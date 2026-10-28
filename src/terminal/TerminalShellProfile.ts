/*---------------------------------------------------------------------------------------------
 *  UnodeAi - TerminalShellProfile (v0.9.96)
 *  What VS Code's effective terminal profile suggests about the shell an agent terminal will run, read from the
 *  settings alone: nothing is started, resolved or typed to learn it. It names the shell on an approval card
 *  before the agent terminal exists; the terminal is created only after the approval, and its capture probe must
 *  then prove the same shell kind, or the command does not run. A raw profile path or its arguments never leave
 *  this module.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  boundedShellLabel,
  type CommandShellKind,
  executableShellKind,
  shellFingerprint,
  shellHintGrammar,
  type ShellHintGrammar,
  shellKindGrammar,
} from '../backend/CommandShell';

export interface TerminalProfileHint {
  /** Undefined when the settings suggest nothing; `unsupported` for a shell UnodeAi cannot check (fish, nu, …). */
  readonly grammar?: ShellHintGrammar;
  /** A bounded, path-free label for a proved shell, e.g. `Git Bash`. */
  readonly label?: string;
  /** The profile runs WSL, whose folders this release never maps to host paths. */
  readonly wsl: boolean;
  /**
   * The shell kind the settings name, when an executable states it: the profile's path, else VS Code's resolved
   * default shell (`vscode.env.shell`), and only when it agrees with the hinted grammar.
   */
  readonly kind?: CommandShellKind;
  /** A bounded digest of the profile facts, for the per-agent failed-profile cache. */
  readonly fingerprint: string;
}

const PLATFORM_KEY: Partial<Record<NodeJS.Platform, string>> = { win32: 'windows', darwin: 'osx', linux: 'linux' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function basename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts = value.trim().replace(/^["']|["']$/g, '').split(/[\\/]/);
  return parts[parts.length - 1]?.toLowerCase() || undefined;
}

export interface TerminalProfileFacts {
  /** `terminal.integrated.defaultProfile.<platform>`. */
  defaultProfile?: string;
  /** The matching entry of `terminal.integrated.profiles.<platform>`. */
  profile?: unknown;
  /**
   * `vscode.env.shell`, VS Code's default shell for the extension host, which the default-profile setting overrides.
   * It suggests the grammar only when no profile is configured, and the kind whenever it agrees with that grammar.
   */
  envShell?: string;
}

/**
 * The hint for a set of profile facts. Priority: the profile's `source` (`PowerShell`, `Git Bash`), its path,
 * then its name, then VS Code's detected default shell. A custom profile NAME that names no known shell gives no
 * hint; an executable path that names an unknown shell is `unsupported`.
 */
export function terminalProfileHint(facts: TerminalProfileFacts): TerminalProfileHint {
  const profile = isRecord(facts.profile) ? facts.profile : undefined;
  const source = typeof profile?.source === 'string' ? profile.source : undefined;
  const rawPath = Array.isArray(profile?.path) ? profile?.path[0] : profile?.path;
  const profilePath = typeof rawPath === 'string' ? rawPath : undefined;
  const name = facts.defaultProfile?.trim() || undefined;
  const envShell = name ? undefined : facts.envShell;

  let grammar: ShellHintGrammar | undefined;
  if (source) grammar = shellHintGrammar(source);
  else if (profilePath) grammar = shellHintGrammar(profilePath);
  else if (name) {
    const fromName = shellHintGrammar(name);
    grammar = fromName === 'unsupported' ? undefined : fromName;
  } else if (envShell) grammar = shellHintGrammar(envShell);

  const pathBase = basename(profilePath) ?? basename(envShell);
  const wsl = /\(wsl\)\s*$/i.test(name ?? '') || pathBase === 'wsl.exe' || pathBase === 'wsl';
  const labelSource = source ?? name;
  const kind = grammar && grammar !== 'unsupported'
    ? [profilePath, facts.envShell].map(executableShellKind).find((candidate) => candidate && candidate !== 'wsl' && shellKindGrammar(candidate) === grammar)
    : undefined;
  return {
    ...(grammar ? { grammar } : {}),
    ...(grammar && grammar !== 'unsupported' && labelSource ? { label: boundedShellLabel(labelSource, labelSource) } : {}),
    wsl,
    ...(kind ? { kind } : {}),
    fingerprint: shellFingerprint(['profile', name ?? '', source ?? '', pathBase ?? '', basename(facts.envShell) ?? '']),
  };
}

/** The effective profile hint for this platform, read from the live settings. */
export function effectiveTerminalProfileHint(platform: NodeJS.Platform = process.platform): TerminalProfileHint {
  const key = PLATFORM_KEY[platform] ?? 'linux';
  const config = vscode.workspace.getConfiguration('terminal.integrated');
  const defaultProfile = config.get<string | null>(`defaultProfile.${key}`) ?? undefined;
  const profiles = config.get<Record<string, unknown>>(`profiles.${key}`) ?? {};
  return terminalProfileHint({
    defaultProfile: defaultProfile ?? undefined,
    profile: defaultProfile && isRecord(profiles) ? profiles[defaultProfile] : undefined,
    envShell: vscode.env.shell,
  });
}

/** Whether a configuration change can change the effective profile, so a cached profile failure is stale. */
export function affectsTerminalProfile(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration('terminal.integrated.defaultProfile')
    || event.affectsConfiguration('terminal.integrated.profiles')
    || event.affectsConfiguration('terminal.integrated.shellIntegration');
}
