import type { OrderObservation } from '@orderrescue/domain';
import {
  BinanceSignedClient,
  TransportFailure,
  digestResponse,
  readVenueError,
  type RawResponse,
  type SignedClientOptions,
} from './client.js';
import type {
  AccountObservation,
  CapabilityReport,
  ExecutionAdapter,
  PlaceOrderRequest,
  StatusOutcome,
  SubmissionOutcome,
  SymbolFilters,
} from './adapter.js';

/**
 * Binance's own documented "the outcome is unknown" code. The docs are explicit
 * that -1007 does not always mean the operation failed, which is precisely the
 * case OrderRescue is built around.
 */
export const BINANCE_TIMEOUT_CODE = -1007;
/** "Order does not exist" — the only code that can support an absence claim. */
export const BINANCE_ORDER_NOT_FOUND_CODE = -2013;

export interface SpotAdapterOptions extends SignedClientOptions {
  environment: 'TESTNET' | 'MAINNET';
  /**
   * Testnet-only hook. Runs AFTER the HTTP exchange has completed, so the order
   * has already reached Binance if it was ever going to. It may discard our
   * knowledge of the response. It cannot and must not invent one.
   */
  afterDispatch?: (context: { clientOrderId: string; status: number }) => void | Promise<void>;
}

export class BinanceSpotAdapter implements ExecutionAdapter {
  readonly venue = 'binance-spot';
  readonly environment: 'TESTNET' | 'MAINNET';
  private readonly client: BinanceSignedClient;
  private readonly options: SpotAdapterOptions;

  constructor(options: SpotAdapterOptions) {
    this.options = options;
    this.environment = options.environment;
    this.client = new BinanceSignedClient(options);
  }

  async capabilities(): Promise<CapabilityReport> {
    const problems: string[] = [];
    let reachable = false;
    let authenticated = false;
    let serverTimeSkewMs: number | null = null;
    const symbolFilters: Record<string, SymbolFilters> = {};

    try {
      const before = Date.now();
      const time = await this.client.publicRequest('GET', '/api/v3/time');
      reachable = time.status === 200;
      if (time.parsed && typeof (time.json as { serverTime?: number }).serverTime === 'number') {
        const serverTime = (time.json as { serverTime: number }).serverTime;
        serverTimeSkewMs = serverTime - Math.round((before + Date.now()) / 2);
        if (Math.abs(serverTimeSkewMs) > this.options.recvWindowMs) {
          problems.push(
            `local clock is ${serverTimeSkewMs}ms from the venue clock, beyond recvWindow ${this.options.recvWindowMs}ms; signed requests will be rejected`,
          );
        }
      }
    } catch (error) {
      problems.push(`venue unreachable: ${describe(error)}`);
    }

    if (this.options.apiKey === '' || this.options.apiSecret === '') {
      problems.push('no API credentials configured; execution and status queries are unavailable');
    } else {
      try {
        const account = await this.client.signedRequest('GET', '/api/v3/account', { omitZeroBalances: 'true' });
        if (account.status === 200) {
          authenticated = true;
        } else {
          const venueError = readVenueError(account);
          problems.push(
            venueError === null
              ? `account query returned HTTP ${account.status}`
              : `account query rejected: ${venueError.code} ${venueError.msg}`,
          );
        }
      } catch (error) {
        problems.push(`account query failed: ${describe(error)}`);
      }
    }

    return {
      reachable,
      authenticated,
      environment: this.environment,
      serverTimeSkewMs,
      // Correlation is a property of the venue API, not of our credentials:
      // POST /api/v3/order takes newClientOrderId and GET /api/v3/order takes
      // origClientOrderId. Verified in docs/integration-gate.md.
      supportsClientOrderIdCorrelation: true,
      symbolFilters,
      problems,
    };
  }

  /** Reads live exchange filters so an order is never built against a stale constant. */
  async loadSymbolFilters(symbol: string): Promise<SymbolFilters> {
    const response = await this.client.publicRequest('GET', '/api/v3/exchangeInfo', { symbol });
    if (response.status !== 200 || !response.parsed) {
      throw new Error(`exchangeInfo for ${symbol} returned HTTP ${response.status}`);
    }
    const body = response.json as { symbols?: Array<Record<string, any>> };
    const entry = body.symbols?.[0];
    if (entry === undefined) throw new Error(`symbol ${symbol} is not listed on this venue`);
    const filters = (entry.filters ?? []) as Array<Record<string, string>>;
    const find = (type: string) => filters.find((f) => f.filterType === type);
    return {
      status: String(entry.status),
      minNotional: find('NOTIONAL')?.minNotional ?? find('MIN_NOTIONAL')?.minNotional ?? null,
      maxNotional: find('NOTIONAL')?.maxNotional ?? null,
      stepSize: find('LOT_SIZE')?.stepSize ?? null,
      minQty: find('LOT_SIZE')?.minQty ?? null,
      tickSize: find('PRICE_FILTER')?.tickSize ?? null,
      baseAsset: String(entry.baseAsset),
      quoteAsset: String(entry.quoteAsset),
    };
  }

  async placeOrder(request: PlaceOrderRequest): Promise<SubmissionOutcome> {
    const params: Record<string, string> = {
      symbol: request.symbol,
      side: request.side,
      type: request.orderType,
      newClientOrderId: request.clientOrderId,
      newOrderRespType: 'RESULT',
    };
    if (request.quantity !== null) params.quantity = request.quantity;
    if (request.quoteQuantity !== null) params.quoteOrderQty = request.quoteQuantity;
    if (request.limitPrice !== null) params.price = request.limitPrice;
    if (request.timeInForce !== null) params.timeInForce = request.timeInForce;

    const requestDigest = BinanceSignedClient.requestDigest('POST', '/api/v3/order', params);

    let response: RawResponse;
    try {
      response = await this.client.signedRequest('POST', '/api/v3/order', params);
    } catch (error) {
      // No response reached us. The order may well exist.
      const failure = error instanceof TransportFailure ? error : null;
      return {
        kind: 'AMBIGUOUS',
        reason: failure?.message ?? 'transport failed before a response was received',
        detail: failure?.detail ?? describe(error),
        requestDigest,
      };
    }

    if (this.options.afterDispatch !== undefined) {
      await this.options.afterDispatch({ clientOrderId: request.clientOrderId, status: response.status });
    }

    return classifySubmission(response, requestDigest);
  }

  async getOrderByClientOrderId(symbol: string, clientOrderId: string): Promise<StatusOutcome> {
    return this.statusCall('GET', '/api/v3/order', { symbol, origClientOrderId: clientOrderId });
  }

  async cancelOrderByClientOrderId(symbol: string, clientOrderId: string): Promise<StatusOutcome> {
    return this.statusCall('DELETE', '/api/v3/order', { symbol, origClientOrderId: clientOrderId });
  }

  private async statusCall(
    method: 'GET' | 'DELETE',
    path: string,
    params: Record<string, string>,
  ): Promise<StatusOutcome> {
    let response: RawResponse;
    try {
      response = await this.client.signedRequest(method, path, params);
    } catch (error) {
      const failure = error instanceof TransportFailure ? error : null;
      return {
        kind: 'UNAVAILABLE',
        reason: failure?.message ?? 'status query failed',
        detail: failure?.detail ?? describe(error),
      };
    }

    const responseDigest = digestResponse(response);

    if (response.status === 200 && response.parsed) {
      const observation = toObservation(response.json as Record<string, unknown>);
      if (observation === null) {
        return { kind: 'UNAVAILABLE', reason: 'status response was missing required fields', detail: '' };
      }
      return { kind: 'OBSERVED', observation, responseDigest };
    }

    const venueError = readVenueError(response);
    if (venueError !== null && venueError.code === BINANCE_ORDER_NOT_FOUND_CODE) {
      // The venue positively says no such order exists for this exact id. That
      // is a data point toward absence; the domain still requires an exhausted
      // window before it will treat it as settled.
      return { kind: 'ABSENT', venueCode: venueError.code, responseDigest };
    }

    return {
      kind: 'UNAVAILABLE',
      reason: venueError === null ? `status query returned HTTP ${response.status}` : `venue error ${venueError.code}`,
      detail: venueError?.msg ?? '',
    };
  }

  async getAccountBalances(assets: string[]): Promise<AccountObservation> {
    const response = await this.client.signedRequest('GET', '/api/v3/account');
    if (response.status !== 200 || !response.parsed) {
      throw new Error(`account query returned HTTP ${response.status}`);
    }
    const body = response.json as { balances?: Array<Record<string, string>>; updateTime?: number };
    const wanted = new Set(assets.map((a) => a.toUpperCase()));
    const balances = (body.balances ?? [])
      .filter((b) => wanted.size === 0 || wanted.has(String(b.asset).toUpperCase()))
      .map((b) => ({ asset: String(b.asset), free: String(b.free), locked: String(b.locked) }));
    return {
      balances,
      sourceTimestamp: typeof body.updateTime === 'number' ? new Date(body.updateTime).toISOString() : null,
      responseDigest: digestResponse(response),
    };
  }
}

/**
 * The classification table. Everything the venue did not clearly tell us is
 * ambiguous, including rate limits and unreadable success bodies.
 */
export function classifySubmission(response: RawResponse, requestDigest: string): SubmissionOutcome {
  const responseDigest = digestResponse(response);

  if (response.status === 200) {
    if (!response.parsed) {
      return {
        kind: 'AMBIGUOUS',
        reason: 'venue returned HTTP 200 with a body we could not parse',
        detail: 'the order may exist despite the unreadable response',
        requestDigest,
      };
    }
    const observation = toObservation(response.json as Record<string, unknown>);
    if (observation === null) {
      return {
        kind: 'AMBIGUOUS',
        reason: 'venue returned HTTP 200 without the fields needed to identify the order',
        detail: 'cannot bind a venue order id to this intent',
        requestDigest,
      };
    }
    return { kind: 'ACKNOWLEDGED', observation, requestDigest, responseDigest };
  }

  const venueError = readVenueError(response);

  if (venueError !== null && venueError.code === BINANCE_TIMEOUT_CODE) {
    return {
      kind: 'AMBIGUOUS',
      reason: 'venue reported -1007 TIMEOUT; send status is unknown',
      detail: venueError.msg,
      requestDigest,
    };
  }

  if (response.status >= 500) {
    return {
      kind: 'AMBIGUOUS',
      reason: `venue returned HTTP ${response.status}; a 5xx must not be treated as a failed operation`,
      detail: venueError?.msg ?? '',
      requestDigest,
    };
  }

  if (response.status === 429 || response.status === 418) {
    return {
      kind: 'AMBIGUOUS',
      reason: `venue returned HTTP ${response.status} (rate limited); treated as unknown rather than assumed rejected`,
      detail: venueError?.msg ?? '',
      requestDigest,
    };
  }

  if (response.status === 409) {
    return {
      kind: 'AMBIGUOUS',
      reason: 'venue returned HTTP 409; the operation may have partially succeeded',
      detail: venueError?.msg ?? '',
      requestDigest,
    };
  }

  if (venueError !== null) {
    return {
      kind: 'REJECTED',
      venueCode: venueError.code,
      reason: `${venueError.code} ${venueError.msg}`,
      requestDigest,
      responseDigest,
    };
  }

  // A 4xx that does not carry a venue error envelope did not necessarily come
  // from the exchange at all.
  return {
    kind: 'AMBIGUOUS',
    reason: `HTTP ${response.status} without a venue error envelope; the source of this response is unproven`,
    detail: '',
    requestDigest,
  };
}

const KNOWN_STATUSES = new Set<OrderObservation['status']>([
  'NEW',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'PENDING_CANCEL',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
]);

export function toObservation(body: Record<string, unknown>): OrderObservation | null {
  const orderId = body.orderId;
  const clientOrderId = body.clientOrderId ?? body.origClientOrderId;
  const status = body.status;
  if (typeof orderId !== 'number' && typeof orderId !== 'string') return null;
  if (typeof clientOrderId !== 'string') return null;
  if (typeof status !== 'string' || !KNOWN_STATUSES.has(status as OrderObservation['status'])) return null;

  const timeValue = body.updateTime ?? body.transactTime ?? body.time;
  return {
    venueOrderId: String(orderId),
    venueClientOrderId: clientOrderId,
    status: status as OrderObservation['status'],
    executedQuantity: String(body.executedQty ?? '0'),
    cumulativeQuoteQuantity: String(body.cummulativeQuoteQty ?? body.cumulativeQuoteQty ?? '0'),
    sourceTimestamp: typeof timeValue === 'number' ? new Date(timeValue).toISOString() : null,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
