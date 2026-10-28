import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }));

import { MessageBus } from '../../bus/MessageBus';
import { TeamViewProvider } from '../TeamViewProvider';
import { savedBatchesDeletePrompt, savedBatchesDocument, savedBatchesPick, workProductLabel } from '../savedTaskBatches';
import { checkpointFinalCheck, type CheckpointAttemptSummary, type TaskCheckpointRecord } from '../../backend/TaskCheckpoints';

/*
 * v0.9.97 L1: what the person sees of saved task batches, and the few words a running task's Team row adds.
 * Each test names the design sentence it realises (DESIGN_v0997 review resolution, section 7.2).
 */

const PLAN = { mode: 'incremental' as const, sections: [{ key: 'intro' }, { key: 'body' }, { key: 'close' }] };

function record(sequence: number, sectionKey: string, text: string): TaskCheckpointRecord {
  return {
    schemaVersion: 1, checkpointId: `ckpt-${sequence}`, attemptId: 'attempt-1', sequence, sectionKey, revision: 1,
    finalCandidate: false, contentSha256: 'a'.repeat(64), requestDigest: 'd', bytes: text.length,
    savedAt: '2026-10-19T04:20:00.000Z', text,
  };
}

function summary(overrides: Partial<CheckpointAttemptSummary> = {}): CheckpointAttemptSummary {
  const records = [record(1, 'intro', 'Intro text.')];
  return {
    attemptId: 'attempt-1', agentId: 'writer', coordinatorId: 'pm', handle: 'h-1', objective: 'Draft the PolyFlow article.',
    plan: PLAN, state: 'cancelled', startedAt: '2026-10-19T04:11:00.000Z', endedAt: '2026-10-19T04:27:57.000Z',
    batches: 1, bytes: 11, lastSavedAt: '2026-10-19T04:20:00.000Z', coveredSections: ['intro'], remainingSections: ['body', 'close'],
    finalCheck: checkpointFinalCheck(PLAN, records, 0), expiresAt: '2026-11-18T04:27:57.000Z', pinned: false,
    ...overrides,
  };
}

describe('the person\'s view of saved batches (§7.2)', () => {
  // §7.2: "在 SECURITY/USAGE 告知并提供查看/删除 … 删除/过期后清楚显示 unavailable".
  it('lists a task with its state, coverage, size and how long it is kept, and a removed one as no longer available', () => {
    expect(savedBatchesPick(summary(), 'Content Strategist')).toEqual({
      label: '$(archive) Content Strategist · Draft the PolyFlow article.',
      description: 'stopped — draft · 1 batch(es) · 0.0 KiB',
      detail: 'Covered intro · remaining body, close · last saved 2026-10-19T04:20:00.000Z · kept until 2026-11-18T04:27:57.000Z',
    });
    expect(savedBatchesPick(summary({ state: 'running', pinned: true, expiresAt: undefined }), 'W').detail).toContain('kept while the task runs');
    expect(savedBatchesPick(summary({ batches: 0, removed: { reason: 'expired', at: '2026-11-18T05:00:00.000Z' } }), 'W')).toMatchObject({
      description: 'expired 2026-11-18T05:00:00.000Z', detail: 'Its saved batches are no longer available.',
    });
    // v0.9.99: a finished task's batches removed automatically say so, and are not called expired or deleted.
    expect(savedBatchesPick(summary({ batches: 0, removed: { reason: 'reclaimed', at: '2026-11-18T05:00:00.000Z' } }), 'W').description)
      .toBe('removed automatically 2026-11-18T05:00:00.000Z');
    expect(savedBatchesPick(summary({ batches: 0, removed: { reason: 'deleted', at: '2026-11-18T05:00:00.000Z' } }), 'W').description)
      .toBe('deleted 2026-11-18T05:00:00.000Z');
  });

  // §7.2: "恢复须用户主动选择，绝不自动发送或重新执行".
  it('opens a stopped task\'s draft saying what it is, with each section under its exact revision', () => {
    const text = savedBatchesDocument(summary(), 'Content Strategist', [record(1, 'intro', 'Intro text.')]);
    expect(text).toContain('<!-- UnodeAi saved batches, opened by you. Nothing here was sent anywhere. -->');
    expect(text).toContain('<!-- This task was stopped. These are the batches UnodeAi confirmed before the stop: a draft, not a delivered result. -->');
    expect(text).toContain('final check: INCOMPLETE: missing body, close');
    expect(text).toContain('[section intro · revision 1 · checkpoint ckpt-1 · sha256 ');
    expect(text).toContain('Intro text.');
    // An objective cannot close the comment it is shown in.
    expect(savedBatchesDocument(summary({ objective: 'end --> here' }), 'W', [])).toContain('end - -> here');
    expect(savedBatchesDeletePrompt(summary())).toBe('Delete the 1 saved batch(es) of "Draft the PolyFlow article."? They are removed from this machine and cannot be recovered.');
  });

  // §7.2: "PM/UI 能看到'已保存第 N 批、已覆盖/剩余、最后保存时间'"; §7.1: "四分钟仍无可读成果显示'尚无可恢复工作产品'".
  it('says on a running task\'s row what it saved, that a batch is due, or that nothing recoverable exists yet', () => {
    expect(workProductLabel({ state: 'on-track', activeMsSinceProduct: 0 }, summary({ state: 'running' })))
      .toBe('batch 1 saved · 1/3 sections · last saved 04:20:00 UTC');
    expect(workProductLabel({ state: 'checkpoint-due', activeMsSinceProduct: 130_000 }, summary({ state: 'running' })))
      .toBe('batch 1 saved · 1/3 sections · last saved 04:20:00 UTC · a batch is due');
    expect(workProductLabel({ state: 'no-recoverable-product', activeMsSinceProduct: 250_000 }, undefined))
      .toBe('no recoverable work product yet after 4 min');
    expect(workProductLabel({ state: 'on-track', activeMsSinceProduct: 10_000 }, undefined)).toBe('no batch saved yet');
  });

  it('shows those words in the Team row of the agent working on the task, escaped', () => {
    const session = {
      id: 'writer', status: 'running', restartCount: 0, currentTask: 'draft',
      config: { id: 'writer', name: 'Content Strategist', role: 'custom', model: 'm', provider: { providerId: 'claude-code' }, systemPrompt: '' },
    };
    const provider = new TeamViewProvider({} as never, { getAll: () => [session] } as never, new MessageBus(), '');
    provider.setWorkProductStatus((agentId) => agentId === 'writer' ? 'no recoverable work product yet after 4 min <b>' : undefined);
    provider.setDelegationProgress([{
      agentId: 'writer', status: 'working', task: 'Draft the article', coordinatorName: 'PM', stepCount: 3,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }] as never);
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    expect(html).toContain('on Draft the article for PM · no recoverable work product yet after 4 min &lt;b&gt;');
    expect(html).not.toContain('<b>');
  });
});
