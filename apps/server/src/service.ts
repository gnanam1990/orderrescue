import { DomainError, compareDecimal, multiplyDecimal, type CreateIntentRequest } from '@orderrescue/domain';
import { Journal, exportEvidence, type ApplyResult } from '@orderrescue/journal';
import { BinanceSpotAdapter, type ExecutionAdapter, type SymbolFilters } from '@orderrescue/adapter-binance';
import type { Config } from './config.js';

export interface FaultState {
  /** Testnet-only: discard the next submission response after real dispatch. */
  dropNextAck: boolean;
  armedAt: string | null;
}

export interface ExecuteResult {
  operationId: string;
  state: string;
  outcome: 'ACKNOWLEDGED' | 'REJECTED' | 'UNKNOWN';
  detail: string;
}

export class OrderRescueService {
  readonly journal: Journal;
  readonly adapter: BinanceSpotAdapter;
  readonly config: Config;
  readonly fault: FaultState = { dropNextAck: false, armedAt: null };
  private readonly filterCache = new Map<string, { filters: SymbolFilters; loadedAt: number }>();
  private reconcilerTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(config: Config, journal?: Journal, adapter?: BinanceSpotAdapter) {
    this.config = config;
    this.journal = journal ?? new Journal(config.dbPath);
    this.adapter =
      adapter ??
      new BinanceSpotAdapter({
        baseUrl: config.binance.baseUrl,
        apiKey: config.binance.apiKey,
        apiSecret: config.binance.apiSecret,
        recvWindowMs: config.binance.recvWindowMs,
        timeoutMs: config.binance.timeoutMs,
        environment: 'TESTNET',
        afterDispatch: async () => {
          // Deliberately a no-op here. The fault is applied to our *knowledge*
          // of the response in executeIntent, after the exchange has answered.
        },
      });
  }

  /**
   * Validates the economics against live exchange filters and the configured
   * notional cap, then commits the intent. Rejecting here is cheap; rejecting
   * after dispatch is not possible.
   */
  async createIntent(request: CreateIntentRequest, idempotencyKey: string) {
    const filters = await this.symbolFilters(request.symbol);
    if (filters.status !== 'TRADING') {
      throw new DomainError('VALIDATION_FAILED', `${request.symbol} is not trading on this venue`, {
        status: filters.status,
      });
    }

    const notional = this.estimateNotional(request);
    if (notional !== null) {
      if (compareDecimal(notional, request.maxNotional) > 0) {
        throw new DomainError(
          'NOTIONAL_CAP_EXCEEDED',
          `estimated notional ${notional} exceeds the intent cap ${request.maxNotional}`,
        );
      }
      if (compareDecimal(request.maxNotional, this.config.maxNotional) > 0) {
        throw new DomainError(
          'NOTIONAL_CAP_EXCEEDED',
          `intent cap ${request.maxNotional} exceeds the server cap ${this.config.maxNotional}`,
        );
      }
      if (filters.minNotional !== null && compareDecimal(notional, filters.minNotional) < 0) {
        throw new DomainError(
          'VALIDATION_FAILED',
          `estimated notional ${notional} is below the venue minimum ${filters.minNotional} for ${request.symbol}`,
        );
      }
    }

    return this.journal.createIntent(request, idempotencyKey);
  }

  private estimateNotional(request: CreateIntentRequest): string | null {
    if (request.quoteQuantity !== undefined) return request.quoteQuantity;
    if (request.quantity !== undefined && request.limitPrice !== undefined) {
      return multiplyDecimal(request.quantity, request.limitPrice);
    }
    // A MARKET order sized in base quantity has no price until it executes, so
    // there is nothing honest to compare against a cap here.
    return null;
  }

  async symbolFilters(symbol: string): Promise<SymbolFilters> {
    const cached = this.filterCache.get(symbol);
    if (cached !== undefined && Date.now() - cached.loadedAt < 60_000) return cached.filters;
    const filters = await this.adapter.loadSymbolFilters(symbol);
    this.filterCache.set(symbol, { filters, loadedAt: Date.now() });
    return filters;
  }

  confirmIntent(operationId: string, confirmationRef: string): ApplyResult {
    const { result } = this.journal.applyCommandWithin(
      operationId,
      { type: 'CONFIRM_INTENT', confirmationRef },
      (applied) => this.journal.recordConfirmation(applied.operation.intentId, confirmationRef),
    );
    return result;
  }

  /**
   * The critical path.
   *
   * Step 1 commits SUBMITTING to disk. Step 2 sends. Nothing between them can
   * lose the fact that we were about to act — which is what makes the recovery
   * in step 4 possible at all.
   */
  async executeIntent(operationId: string): Promise<ExecuteResult> {
    const operation = this.journal.getOperation(operationId);
    if (operation === null) throw new DomainError('VALIDATION_FAILED', `unknown operation ${operationId}`);
    const intent = this.journal.getIntent(operation.intentId);
    if (intent === null) throw new DomainError('VALIDATION_FAILED', 'operation has no intent');

    if (new Date(intent.expiresAt).getTime() < Date.now()) {
      throw new DomainError('INTENT_EXPIRED', 'this intent expired before it was executed');
    }
    if (intent.confirmedAt === null) {
      throw new DomainError('NOT_CONFIRMED', 'this intent has not been confirmed');
    }
    if (!this.config.binance.credentialsPresent) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'no Binance testnet credentials are configured; refusing to pretend an order was placed',
      );
    }

    // 1. Durable before dispatch. Throws RETRY_BLOCKED if anything may already exist.
    const started = this.journal.applyCommand(operationId, { type: 'BEGIN_SUBMISSION' });
    if (started.decision.authorizesDispatch !== true) {
      throw new DomainError('RETRY_BLOCKED', 'dispatch was not authorized');
    }

    // 2. Send exactly once.
    const outcome = await this.adapter.placeOrder({
      symbol: intent.symbol,
      side: intent.side,
      orderType: intent.orderType,
      quantity: intent.quantity,
      quoteQuantity: intent.quoteQuantity,
      limitPrice: intent.limitPrice,
      timeInForce: intent.timeInForce,
      clientOrderId: operation.venueClientOrderId,
    });

    // 3. Optionally lose the answer — after the venue already has the order.
    const faultArmed = this.fault.dropNextAck && this.config.faultLabEnabled;
    if (faultArmed) {
      this.fault.dropNextAck = false;
      this.journal.applyCommand(operationId, {
        type: 'RECORD_ACCOUNT_OBSERVATION',
        facts: {
          faultInjected: 'DROP_ACK',
          note: 'the acknowledgement was discarded locally after the request reached the venue; the venue result was not altered',
          venueDidRespond: outcome.kind !== 'AMBIGUOUS',
        },
      });
      const ambiguous = this.journal.applyCommand(operationId, {
        type: 'RECORD_AMBIGUOUS_SUBMISSION',
        reason: 'acknowledgement dropped by the fault lab after dispatch',
        transportDetail: 'FAULT_LAB:DROP_ACK',
      });
      this.journal.enqueueReconciliation(operationId);
      return {
        operationId,
        state: ambiguous.operation.state,
        outcome: 'UNKNOWN',
        detail: 'the response was lost after the order reached Binance',
      };
    }

    // 4. Record what we actually learned.
    switch (outcome.kind) {
      case 'ACKNOWLEDGED': {
        const applied = this.journal.applyCommand(
          operationId,
          { type: 'RECORD_ACKNOWLEDGEMENT', observation: outcome.observation },
          { sourceTimestamp: outcome.observation.sourceTimestamp },
        );
        return {
          operationId,
          state: applied.operation.state,
          outcome: 'ACKNOWLEDGED',
          detail: `venue order ${outcome.observation.venueOrderId} is ${outcome.observation.status}`,
        };
      }
      case 'REJECTED': {
        const applied = this.journal.applyCommand(operationId, {
          type: 'RECORD_REJECTION',
          reason: outcome.reason,
        });
        return { operationId, state: applied.operation.state, outcome: 'REJECTED', detail: outcome.reason };
      }
      case 'AMBIGUOUS': {
        const applied = this.journal.applyCommand(operationId, {
          type: 'RECORD_AMBIGUOUS_SUBMISSION',
          reason: outcome.reason,
          transportDetail: outcome.detail,
        });
        this.journal.enqueueReconciliation(operationId);
        return { operationId, state: applied.operation.state, outcome: 'UNKNOWN', detail: outcome.reason };
      }
    }
  }

  /**
   * One authoritative reconciliation pass. Queries by the exact client order id
   * written before dispatch — never by symbol, side, quantity, and time.
   */
  async reconcileOnce(operationId: string, attempts: number): Promise<{ state: string; detail: string }> {
    const operation = this.journal.getOperation(operationId);
    if (operation === null) throw new DomainError('VALIDATION_FAILED', `unknown operation ${operationId}`);
    const intent = this.journal.getIntent(operation.intentId);
    if (intent === null) throw new DomainError('VALIDATION_FAILED', 'operation has no intent');

    this.journal.applyCommand(operationId, { type: 'BEGIN_RECONCILIATION' });

    const status = await this.adapter.getOrderByClientOrderId(intent.symbol, operation.venueClientOrderId);

    if (status.kind === 'OBSERVED') {
      const applied = this.journal.applyCommand(
        operationId,
        { type: 'RECORD_ORDER_OBSERVATION', observation: status.observation },
        { sourceTimestamp: status.observation.sourceTimestamp },
      );
      await this.observeAccount(operationId, intent.symbol);
      return {
        state: applied.operation.state,
        detail: `venue reports ${status.observation.status} for order ${status.observation.venueOrderId}`,
      };
    }

    if (status.kind === 'ABSENT') {
      const elapsedMs =
        operation.firstSubmittedAt === null ? 0 : Date.now() - new Date(operation.firstSubmittedAt).getTime();
      const windowExhausted =
        attempts >= this.config.absenceMinAttempts && elapsedMs >= this.config.absenceWindowMs;
      const applied = this.journal.applyCommand(operationId, {
        type: 'RECORD_ORDER_ABSENT',
        windowExhausted,
        attempts,
        windowMs: elapsedMs,
      });
      return {
        state: applied.operation.state,
        detail: windowExhausted
          ? 'no such order after an exhausted observation window'
          : `venue reports no such order (attempt ${attempts}); window not yet exhausted`,
      };
    }

    const applied = this.journal.applyCommand(operationId, {
      type: 'RECORD_RECONCILIATION_UNAVAILABLE',
      reason: status.reason,
      detail: status.detail,
    });
    return { state: applied.operation.state, detail: status.reason };
  }

  private async observeAccount(operationId: string, symbol: string): Promise<void> {
    try {
      const filters = await this.symbolFilters(symbol);
      const account = await this.adapter.getAccountBalances([filters.baseAsset, filters.quoteAsset]);
      this.journal.applyCommand(operationId, {
        type: 'RECORD_ACCOUNT_OBSERVATION',
        facts: { balances: account.balances, responseDigest: account.responseDigest },
      });
    } catch (error) {
      // A failed balance read explains less, but it must never change the
      // order outcome we just established authoritatively.
      this.journal.applyCommand(operationId, {
        type: 'RECORD_ACCOUNT_OBSERVATION',
        facts: { balancesUnavailable: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  exportEvidence(operationId: string) {
    return exportEvidence(this.journal, operationId);
  }

  // ---- background reconciler ------------------------------------------------

  startReconciler(): void {
    if (this.reconcilerTimer !== null) return;
    const tick = async () => {
      if (this.stopping) return;
      try {
        await this.drainReconciliationQueue();
      } catch {
        // a worker crash must not take the API down with it
      }
      if (!this.stopping) this.reconcilerTimer = setTimeout(tick, 1000);
    };
    this.reconcilerTimer = setTimeout(tick, 1000);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconcilerTimer !== null) clearTimeout(this.reconcilerTimer);
    this.reconcilerTimer = null;
  }

  async drainReconciliationQueue(limit = 5): Promise<number> {
    let handled = 0;
    for (let i = 0; i < limit; i += 1) {
      const claimed = this.journal.claimDueReconciliation();
      if (claimed === null) break;
      handled += 1;
      try {
        const result = await this.reconcileOnce(claimed.operationId, claimed.attempts);
        const settled = !['UNKNOWN', 'RECONCILING'].includes(result.state);
        this.journal.releaseReconciliation(
          claimed.operationId,
          settled ? 'SETTLED' : 'PENDING',
          settled ? {} : { nextAttemptAt: new Date(Date.now() + this.backoffMs(claimed.attempts)) },
        );
      } catch (error) {
        this.journal.releaseReconciliation(claimed.operationId, 'PENDING', {
          nextAttemptAt: new Date(Date.now() + this.backoffMs(claimed.attempts)),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return handled;
  }

  /** Bounded exponential backoff with jitter, so a stuck operation does not hammer the venue. */
  backoffMs(attempts: number): number {
    const raw = this.config.reconcileBaseMs * 2 ** Math.max(0, attempts - 1);
    const capped = Math.min(raw, this.config.reconcileMaxMs);
    return Math.round(capped * (0.75 + Math.random() * 0.5));
  }
}

export type { ExecutionAdapter };
