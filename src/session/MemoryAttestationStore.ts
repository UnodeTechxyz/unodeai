/*---------------------------------------------------------------------------------------------
 *  UnodeAi - MemoryAttestationStore
 *  Host-owned, workspace-scoped attestations for exact shared-memory rows.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as path from 'path';
import { isMemoryRowDigest, SHARED_MEMORY_SOURCE } from './SharedMemory';

export const MEMORY_ATTESTATION_STATE_KEY = 'unode.sharedMemoryAttestations.v1';
export const MEMORY_ATTESTATION_STORE_VERSION = 1;
export const MAX_MEMORY_ATTESTATIONS = 200;

export interface MemoryAttestationMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface MemoryAttestationEntry {
  readonly digest: string;
  readonly attestedAt: string;
  readonly actor: 'local-user';
}

interface MemoryAttestationRegistry {
  readonly version: 1;
  readonly workspaceDigest: string;
  readonly source: typeof SHARED_MEMORY_SOURCE;
  readonly entries: readonly MemoryAttestationEntry[];
}

export class MemoryAttestationStore {
  private readonly workspaceDigest: string;

  constructor(
    private readonly state: MemoryAttestationMemento,
    workspaceRoot: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.workspaceDigest = workspaceScopeDigest(workspaceRoot);
  }

  /** A corrupt, unknown-version, or differently scoped registry yields no trust. */
  attestedDigests(): ReadonlySet<string> {
    const registry = this.readValidRegistry();
    return new Set(registry?.entries.map((entry) => entry.digest) ?? []);
  }

  /** Record a local user's attestation of one exact row digest. */
  async attest(digest: string): Promise<boolean> {
    if (!isMemoryRowDigest(digest)) return false;
    const entries = [...(this.readValidRegistry()?.entries ?? [])]
      .filter((entry) => entry.digest !== digest);
    entries.push({ digest, attestedAt: this.now().toISOString(), actor: 'local-user' });
    await this.write(entries.slice(-MAX_MEMORY_ATTESTATIONS));
    return true;
  }

  async revoke(digest: string): Promise<boolean> {
    if (!isMemoryRowDigest(digest)) return false;
    const registry = this.readValidRegistry();
    if (!registry) return false;
    const entries = registry.entries.filter((entry) => entry.digest !== digest);
    if (entries.length === registry.entries.length) return false;
    await this.write(entries);
    return true;
  }

  /** Remove attestations whose exact rows no longer exist. Called only from an explicit review. */
  async prune(currentDigests: ReadonlySet<string>): Promise<void> {
    const registry = this.readValidRegistry();
    if (!registry) return;
    const entries = registry.entries.filter((entry) => currentDigests.has(entry.digest));
    if (entries.length !== registry.entries.length) await this.write(entries);
  }

  private readValidRegistry(): MemoryAttestationRegistry | undefined {
    const candidate = this.state.get<unknown>(MEMORY_ATTESTATION_STATE_KEY);
    if (!isRecord(candidate)
      || !hasOnlyKeys(candidate, ['version', 'workspaceDigest', 'source', 'entries'])
      || candidate.version !== MEMORY_ATTESTATION_STORE_VERSION
      || candidate.workspaceDigest !== this.workspaceDigest
      || candidate.source !== SHARED_MEMORY_SOURCE
      || !Array.isArray(candidate.entries)
      || candidate.entries.length > MAX_MEMORY_ATTESTATIONS) {
      return undefined;
    }
    const entries: MemoryAttestationEntry[] = [];
    const seen = new Set<string>();
    for (const entry of candidate.entries) {
      if (!isRecord(entry)
        || !hasOnlyKeys(entry, ['digest', 'attestedAt', 'actor'])
        || !isMemoryRowDigest(entry.digest)
        || typeof entry.attestedAt !== 'string'
        || !isFiniteIsoDate(entry.attestedAt)
        || entry.actor !== 'local-user'
        || seen.has(entry.digest)) {
        return undefined;
      }
      seen.add(entry.digest);
      entries.push({ digest: entry.digest, attestedAt: entry.attestedAt, actor: 'local-user' });
    }
    return {
      version: MEMORY_ATTESTATION_STORE_VERSION,
      workspaceDigest: this.workspaceDigest,
      source: SHARED_MEMORY_SOURCE,
      entries,
    };
  }

  private async write(entries: readonly MemoryAttestationEntry[]): Promise<void> {
    const registry: MemoryAttestationRegistry = {
      version: MEMORY_ATTESTATION_STORE_VERSION,
      workspaceDigest: this.workspaceDigest,
      source: SHARED_MEMORY_SOURCE,
      entries,
    };
    await this.state.update(MEMORY_ATTESTATION_STATE_KEY, registry);
  }
}

export function workspaceScopeDigest(workspaceRoot: string): string {
  let normalized = path.normalize(path.resolve(workspaceRoot));
  if (process.platform === 'win32') normalized = normalized.toLocaleLowerCase('en-US');
  normalized = normalized.replace(/\\/gu, '/');
  return createHash('sha256')
    .update(`primary-workspace-folder\0${normalized}\0${SHARED_MEMORY_SOURCE}`, 'utf8')
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isFiniteIsoDate(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
