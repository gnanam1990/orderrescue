/**
 * Redaction runs on the way IN to the journal, not on the way out to a
 * response. Anything that reaches storage is already safe to export, so an
 * export bug cannot leak a credential that was never written.
 */
const SECRET_KEY_PATTERN =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-mbx-apikey|apikey|api_key|apisecret|api_secret|secret|secretkey|secret_key|password|passphrase|token|access_token|refresh_token|id_token|signature|privatekey|private_key|mnemonic|seed)$/i;

export const REDACTED = '[redacted]';

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return redactString(value);
  return value;
}

const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const QUERY_SECRET_PATTERN = /([?&](?:signature|apiKey|api_key|token|secret)=)[^&\s]+/gi;

export function redactString(value: string): string {
  return value.replace(BEARER_PATTERN, `$1 ${REDACTED}`).replace(QUERY_SECRET_PATTERN, `$1${REDACTED}`);
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}
