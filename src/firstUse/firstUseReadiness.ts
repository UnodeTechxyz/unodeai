/*
 * v0.9.106 (first use, design §3.2): whether the connection chosen for a first goal can take a task, judged before any
 * agent exists, from the existing local checks only. Nothing here sends a model request or reads a credential file:
 * an API key is "configured" when SecretStorage holds it, the Codex CLI passes its preflight (path, version,
 * `codex login status`), and the Claude CLI starts, reports its version and, where it has one, answers
 * `claude auth status`. When something is missing the result names the real condition and one real action.
 */
import type { ConnectionProfile } from '../routes/RouteContracts';
import { CodexPreflightError } from '../backend/CodexCliPreflight';

export type FirstUseCli = 'claude-cli' | 'codex-cli';

export type FirstUseRepairAction =
  | { kind: 'set-api-key'; label: string; secretName: string }
  | { kind: 'choose-model'; label: string }
  | { kind: 'open-providers'; label: string }
  | { kind: 'choose-cli'; label: string; cli: FirstUseCli }
  | { kind: 'cli-login'; label: string; cli: FirstUseCli; command: string }
  | { kind: 'use-connection'; label: string; connectionId: string };

export interface FirstUseRepair {
  title: string;
  detail: string;
  /** Numbered steps, when the repair has more than one. */
  steps?: string[];
  action: FirstUseRepairAction;
}

/**
 * `version`: v0.9.106 (retest 3, T2), the version the CLI reported to this check. It is shown, never stored: the check
 * is not Settings' Check / choose CLI, and records nothing.
 */
export type FirstUseReadiness = { ready: true; note?: string; version?: string } | { ready: false; repair: FirstUseRepair };

/** What the Claude CLI check found. `loggedIn` is undefined when the CLI has no status command that answers. */
export interface ClaudeCliCheck {
  loggedIn: boolean | undefined;
  /** The version `claude --version` reported to this check. */
  version?: string;
  /**
   * True when the environment a new Claude CLI agent starts with holds one of the credential variables Claude Code
   * signs in with. Presence only: the value is never read beyond being non-empty, shown, logged or checked.
   */
  inheritedCredential?: boolean;
  /** The login command to prefill: the connection registry's (`claude auth login`), the same as Settings → Providers. */
  loginCommand: string;
}

export class ClaudeCliCheckError extends Error {
  constructor(readonly kind: 'not-found' | 'version', message: string) {
    super(message);
    this.name = 'ClaudeCliCheckError';
  }
}

export interface FirstUseReadinessProbes {
  profile: (connectionId: string) => ConnectionProfile | undefined;
  hasSecret: (secretName: string) => Promise<boolean>;
  /**
   * Resolves when the selected Codex CLI passes its preflight, with the version it reported when known; throws
   * CodexPreflightError otherwise.
   */
  codexPreflight: () => Promise<string | void>;
  /** Throws ClaudeCliCheckError when the program is not found or reports no version. */
  claudeCheck: () => Promise<ClaudeCliCheck>;
  /** CLIs found on this computer without starting them, most useful first. */
  detectedClis: () => FirstUseCli[];
}

export interface FirstUseReadinessInput {
  connectionId: string;
  /** The model chosen for a custom gateway. */
  model?: string;
  /** True when nobody chose this connection: neither the first-use record nor an explicit default setting names it. */
  implicitDefault: boolean;
}

const CLI_NAME: Record<FirstUseCli, string> = { 'claude-cli': 'Claude CLI', 'codex-cli': 'Codex CLI' };

function loginRepair(cli: FirstUseCli, command: string): FirstUseRepair {
  return {
    title: `The ${CLI_NAME[cli]} is not signed in`,
    detail: `Opening the terminal does not sign you in: you run the command there yourself.`,
    steps: [
      'Press Open a terminal. It opens with the command typed in, not run.',
      `Run ${command} in that terminal and finish signing in.`,
      'Come back here and press Check again.',
    ],
    action: { kind: 'cli-login', label: 'Open a terminal', cli, command },
  };
}

function chooseCliRepair(cli: FirstUseCli, title: string, detail: string): FirstUseRepair {
  return { title, detail, action: { kind: 'choose-cli', label: `Choose the ${CLI_NAME[cli]}…`, cli } };
}

/** The card shown when nobody chose a connection and the default one cannot run yet: detected CLIs come first. */
function unconfiguredRepair(profile: ConnectionProfile | undefined, detected: FirstUseCli[]): FirstUseRepair | undefined {
  const cli = detected[0];
  if (!cli) return undefined;
  const found = detected.map((id) => CLI_NAME[id]).join(' and the ');
  return {
    title: 'Choose how UnodeAi reaches a model',
    detail: `UnodeAi found the ${found} on this computer.`
      + (profile ? ` ${profile.presentation.displayName}, the default, needs an API key first.` : ''),
    action: { kind: 'use-connection', label: `Use the ${CLI_NAME[cli]}`, connectionId: cli },
  };
}

export async function firstUseReadiness(input: FirstUseReadinessInput, probes: FirstUseReadinessProbes): Promise<FirstUseReadiness> {
  const profile = probes.profile(input.connectionId);
  if (!profile || profile.availability !== 'available') {
    const unconfigured = unconfiguredRepair(undefined, probes.detectedClis());
    if (unconfigured) return { ready: false, repair: unconfigured };
    return {
      ready: false,
      repair: {
        title: 'This connection cannot run tasks',
        detail: profile?.availabilityMessage ?? 'The connection chosen for this task is not available. Choose another connection.',
        action: { kind: 'open-providers', label: 'Open Settings → Providers' },
      },
    };
  }
  if (profile.authKind === 'codex-cli') {
    try {
      const version = await probes.codexPreflight();
      return { ready: true, ...(version ? { version } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof CodexPreflightError ? error.kind : 'did-not-run';
      if (kind === 'login') return { ready: false, repair: loginRepair('codex-cli', 'codex login') };
      if (kind === 'not-configured') {
        return { ready: false, repair: chooseCliRepair('codex-cli', 'UnodeAi does not know where the Codex CLI is',
          'Choose the Codex CLI program on this computer. Install it first with npm install -g @openai/codex if it is not there.') };
      }
      if (kind === 'version') return { ready: false, repair: chooseCliRepair('codex-cli', 'This Codex CLI version is not supported', message) };
      return { ready: false, repair: chooseCliRepair('codex-cli', 'The Codex CLI did not run', message) };
    }
  }
  if (profile.authKind === 'claude-cli') {
    try {
      const check = await probes.claudeCheck();
      const version = check.version ? { version: check.version } : {};
      // A Claude task inherits the credential set in its environment; `auth status` is asked without it, so its
      // "signed out" does not decide for that person.
      if (check.inheritedCredential) {
        return { ready: true, ...version, note: 'The Claude CLI uses the credential set in your environment; it is confirmed when the first task starts.' };
      }
      if (check.loggedIn === false) return { ready: false, repair: loginRepair('claude-cli', check.loginCommand) };
      return check.loggedIn === true ? { ready: true, ...version } : { ready: true, ...version, note: 'Your Claude sign-in is confirmed when the first task starts.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ClaudeCliCheckError && error.kind === 'not-found') {
        return { ready: false, repair: chooseCliRepair('claude-cli', 'UnodeAi did not find the Claude CLI',
          'Choose the Claude CLI program on this computer. Install it first with npm install -g @anthropic-ai/claude-code if it is not there.') };
      }
      return { ready: false, repair: chooseCliRepair('claude-cli', 'The Claude CLI did not report its version', message) };
    }
  }
  // API-key connections: SecretStorage holding the key means configured, not that the account can run a task.
  const custom = profile.id.startsWith('custom:');
  if (profile.apiKeySecretName && !(await probes.hasSecret(profile.apiKeySecretName))) {
    if (custom) {
      return {
        ready: false,
        repair: {
          title: `${profile.presentation.displayName} has no API key`,
          detail: 'Add the key of this gateway in Settings → Providers, then press Check again.',
          action: { kind: 'open-providers', label: 'Open Settings → Providers' },
        },
      };
    }
    const unconfigured = input.implicitDefault ? unconfiguredRepair(profile, probes.detectedClis()) : undefined;
    if (unconfigured) return { ready: false, repair: unconfigured };
    return {
      ready: false,
      repair: {
        title: `${profile.presentation.displayName} needs an API key`,
        detail: 'UnodeAi keeps the key in VS Code\'s secure storage. A stored key shows the connection is set up; the first task shows the account can run it.',
        action: { kind: 'set-api-key', label: 'Set the API key', secretName: profile.apiKeySecretName },
      },
    };
  }
  if (custom && !input.model) {
    return {
      ready: false,
      repair: {
        title: `Choose a model on ${profile.presentation.displayName}`,
        detail: 'This gateway has no built-in model list. Choose the model the agents will use; cancelling keeps your goal and starts nothing.',
        action: { kind: 'choose-model', label: 'Choose a model' },
      },
    };
  }
  return { ready: true, ...(profile.apiKeySecretName ? { note: 'API key configured.' } : {}) };
}

/**
 * The `loggedIn` answer of `claude auth status --json` (N0, 2026-11-17: Claude Code 2.1.326 has this command; it reports
 * the stored sign-in and sends no model request). Undefined when the output carries no such answer, for example a CLI
 * without the command. Nothing else of the output is read or kept: it also names the account.
 */
export function parseClaudeAuthStatus(output: string): boolean | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as { loggedIn?: unknown };
    return typeof parsed?.loggedIn === 'boolean' ? parsed.loggedIn : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when `env` holds a non-empty value for one of `keys`. Presence only: nothing else of a value is read, kept or
 * returned.
 */
export function hasInheritedCredential(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  const wanted = new Set(keys.map((key) => key.toUpperCase()));
  return Object.keys(env).some((name) => wanted.has(name.toUpperCase()) && typeof env[name] === 'string' && env[name]!.trim().length > 0);
}
