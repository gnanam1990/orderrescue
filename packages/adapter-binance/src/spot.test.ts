import { describe, expect, it } from 'vitest';
import { BINANCE_ORDER_NOT_FOUND_CODE, BINANCE_TIMEOUT_CODE, BinanceSpotAdapter, classifySubmission, toObservation } from './spot.js';
import { BinanceSignedClient, type RawResponse } from './client.js';

function response(status: number, body: unknown, options: { unparseable?: boolean } = {}): RawResponse {
  const bodyText = options.unparseable ? '<html>502 Bad Gateway</html>' : JSON.stringify(body);
  let json: unknown = null;
  let parsed = false;
  try {
    json = JSON.parse(bodyText);
    parsed = true;
  } catch {
    parsed = false;
  }
  return { status, bodyText, json, parsed, headers: {} };
}

const filledBody = {
  symbol: 'BNBUSDT',
  orderId: 4477112,
  clientOrderId: 'or_deadbeef',
  transactTime: 1788779481758,
  status: 'FILLED',
  executedQty: '0.03100000',
  cummulativeQuoteQty: '20.00000000',
};

describe('submission classification', () => {
  it('acknowledges a well-formed success', () => {
    const outcome = classifySubmission(response(200, filledBody), 'req');
    expect(outcome.kind).toBe('ACKNOWLEDGED');
    if (outcome.kind !== 'ACKNOWLEDGED') return;
    expect(outcome.observation.venueOrderId).toBe('4477112');
    expect(outcome.observation.executedQuantity).toBe('0.03100000');
  });

  it('treats Binance -1007 TIMEOUT as unknown, not failed', () => {
    const outcome = classifySubmission(response(400, { code: BINANCE_TIMEOUT_CODE, msg: 'Timeout waiting for response from backend server.' }), 'req');
    expect(outcome.kind).toBe('AMBIGUOUS');
    if (outcome.kind !== 'AMBIGUOUS') return;
    expect(outcome.reason).toContain('-1007');
  });

  it.each([500, 502, 503, 504])('treats HTTP %i as unknown, not failed', (status) => {
    expect(classifySubmission(response(status, { code: -1000, msg: 'unknown error' }), 'req').kind).toBe('AMBIGUOUS');
  });

  it.each([429, 418])('treats rate-limit HTTP %i as unknown rather than assumed rejected', (status) => {
    expect(classifySubmission(response(status, { code: -1003, msg: 'Too many requests' }), 'req').kind).toBe('AMBIGUOUS');
  });

  it('treats HTTP 409 as a possible partial success', () => {
    expect(classifySubmission(response(409, { code: -2021, msg: 'Order cancel-replace partially failed' }), 'req').kind).toBe(
      'AMBIGUOUS',
    );
  });

  it('treats an unreadable HTTP 200 as unknown', () => {
    const outcome = classifySubmission(response(200, null, { unparseable: true }), 'req');
    expect(outcome.kind).toBe('AMBIGUOUS');
  });

  it('treats a 200 without an order identity as unknown', () => {
    const outcome = classifySubmission(response(200, { symbol: 'BNBUSDT' }), 'req');
    expect(outcome.kind).toBe('AMBIGUOUS');
  });

  it('treats a 4xx without a venue error envelope as unknown, since a proxy may have produced it', () => {
    const outcome = classifySubmission(response(403, null, { unparseable: true }), 'req');
    expect(outcome.kind).toBe('AMBIGUOUS');
    if (outcome.kind !== 'AMBIGUOUS') return;
    expect(outcome.reason).toContain('unproven');
  });

  it('accepts rejection only when the venue identifies itself', () => {
    const outcome = classifySubmission(response(400, { code: -2010, msg: 'Account has insufficient balance.' }), 'req');
    expect(outcome.kind).toBe('REJECTED');
    if (outcome.kind !== 'REJECTED') return;
    expect(outcome.venueCode).toBe(-2010);
  });
});

describe('observation normalization', () => {
  it('reads the misspelled cummulativeQuoteQty field Binance actually returns', () => {
    expect(toObservation(filledBody)?.cumulativeQuoteQuantity).toBe('20.00000000');
  });

  it('rejects an unknown status rather than guessing', () => {
    expect(toObservation({ ...filledBody, status: 'SOMETHING_NEW' })).toBeNull();
  });

  it('keeps the venue timestamp as an ISO instant', () => {
    expect(toObservation(filledBody)?.sourceTimestamp).toBe('2026-09-07T11:11:21.758Z');
  });
});

describe('request digests', () => {
  it('excludes credentials, signature, and timestamp so a digest is comparable and safe', () => {
    const a = BinanceSignedClient.requestDigest('POST', '/api/v3/order', {
      symbol: 'BNBUSDT',
      timestamp: '1',
      signature: 'aaa',
      apiKey: 'secret-key',
    });
    const b = BinanceSignedClient.requestDigest('POST', '/api/v3/order', {
      symbol: 'BNBUSDT',
      timestamp: '2',
      signature: 'bbb',
      apiKey: 'other-key',
    });
    expect(a).toBe(b);
  });
});

describe('transport failures with no response at all', () => {
  function adapterWith(fetchImpl: typeof fetch, afterDispatch?: () => void) {
    return new BinanceSpotAdapter({
      baseUrl: 'https://testnet.binance.vision',
      apiKey: 'k',
      apiSecret: 's',
      recvWindowMs: 5000,
      timeoutMs: 50,
      environment: 'TESTNET',
      fetchImpl,
      ...(afterDispatch ? { afterDispatch } : {}),
    });
  }

  const placement = {
    symbol: 'BNBUSDT',
    side: 'BUY' as const,
    orderType: 'MARKET' as const,
    quantity: null,
    quoteQuantity: '20',
    limitPrice: null,
    timeInForce: null,
    clientOrderId: 'or_deadbeef',
  };

  it('reports a socket failure as ambiguous', async () => {
    const outcome = await adapterWith((async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch).placeOrder(placement);
    expect(outcome.kind).toBe('AMBIGUOUS');
  });

  it('reports an aborted request as ambiguous', async () => {
    const hang: typeof fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    const outcome = await adapterWith(hang).placeOrder(placement);
    expect(outcome.kind).toBe('AMBIGUOUS');
    if (outcome.kind !== 'AMBIGUOUS') return;
    expect(outcome.reason).toContain('timed out');
  });

  it('runs the fault hook only after the venue has already answered', async () => {
    const order: string[] = [];
    const fetchImpl: typeof fetch = (async () => {
      order.push('venue-received-request');
      return new Response(JSON.stringify(filledBody), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const outcome = await adapterWith(fetchImpl, () => {
      order.push('fault-hook');
    }).placeOrder(placement);
    expect(order).toEqual(['venue-received-request', 'fault-hook']);
    expect(outcome.kind).toBe('ACKNOWLEDGED'); // the fault layer above decides what to do with it
  });
});

describe('status queries', () => {
  it('reports an authoritative -2013 as absence evidence', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ code: BINANCE_ORDER_NOT_FOUND_CODE, msg: 'Order does not exist.' }), {
        status: 400,
      })) as unknown as typeof fetch;
    const adapter = new BinanceSpotAdapter({
      baseUrl: 'https://testnet.binance.vision',
      apiKey: 'k',
      apiSecret: 's',
      recvWindowMs: 5000,
      timeoutMs: 1000,
      environment: 'TESTNET',
      fetchImpl,
    });
    const outcome = await adapter.getOrderByClientOrderId('BNBUSDT', 'or_missing');
    expect(outcome.kind).toBe('ABSENT');
  });

  it('reports an unreachable venue as unavailable, never as absence', async () => {
    const fetchImpl: typeof fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const adapter = new BinanceSpotAdapter({
      baseUrl: 'https://testnet.binance.vision',
      apiKey: 'k',
      apiSecret: 's',
      recvWindowMs: 5000,
      timeoutMs: 1000,
      environment: 'TESTNET',
      fetchImpl,
    });
    const outcome = await adapter.getOrderByClientOrderId('BNBUSDT', 'or_x');
    expect(outcome.kind).toBe('UNAVAILABLE');
  });
});
