export interface Operation {
  operationId: string;
  intentId: string;
  venueClientOrderId: string;
  venueOrderId: string | null;
  state: string;
  stateVersion: number;
  submitAttemptCount: number;
  executedQuantity: string;
  cumulativeQuoteQuantity: string;
  firstSubmittedAt: string | null;
  lastObservedAt: string | null;
  terminalReason: string | null;
  createdAt: string;
  updatedAt: string;
  allowedActions: string[];
  retryBlockedReason: string | null;
}

export interface Intent {
  intentId: string;
  intentDigest: string;
  accountRef: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  quantity: string | null;
  quoteQuantity: string | null;
  limitPrice: string | null;
  maxNotional: string;
  createdBy: string;
  confirmationRef: string | null;
  confirmedAt: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface EvidenceEvent {
  sequence: number;
  eventType: string;
  source: string;
  sourceTimestamp: string | null;
  observedAt: string;
  payloadDigest: string;
  facts: Record<string, unknown>;
  eventHash: string;
}

export interface Readiness {
  process: string;
  journal: string;
  venue: {
    environment: string;
    reachable: boolean;
    authenticated: boolean;
    serverTimeSkewMs: number | null;
    correlation: string;
    problems: string[];
  };
  faultLabEnabled: boolean;
  executionAvailable: boolean;
}

export interface OperationDetail {
  operation: Operation;
  intent: Intent | null;
  evidence: EvidenceEvent[];
  reconciliation: { status: string; attempts: number; lastError: string | null } | null;
}

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const SESSION_STORAGE_KEY = 'orderrescue.session';

export function readSessionSecret(): string {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeSessionSecret(value: string): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, value);
  } catch {
    /* private browsing: the value simply will not persist */
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const secret = readSessionSecret();
  if (secret !== '') headers.set('x-orderrescue-session', secret);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError('DISCONNECTED', 'the OrderRescue service is not reachable from this browser');
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }

  if (!response.ok) {
    const envelope = body as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      envelope?.error?.code ?? `HTTP_${response.status}`,
      envelope?.error?.message ?? `request failed with HTTP ${response.status}`,
    );
  }
  return body as T;
}

export const api = {
  readiness: () => request<Readiness>('/ready'),
  listOperations: () => request<{ operations: Operation[] }>('/v1/operations'),
  operation: (id: string) => request<OperationDetail>(`/v1/operations/${id}`),
  faults: () => request<{ enabled: boolean; dropNextAck: boolean; armedAt: string | null }>('/v1/faults'),
  armDropAck: () => request<{ armed: boolean }>('/v1/faults/drop-ack', { method: 'POST' }),
  disarmDropAck: () => request<{ armed: boolean }>('/v1/faults/drop-ack', { method: 'DELETE' }),
  createIntent: (body: unknown, idempotencyKey: string) =>
    request<{ intent: Intent; operation: Operation; reused: boolean }>('/v1/intents', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'idempotency-key': idempotencyKey },
    }),
  confirm: (intentId: string, confirmationRef: string) =>
    request<{ operation: Operation }>(`/v1/intents/${intentId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ confirmationRef }),
    }),
  execute: (intentId: string) =>
    request<{ operationId: string; state: string; outcome: string; detail: string }>(
      `/v1/intents/${intentId}/execute`,
      { method: 'POST' },
    ),
  reconcile: (operationId: string) =>
    request<{ state: string; detail: string }>(`/v1/operations/${operationId}/reconcile`, { method: 'POST' }),
  evidenceUrl: (operationId: string) => `/v1/operations/${operationId}/evidence`,
};
