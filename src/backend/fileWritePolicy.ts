/*---------------------------------------------------------------------------------------------
 *  UnodeAi - File write policy (v0.9.97)
 *
 *  The one decision a structured file change asks before it acts, whichever route makes it: the host's own write,
 *  edit, patch and delete tools, Claude's native Write/Edit/NotebookEdit at its PreToolUse hook, and Codex's
 *  file-change approval. It grants nothing: every caller has already applied its own permissions, and this can only
 *  refuse, ask, or let the change go on.
 *
 *  Evidence is gathered per target and late. Nothing is read, hashed, listed or asked of Git when a request starts.
 *  An authorised read records what it saw of that file. The first proposed change to a target looks at the editor
 *  buffer, at that one path in Git, at what this request read or wrote, and at the host's record of its own earlier
 *  effects, in that order; the stricter answer wins:
 *
 *  1. unsaved changes in an editor: refused; nothing saves them for the person;
 *  2. changed since this request read or wrote it, or written by another request that is still running: one
 *     explicit decision, bound to the file as it is now;
 *  3. uncommitted or untracked in Git: someone else's work, unless the host's own record says it wrote exactly
 *     these bytes and no running request did;
 *  4. tracked and unchanged in Git: the change goes on under the caller's permissions;
 *  5. outside Git: goes on when it equals what this request read, or the host's own record; otherwise one decision;
 *  6. a file that is not there: goes on, and a file that appears in the meantime ends the plan.
 *
 *  After rule 1 and before rules 2 to 5, a file larger than the hashing bound (32 MiB) is refused for a write or a
 *  delete: its content is unknown, so no look after a wait could find it unchanged and no restore point could hold it.
 *
 *  The host's own records are metadata only (target, size, SHA-256, identity, when, which request), at most 1,000
 *  per workspace and 30 days each. A lost, expired or unclear record means a decision, never a wider permission.
 *  Changes are serialised per target inside this extension host. Another window or program is seen only when it
 *  changes the content or identity of a file before the last look; nothing here is an OS compare-and-swap.
 *
 *  Before a host change replaces or removes an existing file, the host keeps the file's exact bytes as a restore point
 *  (PreChangeCheckpoints), complete on disk before the change acts; when it cannot, the change is not made.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto';
import { constants as fsConstants, realpathSync, type BigIntStats } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { GitPathProbe, GitPathReport } from './gitPathStatus';
import { isPathInsideOrEqual, isPathStrictlyInside } from './pathContainment';
import type { PreChangeCheckpointOutcome, PreChangeCheckpoints } from './PreChangeCheckpoints';
import { physicalPath, windowsNameProblem } from './workspacePath';

/** A host record of its own effect stops counting after this long. */
export const OWN_EFFECT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Records kept per workspace; the oldest go first. */
export const OWN_EFFECT_MAX_ENTRIES = 1_000;
/** A record written under other rules is not read as one of these. */
export const OWN_EFFECT_EVIDENCE_REVISION = 1;
/** A file larger than this is not hashed: its content is unknown, which proves nothing. */
export const TARGET_STATE_HASH_MAX_BYTES = 32 * 1024 * 1024;
/** Files of a folder about to be deleted that are hashed one by one at most; beyond it the folder needs a decision. */
export const FOLDER_EVIDENCE_MAX_FILES = 2_000;

const REQUEST_SCOPES_KEPT = 32;
const TARGETS_PER_SCOPE = 4_096;
const HOST_EFFECTS_KEPT = 4_096;

/** What is at a target. Two states are the same file only when content and identity both match. */
export interface TargetState {
  exists: boolean;
  kind?: 'file' | 'directory' | 'other';
  size?: number;
  /** Absent for a file above the hashing bound. */
  sha256?: string;
  dev?: string;
  ino?: string;
  nlink?: number;
  /** Permission bits, kept so a replaced file keeps them. Not part of sameness. */
  mode?: number;
}

export interface ObservedTarget {
  state: TargetState;
  /** The file's bytes, when it was hashed. */
  bytes?: Buffer;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR';
}

/**
 * Read what is at `physical` now, through one handle: identity and bytes come from the same open file. A name that
 * is a link, a device or something swapped between the two looks is `other`, which is never the same as anything.
 */
export async function readTargetState(physical: string, maxBytes: number = TARGET_STATE_HASH_MAX_BYTES): Promise<ObservedTarget> {
  let named: BigIntStats;
  try {
    named = await fs.lstat(physical, { bigint: true });
  } catch (error) {
    if (isNotFound(error)) return { state: { exists: false } };
    throw error;
  }
  if (named.isDirectory()) {
    return { state: { exists: true, kind: 'directory', dev: String(named.dev), ino: String(named.ino) } };
  }
  if (!named.isFile()) return { state: { exists: true, kind: 'other' } };
  const handle = await fs.open(physical, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== named.dev || opened.ino !== named.ino || !opened.isFile()) {
      return { state: { exists: true, kind: 'other' } };
    }
    const identity = {
      exists: true,
      kind: 'file' as const,
      size: Number(opened.size),
      dev: String(opened.dev),
      ino: String(opened.ino),
      nlink: Number(opened.nlink),
      mode: Number(opened.mode) & 0o7777,
    };
    if (identity.size > maxBytes) return { state: identity };
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) return { state: { ...identity, size: bytes.length } };
    return { state: { ...identity, size: bytes.length, sha256: sha256Hex(bytes) }, bytes };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Same content and same identity. A file whose content is unknown is the same as nothing. */
export function sameTargetState(left: TargetState, right: TargetState): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  if (left.kind !== right.kind) return false;
  if (left.ino !== undefined && right.ino !== undefined && (left.ino !== right.ino || left.dev !== right.dev)) return false;
  if (left.kind === 'directory') return left.ino !== undefined && right.ino !== undefined;
  if (left.kind !== 'file') return false;
  return left.size === right.size && left.sha256 !== undefined && left.sha256 === right.sha256;
}

/**
 * v0.9.97: whether two looks at a target found the same content, whatever its identity: both absent, or a file of the
 * same size and SHA-256. A replaced file that holds the bytes it held is no file effect; one of unknown content is.
 */
export function sameTargetContent(left: TargetState, right: TargetState): boolean {
  if (!left.exists || !right.exists) return left.exists === right.exists;
  return left.kind === 'file' && right.kind === 'file'
    && left.sha256 !== undefined && left.sha256 === right.sha256 && left.size === right.size;
}

/** One key for every spelling of a target: its physical path, without case on Windows. */
export function targetKey(physical: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? physical.toLowerCase() : physical;
}

// ─── The host's record of its own effects ──────────────────────────────────

export interface OwnEffectRecord {
  revision: number;
  workspace: string;
  target: string;
  size: number;
  sha256: string;
  dev?: string;
  ino?: string;
  requestId: string;
  /** `host-verified`: the host wrote and read back these bytes. `native-observed`: a CLI tool's result, read back. */
  evidence: 'host-verified' | 'native-observed';
  at: number;
}

/** Where the records live between sessions. The host passes workspace storage; nothing here holds file content. */
export interface OwnEffectPersistence {
  load(): unknown;
  save(records: readonly OwnEffectRecord[]): unknown;
}

function isOwnEffectRecord(value: unknown): value is OwnEffectRecord {
  const record = value as OwnEffectRecord;
  return !!record && typeof record === 'object'
    && record.revision === OWN_EFFECT_EVIDENCE_REVISION
    && typeof record.workspace === 'string'
    && typeof record.target === 'string'
    && Number.isFinite(record.size)
    && typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.sha256)
    && typeof record.requestId === 'string'
    && (record.evidence === 'host-verified' || record.evidence === 'native-observed')
    && Number.isFinite(record.at)
    && (record.dev === undefined || typeof record.dev === 'string')
    && (record.ino === undefined || typeof record.ino === 'string');
}

class OwnEffectStore {
  private records = new Map<string, OwnEffectRecord>();
  private loaded = false;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly persistence: OwnEffectPersistence | undefined, private readonly now: () => number) {}

  get(key: string): OwnEffectRecord | undefined {
    this.load();
    const record = this.records.get(key);
    if (record && this.now() - record.at > OWN_EFFECT_MAX_AGE_MS) {
      this.records.delete(key);
      this.persist();
      return undefined;
    }
    return record;
  }

  put(record: OwnEffectRecord): void {
    this.load();
    this.records.delete(record.target);
    this.records.set(record.target, record);
    this.prune();
    this.persist();
  }

  remove(key: string, folder: boolean): void {
    this.load();
    let removed = false;
    for (const target of [...this.records.keys()]) {
      if (target === key || (folder && isPathInsideOrEqual(key, target))) {
        this.records.delete(target);
        removed = true;
      }
    }
    if (removed) this.persist();
  }

  /** Loaded at the first look at a target, never before: an empty chat reads nothing. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let stored: unknown;
    try { stored = this.persistence?.load(); } catch { stored = undefined; }
    const records = Array.isArray(stored) ? stored.filter(isOwnEffectRecord) : [];
    records.sort((a, b) => a.at - b.at);
    for (const record of records) {
      this.records.delete(record.target);
      this.records.set(record.target, record);
    }
    this.prune();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (now - record.at > OWN_EFFECT_MAX_AGE_MS) this.records.delete(key);
    }
    while (this.records.size > OWN_EFFECT_MAX_ENTRIES) {
      const oldest = this.records.keys().next().value as string;
      this.records.delete(oldest);
    }
  }

  private persist(): void {
    if (!this.persistence) return;
    const snapshot = [...this.records.values()];
    this.saving = this.saving
      .then(() => this.persistence?.save(snapshot))
      .catch(() => undefined);
  }
}

// ─── The policy ─────────────────────────────────────────────────────────────

export type ProceedBasis = 'new-file' | 'own-latest' | 'read-snapshot' | 'git-clean' | 'own-effect' | 'unhosted';
export type RefusalCode = 'dirty-buffer' | 'hard-link' | 'not-a-file' | 'too-large';
export type DecisionCode =
  | 'changed-since-read'
  | 'changed-since-own-write'
  | 'concurrent-request'
  | 'git-uncommitted'
  | 'no-evidence'
  | 'folder-foreign';

export type WriteEvidence =
  | { verdict: 'proceed'; basis: ProceedBasis }
  | { verdict: 'refuse'; code: RefusalCode; reason: string }
  | { verdict: 'decide'; code: DecisionCode; reason: string };

/** The decision a person makes for one change to one target as it is now. It is never remembered. */
export interface OverwriteDecisionRequest {
  path: string;
  reason: string;
  operation: 'write' | 'delete';
  before: string | null;
  after: string;
  /** What the card shows in place of a text diff, when the change is not text (a saved attachment). */
  preview?: string;
  /** v0.9.97: the cancellation of the call that asks. When it fires the card is withdrawn and the answer is deny. */
  signal?: AbortSignal;
}
export type OverwriteDecider = (request: OverwriteDecisionRequest) => Promise<'once' | 'deny'>;

export interface FileWritePolicyHost {
  /** Records of another workspace are never consulted. */
  workspaceId: () => string;
  /** Files with unsaved editor changes, as their editors name them. */
  dirtyEditorPaths?: () => readonly string[];
  gitPath?: GitPathProbe;
  /** Whether a request still has a live turn. A record of a running request is concurrent work, not this one's. */
  isRequestRunning?: (requestId: string) => boolean;
  ownEffects?: OwnEffectPersistence;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Replaced in tests to count reads. */
  readState?: (physical: string) => Promise<ObservedTarget>;
  /**
   * This workspace's raw-byte restore points, kept before a host change replaces or removes an existing file. Without
   * them (unit tests, the offline lab) a change keeps only the text record made after it.
   */
  checkpoints?: PreChangeCheckpoints;
  /**
   * v0.9.97: every effect a change had on a file, as the host observed it, for the effect ledger of the request the
   * change was made for. Told only what was read back or could not be confirmed; never an approval or an attempt.
   */
  onEffect?: (effect: HostObservedFileEffect) => void;
}

/** v0.9.97: one file effect the host observed, as the request effect ledger takes it. */
export interface HostObservedFileEffect {
  agentId: string;
  /** The request the change was made for; absent when the agent acted outside one. */
  requestId?: string;
  /** Relative to the agent's own folder, `/`-separated; absent when the file is not inside it. */
  path?: string;
  /** The host's key of the file. */
  key: string;
  operation: 'write' | 'delete-file' | 'delete-directory';
  /**
   * `host-verified`: a host commit read back as written, or a removal it saw. `native-observed`: a CLI tool's change
   * read back as the bytes its input fixed. `effect-uncertain`: anything else that may have changed the file.
   */
  grade: 'host-verified' | 'native-observed' | 'effect-uncertain';
}

/**
 * v0.9.97: whose change an effect is: the request scope and request the agent had when the change was planned. A
 * change that settles after its turn ended still belongs to that request.
 */
export interface EffectAttribution {
  readonly scope: string;
  readonly requestId?: string;
  /** When the change was planned, by the policy's clock. */
  readonly at: number;
}

/**
 * v0.9.97: where a file is, relative to an agent's folder, as a request closeout lists it: both by real path,
 * `/`-separated. Undefined for a file that is not inside the folder.
 */
export function requestEffectPath(physicalBase: string, physical: string, pathApi: path.PlatformPath = path): string | undefined {
  if (!isPathStrictlyInside(physicalBase, physical, pathApi)) return undefined;
  return pathApi.relative(physicalBase, physical).split(pathApi.sep).join('/');
}

interface SeenState {
  state: TargetState;
  at: number;
}

interface ScopeEvidence {
  /** What an authorised read of this request saw. */
  reads: Map<string, SeenState>;
  /** What this request's own last confirmed change left. */
  own: Map<string, SeenState>;
}

export interface FolderFile {
  physical: string;
  /** Relative to the folder, with `/`; shown in a decision. */
  display: string;
}

/**
 * The host-wide part: evidence, records and per-target serialisation shared by every agent and route of one
 * workspace. An unhosted policy has no editor, no Git and nobody to ask; it is what direct users of the tool surface
 * get (unit tests, the offline lab). It still refuses links with several names and non-files, and still serialises.
 */
export class FileWritePolicy {
  private readonly scopes = new Map<string, ScopeEvidence>();
  private readonly hostEffects = new Map<string, { scope: string; state: TargetState; at: number }>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly ownEffects: OwnEffectStore;
  private readonly now: () => number;
  readonly platform: NodeJS.Platform;

  constructor(private readonly host: FileWritePolicyHost | undefined) {
    this.now = host?.now ?? (() => Date.now());
    this.platform = host?.platform ?? process.platform;
    this.ownEffects = new OwnEffectStore(host?.ownEffects, this.now);
  }

  static unhosted(): FileWritePolicy {
    return new FileWritePolicy(undefined);
  }

  get hosted(): boolean {
    return this.host !== undefined;
  }

  /** The workspace's raw-byte restore points, when the host keeps them. */
  get checkpoints(): PreChangeCheckpoints | undefined {
    return this.host?.checkpoints;
  }

  forAgent(options: AgentFileWritesOptions): AgentFileWrites {
    return new AgentFileWrites(this, options);
  }

  /** v0.9.97: tell the host of an effect the host observed. A failure to tell is not the change's. */
  reportEffect(effect: HostObservedFileEffect): void {
    try { this.host?.onEffect?.(effect); } catch { /* the ledger is observability */ }
  }

  /**
   * v0.9.97: whether another request changed the target, as this host saw it, at or after `since`. A read-back that
   * then finds the expected bytes cannot tell which change left them.
   */
  changedByOtherSince(physical: string, scope: string, since: number): boolean {
    const last = this.hostEffects.get(this.key(physical));
    return !!last && last.scope !== scope && last.at >= since;
  }

  get clock(): number {
    return this.now();
  }

  key(physical: string): string {
    return targetKey(physical, this.platform);
  }

  async observe(physical: string): Promise<ObservedTarget> {
    return this.host?.readState ? await this.host.readState(physical) : await readTargetState(physical);
  }

  noteRead(scope: string, physical: string, state: TargetState): void {
    if (!state.exists || state.kind !== 'file' || state.sha256 === undefined) return;
    this.remember(this.evidenceOf(scope).reads, this.key(physical), { state, at: this.now() });
  }

  async evaluate(scope: string, physical: string, observed: TargetState, display: string, operation: 'write' | 'delete'): Promise<WriteEvidence> {
    const key = this.key(physical);
    const dirty = this.dirtyUnder(key, false);
    if (dirty) return dirtyRefusal(display);
    if (!observed.exists) return { verdict: 'proceed', basis: 'new-file' };
    if (observed.kind !== 'file') {
      return { verdict: 'refuse', code: 'not-a-file', reason: `"${display}" is not a regular file. Nothing was changed.` };
    }
    // Deleting one name of a file with several leaves the others as they are; replacing its bytes changes them all.
    if (operation === 'write' && (observed.nlink ?? 1) > 1) {
      return {
        verdict: 'refuse',
        code: 'hard-link',
        reason: `"${display}" has more than one name on disk (a hard link), so changing it would also change a file at `
          + 'another path that cannot be shown here. Nothing was changed. Write the change to a new file instead.',
      };
    }
    // A file above the hashing bound has no known content: no look after a wait could find it unchanged, and no
    // restore point holds it. Asking the person would ask for a yes that cannot be honoured, so it is refused here.
    if (observed.sha256 === undefined) return tooLargeRefusal(display, operation);
    if (!this.hosted) return { verdict: 'proceed', basis: 'unhosted' };
    const evidence = this.scopes.get(scope);
    const own = evidence?.own.get(key);
    if (own) {
      return sameTargetState(own.state, observed)
        ? { verdict: 'proceed', basis: 'own-latest' }
        : decision('changed-since-own-write', `"${display}" changed after this request last wrote it.`);
    }
    const snapshot = evidence?.reads.get(key);
    if (snapshot && !sameTargetState(snapshot.state, observed)) {
      return decision('changed-since-read', `"${display}" changed after this request read it.`);
    }
    const ownEffect = this.ownEffect(key, scope, observed);
    if (!snapshot && (ownEffect === 'concurrent' || this.writtenByRunningRequest(key, scope))) {
      return decision('concurrent-request', `"${display}" was changed by another request that is still running.`);
    }
    const git = gitFileState(await this.gitReport(physical, 'file'));
    if (git === 'changed' || git === 'untracked') {
      return ownEffect === 'match'
        ? { verdict: 'proceed', basis: 'own-effect' }
        : decision('git-uncommitted', `"${display}" has ${git === 'untracked' ? 'never been committed to Git' : 'changes that are not committed to Git'}, `
          + 'and UnodeAi has no record of making them, so they may be someone else\'s work.');
    }
    if (git === 'clean') return { verdict: 'proceed', basis: 'git-clean' };
    if (snapshot) return { verdict: 'proceed', basis: 'read-snapshot' };
    if (ownEffect === 'match') return { verdict: 'proceed', basis: 'own-effect' };
    return decision('no-evidence', `"${display}" was not read in this request and UnodeAi has no record of writing it, `
      + 'so what is in it now may be someone else\'s work.');
  }

  /**
   * A folder about to be deleted, judged file by file. Git is asked once for the folder; files it lists as tracked
   * and unchanged need nothing more, and every other file needs this request's own evidence or the host's record.
   */
  async evaluateFolder(scope: string, physicalFolder: string, files: readonly FolderFile[], display: string): Promise<WriteEvidence> {
    const dirty = this.folderDirtyProblem(physicalFolder, display);
    if (dirty) return { verdict: 'refuse', code: 'dirty-buffer', reason: dirty };
    if (!this.hosted) return { verdict: 'proceed', basis: 'unhosted' };
    const report = await this.gitReport(physicalFolder, 'directory');
    const pending = files.filter((file) => folderFileState(report, file.physical, this.platform) !== 'clean');
    if (pending.length > FOLDER_EVIDENCE_MAX_FILES) {
      return decision('folder-foreign', `"${display}" holds ${pending.length} files UnodeAi cannot all compare with what it saw before.`);
    }
    const foreign: string[] = [];
    for (const file of pending) {
      const key = this.key(file.physical);
      let observed: TargetState;
      try {
        observed = (await this.observe(file.physical)).state;
      } catch {
        foreign.push(file.display);
        continue;
      }
      if (!observed.exists) continue;
      const evidence = this.scopes.get(scope);
      const own = evidence?.own.get(key);
      const snapshot = evidence?.reads.get(key);
      const outsideGit = folderFileState(report, file.physical, this.platform) === 'outside';
      const ownEffect = this.ownEffect(key, scope, observed);
      const known = own
        ? sameTargetState(own.state, observed)
        : (snapshot && outsideGit && sameTargetState(snapshot.state, observed)) || (ownEffect === 'match' && !this.writtenByRunningRequest(key, scope));
      if (!known) foreign.push(file.display);
    }
    if (foreign.length === 0) return { verdict: 'proceed', basis: pending.length === 0 && report.repository === true ? 'git-clean' : 'own-effect' };
    const named = foreign.slice(0, 5).map((name) => `"${name}"`).join(', ');
    return decision('folder-foreign', `"${display}" holds ${foreign.length === 1 ? 'a file' : `${foreign.length} files`} UnodeAi did not write `
      + `and this request did not read as it is now (${named}${foreign.length > 5 ? ', ...' : ''}), so they may be someone else's work.`);
  }

  /**
   * The look after a wait and before an effect: the editor, links with several names and the state the plan was made
   * for. Undefined means go on.
   */
  async recheck(physical: string, observed: TargetState, display: string, operation: 'write' | 'delete'): Promise<string | undefined> {
    if (this.dirtyUnder(this.key(physical), false)) return dirtyRefusal(display).reason;
    let now: TargetState;
    try {
      now = (await this.observe(physical)).state;
    } catch (error) {
      return `"${display}" could not be read again before the change: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`;
    }
    if (operation === 'write' && (now.nlink ?? 1) > 1) return `"${display}" now has more than one name on disk (a hard link). Nothing was changed.`;
    if (!sameTargetState(now, observed)) {
      return observed.exists
        ? `"${display}" changed while this change waited, so the plan made for it no longer holds. Nothing was changed; call again to decide on it as it is now.`
        : `"${display}" appeared while this change waited. Nothing was changed; call again to decide on it as it is now.`;
    }
    return undefined;
  }

  /** Unsaved editor changes at or under a folder that is about to be deleted, as the refusal says it, or undefined. */
  folderDirtyProblem(physicalFolder: string, display: string): string | undefined {
    const folderKey = this.key(physicalFolder);
    const dirty = this.dirtyUnder(folderKey, true);
    return dirty ? dirtyRefusal(`${display}/${path.relative(folderKey, dirty).split(path.sep).join('/')}`).reason : undefined;
  }

  noteEffect(scope: string, physical: string, after: TargetState, evidence: OwnEffectRecord['evidence']): void {
    const key = this.key(physical);
    const at = this.now();
    this.remember(this.evidenceOf(scope).own, key, { state: after, at });
    this.rememberHostEffect(key, { scope, state: after, at });
    if (!this.hosted || !after.exists || after.kind !== 'file' || after.sha256 === undefined || after.size === undefined) return;
    this.ownEffects.put({
      revision: OWN_EFFECT_EVIDENCE_REVISION,
      workspace: this.host!.workspaceId(),
      target: key,
      size: after.size,
      sha256: after.sha256,
      ...(after.dev !== undefined ? { dev: after.dev } : {}),
      ...(after.ino !== undefined ? { ino: after.ino } : {}),
      requestId: scope,
      evidence,
      at,
    });
  }

  /** A target this host removed: no record of its old bytes may vouch for a later file of that name. */
  noteGone(scope: string, physical: string, folder: boolean): void {
    const key = this.key(physical);
    const at = this.now();
    const evidence = this.evidenceOf(scope);
    for (const map of [evidence.own, evidence.reads]) {
      for (const target of [...map.keys()]) {
        if (target === key || (folder && isPathInsideOrEqual(key, target))) map.delete(target);
      }
    }
    if (!folder) this.remember(evidence.own, key, { state: { exists: false }, at });
    this.rememberHostEffect(key, { scope, state: { exists: false }, at });
    if (this.hosted) this.ownEffects.remove(key, folder);
  }

  /** An effect whose result could not be confirmed: nothing this host saw of the target still vouches for it. */
  noteUncertain(scope: string, physical: string): void {
    const key = this.key(physical);
    const evidence = this.scopes.get(scope);
    evidence?.own.delete(key);
    evidence?.reads.delete(key);
    this.rememberHostEffect(key, { scope, state: { exists: true, kind: 'other' }, at: this.now() });
    if (this.hosted) this.ownEffects.remove(key, false);
  }

  /** One change to a target at a time inside this host, in arrival order. */
  async serialize<T>(physical: string, effect: () => Promise<T>): Promise<T> {
    const key = this.key(physical);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    this.locks.set(key, tail);
    await previous;
    try {
      return await effect();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private ownEffect(key: string, scope: string, observed: TargetState): 'match' | 'concurrent' | 'none' {
    const record = this.ownEffects.get(key);
    if (!record || record.workspace !== this.host?.workspaceId()) return 'none';
    const sameBytes = record.size === observed.size
      && record.sha256 === observed.sha256
      && (record.ino === undefined || observed.ino === undefined || (record.ino === observed.ino && record.dev === observed.dev));
    if (!sameBytes) return 'none';
    return record.requestId !== scope && this.isRunning(record.requestId) ? 'concurrent' : 'match';
  }

  private writtenByRunningRequest(key: string, scope: string): boolean {
    const last = this.hostEffects.get(key);
    return !!last && last.scope !== scope && this.isRunning(last.scope);
  }

  private isRunning(requestId: string): boolean {
    try { return this.host?.isRequestRunning?.(requestId) === true; } catch { return true; }
  }

  private async gitReport(physical: string, kind: 'file' | 'directory'): Promise<GitPathReport> {
    if (!this.host?.gitPath) return { repository: 'unknown', reason: 'no Git probe' };
    try {
      return await this.host.gitPath(physical, kind);
    } catch (error) {
      return { repository: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The first dirty editor file at or under `key`, as its physical key, or undefined. */
  private dirtyUnder(key: string, folder: boolean): string | undefined {
    let paths: readonly string[];
    try {
      paths = this.host?.dirtyEditorPaths?.() ?? [];
    } catch {
      // The editor could not say: a write that cannot be told apart from unsaved work is not made.
      return key;
    }
    for (const editorPath of paths) {
      const editorKey = this.key(physicalPath(path.resolve(editorPath)));
      if (editorKey === key || (folder && isPathInsideOrEqual(key, editorKey))) return editorKey;
    }
    return undefined;
  }

  private evidenceOf(scope: string): ScopeEvidence {
    let evidence = this.scopes.get(scope);
    if (evidence) {
      this.scopes.delete(scope);
    } else {
      evidence = { reads: new Map(), own: new Map() };
    }
    this.scopes.set(scope, evidence);
    while (this.scopes.size > REQUEST_SCOPES_KEPT) {
      this.scopes.delete(this.scopes.keys().next().value as string);
    }
    return evidence;
  }

  private remember(map: Map<string, SeenState>, key: string, seen: SeenState): void {
    map.delete(key);
    map.set(key, seen);
    while (map.size > TARGETS_PER_SCOPE) map.delete(map.keys().next().value as string);
  }

  private rememberHostEffect(key: string, effect: { scope: string; state: TargetState; at: number }): void {
    this.hostEffects.delete(key);
    this.hostEffects.set(key, effect);
    while (this.hostEffects.size > HOST_EFFECTS_KEPT) this.hostEffects.delete(this.hostEffects.keys().next().value as string);
  }
}

function decision(code: DecisionCode, reason: string): WriteEvidence {
  return { verdict: 'decide', code, reason };
}

/** A file whose content is unknown (above the hashing bound) is neither replaced nor removed. */
function tooLargeRefusal(display: string, operation: 'write' | 'delete'): WriteEvidence & { verdict: 'refuse' } {
  const megabytes = Math.round(TARGET_STATE_HASH_MAX_BYTES / (1024 * 1024));
  return {
    verdict: 'refuse',
    code: 'too-large',
    reason: `"${display}" is larger than ${megabytes} MiB: UnodeAi cannot keep a restore point of a file this large, nor `
      + `compare it with what it saw before, so it does not ${operation === 'delete' ? 'remove' : 'replace'} it. Nothing was changed. `
      + (operation === 'delete' ? 'Ask the user to remove it.' : 'Write the new content to a new file instead, or ask the user.'),
  };
}

function dirtyRefusal(display: string): WriteEvidence & { verdict: 'refuse' } {
  return {
    verdict: 'refuse',
    code: 'dirty-buffer',
    reason: `"${display}" has unsaved changes in an editor. Nothing was changed, and UnodeAi does not save them for `
      + 'you. Save or discard them in the editor, or write the change to another file.',
  };
}

function gitFileState(report: GitPathReport): 'clean' | 'changed' | 'untracked' | 'outside' {
  if (report.repository !== true) return 'outside';
  const entry = report.entries[0];
  if (!entry) return 'clean';
  return entry.state === 'ignored' ? 'outside' : entry.state;
}

/** A file under a folder Git was asked about: listed by an entry for it or a folder holding it, or tracked and clean. */
function folderFileState(report: GitPathReport, physical: string, platform: NodeJS.Platform): 'clean' | 'changed' | 'outside' {
  if (report.repository !== true) return 'outside';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  for (const entry of report.entries) {
    const covers = entry.folder ? isPathInsideOrEqual(entry.path, physical, pathApi) : targetKey(entry.path, platform) === targetKey(physical, platform);
    if (covers) return entry.state === 'ignored' ? 'outside' : 'changed';
  }
  return 'clean';
}

export interface AgentFileWritesOptions {
  agentId: string;
  requestId?: () => string | undefined;
  decide?: OverwriteDecider;
  /** v0.9.97: the agent's own folder. Its request's closeout lists the files it changed relative to it. */
  base?: string;
}

/** One agent's view of the policy: its request decides which reads and writes are "this request's". */
export class AgentFileWrites {
  constructor(
    private readonly policy: FileWritePolicy,
    private readonly options: AgentFileWritesOptions,
  ) {}

  get hosted(): boolean {
    return this.policy.hosted;
  }

  get platform(): NodeJS.Platform {
    return this.policy.platform;
  }

  /** Whether the host keeps the exact bytes of an existing file before a change replaces or removes it. */
  get keepsExactBytes(): boolean {
    return this.policy.checkpoints !== undefined;
  }

  /** The request this agent acts for now; outside one, the agent itself. */
  scope(): string {
    return this.requestId() ?? `agent:${this.options.agentId}`;
  }

  private requestId(): string | undefined {
    try { return this.options.requestId?.(); } catch { return undefined; }
  }

  /**
   * v0.9.97: whose a change planned now is: this agent's request scope and request at this moment. The change is
   * settled with it, so an effect read back after its turn ended still counts for the request that made it.
   */
  attribution(): EffectAttribution {
    const requestId = this.requestId();
    return { scope: requestId ?? `agent:${this.options.agentId}`, ...(requestId ? { requestId } : {}), at: this.policy.clock };
  }

  /** v0.9.97: where a file is, relative to this agent's folder, as its request's closeout lists it. */
  effectPath(physical: string): string | undefined {
    if (!this.options.base) return undefined;
    try {
      return requestEffectPath(physicalPath(path.resolve(this.options.base)), physical);
    } catch {
      return undefined;
    }
  }

  /**
   * Keep the exact bytes of an existing file before a change replaces or removes it, complete on disk before the
   * change acts. Undefined when the host keeps no raw-byte restore points; a refusal means the change must not act.
   */
  async checkpointBefore(change: { physical: string; target: string; path: string; bytes: Buffer | undefined }): Promise<PreChangeCheckpointOutcome | undefined> {
    const checkpoints = this.policy.checkpoints;
    if (!checkpoints) return undefined;
    const requestId = this.requestId();
    return await checkpoints.capture({
      agentId: this.options.agentId,
      ...(requestId ? { requestId } : {}),
      path: change.path,
      target: change.target,
      physical: change.physical,
      bytes: change.bytes,
    });
  }

  key(physical: string): string {
    return this.policy.key(physical);
  }

  observe(physical: string): Promise<ObservedTarget> {
    return this.policy.observe(physical);
  }

  noteRead(physical: string, state: TargetState): void {
    this.policy.noteRead(this.scope(), physical, state);
  }

  evaluate(physical: string, observed: TargetState, display: string, operation: 'write' | 'delete' = 'write'): Promise<WriteEvidence> {
    return this.policy.evaluate(this.scope(), physical, observed, display, operation);
  }

  evaluateFolder(physicalFolder: string, files: readonly FolderFile[], display: string): Promise<WriteEvidence> {
    return this.policy.evaluateFolder(this.scope(), physicalFolder, files, display);
  }

  recheck(physical: string, observed: TargetState, display: string, operation: 'write' | 'delete' = 'write'): Promise<string | undefined> {
    return this.policy.recheck(physical, observed, display, operation);
  }

  folderDirtyProblem(physicalFolder: string, display: string): string | undefined {
    return this.policy.folderDirtyProblem(physicalFolder, display);
  }

  /** Ask the person once for this change. Nobody to ask is not a yes. */
  async decide(request: OverwriteDecisionRequest): Promise<'once' | 'deny' | 'unavailable'> {
    if (!this.options.decide) return 'unavailable';
    try {
      return (await this.options.decide(request)) === 'once' ? 'once' : 'deny';
    } catch {
      return 'deny';
    }
  }

  serialize<T>(physical: string, effect: () => Promise<T>): Promise<T> {
    return this.policy.serialize(physical, effect);
  }

  /**
   * A change read back as it was to be: this request's own state and the host's record. `changed` says whether the
   * file now differs from what it was; one left as it was is no file effect of the request.
   */
  noteEffect(physical: string, after: TargetState, evidence: OwnEffectRecord['evidence'], by: EffectAttribution, changed: boolean): void {
    this.policy.noteEffect(by.scope, physical, after, evidence);
    if (changed) this.report(physical, 'write', evidence, by);
  }

  /**
   * A target the change removed: nothing seen of it, or under it, vouches for a later file of that name. `grade` is
   * how the removal is known; a folder the host could not find gone afterwards is `effect-uncertain`.
   */
  noteGone(physical: string, folder: boolean, grade: HostObservedFileEffect['grade'], by: EffectAttribution): void {
    this.policy.noteGone(by.scope, physical, folder);
    this.report(physical, folder ? 'delete-directory' : 'delete-file', grade, by);
  }

  /**
   * A change whose result could not be confirmed: nothing seen of the target vouches for it any more. It is an effect
   * of the request when the file may have changed: the look failed, or it found something other than was there.
   */
  noteUncertain(physical: string, operation: HostObservedFileEffect['operation'], by: EffectAttribution, mayHaveChanged: boolean): void {
    this.policy.noteUncertain(by.scope, physical);
    if (mayHaveChanged) this.report(physical, operation, 'effect-uncertain', by);
  }

  /**
   * v0.9.97: whether another request changed the target, as this host saw it, since this change was planned. Its
   * read-back cannot then tell which change left what it finds.
   */
  changedByOtherSince(physical: string, by: EffectAttribution): boolean {
    return this.policy.changedByOtherSince(physical, by.scope, by.at);
  }

  private report(physical: string, operation: HostObservedFileEffect['operation'], grade: HostObservedFileEffect['grade'], by: EffectAttribution): void {
    const effectPath = this.effectPath(physical);
    this.policy.reportEffect({
      agentId: this.options.agentId,
      ...(by.requestId ? { requestId: by.requestId } : {}),
      ...(effectPath ? { path: effectPath } : {}),
      key: this.key(physical),
      operation,
      grade,
    });
  }
}

/** The text a decision card shows next to a change that needs one. */
export function overwriteDecisionWarning(reason: string): string {
  return `${reason} Approve only if this change may replace it. This answer covers this one change to the file as it is `
    + 'now; if the file changes before the change is made, the change is not made.';
}

// ─── Committing a host write ──────────────────────────────────────────────

export type FileCommitOutcome =
  | { status: 'committed'; after: TargetState; createdFolders: string[] }
  | { status: 'not-committed'; reason: string }
  | { status: 'effect-uncertain'; reason: string; createdFolders: string[] };

/**
 * Write `bytes` to the physical target. A file that is there is replaced through a new sibling written first
 * (`replace`) or, where that sibling would land outside the grant, in place; a file that is not there is created
 * exclusively, so one that appears first is never replaced. Missing parent folders are made here, each judged
 * again after it exists. `recheck` is the last look before the target changes. The result is read back: success
 * is only what the disk then holds.
 */
export async function commitFileBytes(
  physical: string,
  bytes: Buffer,
  options: {
    observed: TargetState;
    recheck: () => Promise<string | undefined>;
    replace: boolean;
    platform?: NodeJS.Platform;
    /** How the result is read back; replaced in tests to show a disk that holds something else. */
    readBack?: (physical: string) => Promise<ObservedTarget>;
  },
): Promise<FileCommitOutcome> {
  const platform = options.platform ?? process.platform;
  const folder = path.dirname(physical);
  let createdFolders: string[] = [];
  if (!options.observed.exists) {
    let first: string | undefined;
    try {
      first = await fs.mkdir(folder, { recursive: true });
    } catch (error) {
      return { status: 'not-committed', reason: `its folder could not be created: ${errorText(error)}` };
    }
    createdFolders = first ? foldersFrom(first, folder) : [];
    // A folder made here is where the plan said it would be, or nothing is written into it.
    let real: string;
    try { real = realpathSync.native(folder); } catch (error) { real = `unresolved: ${errorText(error)}`; }
    if (targetKey(real, platform) !== targetKey(folder, platform)) {
      await removeEmptyFolders(createdFolders);
      return { status: 'not-committed', reason: 'a folder on the way now leads somewhere else' };
    }
  }
  const problem = await options.recheck();
  if (problem) {
    await removeEmptyFolders(createdFolders);
    return { status: 'not-committed', reason: problem };
  }
  const expected = sha256Hex(bytes);
  if (!options.observed.exists) {
    let handle: fs.FileHandle | undefined;
    let created = false;
    try {
      handle = await fs.open(physical, 'wx');
      created = true;
      await handle.writeFile(bytes);
      await handle.datasync().catch(() => undefined);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
        await removeEmptyFolders(createdFolders);
        return { status: 'not-committed', reason: 'a file of that name appeared before it could be created' };
      }
      if (created) {
        // The file was created by this open and nothing else could have; removing it leaves what was there before.
        // v0.9.97: a look then says so. A file still there, or a look that fails, is an effect of this write.
        await fs.unlink(physical).catch(() => undefined);
        const left = await readTargetState(physical).catch(() => undefined);
        if (left === undefined || left.state.exists) {
          return { status: 'effect-uncertain', reason: `the write failed part way (${errorText(error)}) and UnodeAi could not confirm that the file it created was removed again`, createdFolders };
        }
      }
      await removeEmptyFolders(createdFolders);
      return { status: 'not-committed', reason: errorText(error) };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  } else if (options.replace) {
    // A rename needs only the folder's permission, so the file's own is asked first: a file that could not be written
    // in place is not replaced either.
    try {
      await fs.access(physical, fsConstants.W_OK);
    } catch (error) {
      return { status: 'not-committed', reason: `the file is read-only (${errorText(error)})` };
    }
    const staged = path.join(folder, `.${path.basename(physical)}.unode-${randomBytes(6).toString('hex')}.tmp`);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(staged, 'wx');
      await handle.writeFile(bytes);
      await handle.datasync().catch(() => undefined);
      await handle.close();
      handle = undefined;
      if (platform !== 'win32' && options.observed.mode !== undefined) await fs.chmod(staged, options.observed.mode);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(staged).catch(() => undefined);
      return { status: 'not-committed', reason: errorText(error) };
    }
    const late = await options.recheck();
    if (late) {
      await fs.unlink(staged).catch(() => undefined);
      return { status: 'not-committed', reason: late };
    }
    try {
      await fs.rename(staged, physical);
    } catch (error) {
      await fs.unlink(staged).catch(() => undefined);
      // A rename either happens or not; it is reported as not made only when the old file is seen unchanged.
      const after = await readTargetState(physical).catch(() => undefined);
      if (after && sameTargetState(after.state, options.observed)) {
        return { status: 'not-committed', reason: `it could not be replaced (${errorText(error)}); the file may be read-only or open in another program` };
      }
      return { status: 'effect-uncertain', reason: `the replacement failed (${errorText(error)}) and the file no longer matches what was there`, createdFolders };
    }
  } else {
    try {
      await fs.writeFile(physical, bytes);
    } catch (error) {
      const after = await readTargetState(physical).catch(() => undefined);
      if (after && sameTargetState(after.state, options.observed)) return { status: 'not-committed', reason: errorText(error) };
      return { status: 'effect-uncertain', reason: `the write failed part way (${errorText(error)})`, createdFolders };
    }
  }
  let after: ObservedTarget;
  try {
    after = await (options.readBack ?? readTargetState)(physical);
  } catch (error) {
    return { status: 'effect-uncertain', reason: `it could not be read back: ${errorText(error)}`, createdFolders };
  }
  if (after.state.sha256 !== expected) {
    return { status: 'effect-uncertain', reason: 'what the disk holds now is not what was written', createdFolders };
  }
  return { status: 'committed', after: after.state, createdFolders };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The folders `mkdir -p` made, from the first one it made down to `folder`. Node names the first one with the `\\?\`
 * prefix on Windows. A first folder that is not on the way to `folder` claims nothing: only a folder known to be
 * made here is ever removed.
 */
function foldersFrom(first: string, folder: string): string[] {
  const start = targetKey(withoutLongPathPrefix(first));
  const made: string[] = [];
  let current = folder;
  for (;;) {
    made.unshift(current);
    if (targetKey(current) === start) return made;
    const parent = path.dirname(current);
    if (parent === current) return [];
    current = parent;
  }
}

function withoutLongPathPrefix(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}

/** Only folders this change made, deepest first, and only while empty. */
async function removeEmptyFolders(folders: readonly string[]): Promise<void> {
  for (const folder of [...folders].reverse()) {
    try { await fs.rmdir(folder); } catch { return; }
  }
}

// ─── Native CLI changes (Claude PreToolUse, Codex file-change approval) ─────

export interface NativeFileChangeIntent {
  /** As the tool named it. */
  path: string;
  /** `write`: create or replace, as what is there decides. */
  operation: 'add' | 'update' | 'delete' | 'write';
  /** The bytes the change would leave, when the tool's input fixes them. */
  after?: Buffer;
}

export interface PreparedNativeChange {
  display: string;
  physical: string;
  observed: TargetState;
  before?: Buffer;
  evidence: WriteEvidence;
  operation: NativeFileChangeIntent['operation'];
  /** What the target should hold once the tool has run: a SHA-256, `absent` for a delete, or unknown. */
  expected?: string;
  /** v0.9.97: whose change this is, as it was planned: its result counts for that request when it settles. */
  by: EffectAttribution;
}

/**
 * Prove where each native change lands and what is there before anything is allowed: a Windows name rule, inside a
 * writable root by whole segments, and the physical path (the target's real path or its nearest existing parent's)
 * inside that root's real path. A link whose target is gone, a change that does not match what is there, or a
 * target that is not a regular file is refused. Nothing is created.
 */
export async function prepareNativeFileChanges(
  writes: AgentFileWrites,
  writeRoots: readonly string[],
  base: string,
  intents: readonly NativeFileChangeIntent[],
): Promise<{ ok: true; changes: PreparedNativeChange[] } | { ok: false; reason: string }> {
  const changes: PreparedNativeChange[] = [];
  for (const intent of intents) {
    const display = intent.path;
    const nameProblem = windowsNameProblem(intent.path, writes.platform);
    if (nameProblem) return { ok: false, reason: `Nothing was changed: ${nameProblem}. Use an ordinary file name.` };
    const lexical = path.resolve(base, intent.path);
    const root = writeRoots.map((candidate) => path.resolve(candidate)).find((candidate) => isPathInsideOrEqual(candidate, lexical));
    if (!root) return { ok: false, reason: `"${display}" is outside this agent's writable folders. Nothing was changed.` };
    if (intent.operation === 'delete') {
      // P2-N1: a provider delete removes the NAMED object; a symbolic link canonicalizes to its referent in
      // `physical` below, so deleting it under referent evidence would unlink the link on evidence about a different
      // file. A link is a non-regular target — refuse it. (A hard link is a regular file and is handled as before.)
      try {
        if ((await fs.lstat(lexical)).isSymbolicLink()) {
          return { ok: false, reason: `"${display}" is a symbolic link; a delete would remove the link, not its target, so it is refused. Nothing was changed.` };
        }
      } catch { /* missing/unreadable: the existence check below reports it */ }
    }
    let physical: string;
    try {
      const realRoot = realpathSync.native(root);
      physical = await nativePhysicalTarget(lexical, display);
      if (!isPathInsideOrEqual(realRoot, physical)) {
        return { ok: false, reason: `"${display}" leads outside this agent's writable folders through a link. Nothing was changed.` };
      }
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
    let observed: ObservedTarget;
    try {
      observed = await writes.observe(physical);
    } catch (error) {
      return { ok: false, reason: `"${display}" could not be read before the change: ${errorText(error)}. Nothing was changed.` };
    }
    if (intent.operation === 'add' && observed.state.exists) {
      return { ok: false, reason: `The change adds "${display}", which already exists. Nothing was changed.` };
    }
    if ((intent.operation === 'update' || intent.operation === 'delete') && !observed.state.exists) {
      return { ok: false, reason: `The change ${intent.operation === 'delete' ? 'deletes' : 'updates'} "${display}", which does not exist. Nothing was changed.` };
    }
    const evidence = await writes.evaluate(physical, observed.state, display, intent.operation === 'delete' ? 'delete' : 'write');
    if (evidence.verdict === 'refuse') return { ok: false, reason: evidence.reason };
    changes.push({
      display,
      physical,
      observed: observed.state,
      ...(observed.bytes ? { before: observed.bytes } : {}),
      evidence,
      operation: intent.operation,
      ...(intent.operation === 'delete' ? { expected: 'absent' } : intent.after ? { expected: sha256Hex(intent.after) } : {}),
      by: writes.attribution(),
    });
  }
  return { ok: true, changes };
}

async function nativePhysicalTarget(lexical: string, display: string): Promise<string> {
  try {
    return realpathSync.native(lexical);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await fs.lstat(lexical);
    throw new Error(`"${display}" is a link whose target does not exist. Nothing was changed: the change would create a file wherever it points.`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return physicalPath(lexical);
}

/** The look after an approval and before the native tool is let go: the first reason not to, or undefined. */
export async function recheckNativeFileChanges(writes: AgentFileWrites, changes: readonly PreparedNativeChange[]): Promise<string | undefined> {
  for (const change of changes) {
    const problem = await writes.recheck(change.physical, change.observed, change.display, change.operation === 'delete' ? 'delete' : 'write');
    if (problem) return problem;
  }
  return undefined;
}

/**
 * After a native tool reports its result, read each target back. Only bytes that equal what the change was to leave
 * become this request's own state and the host's record; anything else vouches for nothing.
 *
 * v0.9.97: each result is an effect of the request the change was planned for, graded as read back. What a CLI says it
 * did is not a grade: a change is `native-observed` only when the target holds what the input fixed, and no other
 * request changed it meanwhile (the bytes found could then be either's). A tool that reports a failure may still have
 * changed its target; one found as it was had no effect, anything else is uncertain.
 */
export async function settleNativeFileChanges(writes: AgentFileWrites, changes: readonly PreparedNativeChange[], completed: boolean): Promise<void> {
  for (const change of changes) {
    const intended = change.operation === 'delete' ? 'delete-file' : 'write';
    let after: TargetState;
    try {
      after = (await writes.observe(change.physical)).state;
    } catch {
      writes.noteUncertain(change.physical, intended, change.by, true);
      continue;
    }
    const unchanged = sameTargetContent(after, change.observed);
    if (!completed) {
      if (!unchanged) writes.noteUncertain(change.physical, intended, change.by, true);
      continue;
    }
    const contested = writes.changedByOtherSince(change.physical, change.by);
    if (change.expected === 'absent' && !after.exists && !contested) {
      writes.noteGone(change.physical, false, 'native-observed', change.by);
    } else if (change.expected !== undefined && change.expected !== 'absent' && after.sha256 === change.expected && !contested) {
      writes.noteEffect(change.physical, after, 'native-observed', change.by, !unchanged);
    } else {
      writes.noteUncertain(change.physical, intended, change.by, !unchanged);
    }
  }
}
