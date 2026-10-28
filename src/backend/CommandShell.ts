/*---------------------------------------------------------------------------------------------
 *  UnodeAi - CommandShell (v0.9.96)
 *  One typed shell identity per command invocation. Normalization, command policy, the approval card and
 *  the executor read the same identity, so a command is checked under the grammar that will run it.
 *
 *  The dialect adapters below are deliberately conservative. They admit a small set of chain separators
 *  for silent allowlist matching and refuse a few constructs that can never run in the identified shell.
 *  None of them is a shell parser: anything they do not understand is left to the human (ask mode) or
 *  refused (allowlist mode). vscode-free.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';

export type CommandShellGrammar = 'cmd' | 'powershell' | 'posix' | 'neutral';
export type PersistedCommandShellGrammar = Exclude<CommandShellGrammar, 'neutral'>;

/** Every grammar a human grant may be stored under. `neutral` is policy-only and never persisted. */
export const PERSISTED_COMMAND_SHELL_GRAMMARS: readonly PersistedCommandShellGrammar[] = ['cmd', 'powershell', 'posix'];

export type CommandShellKind =
  | 'cmd'
  | 'windows-powershell'
  | 'pwsh'
  | 'bash'
  | 'zsh'
  | 'sh'
  | 'dash'
  | 'ksh'
  | 'wsl'
  | 'provider-unknown';

/**
 * `terminal-profile`: named from the terminal settings before the agent terminal exists; the terminal's own probe
 * must then prove the same kind before anything runs in it.
 */
export type CommandShellSource = 'terminal-probe' | 'terminal-profile' | 'direct-fallback' | 'native-provider-tool' | 'native-provider-command';

export interface CommandShellIdentity {
  readonly kind: CommandShellKind;
  readonly grammar: CommandShellGrammar;
  readonly label: string;
  readonly source: CommandShellSource;
  /** Bounded host fact proving that a prepared execution still has the same shell. Never persisted or exported. */
  readonly fingerprint: string;
}

export interface UnsupportedCommandShell {
  readonly label: string;
  readonly reason: 'unknown-profile' | 'unsupported-profile' | 'identity-changed';
}

/** Host-private execution data. Only `identity.label` may enter approval or tool output. */
export interface DirectCommandShell {
  readonly identity: CommandShellIdentity;
  readonly executable: string;
}

/** A human grant is bound to the grammar it was given under, never to the template alone. */
export interface CommandApprovalKey {
  readonly grammar: PersistedCommandShellGrammar;
  readonly template: string;
}

const GRAMMAR: Readonly<Record<CommandShellKind, CommandShellGrammar>> = {
  cmd: 'cmd',
  'windows-powershell': 'powershell',
  pwsh: 'powershell',
  bash: 'posix',
  zsh: 'posix',
  sh: 'posix',
  dash: 'posix',
  ksh: 'posix',
  wsl: 'posix',
  'provider-unknown': 'neutral',
};

const DEFAULT_LABEL: Readonly<Record<CommandShellKind, string>> = {
  cmd: 'cmd.exe',
  'windows-powershell': 'Windows PowerShell',
  pwsh: 'PowerShell 7 (pwsh)',
  bash: 'bash',
  zsh: 'zsh',
  sh: 'sh',
  dash: 'dash',
  ksh: 'ksh',
  wsl: 'WSL',
  'provider-unknown': 'Codex provider shell (unverified)',
};

const GRAMMAR_NAME: Readonly<Record<CommandShellGrammar, string>> = {
  cmd: 'cmd.exe',
  powershell: 'PowerShell',
  posix: 'POSIX shell',
  neutral: 'unverified shell',
};

const MAX_LABEL_LENGTH = 40;

export function grammarOfShellKind(kind: CommandShellKind): CommandShellGrammar {
  return GRAMMAR[kind];
}

export function isPersistedCommandShellGrammar(value: unknown): value is PersistedCommandShellGrammar {
  return value === 'cmd' || value === 'powershell' || value === 'posix';
}

/** A short printable label. A value that looks like a path or carries arguments is replaced by the default. */
export function boundedShellLabel(value: string | undefined, fallback: string): string {
  const raw = (value ?? '').trim();
  if (!raw || /[\\/:]|\s-{1,2}\w/.test(raw)) return fallback;
  const cleaned = raw.replace(/[^A-Za-z0-9 ._()+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH).trim();
  return cleaned || fallback;
}

/** A bounded digest of host facts. The parts must hold no workspace path, command text or secret. */
export function shellFingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts.map((part) => String(part)))).digest('hex').slice(0, 16);
}

export function commandShellIdentity(
  kind: CommandShellKind,
  source: CommandShellSource,
  opts: { label?: string; fingerprint?: readonly unknown[] } = {},
): CommandShellIdentity {
  return Object.freeze({
    kind,
    grammar: GRAMMAR[kind],
    label: boundedShellLabel(opts.label, DEFAULT_LABEL[kind]),
    source,
    fingerprint: shellFingerprint([kind, source, ...(opts.fingerprint ?? [])]),
  });
}

/** Two identities are the same shell only when kind, grammar and fingerprint all agree. */
export function sameShellIdentity(a: CommandShellIdentity, b: CommandShellIdentity): boolean {
  return a.kind === b.kind && a.grammar === b.grammar && a.fingerprint === b.fingerprint;
}

/** How a stored grant's grammar is shown to a person, e.g. in the project approvals picker. */
export function grammarDisplayName(grammar: CommandShellGrammar): string {
  return GRAMMAR_NAME[grammar];
}

/** The label and grammar a model or a person reads, e.g. `cmd.exe (cmd grammar)`. */
export function describeShell(shell: Pick<CommandShellIdentity, 'label' | 'grammar'>): string {
  return `${shell.label} (${shell.grammar} grammar)`;
}

function basenameOf(raw: string): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  const parts = trimmed.split(/[\\/]/);
  return (parts[parts.length - 1] ?? '').trim().toLowerCase();
}

const POSIX_BASENAMES: ReadonlyMap<string, CommandShellKind> = new Map([
  ['bash', 'bash'],
  ['zsh', 'zsh'],
  ['sh', 'sh'],
  ['dash', 'dash'],
  ['ksh', 'ksh'],
]);

/**
 * The POSIX kind a probe reported as the basename of `$0`. A login shell reports a leading `-` (`-bash`),
 * which is stripped once. Anything else (fish, nushell, a wrapper) is not admitted.
 */
export function posixShellKindFromBasename(raw: string | undefined): CommandShellKind | undefined {
  if (!raw) return undefined;
  let name = basenameOf(raw);
  if (name.startsWith('-')) name = name.slice(1);
  if (name.endsWith('.exe')) name = name.slice(0, -4);
  return POSIX_BASENAMES.get(name);
}

/** The shell kind an executable's name states, e.g. `pwsh.exe` → pwsh. Undefined for anything else. */
export function executableShellKind(raw: string | undefined): CommandShellKind | undefined {
  if (!raw || !raw.trim()) return undefined;
  let name = basenameOf(raw.toLowerCase());
  if (name.endsWith('.exe')) name = name.slice(0, -4);
  if (name === 'powershell') return 'windows-powershell';
  if (name === 'pwsh' || name === 'pwsh-preview') return 'pwsh';
  if (name === 'cmd') return 'cmd';
  if (name === 'wsl') return 'wsl';
  return posixShellKindFromBasename(name);
}

/** The grammar a shell kind is checked in. */
export function shellKindGrammar(kind: CommandShellKind): CommandShellGrammar {
  return GRAMMAR[kind];
}

export type ShellHintGrammar = PersistedCommandShellGrammar | 'unsupported';

/**
 * The grammar family a terminal-profile NAME or executable path suggests. It is only a hint: VS Code's
 * "PowerShell" profile may be Windows PowerShell or pwsh, and a configured path can be workspace-scoped, so
 * the probe alone admits a grammar. Returns undefined when nothing is suggested.
 */
export function shellHintGrammar(raw: string | undefined): ShellHintGrammar | undefined {
  if (!raw || !raw.trim()) return undefined;
  const lower = raw.trim().toLowerCase();
  if (/\(wsl\)\s*$/.test(lower)) return 'posix';
  let name = basenameOf(lower);
  if (name.endsWith('.exe')) name = name.slice(0, -4);
  switch (name) {
    case 'cmd':
    case 'command prompt':
      return 'cmd';
    case 'powershell':
    case 'windows powershell':
    case 'pwsh':
    case 'powershell 7':
    case 'powershell core':
      return 'powershell';
    case 'bash':
    case 'git bash':
    case 'zsh':
    case 'sh':
    case 'dash':
    case 'ksh':
    case 'wsl':
      return 'posix';
    default:
      return 'unsupported';
  }
}

// ---------------------------------------------------------------------------------------------
// Dialect adapters
// ---------------------------------------------------------------------------------------------

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

function firstToken(command: string): string {
  return (command ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

/** True when a command (or template) begins with the standard PowerShell Verb-Noun cmdlet shape. */
export function isPowerShellOnlyCmdlet(command: string): boolean {
  const match = /^([a-z][a-z0-9]*)-([a-z][a-z0-9]*)$/i.exec(firstToken(command));
  return !!match && POWERSHELL_CMDLET_VERBS.has(match[1].toLowerCase());
}

/** Whether a stored template can run at all under a grammar. Unknown (`neutral`) never admits a cmdlet. */
export function templateRunsUnder(template: string, grammar: CommandShellGrammar): boolean {
  return grammar === 'powershell' || !isPowerShellOnlyCmdlet(template);
}

/**
 * "Allow this session" approvals, in memory only. Each is bound to the grammar it was given under, so an
 * approval of `copy-item` in PowerShell never lets the same template run silently in cmd.exe or a POSIX shell.
 * An unverified (`neutral`) shell can neither add nor match one.
 */
export class SessionCommandApprovals {
  private readonly keys = new Set<string>();

  has(grammar: CommandShellGrammar, template: string): boolean {
    return isPersistedCommandShellGrammar(grammar) && this.keys.has(sessionKey(grammar, template));
  }

  add(grammar: CommandShellGrammar, template: string): boolean {
    if (!isPersistedCommandShellGrammar(grammar) || !template.trim()) return false;
    this.keys.add(sessionKey(grammar, template));
    return true;
  }

  clear(): void {
    this.keys.clear();
  }
}

function sessionKey(grammar: PersistedCommandShellGrammar, template: string): string {
  return `${grammar}\0${template.trim().toLowerCase()}`;
}

/** The reviewed safe list as grammar-bound keys, each grammar holding only what it can run. */
export function reviewedSafeApprovalKeys(templates: readonly string[]): CommandApprovalKey[] {
  const keys: CommandApprovalKey[] = [];
  for (const grammar of PERSISTED_COMMAND_SHELL_GRAMMARS) {
    for (const template of templates) {
      const normalized = template.trim().toLowerCase();
      if (normalized && templateRunsUnder(normalized, grammar)) keys.push({ grammar, template: normalized });
    }
  }
  return keys;
}

const QUOTES: Readonly<Record<CommandShellGrammar, string>> = {
  cmd: '"',
  powershell: `"'`,
  posix: `"'`,
  neutral: `"'`,
};

/**
 * The command with every quoted span removed, or undefined when a quote is left open. PowerShell doubles a
 * quote to escape it inside its own kind of quotes; POSIX double quotes honour a backslash escape. This is
 * used only to look for operators OUTSIDE quotes, never to decide that a quoted span is harmless.
 */
function unquoted(command: string, grammar: CommandShellGrammar): string | undefined {
  const quotes = QUOTES[grammar];
  let out = '';
  let open: string | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (open) {
      if (char === open) {
        if ((grammar === 'powershell') && command[index + 1] === open) {
          index += 1;
          continue;
        }
        open = undefined;
        out += ' ';
      } else if (char === '\\' && open === '"' && grammar === 'posix') {
        index += 1;
      }
      continue;
    }
    if (quotes.includes(char)) {
      open = char;
      continue;
    }
    out += char;
  }
  return open ? undefined : out;
}

/**
 * Constructs that remain unsupported for silent allowlist matching after the admitted chain separators are
 * removed. They are checked over the whole command, inside quotes too, so a quoted operator may prompt
 * unnecessarily but can never be auto-allowed by mistake.
 */
const UNSUPPORTED_FOR_AUTO_ALLOW: Readonly<Record<CommandShellGrammar, RegExp>> = {
  // cmd expands %VAR% before it parses operators, and ^ escapes them, so both are unsupported.
  cmd: /[&|;<>()^%\n\r]/,
  // PowerShell evaluates $variables, $(...), @(...), {...} and (...) inside arguments; ` escapes.
  powershell: /[&|<>()`{}$@\n\r]/,
  // An interactive POSIX shell also expands !history; (...) starts a subshell.
  posix: /[&|`<>()!\n\r]|\$\(|\$\{/,
  // An unverified shell admits one simple executable plus literal arguments, with no expansion at all.
  neutral: /[&|;`<>(){}$@%^!*?[\]~\n\r]/,
};

function admittedSeparators(shell: Pick<CommandShellIdentity, 'kind' | 'grammar'>): RegExp | undefined {
  switch (shell.grammar) {
    case 'cmd':
      return /&&/g;
    case 'powershell':
      return shell.kind === 'pwsh' ? /&&|;/g : /;/g;
    case 'posix':
      return /&&|;/g;
    case 'neutral':
      return undefined;
  }
}

/**
 * The independently executable segments of a command when it uses only the chain separators its grammar
 * admits, or undefined when anything else (pipes, redirects, substitutions, expansions, newlines, an open
 * quote, an empty segment) is present. Only such commands may match an allowlist without a prompt.
 */
export function autoAllowSegments(command: string, shell: Pick<CommandShellIdentity, 'kind' | 'grammar'>): string[] | undefined {
  const text = (command ?? '').trim();
  if (!text || unquoted(text, shell.grammar) === undefined) return undefined;
  const separators = admittedSeparators(shell);
  const segments = separators ? text.split(separators).map((segment) => segment.trim()) : [text];
  if (segments.length === 0 || segments.some((segment) => !segment)) return undefined;
  const remainder = separators ? text.replace(separators, ' ') : text;
  return UNSUPPORTED_FOR_AUTO_ALLOW[shell.grammar].test(remainder) ? undefined : segments;
}

export interface ShellCompatibilityProblem {
  /** The construct that cannot run, as the model wrote it. */
  readonly construct: string;
  /** Names the shell label and grammar, the refused construct and a compatible alternative. */
  readonly message: string;
}

function cmdletEquivalent(cmdlet: string, command: string, grammar: CommandShellGrammar): string {
  const sleepSeconds = /^start-sleep\s+(?:-seconds\s+)?(\d+)\b/i.exec(command.trim())?.[1];
  if (grammar === 'cmd') {
    // ping waits between replies rather than before the first one, so N seconds needs N + 1 requests.
    const sleepPingCount = sleepSeconds === undefined ? '<seconds+1>' : (BigInt(sleepSeconds) + 1n).toString();
    switch (cmdlet) {
      case 'start-sleep': return `ping -n ${sleepPingCount} 127.0.0.1 >nul`;
      case 'get-childitem': return 'dir';
      case 'get-content': return 'type <file>';
      case 'copy-item': return 'copy or xcopy';
      case 'remove-item': return 'del or rmdir';
      case 'move-item': return 'move';
      default: return 'a native cmd.exe command';
    }
  }
  switch (cmdlet) {
    case 'start-sleep': return `sleep ${sleepSeconds ?? '<seconds>'}`;
    case 'get-childitem': return 'ls';
    case 'get-content': return 'cat <file>';
    case 'copy-item': return 'cp';
    case 'remove-item': return 'rm';
    case 'move-item': return 'mv';
    default: return 'a POSIX shell command';
  }
}

/**
 * A construct that can never run in the identified shell. This is an executor fact, not a consent decision:
 * the caller refuses before any approval surface opens. An unverified (`neutral`) shell has no such facts.
 */
export function shellCompatibilityProblem(command: string, shell: CommandShellIdentity): ShellCompatibilityProblem | undefined {
  if (shell.grammar === 'neutral') return undefined;
  const text = (command ?? '').trim();
  if (shell.grammar !== 'powershell' && isPowerShellOnlyCmdlet(text)) {
    const cmdlet = firstToken(text);
    return {
      construct: cmdlet,
      message: `"${cmdlet}" is a PowerShell cmdlet, but this command runs in ${describeShell(shell)}, so it would never `
        + `succeed. Use the ${GRAMMAR_NAME[shell.grammar]} equivalent (${cmdletEquivalent(cmdlet, text, shell.grammar)}).`,
    };
  }
  if (shell.kind === 'windows-powershell') {
    const outside = unquoted(text, 'powershell') ?? text;
    const chain = /&&|\|\|/.exec(outside)?.[0];
    if (chain) {
      return {
        construct: chain,
        message: `"${chain}" is not a command separator in ${describeShell(shell)}, so this command would not parse. `
          + 'Use ";" to run the commands one after another, or make two calls when the second must run only if the '
          + 'first succeeds.',
      };
    }
  }
  return undefined;
}

/**
 * The identity of the declared direct fallback of a host: cmd.exe on Windows, /bin/sh on macOS and Linux.
 * This is the one place a host platform decides a grammar, and only because the fallback is declared that
 * way; DirectCommandExecution still resolves the executable before anything runs.
 */
export function declaredDirectShellIdentity(platform: NodeJS.Platform = process.platform): CommandShellIdentity {
  return platform === 'win32'
    ? commandShellIdentity('cmd', 'direct-fallback', { fingerprint: ['host-direct', 'win32'] })
    : commandShellIdentity('sh', 'direct-fallback', { fingerprint: ['host-direct', 'posix'] });
}

/** The fallback notice when the terminal could not prove its shell or folder; it names the shell, never a path. */
export function directFallbackNotice(shell: Pick<CommandShellIdentity, 'label'>, why: string): string {
  return `${why} This invocation will use the declared direct fallback: ${shell.label}.`;
}
