// Shared helpers of the instance-store tests: a temporary store, a table of running processes standing in for the
// creation query, a recording file system, and version facts as a download would publish them.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliStoreVersionKey } from '../../../backend/cliCompatibilityPolicy';
import type { InstanceRef, InstanceStoreApi, ProcessIdentity, PromotedVersion, Promotion } from '../contracts';
import { createInstanceStore, nodeInstanceFs, type InstanceFs, type InstanceStoreDeps } from '../instanceStore';
import type { ProcessCreationQuery } from '../processIdentity';
import { cliStoreRoots, type CliStoreRoots } from '../storeLayout';

export const CREATED = {
  host: '2026-10-19T10:16:29.6764530Z',
  child: '2026-10-19T10:16:31.0000010Z',
  other: '2026-10-19T11:00:00.0000000Z',
};

export const temps: string[] = [];

export function cleanTemps(): void {
  for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true });
}

/** A new, empty store folder (the location check and its creation are the caller's in production). */
export function tempRoots(): CliStoreRoots {
  const root = mkdtempSync(path.join(tmpdir(), 'unode-instances-'));
  temps.push(root);
  return cliStoreRoots(root);
}

/** The processes that run, by pid and creation time; `unavailable` makes the query fail as PowerShell would. */
export class FakeProcesses {
  readonly running = new Map<number, string>();
  unavailable: 'no' | 'answer' | 'throws' = 'no';
  readonly calls: number[][] = [];

  readonly query: ProcessCreationQuery = async (pids) => {
    this.calls.push([...pids]);
    if (this.unavailable === 'throws') throw new Error('PowerShell failed');
    if (this.unavailable === 'answer') return 'unavailable';
    return new Map(pids.filter((pid) => this.running.has(pid)).map((pid) => [pid, this.running.get(pid) as string]));
  };

  start(pid: number, creation: string): ProcessIdentity {
    this.running.set(pid, creation);
    return { pid, creation };
  }

  stop(pid: number): void {
    this.running.delete(pid);
  }
}

export interface Kit {
  roots: CliStoreRoots;
  store: InstanceStoreApi;
  processes: FakeProcesses;
  clock: { offsetMs: number };
  sleeps: number[];
}

/** A store over the real file system, with fake processes, a clock that can be moved forward and instant sleeps. */
export function kit(overrides: Partial<InstanceStoreDeps> = {}, roots: CliStoreRoots = tempRoots()): Kit {
  const processes = new FakeProcesses();
  const clock = { offsetMs: 0 };
  const sleeps: number[] = [];
  const store = createInstanceStore(roots, {
    processCreations: processes.query,
    now: () => Date.now() + clock.offsetMs,
    sleep: async (ms) => { sleeps.push(ms); },
    ...overrides,
  });
  return { roots, store, processes, clock, sleeps };
}

export async function created(store: InstanceStoreApi): Promise<InstanceRef> {
  const result = await store.create();
  if (!result.ok) throw new Error(`setup: ${result.detail}`);
  return result.ref;
}

/** The SHA-256 of a seed, as an artifact digest. */
export function digestOf(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

/** The facts a download publishes for `version`, with the artifact digest of `seed`. */
export function factsFor(version: string, seed = version, overrides: Partial<PromotedVersion> = {}): PromotedVersion {
  const artifactSha256 = digestOf(seed);
  return {
    key: cliStoreVersionKey({ version, os: 'win32', arch: 'x64', managed: { artifact: { sha256: artifactSha256 } } }),
    provider: 'codex-cli',
    version,
    os: 'win32',
    arch: 'x64',
    policyVersion: '0.9.97-0',
    policyEntryId: `codex-cli-${version}-win32-x64`,
    artifactSha256,
    taskToken: 'a'.repeat(32),
    promotedAt: '2026-10-20T08:00:00.000Z',
    verification: { files: 2, bytes: 10, signed: { openai: 1, microsoftCrt: 0 }, unsigned: ['codex-path/rg.exe'], revocation: 'confirmed-online' },
    ...overrides,
  };
}

let stagingCounter = 0;

/** A staged payload with these files, promoted with these facts. */
export async function promoteVersion(
  store: InstanceStoreApi,
  ref: InstanceRef,
  facts: PromotedVersion,
  files: Record<string, string> = { 'codex.exe': `program ${facts.version}`, 'codex-path/rg.exe': 'helper' },
): Promise<Promotion> {
  stagingCounter++;
  const staging = store.createStaging(ref, stagingCounter.toString(16).padStart(32, '0'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(staging.payload, ...name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return store.promote(ref, staging, facts);
}

export interface FsCall {
  op: string;
  paths: string[];
}

/** A file system that records every call and can be made to fail or act at a chosen call. */
export function recordingFs(hook?: (call: FsCall) => void, base: InstanceFs = nodeInstanceFs): { fs: InstanceFs; calls: FsCall[] } {
  const calls: FsCall[] = [];
  const note = (op: string, ...paths: string[]) => {
    const call = { op, paths };
    calls.push(call);
    hook?.(call);
  };
  const fs: InstanceFs = {
    readdir: (folder) => { note('readdir', folder); return base.readdir(folder); },
    readFile: (file, max) => { note('readFile', file); return base.readFile(file, max); },
    writeExclusive: (file, bytes) => { note('writeExclusive', file); base.writeExclusive(file, bytes); },
    link: (existing, createdName) => { note('link', existing, createdName); base.link(existing, createdName); },
    unlink: (file) => { note('unlink', file); base.unlink(file); },
    mkdir: (folder) => { note('mkdir', folder); base.mkdir(folder); },
    rmdir: (folder) => { note('rmdir', folder); base.rmdir(folder); },
    rename: (from, to) => { note('rename', from, to); base.rename(from, to); },
    lstat: (file) => { note('lstat', file); return base.lstat(file); },
    openRead: (file) => { note('openRead', file); return base.openRead(file); },
    read: (fd, buffer, position) => { note('read'); return base.read(fd, buffer, position); },
    close: (fd) => { note('close'); base.close(fd); },
  };
  return { fs, calls };
}

export function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
