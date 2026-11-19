/*---------------------------------------------------------------------------------------------
 *  UnodeAi - spend money arithmetic (v0.9.89)
 *
 *  Reminder money is integer nano-US dollars (`bigint`) and travels as a decimal string in JSON. Nothing
 *  here uses floating point for arithmetic: a float that rounds up could cross a target the user never
 *  reached. Every cost component rounds DOWN before it is added.
 *--------------------------------------------------------------------------------------------*/

export const NANO_PER_USD = 1_000_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;

/** A target is at least one micro-dollar and at most one million dollars (design §6.2). */
export const MIN_TARGET_NANO_USD = 1_000n;
export const MAX_TARGET_NANO_USD = 1_000_000n * NANO_PER_USD;

const CANONICAL_USD = /^(0|[1-9]\d{0,6})(?:\.(\d{1,6}))?$/;
const CANONICAL_NANO = /^(0|[1-9]\d{0,29})$/;

/**
 * Parse a user- or repository-supplied USD amount: plain digits, an optional point and at most six decimals.
 * No sign, exponent, spaces or leading zeros. Out-of-range or malformed text is `undefined`, never zero.
 */
export function parseTargetUsd(text: unknown): bigint | undefined {
  if (typeof text !== 'string') return undefined;
  const match = CANONICAL_USD.exec(text);
  if (!match) return undefined;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(9, '0'));
  const nano = whole * NANO_PER_USD + fraction;
  return nano >= MIN_TARGET_NANO_USD && nano <= MAX_TARGET_NANO_USD ? nano : undefined;
}

/** A stored nano-USD amount: a canonical non-negative integer string. */
export function parseNanoUsd(text: unknown): bigint | undefined {
  return typeof text === 'string' && CANONICAL_NANO.test(text) ? BigInt(text) : undefined;
}

export function nanoToString(value: bigint): string {
  return (value < 0n ? 0n : value).toString();
}

/**
 * A finite, non-negative decimal (a number or its string) as an exact rational: digits × 10^-scale. A provider's
 * billed JSON number goes through its shortest decimal string, so `0.1` is one tenth, not the binary value
 * nearest it. Anything else is `undefined`.
 */
export function exactDecimal(value: unknown): { digits: bigint; scale: number } | undefined {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return undefined;
  }
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return undefined;
  const fraction = match[2] ?? '';
  let digits = BigInt(`${match[1]}${fraction}`);
  let scale = fraction.length - Number(match[3] ?? 0);
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 400) return undefined;
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { digits, scale };
}

/** Billed USD (a provider number) to nano-USD, rounded down. Invalid, negative or non-finite is `undefined`. */
export function billedUsdToNano(value: unknown): bigint | undefined {
  const decimal = exactDecimal(value);
  return decimal ? (decimal.digits * NANO_PER_USD) / 10n ** BigInt(decimal.scale) : undefined;
}

/** Per-million-token rates in nano-USD. */
export interface NanoRates {
  input: bigint;
  output: bigint;
  cachedInput?: bigint;
}

export interface TokenCounts {
  input: number;
  cachedInput?: number;
  output: number;
}

/**
 * Integer cost of one usage figure (design §13.5): each component rounds down before addition, and cached input
 * is clamped to [0, input]. A missing cached rate prices cached tokens at the full input rate.
 */
export function costNano(tokens: TokenCounts, rates: NanoRates): bigint {
  const input = BigInt(Math.max(0, Math.floor(tokens.input)));
  const cachedRaw = BigInt(Math.max(0, Math.floor(tokens.cachedInput ?? 0)));
  const cached = cachedRaw > input ? input : cachedRaw;
  const fresh = input - cached;
  const output = BigInt(Math.max(0, Math.floor(tokens.output)));
  return (fresh * rates.input) / TOKENS_PER_MILLION
    + (cached * (rates.cachedInput ?? rates.input)) / TOKENS_PER_MILLION
    + (output * rates.output) / TOKENS_PER_MILLION;
}

/** A ratio (e.g. a price coefficient) applied to a rate, rounded down; `undefined` when the ratio is not valid. */
export function scaleNano(rate: bigint, ratio: unknown): bigint | undefined {
  const decimal = exactDecimal(ratio);
  return decimal ? (rate * decimal.digits) / 10n ** BigInt(decimal.scale) : undefined;
}

/**
 * Display a nano-USD amount. Rounds to the nearest displayed digit at the UI boundary only; amounts under a
 * cent keep enough digits to stay non-zero.
 */
export function formatUsd(nano: bigint): string {
  const value = nano < 0n ? 0n : nano;
  const digits = value >= NANO_PER_USD / 100n ? 2 : value >= NANO_PER_USD / 10_000n ? 4 : 6;
  const unit = 10n ** BigInt(9 - digits);
  const rounded = (value + unit / 2n) / unit;
  const whole = rounded / 10n ** BigInt(digits);
  const fraction = (rounded % 10n ** BigInt(digits)).toString().padStart(digits, '0');
  return `$${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

/** A target amount back to its canonical text (for settings writes and prompts). */
export function formatTargetUsd(nano: bigint): string {
  const whole = nano / NANO_PER_USD;
  const fraction = (nano % NANO_PER_USD).toString().padStart(9, '0').slice(0, 6).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
