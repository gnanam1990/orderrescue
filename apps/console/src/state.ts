export type Tone = 'unknown' | 'settled' | 'danger' | 'active' | 'neutral';

interface Presentation {
  label: string;
  tone: Tone;
  glyph: string;
}

/**
 * Every state gets a word and a glyph as well as a colour, so the console is
 * readable without colour vision and in a screenshot printed in greyscale.
 */
const PRESENTATION: Record<string, Presentation> = {
  DRAFT: { label: 'Draft', tone: 'neutral', glyph: '·' },
  AWAITING_CONFIRMATION: { label: 'Awaiting confirmation', tone: 'neutral', glyph: '?' },
  APPROVED: { label: 'Approved', tone: 'active', glyph: '>' },
  SUBMITTING: { label: 'Submitting', tone: 'active', glyph: '>' },
  ACKNOWLEDGED: { label: 'Open at venue', tone: 'active', glyph: '=' },
  PARTIALLY_FILLED: { label: 'Partially filled', tone: 'unknown', glyph: '~' },
  FILLED: { label: 'Filled', tone: 'settled', glyph: '+' },
  UNKNOWN: { label: 'Execution unknown', tone: 'unknown', glyph: '?' },
  RECONCILING: { label: 'Reconciling', tone: 'active', glyph: '*' },
  NOT_FOUND_SAFE: { label: 'No order placed', tone: 'settled', glyph: '0' },
  MANUAL_REVIEW: { label: 'Manual review', tone: 'danger', glyph: '!' },
  REJECTED: { label: 'Rejected by venue', tone: 'neutral', glyph: 'x' },
  CANCEL_REQUESTED: { label: 'Cancel requested', tone: 'active', glyph: '-' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', glyph: 'x' },
  EXPIRED: { label: 'Expired', tone: 'neutral', glyph: 'x' },
};

export function present(state: string): Presentation {
  return PRESENTATION[state] ?? { label: state, tone: 'neutral', glyph: '·' };
}

const STALE_AFTER_MS = 30_000;

export function freshness(lastObservedAt: string | null): { text: string; stale: boolean } {
  if (lastObservedAt === null) return { text: 'never observed', stale: true };
  const ageMs = Date.now() - new Date(lastObservedAt).getTime();
  return { text: `${formatAge(ageMs)} ago`, stale: ageMs > STALE_AFTER_MS };
}

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

export function describeEconomics(intent: {
  side: string;
  symbol: string;
  orderType: string;
  quantity: string | null;
  quoteQuantity: string | null;
  limitPrice: string | null;
}): string {
  const size =
    intent.quoteQuantity !== null ? `${intent.quoteQuantity} quote` : `${intent.quantity ?? '?'} base`;
  const price = intent.limitPrice !== null ? ` @ ${intent.limitPrice}` : '';
  return `${intent.side} ${intent.symbol} · ${intent.orderType} · ${size}${price}`;
}
