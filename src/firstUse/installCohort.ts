/*
 * v0.9.106 (first use, design §3.5 and §3.8): telling a fresh installation from an upgrade or a reinstall, so that the
 * Chat is revealed once, only to a person who never had UnodeAi in this VS Code profile, and a returning person gets the
 * familiar screens back. The evidence is read at the start of activation, before any migration or initialisation
 * writes to the same stores. Pure: the host reads the stores and passes what it found.
 *
 * The flag lives in the extension's globalState, so its scope is the current VS Code profile, not the machine.
 */

/** The globalState flag: the fresh-install reveal was decided (made, or skipped for an upgrade or an unknown cohort). */
export const FIRST_USE_REVEAL_HANDLED_KEY = 'unode.firstUse.revealHandled';

/**
 * What was present before this activation wrote anything. `undefined` for a store that could not be read: a read
 * error makes the cohort unknown, never fresh.
 */
export interface InstallEvidence {
  /** The keys of the extension's globalState. */
  globalStateKeys: readonly string[] | undefined;
  /** The extension's globalStorage folder exists and holds something. */
  globalStorageNonEmpty: boolean | undefined;
  /** A `unode.*` setting has an explicit value in the user's settings. */
  explicitUserSettings: boolean | undefined;
  /** SecretStorage holds a key under one of UnodeAi's secret names. */
  storedSecret: boolean | undefined;
}

export type InstallCohort = 'fresh' | 'upgrade' | 'unknown';

/** Any evidence of an earlier installation makes it an upgrade; a store that could not be read makes it unknown. */
export function classifyInstall(evidence: InstallEvidence): InstallCohort {
  const signals = [
    evidence.globalStateKeys === undefined ? undefined : evidence.globalStateKeys.length > 0,
    evidence.globalStorageNonEmpty,
    evidence.explicitUserSettings,
    evidence.storedSecret,
  ];
  if (signals.some((signal) => signal === true)) return 'upgrade';
  if (signals.some((signal) => signal === undefined)) return 'unknown';
  return 'fresh';
}

/** Project evidence of a returning person (§3.8): a team saved anywhere, an automatic snapshot, or a project team file. */
export interface ReturningEvidence {
  savedTeams: boolean;
  automaticSnapshots: boolean;
  projectTeamFile: boolean;
}

/** §3.8: a returning person is one with installation evidence or a saved team; unknown counts as new for presentation. */
export function isReturningUser(cohort: InstallCohort, evidence: ReturningEvidence): boolean {
  return cohort === 'upgrade' || evidence.savedTeams || evidence.automaticSnapshots || evidence.projectTeamFile;
}

export type RevealDecision = 'reveal' | 'mark-handled' | 'none';

/**
 * §3.5: reveal the Chat once, after the roster was restored, for a fresh installation with no agent and no returning
 * evidence. An upgrade, a returning person or an unknown cohort is marked handled without a reveal; a decision already
 * made stays made.
 */
export function revealDecision(input: {
  cohort: InstallCohort;
  handled: boolean;
  rosterEmpty: boolean;
  returning: boolean;
}): RevealDecision {
  if (input.handled) return 'none';
  if (input.cohort === 'fresh' && input.rosterEmpty && !input.returning) return 'reveal';
  return 'mark-handled';
}
