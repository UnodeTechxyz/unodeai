/*---------------------------------------------------------------------------------------------
 *  UnodeAi - CommandPolicy
 *  Gatekeeper for the run_command tool. Without this, an agent can run ANY shell command the
 *  model emits. Commands now run automatically by default; explicit narrower settings are preserved.
 *
 *  Layers of defense:
 *    1. mode 'none'      — run_command is disabled entirely.
 *       mode 'allowlist' — only commands whose every segment matches an allowed prefix, where segments
 *                          are split only at the chain separators the command's own shell grammar
 *                          admits (CommandShell). Other shell control syntax stays disallowed so a
 *                          teammate cannot smuggle a command through a pipe, substitution, or redirect.
 *       mode 'all'       — ordinary commands run automatically (default).
 *    2. Recognised destructive patterns require exact single-use confirmation in EVERY mode.
 *
 *  F2: Added pure reload(mode, allowlist) so the policy can be updated at runtime without
 *       importing vscode (keeps the class testable in plain Node.js). approvalMode getter
 *       exposes the current mode for external queries. SAFE_COMMAND_PREFIXES and
 *       isApprovalNeeded live here so tests can import them without pulling in vscode.
 *  F2.3: onFirstBlock callback — one-shot hook fired the first time a command is blocked in
 *       'none' mode, so the caller can show a non-modal warning with an "Enable Commands" button.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import {
  autoAllowSegments,
  type CommandApprovalKey,
  type CommandShellGrammar,
  type CommandShellIdentity,
  describeShell,
  isPersistedCommandShellGrammar,
  PERSISTED_COMMAND_SHELL_GRAMMARS,
  type PersistedCommandShellGrammar,
  templateRunsUnder,
} from './CommandShell';

export { isPowerShellOnlyCmdlet } from './CommandShell';

export type CommandApprovalMode = 'none' | 'allowlist' | 'all' | 'ask';

export interface CommandVerdict {
  allowed: boolean;
  reason?: string;
  /**
   * 'ask' mode only: the command is safe to run but not yet allowlisted — the caller should prompt the
   * user (Run once / Always allow / Deny). Already-allowlisted commands return `allowed:true` (no prompt).
   */
  ask?: boolean;
  /**
   * The bounded scanner could not read this command under its own contract (a wrapper or inline script, an
   * escape or expansion, an unidentified shell, over budget): it is `opaque`, NOT judged safe. Opaque never
   * matches an allowlist, is never remembered, and in 'ask' is a single-use prompt for the whole command. In
   * 'all' it runs, labelled not analysed. The physical delete check also raises this when a target's real
   * path cannot be proven. It is advisory for the caller's wording and its single-use/no-persist handling.
   */
  opaque?: boolean;
  /** Recognised destructive command: an exact, single-use human confirmation in every mode. */
  dangerous?: boolean;
  /** Explicit Commands Off. Kept through narrowing so callers can show each refusal. */
  disabled?: boolean;
}

/**
 * The shell the command will be interpreted by, captured once per invocation. Required: the policy never
 * infers a grammar from the host platform, so a command is always checked under the grammar that runs it.
 */
export interface CommandCheckOptions {
  readonly shell: CommandShellIdentity;
}

/** The two sources of silent permission, kept apart because only the second is bound to a grammar. */
export interface CommandPolicyInputs {
  /** User setting; intentionally applicable to compatible recognized grammars. */
  readonly configured: readonly string[];
  /** Human grants; exact grammar match required. */
  readonly project: readonly CommandApprovalKey[];
}

function normalizeTemplates(entries: readonly string[] | undefined): string[] {
  return [...new Set((entries ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

function normalizeKeys(keys: readonly CommandApprovalKey[] | undefined): CommandApprovalKey[] {
  const seen = new Set<string>();
  const out: CommandApprovalKey[] = [];
  for (const key of keys ?? []) {
    const template = typeof key?.template === 'string' ? key.template.trim().toLowerCase() : '';
    if (!template || !isPersistedCommandShellGrammar(key.grammar)) continue;
    const id = `${key.grammar}\0${template}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ grammar: key.grammar, template });
  }
  return out;
}

/** A bare list is the user's configuration, never a grammar-bound human grant. */
function policyInputs(inputs: CommandPolicyInputs | readonly string[] | undefined): { configured: string[]; project: CommandApprovalKey[] } {
  if (inputs === undefined || Array.isArray(inputs)) {
    return { configured: normalizeTemplates(inputs as readonly string[] | undefined), project: [] };
  }
  const structured = inputs as CommandPolicyInputs;
  return { configured: normalizeTemplates(structured.configured), project: normalizeKeys(structured.project) };
}

function admittedChainsText(shell: CommandShellIdentity): string {
  switch (shell.grammar) {
    case 'cmd': return 'nonempty && chains';
    case 'powershell': return shell.kind === 'pwsh' ? 'nonempty ; and && chains' : 'nonempty ; chains';
    case 'posix': return 'nonempty && and ; chains';
    case 'neutral': return 'single commands with literal arguments';
  }
}

function everySegmentIsAllowlisted(segments: readonly string[], allowlist: readonly string[]): boolean {
  return segments.every((segment) => {
    const lower = segment.toLowerCase();
    return allowlist.some((prefix) => lower === prefix || lower.startsWith(prefix + ' '));
  });
}

/** Catastrophic patterns blocked in every mode (defense in depth, not the primary control). */
const CATASTROPHIC: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, // rm -rf / -fr (any flag order)
  /\brm\s+-[rf]\w*\s+(\/|~|\.\.)(\s|$)/i,           // rm -r/-f targeting /, ~, ..
  /\bmkfs\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/,                // fork bomb :(){ :|:& };:
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bsudo\b/i,
  /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh|powershell|pwsh|cmd)\b/i, // pipe-to-shell
  /\bformat\s+[a-z]:/i,                              // Windows format C:
  /\bdel\s+\/[sfq]/i,                                // Windows recursive/forced delete
  />\s*\/dev\/(sd|nvme|disk)/i,
];

const RECURSIVE_DELETE_COMMANDS = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri']);

/**
 * Safe command TEMPLATES for guided enablement. Deliberately narrow: read-only / build / test only.
 * NOT bare tool names — `git`, `node`, `python` as prefixes would silently allow `git reset --hard`,
 * `node evil.js`, `python evil.py`. We seed two-token templates so destructive siblings still hit the
 * 'ask' prompt. Anything not listed here prompts the user (Run once / Always allow / Deny).
 */
// SINGLE SOURCE OF TRUTH for the reviewed safe-command list. It is activated only by an explicit user
// action (the approval-card offer or "Enable Safe Commands" command), never as a new-install default.
// Read-only / verify / lint / build only: never bare tools ('git'/'node'/'npm' would allow destructive or
// arbitrary-code siblings), and never prefix footguns like 'git branch' (matches 'git branch -D x').
export const SAFE_COMMAND_TEMPLATES = [
  // read-only git inspection
  'git status',
  'git diff',
  'git log',
  'git show',
  'git ls-files',
  // process/environment inspection with no write or arbitrary-code capability
  'echo',
  'hostname',
  'whoami',
  // read-only npm inspection
  'npm ls',
  'npm audit',
  // verify / build / typecheck / lint — EXPLICIT scripts only. NOT bare 'npm run' (runs any project
  // script) and NOT install/ci (lifecycle scripts execute arbitrary code) — those go to 'ask'.
  'npm test',
  'npm run test',
  'npm run build',
  'npm run compile',
  'npm run lint',
  'npm run typecheck',
  'pnpm test',
  'yarn test',
  'npx tsc',
  'npx eslint',
  'npx prettier',
  'npx vitest',
  'tsc',
  'eslint',
  'prettier',
  // other ecosystems' non-destructive verify
  'pytest',
  'go test',
  'go vet',
  'go build',
  'cargo test',
  'cargo check',
  'cargo build',
];

/** @deprecated kept as an alias for back-compat; prefer SAFE_COMMAND_TEMPLATES. */
export const SAFE_COMMAND_PREFIXES = SAFE_COMMAND_TEMPLATES;

/** F2: Pure predicate — true when the user should be prompted to enable commands. */
export function isApprovalNeeded(mode: CommandApprovalMode): boolean {
  return mode === 'none';
}

/** A project-local opt-in can only lift the user default from disabled to ask; never to allow/all. */
export function effectiveCommandApprovalMode(
  userMode: CommandApprovalMode,
  projectExecutionEnabled: boolean,
): CommandApprovalMode {
  return userMode === 'none' && projectExecutionEnabled ? 'ask' : userMode;
}

export class CommandPolicy {
  private configured: string[];
  private project: CommandApprovalKey[];

  /**
   * F2.3: Optional callback invoked exactly once when the first command is blocked
   * due to 'none' mode. The caller (extension.ts) wires this to showBlockedWarning().
   */
  onFirstBlock?: () => void;

  private _blockPrompted = false;

  constructor(
    private mode: CommandApprovalMode = 'all',
    inputs: CommandPolicyInputs | readonly string[] = []
  ) {
    // Normalize allowlisted prefixes for case-insensitive, whitespace-tolerant matching.
    ({ configured: this.configured, project: this.project } = policyInputs(inputs));
  }

  /** F2: public getter so external code can check the current mode. */
  get approvalMode(): CommandApprovalMode {
    return this.mode;
  }

  /**
   * The user's configured templates only. A project grant is bound to a grammar and is never part of this
   * list, so an Agent Builder ceiling cannot be mistaken for, or built from, a project grant.
   */
  get allowedCommands(): readonly string[] {
    return [...this.configured];
  }

  /** The grammar-bound human grants. Consumers must treat this as a snapshot, never mutate it. */
  get projectApprovals(): readonly CommandApprovalKey[] {
    return this.project.map((key) => ({ ...key }));
  }

  /**
   * F2: Update the policy with new mode and allowlist at runtime.
   * Pure — the caller reads VS Code settings and passes them in, so this
   * class stays testable in plain Node.js without the vscode module.
   */
  reload(mode: CommandApprovalMode, inputs: CommandPolicyInputs | readonly string[]): void {
    this.mode = mode;
    ({ configured: this.configured, project: this.project } = policyInputs(inputs));
  }

  check(rawCommand: string, options: CommandCheckOptions): CommandVerdict {
    const command = (rawCommand ?? '').trim();
    if (!command) {
      return { allowed: false, reason: 'empty command' };
    }

    // The bounded scanner classifies the command under the grammar that will run it: a recognised dangerous
    // delete (blocked, dominant in every mode), a simple literal command the scanner can read (supported), or
    // something it will not decode (opaque). It is the fact; the mode below is the authorisation.
    const inspection = inspectCommand(command, options.shell);
    if (this.mode === 'none') {
      // F2.3: fire the one-shot callback so the user sees a non-modal
      // "Enable Commands" button the first time an agent tries to run a command.
      if (this.onFirstBlock && !this._blockPrompted) {
        this._blockPrompted = true;
        this.onFirstBlock();
      }
      return {
        allowed: false,
        disabled: true,
        reason: 'command execution is disabled. The user can enable it via "unode.commandApproval".',
      };
    }

    if (inspection.kind === 'blocked') {
      return { allowed: false, ask: true, dangerous: true, reason: DESTRUCTIVE_PATTERN_REASON };
    }

    if (inspection.kind === 'opaque') {
      return this.opaqueVerdict(inspection.reason, options);
    }

    switch (this.mode) {
      case 'all':
        return { allowed: true };

      case 'allowlist': {
        const segments = autoAllowSegments(command, options.shell);
        if (!segments) {
          return {
            allowed: false,
            reason:
              `contains unsupported shell control syntax for ${describeShell(options.shell)}. Only ${admittedChainsText(options.shell)} of independently allowlisted commands are permitted.`,
          };
        }
        const allowlist = this.compatibleAllowlist(options);
        const ok = everySegmentIsAllowlisted(segments, allowlist);
        return ok
          ? { allowed: true }
          : {
              allowed: false,
              reason: `not in the allowlist. Every command segment must match an allowed prefix: ${allowlist.join(', ') || '(none configured)'}.`,
            };
      }

      case 'ask': {
        // Ask mode on a supported command: silent only when every segment is already allowlisted; otherwise a
        // normal, persistable prompt. (An opaque command never reaches here — it returned a single-use prompt
        // above; catastrophic commands are blocked above in every mode.)
        const segments = autoAllowSegments(command, options.shell);
        const allowlist = this.compatibleAllowlist(options);
        if (segments && everySegmentIsAllowlisted(segments, allowlist)) {
          return { allowed: true };
        }
        return { allowed: false, ask: true, reason: 'awaiting user approval' };
      }
    }
  }

  /**
   * How an opaque command (one the bounded scanner will not decode) is authorised under each mode. It is never
   * allowlisted, never remembered: 'allowlist' and 'none' refuse it, 'ask' forces a single-use prompt for the
   * whole command (no session/project grant), and 'all' runs it but marks it not analysed, never safe. The gate
   * also calls this when a supported command's physical delete target cannot be proven.
   */
  opaqueVerdict(reason: string, _options: CommandCheckOptions): CommandVerdict {
    switch (this.mode) {
      case 'none':
        return { allowed: false, disabled: true, opaque: true, reason: 'command execution is disabled. The user can enable it via "unode.commandApproval".' };
      case 'all':
        return { allowed: true, opaque: true };
      case 'allowlist':
        return {
          allowed: false,
          opaque: true,
          reason: `cannot be checked silently (${reason}); the allowlist mode only runs commands it can read segment by segment.`,
        };
      case 'ask':
        return { allowed: false, ask: true, opaque: true, reason: 'awaiting user approval' };
    }
  }

  /**
   * What may match silently under this command's shell: the configured templates that grammar can run,
   * plus the human grants given under exactly this grammar. An unverified (`neutral`) shell gets no grant.
   */
  private compatibleAllowlist(options: CommandCheckOptions): string[] {
    return this.allowlistFor(options.shell.grammar);
  }

  /**
   * The templates a command in one grammar may match without a prompt: the configured templates that grammar can
   * run, and the project approvals given in exactly that grammar. A per-agent narrowing is a ceiling over this set.
   */
  allowlistFor(grammar: CommandShellGrammar): string[] {
    const configured = this.configured.filter((template) => templateRunsUnder(template, grammar));
    const granted = this.project
      .filter((key) => key.grammar === grammar && templateRunsUnder(key.template, grammar))
      .map((key) => key.template);
    return [...new Set([...configured, ...granted])];
  }

  /**
   * Every template a per-agent narrowing may select, with the persisted grammars it is allowed in: the configured
   * templates first, then the project approvals, each once.
   */
  narrowingTemplates(): Array<{ template: string; grammars: PersistedCommandShellGrammar[] }> {
    const byTemplate = new Map<string, PersistedCommandShellGrammar[]>();
    const ordered = [...this.configured, ...this.project.map((key) => key.template)];
    for (const template of ordered) {
      if (byTemplate.has(template)) continue;
      const grammars = PERSISTED_COMMAND_SHELL_GRAMMARS.filter((grammar) => this.allowlistFor(grammar).includes(template));
      if (grammars.length > 0) byTemplate.set(template, grammars);
    }
    return [...byTemplate].map(([template, grammars]) => ({ template, grammars }));
  }

  /** First whitespace-delimited token of a command, lowercased. */
  static commandPrefix(command: string): string {
    return (command ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  }

  /**
   * Tools whose first argument is a sub-verb: we whitelist TWO tokens (e.g. "git status") so that
   * approving one subcommand does not silently allow a dangerous sibling ("git reset --hard").
   */
  private static readonly MULTI_VERB = new Set([
    'git', 'npm', 'npx', 'pnpm', 'yarn', 'cargo', 'go', 'dotnet', 'make',
    'docker', 'kubectl', 'pip', 'pip3', 'python', 'python3', 'node', 'deno', 'bun',
  ]);

  /** Package managers where `<pm> run <script>` indirects through an arbitrary script name. */
  private static readonly RUN_SCRIPT_PM = new Set(['npm', 'pnpm', 'yarn', 'bun']);

  /**
   * The command template we whitelist on "Always allow": two tokens for multi-verb tools
   * ("git status", "node server.js"), one token otherwise. Narrower than the bare first token, so
   * "Always allow git status" never green-lights "git reset --hard".
   *
   * Special case `<pm> run <script>`: keep THREE tokens ("npm run build", not "npm run") — otherwise
   * approving one script would silently green-light every other `npm run <anything>` (e.g. deploy).
   */
  static commandTemplate(command: string): string {
    const tokens = (command ?? '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return '';
    }
    const first = tokens[0].toLowerCase();
    if (CommandPolicy.MULTI_VERB.has(first) && tokens[1]) {
      const second = tokens[1].toLowerCase();
      if (CommandPolicy.RUN_SCRIPT_PM.has(first) && second === 'run' && tokens[2]) {
        return `${first} run ${tokens[2].toLowerCase()}`;
      }
      return `${first} ${second}`;
    }
    return first;
  }
}

/** The reason every mode gives for a command the catastrophic guard blocks. */
export const DESTRUCTIVE_PATTERN_REASON = 'matches a blocked destructive pattern';

/** The short reason an opaque result carries, for the caller's wording. */
export const OPAQUE_REASONS = {
  unidentifiedShell: 'the shell is not identified',
  envelope: 'the command is not a simple literal command the guard can read',
  wrapper: 'it runs another shell, script or inline program the guard does not read',
  uncertainTarget: "a delete target's real path could not be confirmed",
  unsupportedDeleteParam: 'a recognised delete command carries a parameter the guard does not read exactly',
  expandableTarget: 'a delete target holds a wildcard or a home-folder shorthand the guard does not expand',
} as const;

/**
 * The fact the bounded scanner reports about a command, kept apart from the authorisation the mode decides:
 *   - `blocked`   — a recognised dangerous delete (a catastrophic text pattern, or a literal delete of the working
 *                   folder, an ancestor, a drive/home root, or a `.git`/`.unode` segment). Dominant in every mode.
 *   - `supported` — a simple literal command (a chain of the grammar's admitted separators, literal words, whole-word
 *                   quotes only) the scanner read under its contract. NOT a claim it is safe.
 *   - `opaque`    — the scanner will not decode it (a wrapper/inline script, an escape or expansion, an unidentified
 *                   shell, or over budget). Never allowlisted, never remembered.
 * This is not a shell interpreter: it accepts a narrow literal grammar and refuses everything else to opaque.
 */
export type CommandInspection =
  | { kind: 'blocked'; reason: string }
  | { kind: 'supported'; segments: string[][] }
  | { kind: 'opaque'; reason: string };

type LexGrammar = 'cmd' | 'powershell' | 'posix';

/** First-version analysis budget (UTF-16 units, segments, words per segment). Beyond any of these: opaque. */
const ENVELOPE_LIMITS = { length: 16384, segments: 32, wordsPerSegment: 256 } as const;

/**
 * Verbs whose job is to run another command or script, so what follows is a second command this scanner does not
 * read. A segment led by one is opaque (never recursed into). A fixed recognition list, not a claim to cover every
 * interpreter, alias or function.
 */
const SHELL_WRAPPER_VERBS = new Set([
  'cmd', 'command', 'powershell', 'pwsh', 'bash', 'sh', 'dash', 'zsh', 'ksh', 'wsl', 'busybox',
  'env', 'xargs', 'nohup', 'sudo', 'doas', 'eval', 'exec', 'start', 'call', 'source',
]);

/** Interpreters that run inline source when an eval/command flag follows (`node -e`, `python -c`, `-Command`). */
const EVAL_INTERPRETER_VERBS = new Set([
  'node', 'deno', 'bun', 'ts-node', 'tsx', 'python', 'python3', 'py', 'perl', 'ruby', 'php',
]);
const EVAL_FLAGS = new Set(['-e', '-c', '-p', '--eval', '--exec', '--print', '--check', '-command', '-encodedcommand', '-file']);

/** A verb that names a shell script runs arbitrary shell, so it is opaque. */
const SCRIPT_VERB_EXT = /\.(sh|bash|zsh|ksh|ps1|psm1|bat|cmd)$/i;

/** Characters that need shell interpretation (expansion, redirect, group, glob, escape) outside a quote: opaque. */
const REJECT_OUTSIDE_QUOTE: Readonly<Record<LexGrammar, RegExp>> = {
  cmd: /[%^!<>(){}*?[\]`]/,
  powershell: /[$`@<>(){}*?[\]]/,
  posix: /[$\\`!<>(){}*?[\]]/,
};

/**
 * Classify a command under the shell that will run it. A catastrophic text pattern is blocked first and dominates
 * every mode. An unidentified shell, or anything outside the literal envelope, is opaque. Within the envelope a
 * recognised literal delete of a protected or unrecoverable target is blocked; everything else is supported.
 */
export function inspectCommand(command: string, shell?: Pick<CommandShellIdentity, 'kind' | 'grammar'>): CommandInspection {
  const text = (command ?? '').trim();
  if (!text) {
    return { kind: 'opaque', reason: 'empty command' };
  }
  if (CATASTROPHIC.some((pattern) => pattern.test(text))) {
    return { kind: 'blocked', reason: DESTRUCTIVE_PATTERN_REASON };
  }
  const grammar = lexGrammarOf(shell);
  if (!grammar) {
    return { kind: 'opaque', reason: OPAQUE_REASONS.unidentifiedShell };
  }
  // Windows PowerShell has no `&&`; pwsh and POSIX and cmd admit it. `;` is admitted by every grammar but cmd.
  const allowDoubleAmp = grammar !== 'powershell' || shell?.kind === 'pwsh';
  const segments = boundedScan(text, grammar, allowDoubleAmp);
  if (!segments) {
    return { kind: 'opaque', reason: OPAQUE_REASONS.envelope };
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      return { kind: 'opaque', reason: OPAQUE_REASONS.envelope };
    }
    if (isWrapperSegment(segment)) {
      return { kind: 'opaque', reason: OPAQUE_REASONS.wrapper };
    }
  }
  const targets = segments.flatMap((segment) => deleteTargetsOfSegment(segment, grammar));
  if (targets.some(isCatastrophicDeleteTarget)) {
    return { kind: 'blocked', reason: DESTRUCTIVE_PATTERN_REASON };
  }
  // S0-N4: PowerShell binds an ABBREVIATED parameter (`-Fo`→`-Force`, `-Rec`→`-Recurse`) to a real one, so a
  // recognised delete verb carrying a `-` token the guard does not read EXACTLY must not be decoded into a `supported`
  // command on a partial reading — it is opaque, a finite vocabulary and not prefix matching. It comes after the
  // dangerous-target check, so an exact recursive delete of a protected target stays blocked whatever else it carries.
  // Only PowerShell abbreviates parameters this way; cmd `/switches` and POSIX short flags keep their own branches.
  if (grammar === 'powershell' && segments.some(hasUnsupportedDeleteParam)) {
    return { kind: 'opaque', reason: OPAQUE_REASONS.unsupportedDeleteParam };
  }
  // A recursive or forced delete target that may still be expanded names files the guard cannot list: a wildcard
  // (PowerShell's -Path and cmd's erase/del match `*` and `?` themselves, inside quotes too, so `"*"` is every item in
  // the folder) or a leading `~` (the home folder). It is opaque, not read as one literal target. A recognised
  // dangerous target in the same command is still blocked above.
  if (targets.some(isExpandableDeleteTarget)) {
    return { kind: 'opaque', reason: OPAQUE_REASONS.expandableTarget };
  }
  return { kind: 'supported', segments };
}

/** A delete target the delete tool or the shell may expand: a wildcard character anywhere, or a leading `~`. */
function isExpandableDeleteTarget(token: string): boolean {
  return /[*?[\]]/.test(token) || token.startsWith('~');
}

/** The grammar the scanner reads, or undefined for an unidentified shell (always opaque). */
function lexGrammarOf(shell?: Pick<CommandShellIdentity, 'grammar'>): LexGrammar | undefined {
  const grammar = shell?.grammar;
  return grammar === 'cmd' || grammar === 'powershell' || grammar === 'posix' ? grammar : undefined;
}

/** True when `blocked`: the dangerous-delete floor that applies in every mode, read under the running shell. */
export function isCatastrophicCommand(command: string, shell?: Pick<CommandShellIdentity, 'kind' | 'grammar'>): boolean {
  return inspectCommand(command, shell).kind === 'blocked';
}

/**
 * The literal targets of every recursive or forced delete in a SUPPORTED command, for the gate's physical check.
 * Empty for a blocked or opaque command (a blocked one is already refused; an opaque one is not read). Each is the
 * word as the scanner read it, with a PowerShell colon-bound value and comma-list items also returned.
 */
export function supportedDeleteTargets(command: string, shell?: Pick<CommandShellIdentity, 'kind' | 'grammar'>): string[] {
  const inspection = inspectCommand(command, shell);
  const grammar = lexGrammarOf(shell);
  if (inspection.kind !== 'supported' || !grammar) {
    return [];
  }
  return inspection.segments.flatMap((segment) => deleteTargetsOfSegment(segment, grammar));
}

/**
 * The verdict when no CommandPolicy is injected (a missing mode is NOT `all`): a blocked command is refused, an
 * opaque command is refused (it has no explicit execution authority and is never run silently), and a supported
 * command keeps the caller's own existing contract (it may run).
 */
export function noPolicyVerdict(command: string, shell?: Pick<CommandShellIdentity, 'kind' | 'grammar'>): CommandVerdict {
  const inspection = inspectCommand(command, shell);
  if (inspection.kind === 'blocked') {
    return { allowed: false, ask: true, dangerous: true, reason: DESTRUCTIVE_PATTERN_REASON };
  }
  if (inspection.kind === 'opaque') {
    return { allowed: false, opaque: true, reason: `cannot be checked silently (${inspection.reason}); it is not run without an explicit command-execution mode.` };
  }
  return { allowed: true };
}

/**
 * Split a command into its segments of literal words, or undefined (opaque) when anything outside the envelope
 * appears: an unadmitted separator, a pipe/redirect/group, an expansion or escape character outside a quote, a
 * quote that is not a whole word, an unpaired quote, a newline, or a budget overrun. One linear pass, no decoding.
 */
function boundedScan(command: string, grammar: LexGrammar, allowDoubleAmp: boolean): string[][] | undefined {
  if (command.length > ENVELOPE_LIMITS.length) {
    return undefined;
  }
  const reject = REJECT_OUTSIDE_QUOTE[grammar];
  const singleQuoteOpens = grammar !== 'cmd'; // cmd reads a single quote as an ordinary character
  const escapeInsideDouble = grammar === 'posix' ? '\\' : grammar === 'powershell' ? '`' : undefined;
  const segments: string[][] = [[]];
  let word = '';
  let inWord = false;
  const endWord = (): boolean => {
    if (inWord) {
      const segment = segments[segments.length - 1];
      if (segment.length >= ENVELOPE_LIMITS.wordsPerSegment) return false;
      segment.push(word);
    }
    word = '';
    inWord = false;
    return true;
  };
  const newSegment = (): boolean => {
    if (!endWord()) return false;
    if (segments[segments.length - 1].length === 0) return false; // an empty segment (e.g. a leading/doubled separator)
    if (segments.length >= ENVELOPE_LIMITS.segments) return false;
    segments.push([]);
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === ' ' || ch === '\t') {
      if (!endWord()) return undefined;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      return undefined; // a newline or a line continuation is outside the envelope
    }
    if (command.startsWith('&&', i)) {
      if (!allowDoubleAmp || !newSegment()) return undefined;
      i += 1;
      continue;
    }
    if (ch === ';' && grammar !== 'cmd') {
      if (!newSegment()) return undefined;
      continue;
    }
    if (ch === '&' || ch === '|' || ch === ';') {
      return undefined; // `||`, a lone `&` or `|`, or `;` in cmd: an unadmitted or piping construct
    }
    if (ch === '"' || (singleQuoteOpens && ch === "'")) {
      if (inWord) return undefined; // a quote in the middle of a word is concatenation we do not read
      let j = i + 1;
      let span = '';
      let closed = false;
      for (; j < command.length; j++) {
        const c = command[j];
        if (c === ch) { closed = true; break; }
        if (c === '\n' || c === '\r') return undefined;
        if (ch === '"' && escapeInsideDouble && c === escapeInsideDouble) return undefined; // needs escape decoding
        if (ch === '"' && c === '$' && grammar !== 'cmd') return undefined; // interpolation
        if (ch === '"' && grammar === 'cmd' && (c === '^' || c === '%')) return undefined;
        span += c;
      }
      if (!closed) return undefined; // an unpaired quote
      const after = command[j + 1];
      if (after !== undefined && !/[\s&|;]/.test(after)) {
        return undefined; // text follows the closing quote: concatenation
      }
      word += span;
      inWord = true;
      i = j;
      continue;
    }
    if (reject.test(ch)) {
      return undefined;
    }
    word += ch;
    inWord = true;
  }
  if (!endWord()) return undefined;
  if (segments[segments.length - 1].length === 0) return undefined; // a trailing separator leaves an empty segment
  return segments;
}

/** A segment that runs another shell, an inline script, or a script file: opaque, never recursed into. */
function isWrapperSegment(tokens: string[]): boolean {
  const verb = deleteVerb(tokens[0]);
  if (SHELL_WRAPPER_VERBS.has(verb)) return true;
  if (SCRIPT_VERB_EXT.test(tokens[0])) return true;
  if (EVAL_INTERPRETER_VERBS.has(verb) && tokens.slice(1).some((token) => EVAL_FLAGS.has(token.toLowerCase()))) return true;
  return false;
}

/**
 * The ONLY PowerShell parameters on a delete verb the guard reads exactly (each with an optional `:value`). A
 * recognised destructive verb carrying any OTHER token that starts with `-` — an abbreviation (`-Fo`, `-Rec`), an
 * unlisted switch (`-WhatIf`), a single letter other than `-r`, `--`, or a negative number — is opaque, never guessed
 * (S0-N4). This is a finite vocabulary, not prefix matching. It also makes every `-` token that reaches the on-disk
 * check a known parameter, so that check can treat it as one (S0-N8). cmd `/switches` and POSIX flags have their own
 * branches.
 */
const UNDERSTOOD_PS_DELETE_PARAMS = new Set(['-recurse', '-force', '-path', '-literalpath', '-r']);

/**
 * Under PowerShell, true when a recognised destructive verb in this segment carries a `-` token the guard does not
 * read exactly. Such a command fails closed to opaque rather than being read on a partial understanding of its
 * parameters (S0-N4). Applied only under the PowerShell grammar, where prefix-abbreviation binding exists.
 */
function hasUnsupportedDeleteParam(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (!RECURSIVE_DELETE_COMMANDS.has(deleteVerb(tokens[i]))) {
      continue;
    }
    for (const token of tokens.slice(i + 1)) {
      if (!token.startsWith('-')) {
        continue; // a positional target
      }
      const base = token.toLowerCase().split(':', 1)[0];
      if (!UNDERSTOOD_PS_DELETE_PARAMS.has(base)) {
        return true;
      }
    }
  }
  return false;
}

/** The literal recursive/forced-delete targets named in one segment. */
function deleteTargetsOfSegment(tokens: string[], _grammar: LexGrammar): string[] {
  const targets: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const verb = deleteVerb(tokens[i]);
    if (!RECURSIVE_DELETE_COMMANDS.has(verb)) {
      continue;
    }
    const rest = tokens.slice(i + 1);
    if (hasRecursiveOrForceDeleteFlag(verb, rest)) {
      targets.push(...rest.flatMap(deleteOperands));
    }
  }
  return targets;
}

/** A verb as its file name: `/bin/rm` and `rm.exe` are `rm`. */
function deleteVerb(token: string): string {
  return token.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
}

/**
 * One operand as written, and the paths PowerShell would also read in it: a parameter's value bound with a colon
 * (`-Path:..`, `-LiteralPath:.git`) and each item of a comma list (`build,..`).
 */
function deleteOperands(token: string): string[] {
  const bound = /^-[a-z]+:(.+)$/i.exec(token)?.[1];
  const value = bound ?? token;
  const items = value.split(',').filter(Boolean);
  return [...new Set([token, value, ...items])];
}

function hasRecursiveOrForceDeleteFlag(verb: string, rest: string[]): boolean {
  const flags = rest.filter(isDeleteFlag).map((token) => token.toLowerCase());
  // In PowerShell, rm, rmdir, rd, del and erase are all aliases of Remove-Item and take its parameters, so
  // `rmdir .. -Recurse` is as recursive there as `rmdir /s ..` is in cmd. Every verb also reads the
  // PowerShell form; in cmd such a flag is not valid syntax, so reading it there refuses nothing real.
  if (flags.some(isPowerShellRecurseOrForce)) {
    return true;
  }
  if (verb === 'rmdir' || verb === 'rd') {
    return flags.some((flag) => /^\/.*s/.test(flag));
  }
  if (verb === 'del' || verb === 'erase') {
    return flags.some((flag) => /^\/.*[sfq]/.test(flag));
  }
  if (verb === 'rm') {
    return flags.some((flag) => /^-[a-z]*[rf]/i.test(flag) || flag === '--recursive' || flag === '--force');
  }
  return false;
}

// The EXACT recursive/forced-delete directives the guard reads, each with an optional `:value` suffix: the full
// -Recurse and the single-letter -r (for Remove-Item the sole "r" parameter is Recurse) mean recursive; the full
// -Force means forced. An ABBREVIATION (-re, -rec, -fo, -for, -forc) is not read here: inspectCommand has already
// made any PowerShell command with such a parameter opaque (finite vocabulary, not prefix matching — S0-N4). cmd
// `/s` and POSIX combined short flags are handled by the branches below.
function isPowerShellRecurseOrForce(flag: string): boolean {
  const base = flag.toLowerCase().split(':', 1)[0];
  return base === '-r' || base === '-recurse' || base === '-force';
}

function isDeleteFlag(token: string): boolean {
  return /^[-/]/.test(token);
}

/**
 * A delete target the guard refuses as written: the working folder (`.`, `sub/..`), a folder above it, a
 * filesystem or home root, or a path through `.git` or `.unode`. The written segments are judged before
 * normalising, because normalising hides `.git/..`; the normalised path is judged for where the target lands.
 * Both separators are read as separators, which can only refuse more: a POSIX name holding a backslash is a
 * rare false positive, never a bypass.
 */
function isCatastrophicDeleteTarget(token: string): boolean {
  const slashed = token.replace(/\\/g, '/').toLowerCase();
  if (!slashed) {
    return false;
  }
  if (slashed.replace(/^[a-z]:/, '').split('/').some(isProtectedDeleteSegment)) {
    return true;
  }
  const normalized = path.posix.normalize(slashed).replace(/\/+$/g, '') || '/';
  return normalized === '/'
    || normalized === '~'
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || /^[a-z]:$/.test(normalized);
}

/**
 * A segment Windows reads as `.git` or `.unode`. A stream suffix (`.git::$INDEX_ALLOCATION`) names the folder
 * itself, and cmd and PowerShell drop trailing dots and spaces (`.git.`, `.git `), so all of them are that folder.
 */
function isProtectedDeleteSegment(segment: string): boolean {
  const name = segment.split(':')[0].replace(/[. ]+$/g, '');
  return name === '.git' || name === '.unode';
}
