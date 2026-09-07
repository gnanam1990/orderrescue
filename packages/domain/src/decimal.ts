/**
 * Exchange quantities are decimal strings and must never round-trip through a
 * float. These helpers compare and add them as scaled BigInts so that
 * "0.1" + "0.2" === "0.3" and a fill of "0.00000001" is never lost.
 */
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/u;

export function isDecimal(value: string): boolean {
  return DECIMAL_PATTERN.test(value.trim());
}

function parse(value: string): { negative: boolean; digits: string; scale: number } {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new Error(`not a decimal string: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const dot = unsigned.indexOf('.');
  if (dot === -1) return { negative, digits: unsigned, scale: 0 };
  const fraction = unsigned.slice(dot + 1);
  return { negative, digits: unsigned.slice(0, dot) + fraction, scale: fraction.length };
}

function toScaled(value: string, scale: number): bigint {
  const parsed = parse(value);
  const shift = scale - parsed.scale;
  if (shift < 0) throw new Error('internal: target scale below value scale');
  const magnitude = BigInt(parsed.digits || '0') * 10n ** BigInt(shift);
  return parsed.negative ? -magnitude : magnitude;
}

function commonScale(a: string, b: string): number {
  return Math.max(parse(a).scale, parse(b).scale);
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const scale = commonScale(a, b);
  const left = toScaled(a, scale);
  const right = toScaled(b, scale);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function isZero(value: string): boolean {
  return compareDecimal(value, '0') === 0;
}

export function isPositive(value: string): boolean {
  return compareDecimal(value, '0') > 0;
}

export function multiplyDecimal(a: string, b: string): string {
  const pa = parse(a);
  const pb = parse(b);
  const product = BigInt(pa.digits || '0') * BigInt(pb.digits || '0');
  const scale = pa.scale + pb.scale;
  const negative = pa.negative !== pb.negative && product !== 0n;
  return format(negative ? -product : product, scale);
}

function format(scaled: bigint, scale: number): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale) || '0';
  const fraction = scale > 0 ? digits.slice(digits.length - scale) : '';
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}
