import { completionVerificationCommandIssue, resolveCompletionVerificationPolicy, sameVerificationBinding, type VerificationPolicyResolution } from '../backend/CompletionVerificationPolicy';
import { prepareCompletionVerificationCheck, type CompletionVerificationCheckOptions,
  type VerificationCheckOutcome } from '../backend/CompletionVerificationCheck';
import { buildCompletionVerificationSettingsView, readLegacyGlobalVerificationCommand, type CompletionVerificationConfiguration,
  type CompletionVerificationSettingsView } from './CompletionVerificationSettings';
import { workspaceRootIdentity } from '../state/WorkspaceRootIdentity';
import { admitCompletionVerification, type VerificationAdmissionReaders } from '../backend/CompletionVerificationAdmission';
import type { VerificationEligibilitySnapshot } from '../backend/VerificationEligibilitySnapshot';

export interface HostVerificationPolicyReader {
  workspaceRoot(): string;
  agentSkills(): readonly string[];
  /** Absence is legitimate; malformed/unreadable documents MUST reject instead of becoming absence. */
  readTeam(): Promise<{ completionVerification?: unknown } | undefined>;
  configuration(): CompletionVerificationConfiguration;
}

/** Strict display reader shares the execution inputs, but never prepares or runs a command. */
export async function readHostVerificationSettings(reader: HostVerificationPolicyReader): Promise<CompletionVerificationSettingsView> {
  const root = reader.workspaceRoot();
  try {
    const team = await reader.readTeam();
    if (root !== reader.workspaceRoot()) return { kind: 'unavailable', detail: 'The workspace changed. Reopen Team settings.' };
    return buildCompletionVerificationSettingsView({ workspaceRoot: root,
      agentSkills: reader.agentSkills(), completionVerification: team?.completionVerification,
      readLegacyGlobalCommand: () => readLegacyGlobalVerificationCommand(reader.configuration()) });
  } catch {
    return { kind: 'unavailable', detail: 'The current .unode/team.json could not be read. Fix the file before changing completion checks.' };
  }
}

/** Resolve from current host-owned inputs every time, with no merged workspace-setting fallback or policy cache. */
export async function readHostVerificationPolicy(reader: HostVerificationPolicyReader): Promise<VerificationPolicyResolution> {
  return (await readHostPolicy(reader, false))!;
}

/** Unlike interactive/workflow checks, PM end-of-turn checks are opt-in, not an auto-detection trigger. */
export async function readHostCompletionGatePolicy(reader: HostVerificationPolicyReader): Promise<VerificationPolicyResolution | undefined> {
  return readHostPolicy(reader, true);
}

async function readHostPolicy(reader: HostVerificationPolicyReader, optInOnly: boolean): Promise<VerificationPolicyResolution | undefined> {
  const workspaceRoot = reader.workspaceRoot();
  const workspaceId = workspaceRootIdentity(workspaceRoot);
  let raw: unknown;
  try { raw = (await reader.readTeam())?.completionVerification; }
  catch { raw = { mode: '__unreadable__' }; }
  // A root change during I/O must not bind the old document to the new workspace.
  if (reader.workspaceRoot() !== workspaceRoot) raw = { mode: '__stale__' };
  let legacy: unknown;
  if (optInOnly && raw === undefined) {
    try { legacy = readLegacyGlobalVerificationCommand(reader.configuration()); }
    catch { raw = { mode: '__unreadable__' }; }
    // Invalid configured values still surface a configuration problem; a newline is not harmless whitespace.
    if (raw === undefined && (legacy === undefined || completionVerificationCommandIssue(legacy) === 'empty')) return undefined;
  }
  return resolveCompletionVerificationPolicy({
    workspaceId, agentSkills: reader.agentSkills(), completionVerification: raw,
    readLegacyGlobalCommand: () => optInOnly ? legacy : readLegacyGlobalVerificationCommand(reader.configuration()),
  });
}

/** Policy-only observation at the actual agent cwd: no shell preparation, approval or command execution. */
export async function readHostVerificationEligibility(reader: HostVerificationPolicyReader, cwd: string,
  readers?: VerificationAdmissionReaders): Promise<VerificationEligibilitySnapshot> {
  const resolution = await readHostVerificationPolicy(reader);
  const admission = await admitCompletionVerification(resolution, cwd, readers);
  if (admission.kind === 'configuration-invalid') return { kind: admission.kind, source: admission.source };
  const { source, binding } = admission.effective;
  const latest = await readHostVerificationPolicy(reader);
  if (latest.kind !== 'resolved' || !sameVerificationBinding(binding, latest.effective.binding)) return { kind: 'unavailable' };
  return admission.kind === 'ready'
    ? { kind: admission.kind, source, binding, command: admission.command }
    : { kind: admission.kind, source, binding };
}

/** Host execution adapter shared by policy consumers; each operation owns its captured resolution and request. */
export async function runHostVerificationCheck(
  reader: HostVerificationPolicyReader,
  options: Omit<CompletionVerificationCheckOptions, 'resolution' | 'currentResolution' | 'refreshResolution'>,
  capturedResolution?: VerificationPolicyResolution,
): Promise<VerificationCheckOutcome> {
  let current = await readHostVerificationPolicy(reader);
  return prepareCompletionVerificationCheck({
    ...options, resolution: capturedResolution ?? current, currentResolution: () => current,
    refreshResolution: async () => { current = await readHostVerificationPolicy(reader); },
  }).run();
}
