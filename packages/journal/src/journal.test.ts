import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError, type CreateIntentRequest } from '@orderrescue/domain';
import { Journal } from './journal.js';
import { exportEvidence } from './export.js';

let dir: string;
let dbPath: string;
let journal: Journal;

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orderrescue-journal-'));
  dbPath = join(dir, 'journal.db');
  journal = new Journal(dbPath);
});

afterEach(() => {
  try {
    journal.close();
  } catch {
    /* already closed by the test */
  }
  rmSync(dir, { recursive: true, force: true });
});

function approvedOperation() {
  const created = journal.createIntent(request, 'key-1');
  journal.applyCommand(created.operation.operationId, { type: 'CONFIRM_INTENT', confirmationRef: 'user-ok' });
  return created;
}

describe('idempotency', () => {
  it('returns the same intent for a repeated key and identical economics', () => {
    const first = journal.createIntent(request, 'key-1');
    const second = journal.createIntent(request, 'key-1');
    expect(second.created).toBe(false);
    expect(second.intent.intentId).toBe(first.intent.intentId);
    expect(second.operation.operationId).toBe(first.operation.operationId);
  });

  it('conflicts when the same key carries a different trade', () => {
    journal.createIntent(request, 'key-1');
    expect(() => journal.createIntent({ ...request, side: 'SELL' }, 'key-1')).toThrowError(DomainError);
    try {
      journal.createIntent({ ...request, quoteQuantity: '21' }, 'key-1');
    } catch (error) {
      expect((error as DomainError).code).toBe('IDEMPOTENCY_CONFLICT');
    }
  });

  it('leaves no half-written intent behind after a conflict', () => {
    journal.createIntent(request, 'key-1');
    expect(() => journal.createIntent({ ...request, side: 'SELL' }, 'key-1')).toThrow();
    const intents = journal.db.prepare('SELECT COUNT(*) AS n FROM intents').get() as { n: number };
    const operations = journal.db.prepare('SELECT COUNT(*) AS n FROM operations').get() as { n: number };
    expect(intents.n).toBe(1);
    expect(operations.n).toBe(1);
  });
});

describe('persist before dispatch', () => {
  it('commits the intent and its derived client order id before anything is dispatchable', () => {
    const { operation } = journal.createIntent(request, 'key-1');
    expect(operation.venueClientOrderId).toMatch(/^or_[0-9a-f]{28}$/);
    expect(operation.state).toBe('AWAITING_CONFIRMATION');
    const events = journal.getEvidence(operation.operationId);
    expect(events[0]?.eventType).toBe('INTENT_CREATED');
    expect(events[0]?.facts.venueClientOrderId).toBe(operation.venueClientOrderId);
  });

  it('authorizes dispatch once and refuses the second attempt', () => {
    const { operation } = approvedOperation();
    const first = journal.applyCommand(operation.operationId, { type: 'BEGIN_SUBMISSION' });
    expect(first.decision.authorizesDispatch).toBe(true);
    expect(first.operation.state).toBe('SUBMITTING');
    expect(() => journal.applyCommand(operation.operationId, { type: 'BEGIN_SUBMISSION' })).toThrowError(DomainError);
  });

  it('refuses a duplicate dispatch requested through a separate connection', () => {
    const { operation } = approvedOperation();
    journal.applyCommand(operation.operationId, { type: 'BEGIN_SUBMISSION' });

    // A second process holding its own connection to the same journal must
    // reach the same conclusion; duplicate suppression cannot live in memory.
    const other = new Journal(dbPath);
    try {
      expect(() => other.applyCommand(operation.operationId, { type: 'BEGIN_SUBMISSION' })).toThrowError(
        /in flight/i,
      );
      expect(other.getOperation(operation.operationId)?.state).toBe('SUBMITTING');
    } finally {
      other.close();
    }
  });

  it('rejects a write built on a stale state version', () => {
    const { operation } = approvedOperation();
    journal.applyCommand(operation.operationId, { type: 'BEGIN_SUBMISSION' });
    const stale = journal.getOperation(operation.operationId)!;
    // Something else advances the operation between our read and our write.
    journal.applyCommand(operation.operationId, { type: 'RECORD_AMBIGUOUS_SUBMISSION', reason: 'timeout' });
    expect(stale.stateVersion).toBeLessThan(journal.getOperation(operation.operationId)!.stateVersion);
  });
});

describe('restart recovery', () => {
  it('preserves UNKNOWN across a close and reopen, and re-queues observation only', () => {
    const { operation } = approvedOperation();
    journal.applyCommand(operation.operationId, { type: 'BEGIN_SUBMISSION' });
    journal.applyCommand(operation.operationId, { type: 'RECORD_AMBIGUOUS_SUBMISSION', reason: 'response dropped' });
    journal.close();

    journal = new Journal(dbPath);
    const reopened = journal.getOperation(operation.operationId);
    expect(reopened?.state).toBe('UNKNOWN');

    const resumed = journal.resumeUnresolvedOperations();
    expect(resumed).toContain(operation.operationId);
    expect(journal.getOperation(operation.operationId)?.state).toBe('UNKNOWN');
    expect(journal.getReconciliationJob(operation.operationId)?.status).toBe('PENDING');
  });

  it('converts a crash mid-dispatch into UNKNOWN rather than back into APPROVED', () => {
    const { operation } = approvedOperation();
    journal.applyCommand(operation.operationId, { type: 'BEGIN_SUBMISSION' });
    journal.close(); // process dies while the request is in flight

    journal = new Journal(dbPath);
    expect(journal.getOperation(operation.operationId)?.state).toBe('SUBMITTING');
    journal.resumeUnresolvedOperations();
    const recovered = journal.getOperation(operation.operationId)!;
    expect(recovered.state).toBe('UNKNOWN');
    expect(recovered.submitAttemptCount).toBe(1); // recovery never re-dispatches
    const reasons = journal.getEvidence(operation.operationId).map((e) => e.facts.reason);
    expect(reasons.some((r) => String(r).includes('process restarted'))).toBe(true);
  });
});

describe('evidence chain', () => {
  it('links every event and verifies clean', () => {
    const { operation } = approvedOperation();
    journal.applyCommand(operation.operationId, { type: 'BEGIN_SUBMISSION' });
    journal.applyCommand(operation.operationId, { type: 'RECORD_AMBIGUOUS_SUBMISSION', reason: 'timeout' });
    const result = journal.verifyChain();
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(4);
  });

  it('detects an edited fact', () => {
    const { operation } = approvedOperation();
    journal.db
      .prepare(`UPDATE evidence_events SET facts_json = '{"tampered":true}' WHERE sequence = 1`)
      .run();
    const result = journal.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toContain('payload digest');
    expect(operation.operationId).toBeTruthy();
  });

  it('detects a deleted event', () => {
    const { operation } = approvedOperation();
    journal.applyCommand(operation.operationId, { type: 'BEGIN_SUBMISSION' });
    journal.db.prepare('DELETE FROM evidence_events WHERE sequence = 2').run();
    const result = journal.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('sequence gap');
  });
});

describe('evidence export', () => {
  it('redacts credentials at rest, so the export cannot leak them', () => {
    const { operation } = approvedOperation();
    journal.applyCommand(operation.operationId, { type: 'BEGIN_SUBMISSION' });
    journal.applyCommand(operation.operationId, {
      type: 'RECORD_ACCOUNT_OBSERVATION',
      facts: {
        requestHeaders: { 'X-MBX-APIKEY': 'super-secret-key' },
        signature: 'abcdef0123456789',
        balances: [{ asset: 'USDT', free: '980.00' }],
      },
    });

    const stored = journal.db.prepare('SELECT facts_json FROM evidence_events').all() as { facts_json: string }[];
    const raw = stored.map((r) => r.facts_json).join('\n');
    expect(raw).not.toContain('super-secret-key');
    expect(raw).not.toContain('abcdef0123456789');

    const bundle = exportEvidence(journal, operation.operationId)!;
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('super-secret-key');
    expect(serialized).toContain('USDT');
    expect(bundle.chain.ok).toBe(true);
    expect(bundle.bundleDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('withholds the caller-chosen idempotency key from the bundle', () => {
    const { operation } = journal.createIntent(request, 'internal-ticket-4471');
    const bundle = exportEvidence(journal, operation.operationId)!;
    expect(JSON.stringify(bundle)).not.toContain('internal-ticket-4471');
  });
});

describe('reconciliation queue', () => {
  it('hands a due job to exactly one claimant', () => {
    const { operation } = approvedOperation();
    journal.enqueueReconciliation(operation.operationId);
    const first = journal.claimDueReconciliation();
    const second = journal.claimDueReconciliation();
    expect(first?.operationId).toBe(operation.operationId);
    expect(second).toBeNull();
  });

  it('makes a released job claimable again', () => {
    const { operation } = approvedOperation();
    journal.enqueueReconciliation(operation.operationId);
    journal.claimDueReconciliation();
    journal.releaseReconciliation(operation.operationId, 'PENDING', { nextAttemptAt: new Date(Date.now() - 1000) });
    expect(journal.claimDueReconciliation()?.operationId).toBe(operation.operationId);
    expect(journal.getReconciliationJob(operation.operationId)?.attempts).toBe(2);
  });
});
