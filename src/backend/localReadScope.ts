/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Local Read Scope
 *
 *  Host-owned discovery consent and deliberate request/session file grants. Discovery consent
 *  stays read-only; neither kind changes a shell cwd. Workspace Trust remains the outer boundary.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { FolderPermission, ResolvedPathGrant } from '../types';
import { samePath } from './folderAccess';
import { windowsNameProblem } from './workspacePath';
import { isPathInsideOrEqual } from './pathContainment';
import { fileToolReachesAnotherComputer, heldBySpelling } from '../host/namedOutsidePaths';

export type PathAccessLifetime = 'request' | 'session';
export interface PathAccessChoice { permission: FolderPermission; lifetime: PathAccessLifetime }
export interface PathAccessRequest {
  requestId?: string;
  /** The host's captured request/Stop identity, never a model-supplied flag. */
  isCurrent(): boolean;
  /** A logical request can continue through several turns and delegates after the presentation's turn ends. */
  requestCurrent?(): boolean;
  /**
   * v0.9.100 (field): whether the person's answer to this notice still counts. A notice outlives the turn that showed
   * it, usually by far, and the end of a turn cancels nothing; Stop, a cleared chat or a removed agent does.
   */
  decisionCurrent?(): boolean;
}
export interface SessionPathAccessGrant extends PathAccessChoice {
  id: string;
  target: ResolvedPathGrant;
  requestId?: string;
  /** A captured lease cannot become current again when the same path is re-granted. */
  current(): boolean;
}

export type LivePathAccess = () => readonly SessionPathAccessGrant[];
export interface PathAccessMatch {
  physical: string;
  grant: SessionPathAccessGrant;
  current(): boolean;
}

/** Existing targets and future files are resolved through the first real ancestor, never through a broken link. */
/**
 * The physical path a file call on `named` acts on: its nearest existing folder resolved, so a missing file is named
 * under the folder it would be made in. Throws for a name the platform refuses or a link whose target is gone.
 */
export function accessPhysicalPath(named: string): string {
  const problem = windowsNameProblem(named);
  if (problem) throw new Error(problem);
  const absolute = path.resolve(named);
  let ancestor = absolute;
  for (;;) {
    try { return path.join(realpathSync.native(ancestor), path.relative(ancestor, absolute)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        lstatSync(ancestor);
        throw new Error('The path leads through a link whose target is unavailable.');
      } catch (namedError) {
        if ((namedError as NodeJS.ErrnoException).code !== 'ENOENT') throw namedError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

/** Physical identity, not the path spelling, decides which deliberate grant covers this one operation. */
export function matchPathAccess(
  grants: readonly SessionPathAccessGrant[], named: string, permission: FolderPermission,
): PathAccessMatch | undefined {
  // v0.9.101 (E2): a share, device or /net spelling no grant names is not resolved. Resolving it opens SMB to that server.
  if (fileToolReachesAnotherComputer(path.resolve(named)) && !heldBySpelling(named,
    grants.filter(({ target }) => target.kind === 'directory').flatMap(({ target }) => [target.lexicalPath, target.realPath]),
    grants.filter(({ target }) => target.kind === 'file').flatMap(({ target }) => [target.lexicalPath, target.realPath]))) return undefined;
  let physical: string;
  try { physical = accessPhysicalPath(named); } catch { return undefined; }
  const covers = (grant: SessionPathAccessGrant) => grant.current()
    && (permission === 'read' || grant.permission === 'readwrite')
    && (grant.target.kind === 'file' ? samePath(grant.target.realPath, physical)
      : isPathInsideOrEqual(grant.target.realPath, physical));
  const grant = grants.filter(covers).sort((left, right) =>
    Number(right.target.kind === 'file') - Number(left.target.kind === 'file')
      || right.target.realPath.length - left.target.realPath.length)[0];
  if (!grant) return undefined;
  return { physical, grant, current: () => {
    if (!covers(grant)) return false;
    try { return samePath(accessPhysicalPath(named), physical); } catch { return false; }
  } };
}

/** Resolve only the named target. No drive enumeration or filesystem scan. */
function pathAccessTarget(target: string): ResolvedPathGrant {
  const lexicalPath = path.resolve(target);
  const realPath = accessPhysicalPath(lexicalPath);
  let stat;
  try { stat = statSync(realPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      return { kind: 'file', permission: 'read', lexicalPath, realPath, realParent: realpathSync.native(path.dirname(lexicalPath)) };
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError;
      // Creating parent directories needs a folder grant, not an exact-file grant that silently creates above
      // itself. Propose the nearest existing folder explicitly in the same picker before granting anything.
      let ancestor = path.dirname(lexicalPath);
      for (;;) {
        const next = path.dirname(ancestor);
        if (next === ancestor) throw parentError;
        ancestor = next;
        try { realpathSync.native(ancestor); return pathAccessTarget(ancestor); } catch (ancestorError) {
          if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') throw ancestorError;
        }
      }
    }
  }
  if (!stat.isDirectory() && !stat.isFile()) throw new Error('Access can be granted only to a regular file or folder.');
  return { kind: stat.isDirectory() ? 'directory' : 'file', permission: 'read', lexicalPath,
    realPath, realParent: realpathSync.native(path.dirname(lexicalPath)) };
}

/**
 * v0.9.101 (security re-audit, F3): `pathAccessTarget` for a share, device or `/net` spelling, without blocking the
 * extension host. Choosing Grant access for such a path resolves it, which opens SMB to that server; done synchronously,
 * the window froze for about 21 seconds when the server did not answer, before the picker opened. The same rules, read
 * through the asynchronous file system calls.
 */
async function pathAccessTargetAsync(target: string): Promise<ResolvedPathGrant> {
  const lexicalPath = path.resolve(target);
  const nameProblem = windowsNameProblem(lexicalPath);
  if (nameProblem) throw new Error(nameProblem);
  const physical = async (absolute: string): Promise<string> => {
    let ancestor = absolute;
    for (;;) {
      try { return path.join(await fsp.realpath(ancestor), path.relative(ancestor, absolute)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          await fsp.lstat(ancestor);
          throw new Error('The path leads through a link whose target is unavailable.');
        } catch (namedError) {
          if ((namedError as NodeJS.ErrnoException).code !== 'ENOENT') throw namedError;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  };
  const realPath = await physical(lexicalPath);
  let stat;
  try { stat = await fsp.stat(realPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      return { kind: 'file', permission: 'read', lexicalPath, realPath, realParent: await fsp.realpath(path.dirname(lexicalPath)) };
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError;
      let ancestor = path.dirname(lexicalPath);
      for (;;) {
        const next = path.dirname(ancestor);
        if (next === ancestor) throw parentError;
        ancestor = next;
        try { await fsp.realpath(ancestor); return pathAccessTargetAsync(ancestor); } catch (ancestorError) {
          if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') throw ancestorError;
        }
      }
    }
  }
  if (!stat.isDirectory() && !stat.isFile()) throw new Error('Access can be granted only to a regular file or folder.');
  return { kind: stat.isDirectory() ? 'directory' : 'file', permission: 'read', lexicalPath,
    realPath, realParent: await fsp.realpath(path.dirname(lexicalPath)) };
}

/** The target a Grant access choice is for: resolved without blocking when the spelling reaches another computer. */
async function grantTarget(named: string): Promise<ResolvedPathGrant> {
  return fileToolReachesAnotherComputer(path.resolve(named)) ? pathAccessTargetAsync(named) : pathAccessTarget(named);
}

function sameAccessTarget(left: ResolvedPathGrant, right: ResolvedPathGrant): boolean {
  return left.kind === right.kind && samePath(left.realPath, right.realPath) && samePath(left.realParent, right.realParent);
}

function accessTargetCurrent(target: ResolvedPathGrant): boolean {
  try { return sameAccessTarget(target, pathAccessTarget(target.lexicalPath)); } catch { return false; }
}

export type LocalReadScope = 'workspace' | 'parent' | 'volume';

/**
 * Host-owned, session-only confirmation for a local-scope root. The backend deliberately knows
 * neither VS Code nor persistence: the extension supplies the modal and this class owns the
 * in-memory decision lifecycle.
 */
export type LocalReadScopeConsentRequester = (absoluteRoot: string, prompt: LocalReadScopePrompt) => Promise<boolean>;

/**
 * Which appearance of the prompt this is (v0.9.88 attention signal): agents coalescing in one user-request epoch
 * share one appearance, and a grant the user asked for from a recovery notice or the Security panel is a dialog
 * the user opened.
 */
export interface LocalReadScopePrompt {
  epoch: number;
  userInitiated: boolean;
}

export type LocalReadScopeConsentStatus = 'granted' | 'declined';

export interface LocalReadScopeConsentDecision {
  absoluteRoot: string;
  status: LocalReadScopeConsentStatus;
}

/** The callback receives a grant action already bound to the exact refused root. */
export type LocalReadScopeConsentDeclinedHandler = (
  absoluteRoot: string,
  grant: () => Promise<boolean>,
) => void;

export const LOCAL_READ_SCOPE_GRANT_ACTION = 'Grant folder access' as const;

export type LocalReadScopeRecoveryPresenter = (
  message: string,
  action: typeof LOCAL_READ_SCOPE_GRANT_ACTION,
) => PromiseLike<string | undefined>;

/** Present the recoverable refusal without making the original tool call wait for a second decision. */
export async function offerLocalReadScopeRecovery(
  absoluteRoot: string,
  grant: () => Promise<boolean>,
  present: LocalReadScopeRecoveryPresenter,
): Promise<boolean> {
  const choice = await present(
    `Folder access was declined for:\n${absoluteRoot}\n\nThe current request will continue without it.`,
    LOCAL_READ_SCOPE_GRANT_ACTION,
  );
  return choice === LOCAL_READ_SCOPE_GRANT_ACTION ? grant() : false;
}

export interface LocalReadScopeConsentGate {
  ensure(absoluteRoot: string): Promise<boolean>;
  /**
   * v0.9.110 (N1, audit F1/F3): whether the root is approved right now, asked without any question, notice or
   * decision of its own. A gate without it counts every local-scope root as not approved.
   */
  granted?(absoluteRoot: string): boolean;
}

/**
 * v0.9.99: a root the person's own `localReadScope` choice already covers without a question. `autoGrant` says
 * whether this root is one (the host answers yes for the workspace's parent folder and no for a whole volume);
 * `onAutoGranted` shows the one non-modal notice. A root the person revoked or declined this session is asked
 * about again with the existing question.
 */
export interface LocalReadScopeAutoGrant {
  autoGrant(absoluteRoot: string): boolean;
  onAutoGranted?(absoluteRoot: string): void;
}

/**
 * v0.9.101 (the access table, R1 §2.1, the Owner's decision to move it in this version): where deliberate grants are kept.
 * The access table holds them as its grant rows and re-judges its need rows when they change; this class still decides
 * every grant and answers every per-call question about them, through its unchanged API.
 */
export interface PathGrantRows {
  readonly map: Map<string, SessionPathAccessGrant>;
  /** A grant was made, revoked or ended now. */
  changed(): void;
  /** A grant was found expired while the grants were being read: told once the read is over. */
  changedLater(): void;
}

export class SessionLocalReadScopeConsent implements LocalReadScopeConsentGate {
  private readonly pathAccess: Map<string, SessionPathAccessGrant>;
  private readonly pendingPathAccess = new Map<string, Promise<SessionPathAccessGrant | undefined>>();
  private pathAccessGeneration = 0;
  private readonly decisions = new Map<string, LocalReadScopeConsentStatus>();
  private readonly pending = new Map<string, Promise<'granted' | 'declined' | 'failed'>>();
  /** One epoch is shared by the coordinator and every delegate spawned for that user request. */
  private userRequestEpoch = 0;
  /** A decline or unavailable dialog blocks retries only in the epoch that observed it. */
  private readonly blockedAtEpoch = new Map<string, number>();
  /** Defensive dedupe: one declined root can raise at most one recovery notice in an epoch. */
  private readonly recoveryNotifiedAtEpoch = new Map<string, number>();

  constructor(
    private readonly request: LocalReadScopeConsentRequester,
    private readonly onDeclined?: LocalReadScopeConsentDeclinedHandler,
    private readonly implied?: LocalReadScopeAutoGrant,
    private readonly grantRows: PathGrantRows = { map: new Map(), changed: () => undefined, changedLater: () => undefined },
  ) {
    this.pathAccess = grantRows.map;
  }

  /** The same session owner holds deliberate external grants, separately from discovery-root consent. */
  async requestPathAccess(
    named: string,
    owner: PathAccessRequest,
    choose: (target: Readonly<ResolvedPathGrant>) => Promise<PathAccessChoice | undefined>,
  ): Promise<SessionPathAccessGrant | undefined> {
    // A local path stays resolved before any wait, so two clicks for one target still share one decision.
    const target = fileToolReachesAnotherComputer(path.resolve(named)) ? await pathAccessTargetAsync(named) : pathAccessTarget(named);
    const key = `${process.platform === 'win32' ? target.realPath.toLowerCase() : target.realPath}\0${owner.requestId ?? ''}`;
    const pending = this.pendingPathAccess.get(key);
    if (pending) return pending;
    const generation = this.pathAccessGeneration;
    // The person's choice still stands: no Stop, cleared chat or revocation since the picker opened.
    const decided = () => owner.isCurrent() && generation === this.pathAccessGeneration;
    let decision: Promise<SessionPathAccessGrant | undefined>;
    decision = Promise.resolve().then(async () => {
      if (!owner.isCurrent()) return undefined;
      const choice = await choose(Object.freeze({ ...target }));
      if (!choice || (choice.permission !== 'read' && choice.permission !== 'readwrite')
        || (choice.lifetime !== 'request' && choice.lifetime !== 'session')) return undefined;
      if (!decided()) return undefined;
      if (choice.lifetime === 'request' && !owner.requestId) return undefined;
      let now: ResolvedPathGrant;
      try { now = await grantTarget(target.lexicalPath); } catch { return undefined; }
      if (!sameAccessTarget(target, now)) return undefined;
      const id = randomUUID();
      const realParent = fileToolReachesAnotherComputer(target.realPath)
        ? await fsp.realpath(path.dirname(target.realPath)) : realpathSync.native(path.dirname(target.realPath));
      const admitted = { ...target, lexicalPath: target.realPath, realParent };
      // v0.9.101 (audit R6): a share target is checked again through awaits; a Stop, a cleared chat or a revocation
      // during them cancels the decision, so the decision is looked at once more right before authority is committed.
      if (!decided()) return undefined;
      const grant: SessionPathAccessGrant = {
        id, ...choice, target: { ...admitted, permission: choice.permission },
        ...(choice.lifetime === 'request' ? { requestId: owner.requestId } : {}),
        current: () => this.pathAccess.get(id) === grant && accessTargetCurrent(admitted)
          && (choice.lifetime === 'session' || (owner.requestCurrent ?? owner.isCurrent)()),
      };
      this.pathAccess.set(id, grant);
      this.grantRows.changed();
      return grant;
    }).finally(() => { if (this.pendingPathAccess.get(key) === decision) this.pendingPathAccess.delete(key); });
    this.pendingPathAccess.set(key, decision);
    return decision;
  }

  /** Resolve on every call: expiry/revocation is visible to already-running agents and hooks. */
  pathAccessFor(requestId: string | undefined): readonly SessionPathAccessGrant[] {
    const current: SessionPathAccessGrant[] = [];
    let ended = false;
    for (const [id, grant] of this.pathAccess) {
      if (!grant.current()) { this.pathAccess.delete(id); ended = true; continue; }
      if (grant.lifetime === 'session' || grant.requestId === requestId) current.push(grant);
    }
    if (ended) this.grantRows.changedLater();
    return current;
  }

  revokePathAccess(id: string): boolean {
    const revoked = this.pathAccess.delete(id);
    if (revoked) this.grantRows.changed();
    return revoked;
  }

  listPathAccess(): Array<{ id: string; path: string; kind: 'file' | 'directory'; permission: FolderPermission; lifetime: PathAccessLifetime }> {
    return [...this.pathAccess.values()].filter((grant) => grant.current()).map((grant) => ({
      id: grant.id, path: grant.target.realPath, kind: grant.target.kind, permission: grant.permission, lifetime: grant.lifetime,
    }));
  }

  endPathAccessRequest(requestId: string): void {
    let ended = false;
    for (const [id, grant] of this.pathAccess) if (grant.requestId === requestId) { this.pathAccess.delete(id); ended = true; }
    if (ended) this.grantRows.changed();
  }

  /** Host shutdown invalidates outstanding decisions as well as already admitted session grants. */
  endPathAccessSession(): void {
    this.pathAccessGeneration++;
    const had = this.pathAccess.size > 0;
    this.pathAccess.clear();
    this.pendingPathAccess.clear();
    if (had) this.grantRows.changed();
  }

  /**
   * A direct user request is the only event that makes a previous decline askable again. Automated
   * continuations, tool retries, delegate wakes and backend restarts do not call this method, so they
   * retain the fail-closed latch and cannot create a prompt loop.
   */
  beginUserRequest(): void {
    this.userRequestEpoch++;
  }

  /**
   * `waiting` wraps only the time this caller spends on the person's decision, whether it opened the prompt or
   * joined one already open. A root that is already granted or declined never calls it.
   */
  async ensure(
    absoluteRoot: string,
    waiting: <T>(wait: () => PromiseLike<T>) => PromiseLike<T> = (wait) => wait(),
  ): Promise<boolean> {
    const root = path.resolve(absoluteRoot);
    if (this.decisions.get(root) === 'granted') {
      return true;
    }
    const epoch = this.userRequestEpoch;
    if (this.blockedAtEpoch.get(root) === epoch) {
      return false;
    }
    const outcome = await waiting(() => this.ask(root, epoch, 'agent'));
    if (outcome !== 'granted') {
      this.blockedAtEpoch.set(root, epoch);
    }
    return outcome === 'granted';
  }

  /** Open the same confirmation from a recovery notice or the Security panel. */
  async requestGrant(absoluteRoot: string): Promise<boolean> {
    const root = path.resolve(absoluteRoot);
    if (this.decisions.get(root) === 'granted') {
      return true;
    }
    const epoch = this.userRequestEpoch;
    const outcome = await this.ask(root, epoch, 'user');
    if (outcome !== 'granted') {
      this.blockedAtEpoch.set(root, epoch);
    }
    return outcome === 'granted';
  }

  /**
   * v0.9.110: approved now, without asking: granted this session, or implied by the person's own localReadScope
   * choice and not yet decided. A revoke or decline is never approved here. Records nothing and shows nothing.
   */
  isGranted(absoluteRoot: string): boolean {
    const root = path.resolve(absoluteRoot);
    const decision = this.decisions.get(root);
    if (decision !== undefined) return decision === 'granted';
    return this.implied?.autoGrant(root) === true;
  }

  granted(absoluteRoot: string): boolean {
    return this.isGranted(absoluteRoot);
  }

  /** A revoke affects every currently active request before its next tool call. */
  revoke(absoluteRoot: string): boolean {
    const root = path.resolve(absoluteRoot);
    if (this.decisions.get(root) !== 'granted') {
      return false;
    }
    this.decisions.set(root, 'declined');
    this.blockedAtEpoch.set(root, this.userRequestEpoch);
    return true;
  }

  list(): LocalReadScopeConsentDecision[] {
    return [...this.decisions.entries()]
      .map(([absoluteRoot, status]) => ({ absoluteRoot, status }))
      .sort((left, right) => left.absoluteRoot.localeCompare(right.absoluteRoot));
  }

  private ask(root: string, epoch: number, origin: 'agent' | 'user'): Promise<'granted' | 'declined' | 'failed'> {
    const inFlight = this.pending.get(root);
    if (inFlight) {
      return inFlight;
    }
    // Only a root with no decision this session is implied; a revoke or decline keeps the question.
    if (origin === 'agent' && !this.decisions.has(root) && this.implied?.autoGrant(root) === true) {
      this.decisions.set(root, 'granted');
      this.blockedAtEpoch.delete(root);
      try { this.implied.onAutoGranted?.(root); } catch { /* a notice that cannot be shown does not hold up the read */ }
      return Promise.resolve('granted');
    }
    const notifyDecline = origin === 'agent';
    // Store the pending promise before awaiting it so simultaneous agents coalesce to the same modal.
    // A thrown/unavailable UI fails this attempt closed but records no user decision.
    const decision = Promise.resolve()
      .then(() => this.request(root, { epoch, userInitiated: origin === 'user' }))
      .then((approved): 'granted' | 'declined' => approved === true ? 'granted' : 'declined')
      .then((outcome) => {
        this.decisions.set(root, outcome);
        if (outcome === 'granted') {
          this.blockedAtEpoch.delete(root);
          this.recoveryNotifiedAtEpoch.delete(root);
        } else if (notifyDecline && this.recoveryNotifiedAtEpoch.get(root) !== epoch) {
          this.recoveryNotifiedAtEpoch.set(root, epoch);
          this.onDeclined?.(root, () => this.requestGrant(root));
        }
        return outcome;
      }, () => 'failed' as const)
      .finally(() => {
        this.pending.delete(root);
      });
    this.pending.set(root, decision);
    return decision;
  }
}

/**
 * Return the one optional host-owned root implied by the user's local-read choice.
 *
 * - workspace: preserve the long-standing workspace-only sandbox.
 * - parent: let an agent inspect sibling projects without asking the user to pre-register each one.
 * - volume: mirror Codex's broad local read reach on the workspace's current filesystem volume.
 *
 * This intentionally returns lexical paths. `normalizeAgentReadRoots` is still responsible for
 * existence, realpath canonicalisation, de-duplication, and nested-root collapse.
 */
export function localReadRootsForScope(
  scope: LocalReadScope | string | undefined,
  workspaceRoot: string,
  isTrusted: boolean,
): string[] {
  if (!isTrusted) {
    return [];
  }
  const root = path.resolve(workspaceRoot);
  switch (scope) {
    case 'parent': {
      const parent = path.dirname(root);
      return parent === root ? [] : [parent];
    }
    case 'volume':
      return [path.parse(root).root];
    default:
      return [];
  }
}

/**
 * v0.9.89 field fix: tell every route, in its per-turn project context, which extra local root it may ASK to
 * read. It names the canonical root and says it is not a grant: the agent calls read_file or a search tool and
 * the existing consent gate decides. It changes no tool list, read root, write root, shell permission or
 * portable evidence. Untrusted workspaces and the `workspace` scope get nothing.
 */
export function localReadScopeGuidance(
  scope: LocalReadScope | string | undefined,
  primaryRoot: string | undefined,
  trusted: boolean,
): string {
  if (!primaryRoot) return '';
  const [root] = localReadRootsForScope(scope, primaryRoot, trusted);
  if (!root) return '';
  const what = scope === 'volume' ? 'the whole volume that holds this workspace' : 'the folder that contains this workspace';
  // v0.9.99: the parent folder is read without a question (the user is told once); a whole volume still asks.
  const implied = isImpliedLocalReadRoot(root);
  return [
    '## Local read reach (host setting)',
    `Beyond your working folder you may ${implied ? '' : 'ask to '}read or search ${what}: ${root.slice(0, 400)}`,
    (implied
      ? 'When you need something there, call read_file or a search tool; the user is told the first time. '
      : 'This is not granted yet. When you need something there, call read_file or a search tool and UnodeAi will ask the user. ')
      + 'Writes and deletes stay in your working folder unless the user grants access to an outside path; shell commands stay in your working folder.',
  ].join('\n');
}

/**
 * v0.9.100 (field, 4523a765): a path outside the working folder can be granted. Agents told the user to open another
 * folder as the workspace, or that the path was out of scope, without calling a file tool, so nothing offered the
 * grant. Guidance only: the file tools and the person's choice decide every call. Not for Full access, which reaches
 * such paths already, nor for an agent whose own Folder Access a grant never widens.
 */
export function outsidePathGrantGuidance(): string {
  return [
    '## Paths outside the workspace (host setting)',
    'A path outside your working folder is not out of reach for good. When the user names one, UnodeAi offers them '
      + 'Grant access for it as the request starts. When you need such a path, call the file tool for it (read_file, '
      + 'write_file or write_document); if it is refused, UnodeAi offers the user Grant access too. A refused path blocks '
      + 'only the steps that need it: go on with the work that does not. Tell the user to choose Grant access for it in '
      + 'this request (Read + Write for a folder you are to write in). '
      + 'Do not tell them to open another folder as the workspace first.',
  ].join('\n');
}

/**
 * v0.9.100 field fix (S5, S6): an agent under Full access is told so at each turn. Nothing else told it, and both the
 * read guidance above and the OpenAI-compatible system prompt said its writes stay in the workspace. It stays out of
 * that system prompt because Autonomy can change during a session. Guidance only: the file tools decide every call.
 * Native Codex writes through its own permission setting, so that route is promised reads only.
 */
export function fullFileAccessGuidance(backend: string): string {
  return [
    '## File access (host setting)',
    'Full access is on for you now, and it replaces any statement that you can only work inside your workspace root.',
    backend === 'codex'
      ? "UnodeAi's read tools can read outside your working folder, by absolute path. Your writes follow your Codex permission setting."
      : 'The file tools you have can read and write outside your working folder, by absolute path.',
    'Plan is still read only and a task scope still limits you; if a tool refuses, that refusal is the current answer. '
      + 'Full access does not change where commands start.',
  ].join('\n');
}

/**
 * v0.9.99: whether a local-scope root is read without a question. The workspace's parent folder is; a filesystem
 * volume root, home or a profile-container/ancestor is not. Explicit grants are handled separately.
 */
export function isImpliedLocalReadRoot(absoluteRoot: string): boolean {
  try {
    const root = accessPhysicalPath(absoluteRoot); const home = accessPhysicalPath(homedir());
    if (samePath(root, path.parse(root).root) || isPathInsideOrEqual(root, home)) return false;
    // Native path grammar constructs the conventional profile containers; no drive letter or user name is assumed.
    const containers = [path.join(path.parse(root).root, 'Users')];
    if (path.sep === '/') containers.push(path.join(path.parse(root).root, 'home'));
    return !containers.some(container => samePath(root, accessPhysicalPath(container)));
  } catch { return false; } // A failed ownership/location check uses the existing question, never an implicit grant.
}

/** Preserve explicit narrower roots when the new profile boundary requires consent. Volume behavior is unchanged. */
export function preservesNestedProfileReadRoots(root: string): boolean {
  const resolved = path.resolve(root);
  return !samePath(resolved, path.parse(resolved).root) && !isImpliedLocalReadRoot(resolved);
}
