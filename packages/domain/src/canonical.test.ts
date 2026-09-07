import { describe, expect, it } from 'vitest';
import { canonicalJson, deriveClientOrderId, intentDigest, isValidClientOrderId, type EconomicFields } from './canonical.js';
import { compareDecimal, multiplyDecimal } from './decimal.js';
import { redactValue, REDACTED } from './redact.js';

const baseFields: EconomicFields = {
  accountRef: 'agentic-sub-1',
  symbol: 'BNBUSDT',
  side: 'BUY',
  orderType: 'MARKET',
  quantity: null,
  quoteQuantity: '20',
  limitPrice: null,
  timeInForce: null,
};

describe('canonical json', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('treats an undefined field and an absent field identically', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('preserves array order', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('intent digest', () => {
  it('is stable across equal inputs', () => {
    expect(intentDigest(baseFields)).toBe(intentDigest({ ...baseFields }));
  });

  it.each<[keyof EconomicFields, string]>([
    ['symbol', 'BTCUSDT'],
    ['side', 'SELL'],
    ['orderType', 'LIMIT'],
    ['quoteQuantity', '21'],
    ['accountRef', 'other-sub'],
  ])('changes when the economic field %s changes', (field, value) => {
    const mutated = { ...baseFields, [field]: value } as EconomicFields;
    expect(intentDigest(mutated)).not.toBe(intentDigest(baseFields));
  });

  it('treats a null field and an explicitly absent field as the same trade', () => {
    const withoutNulls = { ...baseFields } as Record<string, unknown>;
    delete withoutNulls.limitPrice;
    expect(intentDigest(withoutNulls as unknown as EconomicFields)).toBe(intentDigest(baseFields));
  });
});

describe('derived client order id', () => {
  const intentId = '018f3f1c-0000-7000-8000-000000000001';

  it('is deterministic, so a restarted process can query for what it may have placed', () => {
    const digest = intentDigest(baseFields);
    expect(deriveClientOrderId(intentId, digest)).toBe(deriveClientOrderId(intentId, digest));
  });

  it('satisfies the documented Binance newClientOrderId pattern', () => {
    const id = deriveClientOrderId(intentId, intentDigest(baseFields));
    expect(id.length).toBeLessThanOrEqual(36);
    expect(isValidClientOrderId(id)).toBe(true);
  });

  it('differs for different intents', () => {
    const digest = intentDigest(baseFields);
    expect(deriveClientOrderId(intentId, digest)).not.toBe(
      deriveClientOrderId('018f3f1c-0000-7000-8000-000000000002', digest),
    );
  });
});

describe('decimal arithmetic', () => {
  it('compares quantities without float error', () => {
    expect(compareDecimal('0.1', '0.10000000')).toBe(0);
    expect(compareDecimal('0.00000001', '0')).toBe(1);
    expect(compareDecimal('9.99', '10')).toBe(-1);
  });

  it('multiplies exactly', () => {
    expect(multiplyDecimal('0.031', '645.16')).toBe('19.99996');
    expect(multiplyDecimal('0.1', '0.2')).toBe('0.02');
  });
});

describe('redaction', () => {
  it('removes credential-bearing keys anywhere in the payload', () => {
    const redacted = redactValue({
      headers: { 'X-MBX-APIKEY': 'live-key', accept: 'application/json' },
      nested: [{ secret: 'shh', symbol: 'BNBUSDT' }],
    }) as Record<string, any>;
    expect(redacted.headers['X-MBX-APIKEY']).toBe(REDACTED);
    expect(redacted.headers.accept).toBe('application/json');
    expect(redacted.nested[0].secret).toBe(REDACTED);
    expect(redacted.nested[0].symbol).toBe('BNBUSDT');
  });

  it('strips signatures and bearer tokens out of free-form strings', () => {
    const redacted = redactValue(
      'GET /api/v3/order?symbol=BNBUSDT&signature=deadbeefcafe with Bearer abcdef0123456789',
    ) as string;
    expect(redacted).not.toContain('deadbeefcafe');
    expect(redacted).not.toContain('abcdef0123456789');
    expect(redacted).toContain('symbol=BNBUSDT');
  });
});
