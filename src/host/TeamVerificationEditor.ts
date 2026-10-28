import { createHash, randomUUID } from 'node:crypto';
import { parseCompletionVerificationPolicy, resolveCompletionVerificationPolicy } from '../backend/CompletionVerificationPolicy';
import { buildCompletionVerificationSettingsView, readLegacyGlobalVerificationCommand,
  type CompletionVerificationConfiguration, type CompletionVerificationSettingsView } from './CompletionVerificationSettings';
import { workspaceRootIdentity } from '../state/WorkspaceRootIdentity';
import { TeamVerificationConfigurationError, type TeamFileDocument } from '../state/TeamFileSchema';
import type { AgentConfig } from '../types';

export interface TeamVerificationEditorPort {
  workspaceRoot(): string;
  rosterRevision(): number;
  isCurrentWorkspace(): boolean;
  skills(): readonly string[];
  members(): readonly AgentConfig[];
  configuration(): CompletionVerificationConfiguration;
  readDocument(): Promise<TeamFileDocument | undefined>;
  /** Real PersistenceManager queue; edit runs synchronously against the latest strict document. */
  updateDocument(edit: (current: TeamFileDocument | undefined) => TeamFileDocument): Promise<void>;
}

/** A form target, not a policy cache or execution grant. Only one rendered edit token remains live. */
export class TeamVerificationEditor {
  private preparation = 0;
  private pending: { token: string; root: string; revision: number; signature: string } | undefined;
  constructor(private readonly port: TeamVerificationEditorPort) {}

  private signature(document: TeamFileDocument | undefined): string | undefined {
    let legacy: unknown;
    const resolution = resolveCompletionVerificationPolicy({ workspaceId: workspaceRootIdentity(this.port.workspaceRoot()),
      completionVerification: document?.completionVerification, agentSkills: this.port.skills(),
      readLegacyGlobalCommand: () => { legacy = readLegacyGlobalVerificationCommand(this.port.configuration()); return legacy; } });
    return resolution.kind === 'resolved' ? JSON.stringify({ binding: resolution.effective.binding,
      ...(resolution.effective.source === 'legacy-global' && typeof legacy === 'string'
        ? { legacyDigest: createHash('sha256').update(legacy).digest('hex') } : {}) }) : undefined;
  }
  async prepare(): Promise<CompletionVerificationSettingsView> {
    const preparation = ++this.preparation;
    this.pending = undefined;
    const root = this.port.workspaceRoot(); const revision = this.port.rosterRevision();
    const unavailable = (): CompletionVerificationSettingsView => ({ kind: 'unavailable', detail: 'The team configuration changed or could not be read. Refresh Team settings or repair .unode/team.json.' });
    try {
      const document = await this.port.readDocument();
      if (preparation !== this.preparation || !this.port.isCurrentWorkspace() || !root || root !== this.port.workspaceRoot()
        || revision !== this.port.rosterRevision()) return unavailable();
      const view = buildCompletionVerificationSettingsView({ workspaceRoot: root, completionVerification: document?.completionVerification,
        agentSkills: this.port.skills(), readLegacyGlobalCommand: () => readLegacyGlobalVerificationCommand(this.port.configuration()) });
      const signature = this.signature(document);
      if (view.kind !== 'ready' || !signature) return view;
      const token = randomUUID(); this.pending = { token, root, revision, signature };
      return { ...view, editToken: token };
    } catch (error) {
      if (error instanceof TeamVerificationConfigurationError && preparation === this.preparation
        && root === this.port.workspaceRoot() && revision === this.port.rosterRevision() && this.port.isCurrentWorkspace()) {
        return buildCompletionVerificationSettingsView({ workspaceRoot: root, agentSkills: this.port.skills(),
          teamDocumentState: 'configuration-invalid', readLegacyGlobalCommand: () => undefined });
      }
      return unavailable();
    }
  }
  async save(token: string, raw: unknown): Promise<void> {
    const parsed = parseCompletionVerificationPolicy(raw);
    if (parsed.kind !== 'valid') throw new Error('Choose Off, Automatic selection, or a valid single-line command (at most 2,048 UTF-8 bytes). No checks were run.');
    const captured = this.pending;
    if (!captured || captured.token !== token) throw new Error('This setting was refreshed. The save was not performed.');
    this.pending = undefined; // One-shot, including a failed write; a retry must refresh actual disk state.
    const assertCurrent = (document: TeamFileDocument | undefined) => {
      if (!this.port.isCurrentWorkspace() || captured.root !== this.port.workspaceRoot()
        || captured.revision !== this.port.rosterRevision() || captured.signature !== this.signature(document)) {
        throw new Error('The team or its completion-check source changed. The save was not performed. Refresh Team settings.');
      }
    };
    await this.port.updateDocument(current => {
      assertCurrent(current);
      return { ...(current ?? { version: '1.0', members: [...this.port.members()], workflows: [], mcpServers: [] }),
        completionVerification: parsed.policy };
    });
  }
}
