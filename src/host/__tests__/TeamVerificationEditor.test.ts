import { describe, expect, it, vi } from 'vitest';
import { TeamVerificationEditor, type TeamVerificationEditorPort } from '../TeamVerificationEditor';
import type { TeamFileDocument } from '../../state/TeamFileSchema';
import { TeamVerificationConfigurationError } from '../../state/TeamFileSchema';

function fixture() {
  let document: TeamFileDocument | undefined = { version: '1.0', members: [], mcpServers: [], workflows: [] };
  let root = '/workspace'; let revision = 1; let skills: string[] = []; let legacy = 'npm test'; let current = true;
  const inspect = vi.fn(() => ({ globalValue: legacy, workspaceValue: 'private-workspace-command' }));
  const port: TeamVerificationEditorPort = { workspaceRoot: () => root, rosterRevision: () => revision, isCurrentWorkspace: () => current,
    skills: () => skills, members: () => [], configuration: () => ({ inspect }),
    readDocument: async () => document,
    updateDocument: vi.fn(async edit => { document = edit(document); }),
  };
  const editor = new TeamVerificationEditor(port);
  return { editor, port, inspect, get document() { return document; }, set document(value) { document = value; },
    root: (value: string) => { root = value; }, switchTeam: () => { revision++; }, skills: (value: string[]) => { skills = value; },
    legacy: (value: string) => { legacy = value; }, current: (value: boolean) => { current = value; } };
}
async function token(editor: TeamVerificationEditor) {
  const view = await editor.prepare(); expect(view.kind).toBe('ready');
  if (view.kind !== 'ready') throw new Error('test preparation failed');
  expect(view.editToken).toBeTruthy(); return view.editToken!;
}
describe('current-team completion-check form authority', () => {
  it('imports a User-only compatibility command into this team without running or changing the User setting', async () => {
    const h = fixture(); const key = await token(h.editor);
    expect(h.inspect).toHaveBeenCalledWith('verifyCommand');
    await h.editor.save(key, { mode: 'command', command: 'npm test' });
    expect(h.document?.completionVerification).toEqual({ mode: 'command', command: 'npm test' });
    await expect(h.editor.save(key, { mode: 'disabled' })).rejects.toThrow('save was not performed');
  });
  it.each(['disabled', 'auto'] as const)('persists explicit %s rather than empty-command automatic fallback', async mode => {
    const h = fixture(); await h.editor.save(await token(h.editor), { mode });
    expect(h.document?.completionVerification).toEqual({ mode });
  });
  it('preserves concurrent unrelated document fields through the actual queued callback contract', async () => {
    const h = fixture(); const key = await token(h.editor);
    h.document = { ...h.document!, smartCompactionProfiles: { balanced: { windowPercent: 60 } } };
    await h.editor.save(key, { mode: 'auto' });
    expect(h.document).toMatchObject({ completionVerification: { mode: 'auto' }, smartCompactionProfiles: { balanced: { windowPercent: 60 } } });
  });
  it.each(['source', 'legacy', 'legacy-whitespace', 'kind', 'roster', 'workspace', 'binding'])('refuses a stale %s target before it can overwrite the current document', async change => {
    const h = fixture(); const key = await token(h.editor);
    if (change === 'source') h.document = { ...h.document!, completionVerification: { mode: 'disabled' } };
    if (change === 'legacy') h.legacy('npm run lint');
    if (change === 'legacy-whitespace') h.legacy('npm test ');
    if (change === 'kind') h.skills(['market-research']);
    if (change === 'roster') { h.switchTeam(); h.switchTeam(); } // A→B→A still changed this lifecycle.
    if (change === 'workspace') h.root('/other');
    if (change === 'binding') h.current(false);
    const before = structuredClone(h.document);
    await expect(h.editor.save(key, { mode: 'auto' })).rejects.toThrow('save was not performed');
    expect(h.document).toEqual(before);
  });
  it('an old token cannot act after refresh, and invalid commands never leak into fixed errors', async () => {
    const h = fixture(); const old = await token(h.editor); const current = await token(h.editor);
    await expect(h.editor.save(old, { mode: 'disabled' })).rejects.toThrow('refreshed');
    const error = await h.editor.save(current, { mode: 'command', command: 'private-command\n' }).catch(error => error);
    expect(error.message).not.toContain('private-command'); expect(h.port.updateDocument).not.toHaveBeenCalled();
  });
  it('rechecks the exact captured root even when a replacement spelling has the same normalized policy identity (F4)', async () => {
    const h = fixture(); const key = await token(h.editor);
    h.root('/workspace/.');
    await expect(h.editor.save(key, { mode: 'disabled' })).rejects.toThrow('save was not performed');
    expect(h.document?.completionVerification).toBeUndefined();
  });
  it('revokes the previous token at refresh start, before the new read resolves (F5)', async () => {
    const h = fixture(); const old = await token(h.editor);
    let finish!: (document: TeamFileDocument | undefined) => void;
    h.port.readDocument = () => new Promise(resolve => { finish = resolve; });
    const preparing = h.editor.prepare();
    await expect(h.editor.save(old, { mode: 'disabled' })).rejects.toThrow('refreshed');
    expect(h.port.updateDocument).not.toHaveBeenCalled();
    finish(h.document);
    const view = await preparing;
    if (view.kind !== 'ready' || !view.editToken) throw new Error('refresh did not offer a new token');
    await h.editor.save(view.editToken, { mode: 'auto' });
    expect(h.document?.completionVerification).toEqual({ mode: 'auto' });
  });
  it('preserves state on storage failure and gives no success or reusable saved token', async () => {
    const h = fixture(); const key = await token(h.editor);
    h.port.updateDocument = async () => { throw new Error('write failed'); };
    await expect(h.editor.save(key, { mode: 'disabled' })).rejects.toThrow('write failed');
    expect(h.document?.completionVerification).toBeUndefined();
    await expect(h.editor.save(key, { mode: 'auto' })).rejects.toThrow('save was not performed');
  });
  it('malformed/unreadable reads are unavailable, not a new automatic configuration', async () => {
    const h = fixture(); h.port.readDocument = async () => { throw new Error('private-document'); };
    const view = await h.editor.prepare(); expect(view.kind).toBe('unavailable');
    expect(JSON.stringify(view)).not.toContain('private-document');
    await expect(h.editor.save('fake', { mode: 'auto' })).rejects.toThrow('save was not performed');
  });
  it('retains the fixed team-file repair projection for an invalid policy, without raw command text', async () => {
    const h = fixture(); h.port.readDocument = async () => { throw new TeamVerificationConfigurationError(); };
    expect(await h.editor.prepare()).toMatchObject({ kind: 'configuration-invalid', source: 'team-document', repair: 'team-file' });
  });
});
