/*
 * v0.9.97 P2: Claude's native Write/Edit/NotebookEdit under the shared write policy, decided at the PreToolUse hook
 * before the hook answers allow. Review resolution §2: "返回 allow 之前执行；不能依赖成功后的 checkpoint 事件充当前置保护"
 * (it runs before allow is returned; a checkpoint event after success is no pre-effect protection), and "若目标、
 * before-state … 无法证明，拒绝该结构化 native 操作，并建议改用同一 host 写入通道；不得回退到 shell".
 */
import { realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import type { AgentConfig } from '../../types';
import { FileWritePolicy, type OverwriteDecisionRequest } from '../fileWritePolicy';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);

const linkKind = process.platform === 'win32' ? 'junction' : 'dir';

function config(root: string): AgentConfig {
  return {
    id: 'claude-1', name: 'Claude Dev', role: 'developer', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-5', systemPrompt: 'Follow the role.', autoApprove: true, allowedTools: ['read', 'write'],
    backend: 'claude', workingDirectory: root,
  };
}

async function fixture(options: { decide?: (request: OverwriteDecisionRequest) => Promise<'once' | 'deny'>; platform?: NodeJS.Platform } = {}) {
  const root = realpathSync.native(await temporaryFolder('unode-p2-claude-'));
  const state = { dirty: [] as string[], request: 'r1', decisions: [] as OverwriteDecisionRequest[] };
  const policy = new FileWritePolicy({
    workspaceId: () => 'w',
    dirtyEditorPaths: () => state.dirty,
    gitPath: async () => ({ repository: false }),
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const fileWrites = policy.forAgent({
    agentId: 'claude-1',
    requestId: () => state.request,
    decide: async (request) => { state.decisions.push(request); return options.decide ? options.decide(request) : 'once'; },
  });
  const backend = new ClaudeHeadlessBackend(config(root), undefined, undefined, { fileWrites });
  const gate = async (tool: string, input: Record<string, unknown>, id: string) =>
    (backend as any).handlePreToolUse({ tool_name: tool, tool_input: input, tool_use_id: id }) as Promise<{ allow: boolean; reason?: string }>;
  /** What Claude does after an allow: it runs the tool, and the stream reports the call and its result. */
  const ran = async (tool: string, input: Record<string, unknown>, id: string, effect?: () => Promise<void>) => {
    await (backend as any).handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool, input }] } });
    await effect?.();
    await (backend as any).handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
    // The result is read back after the event; give that read its turn.
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { root, state, gate, ran };
}

describe('Claude native writes at PreToolUse (review resolution §2, §3)', () => {
  it('denies a file with unsaved editor changes before Claude may write it', async () => {
    const { root, state, gate } = await fixture();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'on disk');
    state.dirty = [file];
    const decision = await gate('Write', { file_path: file, content: 'claude' }, 'toolu_1');
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/unsaved changes in an editor.*does not save them/s);
    expect(state.decisions).toEqual([]);
  });

  it('denies a target outside the writable folder, by its name or through a link, and suggests no shell', async () => {
    const { root, gate } = await fixture();
    const outside = realpathSync.native(await temporaryFolder('unode-p2-claude-outside-'));
    expect((await gate('Write', { file_path: path.join(outside, 'x.txt'), content: 'x' }, 'toolu_1')).reason)
      .toMatch(/outside this agent's writable folders.*Do not use a shell command/s);
    await fs.symlink(outside, path.join(root, 'linked'), linkKind);
    expect((await gate('Write', { file_path: 'linked/x.txt', content: 'x' }, 'toolu_2')).reason).toMatch(/through a link/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses a native change whose target cannot be told, and points to Write or Edit, never a shell', async () => {
    const { gate } = await fixture();
    for (const [tool, input] of [['Write', { content: 'no path' }], ['Edit', { file_path: 'a.txt' }], ['Write', { file_path: 'a.txt' }]] as const) {
      const decision = await gate(tool, input, `toolu_${tool}`);
      expect(decision.allow, tool).toBe(false);
      expect(decision.reason, tool).toMatch(/could not tell exactly which file.*Write or Edit.*do not use a shell command/s);
    }
  });

  it('applies the Windows name rule before any file-system call', async () => {
    const { gate } = await fixture({ platform: 'win32' });
    expect((await gate('Write', { file_path: 'notes.txt:hidden', content: 'x' }, 'toolu_1')).reason).toMatch(/alternate data stream/);
  });

  it('asks once for a file this request did not read and nobody vouches for; a denial is a deny, a yes an allow', async () => {
    let answer: 'once' | 'deny' = 'deny';
    const { root, state, gate } = await fixture({ decide: async () => answer });
    await fs.writeFile(path.join(root, 'a.txt'), 'theirs');
    expect(await gate('Write', { file_path: 'a.txt', content: 'claude' }, 'toolu_1')).toMatchObject({ allow: false });
    answer = 'once';
    expect(await gate('Write', { file_path: 'a.txt', content: 'claude' }, 'toolu_2')).toMatchObject({ allow: true });
    expect(state.decisions.map((decision) => decision.path)).toEqual(['a.txt', 'a.txt']);
  });

  it('a decision is void when the file changes while it is open', async () => {
    const { root, gate } = await fixture({ decide: async () => { await fs.writeFile(path.join(root, 'a.txt'), 'changed while asked'); return 'once'; } });
    await fs.writeFile(path.join(root, 'a.txt'), 'theirs');
    const decision = await gate('Write', { file_path: 'a.txt', content: 'claude' }, 'toolu_1');
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/changed while this change waited/);
  });

  it('denies when the workspace stops being trusted while the decision is open', async () => {
    let trusted = true;
    const root = realpathSync.native(await temporaryFolder('unode-p2-claude-trust-'));
    await fs.writeFile(path.join(root, 'a.txt'), 'theirs');
    const fileWrites = new FileWritePolicy({ workspaceId: () => 'w', gitPath: async () => ({ repository: false }) })
      .forAgent({ agentId: 'claude-1', requestId: () => 'r1', decide: async () => { trusted = false; return 'once'; } });
    const backend = new ClaudeHeadlessBackend(config(root), undefined, undefined, {
      fileWrites,
      commandPermission: { isTrusted: () => trusted },
    });
    const decision = await (backend as any).handlePreToolUse({ tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'claude' }, tool_use_id: 'toolu_1' });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/disabled until this workspace is trusted/);
  });

  it('a native Read of this request is its evidence, so the write after it is not asked about', async () => {
    const { root, state, gate, ran } = await fixture();
    await fs.writeFile(path.join(root, 'a.txt'), 'read by Claude');
    await ran('Read', { file_path: path.join(root, 'a.txt') }, 'toolu_read');
    expect(await gate('Edit', { file_path: 'a.txt', old_string: 'read', new_string: 'edited' }, 'toolu_edit')).toMatchObject({ allow: true });
    expect(state.decisions).toEqual([]);
  });

  it('only a result that reads back as the change predicted becomes this host\'s own effect for the next request', async () => {
    const { root, state, gate, ran } = await fixture();
    const file = path.join(root, 'made.txt');
    // r1: a new file, written as Write said.
    expect(await gate('Write', { file_path: 'made.txt', content: 'by claude' }, 'toolu_1')).toMatchObject({ allow: true });
    await ran('Write', { file_path: 'made.txt', content: 'by claude' }, 'toolu_1', () => fs.writeFile(file, 'by claude'));
    state.request = 'r2';
    expect(await gate('Write', { file_path: 'made.txt', content: 'again' }, 'toolu_2')).toMatchObject({ allow: true });
    expect(state.decisions).toEqual([]);
    // r2's tool left something else on disk than it said: nothing of it vouches for the file.
    await ran('Write', { file_path: 'made.txt', content: 'again' }, 'toolu_2', () => fs.writeFile(file, 'something else'));
    state.request = 'r3';
    await gate('Write', { file_path: 'made.txt', content: 'third' }, 'toolu_3');
    expect(state.decisions.map((decision) => decision.path)).toEqual(['made.txt']);
  });
});
