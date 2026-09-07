import { DomainError } from './errors.js';
import { compareDecimal, isPositive } from './decimal.js';
import type { EvidenceEventType, EvidenceSource, OrderObservation } from './schemas.js';
import { isTerminal, retryBlockReason, type OperationState } from './states.js';

/**
 * The projection the machine reasons over. Deliberately small: no persistence
 * handles, no clients, no clock. Every transition in OrderRescue goes through
 * `decide`, so the invariants below hold no matter which caller triggered it.
 */
export interface OperationView {
  readonly operationId: string;
  readonly state: OperationState;
  readonly stateVersion: number;
  readonly submitAttemptCount: number;
  readonly venueOrderId: string | null;
  readonly executedQuantity: string;
  readonly cumulativeQuoteQuantity: string;
}

export type Command =
  | { type: 'BEGIN_SUBMISSION' }
  | { type: 'RECORD_ACKNOWLEDGEMENT'; observation: OrderObservation }
  | { type: 'RECORD_AMBIGUOUS_SUBMISSION'; reason: string; transportDetail?: string }
  | { type: 'RECORD_REJECTION'; reason: string }
  | { type: 'BEGIN_RECONCILIATION' }
  | { type: 'RECORD_ORDER_OBSERVATION'; observation: OrderObservation; source?: EvidenceSource }
  | { type: 'RECORD_ORDER_ABSENT'; windowExhausted: boolean; attempts: number; windowMs: number }
  | { type: 'RECORD_ACCOUNT_OBSERVATION'; facts: Record<string, unknown> }
  | { type: 'REQUEST_CANCEL' }
  | { type: 'ESCALATE_MANUAL_REVIEW'; reason: string };

export interface DomainEvent {
  eventType: EvidenceEventType;
  source: EvidenceSource;
  sourceTimestamp: string | null;
  facts: Record<string, unknown>;
}

export interface Decision {
  nextState: OperationState;
  events: DomainEvent[];
  venueOrderId?: string;
  executedQuantity?: string;
  cumulativeQuoteQuantity?: string;
  terminalReason?: string;
  incrementSubmitAttempt?: boolean;
  /** True only when the caller is authorized to dispatch to the venue. */
  authorizesDispatch?: boolean;
}

const STATUS_TO_STATE: Record<OrderObservation['status'], OperationState> = {
  NEW: 'ACKNOWLEDGED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELED: 'CANCELLED',
  PENDING_CANCEL: 'CANCEL_REQUESTED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  EXPIRED_IN_MATCH: 'EXPIRED',
};

export function decide(view: OperationView, command: Command): Decision {
  if (isTerminal(view.state) && command.type !== 'RECORD_ACCOUNT_OBSERVATION') {
    // A terminal operation is settled history. Re-observing it is fine; moving
    // it is not, because that would let a late or wrong response rewrite an
    // outcome the operator has already acted on.
    if (command.type === 'RECORD_ORDER_OBSERVATION') {
      return reobserveTerminal(view, command.observation);
    }
    throw new DomainError('TERMINAL_STATE', `operation is terminal in state ${view.state}`, {
      state: view.state,
    });
  }

  switch (command.type) {
    case 'BEGIN_SUBMISSION':
      return beginSubmission(view);
    case 'RECORD_ACKNOWLEDGEMENT':
      return recordAcknowledgement(view, command.observation);
    case 'RECORD_AMBIGUOUS_SUBMISSION':
      return recordAmbiguous(view, command.reason, command.transportDetail);
    case 'RECORD_REJECTION':
      return recordRejection(view, command.reason);
    case 'BEGIN_RECONCILIATION':
      return beginReconciliation(view);
    case 'RECORD_ORDER_OBSERVATION':
      return recordOrderObservation(view, command.observation, command.source ?? 'BINANCE_ORDER_API');
    case 'RECORD_ORDER_ABSENT':
      return recordOrderAbsent(view, command);
    case 'RECORD_ACCOUNT_OBSERVATION':
      return {
        nextState: view.state,
        events: [
          {
            eventType: 'ACCOUNT_OBSERVED',
            source: 'BINANCE_ACCOUNT_API',
            sourceTimestamp: null,
            facts: command.facts,
          },
        ],
      };
    case 'REQUEST_CANCEL':
      return requestCancel(view);
    case 'ESCALATE_MANUAL_REVIEW':
      return escalate(view, command.reason);
    default: {
      const exhaustive: never = command;
      throw new DomainError('ILLEGAL_TRANSITION', `unknown command ${JSON.stringify(exhaustive)}`);
    }
  }
}

function beginSubmission(view: OperationView): Decision {
  if (view.state !== 'APPROVED') {
    const blocked = retryBlockReason(view.state);
    if (blocked) {
      // This is the invariant the whole product exists for.
      throw new DomainError('RETRY_BLOCKED', blocked, { state: view.state });
    }
    throw new DomainError(
      'ILLEGAL_TRANSITION',
      `submission requires an APPROVED operation, found ${view.state}`,
      { state: view.state },
    );
  }
  return {
    nextState: 'SUBMITTING',
    authorizesDispatch: true,
    incrementSubmitAttempt: true,
    events: [
      {
        eventType: 'SUBMISSION_STARTED',
        source: 'LOCAL',
        sourceTimestamp: null,
        facts: { attempt: view.submitAttemptCount + 1 },
      },
    ],
  };
}

function recordAcknowledgement(view: OperationView, observation: OrderObservation): Decision {
  if (view.state !== 'SUBMITTING') {
    throw new DomainError(
      'ILLEGAL_TRANSITION',
      `acknowledgement requires SUBMITTING, found ${view.state}`,
      { state: view.state },
    );
  }
  const nextState = STATUS_TO_STATE[observation.status];
  return {
    nextState,
    venueOrderId: observation.venueOrderId,
    executedQuantity: observation.executedQuantity,
    cumulativeQuoteQuantity: observation.cumulativeQuoteQuantity,
    terminalReason: isTerminal(nextState) ? `venue status ${observation.status}` : undefined,
    events: [
      {
        eventType: 'SUBMISSION_ACKNOWLEDGED',
        source: 'BINANCE_ORDER_API',
        sourceTimestamp: observation.sourceTimestamp,
        facts: normalizedFacts(observation),
      },
    ],
  };
}

function recordAmbiguous(view: OperationView, reason: string, transportDetail?: string): Decision {
  if (view.state !== 'SUBMITTING') {
    throw new DomainError(
      'ILLEGAL_TRANSITION',
      `ambiguous submission requires SUBMITTING, found ${view.state}`,
      { state: view.state },
    );
  }
  return {
    nextState: 'UNKNOWN',
    events: [
      {
        eventType: 'SUBMISSION_AMBIGUOUS',
        source: 'LOCAL',
        sourceTimestamp: null,
        facts: {
          reason,
          transportDetail: transportDetail ?? null,
          note: 'transport ambiguity is not evidence of non-execution',
        },
      },
    ],
  };
}

function recordRejection(view: OperationView, reason: string): Decision {
  if (view.state !== 'SUBMITTING') {
    throw new DomainError(
      'ILLEGAL_TRANSITION',
      `rejection requires SUBMITTING, found ${view.state}`,
      { state: view.state },
    );
  }
  return {
    nextState: 'REJECTED',
    terminalReason: reason,
    events: [
      {
        eventType: 'SUBMISSION_REJECTED',
        source: 'BINANCE_ORDER_API',
        sourceTimestamp: null,
        facts: { reason },
      },
    ],
  };
}

function beginReconciliation(view: OperationView): Decision {
  const reconcilable: OperationState[] = [
    'UNKNOWN',
    'ACKNOWLEDGED',
    'PARTIALLY_FILLED',
    'CANCEL_REQUESTED',
    'MANUAL_REVIEW',
  ];
  if (!reconcilable.includes(view.state)) {
    throw new DomainError(
      'ILLEGAL_TRANSITION',
      `reconciliation is not applicable in state ${view.state}`,
      { state: view.state },
    );
  }
  return {
    nextState: 'RECONCILING',
    events: [
      {
        eventType: 'RECONCILIATION_STARTED',
        source: 'LOCAL',
        sourceTimestamp: null,
        facts: { fromState: view.state },
      },
    ],
  };
}

function recordOrderObservation(
  view: OperationView,
  observation: OrderObservation,
  source: EvidenceSource,
): Decision {
  const contradiction = detectContradiction(view, observation);
  const observedEvent: DomainEvent = {
    eventType: 'ORDER_OBSERVED',
    source,
    sourceTimestamp: observation.sourceTimestamp,
    facts: normalizedFacts(observation),
  };

  if (contradiction) {
    return {
      nextState: 'MANUAL_REVIEW',
      events: [
        observedEvent,
        {
          eventType: 'MANUAL_REVIEW_ESCALATED',
          source: 'LOCAL',
          sourceTimestamp: null,
          facts: { reason: contradiction },
        },
      ],
    };
  }

  const nextState = STATUS_TO_STATE[observation.status];
  return {
    nextState,
    venueOrderId: observation.venueOrderId,
    executedQuantity: observation.executedQuantity,
    cumulativeQuoteQuantity: observation.cumulativeQuoteQuantity,
    terminalReason: isTerminal(nextState) ? `venue status ${observation.status}` : undefined,
    events: [observedEvent],
  };
}

/**
 * A terminal operation may still be re-queried (an operator clicking "verify
 * again"). Agreement is recorded; disagreement is escalated rather than
 * applied, because rewriting a settled outcome is exactly the failure this
 * product is supposed to prevent.
 */
function reobserveTerminal(view: OperationView, observation: OrderObservation): Decision {
  const observedState = STATUS_TO_STATE[observation.status];
  const quantityMatches = compareDecimal(view.executedQuantity, observation.executedQuantity) === 0;
  const agrees = observedState === view.state && quantityMatches;
  if (agrees) {
    return {
      nextState: view.state,
      events: [
        {
          eventType: 'ORDER_OBSERVED',
          source: 'BINANCE_ORDER_API',
          sourceTimestamp: observation.sourceTimestamp,
          facts: { ...normalizedFacts(observation), confirmsTerminalState: true },
        },
      ],
    };
  }
  throw new DomainError(
    'CONTRADICTORY_OBSERVATION',
    `terminal state ${view.state} contradicted by venue status ${observation.status}`,
    { state: view.state, observedStatus: observation.status },
  );
}

function detectContradiction(view: OperationView, observation: OrderObservation): string | null {
  if (view.venueOrderId !== null && view.venueOrderId !== observation.venueOrderId) {
    return `operation is bound to venue order ${view.venueOrderId} but observation carries ${observation.venueOrderId}`;
  }
  if (compareDecimal(view.executedQuantity, observation.executedQuantity) > 0) {
    return `recorded executed quantity ${view.executedQuantity} exceeds observed ${observation.executedQuantity}; fills cannot be undone`;
  }
  if (view.state === 'PARTIALLY_FILLED' && observation.status === 'NEW') {
    return 'operation was observed partially filled but the venue now reports an untouched order';
  }
  return null;
}

/**
 * Absence is a claim about the world, so it needs the strongest evidence of
 * any transition here. It is only accepted when nothing was ever acknowledged,
 * nothing was ever filled, and the documented observation window is exhausted.
 */
function recordOrderAbsent(
  view: OperationView,
  command: Extract<Command, { type: 'RECORD_ORDER_ABSENT' }>,
): Decision {
  const absenceEvent: DomainEvent = {
    eventType: 'ORDER_ABSENT_OBSERVED',
    source: 'BINANCE_ORDER_API',
    sourceTimestamp: null,
    facts: {
      attempts: command.attempts,
      windowMs: command.windowMs,
      windowExhausted: command.windowExhausted,
    },
  };

  if (view.venueOrderId !== null || isPositive(view.executedQuantity)) {
    return {
      nextState: 'MANUAL_REVIEW',
      events: [
        absenceEvent,
        {
          eventType: 'MANUAL_REVIEW_ESCALATED',
          source: 'LOCAL',
          sourceTimestamp: null,
          facts: {
            reason:
              'venue reports no such order for an operation that already carries a venue order id or a recorded fill',
          },
        },
      ],
    };
  }

  if (!command.windowExhausted) {
    // A single "not found" is not proof. Stay UNKNOWN and keep querying.
    return { nextState: 'UNKNOWN', events: [absenceEvent] };
  }

  return {
    nextState: 'NOT_FOUND_SAFE',
    terminalReason: `no order with this client order id after ${command.attempts} authoritative queries across ${command.windowMs}ms`,
    events: [absenceEvent],
  };
}

function requestCancel(view: OperationView): Decision {
  if (view.state !== 'ACKNOWLEDGED' && view.state !== 'PARTIALLY_FILLED') {
    throw new DomainError(
      'ILLEGAL_TRANSITION',
      `cancel requires an open order, found ${view.state}`,
      { state: view.state },
    );
  }
  return {
    nextState: 'CANCEL_REQUESTED',
    events: [
      {
        eventType: 'CANCEL_REQUESTED',
        source: 'LOCAL',
        sourceTimestamp: null,
        facts: { fromState: view.state },
      },
    ],
  };
}

function escalate(view: OperationView, reason: string): Decision {
  return {
    nextState: 'MANUAL_REVIEW',
    events: [
      {
        eventType: 'MANUAL_REVIEW_ESCALATED',
        source: 'OPERATOR',
        sourceTimestamp: null,
        facts: { reason, fromState: view.state },
      },
    ],
  };
}

function normalizedFacts(observation: OrderObservation): Record<string, unknown> {
  return {
    venueOrderId: observation.venueOrderId,
    venueClientOrderId: observation.venueClientOrderId,
    status: observation.status,
    executedQuantity: observation.executedQuantity,
    cumulativeQuoteQuantity: observation.cumulativeQuoteQuantity,
  };
}

