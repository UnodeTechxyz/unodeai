import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { verifyCodexCliPreflight } from '../CodexCliPreflight';

const binary = path.resolve('tools/codex.exe');
const env = { PATH: 'safe' };

describe('Codex CLI preflight diagnostics', () => {
  it.each([
    { code: 7, signal: null, output: 'startup failed', expected: 'exit 7; startup failed' },
    { code: null, signal: 'SIGTERM' as const, output: '', expected: 'exit none, signal SIGTERM; no output' },
    { code: 0, signal: null, output: 'codex-cli 0.154.0', expected: 'exit 0; codex-cli 0.154.0' },
    { code: 0, signal: null, output: '', expected: 'exit 0; no output' },
  ])('throws an actionable version error for $expected without checking login', async ({ expected, ...result }) => {
    const run = vi.fn().mockResolvedValue(result);
    await expect(verifyCodexCliPreflight(binary, env, run, () => true)).rejects.toThrow(
      `Codex CLI version check failed for ${binary} (${expected}). UnodeAi requires codex-cli 0.155.0 or newer; newer builds must also pass the live App Server and effective-policy checks. Windows validation records 0.155.1.`,
    );
    expect(run.mock.calls).toEqual([[binary, ['--version'], env]]);
  });

  it('checks login only after a valid version and returns the exact version', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code: 0, signal: null, output: 'codex-cli 0.155.1' })
      .mockResolvedValueOnce({ code: 0, signal: null, output: 'Logged in' });
    await expect(verifyCodexCliPreflight(binary, env, run, () => true)).resolves.toBe('0.155.1');
    expect(run.mock.calls).toEqual([[binary, ['--version'], env], [binary, ['login', 'status'], env]]);
  });

  it('rejects an unconfigured executable before spawning anything', async () => {
    const run = vi.fn();
    await expect(verifyCodexCliPreflight(binary, env, run, () => false)).rejects.toThrow('not configured');
    await expect(verifyCodexCliPreflight('relative', env, run, () => true)).rejects.toThrow('not configured');
    expect(run).not.toHaveBeenCalled();
  });

  it('preserves login failure without mistaking it for a version failure', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code: 0, signal: null, output: 'codex-cli 0.155.1' })
      .mockResolvedValueOnce({ code: 1, signal: null, output: 'Not logged in' });
    await expect(verifyCodexCliPreflight(binary, env, run, () => true)).rejects.toThrow('Codex CLI is not logged in');
  });

  it('keeps the real extension preflight wired to this checked implementation', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/extension.ts'), 'utf8');
    const start = source.indexOf('async function verifyCodexCli(');
    const body = source.slice(start, source.indexOf('\n}', start));
    expect(body).toContain('return verifyCodexCliPreflight(binaryPath, env, runCodexCli);');
  });
});
