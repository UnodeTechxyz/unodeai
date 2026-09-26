import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCodexAccountModels, parseCodexAccountModels } from '../CodexModelLoader';

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
      killProcessTree: kill,
      clientVersion: '0.9.84',
    });

    expect(models).toEqual([{ id: 'gpt-6-sol', name: 'GPT-6 Sol', vision: true, isDefault: true }]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].options).toMatchObject({ cwd: neutral, shell: false, windowsHide: true });
    expect(fake.calls[0].options.env.OPENAI_API_KEY).toBeUndefined();
    expect(fake.calls[0].options.env.CODEX_API_KEY).toBeUndefined();
    expect(fake.calls[0].args).toContain('sandbox_mode="read-only"');
    expect(fake.messages.map((message) => message.method)).toEqual(['initialize', 'model/list']);
    expect(fake.messages.some((message) => /thread|turn|config\/read/.test(String(message.method)))).toBe(false);
    expect(kill).toHaveBeenCalledWith(4242);
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
      killProcessTree: kill,
      timeoutMs: 250,
    })).rejects.toThrow(/stdout safety limit/i);
    expect(kill).toHaveBeenCalledWith(4242);
  });
});
