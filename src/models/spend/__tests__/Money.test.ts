import { describe, expect, it } from 'vitest';
import {
  billedUsdToNano,
  costNano,
  exactDecimal,
  formatTargetUsd,
  formatUsd,
  MAX_TARGET_NANO_USD,
  MIN_TARGET_NANO_USD,
  parseNanoUsd,
  parseTargetUsd,
  scaleNano,
} from '../Money';

describe('parseTargetUsd', () => {
  it('accepts the canonical range and exact decimals', () => {
    expect(parseTargetUsd('0.000001')).toBe(MIN_TARGET_NANO_USD);
    expect(parseTargetUsd('1000000.000000')).toBe(MAX_TARGET_NANO_USD);
    expect(parseTargetUsd('5.00')).toBe(5_000_000_000n);
    expect(parseTargetUsd('0.1')).toBe(100_000_000n);
    expect(parseTargetUsd('12')).toBe(12_000_000_000n);
  });

  it('rejects everything else instead of turning it into zero or infinity', () => {
    for (const bad of ['0', '0.0000001', '1000000.000001', '-1', '+1', '1e3', ' 1', '01', '1.', '.5', 'NaN', 'Infinity', '', '1,000']) {
      expect(parseTargetUsd(bad), bad).toBeUndefined();
    }
    expect(parseTargetUsd(5)).toBeUndefined();
    expect(parseTargetUsd(undefined)).toBeUndefined();
  });
});

describe('billed amounts', () => {
  it('goes through the shortest decimal string, not the binary float', () => {
    expect(billedUsdToNano(0.1)).toBe(100_000_000n);
    expect(billedUsdToNano(0.30000000000000004)).toBe(300_000_000n);
    expect(billedUsdToNano(1e-7)).toBe(100n);
    expect(billedUsdToNano(2.5e3)).toBe(2_500_000_000_000n);
  });

  it('rounds down below a nano-dollar', () => {
    expect(billedUsdToNano(0.0000000019)).toBe(1n);
    expect(billedUsdToNano(0.0000000009)).toBe(0n);
  });

  it('makes invalid, negative and non-finite values unavailable', () => {
    expect(billedUsdToNano(-0.1)).toBeUndefined();
    expect(billedUsdToNano(Number.NaN)).toBeUndefined();
    expect(billedUsdToNano(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(billedUsdToNano('abc')).toBeUndefined();
    expect(exactDecimal('-1')).toBeUndefined();
  });
});

describe('costNano', () => {
  const rates = { input: 1_000_000_000n, output: 3_000_000_000n, cachedInput: 100_000_000n };

  it('floors each component before adding', () => {
    // 1 input token at $1/M = 1000 nano; 1 output at $3/M = 3000 nano.
    expect(costNano({ input: 1, output: 1 }, rates)).toBe(4000n);
    // 1 token at 0.0000001 $/token rounds down per component.
    expect(costNano({ input: 1, output: 0 }, { input: 999n, output: 0n })).toBe(0n);
    expect(costNano({ input: 3, output: 3 }, { input: 500_000n, output: 500_000n })).toBe(2n);
  });

  it('prices cached input at its own rate and clamps it to the input', () => {
    expect(costNano({ input: 1_000_000, cachedInput: 400_000, output: 0 }, rates)).toBe(600_000_000n + 40_000_000n);
    expect(costNano({ input: 10, cachedInput: 50, output: 0 }, rates)).toBe(1_000n);
    expect(costNano({ input: 1_000_000, cachedInput: 1_000_000, output: 0 }, { input: 7n, output: 0n })).toBe(7n);
  });

  it('never rounds a total above the exact rational cost', () => {
    const inputRate = 333_333n;
    for (let n = 1; n < 200; n++) {
      const exactTimesMillion = BigInt(n) * inputRate;
      expect(costNano({ input: n, output: 0 }, { input: inputRate, output: 0n }) * 1_000_000n <= exactTimesMillion).toBe(true);
    }
  });
});

describe('formatting', () => {
  it('shows small amounts without collapsing to zero', () => {
    expect(formatUsd(0n)).toBe('$0.000000');
    expect(formatUsd(1_234n)).toBe('$0.000001');
    expect(formatUsd(123_456n)).toBe('$0.0001');
    expect(formatUsd(12_345_678n)).toBe('$0.01');
    expect(formatUsd(1_234_567_890_123n)).toBe('$1,234.57');
  });

  it('round-trips target text', () => {
    expect(formatTargetUsd(5_000_000_000n)).toBe('5');
    expect(formatTargetUsd(1_500n)).toBe('0.000001');
    expect(formatTargetUsd(parseTargetUsd('12.345')!)).toBe('12.345');
  });

  it('parses only canonical stored nano strings', () => {
    expect(parseNanoUsd('0')).toBe(0n);
    expect(parseNanoUsd('00')).toBeUndefined();
    expect(parseNanoUsd('-1')).toBeUndefined();
    expect(parseNanoUsd('1.5')).toBeUndefined();
  });

  it('scales a rate by an exact ratio and rejects invalid ratios', () => {
    expect(scaleNano(1_000n, 0.33)).toBe(330n);
    expect(scaleNano(1_000n, '1.0625')).toBe(1_062n);
    expect(scaleNano(1_000n, 0)).toBe(0n);
    expect(scaleNano(1_000n, -1)).toBeUndefined();
  });
});
