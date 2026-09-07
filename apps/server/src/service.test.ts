import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError, type CreateIntentRequest } from '@orderrescue/domain';
import { Journal } from '@orderrescue/journal';
import { BinanceSpotAdapter } from '@orderrescue/adapter-binance';
import { loadConfig } from './config.js';
import { OrderRescueService } from './service.js';

/**
 * Only the network is stubbed. The real classification table, the real domain
 * machine, and the real SQLite journal all run, so these tests exercise the
 * code that will face Binance rather than a parallel implementation of it.
 */
interface VenueScript {
  exchangeInfo: () => Response;
  account: () => Response;
  placeOrder: () => Response | Promise<Response>;
  orderStatus: () => Response;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const EXCHANGE_INFO = {
  symbols: [
    {
      symbol: 'BNBUSDT',
      status: 'TRADING',
      baseAsset: 'BNB',
      quoteAsset: 'USDT',
      filters: [
        { filterType: 'LOT_SIZE', minQty: '0.00100000', stepSize: '0.00100000' },
        { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
        { filterType: 'NOTIONAL', minNotional: '5.00000000', maxNotional: '9000000.00000000' },
      ],
    },
  ],
};

const FILLED_ORDER = {
  symbol: 'BNBUSDT',
  orderId: 4477112,
  clientOrderId: 'placeholder',
  transactTime: 1788779481758,
  updateTime: 1788779481758,
  status: 'FILLED',
  executedQty: '0.03100000',
  cummulativeQuoteQty: '20.00000000',
};

let dir: string;
let dbPath: string;
let service: OrderRescueService;
let script: VenueScript;
let placementCount = 0;

const request: CreateIntentRequest = {
  accountRef: 'agentic-sub-1',
  symbol: 'BNBUSDT',
  side: 'BUY',
  orderType: 'MARKET',
  quoteQuantity: '20',
  maxNotional: '25',
  expiresInSeconds: 3600,
  createdBy: 'demo-agent',
};

function buildService(): OrderRescueService {
  const config = loadConfig({
    ORDERRESCUE_DB_PATH: dbPath,
    BINANCE_API_KEY: 'test-key',
    BINANCE_API_SECRET: 'test-secret',
    ORDERRESCUE_ABSENCE_MIN_ATTEMPTS: '3',
    ORDERRESCUE_ABSENCE_WINDOW_MS: '5000',
  } as NodeJS.ProcessEnv);

  const fetchImpl: typeof fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/v3/time') return jsonResponse(200, { serverTime: Date.now() });
    if (path === '/api/v3/exchangeInfo') return script.exchangeInfo();
    if (path === '/api/v3/account') return script.account();
    if (path === '/api/v3/order' && init.method === 'POST') {
      placementCount += 1;
      return script.placeOrder();
    }
    if (path === '/api/v3/order') return script.orderStatus();
    return jsonResponse(404, { code: -1121, msg: 'unknown route' });
  }) as unknown as typeof fetch;

  const adapter = new BinanceSpotAdapter({
    baseUrl: config.binance.baseUrl,
    apiKey: config.binance.apiKey,
    apiSecret: config.binance.apiSecret,
    recvWindowMs: config.binance.recvWindowMs,
    timeoutMs: 2000,
    environment: 'TESTNET',
    fetchImpl,
  });

  return new OrderRescueService(config, new Journal(dbPath), adapter);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orderrescue-service-'));
  dbPath = join(dir, 'journal.db');
  placementCount = 0;
  script = {
    exchangeInfo: () => jsonResponse(200, EXCHANGE_INFO),
    account: () => jsonResponse(200, { updateTime: Date.now(), balances: [{ asset: 'USDT', free: '980.00', locked: '0' }] }),
    placeOrder: () => jsonResponse(200, FILLED_ORDER),
    orderStatus: () => jsonResponse(200, FILLED_ORDER),
  };
  service = buildService();
});

afterEach(async () => {
  await service.stop();
  try {
    service.journal.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

async function readyOperation() {
  const created = await service.createIntent(request, `key-${Math.random()}`);
  service.confirmIntent(created.operation.operationId, 'user-approved-in-agent-os');
  return created;
}

describe('intent validation', () => {
  it('refuses a notional above the server cap', async () => {
    await expect(service.createIntent({ ...request, quoteQuantity: '500', maxNotional: '500' }, 'k')).rejects.toThrow(
      /exceeds the server cap/,
    );
  });

  it('refuses a notional below the live venue minimum', async () => {
    await expect(service.createIntent({ ...request, quoteQuantity: '1' }, 'k')).rejects.toThrow(/venue minimum/);
  });

  it('refuses to execute an unconfirmed intent', async () => {
    const created = await service.createIntent(request, 'k');
    await expect(service.executeIntent(created.operation.operationId)).rejects.toThrow(/not been confirmed/);
    expect(placementCount).toBe(0);
  });
});

describe('the lost-response path end to end', () => {
  it('reaches UNKNOWN, blocks the retry, survives restart, and reconciles to FILLED against one order', async () => {
    const { operation } = await readyOperation();

    // The order really is sent; only our knowledge of the answer is destroyed.
    service.fault.dropNextAck = true;
    const executed = await service.executeIntent(operation.operationId);
    expect(executed.outcome).toBe('UNKNOWN');
    expect(executed.state).toBe('UNKNOWN');
    expect(placementCount).toBe(1);

    // A naive agent retries here. This is the moment the product exists for.
    await expect(service.executeIntent(operation.operationId)).rejects.toThrowError(DomainError);
    expect(placementCount).toBe(1);

    // Restart the process. UNKNOWN must survive it.
    await service.stop();
    service.journal.close();
    service = buildService();
    expect(service.journal.getOperation(operation.operationId)?.state).toBe('UNKNOWN');
    service.journal.resumeUnresolvedOperations();
    expect(placementCount).toBe(1); // recovery observes; it never resubmits

    // Ask Binance what actually happened, by the id written before dispatch.
    const reconciled = await service.reconcileOnce(operation.operationId, 1);
    expect(reconciled.state).toBe('FILLED');

    const settled = service.journal.getOperation(operation.operationId)!;
    expect(settled.venueOrderId).toBe('4477112');
    expect(settled.executedQuantity).toBe('0.03100000');
    expect(settled.submitAttemptCount).toBe(1);
    expect(placementCount).toBe(1); // exactly one order exists at the venue

    // And the retry stays blocked afterwards, for the opposite reason.
    await expect(service.executeIntent(operation.operationId)).rejects.toThrow(/already executed/);

    const bundle = service.exportEvidence(operation.operationId)!;
    expect(bundle.chain.ok).toBe(true);
    const types = bundle.events.map((e) => e.eventType);
    expect(types).toContain('SUBMISSION_AMBIGUOUS');
    expect(types).toContain('ORDER_OBSERVED');
    expect(types).toContain('ACCOUNT_OBSERVED');
  });

  it('resolves a genuine -1007 timeout the same way', async () => {
    const { operation } = await readyOperation();
    script.placeOrder = () => jsonResponse(400, { code: -1007, msg: 'Timeout waiting for response from backend server.' });

    const executed = await service.executeIntent(operation.operationId);
    expect(executed.outcome).toBe('UNKNOWN');
    await expect(service.executeIntent(operation.operationId)).rejects.toThrowError(DomainError);

    script.orderStatus = () => jsonResponse(200, { ...FILLED_ORDER, status: 'PARTIALLY_FILLED', executedQty: '0.01000000' });
    const reconciled = await service.reconcileOnce(operation.operationId, 1);
    expect(reconciled.state).toBe('PARTIALLY_FILLED');
    // A partial fill is exposure; it must not unlock a retry.
    await expect(service.executeIntent(operation.operationId)).rejects.toThrow(/partially filled/i);
  });
});

describe('absence', () => {
  it('keeps an operation UNKNOWN until the observation window is exhausted', async () => {
    const { operation } = await readyOperation();
    script.placeOrder = () => {
      throw new TypeError('fetch failed');
    };
    await service.executeIntent(operation.operationId);
    script.orderStatus = () => jsonResponse(400, { code: -2013, msg: 'Order does not exist.' });

    // Attempts below the threshold cannot settle absence, however many times asked.
    for (const attempt of [1, 2]) {
      const result = await service.reconcileOnce(operation.operationId, attempt);
      expect(result.state).toBe('UNKNOWN');
    }
  });

  it('never turns an unreachable venue into absence', async () => {
    const { operation } = await readyOperation();
    script.placeOrder = () => {
      throw new TypeError('fetch failed');
    };
    await service.executeIntent(operation.operationId);

    script.orderStatus = () => {
      throw new TypeError('fetch failed');
    };
    const result = await service.reconcileOnce(operation.operationId, 99);
    expect(result.state).toBe('UNKNOWN');
    expect(service.journal.getOperation(operation.operationId)?.terminalReason).toBeNull();
  });
});

describe('rejection', () => {
  it('records a venue-identified rejection as terminal without a retry block', async () => {
    const { operation } = await readyOperation();
    script.placeOrder = () => jsonResponse(400, { code: -2010, msg: 'Account has insufficient balance.' });
    const executed = await service.executeIntent(operation.operationId);
    expect(executed.outcome).toBe('REJECTED');
    expect(service.journal.getOperation(operation.operationId)?.state).toBe('REJECTED');
  });

  it('treats a 5xx as unknown rather than a rejection', async () => {
    const { operation } = await readyOperation();
    script.placeOrder = () => jsonResponse(503, { code: -1000, msg: 'Service unavailable.' });
    const executed = await service.executeIntent(operation.operationId);
    expect(executed.outcome).toBe('UNKNOWN');
  });
});

describe('configuration lockout', () => {
  it('refuses to start against mainnet', () => {
    expect(() => loadConfig({ ORDERRESCUE_ENV: 'MAINNET' } as NodeJS.ProcessEnv)).toThrow(/Testnet only/i);
  });

  it('refuses a mainnet base url even when the mode says testnet', () => {
    expect(() => loadConfig({ BINANCE_BASE_URL: 'https://api.binance.com' } as NodeJS.ProcessEnv)).toThrow(
      /mainnet host/,
    );
  });

  it('refuses to execute without credentials instead of pretending', async () => {
    const config = loadConfig({ ORDERRESCUE_DB_PATH: join(dir, 'nocreds.db') } as NodeJS.ProcessEnv);
    const bare = new OrderRescueService(config, new Journal(join(dir, 'nocreds.db')));
    const created = bare.journal.createIntent(request, 'k');
    bare.confirmIntent(created.operation.operationId, 'ok');
    await expect(bare.executeIntent(created.operation.operationId)).rejects.toThrow(/refusing to pretend/);
    bare.journal.close();
  });
});
