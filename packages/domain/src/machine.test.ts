import { describe, expect, it } from 'vitest';
import { decide, type Command, type OperationView } from './machine.js';
import { DomainError } from './errors.js';
import { OPERATION_STATES, allowedActions, isTerminal, retryBlockReason } from './states.js';
import type { OperationState } from './states.js';
import type { OrderObservation } from './schemas.js';

function view(overrides: Partial<OperationView> = {}): OperationView {
  return {
    operationId: '00000000-0000-4000-8000-000000000001',
    state: 'APPROVED',
    stateVersion: 0,
    submitAttemptCount: 0,
    venueOrderId: null,
    executedQuantity: '0',
    cumulativeQuoteQuantity: '0',
    ...overrides,
  };
}

function observation(overrides: Partial<OrderObservation> = {}): OrderObservation {
  return {
    venueClientOrderId: 'or_abc',
    venueOrderId: '12345',
    status: 'NEW',
    executedQuantity: '0',
    cumulativeQuoteQuantity: '0',
    sourceTimestamp: '2026-09-07T10:00:00.000Z',
    ...overrides,
  };
}

function expectDomainError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
}

describe('dispatch authorization', () => {
  it('authorizes dispatch exactly once from APPROVED', () => {
    const decision = decide(view(), { type: 'BEGIN_SUBMISSION' });
    expect(decision.nextState).toBe('SUBMITTING');
    expect(decision.authorizesDispatch).toBe(true);
    expect(decision.incrementSubmitAttempt).toBe(true);
  });

  it.each<OperationState>([
    'SUBMITTING',
    'UNKNOWN',
    'RECONCILING',
    'ACKNOWLEDGED',
    'PARTIALLY_FILLED',
    'CANCEL_REQUESTED',
    'MANUAL_REVIEW',
  ])('refuses a second dispatch while %s may already carry economic effect', (state) => {
    expectDomainError(() => decide(view({ state }), { type: 'BEGIN_SUBMISSION' }), 'RETRY_BLOCKED');
  });

  it('refuses dispatch after the intent already filled, and says why', () => {
    expectDomainError(
      () => decide(view({ state: 'FILLED', executedQuantity: '0.031' }), { type: 'BEGIN_SUBMISSION' }),
      'RETRY_BLOCKED',
    );
    expect(() => decide(view({ state: 'FILLED' }), { type: 'BEGIN_SUBMISSION' })).toThrow(/already executed/);
  });

  it('gives every retry-blocking state a human-readable reason', () => {
    for (const state of OPERATION_STATES) {
      if (state === 'APPROVED' || state === 'DRAFT' || state === 'AWAITING_CONFIRMATION') continue;
      if (isTerminal(state)) continue;
      expect(retryBlockReason(state), `no reason for ${state}`).toBeTruthy();
    }
  });
});

describe('transport ambiguity', () => {
  it('maps a lost response to UNKNOWN, never to a failure', () => {
    const decision = decide(view({ state: 'SUBMITTING' }), {
      type: 'RECORD_AMBIGUOUS_SUBMISSION',
      reason: 'socket hang up',
    });
    expect(decision.nextState).toBe('UNKNOWN');
    expect(decision.terminalReason).toBeUndefined();
    expect(isTerminal(decision.nextState)).toBe(false);
  });

  it('never exposes EXECUTE as an allowed action while UNKNOWN', () => {
    expect(allowedActions('UNKNOWN')).not.toContain('EXECUTE');
    expect(allowedActions('UNKNOWN')).toContain('RECONCILE');
  });
});

describe('absence requires an exhausted window', () => {
  const absent = (overrides: Partial<Extract<Command, { type: 'RECORD_ORDER_ABSENT' }>> = {}) =>
    ({ type: 'RECORD_ORDER_ABSENT', windowExhausted: false, attempts: 1, windowMs: 1000, ...overrides }) as Command;

  it('keeps a single not-found response in UNKNOWN', () => {
    const decision = decide(view({ state: 'UNKNOWN' }), absent());
    expect(decision.nextState).toBe('UNKNOWN');
  });

  it('accepts NOT_FOUND_SAFE only after the window is exhausted', () => {
    const decision = decide(
      view({ state: 'UNKNOWN' }),
      absent({ windowExhausted: true, attempts: 6, windowMs: 30_000 }),
    );
    expect(decision.nextState).toBe('NOT_FOUND_SAFE');
    expect(decision.terminalReason).toContain('6 authoritative queries');
  });

  it('escalates when absence contradicts a recorded venue order id', () => {
    const decision = decide(
      view({ state: 'UNKNOWN', venueOrderId: '999' }),
      absent({ windowExhausted: true, attempts: 6, windowMs: 30_000 }),
    );
    expect(decision.nextState).toBe('MANUAL_REVIEW');
  });

  it('escalates when absence contradicts a recorded fill', () => {
    const decision = decide(
      view({ state: 'UNKNOWN', executedQuantity: '0.5' }),
      absent({ windowExhausted: true, attempts: 6, windowMs: 30_000 }),
    );
    expect(decision.nextState).toBe('MANUAL_REVIEW');
  });
});

describe('observations', () => {
  it('treats a partial fill as exposure, not absence', () => {
    const decision = decide(view({ state: 'RECONCILING' }), {
      type: 'RECORD_ORDER_OBSERVATION',
      observation: observation({ status: 'PARTIALLY_FILLED', executedQuantity: '0.01', cumulativeQuoteQuantity: '6.4' }),
    });
    expect(decision.nextState).toBe('PARTIALLY_FILLED');
    expect(decision.executedQuantity).toBe('0.01');
    expect(retryBlockReason('PARTIALLY_FILLED')).toContain('exposure');
  });

  it('resolves an UNKNOWN operation to FILLED from authoritative status', () => {
    const decision = decide(view({ state: 'RECONCILING' }), {
      type: 'RECORD_ORDER_OBSERVATION',
      observation: observation({ status: 'FILLED', executedQuantity: '0.031', cumulativeQuoteQuantity: '20.00' }),
    });
    expect(decision.nextState).toBe('FILLED');
    expect(decision.venueOrderId).toBe('12345');
    expect(decision.terminalReason).toBe('venue status FILLED');
  });

  it('escalates when a fill appears to shrink', () => {
    const decision = decide(view({ state: 'PARTIALLY_FILLED', executedQuantity: '0.5', venueOrderId: '12345' }), {
      type: 'RECORD_ORDER_OBSERVATION',
      observation: observation({ status: 'PARTIALLY_FILLED', executedQuantity: '0.2' }),
    });
    expect(decision.nextState).toBe('MANUAL_REVIEW');
  });

  it('escalates when the observation belongs to a different venue order', () => {
    const decision = decide(view({ state: 'ACKNOWLEDGED', venueOrderId: '111' }), {
      type: 'RECORD_ORDER_OBSERVATION',
      observation: observation({ venueOrderId: '222' }),
    });
    expect(decision.nextState).toBe('MANUAL_REVIEW');
  });

  it('accepts a re-observation that confirms a terminal state', () => {
    const decision = decide(view({ state: 'FILLED', executedQuantity: '0.031', venueOrderId: '12345' }), {
      type: 'RECORD_ORDER_OBSERVATION',
      observation: observation({ status: 'FILLED', executedQuantity: '0.031' }),
    });
    expect(decision.nextState).toBe('FILLED');
    expect(decision.events[0]?.facts.confirmsTerminalState).toBe(true);
  });

  it('refuses to let a late response rewrite a terminal state', () => {
    expectDomainError(
      () =>
        decide(view({ state: 'FILLED', executedQuantity: '0.031', venueOrderId: '12345' }), {
          type: 'RECORD_ORDER_OBSERVATION',
          observation: observation({ status: 'NEW', executedQuantity: '0' }),
        }),
      'CONTRADICTORY_OBSERVATION',
    );
  });
});

describe('reconciliation entry', () => {
  it.each<OperationState>(['UNKNOWN', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'MANUAL_REVIEW'])(
    'allows reconciliation from %s',
    (state) => {
      expect(decide(view({ state }), { type: 'BEGIN_RECONCILIATION' }).nextState).toBe('RECONCILING');
    },
  );

  it('rejects reconciliation of a draft operation', () => {
    expectDomainError(() => decide(view({ state: 'DRAFT' }), { type: 'BEGIN_RECONCILIATION' }), 'ILLEGAL_TRANSITION');
  });
});

describe('terminal states never regress', () => {
  const terminalStates = OPERATION_STATES.filter(isTerminal);
  const mutatingCommands: Command[] = [
    { type: 'BEGIN_SUBMISSION' },
    { type: 'BEGIN_RECONCILIATION' },
    { type: 'REQUEST_CANCEL' },
    { type: 'RECORD_AMBIGUOUS_SUBMISSION', reason: 'late timeout' },
    { type: 'ESCALATE_MANUAL_REVIEW', reason: 'operator' },
  ];

  it('rejects every mutating command in every terminal state', () => {
    for (const state of terminalStates) {
      for (const command of mutatingCommands) {
        expect(() => decide(view({ state }), command), `${state} accepted ${command.type}`).toThrow(DomainError);
      }
    }
  });
});

describe('unreachable venue', () => {
  it('returns a reconciling operation to UNKNOWN, never to absence', () => {
    const decision = decide(view({ state: 'RECONCILING' }), {
      type: 'RECORD_RECONCILIATION_UNAVAILABLE',
      reason: 'status query failed',
      detail: 'TypeError: fetch failed',
    });
    expect(decision.nextState).toBe('UNKNOWN');
    expect(retryBlockReason(decision.nextState)).toBeTruthy();
  });
});
