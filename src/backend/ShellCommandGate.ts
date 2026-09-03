import * as path from 'path';
import { CommandPolicy } from './CommandPolicy';

/**
 * Human-visible prefix for a shell-path heuristic refusal. It is not a sandbox boundary and must never
 * control turn termination; only structured path-resolution errors can do that (G-003).
 */
export const BLOCKED_OUTSIDE_WORKDIR = 'BLOCKED_OUTSIDE_WORKDIR';

export interface CommandApprovalDecision {
  allow: boolean;
  note?: string;
}

export interface CommandApprovalContext {
  warning?: string;
  forcePrompt?: boolean;
  /** The executor's actual shell, when it affects whether a command is runnable. */
  activeShell?: 'cmd';
}

/**
 * `context.warning` explains why a command is being escalated that policy would otherwise have let
 * through silently. `context.forcePrompt` says the human must be asked even if this command's template
 * was already latched (session/project) — the template is approved, the new detail (e.g. an out-of-root
 * path) is not.
 */
export type CommandApprover = (
  command: string,
  context?: CommandApprovalContext
) => Promise<CommandApprovalDecision>;

export type ShellCommandSource = 'model' | 'config';

export type ShellCommandGateBlockKind = 'policy' | 'approval' | 'outside-unattended';

export type ShellCommandGateResult =
  | { ok: true; outsidePath?: string }
  | { ok: false; kind: ShellCommandGateBlockKind; message: string; reason?: string; note?: string; outsidePath?: string };

export interface ShellCommandGateOptions {
  command: string;
  roots: string | string[];
  source: ShellCommandSource;
  commandPolicy?: CommandPolicy;
  requestApproval?: CommandApprover;
  onOutsideRoot?: (attemptedPath: string) => void;
  onConfigOutsideRoot?: (message: string, outsidePath: string, command: string) => void;
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
export function detectOutsideRootPath(command: string, roots: string | string[]): string | undefined {
  const resolvedRoots = (Array.isArray(roots) ? roots : [roots]).map((r) => path.resolve(r));
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
        const embedded = outsideEmbeddedDrivePath(raw, resolvedRoots);
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
      abs = path.resolve(tok);
    } catch {
      continue;
    }
    if (!resolvedRoots.some((root) => isInside(root, abs))) {
      return abs;
    }
  }
  return undefined;
}

export async function gateShellCommand(opts: ShellCommandGateOptions): Promise<ShellCommandGateResult> {
  // WorkspaceTools runs shell:true, which resolves to cmd.exe on Windows. Tell the shared policy so it
  // neither silently permits nor advertises a saved PowerShell-only cmdlet. Other backends may expose a
  // real PowerShell tool, so they continue to call CommandPolicy without this cmd.exe context.
  const commandCheckOptions = process.platform === 'win32' ? { activeShell: 'cmd' as const } : undefined;
  const verdict = opts.commandPolicy?.check(opts.command, commandCheckOptions) ?? { allowed: true };

  // A policy DENIAL is final and is decided first. Outside-root detection may add a prompt/warning only
  // to a command policy would otherwise permit; it must never make a denied command runnable.
  if (!verdict.allowed && !verdict.ask) {
    return {
      ok: false,
      kind: 'policy',
      reason: verdict.reason,
      message: policyBlockMessage(verdict.reason),
    };
  }

  const outsidePath = detectOutsideRootPath(opts.command, opts.roots);
  if (outsidePath) {
    opts.onOutsideRoot?.(outsidePath);
  }

  if (opts.source === 'model') {
    return await gateModelCommand(opts, verdict, outsidePath, commandCheckOptions?.activeShell);
  }
  return await gateConfigCommand(opts, verdict, outsidePath, commandCheckOptions?.activeShell);
}

function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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

function outsideEmbeddedDrivePath(rawUriTail: string, roots: string[]): string | undefined {
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
    const abs = path.resolve(embedded);
    return roots.some((root) => isInside(root, abs)) ? undefined : abs;
  } catch {
    return undefined;
  }
}

async function gateModelCommand(
  opts: ShellCommandGateOptions,
  verdict: { allowed: boolean; ask?: boolean; reason?: string },
  outsidePath: string | undefined,
  activeShell: 'cmd' | undefined
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
    const context = outsidePath
      ? {
        warning: `This command names "${outsidePath}", outside the agent's writable folder(s) (${formatRoots(opts.roots)}).`,
        forcePrompt: true,
        activeShell,
      }
      : { activeShell };
    const decision = await opts.requestApproval(
      opts.command,
      context
    );
    if (!decision.allow) {
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
  verdict: { allowed: boolean; ask?: boolean; reason?: string },
  outsidePath: string | undefined,
  activeShell: 'cmd' | undefined
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
    const decision = await opts.requestApproval(opts.command, { activeShell });
    if (!decision.allow) {
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
