import { EventEmitter } from 'node:events';
import { promises as loaderFs } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCodexAccountModels, parseCodexAccountModels, parseCodexImageInputModels } from '../CodexModelLoader';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeAppServer(options: { floodOnInitialize?: boolean } = {}) {
  const messages: any[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter() as any;
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split(/\r?\n/)) {
        if (!line) continue;
        const message = JSON.parse(line);
        messages.push(message);
        if (message.method === 'initialize') {
          if (options.floodOnInitialize) {
            stdout.write('x'.repeat(4 * 1024 * 1024 + 1));
            callback();
            return;
          }
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake' } })}\n`);
        } else if (message.method === 'model/list') {
          stdout.write(`${JSON.stringify({
            jsonrpc: '2.0', id: message.id, result: { data: [
              { id: 'gpt-6-sol', displayName: 'GPT-6 Sol', inputModalities: ['text', 'image'], isDefault: true },
              { id: 'hidden', hidden: true },
            ] },
          })}\n`);
        }
      }
      callback();
    },
  });
  Object.assign(emitter, { stdin, stdout, stderr, pid: 4242, kill: vi.fn() });
  const calls: any[] = [];
  const spawn = vi.fn((command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
    return emitter;
  });
  return { spawn, calls, messages };
}

describe('Codex model-list-only session', () => {
  it('uses a neutral cwd, sends only initialize/model-list requests, and always stops the process tree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'unode-codex-models-'));
    temporaryDirectories.push(root);
    const workspace = path.join(root, 'workspace');
    const neutral = path.join(root, 'global-storage', 'codex-model-discovery');
    const fake = fakeAppServer();
    const kill = vi.fn(async () => undefined);

    const models = await loadCodexAccountModels({
      binaryPath: path.join(root, 'codex.exe'),
      neutralWorkingDirectory: neutral,
      workspaceRoots: [workspace],
      env: { PATH: 'safe', OPENAI_API_KEY: 'must-not-cross', CODEX_API_KEY: 'must-not-cross' },
      spawn: fake.spawn as any,
      assertCurrent: () => undefined,
      killProcessTree: kill,
      clientVersion: '0.9.84',
    });

    expect(models).toEqual([{ id: 'gpt-6-sol', name: 'GPT-6 Sol', vision: true, isDefault: true }]);
    expect(fake.calls).toHaveLength(1);
    // The loader runs in the physical folder it checked (an 8.3 temp path resolves to its long form).
    expect(fake.calls[0].options).toMatchObject({ cwd: await realpath(neutral), shell: false, windowsHide: true });
    expect(fake.calls[0].options.env.OPENAI_API_KEY).toBeUndefined();
    expect(fake.calls[0].options.env.CODEX_API_KEY).toBeUndefined();
    expect(fake.calls[0].args).toContain('sandbox_mode="read-only"');
    expect(fake.messages.map((message) => message.method)).toEqual(['initialize', 'model/list']);
    expect(fake.messages.some((message) => /thread|turn|config\/read/.test(String(message.method)))).toBe(false);
    expect(kill).toHaveBeenCalledWith(4242);
  });

  it.each([
    [{ status: 'confirmed-stopped' }],
    [{ status: 'unknown', detail: 'taskkill timed out' }],
  ] as const)('v0.9.97: with onStopped, observes the stop of the tree and reports it (%o); nothing is killed by number', async (outcome) => {
    const root = await mkdtemp(path.join(tmpdir(), 'unode-codex-models-'));
    temporaryDirectories.push(root);
    const fake = fakeAppServer();
    const kill = vi.fn(async () => undefined);
    const terminate = vi.fn(async () => outcome);
    const stops: unknown[] = [];
    await loadCodexAccountModels({
      binaryPath: path.join(root, 'codex.exe'),
      neutralWorkingDirectory: path.join(root, 'global-storage', 'codex-model-discovery'),
      spawn: fake.spawn as any,
      assertCurrent: () => undefined,
      killProcessTree: kill,
      terminateProcessTree: terminate,
      onStopped: (stopped) => stops.push(stopped),
    });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
    expect(stops).toEqual([outcome]);
  });

  it('v0.9.97: reports a failed observation as a stop that is not confirmed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'unode-codex-models-'));
    temporaryDirectories.push(root);
    const fake = fakeAppServer();
    const stops: unknown[] = [];
    await loadCodexAccountModels({
      binaryPath: path.join(root, 'codex.exe'),
      neutralWorkingDirectory: path.join(root, 'global-storage', 'codex-model-discovery'),
      spawn: fake.spawn as any,
      assertCurrent: () => undefined,
      terminateProcessTree: async () => { throw new Error('process list unavailable'); },
      onStopped: (stopped) => stops.push(stopped),
    });
    expect(stops).toEqual([{ status: 'unknown', detail: 'process list unavailable' }]);
  });

  it('refuses a neutral directory inside the workspace before spawning', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'unode-codex-models-'));
    temporaryDirectories.push(root);
    const fake = fakeAppServer();
    await expect(loadCodexAccountModels({
      binaryPath: path.join(root, 'codex.exe'),
      neutralWorkingDirectory: path.join(root, 'workspace', '.storage'),
      workspaceRoots: [path.join(root, 'workspace')],
      spawn: fake.spawn as any,
      assertCurrent: () => undefined,
    })).rejects.toThrow(/inside a workspace/i);
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it('refuses an extension-storage symlink that resolves into the workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'unode-codex-models-'));
    temporaryDirectories.push(root);
    const workspace = path.join(root, 'workspace');
    const storage = path.join(root, 'global-storage');
    const neutral = path.join(storage, 'codex-model-discovery');
    await mkdir(workspace);
    await mkdir(storage);
    await symlink(workspace, neutral, process.platform === 'win32' ? 'junction' : 'dir');
    const fake = fakeAppServer();

    await expect(loadCodexAccountModels({
      binaryPath: path.join(root, 'codex.exe'),
      neutralWorkingDirectory: neutral,
      workspaceRoots: [workspace],
      spawn: fake.spawn as any,
      assertCurrent: () => undefined,
    })).rejects.toThrow(/inside a workspace/i);
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it('asks the host right before it spawns, after its folder preparation, and starts nothing for a stale operation (v0.9.96)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'unode-codex-models-'));
    temporaryDirectories.push(root);
    const workspace = path.join(root, 'workspace');
    const neutral = path.join(root, 'global-storage', 'codex-model-discovery');
    await mkdir(workspace);
    // Each await of the preparation in turn: making the folder, resolving it, resolving a workspace root.
    const pauses: Array<{ name: string; matches: (method: string, target: string) => boolean }> = [
      { name: 'mkdir', matches: (method, target) => method === 'mkdir' && target === neutral },
      { name: 'folder realpath', matches: (method, target) => method === 'realpath' && target === neutral },
      { name: 'workspace realpath', matches: (method, target) => method === 'realpath' && target === workspace },
    ];
    for (const stale of [false, true]) {
      for (const pause of pauses) {
        const label = `${stale ? 'stale' : 'current'} during ${pause.name}`;
        const order: string[] = [];
        let current = true;
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        let reached!: () => void;
        const waiting = new Promise<void>((resolve) => { reached = resolve; });
        const realMkdir = loaderFs.mkdir.bind(loaderFs);
        const realRealpath = loaderFs.realpath.bind(loaderFs);
        const hold = (method: string, target: unknown) => {
          if (!pause.matches(method, String(target))) return Promise.resolve();
          reached();
          return released;
        };
        const mkdirSpy = vi.spyOn(loaderFs, 'mkdir').mockImplementation((async (target: any, options: any) => {
          await hold('mkdir', target);
          return realMkdir(target, options);
        }) as any);
        const realpathSpy = vi.spyOn(loaderFs, 'realpath').mockImplementation((async (target: any, options: any) => {
          await hold('realpath', target);
          return realRealpath(target, options);
        }) as any);
        const fake = fakeAppServer();
        const spawn = vi.fn((...args: any[]) => { order.push('spawn'); return (fake.spawn as any)(...args); });
        try {
          const loading = loadCodexAccountModels({
            binaryPath: path.join(root, 'codex.exe'),
            neutralWorkingDirectory: neutral,
            workspaceRoots: [workspace],
            spawn: spawn as any,
            killProcessTree: vi.fn(async () => undefined),
            assertCurrent: () => {
              order.push('assert');
              if (!current) throw new Error('the selection changed');
            },
          });
          await waiting;
          expect(order, label).toEqual([]);
          if (stale) current = false;
          release();
          if (stale) {
            await expect(loading, label).rejects.toThrow('the selection changed');
            expect(spawn, label).not.toHaveBeenCalled();
            expect(fake.messages, label).toEqual([]);
            expect(order, label).toEqual(['assert']);
          } else {
            await expect(loading, label).resolves.toHaveLength(1);
            expect(order, label).toEqual(['assert', 'spawn']);
          }
        } finally {
          mkdirSpy.mockRestore();
          realpathSpy.mockRestore();
        }
      }
    }
  });

  it('refuses a neutral folder in a workspace child whose name starts with two dots (v0.9.96)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'unode-codex-models-'));
    temporaryDirectories.push(root);
    const fake = fakeAppServer();
    await expect(loadCodexAccountModels({
      binaryPath: path.join(root, 'codex.exe'),
      neutralWorkingDirectory: path.join(root, 'workspace', '..storage', 'codex-model-discovery'),
      workspaceRoots: [path.join(root, 'workspace')],
      spawn: fake.spawn as any,
      assertCurrent: () => undefined,
    })).rejects.toThrow(/inside a workspace/i);
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it('bounds and de-duplicates the account model response', () => {
    expect(parseCodexAccountModels({ data: [
      { id: 'gpt-a', displayName: 'A', inputModalities: ['text'] },
      { id: 'gpt-a', displayName: 'duplicate' },
      { model: 'gpt-b', inputModalities: ['image'] },
      { id: 'hidden', hidden: true },
    ] })).toEqual([
      { id: 'gpt-a', name: 'A', vision: false, isDefault: false },
      { id: 'gpt-b', name: 'gpt-b', vision: true, isDefault: false },
    ]);
  });

  it('stops a model-discovery process whose stdout exceeds the safety limit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'unode-codex-models-'));
    temporaryDirectories.push(root);
    const fake = fakeAppServer({ floodOnInitialize: true });
    const kill = vi.fn(async () => undefined);

    await expect(loadCodexAccountModels({
      binaryPath: path.join(root, 'codex.exe'),
      neutralWorkingDirectory: path.join(root, 'global-storage'),
      spawn: fake.spawn as any,
      assertCurrent: () => undefined,
      killProcessTree: kill,
      timeoutMs: 250,
    })).rejects.toThrow(/stdout safety limit/i);
    expect(kill).toHaveBeenCalledWith(4242);
  });
});

// v0.9.97 ATTACH-CODEX: a Codex image is sent only to a model App Server's own list says takes images.
describe('parseCodexImageInputModels (v0.9.97)', () => {
  it('names each model whose inputModalities include image, by id and by model, hidden ones too', () => {
    expect([...parseCodexImageInputModels({ data: [
      { id: 'gpt-a', model: 'gpt-a-slug', inputModalities: ['text', 'image'] },
      { id: 'gpt-hidden', hidden: true, inputModalities: ['image'] },
      { id: 'gpt-text', inputModalities: ['text'] },
      { id: 'gpt-unstated' },
      { id: 'gpt-odd', inputModalities: 'image' },
      { id: 'gpt-mixed', inputModalities: ['image', 3] },
    ] })].sort()).toEqual(['gpt-a', 'gpt-a-slug', 'gpt-hidden']);
    expect(parseCodexImageInputModels({}).size).toBe(0);
    expect(parseCodexImageInputModels(null).size).toBe(0);
  });
});
