import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTools, type WriteApprover } from '../WorkspaceTools';
import { FileWritePolicy, type HostObservedFileEffect, type OverwriteDecisionRequest, type OwnEffectRecord, type OverwriteDecision } from '../fileWritePolicy';
import { modelFacingToolOutput } from '../toolSummary';
import { SecurityControlLocationAdapter } from '../../security/SecurityControlLocations';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { OpenAICompatBackend, type FetchFn } from '../OpenAICompatBackend';
import type { AgentConfig } from '../../types';
import { admitUserTurn, attachment, attachmentIds } from './attachmentSaveFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const settingsText = (approval = 'all', theme = 'Public theme') => JSON.stringify({
  'unode.commandApproval': approval, 'workbench.colorTheme': theme, 'editor.fontSize': 14,
}, null, 2);

async function host(options: {
  decide?: (request: OverwriteDecisionRequest) => Promise<OverwriteDecision>;
  ask?: boolean;
} = {}) {
  const root = await fs.realpath(await temporaryFolder('unode-controls-real-host-'));
  const workspace = path.join(root, 'workspace'), user = path.join(root, 'Editor', 'User');
  const storage = path.join(user, 'globalStorage', 'unode.unodeai');
  const workspaceStorage = path.join(user, 'workspaceStorage', 'public-workspace', 'unode.unodeai');
  await Promise.all([fs.mkdir(workspace), fs.mkdir(storage, { recursive: true }), fs.mkdir(workspaceStorage, { recursive: true })]);
  const settings = path.join(user, 'settings.json'); await fs.writeFile(settings, settingsText());
  await fs.writeFile(path.join(user, 'globalStorage', 'storage.json'), JSON.stringify({ userDataProfiles: [] }));
  const adapter = new SecurityControlLocationAdapter({ globalStorageUri: { scheme: 'file', fsPath: storage },
    workspaceStorageUri: { scheme: 'file', fsPath: workspaceStorage }, hostFileSystem: 'local-desktop' });
  const state = { full: true, revision: 0, trusted: true, request: 'request-1', turn: 'turn-1', ask: options.ask ?? false,
    answer: 'once' as 'once' | 'deny', now: 1_000_000, stored: [] as OwnEffectRecord[],
    decisions: [] as OverwriteDecisionRequest[], approvals: [] as Parameters<WriteApprover>[0][], effects: [] as HostObservedFileEffect[] };
  const locations = vi.fn(async (target?: string) => adapter.getLocations(target));
  const makePolicy = () => new FileWritePolicy({ workspaceId: () => 'public-workspace', securityControls: locations,
    gitPath: async () => ({ repository: false }), now: () => ++state.now,
    ownEffects: { load: () => state.stored, save: rows => { state.stored = rows.map(row => ({ ...row })); } },
    onEffect: effect => state.effects.push(effect),
  });
  let policy = makePolicy();
  const writes = (id = 'dev') => policy.forAgent({ agentId: id, base: workspace, requestId: () => state.request,
    turnId: () => state.turn, decide: async request => {
      state.decisions.push(request); return options.decide ? options.decide(request) : state.answer;
    } });
  const tools = (id = 'dev', allowed = new Set(['read', 'write']), assets?: ContentAssetStore) => {
    const t = new WorkspaceTools(workspace, allowed, id, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, () => state.ask,
      async request => { state.approvals.push(request); state.ask = false; return 'always'; },
      undefined, undefined, undefined, [], () => state.trusted, [workspace], undefined, undefined, undefined, assets);
    t.setFullFileAccess(() => state.full, () => state.revision); t.setFileWrites(writes(id)); return t;
  };
  return { root, workspace, user, storage, workspaceStorage, settings, adapter, locations, state, tools, writes,
    reopenPolicy: () => { policy = makePolicy(); } };
}

describe('security controls through real host file tools and storage locations', () => {
  it.each(['write', 'delete-file', 'delete-folder'] as const)('a protected %s decline carries the human note only to the explicit model renderer', async action => {
    const note = 'OWNER-SECURITY-INSTRUCTION "keep this"'; const h = await host({ decide: async () => ({ action: 'deny', userNote: note }) });
    const tools = h.tools(); const result = action === 'write' ? await tools.run('write_file', { path: h.settings, content: settingsText('none') })
      : action === 'delete-file' ? await tools.run('delete_file', { path: h.settings }) : await tools.run('delete_dir', { path: h.user });
    expect(result).toMatchObject({ status: 'refused', userNote: note }); expect(result.output).not.toContain(note);
    expect(modelFacingToolOutput(result)).toContain(`The user said: ${JSON.stringify(note)}`);
    expect(h.state.decisions).toHaveLength(1); expect(h.state.approvals).toEqual([]); expect(h.state.effects).toEqual([]);
    expect(JSON.stringify(h.state.stored)).not.toContain(note); expect(await fs.readFile(h.settings, 'utf8')).toBe(settingsText());
  });

  it('an ordinary file Ask can decline with a note without accidentally allowing the new decision object', async () => {
    const h = await host({ ask: true }); const tools = h.tools(); const note = 'ORDINARY-FILE-INSTRUCTION';
    (tools as any).requestWriteApproval = async () => ({ action: 'deny', userNote: note });
    const file = path.join(h.workspace, 'draft.txt'); const result = await tools.run('write_file', { path: file, content: 'not approved' });
    expect(result).toMatchObject({ status: 'refused', userNote: note }); expect(modelFacingToolOutput(result)).toContain(note);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('Full access asks once for each exact User control change despite remembered write approval and newer unrelated stored effects', async () => {
    const h = await host({ ask: true });
    let tools = h.tools();
    expect((await tools.run('write_file', { path: 'warmup.txt', content: 'ordinary reviewed work' })).status).toBe('success');
    expect(h.state.approvals).toHaveLength(1); expect(h.state.ask).toBe(false);
    expect((await tools.run('write_file', { path: h.settings, content: settingsText('none') })).status).toBe('success');
    expect(h.state.decisions).toHaveLength(1);
    expect(h.state.decisions[0]).toMatchObject({ purpose: 'security-control', operation: 'write', path: h.settings,
      securityChanges: [{ kind: 'user-settings', operation: 'write' }] });
    expect(h.state.decisions[0].before).toContain('"unode.commandApproval": "all"');
    expect(h.state.decisions[0].after).toContain('"unode.commandApproval": "none"');
    for (let index = 0; index < 4; index++) {
      expect((await tools.run('write_file', { path: `irrelevant-${index}.txt`, content: `newer ordinary row ${index}` })).status).toBe('success');
    }
    expect(h.state.stored.length).toBeGreaterThanOrEqual(6);
    h.reopenPolicy(); tools = h.tools();
    expect((await tools.run('write_file', { path: h.settings, content: settingsText('ask') })).status).toBe('success');
    expect(h.state.decisions).toHaveLength(2); expect(h.state.approvals).toHaveLength(1);
    expect(await fs.readFile(h.settings, 'utf8')).toBe(settingsText('ask'));
  });

  it('a declined control change keeps the file and does not become a remembered permission', async () => {
    const h = await host(); h.state.answer = 'deny'; const tools = h.tools();
    const refused = await tools.run('write_file', { path: h.settings, content: settingsText('none') });
    expect(refused.status).toBe('refused'); expect(refused.output).toContain('did not approve');
    expect(await fs.readFile(h.settings, 'utf8')).toBe(settingsText()); expect(h.state.effects).toEqual([]);
    h.state.answer = 'once';
    expect((await tools.run('write_file', { path: h.settings, content: settingsText('none') })).status).toBe('success');
    expect(h.state.decisions).toHaveLength(2); expect(await fs.readFile(h.settings, 'utf8')).toBe(settingsText('none'));
  });

  it('theme and font changes, no-op settings writes and ordinary source files add no security question', async () => {
    const h = await host(); const tools = h.tools();
    const ordinary = JSON.stringify({ 'unode.commandApproval': 'all', 'workbench.colorTheme': 'Another theme', 'editor.fontSize': 18 });
    expect((await tools.run('write_file', { path: h.settings, content: ordinary })).status).toBe('success');
    expect((await tools.run('write_file', { path: h.settings, content: ordinary })).status).toBe('success');
    expect((await tools.run('write_file', { path: 'source.ts', content: 'const token = await getToken(req);' })).status).toBe('success');
    expect((await tools.run('write_file', { path: 'settings.json', content: settingsText('none') })).status).toBe('success');
    expect(h.state.decisions).toEqual([]); expect(h.state.approvals).toEqual([]);
    expect(await fs.readFile(h.settings, 'utf8')).toBe(ordinary);
  });

  it('ordinary explicit Review remains active but security and Review share one exact decision', async () => {
    const h = await host({ ask: true }); const tools = h.tools();
    expect((await tools.run('write_file', { path: h.settings, content: settingsText('ask') })).status).toBe('success');
    expect(h.state.decisions).toHaveLength(1); expect(h.state.approvals).toEqual([]);
    expect(h.state.ask).toBe(true);
    expect((await tools.run('write_file', { path: 'ordinary.ts', content: 'export const ready = true;' })).status).toBe('success');
    expect(h.state.approvals).toHaveLength(1); expect(h.state.decisions).toHaveLength(1);
  });

  it('Off and Workspace Trust refuse before any security question', async () => {
    const h = await host();
    expect((await h.tools('off', new Set(['read'])).run('write_file', { path: h.settings, content: settingsText('none') })).status).toBe('refused');
    h.state.trusted = false;
    expect((await h.tools().run('write_file', { path: h.settings, content: settingsText('none') })).status).toBe('refused');
    expect(h.state.decisions).toEqual([]); expect(h.locations).not.toHaveBeenCalled();
    expect(await fs.readFile(h.settings, 'utf8')).toBe(settingsText());
  });

  it('Stop, Full revocation and revoke-reenable retire an old waiting control decision while unrelated work continues', async () => {
    for (const action of ['stop', 'revoke', 'reenable', 'replace-turn'] as const) {
      const entered = deferred(), release = deferred();
      const h = await host({ decide: async () => { entered.resolve(); await release.promise; return 'once'; } });
      const controller = new AbortController(), tools = h.tools();
      const pending = tools.run('write_file', { path: h.settings, content: settingsText('none') }, { signal: controller.signal });
      await entered.promise;
      expect((await h.tools('other').run('write_file', { path: 'independent.txt', content: 'completed while the decision waits' })).status).toBe('success');
      if (action === 'stop') controller.abort();
      else if (action === 'replace-turn') h.state.turn = 'turn-2';
      else { h.state.full = false; h.state.revision++; if (action === 'reenable') { h.state.full = true; h.state.revision++; } }
      release.resolve(); expect((await pending).status, action).not.toBe('success');
      expect(await fs.readFile(h.settings, 'utf8'), action).toBe(settingsText());
      expect(h.state.decisions, action).toHaveLength(1);
      h.state.full = true; h.state.revision++;
      expect((await tools.run('write_file', { path: h.settings, content: settingsText('ask') })).status, action).toBe('success');
      expect(h.state.decisions, action).toHaveLength(2);
    }
  });

  it('a current-file change while approval waits invalidates the old proposed replacement', async () => {
    const entered = deferred(), release = deferred();
    const h = await host({ decide: async () => { entered.resolve(); await release.promise; return 'once'; } });
    const pending = h.tools().run('write_file', { path: h.settings, content: settingsText('none') });
    await entered.promise; await fs.writeFile(h.settings, settingsText('ask', 'User changed this while waiting'));
    release.resolve(); expect((await pending).status).not.toBe('success');
    expect(await fs.readFile(h.settings, 'utf8')).toBe(settingsText('ask', 'User changed this while waiting'));
    expect(h.state.decisions).toHaveLength(1);
  });

  it('an approved alias cannot follow a directory link retargeted while the control decision waits', async () => {
    const entered = deferred(), release = deferred();
    const h = await host({ decide: async () => { entered.resolve(); await release.promise; return 'once'; } });
    const other = path.join(h.root, 'OtherUser'); await fs.mkdir(other); const otherSettings = path.join(other, 'settings.json');
    await fs.writeFile(otherSettings, settingsText('ask'));
    const alias = path.join(h.workspace, 'user-link');
    await fs.symlink(h.user, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const pending = h.tools().run('write_file', { path: path.join(alias, 'settings.json'), content: settingsText('none') });
    await entered.promise; expect(path.dirname(alias)).toBe(h.workspace);
    await fs.rm(alias, { recursive: true, force: false });
    await fs.symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
    release.resolve(); expect((await pending).status).not.toBe('success');
    expect(await fs.readFile(h.settings, 'utf8')).toBe(settingsText());
    expect(await fs.readFile(otherSettings, 'utf8')).toBe(settingsText('ask')); expect(h.state.decisions).toHaveLength(1);
  });

  it('a file or alias changed after approval while the real target queue waits cannot receive the old change', async () => {
    for (const action of ['file', 'alias'] as const) {
      const h = await host(); const entered = deferred(), release = deferred(), approved = deferred();
      const writes = h.writes(), tools = h.tools(); tools.setFileWrites(writes);
      const authorize = writes.authorizeSecurityControlChange.bind(writes);
      vi.spyOn(writes, 'authorizeSecurityControlChange').mockImplementation(async change => {
        const answer = await authorize(change); if (answer.status === 'ready' && answer.required) approved.resolve(); return answer;
      });
      const alias = path.join(h.workspace, 'approved-user-link'), other = path.join(h.root, 'OtherUser');
      await fs.mkdir(other); const otherSettings = path.join(other, 'settings.json'); await fs.writeFile(otherSettings, settingsText('ask'));
      await fs.symlink(h.user, alias, process.platform === 'win32' ? 'junction' : 'dir');
      // The actual policy queue, held by an earlier effect, keeps this approved write from committing yet.
      const held = writes.serialize(await fs.realpath(h.settings), async () => { entered.resolve(); await release.promise; });
      await entered.promise;
      const pending = tools.run('write_file', { path: action === 'alias' ? path.join(alias, 'settings.json') : h.settings,
        content: settingsText('none') });
      await approved.promise; expect(h.state.decisions).toHaveLength(1);
      if (action === 'file') await fs.writeFile(h.settings, settingsText('ask', 'Changed after approval'));
      else {
        expect(path.dirname(alias)).toBe(h.workspace); await fs.rm(alias, { recursive: true, force: false });
        await fs.symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
      }
      release.resolve(); await held;
      expect((await pending).status, action).not.toBe('success');
      expect(await fs.readFile(h.settings, 'utf8'), action).toBe(action === 'file' ? settingsText('ask', 'Changed after approval') : settingsText());
      expect(await fs.readFile(otherSettings, 'utf8'), action).toBe(settingsText('ask'));
      expect(h.state.decisions).toHaveLength(1);
    }
  });

  it('deleting only an ordinary link to User controls does not ask to remove the retained controls', async () => {
    const h = await host(), alias = path.join(h.workspace, 'user-controls-link');
    await fs.symlink(h.user, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await h.tools().run('delete_dir', { path: alias })).status).toBe('success');
    expect(h.state.decisions.filter(request => request.purpose === 'security-control')).toEqual([]);
    expect(await fs.readFile(h.settings, 'utf8')).toBe(settingsText());
    await expect(fs.lstat(alias)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('file and parent-folder deletion use one combined control decision and retain the dangerous-folder details', async () => {
    const h = await host(); const tools = h.tools(); h.state.answer = 'deny';
    expect((await tools.run('delete_file', { path: h.settings })).status).toBe('refused');
    expect(await fs.readFile(h.settings, 'utf8')).toBe(settingsText());
    h.state.answer = 'once'; expect((await tools.run('delete_file', { path: h.settings })).status).toBe('success');
    await fs.writeFile(h.settings, settingsText());
    const database = path.join(h.user, 'globalStorage', 'state.vscdb');
    await fs.writeFile(database, Buffer.concat([Buffer.from('SQLite format 3\0public fixture'), Buffer.from([0xff, 0x80])]));
    await fs.writeFile(path.join(h.user, 'personal-notes.txt'), 'foreign ordinary file');
    const before = h.state.decisions.length;
    expect((await tools.run('delete_dir', { path: h.user })).status).toBe('success');
    expect(h.state.decisions).toHaveLength(before + 1);
    const combined = h.state.decisions.at(-1)!;
    expect(combined.purpose).toBe('security-control'); expect(combined.securityChanges?.map(change => change.kind).sort()).toEqual(['global-state', 'user-settings']);
    expect(combined.foreignFiles).toContain('personal-notes.txt'); expect(combined.preview).toContain('no restore point');
    await expect(fs.stat(h.user)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('the original admitted settings attachment reaches the same binary writer and one control decision', async () => {
    const h = await host({ ask: true }); const assets = new ContentAssetStore();
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(settingsText('none').replace(/\n/g, '\r\n'))]);
    const sources = await admitUserTurn(assets, [attachment('settings.json', 'application/json', 'file', bytes)]);
    const tools = h.tools('dev', new Set(['read', 'write']), assets); tools.setDelegationContentSources(sources);
    const result = await tools.run('save_attachment', { asset_id: attachmentIds(sources)[0], path: h.settings });
    expect(result.status).toBe('success'); expect(await fs.readFile(h.settings)).toEqual(bytes);
    expect(h.state.decisions).toHaveLength(1); expect(h.state.decisions[0].purpose).toBe('security-control');
    expect(h.state.approvals).toEqual([]); assets.dispose();
  });

  it('a declined binary settings save keeps its per-call human note without touching the admitted bytes', async () => {
    const note = 'BINARY-DECLINE-INSTRUCTION'; const h = await host({ decide: async () => ({ action: 'deny', userNote: note }) });
    const assets = new ContentAssetStore();
    try {
      const sources = await admitUserTurn(assets, [attachment('settings.json', 'application/json', 'file', Buffer.from(settingsText('none')))]);
      const tools = h.tools('dev', new Set(['read', 'write']), assets); tools.setDelegationContentSources(sources);
      const result = await tools.run('save_attachment', { asset_id: attachmentIds(sources)[0], path: h.settings });
      expect(result).toMatchObject({ status: 'refused', userNote: note }); expect(result.output).not.toContain(note);
      expect(modelFacingToolOutput(result)).toContain(`The user said: ${JSON.stringify(note)}`);
      expect(await fs.readFile(h.settings, 'utf8')).toBe(settingsText()); expect(h.state.effects).toEqual([]);
    } finally { assets.dispose(); }
  });

  it('the real engine keeps Plan before the control question and asks once for the subsequent Act write', async () => {
    const h = await host(); const after = settingsText('none');
    const config: AgentConfig = { id: 'dev', name: 'Public Dev', role: 'developer', skill: '', systemPrompt: '',
      provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'public-test-model',
      workingDirectory: h.workspace, autoApprove: true, allowedTools: ['read', 'write'] };
    const call = (id: string) => ({ choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: h.settings, content: after }) } }] } }] });
    const reply = { choices: [{ message: { role: 'assistant', content: 'Finished.' } }] };
    const responses = [call('plan'), reply, call('act'), reply];
    const fetchFn: FetchFn = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(responses.shift() ?? reply) });
    const backend = new OpenAICompatBackend(config, fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { fileWrites: h.writes(), fullFileAccess: () => h.state.full, fullFileAccessRevision: () => h.state.revision });
    try {
      await backend.start({ ROAM_API_KEY: 'public-fixture' });
      const turn = (mode: 'plan' | 'act') => new Promise<void>(resolve => {
        const off = backend.onEvent(event => { if (event.kind === 'turn_complete') { off(); resolve(); } });
        backend.sendUserTurn('Apply the requested public fixture settings change.', { mode });
      });
      await turn('plan'); expect(h.state.decisions).toEqual([]); expect(await fs.readFile(h.settings, 'utf8')).toBe(settingsText());
      await turn('act'); expect(h.state.decisions).toHaveLength(1); expect(await fs.readFile(h.settings, 'utf8')).toBe(after);
    } finally { await backend.stop(); }
  });
});
