import type { AgentConfig, CodexActPermissionProfile } from '../types';
import type { CommandApprovalMode } from '../backend/CommandPolicy';
import { codexReadCapable, codexWriteCapable } from '../backend/CodexPermissionProfile';

export type AutonomyMode = 'workspace' | 'review' | 'full-access';
export type AutonomyChoice = AutonomyMode | 'inherit';
export const AUTONOMY_DEFAULT_CONSENT_KEY = 'unode.autonomy.fullAccessDefault.v1';
export const FULL_ACCESS_ACTION = 'Enable full access';

export function isAutonomyMode(value: unknown): value is AutonomyMode {
  return value === 'workspace' || value === 'review' || value === 'full-access';
}

/** v0.9.100 (the Owner): the input-box menu's three positions, in order, with the names native Codex uses. */
export const AUTONOMY_MENU_MODES: readonly AutonomyMode[] = ['workspace', 'review', 'full-access'];
export const AUTONOMY_MENU_LABEL: Readonly<Record<AutonomyMode, string>> = {
  workspace: 'Approve for me',
  review: 'Ask for approval',
  'full-access': 'Full access',
};

/** The menu position a native Codex profile is shown as. Its names are the menu's names. */
export function autonomyModeForCodexProfile(profile: CodexActPermissionProfile): AutonomyMode {
  return profile === 'full-access' ? 'full-access' : profile === 'ask-for-approval' ? 'review' : 'workspace';
}

/** One independent restriction, in the words the menu shows. An unknown entry is shown as it is. */
export function plainAutonomyLimit(limit: string): string {
  switch (limit) {
    case 'Plan is read only': return 'Plan mode: read only.';
    case 'Workspace Trust is read only': return 'This folder is not trusted: read only.';
    case 'Folder Access stays within the granted scope': return 'Limited to the folders you granted.';
    case 'the current task narrows file access': return 'This task limits file access.';
    case 'Commands Off': return 'Commands are off.';
    case 'independent command review or narrowing': return 'Asks before commands.';
    case 'independent write review': return 'Asks before file edits.';
    case 'file-write tool Off': return 'Cannot edit files.';
    case 'host read tool Off': return 'Cannot read files.';
    case 'separate saved native Codex choice': return 'Codex keeps its own saved approval setting.';
    default: return limit;
  }
}

export interface AutonomyPolicyInput {
  config: AgentConfig;
  backend: string;
  defaultMode: AutonomyMode;
  trusted: boolean;
  mode?: 'plan' | 'act';
  taskScoped?: boolean;
  commandMode: CommandApprovalMode;
  writeApproval: 'none' | 'ask';
}

/** A projection of existing policy owners, not a second source of permission. */
export function resolveAutonomyPolicy(input: AutonomyPolicyInput) {
  const { config } = input;
  const choice: AutonomyChoice = isAutonomyMode(config.autonomyMode) ? config.autonomyMode : 'inherit';
  const requested = choice === 'inherit' ? input.defaultMode : choice;
  const restricted = !!config.folderAccess?.length;
  const fullFileAccess = requested === 'full-access' && input.trusted && !restricted;
  // v0.9.101 (the Owner, 2026-11-05): review comes only from what a person chose. Claude's legacy `autoApprove` is
  // false on every role Create team makes and no screen sets it, so it is no one's choice and adds no review; it
  // still selects Claude's launch mode, behind the always-on PreToolUse gate.
  const writeReview = input.writeApproval === 'ask' || requested === 'review';
  const commandReview = requested === 'review';
  const legacy = config.codexPermissionProfile;
  // Old approve-for-me has ambiguous provenance. Only a deliberate new choice/default changes it.
  // Existing explicit native Ask/Full stay separate unless this agent's Autonomy was deliberately edited.
  const codexProfile: CodexActPermissionProfile = choice === 'inherit' && (legacy === 'ask-for-approval' || legacy === 'full-access')
    ? legacy : requested === 'full-access' ? 'full-access' : requested === 'review' ? 'ask-for-approval' : 'approve-for-me';
  const limits: string[] = [];
  if (input.mode === 'plan') limits.push('Plan is read only');
  if (!input.trusted) limits.push('Workspace Trust is read only');
  if (restricted) limits.push('Folder Access stays within the granted scope');
  if (input.taskScoped) limits.push('the current task narrows file access');
  const hostExecuteOff = input.backend !== 'codex' && Array.isArray(config.allowedTools) && !config.allowedTools.includes('execute');
  if (hostExecuteOff || config.executePreference === 'deny' || input.commandMode === 'none' || config.commandNarrowing?.approvalMode === 'none') limits.push('Commands Off');
  else if (input.commandMode === 'ask' && requested !== 'review' || input.commandMode === 'allowlist' || config.commandNarrowing) limits.push('independent command review or narrowing');
  if (input.writeApproval === 'ask' && requested !== 'review') limits.push('independent write review');
  if (input.backend === 'codex' ? !codexWriteCapable(config.allowedTools, config.toolCeiling)
    : Array.isArray(config.allowedTools) && !config.allowedTools.includes('write')) limits.push('file-write tool Off');
  if (input.backend === 'codex' ? !codexReadCapable(config.allowedTools, config.toolCeiling)
    : Array.isArray(config.allowedTools) && !config.allowedTools.includes('read')) limits.push('host read tool Off');
  const expectedNative = requested === 'full-access' ? 'full-access' : requested === 'review' ? 'ask-for-approval' : 'approve-for-me';
  if (input.backend === 'codex' && codexProfile !== expectedNative) limits.push('separate saved native Codex choice');
  const title = requested === 'full-access' ? 'Full access' : requested === 'review' ? 'Review' : 'Workspace';
  const label = limits.length ? `Custom · ${title} requested` : title;
  const routeDetail = input.backend === 'codex'
    ? 'Native Codex uses its own sandbox and reviewer. Ask concerns escalation, not every ordinary edit. Native Full access bypasses UnodeAi command, deletion, outward and checkpoint checks; native reads are not confined by host read roots.'
    : 'Host and Claude commands follow command policy but have no OS filesystem sandbox; their effects can reach outside the working folder.';
  const scope = `${fullFileAccess && !input.taskScoped ? 'Host file tools can reach files your OS account permits' : 'Host file tools use workspace, granted and task scope'}; `
    + `${input.mode === 'plan' || !input.trusted ? 'changes are disabled' : writeReview ? 'mediated writes use review' : 'ordinary mediated writes run automatically'}. `;
  const detail = scope + (limits.length ? `${limits.join('; ')}. ` : '') + routeDetail;
  // The menu item's explanation: the same facts without the independent limits, which the menu lists in plain words.
  const description = scope + routeDetail;
  return { choice, requested, label, detail, description, fullFileAccess, writeReview, commandReview, codexProfile, limits };
}

export interface AutonomyState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** The persisted default enable decision, written only from a contemporaneous person's choice. */
export class AutonomyDefaultConsent {
  private generation = 0;
  private commitTail: Promise<unknown> = Promise.resolve();
  private liveConsent: boolean | undefined;
  constructor(private readonly state: AutonomyState) {}
  get revision(): number { return this.generation; }
  invalidate(): void { this.generation++; this.liveConsent = false; }
  effective(configured: unknown): AutonomyMode {
    if (!isAutonomyMode(configured)) return 'workspace';
    return configured === 'full-access' && (this.liveConsent === false || this.state.get(AUTONOMY_DEFAULT_CONSENT_KEY) !== true) ? 'workspace' : configured;
  }
  async choose(mode: AutonomyMode, ports: {
    trusted(): boolean;
    confirm(): Promise<unknown>;
    write(mode: AutonomyMode): PromiseLike<void>;
  }): Promise<boolean> {
    const generation = ++this.generation;
    this.liveConsent = false;
    if (mode === 'full-access') {
      if (!ports.trusted()) return false;
      const answer = await ports.confirm();
      if (answer !== FULL_ACCESS_ACTION || generation !== this.generation || !ports.trusted()) return false;
    }
    const commit = this.commitTail.catch(() => undefined).then(async () => {
      if (generation !== this.generation || mode === 'full-access' && !ports.trusted()) return false;
      await this.state.update(AUTONOMY_DEFAULT_CONSENT_KEY, false);
      if (generation !== this.generation || mode === 'full-access' && !ports.trusted()) return false;
      try { await ports.write(mode); }
      catch (error) { await this.state.update(AUTONOMY_DEFAULT_CONSENT_KEY, false); throw error; }
      if (generation !== this.generation || mode === 'full-access' && !ports.trusted()) return false;
      if (mode === 'full-access') {
        await this.state.update(AUTONOMY_DEFAULT_CONSENT_KEY, true);
        if (generation !== this.generation || !ports.trusted()) {
          await this.state.update(AUTONOMY_DEFAULT_CONSENT_KEY, false);
          return false;
        }
      }
      this.liveConsent = mode === 'full-access';
      return true;
    });
    this.commitTail = commit;
    return commit;
  }
}
