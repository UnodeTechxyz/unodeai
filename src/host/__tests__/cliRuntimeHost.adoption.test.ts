import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_NPM_LAUNCHER_PROGRAM } from '../../backend/cliClosure';
import { createCliRuntimeHost } from '../cliRuntimeHost';

// The adoption of an external Claude launcher, through the window's real host wiring: the question describes the
// launcher whose files were hashed, and the check that follows the OK runs exactly that launcher. The setting is never
// read again for it, so a launcher configured while the question is open runs nothing (Codex's audit of 87092b9, F1).

const probes: Array<{ executable: string; shell: boolean }> = [];
let duringProbe: (() => void) | undefined;
let probeWait: Promise<void> | undefined;
let probeFails = false;
vi.mock('../claudeGateProbe', () => ({
  runClaudeGateProbe: async (request: { launch: { executable: string; shell: boolean } }) => {
    probes.push({ ...request.launch });
    await probeWait;
    if (probeFails) return { result: 'fail', detail: 'test failure' };
    duringProbe?.();
    return { result: 'pass', version: '2.1.305', versionOutput: '2.1.305 (Claude Code)', startedAt: '2026-10-21T00:00:00.000Z', durationMs: 300 };
  },
}));

const temps: string[] = [];
beforeEach(() => { probes.length = 0; duringProbe = undefined; probeWait = undefined; probeFails = false; });
afterEach(() => { for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true }); });

/** An npm install of Claude: the `.cmd` launcher and the program it starts, beside it. */
function launcher(root: string, name: string): string {
  const folder = path.join(root, name);
  const program = path.join(folder, ...CLAUDE_NPM_LAUNCHER_PROGRAM);
  mkdirSync(path.dirname(program), { recursive: true });
  writeFileSync(program, `MZ claude of ${name}`);
  const cmd = path.join(folder, 'claude.cmd');
  writeFileSync(cmd, `@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n`);
  return cmd;
}

function world() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'unode-adopt-')));
  temps.push(root);
  const appData = path.join(root, 'LocalAppData');
  mkdirSync(appData);
  const check = path.join(root, 'check');
  mkdirSync(check);
  const logs: string[] = [];
  const configured = { cmd: launcher(root, 'first') };
  const second = launcher(root, 'second');
  const pins = new Map<string, unknown>();
  const host = createCliRuntimeHost({
    env: { LOCALAPPDATA: appData },
    platform: 'win32',
    // Not x64: managed Codex is not offered, so only the adoption is wired.
    arch: 'arm64',
    execPath: process.execPath,
    extensionVersion: '0.9.97',
    globalStorage: path.join(root, 'global'),
    workspaceRoots: () => [],
    agentReach: () => ({ writeRoots: [], folderAccessGrants: [] }),
    checkFolder: () => check,
    externalProgram: () => ({ executable: configured.cmd, shell: true }),
    physical: (file) => realpathSync.native(file),
    agentEnv: () => ({}),
    pins: { load: (id) => pins.get(id), save: async (id, pin) => { pins.set(id, pin); } },
    windowAllowed: () => true,
    shutdown: { started: false } as never,
    log: line => logs.push(line),
  });
  return { host, configured, second, logs, first: configured.cmd };
}

describe.runIf(process.platform === 'win32')('the adoption of an external Claude launcher, through the host wiring (v0.9.97)', () => {
  it('a failed background check reports a reminder and does not refuse a start', async () => {
    const w = world(); probeFails = true;
    let starts = 0;
    await w.host.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, async () => { starts++; return {} as never; });
    await vi.waitFor(() => expect(w.logs.join('\n')).toContain('agent can keep running'));
    expect(starts).toBe(1);
  });
  it('starts without a modal or waiting for the background check, then records the exact checked launcher', async () => {
    const w = world();
    let finish!: () => void;
    probeWait = new Promise<void>(resolve => { finish = resolve; });
    const spawned: string[] = [];
    const started = await w.host.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, async (program) => {
      spawned.push(program.executable);
      return {} as never;
    });
    expect(started.version).toBe('not-yet-checked');
    expect(spawned).toEqual([w.first]);
    finish();
    await vi.waitFor(async () => expect((await w.host.facts('claude-cli', w.first)).verdict).toBe('adopted'));
    expect(probes).toEqual([{ executable: w.first, shell: true }]);
    expect(probes.some((launch) => launch.executable === w.second)).toBe(false);
    expect(w.logs.join('\n')).toContain('2.1.305');
  });

  it('records no adoption when the files changed while they were checked', async () => {
    const w = world();
    duringProbe = () => writeFileSync(path.join(path.dirname(w.first), ...CLAUDE_NPM_LAUNCHER_PROGRAM), 'MZ replaced while checked');
    await w.host.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, async () => ({}) as never);
    await vi.waitFor(() => expect(w.logs.join('\n')).toContain('check was not recorded'));
    duringProbe = undefined;
    // Asked again: the record of the first answer was not written.
    expect((await w.host.facts('claude-cli', w.first)).verdict).toBe('needs-adoption');
  });
});
