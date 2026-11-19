import { describe, expect, it } from 'vitest';
import type { CliClosureFile } from '../../backend/cliCompatibilityPolicy';
import { ADOPTION_CHECK_BUTTON, ADOPTION_NOT_NOW_BUTTON, adoptionDialog, formatAdoptionBytes, type AdoptionDialogInput } from '../cliAdoptionDialog';
import type { AuthenticodeCheckResult, AuthenticodeFileVerdict } from '../windowsAuthenticode';

// The design these tests realise: the adoption dialog, every line filled from measured facts. The physical path and
// install type; "UnodeAi did not install or update it"; "Version: not yet verified. UnodeAi has not started this
// program."; the package line with the file count and size of the measured listing; the signature line from the
// Authenticode results (counts per publisher, the unsigned file named) or "not checked: <reason>"; the run sentence;
// [Check and use this program] [Not now]. Variants: unbounded (helpers not covered), Claude single file, launcher-pair.
// Off Windows x64: "UnodeAi qualifies CLI versions on Windows x64 only."

const hex = (seed: string) => seed.repeat(64).slice(0, 64);
const ROOT = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc';
const EXE = `${ROOT}\\bin\\codex.exe`;
const WINDOWS = { platform: 'win32' as const, arch: 'x64', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\u' }, execPath: 'C:\\Program Files\\nodejs\\node.exe' };

function packageFiles(count: number, size: number): CliClosureFile[] {
  return [
    { path: 'bin/codex.exe', size: 341_270_320, sha256: hex('a') },
    { path: 'codex-path/rg.exe', size: 5_000_000, sha256: hex('b') },
    ...Array.from({ length: count - 2 }, (_, index) => ({ path: `codex-resources/r${index}.dll`, size, sha256: hex('c') })),
  ];
}

type Checked = Extract<AuthenticodeCheckResult, { status: 'checked' }>;

function signed(openai: number, crt: number, unsigned: string[], extra: Partial<Checked> = {}): Checked {
  const files: AuthenticodeFileVerdict[] = [
    ...Array.from({ length: openai }, (_, index) => ({ path: `${ROOT}\\bin\\f${index}.exe`, signer: 'openai' as const, accepted: true as const, alternative: 0, signatureType: 'Authenticode' as const, revocation: 'confirmed-online' as const })),
    ...Array.from({ length: crt }, (_, index) => ({ path: `${ROOT}\\codex-resources\\vcruntime${index}.dll`, signer: 'microsoft-crt' as const, accepted: true as const, alternative: 1, signatureType: 'Catalog' as const, revocation: 'confirmed-online' as const })),
    ...unsigned.map((file) => ({ path: file, signer: 'unsigned' as const, accepted: true as const })),
  ];
  return {
    status: 'checked', accepted: true, revoked: false, files, notSent: [],
    counts: { openai, 'microsoft-crt': crt, unsigned: unsigned.length }, unsignedFiles: unsigned, revocation: 'confirmed-online', ...extra,
  };
}

function codex(overrides: Partial<AdoptionDialogInput> = {}): AdoptionDialogInput {
  return {
    provider: 'codex-cli', executable: EXE,
    closure: { kind: 'package', files: packageFiles(45, 2_689_000), executablePath: 'bin/codex.exe', root: ROOT },
    signatures: signed(43, 1, [`${ROOT}\\codex-path\\rg.exe`]),
    host: WINDOWS,
    ...overrides,
  };
}

describe('the adoption dialog', () => {
  it('says what was measured for a package, in the order of the design', () => {
    const dialog = adoptionDialog(codex());
    expect(dialog.title).toBe('Use Codex CLI with UnodeAi?');
    expect(dialog.buttons).toEqual([ADOPTION_CHECK_BUTTON, ADOPTION_NOT_NOW_BUTTON]);
    expect(dialog.buttons).toEqual(['Check and use this program', 'Not now']);
    expect(dialog.lines).toEqual([
      `Program: ${EXE} (npm global install). UnodeAi did not install or update it.`,
      'Version: not yet verified. UnodeAi has not started this program.',
      // 341,270,320 + 5,000,000 + 43 × 2,689,000 = 461,897,320 bytes.
      'Package: 45 files, 461.9 MB, checked by hash. This exact set is not one UnodeAi has qualified.',
      'Publisher signatures: 43 files signed by OpenAI OpCo, LLC; 1 by Microsoft; 1 without a signature (codex-path/rg.exe).',
      'If you continue, UnodeAi starts it once in its own folder to read its version and check its safety interfaces. That run sends no model request and opens no workspace. If the check passes, agents use this exact package. Any change to one of its files asks again.',
    ]);
  });

  it('takes every count and size from the listing and the results, never from a constant', () => {
    const small = adoptionDialog(codex({ closure: { kind: 'package', files: packageFiles(3, 10), executablePath: 'bin/codex.exe', root: ROOT }, signatures: signed(2, 0, []) }));
    expect(small.lines[2]).toBe('Package: 3 files, 346.3 MB, checked by hash. This exact set is not one UnodeAi has qualified.');
    expect(small.lines[3]).toBe('Publisher signatures: 2 files signed by OpenAI OpCo, LLC.');
    const big = adoptionDialog(codex({ closure: { kind: 'package', files: packageFiles(1_200, 1_000_000), executablePath: 'bin/codex.exe', root: ROOT } }));
    expect(big.lines[2]).toBe('Package: 1,200 files, 1.5 GB, checked by hash. This exact set is not one UnodeAi has qualified.');
    expect(adoptionDialog(codex()).lines[2]).not.toBe(small.lines[2]);
  });

  it('names a file whose signature failed, and says when revocation was not confirmed', () => {
    const failed: AuthenticodeFileVerdict = { path: `${ROOT}\\bin\\codex.exe`, signer: 'openai', accepted: false, revoked: false, reason: 'Windows reports its signature as HashMismatch', reported: { status: 'HashMismatch', type: 'Authenticode' } };
    const base = signed(42, 1, [`${ROOT}\\codex-path\\rg.exe`], { revocation: 'not-confirmed-offline', accepted: false });
    const dialog = adoptionDialog(codex({ signatures: { ...base, files: [...base.files, failed] } }));
    expect(dialog.lines[3]).toBe('Publisher signatures: 42 files signed by OpenAI OpCo, LLC; 1 by Microsoft; 1 without a signature (codex-path/rg.exe); 1 not verified (bin/codex.exe: Windows reports its signature as HashMismatch). Revocation: revocation not confirmed (offline).');
  });

  it('says why the signatures were not checked', () => {
    expect(adoptionDialog(codex({ signatures: { status: 'unavailable', reason: 'constrained-language', message: 'PowerShell is restricted by policy (constrained language)', diagnostic: 'CLM' } })).lines[3])
      .toBe('Publisher signatures: not checked: PowerShell is restricted by policy (constrained language).');
    expect(adoptionDialog(codex({ signatures: { status: 'not-checked', reason: 'this is not Windows' } })).lines[3])
      .toBe('Publisher signatures: not checked: this is not Windows.');
  });

  it('for an unbounded program, says that what it starts from beside it is not covered, and checks only the program', () => {
    const dialog = adoptionDialog(codex({
      executable: 'D:\\tools\\codex.exe',
      closure: { kind: 'unbounded', files: [{ path: 'codex.exe', size: 341_270_320, sha256: hex('a') }], executablePath: 'codex.exe' },
      signatures: { ...signed(1, 0, []), files: [{ path: 'D:\\tools\\codex.exe', signer: 'openai', accepted: true, alternative: 0, signatureType: 'Authenticode', revocation: 'confirmed-online' }] },
    }));
    expect(dialog.lines).toEqual([
      'Program: D:\\tools\\codex.exe (chosen file). UnodeAi did not install or update it.',
      'Version: not yet verified. UnodeAi has not started this program.',
      'Package: UnodeAi could not identify the package this program belongs to, so programs it may start from beside it (for example rg.exe) are not identified, not checked, and not covered by this choice. Only codex.exe itself (341.3 MB) is checked by hash.',
      'Publisher signature of codex.exe: OpenAI OpCo, LLC.',
      'If you continue, UnodeAi starts it once in its own folder to read its version and check its safety interfaces. That run sends no model request and opens no workspace. If the check passes, agents use this exact program. Any change to it asks again.',
    ]);
    expect(dialog.lines.join('\n')).not.toMatch(/Publisher signatures:/);
  });

  it('for Claude, a single file and the vendor\'s own update check', () => {
    const dialog = adoptionDialog({
      provider: 'claude-cli', executable: 'C:\\Users\\u\\.local\\bin\\claude.exe',
      closure: { kind: 'single-file', files: [{ path: 'claude.exe', size: 276_800_000, sha256: hex('d') }], executablePath: 'claude.exe' },
      signatures: { status: 'not-checked', reason: 'UnodeAi holds no pinned publisher identity for Claude CLI' },
      host: WINDOWS,
    });
    expect(dialog.title).toBe('Use Claude CLI with UnodeAi?');
    expect(dialog.lines[0]).toBe('Program: C:\\Users\\u\\.local\\bin\\claude.exe (native installer). UnodeAi did not install or update it.');
    expect(dialog.lines[2]).toBe('Package: 1 file, 276.8 MB, checked by hash. This exact file is not one UnodeAi has qualified.');
    expect(dialog.lines[3]).toBe('Publisher signature: not checked: UnodeAi holds no pinned publisher identity for Claude CLI.');
    expect(dialog.lines.at(-1)).toMatch(/Starting it may also run Claude Code's own update check\. If the check passes, agents use this exact file\. Any change to it asks again\.$/);
  });

  it('for npm\'s launcher, names both files and says the launcher is an unsigned script', () => {
    const dialog = adoptionDialog({
      provider: 'claude-cli', executable: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd',
      closure: {
        kind: 'launcher-pair',
        files: [
          { path: 'claude.cmd', size: 400, sha256: hex('e') },
          { path: 'node_modules/@anthropic-ai/claude-code/bin/claude.exe', size: 290_228_384, sha256: hex('f') },
        ],
        executablePath: 'claude.cmd',
      },
      signatures: { status: 'not-checked', reason: 'not requested' },
      host: WINDOWS,
    });
    expect(dialog.lines[2]).toBe('Package: 2 files, 290.2 MB, checked by hash: the launcher claude.cmd and the program it starts, node_modules/@anthropic-ai/claude-code/bin/claude.exe. The launcher is a script that is not signed. This exact pair is not one UnodeAi has qualified.');
    expect(dialog.lines[3]).toBe('Publisher signature of claude.exe: not checked: not requested.');
    expect(dialog.lines.at(-1)).toMatch(/agents use these exact two files\. Any change to either file asks again\.$/);
  });

  it('says that versions are qualified on Windows x64 only, off that platform only', () => {
    const sentence = 'UnodeAi qualifies CLI versions on Windows x64 only.';
    expect(adoptionDialog(codex()).lines).not.toContain(sentence);
    for (const host of [{ ...WINDOWS, arch: 'arm64' }, { ...WINDOWS, platform: 'linux' as const }, { ...WINDOWS, platform: 'darwin' as const }]) {
      expect(adoptionDialog(codex({ host, signatures: { status: 'not-checked', reason: 'not Windows' } })).lines).toContain(sentence);
    }
  });

  it('never says that UnodeAi updated the program', () => {
    for (const kind of ['package', 'unbounded'] as const) {
      const text = adoptionDialog(codex({ closure: { kind, files: packageFiles(3, 1), executablePath: 'bin/codex.exe', root: ROOT } })).lines.join('\n');
      expect(text).not.toMatch(/UnodeAi (has )?updated|\bUpdated\b/);
    }
  });

  it('formats sizes in decimal units with one decimal place', () => {
    expect([0, 1, 999, 1_000, 465_730_000, 341_270_320, 1_500_000_000].map(formatAdoptionBytes))
      .toEqual(['0 bytes', '1 byte', '999 bytes', '1.0 kB', '465.7 MB', '341.3 MB', '1.5 GB']);
  });
});
