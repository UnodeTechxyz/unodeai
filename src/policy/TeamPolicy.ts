export const ARTIFACT_REVIEW_POLICY_ID = 'artifact-review-different-reported-model-v1' as const;
export const TEAM_POLICY_STATE_KEY = 'unode.teamPolicy.v1';
export const TEAM_POLICY_MODE_STATE_KEY = 'unode.teamPolicy.v2';
export const TEAM_POLICY_CHANGE_LEDGER_KEY = 'unode.teamPolicyChanges.v1';
const POLICY_CHANGE_LIMIT = 50;

export interface TeamPolicyV1 {
  version: 1;
  requireDifferentReportedModelForArtifactReview: boolean;
}
export const REVIEW_POLICY_MODES = ['off', 'strict-different-reported-model', 'different-when-author-known'] as const;
export type ReviewPolicyMode = typeof REVIEW_POLICY_MODES[number];
export interface TeamPolicyV2 {
  version: 2;
  reviewMode: ReviewPolicyMode;
  /** Compatibility projection; semantics are always taken from reviewMode in v2. */
  requireDifferentReportedModelForArtifactReview: boolean;
}
export type TeamPolicy = TeamPolicyV1 | TeamPolicyV2;
export function isReviewPolicyMode(value: unknown): value is ReviewPolicyMode {
  return typeof value === 'string' && (REVIEW_POLICY_MODES as readonly string[]).includes(value);
}
export function reviewPolicyMode(policy: TeamPolicy): ReviewPolicyMode {
  return policy.version === 2 ? policy.reviewMode : policy.requireDifferentReportedModelForArtifactReview ? 'strict-different-reported-model' : 'off';
}

export interface TeamPolicyChangeReceipt {
  version: 1 | 2;
  policyId: typeof ARTIFACT_REVIEW_POLICY_ID;
  oldValue: boolean;
  newValue: boolean;
  recordedAt: string;
  source: 'human-panel';
  oldMode?: ReviewPolicyMode;
  newMode?: ReviewPolicyMode;
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

  current(): TeamPolicy {
    const value = this.state.get<unknown>(TEAM_POLICY_STATE_KEY);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_TEAM_POLICY };
    const candidate = value as Record<string, unknown>;
    const mode = this.state.get<unknown>(TEAM_POLICY_MODE_STATE_KEY);
    const history = this.state.get<TeamPolicyChangeLedgerV1>(TEAM_POLICY_CHANGE_LEDGER_KEY);
    const last = Array.isArray(history?.receipts) ? history.receipts.at(-1) : undefined;
    // Keep the original boolean readable by older versions. A later legacy-panel change invalidates the mode
    // marker, so returning to v107 cannot resurrect an earlier, more permissive recommendation over strict.
    if (candidate.version === 1 && mode && typeof mode === 'object' && !Array.isArray(mode)) {
      const selected = mode as Record<string, unknown>;
      if (selected.version === 2 && isReviewPolicyMode(selected.reviewMode)
        && candidate.requireDifferentReportedModelForArtifactReview === (selected.reviewMode !== 'off')
        && last?.version === 2 && last.newMode === selected.reviewMode && last.recordedAt === selected.recordedAt) return {
        version: 2, reviewMode: selected.reviewMode, requireDifferentReportedModelForArtifactReview: selected.reviewMode !== 'off',
      };
    }
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
      if ((row.version !== 1 && row.version !== 2) || row.policyId !== ARTIFACT_REVIEW_POLICY_ID
          || typeof row.oldValue !== 'boolean' || typeof row.newValue !== 'boolean'
          || typeof row.recordedAt !== 'string' || row.source !== 'human-panel'
          || row.version === 2 && (!isReviewPolicyMode(row.oldMode) || !isReviewPolicyMode(row.newMode)
            || row.oldValue !== (row.oldMode !== 'off') || row.newValue !== (row.newMode !== 'off'))) return [];
      return [{
        version: row.version,
        policyId: ARTIFACT_REVIEW_POLICY_ID,
        oldValue: row.oldValue,
        newValue: row.newValue,
        recordedAt: row.recordedAt,
        source: 'human-panel',
        ...(row.version === 2 ? { oldMode: row.oldMode as ReviewPolicyMode, newMode: row.newMode as ReviewPolicyMode } : {}),
      }];
    }).slice(-POLICY_CHANGE_LIMIT);
  }

  async setFromHumanPanel(enabled: boolean): Promise<boolean> {
    return this.setModeFromHumanPanel(enabled ? 'strict-different-reported-model' : 'off');
  }

  async setModeFromHumanPanel(mode: ReviewPolicyMode): Promise<boolean> {
    if (!isReviewPolicyMode(mode)) return false;
    const current = this.current();
    const oldMode = reviewPolicyMode(current);
    if (oldMode === mode) return false;
    const receipt: TeamPolicyChangeReceipt = {
      version: 2,
      policyId: ARTIFACT_REVIEW_POLICY_ID,
      oldValue: current.requireDifferentReportedModelForArtifactReview,
      newValue: mode !== 'off', oldMode, newMode: mode,
      recordedAt: this.now().toISOString(),
      source: 'human-panel',
    };
    const receipts = [...this.changes(), receipt].slice(-POLICY_CHANGE_LIMIT);
    await this.state.update(TEAM_POLICY_STATE_KEY, {
      version: 1,
      requireDifferentReportedModelForArtifactReview: mode !== 'off',
    } satisfies TeamPolicyV1);
    await this.state.update(TEAM_POLICY_MODE_STATE_KEY, { version: 2, reviewMode: mode, recordedAt: receipt.recordedAt });
    await this.state.update(TEAM_POLICY_CHANGE_LEDGER_KEY, {
      version: 1,
      receipts,
    } satisfies TeamPolicyChangeLedgerV1);
    return true;
  }
}
