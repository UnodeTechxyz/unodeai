export const ARTIFACT_REVIEW_POLICY_ID = 'artifact-review-different-reported-model-v1' as const;
export const TEAM_POLICY_STATE_KEY = 'unode.teamPolicy.v1';
export const TEAM_POLICY_CHANGE_LEDGER_KEY = 'unode.teamPolicyChanges.v1';
const POLICY_CHANGE_LIMIT = 50;

export interface TeamPolicyV1 {
  version: 1;
  requireDifferentReportedModelForArtifactReview: boolean;
}

export interface TeamPolicyChangeReceipt {
  version: 1;
  policyId: typeof ARTIFACT_REVIEW_POLICY_ID;
  oldValue: boolean;
  newValue: boolean;
  recordedAt: string;
  source: 'human-panel';
}

export interface TeamPolicyChangeLedgerV1 {
  version: 1;
  receipts: TeamPolicyChangeReceipt[];
}

export interface TeamPolicyMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

export const DEFAULT_TEAM_POLICY: Readonly<TeamPolicyV1> = Object.freeze({
  version: 1,
  requireDifferentReportedModelForArtifactReview: false,
});

/** Host-owned workspace policy. Only the human panel receives the mutation method. */
export class TeamPolicyStore {
  constructor(private readonly state: TeamPolicyMemento, private readonly now: () => Date = () => new Date()) {}

  current(): TeamPolicyV1 {
    const value = this.state.get<unknown>(TEAM_POLICY_STATE_KEY);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_TEAM_POLICY };
    const candidate = value as Record<string, unknown>;
    return candidate.version === 1 && typeof candidate.requireDifferentReportedModelForArtifactReview === 'boolean'
      ? { version: 1, requireDifferentReportedModelForArtifactReview: candidate.requireDifferentReportedModelForArtifactReview }
      : { ...DEFAULT_TEAM_POLICY };
  }

  changes(): TeamPolicyChangeReceipt[] {
    const value = this.state.get<unknown>(TEAM_POLICY_CHANGE_LEDGER_KEY);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== 1 || !Array.isArray(candidate.receipts)) return [];
    return candidate.receipts.flatMap((receipt): TeamPolicyChangeReceipt[] => {
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return [];
      const row = receipt as Record<string, unknown>;
      if (row.version !== 1 || row.policyId !== ARTIFACT_REVIEW_POLICY_ID
          || typeof row.oldValue !== 'boolean' || typeof row.newValue !== 'boolean'
          || typeof row.recordedAt !== 'string' || row.source !== 'human-panel') return [];
      return [{
        version: 1,
        policyId: ARTIFACT_REVIEW_POLICY_ID,
        oldValue: row.oldValue,
        newValue: row.newValue,
        recordedAt: row.recordedAt,
        source: 'human-panel',
      }];
    }).slice(-POLICY_CHANGE_LIMIT);
  }

  async setFromHumanPanel(enabled: boolean): Promise<boolean> {
    const current = this.current();
    if (current.requireDifferentReportedModelForArtifactReview === enabled) return false;
    const receipt: TeamPolicyChangeReceipt = {
      version: 1,
      policyId: ARTIFACT_REVIEW_POLICY_ID,
      oldValue: current.requireDifferentReportedModelForArtifactReview,
      newValue: enabled,
      recordedAt: this.now().toISOString(),
      source: 'human-panel',
    };
    const receipts = [...this.changes(), receipt].slice(-POLICY_CHANGE_LIMIT);
    await this.state.update(TEAM_POLICY_STATE_KEY, {
      version: 1,
      requireDifferentReportedModelForArtifactReview: enabled,
    } satisfies TeamPolicyV1);
    await this.state.update(TEAM_POLICY_CHANGE_LEDGER_KEY, {
      version: 1,
      receipts,
    } satisfies TeamPolicyChangeLedgerV1);
    return true;
  }
}
