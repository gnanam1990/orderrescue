import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, arrays order-preserving, no
 * whitespace. Two structurally equal values always produce the same string on
 * any machine and any Node version, which is what makes the intent digest a
 * usable identity rather than a hint.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalJson: non-finite number is not representable');
    }
    return value;
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v === undefined) continue; // undefined and absent must digest identically
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * The economic fields that define "the same trade". Anything outside this list
 * (labels, timestamps, UI metadata) may change without producing a new
 * identity; anything inside it MUST produce an idempotency conflict.
 */
export interface EconomicFields {
  accountRef: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  quantity: string | null;
  quoteQuantity: string | null;
  limitPrice: string | null;
  timeInForce: string | null;
}

export const ECONOMIC_FIELD_NAMES: ReadonlyArray<keyof EconomicFields> = [
  'accountRef',
  'symbol',
  'side',
  'orderType',
  'quantity',
  'quoteQuantity',
  'limitPrice',
  'timeInForce',
];

export function intentDigest(fields: EconomicFields): string {
  const subject: Record<string, unknown> = {};
  for (const name of ECONOMIC_FIELD_NAMES) {
    subject[name] = fields[name] ?? null;
  }
  return sha256Hex(canonicalJson({ v: 1, economic: subject }));
}

/**
 * Deterministic venue client order id derived from the intent identity.
 *
 * Binance `newClientOrderId` accepts up to 36 characters matching ^[.A-Z:/a-z0-9_-]{1,36}$.
 * Deriving it from the digest means a crashed-and-restarted process rebuilds
 * the exact same id and can therefore query for the order it may have placed.
 */
export function deriveClientOrderId(intentId: string, digest: string): string {
  const material = sha256Hex(canonicalJson({ v: 1, intentId, digest }));
  return `or_${material.slice(0, 28)}`;
}

const CLIENT_ORDER_ID_PATTERN = /^[.A-Z:/a-z0-9_-]{1,36}$/;

export function isValidClientOrderId(value: string): boolean {
  return CLIENT_ORDER_ID_PATTERN.test(value);
}
