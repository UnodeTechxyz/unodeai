import { EventEmitter } from 'events';
import { spawn as realSpawn } from 'child_process';
import * as fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeHeadlessBackend, pluginDirArgument } from '../ClaudeHeadlessBackend';
import { SkillRegistry } from '../../skills/SkillRegistry';
import type { AgentConfig } from '../../types';
import type { BackendEvent } from '../AgentBackend';

// v0.9.99 item 4 (Owner, 2026-10-27): a temp path with a space no longer costs a Claude agent its skill plugin. The
// value is formed for the launch before anything is advertised; one a shell cannot carry is excluded cleanly.
const config = (workspace: string): AgentConfig => ({
  id: 'claude-1', name: 'Claude Dev', role: 'developer', skill: '',
  provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
  model: 'claude-sonnet-4-5', systemPrompt: 'Follow the role.', autoApprove: true,
  allowedTools: ['read', 'write', 'execute'], backend: 'claude', workingDirectory: workspace, playbooks: ['api-contract-review'],
});

function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[]; options?: Record<string, unknown> }> = [];
  const fn = (cmd: string, args: string[], options?: Record<string, unknown>) => {
    calls.push({ cmd, args, options });
    const proc = new EventEmitter() as any;
    proc.pid = 1234; proc.exitCode = null;
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined; proc.stderr.setEncoding = () => undefined;
    proc.stdin = { write: () => true, end: () => undefined };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    setTimeout(() => proc.emit('spawn'), 0);
    return proc;
  };
  return { fn, calls };
}

/** Run `body` with TEMP, TMP and TMPDIR pointing at `temp`. */
async function withTemp<T>(temp: string, body: () => Promise<T>): Promise<T> {
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = temp; process.env.TMP = temp; process.env.TMPDIR = temp;
  try { return await body(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function launch(tempName: string, shell: boolean) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-plugin-path-'));
  const temp = path.join(base, tempName);
  await fs.mkdir(temp);
  const workspace = await fs.mkdtemp(path.join(base, 'workspace-'));
  const spawn = fakeSpawn();
  const events: BackendEvent[] = [];
  const backend = new ClaudeHeadlessBackend(config(workspace), undefined, undefined, {
    spawn: spawn.fn as any,
    skillRegistry: SkillRegistry.load(path.resolve(process.cwd(), 'skills')),
    resolveClaudeLaunch: async () => ({ executable: shell ? 'C:\\tools\\claude.cmd' : 'C:\\tools\\claude.exe', shell }),
  });
  backend.onEvent((event) => events.push(event));
  await withTemp(temp, () => backend.start({} as NodeJS.ProcessEnv, { pin: 'take' }));
  return { base, temp, backend, args: spawn.calls[0].args, events };
}

describe('pluginDirArgument', () => {
  it('passes the raw path without a shell, whatever it holds', () => {
    expect(pluginDirArgument('C:\\Users\\Ada Lovelace\\Temp\\p', false)).toBe('C:\\Users\\Ada Lovelace\\Temp\\p');
    expect(pluginDirArgument('/tmp/a%b!c', false)).toBe('/tmp/a%b!c');
  });

  it('under a shell, passes a safe path as it is, quotes a path with a space, and refuses what cmd.exe still reads', () => {
    expect(pluginDirArgument('C:\\Users\\ada\\Temp\\p', true)).toBe('C:\\Users\\ada\\Temp\\p');
    expect(pluginDirArgument('C:\\Users\\Ada Lovelace\\Temp\\p', true)).toBe('"C:\\Users\\Ada Lovelace\\Temp\\p"');
    expect(pluginDirArgument('C:\\Users\\Ada (Lab) & Co\\p', true)).toBe('"C:\\Users\\Ada (Lab) & Co\\p"');
    for (const bad of ['C:\\a%PATH%\\p', 'C:\\a!b\\p', 'C:\\a"b\\p', 'C:\\a\rb', 'C:\\a\nb']) {
      expect(pluginDirArgument(bad, true)).toBeUndefined();
    }
  });
});

describe('the skill plugin with a temp path that has a space or an unsafe character', () => {
  it('mounts the plugin under a shell launch, with the path quoted as one value', async () => {
    const { base, backend, args } = await launch('Ada Lovelace', true);
    try {
      const at = args.indexOf('--plugin-dir');
      expect(at).toBeGreaterThan(-1);
      const value = args[at + 1];
      expect(value.startsWith('"') && value.endsWith('"')).toBe(true);
      const directory = value.slice(1, -1);
      expect(directory).toContain('Ada Lovelace');
      expect(existsSync(path.join(directory, '.claude-plugin', 'plugin.json'))).toBe(true);
      expect((backend as any).composeTurnText('review the contract')).toContain('/unode-agent-claude-1:api-contract-review');
      await backend.stop(50);
      expect(existsSync(directory)).toBe(false);
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });

  it('passes the raw path without a shell', async () => {
    const { base, backend, args } = await launch('Ada Lovelace', false);
    try {
      const value = args[args.indexOf('--plugin-dir') + 1];
      expect(value).toContain('Ada Lovelace');
      expect(value.startsWith('"')).toBe(false);
      expect(existsSync(path.join(value, '.claude-plugin', 'plugin.json'))).toBe(true);
      await backend.stop(50);
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });

  it('excludes the plugin under a shell when the path holds %, leaving no directory and advertising nothing', async () => {
    const { base, temp, backend, args, events } = await launch('a%b', true);
    try {
      expect(args).not.toContain('--plugin-dir');
      const prompt = (backend as any).composeTurnText('review the contract');
      expect(prompt).not.toContain('/unode-agent-');
      expect(prompt).not.toContain('extension-managed Claude plugin');
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'log', line: 'Claude skill plugin skipped: temporary path is unsafe for the Windows launcher; using L1 skill summaries.',
      }));
      expect(readdirSync(temp).filter((name) => name.startsWith('unodeai-claude-skills-'))).toEqual([]);
      expect((backend as any).skillPluginArgument).toBeUndefined();
      await backend.stop(50);
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });

  it('clears the argument with the directory when the plugin is cleaned up', async () => {
    const { base, backend } = await launch('Ada Lovelace', true);
    try {
      expect((backend as any).skillPluginArgument).toBeDefined();
      (backend as any).cleanupSkillPlugin();
      expect((backend as any).skillPluginArgument).toBeUndefined();
      expect((backend as any).buildArgs?.() ?? []).not.toContain('--plugin-dir');
      await backend.stop(50);
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });

  it('removes a half-built plugin directory when writing it fails', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-plugin-path-'));
    const temp = path.join(base, 'Ada Lovelace');
    await fs.mkdir(temp);
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    const failing = { grantedDocuments: () => { const documents = registry.grantedDocuments(['api-contract-review']); return documents.map((document) => ({ ...document, name: 'bad\u0000name' })); } };
    const backend = new ClaudeHeadlessBackend(config(base), undefined, undefined, {
      spawn: fakeSpawn().fn as any, skillRegistry: { ...registry, promptBlock: registry.promptBlock.bind(registry), grantedDocuments: failing.grantedDocuments } as never,
      resolveClaudeLaunch: async () => ({ executable: 'C:\\tools\\claude.cmd', shell: true }),
    });
    try {
      await withTemp(temp, () => backend.start({} as NodeJS.ProcessEnv, { pin: 'take' }));
      expect(readdirSync(temp).filter((name) => name.startsWith('unodeai-claude-skills-'))).toEqual([]);
      await backend.stop(50);
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
});

// R3 §3: the proof that cmd.exe hands the shim the plugin path as exactly one argument. The shim forwards %* to a
// probe, as the npm shim does; a sentinel after the backend's own arguments shows where its argv ends.
describe.runIf(process.platform === 'win32')('the Windows .cmd shim receives the plugin path as one argument', () => {
  it('passes a temp path with a space through cmd.exe as exactly one argument', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-shim-'));
    const shimDir = path.join(base, 'unode shim dir');
    const temp = path.join(base, 'temp with space');
    await fs.mkdir(shimDir); await fs.mkdir(temp);
    const workspace = await fs.mkdtemp(path.join(base, 'workspace-'));
    const out = path.join(base, 'argv.json');
    await fs.writeFile(path.join(shimDir, 'argv-probe.js'),
      'require("fs").writeFileSync(process.env.UNODE_ARGV_OUT, JSON.stringify(process.argv.slice(2)));');
    await fs.writeFile(path.join(shimDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0argv-probe.js" %*\r\n');
    const recorded: string[][] = [];
    const backend = new ClaudeHeadlessBackend(config(workspace), undefined, undefined, {
      spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
        recorded.push(args);
        return realSpawn(command, [...args, 'UNODE-SENTINEL'], { ...options, env: { ...(options.env as object), UNODE_ARGV_OUT: out } } as never);
      }) as any,
      skillRegistry: SkillRegistry.load(path.resolve(process.cwd(), 'skills')),
      resolveClaudeLaunch: async () => ({ executable: path.join(shimDir, 'claude.cmd'), shell: true }),
    });
    try {
      await withTemp(temp, () => backend.start({ ...process.env } as NodeJS.ProcessEnv, { pin: 'take' }));
      await vi.waitFor(() => { if (!existsSync(out)) throw new Error('the probe has not written yet'); }, { timeout: 15_000, interval: 100 });
      const received = JSON.parse(await fs.readFile(out, 'utf8')) as string[];
      const sent = recorded[0];
      const at = sent.indexOf('--plugin-dir');
      expect(at).toBeGreaterThan(-1);
      const pluginPath = sent[at + 1].slice(1, -1);
      expect(pluginPath).toContain(' ');
      expect(path.join(shimDir, 'claude.cmd')).toContain(' ');
      // What the shim received: the backend's argv with the quoted value unquoted, then the sentinel on its own.
      expect(received).toEqual([...sent.slice(0, at + 1), pluginPath, ...sent.slice(at + 2), 'UNODE-SENTINEL']);
    } finally {
      await backend.stop(200).catch(() => undefined);
      await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 30_000);
});
