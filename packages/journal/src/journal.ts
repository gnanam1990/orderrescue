import { v7 as uuidv7 } from 'uuid';
import {
  DomainError,
  canonicalJson,
  decide,
  deriveClientOrderId,
  intentDigest,
  isTerminal,
  redactValue,
  sha256Hex,
  type Command,
  type CreateIntentRequest,
  type Decision,
  type DomainEvent,
  type EvidenceEvent,
  type Operation,
  type OperationState,
  type OperationView,
  type TradeIntent,
} from '@orderrescue/domain';
import { inWriteTransaction, openDatabase, type Db } from './db.js';

export interface CreateIntentResult {
  intent: TradeIntent;
  operation: Operation;
  /** false when an existing intent was returned for a repeated idempotency key */
  created: boolean;
}

export interface ApplyResult {
  operation: Operation;
  decision: Decision;
  appended: EvidenceEvent[];
}

interface IntentRow {
  intent_id: string;
  idempotency_key: string;
  intent_digest: string;
  account_ref: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  order_type: 'MARKET' | 'LIMIT';
  quantity: string | null;
  quote_quantity: string | null;
  limit_price: string | null;
  time_in_force: string | null;
  max_notional: string;
  created_by: string;
  confirmation_ref: string | null;
  confirmed_at: string | null;
  created_at: string;
  expires_at: string;
  schema_version: number;
}

interface OperationRow {
  operation_id: string;
  intent_id: string;
  venue_client_order_id: string;
  venue_order_id: string | null;
  state: OperationState;
  state_version: number;
  submit_attempt_count: number;
  executed_quantity: string;
  cumulative_quote_quantity: string;
  first_submitted_at: string | null;
  last_observed_at: string | null;
  terminal_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface EvidenceRow {
  sequence: number;
  operation_id: string;
  event_type: string;
  source: string;
  source_timestamp: string | null;
  observed_at: string;
  payload_digest: string;
  facts_json: string;
  previous_event_hash: string | null;
  event_hash: string;
}

export type Clock = () => Date;

export class Journal {
  readonly db: Db;
  private readonly now: Clock;

  constructor(path: string, clock: Clock = () => new Date()) {
    this.db = openDatabase(path);
    this.now = clock;
  }

  close(): void {
    this.db.close();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  /**
   * Creates the intent, its operation, and its first evidence event in one
   * transaction. Nothing may be dispatched for an intent that is not on disk,
   * so this is the only door into the system.
   */
  createIntent(request: CreateIntentRequest, idempotencyKey: string): CreateIntentResult {
    const digest = intentDigest({
      accountRef: request.accountRef,
      symbol: request.symbol,
      side: request.side,
      orderType: request.orderType,
      quantity: request.quantity ?? null,
      quoteQuantity: request.quoteQuantity ?? null,
      limitPrice: request.limitPrice ?? null,
      timeInForce: request.timeInForce ?? null,
    });

    return inWriteTransaction(this.db, () => {
      const existing = this.db
        .prepare<[string], IntentRow>('SELECT * FROM intents WHERE idempotency_key = ?')
        .get(idempotencyKey);

      if (existing !== undefined) {
        if (existing.intent_digest !== digest) {
          // Same key, different trade. Returning the old intent would silently
          // ignore what the caller actually asked for; creating a new one would
          // defeat the key. The only honest answer is a conflict.
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'this idempotency key is already bound to a different economic intent',
            { idempotencyKey, storedDigest: existing.intent_digest, requestDigest: digest },
          );
        }
        const operation = this.requireOperationByIntent(existing.intent_id);
        return { intent: toIntent(existing), operation, created: false };
      }

      const createdAt = this.timestamp();
      const intentId = uuidv7();
      const expiresAt = new Date(
        this.now().getTime() + request.expiresInSeconds * 1000,
      ).toISOString();

      const row: IntentRow = {
        intent_id: intentId,
        idempotency_key: idempotencyKey,
        intent_digest: digest,
        account_ref: request.accountRef,
        symbol: request.symbol,
        side: request.side,
        order_type: request.orderType,
        quantity: request.quantity ?? null,
        quote_quantity: request.quoteQuantity ?? null,
        limit_price: request.limitPrice ?? null,
        time_in_force: request.timeInForce ?? null,
        max_notional: request.maxNotional,
        created_by: request.createdBy,
        confirmation_ref: null,
        confirmed_at: null,
        created_at: createdAt,
        expires_at: expiresAt,
        schema_version: 1,
      };

      this.db
        .prepare(
          `INSERT INTO intents (intent_id, idempotency_key, intent_digest, account_ref, symbol, side,
             order_type, quantity, quote_quantity, limit_price, time_in_force, max_notional, created_by,
             confirmation_ref, confirmed_at, created_at, expires_at, schema_version)
           VALUES (@intent_id, @idempotency_key, @intent_digest, @account_ref, @symbol, @side,
             @order_type, @quantity, @quote_quantity, @limit_price, @time_in_force, @max_notional, @created_by,
             @confirmation_ref, @confirmed_at, @created_at, @expires_at, @schema_version)`,
        )
        .run(row);

      const operationRow: OperationRow = {
        operation_id: uuidv7(),
        intent_id: intentId,
        venue_client_order_id: deriveClientOrderId(intentId, digest),
        venue_order_id: null,
        state: 'AWAITING_CONFIRMATION',
        state_version: 0,
        submit_attempt_count: 0,
        executed_quantity: '0',
        cumulative_quote_quantity: '0',
        first_submitted_at: null,
        last_observed_at: null,
        terminal_reason: null,
        created_at: createdAt,
        updated_at: createdAt,
      };

      this.db
        .prepare(
          `INSERT INTO operations (operation_id, intent_id, venue_client_order_id, venue_order_id, state,
             state_version, submit_attempt_count, executed_quantity, cumulative_quote_quantity,
             first_submitted_at, last_observed_at, terminal_reason, created_at, updated_at)
           VALUES (@operation_id, @intent_id, @venue_client_order_id, @venue_order_id, @state,
             @state_version, @submit_attempt_count, @executed_quantity, @cumulative_quote_quantity,
             @first_submitted_at, @last_observed_at, @terminal_reason, @created_at, @updated_at)`,
        )
        .run(operationRow);

      this.appendEvidence(operationRow.operation_id, {
        eventType: 'INTENT_CREATED',
        source: 'LOCAL',
        sourceTimestamp: null,
        facts: {
          intentId,
          intentDigest: digest,
          symbol: request.symbol,
          side: request.side,
          orderType: request.orderType,
          quantity: request.quantity ?? null,
          quoteQuantity: request.quoteQuantity ?? null,
          limitPrice: request.limitPrice ?? null,
          maxNotional: request.maxNotional,
          venueClientOrderId: operationRow.venue_client_order_id,
        },
      });

      return { intent: toIntent(row), operation: toOperation(operationRow), created: true };
    });
  }

  /**
   * Runs one domain command atomically: read state, decide, persist the new
   * state and its evidence together. If the caller crashes after this returns,
   * the decision is already durable — which is what makes `authorizesDispatch`
   * safe to act on.
   */
  applyCommand(operationId: string, command: Command, options: { sourceTimestamp?: string | null } = {}): ApplyResult {
    return inWriteTransaction(this.db, () => {
      const row = this.requireOperationRow(operationId);
      const decision = decide(toView(row), command);
      return this.persistDecision(row, decision, options.sourceTimestamp ?? null);
    });
  }

  /**
   * Same as applyCommand, but the caller supplies the follow-up work that must
   * happen inside the same transaction (recording a confirmation reference, for
   * example) so that state and its justification can never separate.
   */
  applyCommandWithin<T>(
    operationId: string,
    command: Command,
    extra: (result: ApplyResult) => T,
  ): { result: ApplyResult; extra: T } {
    return inWriteTransaction(this.db, () => {
      const row = this.requireOperationRow(operationId);
      const decision = decide(toView(row), command);
      const result = this.persistDecision(row, decision, null);
      return { result, extra: extra(result) };
    });
  }

  private persistDecision(row: OperationRow, decision: Decision, sourceTimestamp: string | null): ApplyResult {
    const updatedAt = this.timestamp();
    const next: OperationRow = {
      ...row,
      state: decision.nextState,
      state_version: row.state_version + 1,
      submit_attempt_count: row.submit_attempt_count + (decision.incrementSubmitAttempt ? 1 : 0),
      venue_order_id: decision.venueOrderId ?? row.venue_order_id,
      executed_quantity: decision.executedQuantity ?? row.executed_quantity,
      cumulative_quote_quantity: decision.cumulativeQuoteQuantity ?? row.cumulative_quote_quantity,
      terminal_reason: decision.terminalReason ?? row.terminal_reason,
      first_submitted_at:
        row.first_submitted_at ?? (decision.nextState === 'SUBMITTING' ? updatedAt : null),
      last_observed_at: sourceTimestamp !== null || decision.venueOrderId !== undefined ? updatedAt : row.last_observed_at,
      updated_at: updatedAt,
    };

    // The state_version guard turns a lost update into a visible failure rather
    // than a silently overwritten state.
    const applied = this.db
      .prepare(
        `UPDATE operations SET state = @state, state_version = @state_version,
           submit_attempt_count = @submit_attempt_count, venue_order_id = @venue_order_id,
           executed_quantity = @executed_quantity, cumulative_quote_quantity = @cumulative_quote_quantity,
           terminal_reason = @terminal_reason, first_submitted_at = @first_submitted_at,
           last_observed_at = @last_observed_at, updated_at = @updated_at
         WHERE operation_id = @operation_id AND state_version = @expected_version`,
      )
      .run({ ...next, expected_version: row.state_version });

    if (applied.changes !== 1) {
      throw new DomainError('ILLEGAL_TRANSITION', 'operation was modified concurrently', {
        operationId: row.operation_id,
        expectedVersion: row.state_version,
      });
    }

    const appended = decision.events.map((event) => this.appendEvidence(row.operation_id, event));
    return { operation: toOperation(next), decision, appended };
  }

  /**
   * Appends one evidence event and links it into the journal-wide hash chain.
   * Facts are redacted here, on the way in, so nothing secret is ever at rest.
   */
  private appendEvidence(operationId: string, event: DomainEvent): EvidenceEvent {
    const observedAt = this.timestamp();
    const facts = redactValue(event.facts) as Record<string, unknown>;
    const payloadDigest = sha256Hex(canonicalJson(facts));
    const previous = this.db
      .prepare<[], { event_hash: string }>('SELECT event_hash FROM evidence_events ORDER BY sequence DESC LIMIT 1')
      .get();
    const previousEventHash = previous?.event_hash ?? null;

    const insert = this.db
      .prepare(
        `INSERT INTO evidence_events (operation_id, event_type, source, source_timestamp, observed_at,
           payload_digest, facts_json, previous_event_hash, event_hash)
         VALUES (@operation_id, @event_type, @source, @source_timestamp, @observed_at,
           @payload_digest, @facts_json, @previous_event_hash, @event_hash)`,
      );

    const nextSequence =
      (this.db.prepare<[], { seq: number | null }>('SELECT MAX(sequence) AS seq FROM evidence_events').get()?.seq ??
        0) + 1;

    const eventHash = hashEvidence({
      sequence: nextSequence,
      operationId,
      eventType: event.eventType,
      source: event.source,
      sourceTimestamp: event.sourceTimestamp,
      observedAt,
      payloadDigest,
      facts,
      previousEventHash,
    });

    insert.run({
      operation_id: operationId,
      event_type: event.eventType,
      source: event.source,
      source_timestamp: event.sourceTimestamp,
      observed_at: observedAt,
      payload_digest: payloadDigest,
      facts_json: JSON.stringify(facts),
      previous_event_hash: previousEventHash,
      event_hash: eventHash,
    });

    return {
      sequence: nextSequence,
      operationId,
      eventType: event.eventType,
      source: event.source,
      sourceTimestamp: event.sourceTimestamp,
      observedAt,
      payloadDigest,
      facts,
      previousEventHash,
      eventHash,
    } as EvidenceEvent;
  }

  getIntent(intentId: string): TradeIntent | null {
    const row = this.db.prepare<[string], IntentRow>('SELECT * FROM intents WHERE intent_id = ?').get(intentId);
    return row === undefined ? null : toIntent(row);
  }

  recordConfirmation(intentId: string, confirmationRef: string): void {
    this.db
      .prepare('UPDATE intents SET confirmation_ref = ?, confirmed_at = ? WHERE intent_id = ?')
      .run(confirmationRef, this.timestamp(), intentId);
  }

  getOperation(operationId: string): Operation | null {
    const row = this.db
      .prepare<[string], OperationRow>('SELECT * FROM operations WHERE operation_id = ?')
      .get(operationId);
    return row === undefined ? null : toOperation(row);
  }

  listOperations(limit = 200): Operation[] {
    return this.db
      .prepare<[number], OperationRow>('SELECT * FROM operations ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map(toOperation);
  }

  getEvidence(operationId: string): EvidenceEvent[] {
    return this.db
      .prepare<[string], EvidenceRow>('SELECT * FROM evidence_events WHERE operation_id = ? ORDER BY sequence ASC')
      .all(operationId)
      .map(toEvidence);
  }

  private requireOperationRow(operationId: string): OperationRow {
    const row = this.db
      .prepare<[string], OperationRow>('SELECT * FROM operations WHERE operation_id = ?')
      .get(operationId);
    if (row === undefined) throw new DomainError('VALIDATION_FAILED', `unknown operation ${operationId}`);
    return row;
  }

  private requireOperationByIntent(intentId: string): Operation {
    const row = this.db
      .prepare<[string], OperationRow>('SELECT * FROM operations WHERE intent_id = ?')
      .get(intentId);
    if (row === undefined) throw new DomainError('VALIDATION_FAILED', `intent ${intentId} has no operation`);
    return toOperation(row);
  }

  /**
   * Verifies the append-only chain end to end. Any edited fact, deleted row, or
   * reordered event breaks the linkage and is reported with its sequence number.
   */
  verifyChain(): { ok: boolean; checked: number; brokenAt: number | null; reason: string | null } {
    const rows = this.db
      .prepare<[], EvidenceRow>('SELECT * FROM evidence_events ORDER BY sequence ASC')
      .all();
    let previousHash: string | null = null;
    let expectedSequence = 1;
    for (const row of rows) {
      if (row.sequence !== expectedSequence) {
        return {
          ok: false,
          checked: expectedSequence - 1,
          brokenAt: row.sequence,
          reason: `sequence gap: expected ${expectedSequence}, found ${row.sequence}`,
        };
      }
      if (row.previous_event_hash !== previousHash) {
        return {
          ok: false,
          checked: expectedSequence - 1,
          brokenAt: row.sequence,
          reason: 'previous_event_hash does not match the preceding event',
        };
      }
      const facts = JSON.parse(row.facts_json) as Record<string, unknown>;
      if (sha256Hex(canonicalJson(facts)) !== row.payload_digest) {
        return {
          ok: false,
          checked: expectedSequence - 1,
          brokenAt: row.sequence,
          reason: 'facts do not match their recorded payload digest',
        };
      }
      const recomputed = hashEvidence({
        sequence: row.sequence,
        operationId: row.operation_id,
        eventType: row.event_type,
        source: row.source,
        sourceTimestamp: row.source_timestamp,
        observedAt: row.observed_at,
        payloadDigest: row.payload_digest,
        facts,
        previousEventHash: row.previous_event_hash,
      });
      if (recomputed !== row.event_hash) {
        return {
          ok: false,
          checked: expectedSequence - 1,
          brokenAt: row.sequence,
          reason: 'recomputed event hash does not match the stored hash',
        };
      }
      previousHash = row.event_hash;
      expectedSequence += 1;
    }
    return { ok: true, checked: rows.length, brokenAt: null, reason: null };
  }

  // ---- reconciliation queue -------------------------------------------------

  enqueueReconciliation(operationId: string, dueAt: Date = this.now()): void {
    const stamp = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO reconciliation_jobs (operation_id, status, attempts, first_attempt_at, next_attempt_at,
           last_error, created_at, updated_at)
         VALUES (?, 'PENDING', 0, NULL, ?, NULL, ?, ?)
         ON CONFLICT(operation_id) DO UPDATE SET
           status = CASE WHEN reconciliation_jobs.status IN ('SETTLED','GAVE_UP') THEN 'PENDING' ELSE reconciliation_jobs.status END,
           next_attempt_at = MIN(reconciliation_jobs.next_attempt_at, excluded.next_attempt_at),
           updated_at = excluded.updated_at`,
      )
      .run(operationId, dueAt.toISOString(), stamp, stamp);
  }

  /** Claims one due job, marking it RUNNING so a second worker cannot take it. */
  claimDueReconciliation(): { operationId: string; attempts: number } | null {
    return inWriteTransaction(this.db, () => {
      const row = this.db
        .prepare<[string], { operation_id: string; attempts: number }>(
          `SELECT operation_id, attempts FROM reconciliation_jobs
           WHERE status = 'PENDING' AND next_attempt_at <= ?
           ORDER BY next_attempt_at ASC LIMIT 1`,
        )
        .get(this.timestamp());
      if (row === undefined) return null;
      const stamp = this.timestamp();
      this.db
        .prepare(
          `UPDATE reconciliation_jobs
           SET status = 'RUNNING', attempts = attempts + 1,
               first_attempt_at = COALESCE(first_attempt_at, ?), updated_at = ?
           WHERE operation_id = ?`,
        )
        .run(stamp, stamp, row.operation_id);
      return { operationId: row.operation_id, attempts: row.attempts + 1 };
    });
  }

  releaseReconciliation(operationId: string, outcome: 'SETTLED' | 'GAVE_UP' | 'PENDING', options: { nextAttemptAt?: Date; error?: string } = {}): void {
    const stamp = this.timestamp();
    this.db
      .prepare(
        `UPDATE reconciliation_jobs SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE operation_id = ?`,
      )
      .run(
        outcome,
        (options.nextAttemptAt ?? this.now()).toISOString(),
        options.error ?? null,
        stamp,
        operationId,
      );
  }

  getReconciliationJob(operationId: string): { status: string; attempts: number; firstAttemptAt: string | null; lastError: string | null } | null {
    const row = this.db
      .prepare<[string], { status: string; attempts: number; first_attempt_at: string | null; last_error: string | null }>(
        'SELECT status, attempts, first_attempt_at, last_error FROM reconciliation_jobs WHERE operation_id = ?',
      )
      .get(operationId);
    return row === undefined
      ? null
      : { status: row.status, attempts: row.attempts, firstAttemptAt: row.first_attempt_at, lastError: row.last_error };
  }

  /**
   * Called once at startup. Unresolved operations are re-queued for
   * *observation* only. Nothing here resubmits an order — a process that
   * restarts must first find out what the venue already holds.
   */
  resumeUnresolvedOperations(): string[] {
    const rows = this.db
      .prepare<[], OperationRow>(
        `SELECT * FROM operations WHERE state IN ('SUBMITTING', 'UNKNOWN', 'RECONCILING', 'CANCEL_REQUESTED')`,
      )
      .all();
    const resumed: string[] = [];
    for (const row of rows) {
      // A process that died mid-dispatch left SUBMITTING behind. The order may
      // exist. It becomes UNKNOWN, never APPROVED and never re-dispatched.
      if (row.state === 'SUBMITTING' || row.state === 'RECONCILING') {
        inWriteTransaction(this.db, () => {
          const current = this.requireOperationRow(row.operation_id);
          const stamp = this.timestamp();
          this.db
            .prepare(
              `UPDATE operations SET state = 'UNKNOWN', state_version = state_version + 1, updated_at = ?
               WHERE operation_id = ? AND state_version = ?`,
            )
            .run(stamp, row.operation_id, current.state_version);
          this.appendEvidence(row.operation_id, {
            eventType: 'SUBMISSION_AMBIGUOUS',
            source: 'LOCAL',
            sourceTimestamp: null,
            facts: {
              reason: `process restarted while operation was ${current.state}`,
              note: 'restart is not evidence of non-execution; awaiting authoritative observation',
            },
          });
        });
      }
      this.enqueueReconciliation(row.operation_id);
      resumed.push(row.operation_id);
    }
    return resumed;
  }
}

function hashEvidence(input: {
  sequence: number;
  operationId: string;
  eventType: string;
  source: string;
  sourceTimestamp: string | null;
  observedAt: string;
  payloadDigest: string;
  facts: Record<string, unknown>;
  previousEventHash: string | null;
}): string {
  return sha256Hex(canonicalJson({ v: 1, ...input }));
}

function toIntent(row: IntentRow): TradeIntent {
  return {
    schemaVersion: 1,
    intentId: row.intent_id,
    idempotencyKey: row.idempotency_key,
    intentDigest: row.intent_digest,
    accountRef: row.account_ref,
    symbol: row.symbol,
    side: row.side,
    orderType: row.order_type,
    quantity: row.quantity,
    quoteQuantity: row.quote_quantity,
    limitPrice: row.limit_price,
    timeInForce: row.time_in_force as TradeIntent['timeInForce'],
    maxNotional: row.max_notional,
    createdBy: row.created_by,
    confirmationRef: row.confirmation_ref,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function toOperation(row: OperationRow): Operation {
  return {
    operationId: row.operation_id,
    intentId: row.intent_id,
    venueClientOrderId: row.venue_client_order_id,
    venueOrderId: row.venue_order_id,
    state: row.state,
    stateVersion: row.state_version,
    submitAttemptCount: row.submit_attempt_count,
    executedQuantity: row.executed_quantity,
    cumulativeQuoteQuantity: row.cumulative_quote_quantity,
    firstSubmittedAt: row.first_submitted_at,
    lastObservedAt: row.last_observed_at,
    terminalReason: row.terminal_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvidence(row: EvidenceRow): EvidenceEvent {
  return {
    sequence: row.sequence,
    operationId: row.operation_id,
    eventType: row.event_type,
    source: row.source,
    sourceTimestamp: row.source_timestamp,
    observedAt: row.observed_at,
    payloadDigest: row.payload_digest,
    facts: JSON.parse(row.facts_json) as Record<string, unknown>,
    previousEventHash: row.previous_event_hash,
    eventHash: row.event_hash,
  } as EvidenceEvent;
}

function toView(row: OperationRow): OperationView {
  return {
    operationId: row.operation_id,
    state: row.state,
    stateVersion: row.state_version,
    submitAttemptCount: row.submit_attempt_count,
    venueOrderId: row.venue_order_id,
    executedQuantity: row.executed_quantity,
    cumulativeQuoteQuantity: row.cumulative_quote_quantity,
  };
}

export { isTerminal };
