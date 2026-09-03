/*---------------------------------------------------------------------------------------------
 *  UnodeAi - CommandPolicy
 *  Gatekeeper for the run_command tool. Without this, an agent can run ANY shell command the
 *  model emits (LLM-driven RCE). Default posture is deny; the user opts into specific commands.
 *
 *  Layers of defense:
 *    1. mode 'none'      — run_command is disabled entirely.
 *       mode 'allowlist' — only commands whose every `&&`/`;`-separated segment matches a configured
 *                          prefix. Other shell control syntax stays disallowed so a teammate cannot
 *                          smuggle a command through a pipe, substitution, or redirect.
 *       mode 'all'       — anything goes (explicit opt-in for trusted/sandboxed setups).
 *    2. A hard denylist of catastrophic patterns is applied in EVERY mode as a final seatbelt.
 *
 *  F2: Added pure reload(mode, allowlist) so the policy can be updated at runtime without
 *       importing vscode (keeps the class testable in plain Node.js). approvalMode getter
 *       exposes the current mode for external queries. SAFE_COMMAND_PREFIXES and
 *       isApprovalNeeded live here so tests can import them without pulling in vscode.
 *  F2.3: onFirstBlock callback — one-shot hook fired the first time a command is blocked in
 *       'none' mode, so the caller can show a non-modal warning with an "Enable Commands" button.
 *--------------------------------------------------------------------------------------------*/

export type CommandApprovalMode = 'none' | 'allowlist' | 'all' | 'ask';

export interface CommandVerdict {
  allowed: boolean;
  reason?: string;
  /**
   * 'ask' mode only: the command is safe to run but not yet allowlisted — the caller should prompt the
   * user (Run once / Always allow / Deny). Already-allowlisted commands return `allowed:true` (no prompt).
   */
  ask?: boolean;
}

/** Execution-shell facts supplied by the caller; CommandPolicy is shared by different backends. */
export interface CommandCheckOptions {
  /** Windows cmd.exe cannot execute PowerShell cmdlets such as `Copy-Item`. */
  activeShell?: 'cmd';
}

/**
 * PowerShell's approved verb set. This avoids treating ordinary hyphenated executables such as
 * `git-lfs` as cmdlets while catching standard Verb-Noun PowerShell commands.
 */
const POWERSHELL_CMDLET_VERBS = new Set([
  'add', 'approve', 'assert', 'backup', 'block', 'checkpoint', 'clear', 'close', 'compare', 'complete',
  'compress', 'confirm', 'connect', 'convert', 'convertfrom', 'convertto', 'copy', 'debug', 'dismount',
  'edit', 'disable', 'disconnect', 'enable', 'enter', 'exit', 'expand', 'export', 'find', 'format', 'get',
  'grant', 'group', 'hide', 'import', 'initialize', 'install', 'invoke', 'join', 'limit', 'lock', 'measure',
  'merge', 'mount', 'move', 'new', 'optimize', 'out', 'ping', 'pop', 'protect', 'publish', 'push', 'read',
  'receive', 'register', 'remove', 'rename', 'repair', 'reset', 'resize', 'resolve', 'restart', 'restore',
  'resume', 'revoke', 'save', 'search', 'select', 'send', 'set', 'show', 'skip', 'sort', 'split', 'start',
  'step', 'stop', 'submit', 'suspend', 'sync', 'tee', 'test', 'trace', 'unblock', 'undo', 'uninstall',
  'unlock', 'unpublish', 'unregister', 'update', 'use', 'wait', 'watch', 'where', 'write', 'foreach',
]);

/**
 * Shell syntax that must never be treated as a chain of independently allowlisted commands. `&&` and
 * `;` are deliberately handled by `allowlistedCommandSegments`; everything else either changes command
 * meaning or can inject arbitrary execution.
 */
const UNSUPPORTED_SHELL_CONTROL = /[&|`\n\r]|\$\(|\$\{|>|</;

/**
 * Returns the independently executable command segments when a command uses only the two supported
 * chain separators. Empty segments (for example `npm test &&`) are rejected rather than ignored.
 *
 * This is deliberately conservative instead of attempting a shell parser: quotes or escapes containing
 * `&&`/`;` may prompt unnecessarily, but they can never cause us to auto-allow a command we misunderstood.
 */
function allowlistedCommandSegments(command: string): string[] | undefined {
  const segments = command.split(/&&|;/).map((segment) => segment.trim());
  if (segments.length === 0 || segments.some((segment) => !segment)) {
    return undefined;
  }

  // Remove only the separators this policy supports before rejecting all remaining shell syntax. A lone
  // `&`, `&&&`, pipes, substitutions, redirects, and newlines therefore remain fail-closed.
  const withoutSupportedSeparators = command.replace(/&&|;/g, '');
  return UNSUPPORTED_SHELL_CONTROL.test(withoutSupportedSeparators) ? undefined : segments;
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

/** True when a command prefix has the standard PowerShell Verb-Noun cmdlet shape. */
export function isPowerShellOnlyCmdlet(command: string): boolean {
  const prefix = CommandPolicy.commandPrefix(command);
  const match = /^([a-z][a-z0-9]*)-([a-z][a-z0-9]*)$/i.exec(prefix);
  return !!match && POWERSHELL_CMDLET_VERBS.has(match[1].toLowerCase());
}

/** Clear, reusable UX text for a cmdlet that was requested from cmd.exe. */
export function windowsCmdletCompatibilityWarning(command: string): string | undefined {
  if (!isPowerShellOnlyCmdlet(command)) {
    return undefined;
  }
  const cmdlet = CommandPolicy.commandPrefix(command);
  return `"${cmdlet}" is a PowerShell cmdlet, but agent commands run in cmd.exe — it will never succeed. Use a cmd.exe equivalent (for example copy or xcopy), or switch the agent shell.`;
}

export class CommandPolicy {
  private allowlist: string[];

  /**
   * F2.3: Optional callback invoked exactly once when the first command is blocked
   * due to 'none' mode. The caller (extension.ts) wires this to showBlockedWarning().
   */
  onFirstBlock?: () => void;

  private _blockPrompted = false;

  constructor(
    private mode: CommandApprovalMode = 'none',
    allowlist: string[] = []
  ) {
    // Normalize allowlisted prefixes for case-insensitive, whitespace-tolerant matching.
    this.allowlist = allowlist.map((p) => p.trim().toLowerCase()).filter(Boolean);
  }

  /** F2: public getter so external code can check the current mode. */
  get approvalMode(): CommandApprovalMode {
    return this.mode;
  }

  /** Normalized workspace entries. Consumers must treat this as a snapshot, never mutate it. */
  get allowedCommands(): readonly string[] {
    return [...this.allowlist];
  }

  /**
   * F2: Update the policy with new mode and allowlist at runtime.
   * Pure — the caller reads VS Code settings and passes them in, so this
   * class stays testable in plain Node.js without the vscode module.
   */
  reload(mode: CommandApprovalMode, allowlist: string[]): void {
    this.mode = mode;
    this.allowlist = (allowlist ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean);
  }

  check(rawCommand: string, options?: CommandCheckOptions): CommandVerdict {
    const command = (rawCommand ?? '').trim();
    if (!command) {
      return { allowed: false, reason: 'empty command' };
    }

    // Catastrophic patterns are blocked regardless of mode.
    for (const pattern of CATASTROPHIC) {
      if (pattern.test(command)) {
        return { allowed: false, reason: 'matches a blocked destructive pattern' };
      }
    }
    if (isDangerousRecursiveDelete(command)) {
      return { allowed: false, reason: 'matches a blocked destructive pattern' };
    }

    switch (this.mode) {
      case 'none': {
        // F2.3: fire the one-shot callback so the user sees a non-modal
        // "Enable Commands" button the first time an agent tries to run a command.
        if (this.onFirstBlock && !this._blockPrompted) {
          this._blockPrompted = true;
          this.onFirstBlock();
        }
        return {
          allowed: false,
          reason: 'command execution is disabled. The user can enable it via "unode.commandApproval".',
        };
      }

      case 'all':
        return { allowed: true };

      case 'allowlist': {
        const segments = allowlistedCommandSegments(command);
        if (!segments) {
          return {
            allowed: false,
            reason:
              'contains unsupported shell control syntax. Only nonempty && and ; chains of independently allowlisted commands are permitted.',
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
        // Ask mode: user gets the final say on any command (except catastrophic patterns, which are
        // blocked above). Don't pre-reject shell syntax — legitimate pipes, chains, etc. are fine if the
        // user approves them. (UnodeAi's P0: restore tool call reliability by unblocking PowerShell syntax.)
        const segments = allowlistedCommandSegments(command);
        const allowlist = this.compatibleAllowlist(options);
        // Every supported chain segment must be pre-approved. Unsupported syntax still falls through to
        // the human prompt in ask mode; catastrophic commands remain blocked above in every mode.
        if (segments && everySegmentIsAllowlisted(segments, allowlist)) {
          return { allowed: true };
        }
        return { allowed: false, ask: true, reason: 'awaiting user approval' };
      }
    }
  }

  /**
   * A saved allowlist is shared by all backends. Filter only for cmd.exe execution: removing a
   * PowerShell cmdlet globally would break a backend with a native PowerShell tool.
   */
  private compatibleAllowlist(options?: CommandCheckOptions): string[] {
    return options?.activeShell === 'cmd'
      ? this.allowlist.filter((prefix) => !isPowerShellOnlyCmdlet(prefix))
      : this.allowlist;
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

function isDangerousRecursiveDelete(command: string): boolean {
  const rawTokens = shellLikeTokens(command);
  // Unwrap a quoted sub-command: `cmd /c "rmdir /s /q .git"`, `powershell -Command "Remove-Item -Recurse
  // .unode"`, `bash -c "..."`. shellLikeTokens keeps a quoted span as ONE token, hiding the delete verb and
  // target from the scan below — so the newly-added rmdir/Remove-Item guard was strictly weaker than the raw
  // rm/del regexes against wrapping. Recurse into any token that still holds whitespace (i.e. was a quoted
  // multi-word span). One level covers the common cmd /c and -Command wrappers; the guard is the same, so a
  // benign quoted string can't false-positive.
  for (const raw of rawTokens) {
    const inner = cleanToken(raw);
    if (inner && /\s/.test(inner) && inner !== command.trim() && isDangerousRecursiveDelete(inner)) {
      return true;
    }
  }
  const tokens = rawTokens.map(cleanToken).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const verb = tokens[i].toLowerCase();
    if (!RECURSIVE_DELETE_COMMANDS.has(verb)) {
      continue;
    }
    const rest = tokens.slice(i + 1);
    if (!hasRecursiveOrForceDeleteFlag(verb, rest)) {
      continue;
    }
    if (rest.some(isCatastrophicDeleteTarget)) {
      return true;
    }
  }
  return false;
}

function shellLikeTokens(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function cleanToken(token: string): string {
  return token
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/[),;]+$/g, '');
}

function hasRecursiveOrForceDeleteFlag(verb: string, rest: string[]): boolean {
  const flags = rest.filter(isDeleteFlag).map((token) => token.toLowerCase());
  if (verb === 'rmdir' || verb === 'rd') {
    return flags.some((flag) => /^\/.*s/.test(flag));
  }
  if (verb === 'remove-item' || verb === 'ri') {
    // PowerShell binds -Recurse from ANY unambiguous prefix (-r, -re, -rec, -recu, -recur, -recurs,
    // -recurse), optionally with a `:value` suffix. Matching only the full flag let `Remove-Item -Rec .git`
    // wipe .git. For Remove-Item the sole "r" parameter is Recurse, so -r-through-recurse all mean recursive.
    return flags.some((flag) => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::.*)?$/.test(flag) || flag === '-force' || flag.startsWith('-force:'));
  }
  if (verb === 'del' || verb === 'erase') {
    return flags.some((flag) => /^\/.*[sfq]/.test(flag));
  }
  if (verb === 'rm') {
    return flags.some((flag) => /^-[a-z]*[rf]/i.test(flag) || flag === '--recursive' || flag === '--force');
  }
  return false;
}

function isDeleteFlag(token: string): boolean {
  return /^[-/]/.test(token);
}

function isCatastrophicDeleteTarget(token: string): boolean {
  if (token === '/' || token === '\\') {
    return true;
  }
  const normalized = token.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === '/' || normalized === '~' || normalized === '..' || normalized.startsWith('../')) {
    return true;
  }
  if (/^[a-z]:\/?$/.test(normalized)) {
    return true;
  }
  const segments = normalized.split('/').filter(Boolean);
  return segments.includes('.git') || segments.includes('.unode');
}
