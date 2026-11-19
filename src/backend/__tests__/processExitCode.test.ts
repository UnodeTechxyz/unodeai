import { describe, expect, it } from 'vitest';
import { displayProcessExitCode } from '../processExitCode';

/*
 * v0.9.95: the exit code a sentence shows. Windows reports an exit status as an unsigned 32-bit number, so a
 * status of -4058 arrives as 4294963238. The platform is an argument, so both behaviours are checked on every
 * machine that runs this file.
 */

describe('displayProcessExitCode', () => {
  it('shows zero as zero on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(displayProcessExitCode(0, platform)).toBe(0);
    }
  });

  it.each([1, 2, 127, 255, 9009])('leaves an ordinary positive failure as it is on Windows: %d', (code) => {
    expect(displayProcessExitCode(code, 'win32')).toBe(code);
  });

  it.each([-1, -4058, -1073741819, -2147483648])('leaves a status that is already negative as it is on Windows: %d', (code) => {
    expect(displayProcessExitCode(code, 'win32')).toBe(code);
  });

  it('shows the unsigned form of a negative Windows status as the signed value', () => {
    expect(displayProcessExitCode(0xfffff026, 'win32')).toBe(-4058);
    expect(displayProcessExitCode(4294963238, 'win32')).toBe(-4058);
    // An access violation, as Windows reports the status of a process that crashed.
    expect(displayProcessExitCode(0xc0000005, 'win32')).toBe(-1073741819);
  });

  it('starts just above the largest signed 32-bit value', () => {
    expect(displayProcessExitCode(0x7fff_ffff, 'win32')).toBe(2147483647);
    expect(displayProcessExitCode(0x8000_0000, 'win32')).toBe(-2147483648);
  });

  it('ends at the largest unsigned 32-bit value', () => {
    expect(displayProcessExitCode(0xffff_ffff, 'win32')).toBe(-1);
    expect(displayProcessExitCode(0x1_0000_0000, 'win32')).toBe(4294967296);
    expect(displayProcessExitCode(0x1_0000_0001, 'win32')).toBe(4294967297);
  });

  it('shows zero for a raw zero only, so a failing code never reads as success', () => {
    const codes = [
      1, 255, 0x7fff_ffff, 0x8000_0000, 0xfffff026, 0xffff_ffff, 0x1_0000_0000, 0x1_0000_0001, 0x2_0000_0000,
      -1, -4058, -2147483648,
    ];
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      for (const code of codes) expect(displayProcessExitCode(code, platform)).not.toBe(0);
    }
  });

  it('leaves a value that is not a whole number as it is', () => {
    expect(displayProcessExitCode(0x8000_0000 + 0.5, 'win32')).toBe(2147483648.5);
    expect(displayProcessExitCode(Number.NaN, 'win32')).toBeNaN();
    expect(displayProcessExitCode(Number.POSITIVE_INFINITY, 'win32')).toBe(Number.POSITIVE_INFINITY);
  });

  it.each(['linux', 'darwin', 'freebsd'] as const)('changes no code on %s', (platform) => {
    for (const code of [0, 1, 255, -1, 0x7fff_ffff, 0x8000_0000, 0xfffff026, 0xffff_ffff, 0x1_0000_0000]) {
      expect(displayProcessExitCode(code, platform)).toBe(code);
    }
  });
});
