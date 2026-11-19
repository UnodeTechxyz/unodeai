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
import { SessionLocalReadScopeConsent, type LivePathAccess } from '../localReadScope';
import { WorkspaceTools } from '../WorkspaceTools';

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

async function fixture(options: { decide?: (request: OverwriteDecisionRequest) => Promise<'once' | 'deny'>; platform?: NodeJS.Platform;
  ask?: boolean; approve?: () => Promise<'once' | 'deny'>; livePathAccess?: LivePathAccess;
  fullFileAccess?: () => boolean; fullFileAccessRevision?: () => unknown;
  hostFileTools?: (root: string) => WorkspaceTools } = {}) {
  const root = realpathSync.native(await temporaryFolder('unode-p2-claude-'));
  const state = { dirty: [] as string[], request: 'r1', decisions: [] as OverwriteDecisionRequest[], notices: [] as string[] };
  const policy = new FileWritePolicy({
    workspaceId: () => 'w',
    dirtyEditorPaths: () => state.dirty,
    gitPath: async () => ({ repository: false }),
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const fileWrites = policy.forAgent({
    agentId: 'claude-1',
    requestId: () => state.request,
    notice: message => state.notices.push(message),
    decide: async (request) => { state.decisions.push(request); return options.decide ? options.decide(request) : 'once'; },
  });
  const backend = new ClaudeHeadlessBackend(config(root), undefined, undefined, { fileWrites,
    livePathAccess: options.livePathAccess,
    fullFileAccess: options.fullFileAccess, fullFileAccessRevision: options.fullFileAccessRevision,
    hostFileTools: options.hostFileTools?.(root),
    writeApprovalAsk: () => options.ask ?? false, requestWriteApproval: options.approve });
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
  return { root, state, gate, ran, backend };
}

describe('Claude native writes at PreToolUse (review resolution §2, §3)', () => {
  it('Full access reaches the real hook after irrelevant roots and keeps task Plan and tool ceilings', async () => {
    const outside = await temporaryFolder('unode-full-native-');
    const irrelevant = await Promise.all([1, 2, 3].map(() => temporaryFolder('unode-full-newer-')));
    const target = path.join(outside, 'report.txt');
    let full = false;
    let tools!: WorkspaceTools;
    const h = await fixture({ fullFileAccess: () => full, hostFileTools: (root) => {
      tools = new WorkspaceTools(root, new Set(['read', 'write']), undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, irrelevant);
      return tools;
    } });
    const input = { file_path: target, content: 'outside effect' };
    expect((await h.gate('Write', input, 'toolu_full_before')).allow).toBe(false);
    full = true;
    expect((await h.gate('Write', input, 'toolu_full_allowed')).allow).toBe(true);
    await h.ran('Write', input, 'toolu_full_allowed', () => fs.writeFile(target, 'outside effect'));
    expect(await fs.readFile(target, 'utf8')).toBe('outside effect');
    tools.setTurnWorkspaceAccess({ pathBase: h.root, readRoots: [h.root], writeRoots: [h.root] });
    expect((await h.gate('Write', { file_path: path.join(outside, 'scoped.txt'), content: 'no' }, 'toolu_full_scoped')).allow).toBe(false);
    tools.setTurnWorkspaceAccess(undefined);
    (h.backend as any).activeTurnMode = 'plan';
    expect((await h.gate('Write', input, 'toolu_full_plan')).allow).toBe(false);
    (h.backend as any).activeTurnMode = 'act';
    (h.backend as any).config.allowedTools = ['read'];
    expect((await h.gate('Write', input, 'toolu_full_off')).allow).toBe(false);
  });

  it('Full access removal and re-enable cannot revive a native write waiting for Ask', async () => {
    const outside = await temporaryFolder('unode-full-native-revoked-');
    const target = path.join(outside, 'report.txt');
    let full = true, revision = 0;
    const h = await fixture({ fullFileAccess: () => full, fullFileAccessRevision: () => revision,
      hostFileTools: (root) => new WorkspaceTools(root, new Set(['read', 'write'])),
      ask: true, approve: async () => { full = false; revision++; full = true; revision++; return 'once'; } });
    const result = await h.gate('Write', { file_path: target, content: 'stale' }, 'toolu_full_stale');
    expect(result.allow).toBe(false);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Full access native Read evidence avoids a false foreign-file notice for the outside file just read', async () => {
    const outside = await temporaryFolder('unode-full-native-read-');
    const target = path.join(outside, 'report.txt');
    const unread = path.join(outside, 'unread.txt');
    await fs.writeFile(target, 'original');
    await fs.writeFile(unread, 'original');
    const h = await fixture({ fullFileAccess: () => true,
      hostFileTools: (root) => new WorkspaceTools(root, new Set(['read', 'write'])) });
    expect((await h.gate('Read', { file_path: target }, 'toolu_full_read')).allow).toBe(true);
    await h.ran('Read', { file_path: target }, 'toolu_full_read');
    expect((await h.gate('Write', { file_path: target, content: 'updated' }, 'toolu_full_after_read')).allow).toBe(true);
    await h.ran('Write', { file_path: target, content: 'updated' }, 'toolu_full_after_read', () => fs.writeFile(target, 'updated'));
    expect(await fs.readFile(target, 'utf8')).toBe('updated');
    expect(h.state.notices).toEqual([]);
    // v0.9.99 deliberately continues ordinary foreign-file edits and reports the concern after the effect.
    // A different file never read in this request still gets that notice; Full access does not suppress it.
    expect((await h.gate('Write', { file_path: unread, content: 'updated' }, 'toolu_full_unread')).allow).toBe(true);
    await h.ran('Write', { file_path: unread, content: 'updated' }, 'toolu_full_unread', () => fs.writeFile(unread, 'updated'));
    expect(h.state.notices).toHaveLength(1);
    expect(h.state.notices[0]).toContain('unread.txt');
    expect(h.state.notices[0]).toContain('had changes UnodeAi did not make');
    expect(h.state.decisions).toEqual([]);
  });

  it('a native Read that succeeded outside every writable folder is no refused write and offers nothing (v0.9.102 field T2)', async () => {
    // Field T2: Claude CLI spilled a large tool result to its own tool-results file and read it back. Keeping that Read
    // as write evidence asked the write resolver, which reported a refused Read + Write and the person was offered it.
    const cliOwn = await temporaryFolder('unode-cli-tool-results-');
    const spilled = path.join(cliOwn, 'toolu_1.json');
    await fs.writeFile(spilled, '{"output":"large"}');
    const reported: Array<string | undefined> = [];
    const h = await fixture({ hostFileTools: (root) => {
      const tools = new WorkspaceTools(root, new Set(['read', 'write']));
      tools.setOutsideRootObserver((_target, access) => reported.push(access));
      return tools;
    } });
    await h.ran('Read', { file_path: spilled }, 'toolu_cli_read');
    expect(reported).toEqual([]);
    expect(h.state.notices).toEqual([]);
    // A change there is still refused, and that refusal still asks for Read + Write.
    expect((await h.gate('Write', { file_path: spilled, content: 'changed' }, 'toolu_cli_write')).allow).toBe(false);
    expect(reported).toEqual(['readwrite']);
    expect(await fs.readFile(spilled, 'utf8')).toBe('{"output":"large"}');
  });

  it('Full access reaches the actual read-only files bridge without widening its write capability', async () => {
    const outside = await temporaryFolder('unode-full-native-bridge-');
    const target = path.join(outside, 'input.txt');
    await fs.writeFile(target, 'bridge input');
    let full = false;
    const h = await fixture({ fullFileAccess: () => full });
    try {
      await (h.backend as any).prepareFilesBridge(h.root);
      const tools = (h.backend as any).filesBridgeTools as WorkspaceTools;
      expect((await tools.run('read_file', { path: target })).status).not.toBe('success');
      full = true;
      expect((await tools.run('read_file', { path: target })).output).toContain('bridge input');
      expect((await tools.run('write_file', { path: target, content: 'no' })).status).toBe('refused');
      expect(await fs.readFile(target, 'utf8')).toBe('bridge input');
    } finally { await h.backend.stop(); }
  });

  it('rechecks the named physical target after Ask even when both files hold identical bytes', async () => {
    const { root, gate } = await fixture({ ask: true, approve: async () => {
      const alias = path.join(root, 'alias');
      if (process.platform === 'win32') await fs.rmdir(alias); else await fs.unlink(alias);
      await fs.symlink(path.join(root, 'two'), alias, linkKind);
      return 'once';
    } });
    for (const folder of ['one', 'two']) {
      await fs.mkdir(path.join(root, folder));
      await fs.writeFile(path.join(root, folder, 'a.txt'), 'identical');
    }
    await fs.symlink(path.join(root, 'one'), path.join(root, 'alias'), linkKind);
    const decision = await gate('Write', { file_path: path.join(root, 'alias', 'a.txt'), content: 'changed' }, 'toolu_changed_target');
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('another physical target');
    expect(await fs.readFile(path.join(root, 'one', 'a.txt'), 'utf8')).toBe('identical');
    expect(await fs.readFile(path.join(root, 'two', 'a.txt'), 'utf8')).toBe('identical');
  });

  it('the hook keeps a task ceiling, Off and Plan even with a live outside write grant', async () => {
    const owner = new SessionLocalReadScopeConsent(async () => false);
    const outside = realpathSync.native(await temporaryFolder('unode-live-hook-ceiling-'));
    const target = path.join(outside, 'target.txt');
    await owner.requestPathAccess(target, { requestId: 'r1', isCurrent: () => true }, async () => ({ permission: 'readwrite', lifetime: 'request' }));
    const source = () => owner.pathAccessFor('r1');
    let tools!: WorkspaceTools;
    const { gate, backend } = await fixture({ livePathAccess: source, hostFileTools: (root) => {
      tools = new WorkspaceTools(root, new Set(['read', 'write']));
      tools.setLivePathAccess(source);
      tools.setTurnWorkspaceAccess({ pathBase: root, readRoots: [root], writeRoots: [root] });
      return tools;
    } });
    const input = { file_path: target, content: 'change' };
    expect((await gate('Write', input, 'toolu_scoped')).allow).toBe(false);
    tools.setTurnWorkspaceAccess(undefined);
    expect((await gate('Write', input, 'toolu_unscoped')).allow).toBe(true);
    (backend as any).activeTurnMode = 'plan';
    expect((await gate('Write', input, 'toolu_plan')).allow).toBe(false);
    (backend as any).activeTurnMode = 'act';
    (backend as any).config.allowedTools = ['read'];
    expect((await gate('Write', input, 'toolu_off')).allow).toBe(false);
  });

  it('a live exact-file grant reaches the next real hook call without restarting Claude or granting a sibling', async () => {
    const owner = new SessionLocalReadScopeConsent(async () => false);
    const source = () => owner.pathAccessFor('r1');
    const { root, gate } = await fixture({ livePathAccess: source });
    const outside = realpathSync.native(await temporaryFolder('unode-live-hook-'));
    const target = path.join(outside, 'target.txt');
    const input = { file_path: target, content: 'authorized' };
    expect((await gate('Write', input, 'toolu_before')).allow).toBe(false);
    const grant = await owner.requestPathAccess(target, { requestId: 'r1', isCurrent: () => true },
      async () => ({ permission: 'readwrite', lifetime: 'request' }));
    for (let i = 0; i < 4; i++) await owner.requestPathAccess(path.join(root, `later-${i}.txt`),
      { requestId: 'r1', isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'session' }));
    expect((await gate('Write', input, 'toolu_after')).allow).toBe(true);
    expect((await gate('Write', { ...input, file_path: path.join(outside, 'sibling.txt') }, 'toolu_sibling')).allow).toBe(false);
    owner.revokePathAccess(grant!.id);
    expect((await gate('Write', input, 'toolu_revoked')).allow).toBe(false);
  });

  it('a native Ask answer cannot use a revoked lease even when the same file was regranted', async () => {
    const owner = new SessionLocalReadScopeConsent(async () => false);
    const outside = realpathSync.native(await temporaryFolder('unode-live-hook-ask-'));
    const target = path.join(outside, 'target.txt');
    const grant = await owner.requestPathAccess(target, { requestId: 'r1', isCurrent: () => true },
      async () => ({ permission: 'readwrite', lifetime: 'request' }));
    let asked = 0;
    const { gate } = await fixture({ livePathAccess: () => owner.pathAccessFor('r1'), ask: true,
      approve: async () => {
        asked++;
        owner.revokePathAccess(grant!.id);
        await owner.requestPathAccess(target, { isCurrent: () => true }, async () => ({ permission: 'readwrite', lifetime: 'session' }));
        return 'once';
      } });
    const decision = await gate('Write', { file_path: target, content: 'stale' }, 'toolu_ask');
    expect(asked).toBe(1);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('no longer current');
  });

  // v0.9.99 (A2): unsaved editor changes no longer stop Claude's write. The editor's text is left alone and the
  // person is told in one line once the write is read back.
  it('lets Claude write a file with unsaved editor changes, asks nothing, and says so once the write is read back', async () => {
    const { root, state, gate, ran } = await fixture();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'on disk');
    state.dirty = [file];
    const input = { file_path: file, content: 'claude' };
    const decision = await gate('Write', input, 'toolu_1');
    expect(decision.allow).toBe(true);
    await ran('Write', input, 'toolu_1', () => fs.writeFile(file, 'claude'));
    expect(await fs.readFile(file, 'utf8')).toBe('claude');
    expect(state.decisions).toEqual([]);
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]).toMatch(/a\.txt" had unsaved changes in an editor when it was changed on disk\. Your unsaved text is still in the editor; when you save, VS Code lets you compare/);
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

  it('does not ask an ownership question for an unread file, then posts a truthful change notice', async () => {
    let answer: 'once' | 'deny' = 'deny';
    const { root, state, gate, ran } = await fixture({ decide: async () => answer });
    await fs.writeFile(path.join(root, 'a.txt'), 'theirs');
    expect(await gate('Write', { file_path: 'a.txt', content: 'claude' }, 'toolu_1')).toMatchObject({ allow: true });
    answer = 'once';
    expect(await gate('Write', { file_path: 'a.txt', content: 'claude' }, 'toolu_2')).toMatchObject({ allow: true });
    expect(state.decisions).toEqual([]);
    await ran('Write', { file_path: 'a.txt', content: 'claude' }, 'toolu_2', () => fs.writeFile(path.join(root, 'a.txt'), 'claude'));
    expect(state.notices.join('\n')).toContain('had changes UnodeAi did not make');
  });

  it('a decision is void when the file changes while it is open', async () => {
    const { root, gate } = await fixture({ ask: true, approve: async () => { await fs.writeFile(path.join(root, 'a.txt'), 'changed while asked'); return 'once'; } });
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
      writeApprovalAsk: () => true,
      requestWriteApproval: async () => { trusted = false; return 'once'; },
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
    expect(state.decisions).toEqual([]);
    await ran('Write', { file_path: 'made.txt', content: 'third' }, 'toolu_3', () => fs.writeFile(file, 'third'));
    expect(state.notices.join('\n')).toContain('made.txt');
  });
});
