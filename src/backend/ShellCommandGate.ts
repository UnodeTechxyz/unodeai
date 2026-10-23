import { promises as fs } from 'fs';
import * as path from 'path';
import { CommandPolicy, DESTRUCTIVE_PATTERN_REASON, noPolicyVerdict, supportedDeleteTargets, type CommandVerdict } from './CommandPolicy';
import { type CommandShellIdentity, grammarOfShellKind, shellCompatibilityProblem } from './CommandShell';

/**
 * Human-visible prefix for a shell-path heuristic refusal. It is not a sandbox boundary and must never
 * control turn termination; only structured path-resolution errors can do that (G-003).
 */
export const BLOCKED_OUTSIDE_WORKDIR = 'BLOCKED_OUTSIDE_WORKDIR';

export interface CommandApprovalDecision {
  allow: boolean;
  note?: string;
  /** The host closed the prompt (the agent was removed, restarted or stopped); nobody decided. */
  withdrawn?: boolean;
}

export interface CommandApprovalContext {
  /** The shell that will interpret this exact command. Approvals are remembered for its grammar only. */
  readonly shell: CommandShellIdentity;
  warning?: string;
  forcePrompt?: boolean;
  /**
   * The command is opaque (the guard could not read it), so its approval is single-use only: no session or
   * project grant is offered, no latched grant is honoured, and nothing is persisted. The approver must prompt
   * for this exact command and run it at most once.
   */
  singleUse?: boolean;
  /** Aborted when the host disposes the agent before the command ran: the prompt closes at once. */
  signal?: AbortSignal;
}

/**
 * `context.warning` explains why a command is being escalated that policy would otherwise have let
 * through silently. `context.forcePrompt` says the human must be asked even if this command's template
 * was already latched (session/project) — the template is approved, the new detail (e.g. an out-of-root
 * path) is not.
 */
export type CommandApprover = (
  command: string,
  context: CommandApprovalContext
) => Promise<CommandApprovalDecision>;

export type ShellCommandSource = 'model' | 'config';

export type ShellCommandGateBlockKind = 'policy' | 'approval' | 'outside-unattended' | 'shell-compatibility';

export type ShellCommandGateResult =
  | { ok: true; outsidePath?: string }
  | { ok: false; kind: ShellCommandGateBlockKind; message: string; reason?: string; note?: string; outsidePath?: string };

export interface ShellCommandGateOptions {
  command: string;
  roots: string | string[];
  /**
   * The directory the command will run in, exactly as the executor is given it. The catastrophic-delete guard
   * resolves a delete's targets from here; never a first root or the extension's own directory.
   */
  cwd: string;
  source: ShellCommandSource;
  /** The prepared shell identity. Required: the gate never infers a grammar from the host platform. */
  shell: CommandShellIdentity;
  /** A truthful preparation notice (e.g. the direct fallback), shown with any approval this gate opens. */
  notice?: string;
  /** The prepared execution's lifecycle signal, handed to any approval this gate opens. */
  signal?: AbortSignal;
  commandPolicy?: CommandPolicy;
  requestApproval?: CommandApprover;
  onOutsideRoot?: (attemptedPath: string) => void;
  onConfigOutsideRoot?: (message: string, outsidePath: string, command: string) => void;
  /**
   * Test-only seam for the physical delete guard's budget, clock and filesystem resolver (S0-N5). It reaches the
   * guard through the production gate so a regression can drive a stalled query and the budget deadline on the real
   * route. Never set in production code; omitted, the guard uses its 32-target / 1-second / fs.realpath defaults.
   */
  physicalDeleteGuardForTest?: Partial<PhysicalDeleteGuardLimits>;
}

/** How outside-root detection reads a token: under which shell, on which host. */
export interface OutsideRootScanOptions {
  shell?: Pick<CommandShellIdentity, 'kind'>;
  platform?: NodeJS.Platform;
  pathApi?: typeof path.posix | typeof path.win32;
}

/**
 * Git Bash and other MSYS shells on Windows spell a drive as `/c/...`. Only that unambiguous form is mapped,
 * and only for an identified bash on a Windows host; WSL paths and shell expansions are never guessed.
 */
export function msysDrivePath(token: string): string | undefined {
  const match = /^\/([A-Za-z])(\/.*)?$/.exec(token);
  if (!match) return undefined;
  return `${match[1].toUpperCase()}:\\${(match[2] ?? '').replace(/^\//, '').replace(/\//g, '\\')}`;
}

const warnedConfigOutsideRootCommands = new Set<string>();

export function resetShellCommandGateWarningsForTest(): void {
  warnedConfigOutsideRootCommands.clear();
}

/**
 * Find the first absolute path token in a shell command that points OUTSIDE `root` (G-003). Catches the
 * common ways a command escapes the file-tool sandbox — `type C:\...`, `Get-Content C:\...`, UNC
 * `\\...`, forward-slash UNC `//server/share/...`, or a unix `/a/b` path. Relative paths (`src/foo.ts`,
 * `./x`) and short flags (`/d`) are ignored. Returns the offending absolute path, or undefined if every
 * referenced absolute path is inside the root.
 */
export function detectOutsideRootPath(command: string, roots: string | string[], scan: OutsideRootScanOptions = {}): string | undefined {
  const pathApi = scan.pathApi ?? path;
  const mapMsysDrives = scan.shell?.kind === 'bash' && (scan.platform ?? process.platform) === 'win32';
  const resolvedRoots = (Array.isArray(roots) ? roots : [roots]).map((r) => pathApi.resolve(r));
  // An INLINE-SCRIPT body (node -e "...", python -c "...", perl -e "...") is source code, not shell argv:
  // it's full of regex literals and string escapes — /\r?\n/, '\\n', '/g' — that look like Windows/UNC
  // or unix paths but aren't. Path-sniff only the argv BEFORE the eval flag.
  let scanned = command;
  if (/\b(?:node|deno|bun|ts-node|tsx|python|python3|ruby|perl|php)\b/.test(command)) {
    const evalAt = command.search(/(?:^|\s)-(?:e|c|p)\b|(?:^|\s)--(?:eval|exec|print|check)\b/);
    if (evalAt >= 0) {
      scanned = command.slice(0, evalAt);
    }
  }

  // Windows drive (C:\ or C:/), extended paths (\\?\C:\... / \\?\UNC\...), UNC
  // (\\server\... or //server/share/...), or a unix ABSOLUTE path with ≥2 segments (/a/b...).
  //
  // URL schemes are filtered with the full scheme token, not by peeking at one character before the
  // colon. This fixes `a://host` and `git+ssh:/host` without losing the intentional `file://c:/...`
  // recovery: the embedded `c:/...` is a separate drive candidate, not part of the `file:` scheme token.
  const drive = String.raw`[A-Za-z]:[\\/]`;
  const winExtended = String.raw`\\\\\?\\(?:[A-Za-z]:[\\/]|UNC[\\/][^\s"'\\/|&;<>]+[\\/][^\s"'\\/|&;<>]+[\\/])`;
  const unc = String.raw`\\\\[^\s"'|&;<>]*|(?<!:)\/\/[^\s"'\/|&;<>]+\/[^\s"'|&;<>]*`;
  const unixAbs = String.raw`(?<![\w.~)\]/])\/[^\s"'\/|&;<>]+\/[^\s"'|&;<>]*`;
  const re = new RegExp(String.raw`(?:${winExtended}|${drive}|${unc}|${unixAbs})[^\s"'|&;<>]*`, 'g');

  for (const match of scanned.matchAll(re)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const uriScheme = uriSchemeForDriveCandidate(scanned, index, raw);
    if (uriScheme) {
      if (uriScheme.toLowerCase() === 'file') {
        const embedded = outsideEmbeddedDrivePath(raw, resolvedRoots, pathApi);
        if (embedded) {
          return embedded;
        }
      }
      continue;
    }

    // Paths written in PROSE carry trailing punctuation — "(c:\proj).", "c:\proj," — strip a trailing
    // run of it, or "c:\proj)." is mistaken for a SIBLING of the working root and flagged as outside.
    const tok = raw.replace(/[)\]}.,;:'"!?]+$/, '');
    if (!tok) {
      continue;
    }

    // Windows extended-length paths contain `?` by design. Handle those before the wildcard/glob filter.
    const extendedLength = isWindowsExtendedLengthPath(tok);

    // A real ordinary filesystem path we'd want to block never contains `?` or `*` (invalid in Windows
    // filenames; shell globs/regex elsewhere). When they appear outside an extended-length prefix, the
    // token is almost always a regex literal or glob inside an inline script.
    if (!extendedLength && /[?*]/.test(tok)) {
      continue;
    }
    // `/dev/null` (and friends) is the standard "discard output" sink, not an out-of-workspace path.
    if (/^\/dev\/(?:null|stdout|stderr|tty|zero|random|urandom|fd\/\d+)$/i.test(tok)) {
      continue;
    }
    let abs: string;
    try {
      abs = pathApi.resolve(mapMsysDrives ? msysDrivePath(tok) ?? tok : tok);
    } catch {
      continue;
    }
    if (!resolvedRoots.some((root) => isInside(root, abs, pathApi))) {
      return abs;
    }
  }
  return undefined;
}

export async function gateShellCommand(opts: ShellCommandGateOptions): Promise<ShellCommandGateResult> {
  // The policy reads the prepared shell, never the host platform: the same identity runs the command. With no
  // policy a missing mode is NOT `all`: a blocked or opaque command is refused, a supported one keeps the
  // caller's existing contract.
  const shell = opts.shell;
  let verdict: CommandVerdict = opts.commandPolicy?.check(opts.command, { shell })
    ?? noPolicyVerdict(opts.command, shell);
  // The physical half of the delete guard reads the filesystem for a SUPPORTED command: a short name, a link or
  // an absolute spelling of a protected folder resolves to that folder (blocked). When a target's real path
  // cannot be proven the command becomes opaque — never "no hit so allowed" — and is re-mapped under the mode.
  if (verdict.reason !== DESTRUCTIVE_PATTERN_REASON && !verdict.opaque) {
    const limits = opts.physicalDeleteGuardForTest
      ? { ...DEFAULT_PHYSICAL_LIMITS, ...opts.physicalDeleteGuardForTest }
      : DEFAULT_PHYSICAL_LIMITS;
    const physical = await deletesProtectedTarget(opts.command, opts.cwd, opts.roots, shell, limits);
    if (physical === 'protected') {
      verdict = { allowed: false, reason: DESTRUCTIVE_PATTERN_REASON };
    } else if (physical === 'uncertain') {
      verdict = opts.commandPolicy
        ? opts.commandPolicy.opaqueVerdict("a delete target's real path could not be confirmed", { shell })
        : { allowed: false, opaque: true, reason: "a delete target's real path could not be confirmed; it is not run without an explicit command-execution mode." };
    }
  }

  // A construct the identified shell can never run (a PowerShell cmdlet in cmd.exe, `&&` in Windows
  // PowerShell) is an executor fact, not a consent decision: refuse before opening an approval surface so an
  // Allow click can never be reported as missing consent. A catastrophic-command denial remains dominant so
  // compatibility guidance can never soften that block.
  const problem = shellCompatibilityProblem(opts.command, shell);
  if (problem && verdict.reason !== DESTRUCTIVE_PATTERN_REASON) {
    return {
      ok: false,
      kind: 'shell-compatibility',
      reason: problem.message,
      message: problem.message,
    };
  }

  // A policy DENIAL is final. Outside-root detection may add a prompt/warning only to a command policy
  // would otherwise permit; it must never make a denied command runnable.
  if (!verdict.allowed && !verdict.ask) {
    return {
      ok: false,
      kind: 'policy',
      reason: verdict.reason,
      message: policyBlockMessage(verdict.reason),
    };
  }

  const outsidePath = detectOutsideRootPath(opts.command, opts.roots, { shell });
  if (outsidePath) {
    opts.onOutsideRoot?.(outsidePath);
  }

  if (opts.source === 'model') {
    return await gateModelCommand(opts, verdict, outsidePath);
  }
  return await gateConfigCommand(opts, verdict, outsidePath);
}

function isInside(root: string, abs: string, pathApi: typeof path.posix | typeof path.win32 = path): boolean {
  const rel = pathApi.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !pathApi.isAbsolute(rel));
}

/**
 * The physical half of the catastrophic-delete guard. Each literal target of a recursive or forced delete is
 * resolved as this host's filesystem resolves it, from the directory the command runs in. It is refused when it
 * is that directory, a workspace root, a folder above either, or has a `.git` or `.unode` segment, so a short
 * name (`GIT~1`), a link or an absolute spelling of one of them is judged as what it names. It only adds
 * refusals: a target that does not exist, or that the shell would expand or read differently (a variable, glob,
 * escape or unmapped drive), is left to the lexical floor and the mode. It is not a shell interpreter, and a
 * target that changes after this check is a residual race.
 *
 * Containment is judged by whole path segments: a working folder named `..cache` is inside its parent. The
 * protected segments are judged under every protected folder that holds the target, so a narrower working folder
 * never hides a `.git` that a wider root sees.
 */
/** The physical delete guard over at most 32 literal targets within a 1-second budget. Injectable for tests. */
export interface PhysicalDeleteGuardLimits {
  maxTargets: number;
  budgetMs: number;
  now: () => number;
  /**
   * The filesystem resolver, injectable so a test can drive a stalled query through the gate (S0-N5). Production
   * uses fs.realpath. The guard races every call to it against the remaining budget, so a resolver that never
   * settles makes the guard report `uncertain` at the deadline instead of hanging.
   */
  realpath: (p: string) => Promise<string>;
  /**
   * The cap on resolver calls that have started and not yet settled, shared by every gate call (S0-N6). Production
   * uses one process-wide limit; a test passes its own so a never-settling resolver cannot fill the shared one.
   */
  queries: PhysicalQueryLimit;
}

/** Thrown, as a rejection, by PhysicalQueryLimit.start when every slot is held; no query was started. */
const PHYSICAL_QUERY_LIMIT_REACHED = 'UNODE_PHYSICAL_QUERY_LIMIT';

/**
 * S0-N6: a finite bound on physical filesystem queries in flight ACROSS gate calls. fs.realpath cannot be cancelled,
 * so a query abandoned at a call's deadline keeps running until the system call really returns, and the next call
 * would otherwise start another one. Each started query holds a slot until it settles (resolve or reject); once every
 * slot is held, `start` refuses without calling the resolver, and the guard reports `uncertain` (→ opaque). A
 * filesystem that never answers therefore costs at most `max` outstanding queries in total, however many commands
 * are checked, sequentially or at once.
 */
export class PhysicalQueryLimit {
  private active = 0;

  constructor(readonly max: number) {}

  /** Queries started and not yet settled. */
  get inFlight(): number {
    return this.active;
  }

  get saturated(): boolean {
    return this.active >= this.max;
  }

  /** Start one query in a free slot, released when it settles; reject without starting it when no slot is free. */
  start<T>(query: () => Promise<T>): Promise<T> {
    if (this.saturated) {
      return Promise.reject(Object.assign(new Error('the physical query limit is reached'), { code: PHYSICAL_QUERY_LIMIT_REACHED }));
    }
    this.active += 1;
    let started: Promise<T>;
    try {
      started = query();
    } catch (error) {
      this.active -= 1;
      return Promise.reject(error);
    }
    return started.finally(() => {
      this.active -= 1;
    });
  }
}

/** Eight slots: one gate call resolves one query at a time, so a healthy filesystem never comes near this. */
const SHARED_PHYSICAL_QUERY_LIMIT = new PhysicalQueryLimit(8);

const DEFAULT_PHYSICAL_LIMITS: PhysicalDeleteGuardLimits = {
  maxTargets: 32,
  budgetMs: 1000,
  now: () => Date.now(),
  realpath: (p) => fs.realpath(p),
  queries: SHARED_PHYSICAL_QUERY_LIMIT,
};

type PhysicalDeleteResult = 'protected' | 'clear' | 'uncertain';

async function deletesProtectedTarget(
  command: string,
  cwd: string,
  roots: string | string[],
  shell: CommandShellIdentity,
  limits: PhysicalDeleteGuardLimits = DEFAULT_PHYSICAL_LIMITS,
): Promise<PhysicalDeleteResult> {
  const targets = supportedDeleteTargets(command, shell);
  if (targets.length === 0) {
    return 'clear';
  }
  if (targets.length > limits.maxTargets) {
    return 'uncertain'; // too many targets to resolve within budget
  }
  // S0-N5: a single wall-clock deadline bounds the WAIT for every filesystem query, protected-root and target
  // resolution alike. Each query is raced against the remaining budget; one that has not settled by the deadline
  // reports `uncertain` (never "no hit so allowed") instead of holding the gate. Within a call, roots and targets are
  // resolved one at a time, no query starts once the deadline has passed, and the call stops at the first timeout.
  // S0-N6: the abandoned query is not cancellable (fs.realpath has no abort) and keeps its slot in the shared
  // `limits.queries` until it really settles. Every resolver call goes through that limit, so across all calls at
  // most `limits.queries.max` queries are ever outstanding; with every slot held the guard starts none and reports
  // `uncertain`. The timer is unref'd so a stalled query cannot hold the process.
  const realpath = (p: string): Promise<string> => limits.queries.start(() => limits.realpath(p));
  const deadline = limits.now() + limits.budgetMs;
  const remainingMs = (): number => deadline - limits.now();
  const protectedDirs: string[] = [];
  for (const dir of [cwd, ...(Array.isArray(roots) ? roots : [roots])]) {
    if (remainingMs() <= 0 || limits.queries.saturated) {
      return 'uncertain'; // out of budget, or no query slot free, before this root could be resolved
    }
    const resolved = await withinBudget(realPathOfProtectedDir(dir, realpath), remainingMs());
    if (resolved.timedOut || resolved.value === undefined) {
      return 'uncertain'; // a protected root has no proven real path (timeout, query failure, no slot); not judged
    }
    protectedDirs.push(resolved.value);
  }
  let uncertain = false;
  for (const target of targets) {
    if (remainingMs() <= 0 || limits.queries.saturated) {
      return 'uncertain'; // out of budget or slots; never leave an unresolved target as "no hit so allowed"
    }
    const resolved = await withinBudget(physicalDeleteTarget(target, cwd, shell, realpath), remainingMs());
    if (resolved.timedOut) {
      return 'uncertain'; // this target did not resolve within budget
    }
    const real = resolved.value;
    if (real.kind === 'skip') {
      continue; // a flag, or a target the lexical floor already judged
    }
    if (real.kind === 'uncertain') {
      uncertain = true;
      continue;
    }
    if (protectedDirs.some((dir) => holdsPath(real.path, dir))) {
      return 'protected'; // the working folder, a root, or a folder above them
    }
    const holders = protectedDirs.filter((dir) => holdsPath(dir, real.path));
    const tails = holders.length > 0 ? holders.map((dir) => path.relative(dir, real.path)) : [real.path];
    if (tails.some((tail) => tail.split(/[\\/]+/).some(isProtectedSegmentName))) {
      return 'protected';
    }
  }
  return uncertain ? 'uncertain' : 'clear';
}

/** `dir` is `abs` or holds it, by whole segments: `repo` holds `repo/..cache`, and does not hold `repo-other`. */
function holdsPath(dir: string, abs: string): boolean {
  const rel = path.relative(dir, abs);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolve a filesystem query, or report a timeout when the remaining budget elapses first (S0-N5). The query
 * promises passed here never reject (realPathOfProtectedDir and physicalDeleteTarget catch their own errors), so the race
 * only ever resolves. On a timeout the query is abandoned, not awaited: fs.realpath is not cancellable, so its
 * libuv request completes later and its result is discarded. The timer is unref'd and always cleared.
 */
async function withinBudget<T>(query: Promise<T>, remainingMs: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  if (remainingMs <= 0) {
    return { timedOut: true };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), remainingMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([query.then((value) => ({ timedOut: false as const, value })), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * A protected folder's real path, or undefined when the system did not give one: any query failure, the shared query
 * limit's refusal (S0-N6) included. S0-N7: a folder's written spelling is not its physical identity, so it is never
 * used in place of a failed query; a target that resolves to the folder's real location would otherwise be judged
 * against the wrong path. The caller reports `uncertain` (→ opaque).
 */
async function realPathOfProtectedDir(dir: string, realpath: (p: string) => Promise<string>): Promise<string | undefined> {
  try {
    return await realpath(dir);
  } catch {
    return undefined;
  }
}

/** Characters each grammar expands or treats specially in a bare argument (variables, globs, escapes). */
const EXPANDED_BY: Readonly<Record<ReturnType<typeof grammarOfShellKind>, RegExp>> = {
  cmd: /[%!^*?]/,
  powershell: /[$`*?[\]]/,
  posix: /[$`*?[\]{}]/,
  neutral: /[%!^$`*?[\]{}]/,
};

/** `.git` and `.unode`, compared as this host's filesystem compares names. */
function isProtectedSegmentName(segment: string): boolean {
  const name = process.platform === 'linux' ? segment : segment.toLowerCase();
  return name === '.git' || name === '.unode';
}

/**
 * What the on-disk check found for one literal delete token. `skip` counts as clear, so it means only "proven to name
 * nothing to delete": a proven argument, or a proven host path the system reports does not exist.
 */
type PhysicalTarget =
  | { kind: 'resolved'; path: string }
  | { kind: 'skip' }
  | { kind: 'uncertain' };

/**
 * S0-N8: the one rule of the on-disk check, with four outcomes and no per-spelling cases.
 *   1. A token proven to be an argument, not a target (`isProvenArgument`: only a PowerShell `-x`) → `skip`.
 *   2. A proven host path (`provenWrittenPath`) that the system resolves → `resolved`, judged protected or clear.
 *   3. A proven host path the system reports absent (ENOENT) → `skip`: it names nothing, so it is no alias.
 *   4. Anything else — a path this check cannot prove the shell will act on, or a query that fails or is refused —
 *      → `uncertain` (→ opaque). "Could not tell" is never "nothing to check".
 * fs.realpath is the system's own resolution: it reads an 8.3 short name or a `::$INDEX_ALLOCATION` stream spelling
 * as the folder it names.
 */
async function physicalDeleteTarget(
  target: string,
  cwd: string,
  shell: CommandShellIdentity,
  realpath: (p: string) => Promise<string>,
): Promise<PhysicalTarget> {
  const grammar = grammarOfShellKind(shell.kind);
  if (isProvenArgument(target, grammar)) {
    return { kind: 'skip' };
  }
  const written = provenWrittenPath(target, shell, grammar);
  if (written === undefined) {
    return { kind: 'uncertain' };
  }
  try {
    if (process.platform === 'win32') {
      return { kind: 'resolved', path: await realpath(path.resolve(cwd, written)) };
    }
    let current = path.isAbsolute(written) ? '/' : await realpath(cwd);
    for (const segment of written.split('/')) {
      if (!segment || segment === '.') continue;
      current = segment === '..' ? path.dirname(await realpath(current)) : path.join(current, segment);
    }
    return { kind: 'resolved', path: await realpath(current) };
  } catch (error) {
    // A proven path that is simply absent is no alias of a protected folder; a real query failure, or the shared
    // query limit refusing to start one (S0-N6), is uncertain.
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { kind: 'skip' } : { kind: 'uncertain' };
  }
}

/**
 * A token this check can prove names nothing to delete. Only PowerShell gives that proof: every `-x` token on a delete
 * verb is a parameter, because the scanner has already made any one outside the exact delete vocabulary opaque.
 * S0-N9: what a token means is decided by the program that receives it, not by the shell that starts it, so no other
 * shape is assumed to be an argument — a cmd `/x` is a path to `rm.exe -r /alias`, and a POSIX `-x` is a file name
 * after `--`. Such a token is resolved like any target; a switch or option that names no file is simply absent.
 */
function isProvenArgument(token: string, grammar: ReturnType<typeof grammarOfShellKind>): boolean {
  return grammar === 'powershell' && token.startsWith('-');
}

/**
 * The path to resolve for a delete target, ONLY when this check can prove it is the path the shell will act on;
 * otherwise undefined (→ uncertain). The proven forms are this closed list, so any other spelling, whatever shell
 * construct it is, is unproven by default and needs no rule of its own:
 *   - not empty, no character its grammar may expand, no leading `~`;
 *   - POSIX: not under WSL (this host cannot map its paths) and no `\`; on Windows (Git Bash) a relative path, or an
 *     absolute one with an MSYS drive mapping (`/c/...`);
 *   - cmd: anything but a drive-relative path (`D:x`), which depends on that drive's own current folder; a stream
 *     suffix is read by the system's resolution;
 *   - PowerShell: a path with no colon, or a drive-absolute one (`C:\...`) with no other colon; any other colon is a
 *     drive-relative path, a PowerShell drive (`ws:\`) or a provider path (`FileSystem::...`).
 */
function provenWrittenPath(
  target: string,
  shell: CommandShellIdentity,
  grammar: ReturnType<typeof grammarOfShellKind>,
): string | undefined {
  if (!target || target.startsWith('~') || EXPANDED_BY[grammar].test(target)) {
    return undefined;
  }
  switch (grammar) {
    case 'posix':
      if (shell.kind === 'wsl' || target.includes('\\')) {
        return undefined;
      }
      if (process.platform === 'win32' && target.startsWith('/')) {
        return shell.kind === 'bash' ? msysDrivePath(target) : undefined;
      }
      return target;
    case 'cmd':
      return /^[A-Za-z]:(?![\\/])/.test(target) ? undefined : target;
    case 'powershell':
      return target.replace(/^[A-Za-z]:(?=[\\/])/, '').includes(':') ? undefined : target;
    default:
      return undefined; // no grammar to read it under
  }
}

function isWindowsExtendedLengthPath(tok: string): boolean {
  return /^\\\\\?\\(?:[A-Za-z]:[\\/]|UNC[\\/][^\\/]+[\\/][^\\/]+[\\/])/i.test(tok);
}

function uriSchemeForDriveCandidate(scanned: string, index: number, raw: string): string | undefined {
  if (!/^[A-Za-z]:\//.test(raw)) {
    return undefined;
  }
  const colon = index + 1;
  let start = index;
  while (start > 0 && /[A-Za-z0-9+.-]/.test(scanned[start - 1])) {
    start--;
  }
  const token = scanned.slice(start, colon);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(token)) {
    return undefined;
  }
  // `-oC:/...` and `-IC:/...` are short-option-glued paths, not URI schemes.
  if (start > 0 && scanned[start - 1] === '-') {
    return undefined;
  }
  // Keep the existing Windows-path behavior for common uppercase drive spellings like `C://Users/...`,
  // while still allowing legal single-letter URI schemes such as `a://host`.
  if (token.length === 1) {
    return raw.startsWith(`${token.toLowerCase()}://`) ? token : undefined;
  }
  return token;
}

function outsideEmbeddedDrivePath(rawUriTail: string, roots: string[], pathApi: typeof path.posix | typeof path.win32): string | undefined {
  const afterSlashes = rawUriTail.indexOf('//');
  if (afterSlashes < 0) {
    return undefined;
  }
  const tail = rawUriTail.slice(afterSlashes + 2);
  const embedded = tail.match(/[A-Za-z]:[\\/][^\s"'|&;<>]*/)?.[0];
  if (!embedded) {
    return undefined;
  }
  try {
    const abs = pathApi.resolve(embedded);
    return roots.some((root) => isInside(root, abs, pathApi)) ? undefined : abs;
  } catch {
    return undefined;
  }
}

/** The approval context of one gated command: its shell, its lifecycle signal and every truthful warning. */
function approvalContext(opts: ShellCommandGateOptions, outsideWarning?: string, singleUse?: boolean): CommandApprovalContext {
  const opaqueNote = singleUse
    ? 'UnodeAi could not analyse this command, so it can only be approved for this one use.'
    : undefined;
  const warning = [outsideWarning, opaqueNote, opts.notice].filter((value): value is string => !!value).join('\n\n') || undefined;
  return {
    shell: opts.shell,
    ...(warning ? { warning } : {}),
    ...(outsideWarning || singleUse ? { forcePrompt: true } : {}),
    ...(singleUse ? { singleUse: true } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}

/** A prompt that the host closed is reported as such, never as a refusal by the user. */
function withdrawnRefusal(outsidePath: string | undefined): ShellCommandGateResult {
  return {
    ok: false,
    kind: 'approval',
    outsidePath,
    message: 'Command not run: its approval was withdrawn because the agent was stopped, restarted or removed.',
  };
}

async function gateModelCommand(
  opts: ShellCommandGateOptions,
  verdict: CommandVerdict,
  outsidePath: string | undefined,
): Promise<ShellCommandGateResult> {
  if (outsidePath && !opts.requestApproval) {
    return {
      ok: false,
      kind: 'outside-unattended',
      outsidePath,
      message: outsideRootRefusal(outsidePath, opts.roots),
    };
  }
  if ((verdict.ask || outsidePath) && opts.requestApproval) {
    const context = approvalContext(opts, outsidePath
      ? `This command names "${outsidePath}", outside the agent's writable folder(s) (${formatRoots(opts.roots)}).`
      : undefined, verdict.opaque);
    const decision = await opts.requestApproval(
      opts.command,
      context
    );
    if (!decision.allow) {
      if (decision.withdrawn) return withdrawnRefusal(outsidePath);
      const note = decision.note ? ` The user said: "${decision.note}". Adjust accordingly or ask them what to do.` : '';
      return {
        ok: false,
        kind: 'approval',
        note: decision.note,
        outsidePath,
        message: `Command blocked: not approved by the user.${note}`,
      };
    }
  } else if (!verdict.allowed) {
    return {
      ok: false,
      kind: 'policy',
      reason: verdict.reason,
      outsidePath,
      message: policyBlockMessage(verdict.reason),
    };
  }
  return { ok: true, outsidePath };
}

async function gateConfigCommand(
  opts: ShellCommandGateOptions,
  verdict: CommandVerdict,
  outsidePath: string | undefined,
): Promise<ShellCommandGateResult> {
  if (verdict.ask) {
    if (!opts.requestApproval) {
      return {
        ok: false,
        kind: 'policy',
        reason: verdict.reason,
        outsidePath,
        message: policyBlockMessage(verdict.reason),
      };
    }
    const decision = await opts.requestApproval(opts.command, approvalContext(opts, undefined, verdict.opaque));
    if (!decision.allow) {
      if (decision.withdrawn) return withdrawnRefusal(outsidePath);
      const note = decision.note ? ` The user said: "${decision.note}".` : '';
      return {
        ok: false,
        kind: 'approval',
        note: decision.note,
        outsidePath,
        message: `Command blocked: not approved by the user.${note}`,
      };
    }
  }

  if (outsidePath) {
    warnConfigOutsideRootOnce(opts.command, outsidePath, opts.onConfigOutsideRoot);
  }
  return { ok: true, outsidePath };
}

function warnConfigOutsideRootOnce(
  command: string,
  outsidePath: string,
  notify?: (message: string, outsidePath: string, command: string) => void
): void {
  if (!notify || warnedConfigOutsideRootCommands.has(command)) {
    return;
  }
  warnedConfigOutsideRootCommands.add(command);
  notify(`Your configured verify command references a path outside the workspace: "${outsidePath}".`, outsidePath, command);
}

function policyBlockMessage(reason: string | undefined): string {
  const guidance = /control character/i.test(reason ?? '')
    ? ' Run ONE simple command without `;`/`|`/`&&`/`>`. To edit a file, use the write_file tool (not shell redirection); to read one, use read_file.'
    : '';
  return `Command blocked: ${reason ?? 'not allowed'}${guidance}`;
}

function outsideRootRefusal(outsidePath: string, roots: string | string[]): string {
  return (
    `${BLOCKED_OUTSIDE_WORKDIR}: this command references "${outsidePath}", outside your writable folder(s) ` +
    `(${formatRoots(roots)}), and no one is available to approve it. Ask the user, in your reply, to ` +
    `switch your working folder to that folder or open it as the workspace, then wait.`
  );
}

function formatRoots(roots: string | string[]): string {
  return (Array.isArray(roots) ? roots : [roots]).join(', ');
}
