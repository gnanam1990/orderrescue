export type DomainErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'ILLEGAL_TRANSITION'
  | 'TERMINAL_STATE'
  | 'RETRY_BLOCKED'
  | 'NOT_CONFIRMED'
  | 'INTENT_EXPIRED'
  | 'NOTIONAL_CAP_EXCEEDED'
  | 'CONTRADICTORY_OBSERVATION'
  | 'VALIDATION_FAILED';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
