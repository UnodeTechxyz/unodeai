/*---------------------------------------------------------------------------------------------
 *  UnodeAi - processExitCode (v0.9.95)
 *  The exit code a sentence shows for a process. Windows hands an exit status back as an unsigned 32-bit
 *  number, so a status a program set as -4058 arrives as 4294963238 and reads as nothing a person or a model
 *  can look up. This is for text only: what a caller compares, stores or records stays the raw code. A leaf
 *  module: it imports nothing, starts no process and decides nothing about one.
 *--------------------------------------------------------------------------------------------*/

/**
 * The code as it is shown. On Windows a whole number above the signed 32-bit range and within the unsigned one
 * is shown as the signed value it stands for. Every other code, and every code on another platform, is shown as
 * it is. A raw zero is the only code shown as zero.
 */
export function displayProcessExitCode(raw: number, platform: NodeJS.Platform): number {
  return platform === 'win32' && Number.isInteger(raw) && raw > 0x7fff_ffff && raw <= 0xffff_ffff
    ? raw - 0x1_0000_0000
    : raw;
}
