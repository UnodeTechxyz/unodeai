/*
 * Fixtures for the managed Codex updater's tests: a small Codex-shaped package built byte by byte as a `.tar.gz`,
 * policy entries for it that pass the real policy validator, fetch responses, and a fake Windows PowerShell child
 * that answers the fixed signature script with the package's real leaf certificates (public data). No vendor program
 * is started and nothing is downloaded.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
  CLI_COMPATIBILITY_POLICY,
  CLI_REQUIRED_CANARIES,
  loadCliCompatibilityPolicy,
  type CliCompatibilityPolicy,
  type PolicyEntry,
  type ValidatedCliCompatibilityPolicy,
} from '../../../backend/cliCompatibilityPolicy';
import type { ProcessTerminationOutcome } from '../../../backend/processTree';
import type { DownloadFetch, DownloadRequestInit, DownloadResponse, DownloadTimers } from '../../cliDelivery/boundedDownload';
import type { AuthenticodeCheckDeps, AuthenticodeRawChain, AuthenticodeRawResult } from '../../windowsAuthenticode';

export const PRIMARY_HOST = 'releases.openai.com';
export const GITHUB_HOST = 'github.com';
export const ASSET_HOST = 'release-assets.githubusercontent.com';
export const ALL_HOSTS = [PRIMARY_HOST, GITHUB_HOST, ASSET_HOST];

export function primaryUrl(version: string): string {
  return `https://${PRIMARY_HOST}/codex/releases/${version}/codex-package-x86_64-pc-windows-msvc.tar.gz`;
}
export function githubUrl(version: string): string {
  return `https://${GITHUB_HOST}/openai/codex/releases/download/rust-v${version}/codex-package-x86_64-pc-windows-msvc.tar.gz`;
}

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

// ---- The package ------------------------------------------------------------------------------

export type Signer = 'openai' | 'microsoft-crt' | 'unsigned' | 'none';
export interface PackageFile { path: string; data: Buffer; pe: boolean; signer: Signer }

const MZ = Buffer.from('MZ', 'latin1');

/** Five files in the package's real folders: one OpenAI program, the Microsoft CRT, ripgrep without a signature, two data files. */
export function codexPackageFiles(version: string): PackageFile[] {
  return [
    { path: 'bin/codex.exe', data: Buffer.concat([MZ, Buffer.from(` codex ${version} `), Buffer.alloc(3000, 0x41)]), pe: true, signer: 'openai' },
    { path: 'codex-package.json', data: Buffer.from('{"layoutVersion":1,"entrypoint":"bin/codex.exe"}\n'), pe: false, signer: 'none' },
    { path: 'codex-path/rg.exe', data: Buffer.concat([MZ, Buffer.from(' ripgrep 15.2.0 '), Buffer.alloc(900, 0x52)]), pe: true, signer: 'unsigned' },
    { path: 'codex-resources/NOTICE.md', data: Buffer.alloc(700, 0x6e), pe: false, signer: 'none' },
    { path: 'codex-resources/voice/bin/vcruntime140.dll', data: Buffer.concat([MZ, Buffer.from(' crt '), Buffer.alloc(600, 0x43)]), pe: true, signer: 'microsoft-crt' },
  ];
}
export const PACKAGE_DIRS = ['bin', 'codex-path', 'codex-resources', 'codex-resources/voice', 'codex-resources/voice/bin'];

function tarHeader(name: string, type: string, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'latin1');
  block.write('0000644\0', 100, 'latin1');
  block.write('0000000\0', 108, 'latin1');
  block.write('0000000\0', 116, 'latin1');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  block.write('15264123577\0', 136, 'latin1');
  block[156] = type.charCodeAt(0);
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

function padded(data: Buffer): Buffer {
  const rest = data.length % 512;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

/** The archive: every folder, then every file, then the two end blocks, gzipped. */
export function buildArchive(files: readonly PackageFile[], dirs: readonly string[] = PACKAGE_DIRS): Buffer {
  const parts: Buffer[] = [];
  for (const dir of dirs) parts.push(tarHeader(`${dir}/`, '5', 0));
  for (const file of files) parts.push(tarHeader(file.path, '0', file.data.length), padded(file.data));
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

export interface TestPackage {
  version: string;
  files: PackageFile[];
  archive: Buffer;
  entry: PolicyEntry;
}

export interface PackageOptions {
  /** The files the archive holds; by default the files the layout lists. */
  archiveFiles?: PackageFile[];
  /** The files the layout lists. */
  files?: PackageFile[];
  urls?: string[];
  redirectHosts?: string[];
  status?: PolicyEntry['status'];
  os?: string;
  arch?: string;
  entrypoint?: string;
}

/** One Codex version: its archive and its policy entry. */
export function testPackage(version: string, options: PackageOptions = {}): TestPackage {
  const files = options.files ?? codexPackageFiles(version);
  const archive = buildArchive(options.archiveFiles ?? files);
  const entry: PolicyEntry = {
    id: `codex-cli-${version}-win32-x64`,
    provider: 'codex-cli',
    version,
    versionOutput: `codex-cli ${version}`,
    os: (options.os ?? 'win32') as 'win32',
    arch: (options.arch ?? 'x64') as 'x64',
    status: options.status ?? 'qualified',
    ...(options.status && options.status !== 'qualified' ? { statusReason: 'marked bad for the test' } : {}),
    managed: {
      artifact: {
        kind: 'tar.gz',
        name: 'codex-package-x86_64-pc-windows-msvc.tar.gz',
        size: archive.length,
        sha256: sha256(archive),
        urls: options.urls ?? [primaryUrl(version), githubUrl(version)],
        redirectHosts: options.redirectHosts ?? [ASSET_HOST],
      },
      layout: {
        entrypoint: options.entrypoint ?? 'bin/codex.exe',
        unpackedBytes: files.reduce((sum, file) => sum + file.data.length, 0),
        dirs: [...PACKAGE_DIRS],
        ignoredEntries: [],
        files: files.map((file) => ({ path: file.path, size: file.data.length, sha256: sha256(file.data), pe: file.pe, signer: file.signer })),
      },
    },
    gates: { 'approval-gate': true },
    canaries: CLI_REQUIRED_CANARIES['codex-cli'].map((id) => ({ id, result: 'pass' as const, evidenceRef: 'test', ranAt: '2026-10-01T00:00:00Z', model: 'none' })),
    selfUpdateReview: { sourceRef: 'test', finding: 'no update path in app-server' },
    qualifiedAt: '2026-10-01T00:00:00Z',
    qualificationRecord: 'test',
    leafThumbprints: [],
  };
  return { version, files, archive, entry };
}

/** A policy the real validator accepted. */
export function testPolicy(entries: PolicyEntry[]): ValidatedCliCompatibilityPolicy {
  const policy: CliCompatibilityPolicy = { ...structuredClone(CLI_COMPATIBILITY_POLICY), policyVersion: 'test-1', entries };
  const loaded = loadCliCompatibilityPolicy(policy);
  if (!loaded.ok) throw new Error(`the test policy is invalid: ${loaded.problems.join('; ')}`);
  return loaded.policy;
}

/** A policy that skipped the validator, for the checks the updater repeats on its own (the version floor). */
export function unvalidatedPolicy(entries: PolicyEntry[]): ValidatedCliCompatibilityPolicy {
  return { ...structuredClone(CLI_COMPATIBILITY_POLICY), policyVersion: 'test-1', entries } as unknown as ValidatedCliCompatibilityPolicy;
}

// ---- Fetch ------------------------------------------------------------------------------------

export function streamOf(bytes: Uint8Array, chunk = 4096): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      const piece = bytes.subarray(at, at + chunk);
      at += piece.length;
      controller.enqueue(piece);
    },
  }, { highWaterMark: 0 });
}

/** A body that never sends a byte; it ends only when its request is aborted. */
export function stalledResponse(size: number, signal: AbortSignal): DownloadResponse {
  return {
    status: 200,
    headers: new Headers({ 'content-length': String(size) }),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); resolve(); }, { once: true });
        });
      },
    }, { highWaterMark: 0 }),
  };
}

export function okResponse(bytes: Buffer): DownloadResponse {
  return { status: 200, headers: new Headers({ 'content-length': String(bytes.length) }), body: streamOf(bytes) };
}

export type Route = (init: DownloadRequestInit) => DownloadResponse | Promise<DownloadResponse>;

/** Serves each URL from its route; 404 otherwise. Every request is recorded. */
export function fakeFetch(routes: Record<string, Route>, recorder?: string[]): { fetch: DownloadFetch; calls: Array<{ url: string; init: DownloadRequestInit }> } {
  const calls: Array<{ url: string; init: DownloadRequestInit }> = [];
  const fetch: DownloadFetch = async (url, init) => {
    calls.push({ url, init });
    recorder?.push(`fetch:${new URL(url).hostname}`);
    const route = routes[url];
    if (!route) return { status: 404, headers: new Headers(), body: null };
    return route(init);
  };
  return { fetch, calls };
}

/** Serves every package from its primary URL. */
export function packageFetch(packages: readonly TestPackage[], recorder?: string[]) {
  const routes: Record<string, Route> = {};
  for (const item of packages) routes[primaryUrl(item.version)] = () => okResponse(item.archive);
  return fakeFetch(routes, recorder);
}

// ---- Windows PowerShell -----------------------------------------------------------------------

const LEAVES = (JSON.parse(readFileSync(path.join(__dirname, '..', '..', '__tests__', 'fixtures', 'authenticode-leaves.json'), 'utf8')) as {
  leaves: Array<{ der: string }>;
}).leaves;
const OPENAI_LEAF = Buffer.from(LEAVES[0].der, 'base64');
const CRT_CATALOG_LEAF = Buffer.from(LEAVES[1].der, 'base64');
const OPENAI_ROOT = 'F40042E2E5F7E8EF8189FED15519AECE42C3BFA2';
const CRT_CATALOG_ROOT = '3B1EFD3A66EA28B16697394703A72CA340A05BD5';
const INTERMEDIATE_A = '4C07413E5DA89A259A127E1D76F792AF239CD9D9';
const INTERMEDIATE_B = '8E750F459DAF9A79D6370DB747AD2226866AD818';

const thumbprintOf = (der: Buffer): string => createHash('sha1').update(der).digest('hex').toUpperCase();

function chainOf(der: Buffer, root: string, statuses: string[][], intermediates: string[], built = true): AuthenticodeRawChain {
  const thumbs = [thumbprintOf(der), ...intermediates, root];
  const elements = thumbs.map((thumb, k) => ({ thumb, status: statuses[k] ?? [] }));
  return { built, status: [...new Set(elements.flatMap((element) => element.status))], elements };
}

/**
 * How the fake PowerShell answers:
 * - `honest`: every file as its signer signs it; the OpenAI leaf has expired since its timestamp (as real leaves do);
 * - `crt-expired-intermediate`: the CRT catalog chain also carries an expired intermediate, which passes only for a
 *   file whose bytes the caller has just verified against their pin;
 * - `offline`: the OpenAI chain could not be checked for revocation;
 * - `openai-not-signed`: the OpenAI program reports no signature (a definite failure);
 * - `revoked`: the OpenAI chain reports a revoked certificate;
 * - `garbage`: PowerShell prints something that is not an answer (unavailable);
 * - `hang`: PowerShell never answers.
 */
export type SignatureMode = 'honest' | 'crt-expired-intermediate' | 'offline' | 'openai-not-signed' | 'revoked' | 'garbage' | 'hang';

export class FakePowerShellChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stopped = false;

  end(code: number | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    if (code === null) this.signalCode = 'SIGKILL';
    else this.exitCode = code;
    this.emit('exit', code, this.signalCode);
    this.emit('close', code, this.signalCode);
  }

  stop(): void {
    this.stopped = true;
    this.end(null);
  }
}

function signerOfPath(file: string): Signer {
  const name = file.split(/[\\/]/).pop() ?? '';
  if (name === 'rg.exe') return 'unsigned';
  if (name === 'vcruntime140.dll') return 'microsoft-crt';
  return 'openai';
}

function answerFor(files: string[], mode: SignatureMode): string {
  const results: AuthenticodeRawResult[] = [];
  const chains: Record<string, AuthenticodeRawChain> = {};
  files.forEach((file, i) => {
    const signer = signerOfPath(file);
    if (signer === 'unsigned') {
      results.push({ i, status: 'NotSigned', type: 'None', leaf: null, leafDer: null, timestamped: false });
    } else if (signer === 'microsoft-crt') {
      results.push({ i, status: 'Valid', type: 'Catalog', leaf: thumbprintOf(CRT_CATALOG_LEAF), leafDer: CRT_CATALOG_LEAF.toString('base64'), timestamped: true });
      const statuses = mode === 'crt-expired-intermediate' ? [['NotTimeValid'], ['NotTimeValid'], []] : [['NotTimeValid']];
      chains[thumbprintOf(CRT_CATALOG_LEAF)] = chainOf(CRT_CATALOG_LEAF, CRT_CATALOG_ROOT, statuses, [INTERMEDIATE_A]);
    } else if (mode === 'openai-not-signed') {
      results.push({ i, status: 'NotSigned', type: 'None', leaf: null, leafDer: null, timestamped: false });
    } else {
      results.push({ i, status: 'Valid', type: 'Authenticode', leaf: thumbprintOf(OPENAI_LEAF), leafDer: OPENAI_LEAF.toString('base64'), timestamped: true });
      const statuses = mode === 'revoked' ? [['NotTimeValid'], ['Revoked']] : mode === 'offline' ? [['NotTimeValid', 'OfflineRevocation']] : [['NotTimeValid']];
      chains[thumbprintOf(OPENAI_LEAF)] = chainOf(OPENAI_LEAF, OPENAI_ROOT, statuses, [INTERMEDIATE_A, INTERMEDIATE_B]);
    }
  });
  return `UNODE-AC1:${Buffer.from(JSON.stringify({ v: 1, results, chains }), 'utf8').toString('base64')}\r\n`;
}

export interface SpawnRecord { command: string; args: readonly string[]; options: SpawnOptions; child: FakePowerShellChild; files: string[] }

/** The signature check's runner dependencies with a fake `spawn`: every spawn is recorded and answered as `mode` says. */
export function fakePowerShell(mode: SignatureMode = 'honest', recorder?: string[]) {
  const spawned: SpawnRecord[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const child = new FakePowerShellChild();
    const input = (options.env as Record<string, string>).UNODE_AC_INPUT;
    const files = (JSON.parse(Buffer.from(input, 'base64').toString('utf8')) as { files: string[] }).files;
    spawned.push({ command, args, options, child, files });
    recorder?.push('spawn:powershell');
    if (mode !== 'hang') {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(mode === 'garbage' ? 'something else\r\n' : answerFor(files, mode)));
        child.end(0);
      });
    }
    return child as unknown as ChildProcess;
  };
  const deps: AuthenticodeCheckDeps = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    resolveExecutable: (command) => command,
    spawn,
  };
  const stops: FakePowerShellChild[] = [];
  /** The task's observed stop of a run: the fake child ends at once and the stop is confirmed. */
  const stopTree = async (child: ChildProcess): Promise<ProcessTerminationOutcome> => {
    stops.push(child as unknown as FakePowerShellChild);
    recorder?.push('stop:powershell');
    (child as unknown as FakePowerShellChild).stop();
    return { status: 'confirmed-stopped' };
  };
  return { deps, spawned, stopTree, stops };
}

// ---- Timers -----------------------------------------------------------------------------------

/** Timers the test moves by hand. Callbacks run in time order; `now` follows them. */
export function manualTimers(start = Date.parse('2026-10-21T08:00:00Z')): DownloadTimers & { advance(ms: number): void; pending(): number; nextAt(): number | undefined } {
  let now = start;
  let next = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = ++next;
      pending.set(id, { at: now + Math.max(0, ms), callback });
      return id;
    },
    clearTimeout: (handle) => { pending.delete(handle as number); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let due: [number, { at: number; callback: () => void }] | undefined;
        for (const item of pending) if (item[1].at <= end && (!due || item[1].at < due[1].at)) due = item;
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
    pending: () => pending.size,
    nextAt: () => {
      let earliest: number | undefined;
      for (const item of pending.values()) if (earliest === undefined || item.at < earliest) earliest = item.at;
      return earliest;
    },
  };
}

/** Lets real I/O and promise chains run until the condition holds, for at most `ms` of real time. */
export async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 2));
  if (!condition()) throw new Error('the condition did not hold in time');
}
