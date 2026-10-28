/*
 * v0.9.97 P5: how a CLI's native file change reaches the request effect ledger. Review resolution §2: "native
 * self-report of success is not SHA verification; read-back content does not prove who wrote it; when concurrent
 * attribution is unclear the evidence is downgraded"; "a trusted native result plus an attributable read-back of the
 * target, otherwise observed/unverified"; handoff §5: "approvals, attempts and model claims never count". P0 lead B
 * finding 9: an absolute Claude `file_path` was dropped from the closeout instead of being shown relative.
 */
import { realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import {
  FileWritePolicy,
  prepareNativeFileChanges,
  readTargetState,
  settleNativeFileChanges,
  type HostObservedFileEffect,
} from '../fileWritePolicy';
import type { AgentConfig } from '../../types';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);

async function fixture() {
  const root = realpathSync.native(await temporaryFolder('unode-p5-native-'));
  const state = { request: 'r1' as string | undefined, now: 1_000 };
  const effects: HostObservedFileEffect[] = [];
  const policy = new FileWritePolicy({
    workspaceId: () => 'w',
    gitPath: async () => ({ repository: false }),
    now: () => state.now,
    onEffect: (effect) => { effects.push(effect); },
  });
  const writes = policy.forAgent({ agentId: 'claude-1', base: root, requestId: () => state.request });
  const other = policy.forAgent({ agentId: 'dev', base: root, requestId: () => 'r-other' });
  const prepare = async (intent: Parameters<typeof prepareNativeFileChanges>[3][number]) => {
    const prepared = await prepareNativeFileChanges(writes, [root], root, [intent]);
    if (!prepared.ok) throw new Error(prepared.reason);
    return prepared.changes;
  };
  const shown = () => effects.map(({ path: shownPath, operation, grade, requestId }) => ({ path: shownPath, operation, grade, requestId }));
  return { root, state, effects, policy, writes, other, prepare, shown };
}

describe('a native change is graded by what the host reads back, never by what the CLI says', () => {
  it('is native-observed when the target holds the bytes its input fixed, for the request it was allowed under', async () => {
    const f = await fixture();
    const changes = await f.prepare({ path: 'docs/a.md', operation: 'write', after: Buffer.from('# A\n') });
    f.state.request = undefined; // the turn ended before the result was read back
    await fs.mkdir(path.join(f.root, 'docs'));
    await fs.writeFile(path.join(f.root, 'docs/a.md'), '# A\n');
    await settleNativeFileChanges(f.writes, changes, true);
    expect(f.shown()).toEqual([{ path: 'docs/a.md', operation: 'write', grade: 'native-observed', requestId: 'r1' }]);
  });

  it('names a file a CLI gave by its absolute path relative to the agent\'s folder', async () => {
    const f = await fixture();
    const absolute = path.join(f.root, 'src', 'b.ts');
    const changes = await f.prepare({ path: absolute, operation: 'write', after: Buffer.from('b') });
    await fs.mkdir(path.dirname(absolute));
    await fs.writeFile(absolute, 'b');
    await settleNativeFileChanges(f.writes, changes, true);
    expect(f.shown()).toEqual([{ path: 'src/b.ts', operation: 'write', grade: 'native-observed', requestId: 'r1' }]);
  });

  it('is effect-uncertain when the target holds other bytes than the input fixed', async () => {
    const f = await fixture();
    const changes = await f.prepare({ path: 'a.txt', operation: 'write', after: Buffer.from('planned') });
    await fs.writeFile(path.join(f.root, 'a.txt'), 'something else');
    await settleNativeFileChanges(f.writes, changes, true);
    expect(f.shown()).toEqual([{ path: 'a.txt', operation: 'write', grade: 'effect-uncertain', requestId: 'r1' }]);
  });

  it('counts nothing when the CLI reports a write it did not make', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'kept.txt'), 'as it was');
    const changes = await f.prepare({ path: 'kept.txt', operation: 'write', after: Buffer.from('claimed') });
    await settleNativeFileChanges(f.writes, changes, true);
    const missing = await f.prepare({ path: 'never.txt', operation: 'write', after: Buffer.from('claimed') });
    await settleNativeFileChanges(f.writes, missing, true);
    expect(f.effects).toEqual([]);
  });

  it('counts a failed tool only when it changed its target, and then as uncertain', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'a.txt'), 'before');
    await fs.writeFile(path.join(f.root, 'b.txt'), 'before');
    const untouched = await f.prepare({ path: 'a.txt', operation: 'write', after: Buffer.from('after') });
    await settleNativeFileChanges(f.writes, untouched, false);
    expect(f.effects).toEqual([]);
    const touched = await f.prepare({ path: 'b.txt', operation: 'write', after: Buffer.from('after') });
    await fs.writeFile(path.join(f.root, 'b.txt'), 'half');
    await settleNativeFileChanges(f.writes, touched, false);
    expect(f.shown()).toEqual([{ path: 'b.txt', operation: 'write', grade: 'effect-uncertain', requestId: 'r1' }]);
  });

  it('is a native-observed removal when the target is gone, and uncertain for a change whose bytes nothing fixed', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'gone.txt'), 'x');
    await fs.writeFile(path.join(f.root, 'nb.ipynb'), '{}');
    const removal = await f.prepare({ path: 'gone.txt', operation: 'delete' });
    const notebook = await f.prepare({ path: 'nb.ipynb', operation: 'update' });
    await fs.rm(path.join(f.root, 'gone.txt'));
    await fs.writeFile(path.join(f.root, 'nb.ipynb'), '{"cells":[]}');
    await settleNativeFileChanges(f.writes, [...removal, ...notebook], true);
    expect(f.shown()).toEqual([
      { path: 'gone.txt', operation: 'delete-file', grade: 'native-observed', requestId: 'r1' },
      { path: 'nb.ipynb', operation: 'write', grade: 'effect-uncertain', requestId: 'r1' },
    ]);
  });

  it('is downgraded to uncertain when another request changed the target meanwhile: the bytes found could be either\'s', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'shared.txt'), 'v1');
    const changes = await f.prepare({ path: 'shared.txt', operation: 'write', after: Buffer.from('v2') });
    f.state.now += 10;
    // Another request's host write lands on the same file before the native result is read back.
    await fs.writeFile(path.join(f.root, 'shared.txt'), 'v2');
    const physical = path.join(f.root, 'shared.txt');
    f.other.noteEffect(physical, (await readTargetState(physical)).state, 'host-verified', f.other.attribution(), true);
    await settleNativeFileChanges(f.writes, changes, true);
    expect(f.shown()).toEqual([
      { path: 'shared.txt', operation: 'write', grade: 'host-verified', requestId: 'r-other' },
      { path: 'shared.txt', operation: 'write', grade: 'effect-uncertain', requestId: 'r1' },
    ]);
  });
});

function claudeConfig(root: string): AgentConfig {
  return {
    id: 'claude-1', name: 'Claude Dev', role: 'developer', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-5', systemPrompt: 'Follow the role.', autoApprove: true, allowedTools: ['read', 'write'],
    backend: 'claude', workingDirectory: root,
  };
}

describe('Claude\'s native Write on the route (PreToolUse, result, read-back)', () => {
  it('reaches the ledger as native-observed, named relative to its folder, for the request it was allowed under', async () => {
    const f = await fixture();
    const backend = new ClaudeHeadlessBackend(claudeConfig(f.root), undefined, undefined, { fileWrites: f.writes });
    const file = path.join(f.root, 'notes', 'plan.md');
    const input = { file_path: file, content: '# Plan\n' };
    const decision = await (backend as any).handlePreToolUse({ tool_name: 'Write', tool_input: input, tool_use_id: 'toolu_1' });
    expect(decision.allow).toBe(true);
    await (backend as any).handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input }] } });
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, '# Plan\n');
    f.state.request = 'r-next'; // the request has moved on by the time the result arrives
    await (backend as any).handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.shown()).toEqual([{ path: 'notes/plan.md', operation: 'write', grade: 'native-observed', requestId: 'r1' }]);
  });
});
