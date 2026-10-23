/*---------------------------------------------------------------------------------------------
 * v0.9.96: Check / choose CLI, for Claude CLI and Codex CLI. The flow is the policy; the port is the editor.
 *
 * Listing starts nothing. v0.9.97: picking a program is not consent to run it either. The order is pick, prepare,
 * read its static facts (its files and their hashes, the bundled policy, an adoption record, the signatures; none of
 * this starts the program), ask, and only then start it: the existing check for a program this UnodeAi qualified or
 * the user already adopted, or the compatibility check for any other, whose pass alone writes the adoption record. A
 * different program is used only after the user confirms it, and only if neither the setting nor the program's files
 * changed while the user decided. Choosing a program is not network consent, starts no agent and stops none. The
 * latest published version is looked up by the port, only as the user's network consent allows, and is shown beside
 * what was measured; it never chooses.
 *--------------------------------------------------------------------------------------------*/

import { compareCliVersions } from '../backend/cliRuntime';
import type { CliCandidateSource, CliLaunchRoute, CliRuntimeCandidate, CliRuntimeProvider } from '../backend/cliRuntime';
import type { AdoptionDialogText } from './cliAdoptionDialog';

export interface CliRuntimeCheck {
  provider: CliRuntimeProvider;
  /** The program that was started, as resolved. */
  program: string;
  version: string;
  checkedAt: string;
  /** The identity of the program file that was checked (see `cliProgramStamp`). Another file was not checked. */
  stamp: string;
}

export interface CurrentCliRuntime {
  /** The program UnodeAi starts now, found without starting it. */
  program?: string;
  /** `configured`: the user setting. `legacy`: the PATH lookup UnodeAi used before 0.9.96. `none`: nothing. */
  origin: 'configured' | 'legacy' | 'none';
  source?: CliCandidateSource;
  /** Why the current program cannot be started, when it cannot. */
  problem?: string;
  /** The raw setting, so a change made while a program is being checked is noticed. */
  settingValue: string;
}

export interface PreparedCliRuntime {
  /** What the setting will hold: the chosen launcher, kept stable for later resolution. */
  settingValue: string;
  /** The program actually started, links resolved. */
  program: string;
  route: CliLaunchRoute;
  source: CliCandidateSource;
  /** The identity of that program file when it was prepared. */
  stamp: string;
}

/**
 * v0.9.97: what is known of a prepared program without starting it. `closureDigest` is the digest of the files a
 * start of it binds; the program the user confirms is the one with this digest.
 */
export type CliProgramFacts =
  /** These exact files were qualified by this UnodeAi: the version is the policy's. */
  | { verdict: 'qualified'; closureDigest: string; version: string; compatibilityPolicyId: string }
  /** The user adopted these exact files before, after a check that passed: the version is the record's. */
  | { verdict: 'adopted'; closureDigest: string; version: string; adoptionId: string }
  /** Nothing qualifies or adopted these files: the dialog asks, and the compatibility check runs after an OK. */
  | { verdict: 'needs-adoption'; closureDigest: string; dialog: AdoptionDialogText }
  /** A release marked these bytes bad; no consent overrides that. */
  | { verdict: 'blocked-bad'; closureDigest: string; reason: string };

/** The compatibility check's outcome, as the chooser reads it. */
export type CliGateProbeOutcome =
  | { result: 'pass'; version: string; versionOutput: string; startedAt: string; durationMs: number }
  | { result: 'fail' | 'stop-unconfirmed'; detail: string };

export type CliPickItem =
  | { kind: 'candidate'; label: string; description: string; detail: string; path: string; current: boolean }
  | { kind: 'browse'; label: string; description: string };

export interface CliRuntimeConfirmation {
  provider: CliRuntimeProvider;
  /**
   * `adopt`: show `next.facts.dialog`, the adoption question, whose buttons are its own. `use`: the program is
   * qualified or adopted; ask whether to start and use it.
   */
  kind: 'adopt' | 'use';
  current: CurrentCliRuntime;
  currentVersion?: string;
  next: PreparedCliRuntime & { facts: CliProgramFacts; version?: string };
  /** What starts after an OK to `use`, in the words of the check (`CLI_CHECK_RUNS`). */
  startsAfterOk: string;
  /** The latest published version, when it was looked up. */
  latest?: string;
}

/** What a latest-version lookup found: a version, or in plain words why there is none. */
export interface CliLatestLookup {
  version?: string;
  note: string;
}

export interface CliRuntimeChooserPort {
  current(): CurrentCliRuntime;
  /** The latest published version, looked up only as the user's network consent allows. Never throws. */
  latest(): PromiseLike<CliLatestLookup>;
  /** File-system discovery only. */
  candidates(): CliRuntimeCandidate[];
  lastCheck(program: string): CliRuntimeCheck | undefined;
  pick(items: CliPickItem[], placeHolder: string): PromiseLike<CliPickItem | undefined>;
  browse(): PromiseLike<string | undefined>;
  /**
   * Resolve a chosen path the way a start would, refusing what a start would refuse, and read the identity of the
   * program file. Throws with the reason. Called again before saving, so a target that changed is noticed.
   */
  prepare(path: string): PreparedCliRuntime;
  /**
   * v0.9.97: the program's static facts: its closure, hashed; the policy verdict; its adoption record; for a program
   * to adopt, the signature check and the dialog text. Starts nothing of the program. Throws with the reason, for
   * example when the program lies inside UnodeAi's CLI store. Called again after the OK, so changed files are noticed.
   */
  facts(prepared: PreparedCliRuntime): Promise<CliProgramFacts>;
  /**
   * Start that one qualified or adopted program to check it, after the OK; resolves its version. Throws with the
   * reason. Never called before the confirmation.
   */
  check(prepared: PreparedCliRuntime): Promise<string>;
  /**
   * v0.9.97: the compatibility check of a program to adopt, after the OK to the adoption dialog. Never called before
   * it. Never throws: a failure is an outcome.
   */
  probe(prepared: PreparedCliRuntime, facts: Extract<CliProgramFacts, { verdict: 'needs-adoption' }>): Promise<CliGateProbeOutcome>;
  /** v0.9.97: write the adoption record of those exact files. Called only after a pass. Throws with the reason. */
  adopt(prepared: PreparedCliRuntime, facts: Extract<CliProgramFacts, { verdict: 'needs-adoption' }>, outcome: Extract<CliGateProbeOutcome, { result: 'pass' }>): PromiseLike<void>;
  confirm(question: CliRuntimeConfirmation): PromiseLike<boolean>;
  persist(settingValue: string): PromiseLike<void>;
  record(check: CliRuntimeCheck): PromiseLike<void>;
  /** The window is closing or the bound workspace changed: nothing more happens. */
  blocked(): boolean;
  /** Agents of this provider that have a running process, which keeps the program it was started with. */
  runningAgents(): number;
  report(kind: 'information' | 'warning', message: string): void;
  now(): Date;
  samePath(a: string, b: string): boolean;
}

export const CLI_PROVIDER_LABEL: Record<CliRuntimeProvider, string> = { 'claude-cli': 'Claude CLI', 'codex-cli': 'Codex CLI' };

/** What the check of a qualified or adopted program starts, after the OK. Codex keeps its login check as well. */
export const CLI_CHECK_RUNS: Record<CliRuntimeProvider, string> = {
  'claude-cli': 'once, with --version',
  'codex-cli': 'twice, with --version and then login status',
};

export interface CliRuntimeChoice {
  program: string;
  version: string;
  changed: boolean;
  /** What the setting holds for this choice, and the identity of the program file that was checked. */
  settingValue: string;
  stamp: string;
  /** The latest published version, when it was looked up. */
  latest?: string;
}

function originLabel(current: CurrentCliRuntime): string {
  if (current.origin === 'configured') return 'your setting';
  if (current.origin === 'legacy') return 'found on PATH, as before 0.9.96';
  return 'not set';
}

export async function chooseCliRuntime(provider: CliRuntimeProvider, port: CliRuntimeChooserPort): Promise<CliRuntimeChoice | undefined> {
  const label = CLI_PROVIDER_LABEL[provider];
  const start = port.current();
  const latest = await port.latest();
  if (port.blocked()) return undefined;
  const older = (version: string) => latest.version !== undefined && compareCliVersions(version, latest.version) === -1;
  const describe = (program: string) => {
    const check = port.lastCheck(program);
    if (!check) return 'version not checked yet';
    return `${check.version} · checked ${check.checkedAt.slice(0, 10)}${older(check.version) ? ` · older than ${latest.version}` : ''}`;
  };
  const items: CliPickItem[] = [];
  if (start.program) {
    items.push({
      kind: 'candidate', label: `$(check) Current · ${originLabel(start)}`, description: describe(start.program),
      detail: start.program, path: start.program, current: true,
    });
  }
  for (const candidate of port.candidates()) {
    if (start.program && port.samePath(candidate.path, start.program)) continue;
    items.push({
      kind: 'candidate', label: candidate.source, description: describe(candidate.path),
      detail: candidate.note ? `${candidate.path} — ${candidate.note}` : candidate.path, path: candidate.path, current: false,
    });
  }
  items.push({ kind: 'browse', label: '$(folder-opened) Browse for the program…', description: 'Choose another file' });
  const picked = await port.pick(items,
    `${latest.note} Choose a ${label} to check. UnodeAi reads that program's files first and starts it only after you confirm; nothing else is started.`);
  if (!picked) return undefined;
  const chosenPath = picked.kind === 'browse' ? await port.browse() : picked.path;
  if (!chosenPath || port.blocked()) return undefined;

  let prepared: PreparedCliRuntime;
  try {
    prepared = port.prepare(chosenPath);
  } catch (error) {
    port.report('warning', `UnodeAi will not use that ${label}: ${messageOf(error)}`);
    return undefined;
  }
  // Static facts only: nothing of the chosen program runs before the user's answer below.
  let facts: CliProgramFacts;
  try {
    facts = await port.facts(prepared);
  } catch (error) {
    port.report('warning', `UnodeAi will not use that ${label}: ${messageOf(error)} Nothing was started.`);
    return undefined;
  }
  if (port.blocked()) return undefined;
  if (facts.verdict === 'blocked-bad') {
    port.report('warning', `UnodeAi will not use that ${label}: a UnodeAi release marked this version bad (${facts.reason}). Nothing was started.`);
    return undefined;
  }
  const known = latest.version ? { latest: latest.version } : {};
  const isCurrent = !!start.program && port.samePath(prepared.program, start.program);
  const factVersion = facts.verdict === 'needs-adoption' ? undefined : facts.version;
  if (isCurrent && factVersion !== undefined) {
    // Qualified or adopted already, and already in use: there is nothing to decide, so nothing is started.
    const behind = older(factVersion) ? ` It is older than the latest published ${label}, ${latest.version}.` : '';
    const how = facts.verdict === 'qualified' ? 'qualified by this UnodeAi' : 'adopted by you';
    port.report(behind ? 'warning' : 'information', `${label} ${factVersion} (${how}): ${prepared.program}. UnodeAi already starts this program; nothing was started.${behind}`);
    return { program: prepared.program, version: factVersion, changed: false, settingValue: prepared.settingValue, stamp: prepared.stamp, ...known };
  }
  // The choice is made against the setting the user saw. If it changed meanwhile, this choice is about the past.
  if (port.current().settingValue !== start.settingValue) {
    port.report('warning', `The ${label} setting changed while UnodeAi read the program. Nothing was changed; check again.`);
    return undefined;
  }
  const currentVersion = start.program ? port.lastCheck(start.program)?.version : undefined;
  const confirmed = await port.confirm({
    provider, kind: facts.verdict === 'needs-adoption' ? 'adopt' : 'use', current: start,
    ...(currentVersion ? { currentVersion } : {}),
    next: { ...prepared, facts, ...(factVersion !== undefined ? { version: factVersion } : {}) },
    startsAfterOk: CLI_CHECK_RUNS[provider], ...known,
  });
  if (!confirmed || port.blocked() || port.current().settingValue !== start.settingValue) return undefined;
  // What a launcher or link starts is decided when it starts, not when it was read. Resolve the choice again: a
  // launcher pointed elsewhere, or a program file replaced, while the user decided is a program nobody confirmed.
  let now: PreparedCliRuntime;
  try {
    now = port.prepare(chosenPath);
  } catch (error) {
    port.report('warning', `UnodeAi will not use that ${label} now: ${messageOf(error)} Nothing was saved.`);
    return undefined;
  }
  if (now.settingValue !== prepared.settingValue || now.route !== prepared.route
    || !port.samePath(now.program, prepared.program) || now.stamp !== prepared.stamp) {
    const moved = port.samePath(now.program, prepared.program) ? '' : ` It now starts ${now.program}.`;
    port.report('warning', `The ${label} program at ${chosenPath} changed while you decided.${moved} Nothing was saved; check it again.`);
    return undefined;
  }
  // The files are hashed again: a change to any of them while the user decided is a program nobody confirmed.
  let again: CliProgramFacts;
  try {
    again = await port.facts(now);
  } catch (error) {
    port.report('warning', `UnodeAi will not use that ${label} now: ${messageOf(error)} Nothing was started.`);
    return undefined;
  }
  if (again.verdict !== facts.verdict || again.closureDigest !== facts.closureDigest) {
    port.report('warning', `The files of the ${label} program at ${chosenPath} changed while you decided. Nothing was started; check it again.`);
    return undefined;
  }
  if (port.blocked()) return undefined;

  let version: string;
  if (facts.verdict === 'needs-adoption') {
    const outcome = await port.probe(prepared, facts);
    if (outcome.result !== 'pass') {
      port.report('warning', outcome.result === 'stop-unconfirmed'
        ? `UnodeAi will not use that ${label}: ${outcome.detail}. Restart Windows if you are not sure it stopped. Nothing was saved.`
        : `UnodeAi will not use that ${label}: its check failed (${outcome.detail}). Nothing was saved.`);
      return undefined;
    }
    if (port.blocked()) return undefined;
    try {
      await port.adopt(prepared, facts, outcome);
    } catch (error) {
      port.report('warning', `UnodeAi could not record that you chose that ${label}: ${messageOf(error)} Nothing was saved.`);
      return undefined;
    }
    version = outcome.version;
  } else {
    try {
      version = await port.check(prepared);
    } catch (error) {
      port.report('warning', `UnodeAi could not check that ${label}: ${messageOf(error)} Nothing was changed.`);
      return undefined;
    }
  }
  if (port.blocked()) return undefined;
  await port.record({ provider, program: prepared.program, version, checkedAt: port.now().toISOString(), stamp: prepared.stamp });
  const behind = older(version) ? ` It is older than the latest published ${label}, ${latest.version}.` : '';
  if (isCurrent) {
    port.report(behind ? 'warning' : 'information', `${label} ${version} checked: ${prepared.program}. UnodeAi already starts this program.${behind}`);
    return { program: prepared.program, version, changed: false, settingValue: prepared.settingValue, stamp: prepared.stamp, ...known };
  }
  if (port.current().settingValue !== start.settingValue) {
    port.report('warning', `The ${label} setting changed while UnodeAi checked the program. Nothing was saved; check again.`);
    return undefined;
  }
  await port.persist(prepared.settingValue);
  const running = port.runningAgents();
  port.report(behind ? 'warning' : 'information', `${label} ${version} saved: ${prepared.program}.${behind}`
    + (running > 0 ? ` Agents that are already running still use the previous program. Stop and restart them when you are ready; nothing is resent.` : ''));
  return { program: prepared.program, version, changed: true, settingValue: prepared.settingValue, stamp: prepared.stamp, ...known };
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}
