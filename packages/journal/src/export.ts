import { canonicalJson, sha256Hex, type EvidenceEvent, type Operation, type TradeIntent } from '@orderrescue/domain';
import type { Journal } from './journal.js';

export interface EvidenceBundle {
  bundleVersion: 1;
  generatedAt: string;
  operation: Operation;
  intent: Omit<TradeIntent, 'idempotencyKey'>;
  events: EvidenceEvent[];
  chain: { ok: boolean; checked: number; brokenAt: number | null; reason: string | null };
  bundleDigest: string;
}

/**
 * The export is an allow-list, not a filter: every exported field is named
 * here explicitly, so a column added to the journal later cannot leak into a
 * shared bundle just because nobody remembered to exclude it.
 *
 * idempotencyKey is withheld — it is caller-chosen and can carry internal
 * identifiers that have no business in a file the user will attach to a report.
 */
export function exportEvidence(journal: Journal, operationId: string): EvidenceBundle | null {
  const operation = journal.getOperation(operationId);
  if (operation === null) return null;
  const intent = journal.getIntent(operation.intentId);
  if (intent === null) return null;

  const { idempotencyKey: _withheld, ...intentFields } = intent;
  const body = {
    bundleVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    operation,
    intent: intentFields,
    events: journal.getEvidence(operationId),
    chain: journal.verifyChain(),
  };

  return { ...body, bundleDigest: sha256Hex(canonicalJson(body)) };
}
