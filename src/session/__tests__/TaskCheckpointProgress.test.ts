import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_DUE_AFTER_MS,
  CHECKPOINT_DUE_GENERATED_TOKENS,
  describeCheckpointProgress,
  NO_RECOVERABLE_PRODUCT_AFTER_MS,
  TaskCheckpointProgressTracker,
} from '../TaskCheckpointProgress';

/*
 * v0.9.97 L1: how far a task that delivers in batches is from its last saved batch. Observational only.
 * Each test names the design sentence it realises (DESIGN_v0997 review resolution, section 7.1).
 */

const active = (activeMs: number, approvalWaitMs = 0) => ({ activeMs, approvalWaitMs });

function tracked(now = () => 1_000) {
  const tracker = new TaskCheckpointProgressTracker(now);
  tracker.begin('writer', 'attempt-1', 'handle-1');
  return tracker;
}

describe('provider-reported generated tokens (§7.1)', () => {
  // §7.1: "CLI 不提供实时用量时显示 unavailable … 不能从70k最终用量推断".
  it('says unavailable until the provider reported a count, and infers none from elapsed time', () => {
    const tracker = tracked();
    const snapshot = tracker.snapshot('writer', active(10 * 60_000))!;
    expect(snapshot.generated).toEqual({ status: 'unavailable' });
    // Elapsed time alone makes a batch due; tokens never are, without a report.
    expect(snapshot.dueReasons).toEqual(['elapsed']);
    expect(describeCheckpointProgress(snapshot)).toContain('generated tokens: unavailable (no live count reported on this route yet)');
  });

  // §7.1: "累计计数不得因流式重复事件重复增加".
  it('replaces a repeated report of one unit instead of adding it, and ignores a lower late report', () => {
    const tracker = tracked();
    tracker.noteUsage('writer', { source: 'claude-stream-message', unit: 'msg_1', outputTokens: 500 });
    tracker.noteUsage('writer', { source: 'claude-stream-message', unit: 'msg_1', outputTokens: 500 });
    tracker.noteUsage('writer', { source: 'claude-stream-message', unit: 'msg_1', outputTokens: 1_200 });
    // A late report of a smaller figure for the same unit does not shrink it.
    tracker.noteUsage('writer', { source: 'claude-stream-message', unit: 'msg_1', outputTokens: 900 });
    tracker.noteUsage('writer', { source: 'claude-stream-message', unit: 'msg_2', outputTokens: 300 });
    expect(tracker.snapshot('writer', active(0))!.generated).toMatchObject({
      status: 'reported', outputTokens: 1_500, sources: ['claude-stream-message'], sinceLastBatch: { outputTokens: 1_500 },
    });
  });

  // §7.1: "明确区分正文与 reasoning 计数；不读推理文本".
  it('keeps the reported reasoning share apart, and shows it only when a provider reported one', () => {
    const tracker = tracked();
    tracker.noteUsage('writer', { source: 'codex-thread-usage', unit: 'thread:0', outputTokens: 9_000, reasoningTokens: 7_000 });
    const snapshot = tracker.snapshot('writer', active(0))!;
    expect(snapshot.generated).toMatchObject({ outputTokens: 9_000, reasoningTokens: 7_000, sinceLastBatch: { outputTokens: 9_000, reasoningTokens: 7_000 } });
    expect(describeCheckpointProgress(snapshot)).toMatch(/9000 output tokens since the last saved batch \(reasoning reported separately: 7000\) · source: Codex App Server thread usage/);
    const other = tracked();
    other.noteUsage('writer', { source: 'claude-stream-message', unit: 'm', outputTokens: 10 });
    expect(other.snapshot('writer', active(0))!.generated).not.toHaveProperty('reasoningTokens');
  });

  it('counts nothing that is not a whole non-negative number, and nothing for an untracked session', () => {
    const tracker = tracked();
    for (const outputTokens of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      tracker.noteUsage('writer', { source: 'openai-compatible-response', unit: 'response-1', outputTokens });
    }
    tracker.noteUsage('someone-else', { source: 'openai-compatible-response', unit: 'response-1', outputTokens: 50_000 });
    expect(tracker.snapshot('writer', active(0))!.generated).toEqual({ status: 'unavailable' });
    expect(tracker.snapshot('someone-else', active(0))).toBeUndefined();
  });
});

describe('checkpoint-due and no recoverable work product (§7.1)', () => {
  // §7.1: "自上次持久 checkpoint 累计达到 8,000 个 provider 可观测生成 tokens … 进入 checkpoint-due".
  it('is due at 8,000 generated tokens since the last saved batch, and starts again from a saved batch', () => {
    const tracker = tracked();
    tracker.noteUsage('writer', { source: 'openai-compatible-response', unit: 'response-1', outputTokens: CHECKPOINT_DUE_GENERATED_TOKENS - 1 });
    expect(tracker.snapshot('writer', active(1_000))!.state).toBe('on-track');
    tracker.noteUsage('writer', { source: 'openai-compatible-response', unit: 'response-2', outputTokens: 1 });
    expect(tracker.snapshot('writer', active(1_000))).toMatchObject({ state: 'checkpoint-due', dueReasons: ['generated-tokens'] });
    expect(tracker.noteBatchSaved('attempt-1', active(1_000))).toBe(true);
    expect(tracker.snapshot('writer', active(1_000))).toMatchObject({
      state: 'on-track', batchesSaved: 1, generated: { outputTokens: CHECKPOINT_DUE_GENERATED_TOKENS, sinceLastBatch: { outputTokens: 0 } },
    });
  });

  // §7.1: "或两分钟没有持久工作产品时 … 四分钟仍无可读成果显示'尚无可恢复工作产品'".
  it('is due after two minutes of active time without a saved batch, and has no recoverable product at four', () => {
    const tracker = tracked();
    expect(tracker.snapshot('writer', active(CHECKPOINT_DUE_AFTER_MS - 1))!.state).toBe('on-track');
    expect(tracker.snapshot('writer', active(CHECKPOINT_DUE_AFTER_MS))).toMatchObject({ state: 'checkpoint-due', dueReasons: ['elapsed'] });
    const none = tracker.snapshot('writer', active(NO_RECOVERABLE_PRODUCT_AFTER_MS))!;
    expect(none.state).toBe('no-recoverable-product');
    expect(describeCheckpointProgress(none)).toMatch(/^no recoverable work product yet after 4m 0s of active time/);
    // Once a batch is saved, a long gap is "due", never "no recoverable product".
    tracker.noteBatchSaved('attempt-1', active(NO_RECOVERABLE_PRODUCT_AFTER_MS));
    expect(tracker.snapshot('writer', active(NO_RECOVERABLE_PRODUCT_AFTER_MS * 3))!.state).toBe('checkpoint-due');
  });

  // §7.1: "待审批时间单列，不把等用户催成模型超时".
  it('shows the approval wait apart and counts only the active time it is given', () => {
    const tracker = tracked();
    const snapshot = tracker.snapshot('writer', active(60_000, 10 * 60_000))!;
    expect(snapshot).toMatchObject({ state: 'on-track', activeMsSinceProduct: 60_000, approvalWaitMs: 600_000 });
    expect(describeCheckpointProgress(snapshot)).toContain('approval wait 10m 0s (not counted)');
  });

  it('gives the reminder once per due period, and again only after the next saved batch falls due', () => {
    const tracker = tracked();
    expect(tracker.takeDueNotice('attempt-1', active(1_000))).toBeUndefined();
    const notice = tracker.takeDueNotice('attempt-1', active(CHECKPOINT_DUE_AFTER_MS));
    expect(notice).toBe('[host] A batch is due: 2 min of active time since this task began, and no batch is saved yet. '
      + 'If a section is complete, save it now with save_task_checkpoint. Saving extends no wait, budget or deadline.');
    expect(tracker.takeDueNotice('attempt-1', active(CHECKPOINT_DUE_AFTER_MS * 2))).toBeUndefined();
    tracker.noteBatchSaved('attempt-1', active(CHECKPOINT_DUE_AFTER_MS * 2));
    expect(tracker.takeDueNotice('attempt-1', active(CHECKPOINT_DUE_AFTER_MS * 2 + 1))).toBeUndefined();
    expect(tracker.takeDueNotice('attempt-1', active(CHECKPOINT_DUE_AFTER_MS * 3))).toMatch(/since the last saved batch/);
  });

  it('says when the state next changes by time alone, and nothing once it no longer can', () => {
    const tracker = tracked();
    expect(tracker.nextTimedChangeMs('writer', active(30_000))).toBe(CHECKPOINT_DUE_AFTER_MS - 30_000);
    expect(tracker.nextTimedChangeMs('writer', active(CHECKPOINT_DUE_AFTER_MS))).toBe(NO_RECOVERABLE_PRODUCT_AFTER_MS - CHECKPOINT_DUE_AFTER_MS);
    expect(tracker.nextTimedChangeMs('writer', active(NO_RECOVERABLE_PRODUCT_AFTER_MS))).toBeUndefined();
    tracker.end('writer');
    expect(tracker.snapshot('writer', active(0))).toBeUndefined();
    expect(tracker.noteBatchSaved('attempt-1', active(0))).toBe(false);
  });
});
