import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_REVIEW_POLICY_ID,
  TEAM_POLICY_CHANGE_LEDGER_KEY,
  TEAM_POLICY_STATE_KEY,
  TeamPolicyStore,
} from '../TeamPolicy';

class MemoryState {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  update(key: string, value: unknown): void { this.values.set(key, value); }
}

describe('TeamPolicyStore', () => {
  it('defaults malformed, absent, and future state off', () => {
    const state = new MemoryState();
    const store = new TeamPolicyStore(state);
    expect(store.current().requireDifferentReportedModelForArtifactReview).toBe(false);
    state.values.set(TEAM_POLICY_STATE_KEY, { version: 99, requireDifferentReportedModelForArtifactReview: true });
    expect(store.current().requireDifferentReportedModelForArtifactReview).toBe(false);
    state.values.set(TEAM_POLICY_STATE_KEY, { version: 1, requireDifferentReportedModelForArtifactReview: 'yes' });
    expect(store.current().requireDifferentReportedModelForArtifactReview).toBe(false);
  });

  it('records only a real human-panel change and does not append on unchanged save', async () => {
    const state = new MemoryState();
    const store = new TeamPolicyStore(state, () => new Date('2026-08-29T10:00:00.000Z'));
    await expect(store.setFromHumanPanel(false)).resolves.toBe(false);
    await expect(store.setFromHumanPanel(true)).resolves.toBe(true);
    await expect(store.setFromHumanPanel(true)).resolves.toBe(false);
    expect(store.current()).toEqual({ version: 1, requireDifferentReportedModelForArtifactReview: true });
    expect(store.changes()).toEqual([{
      version: 1,
      policyId: ARTIFACT_REVIEW_POLICY_ID,
      oldValue: false,
      newValue: true,
      recordedAt: '2026-08-29T10:00:00.000Z',
      source: 'human-panel',
    }]);
    expect(state.values.has(TEAM_POLICY_CHANGE_LEDGER_KEY)).toBe(true);
  });

  it('bounds and sanitizes the human change ledger', () => {
    const state = new MemoryState();
    state.values.set(TEAM_POLICY_CHANGE_LEDGER_KEY, {
      version: 1,
      receipts: [
        { version: 1, policyId: ARTIFACT_REVIEW_POLICY_ID, oldValue: false, newValue: true, recordedAt: 'ok', source: 'human-panel' },
        { version: 1, policyId: 'foreign', oldValue: true, newValue: false, recordedAt: 'bad', source: 'model' },
      ],
    });
    expect(new TeamPolicyStore(state).changes()).toHaveLength(1);
  });
});
