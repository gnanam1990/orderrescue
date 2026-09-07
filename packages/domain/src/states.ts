/**
 * OrderRescue lifecycle states.
 *
 * The single rule that shapes this file: a lost or ambiguous transport
 * response is NOT evidence that the venue rejected the order. Ambiguity gets
 * its own state (UNKNOWN) and its own exit path (authoritative reconciliation).
 */
export const OPERATION_STATES = [
  'DRAFT',
  'AWAITING_CONFIRMATION',
  'APPROVED',
  'SUBMITTING',
  'ACKNOWLEDGED',
  'PARTIALLY_FILLED',
  'FILLED',
  'UNKNOWN',
  'RECONCILING',
  'NOT_FOUND_SAFE',
  'MANUAL_REVIEW',
  'REJECTED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type OperationState = (typeof OPERATION_STATES)[number];

/**
 * Terminal states never transition again. NOT_FOUND_SAFE is terminal only
 * because reaching it already required an exhausted, documented observation
 * window (see `notFoundSafe` policy in reconcile.ts) — it is not a timeout.
 */
const TERMINAL: ReadonlySet<OperationState> = new Set<OperationState>([
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'NOT_FOUND_SAFE',
]);

export function isTerminal(state: OperationState): boolean {
  return TERMINAL.has(state);
}

/**
 * States in which the venue may already hold an economic action for this
 * intent. While any of these hold, no new order may be dispatched for the same
 * intent — this is the product's core invariant.
 */
const MAY_HAVE_ECONOMIC_EFFECT: ReadonlySet<OperationState> = new Set<OperationState>([
  'SUBMITTING',
  'ACKNOWLEDGED',
  'PARTIALLY_FILLED',
  'FILLED',
  'UNKNOWN',
  'RECONCILING',
  'CANCEL_REQUESTED',
  'MANUAL_REVIEW',
]);

export function mayHaveEconomicEffect(state: OperationState): boolean {
  return MAY_HAVE_ECONOMIC_EFFECT.has(state);
}

/** Human-readable explanation shown wherever a retry control is disabled. */
export function retryBlockReason(state: OperationState): string | null {
  switch (state) {
    case 'SUBMITTING':
      return 'A submission for this intent is in flight. A second dispatch could create a duplicate order.';
    case 'UNKNOWN':
      return 'The venue response was lost. The original order may already exist and may already have filled. Reconcile against authoritative order status before any further economic action.';
    case 'RECONCILING':
      return 'Authoritative order status is being queried. Wait for the result.';
    case 'ACKNOWLEDGED':
      return 'Binance acknowledged an order for this intent. It is open, not absent.';
    case 'PARTIALLY_FILLED':
      return 'This intent is partially filled. A partial fill is exposure, not absence.';
    case 'FILLED':
      return 'This intent already executed. Retrying would double the position.';
    case 'CANCEL_REQUESTED':
      return 'A cancellation is in flight and its outcome is not yet authoritative.';
    case 'MANUAL_REVIEW':
      return 'Observations disagree. A human must resolve the contradiction before any further economic action.';
    default:
      return null;
  }
}

export type AllowedAction =
  | 'CONFIRM'
  | 'EXECUTE'
  | 'RECONCILE'
  | 'REQUEST_CANCEL'
  | 'ESCALATE'
  | 'EXPORT_EVIDENCE';

export function allowedActions(state: OperationState): AllowedAction[] {
  const base: AllowedAction[] = ['EXPORT_EVIDENCE'];
  switch (state) {
    case 'DRAFT':
      return [...base, 'CONFIRM'];
    case 'AWAITING_CONFIRMATION':
      return [...base, 'CONFIRM'];
    case 'APPROVED':
      return [...base, 'EXECUTE'];
    case 'SUBMITTING':
      return base;
    case 'UNKNOWN':
      return [...base, 'RECONCILE', 'ESCALATE'];
    case 'RECONCILING':
      return base;
    case 'ACKNOWLEDGED':
      return [...base, 'RECONCILE', 'REQUEST_CANCEL', 'ESCALATE'];
    case 'PARTIALLY_FILLED':
      return [...base, 'RECONCILE', 'REQUEST_CANCEL', 'ESCALATE'];
    case 'CANCEL_REQUESTED':
      return [...base, 'RECONCILE'];
    case 'MANUAL_REVIEW':
      return [...base, 'RECONCILE'];
    default:
      return base;
  }
}
