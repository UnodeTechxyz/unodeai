/** Exact decimal/rational values for fixed host computations; allocation stays in the resource-bounded worker. */
import { getHeapStatistics } from 'node:v8';

/** Leave room for decimal strings, BigInts, intermediate arithmetic and the surrounding workbook worker. */
export const workbookArithmeticDigitAllowance = () => Math.max(1, Math.floor(getHeapStatistics().heap_size_limit / 64));
export interface ExactValue { numerator: string; denominator: string }
const gcd = (left: bigint, right: bigint): bigint => {
  left = left < 0n ? -left : left; right = right < 0n ? -right : right;
  while (right) { const remainder = left % right; left = right; right = remainder; } return left;
};
export class WorkbookExactNumber {
  constructor(readonly numerator: bigint, readonly denominator: bigint = 1n) {
    if (denominator === 0n) throw new Error('division-by-zero');
    const factor = gcd(numerator, denominator); const sign = denominator < 0n ? -1n : 1n;
    this.numerator = numerator / factor * sign; this.denominator = denominator / factor * sign;
  }
  static parse(raw: string, digitAllowance = workbookArithmeticDigitAllowance()): WorkbookExactNumber {
    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(raw);
    if (!match) throw new Error('ambiguous-or-nonnumeric-literal');
    const fraction = match[3] ?? match[4] ?? ''; const digits = ((match[2] ?? '') + fraction).replace(/^0+/, '') || '0';
    // Zero never needs an exponent-sized allocation.
    if (digits === '0') return new WorkbookExactNumber(0n);
    const exponent = BigInt(match[5] ?? '0') - BigInt(fraction.length);
    const magnitude = exponent < 0n ? -exponent : exponent;
    if (digitAllowance !== undefined) {
      if (!Number.isSafeInteger(digitAllowance) || digitAllowance < 1) throw new Error('invalid-arithmetic-resource');
      if (magnitude + BigInt(digits.length) > BigInt(digitAllowance)) throw new Error('arithmetic-resource-budget');
    }
    const coefficient = BigInt(digits) * (match[1] === '-' ? -1n : 1n); const scale = 10n ** magnitude;
    return exponent < 0n ? new WorkbookExactNumber(coefficient, scale) : new WorkbookExactNumber(coefficient * scale);
  }
  add(other: WorkbookExactNumber): WorkbookExactNumber {
    const factor = gcd(this.denominator, other.denominator);
    return new WorkbookExactNumber(this.numerator * (other.denominator / factor) + other.numerator * (this.denominator / factor), this.denominator / factor * other.denominator);
  }
  multiply(other: WorkbookExactNumber): WorkbookExactNumber {
    const first = gcd(this.numerator, other.denominator); const second = gcd(other.numerator, this.denominator);
    return new WorkbookExactNumber(this.numerator / first * (other.numerator / second), this.denominator / second * (other.denominator / first));
  }
  divide(other: WorkbookExactNumber): WorkbookExactNumber { return this.multiply(new WorkbookExactNumber(other.denominator, other.numerator)); }
  compare(other: WorkbookExactNumber): number { const value = this.numerator * other.denominator - other.numerator * this.denominator; return value < 0n ? -1 : value > 0n ? 1 : 0; }
  json(): ExactValue { return { numerator: this.numerator.toString(), denominator: this.denominator.toString() }; }
  /** Whether the actual IEEE754 value equals this rational, not whether a decimal roundtrip merely looks similar. */
  chartNumber(): { value: number | null; exact: boolean } {
    const negative = this.numerator < 0n; const numerator = negative ? -this.numerator : this.numerator;
    if (!numerator) return { value: 0, exact: true };
    let binaryExponent = numerator.toString(2).length - this.denominator.toString(2).length;
    if (binaryExponent >= 0 ? numerator < (this.denominator << BigInt(binaryExponent)) : (numerator << BigInt(-binaryExponent)) < this.denominator) binaryExponent--;
    if (binaryExponent > 1023) return { value: null, exact: false };
    if (binaryExponent < -1075) return { value: negative ? -0 : 0, exact: false };
    const shiftForSignificand = binaryExponent < -1022 ? 1074 : 52 - binaryExponent;
    const top = shiftForSignificand >= 0 ? numerator << BigInt(shiftForSignificand) : numerator;
    const bottom = shiftForSignificand < 0 ? this.denominator << BigInt(-shiftForSignificand) : this.denominator;
    let significand = top / bottom; const remainder = top % bottom;
    if (remainder * 2n > bottom || (remainder * 2n === bottom && significand % 2n !== 0n)) significand++;
    const value = (negative ? -1 : 1) * Number(significand) * 2 ** -shiftForSignificand;
    if (!Number.isFinite(value)) return { value: null, exact: false };
    if (value === 0) return { value, exact: this.numerator === 0n };
    const bytes = new ArrayBuffer(8); const view = new DataView(bytes); view.setFloat64(0, value, false);
    const bits = view.getBigUint64(0, false); const exponent = Number(bits >> 52n & 0x7ffn);
    const mantissa = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
    const shift = (exponent || 1) - 1023 - 52; const sign = bits >> 63n ? -1n : 1n;
    const actual = shift >= 0 ? new WorkbookExactNumber(sign * (mantissa << BigInt(shift))) : new WorkbookExactNumber(sign * mantissa, 1n << BigInt(-shift));
    return { value, exact: this.compare(actual) === 0 };
  }
}
