import { describe, expect, it, vi } from 'vitest';
import { AgentConfigBuilder } from '../../roles/RoleConfig';
import { AgentRosterEdits } from '../AgentRosterEdits';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let members = [new AgentConfigBuilder().fromTemplate('contract-analyst').setId('A').build()];
  let revision = 0; let current = true;
  const writes: typeof members[] = [];
  const persist = vi.fn(async (next: typeof members) => { writes.push(structuredClone(next)); });
  const editor = new AgentRosterEdits({ members: () => members, revision: () => revision, currentWorkspace: () => current, persist });
  return { editor, persist, writes, members: () => members, change: () => { revision++; },
    replace: () => { members = structuredClone(members); }, stale: () => { current = false; } };
}

describe('staged same-host Agent Builder roster writes', () => {
  it('saves Off without waiting for Stop and keeps other work available', async () => {
    const h = fixture(); const current = h.members()[0]; const stopped = deferred();
    const next = { ...current, executePreference: 'deny' as const, allowedTools: ['read'], builtinToolDefaultsRevision: 1 as const };
    const stop = vi.fn(() => stopped.promise); const publish = vi.fn(() => { h.members()[0] = next; });
    const operation = h.editor.revokeCommands(next, current, h.editor.capture(), stop, publish);
    expect(current.allowedTools).not.toContain('execute'); expect(h.editor.admissionAllowed).toBe(true);
    expect(await operation).toBe(true); expect(publish).toHaveBeenCalledOnce();
    expect(h.writes[0][0]).toEqual(next); stopped.resolve();
  });
  it.each(['stop', 'storage'] as const)('a %s failure does not freeze the team or undo Off; next save retries it', async failure => {
    const h = fixture(); const current = h.members()[0]; const next = { ...current, executePreference: 'deny' as const,
      builtinToolDefaultsRevision: 1 as const, allowedTools: ['read'] };
    if (failure === 'storage') h.persist.mockRejectedValueOnce(new Error('failed'));
    const stop = failure === 'stop' ? async () => { throw new Error('failed'); } : async () => {};
    const operation = h.editor.revokeCommands(next, current, h.editor.capture(), stop, () => { h.members()[0] = next; });
    if (failure === 'storage') await expect(operation).rejects.toThrow('failed');
    else await expect(operation).resolves.toBe(true);
    expect(current.allowedTools).not.toContain('execute'); expect(h.editor.admissionAllowed).toBe(true);
    const pending = h.editor.overlayUnsavedOff([{ ...current, allowedTools: ['read', 'execute'], executePreference: 'allow' }]);
    if (failure === 'storage') expect(pending[0].allowedTools).not.toContain('execute');
    await h.editor.save(); expect(h.writes.at(-1)?.[0].executePreference).toBe('deny');
    await expect(h.editor.replace(h.editor.capture(), async () => 'switched')).resolves.toBe('switched');
  });
  it('recovery reloads instead of leaving a global freeze, including a failed reload', async () => {
    const h = fixture(); const reload = vi.fn(async () => {}); const notice = vi.fn();
    const editor = new AgentRosterEdits({ members: h.members, revision: () => 0, currentWorkspace: () => true,
      persist: h.persist, reloadFromFile: reload, notice });
    editor.requireRecovery(); await editor.save();
    expect(reload).toHaveBeenCalledOnce(); expect(editor.admissionAllowed).toBe(true);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('reloaded the team'));
    reload.mockRejectedValueOnce(new Error('bad disk')); editor.requireRecovery(); await editor.save();
    expect(editor.admissionAllowed).toBe(true); expect(notice).toHaveBeenCalledWith(expect.stringContaining('could not be reloaded'));
  });
  it('publishes only after the exact candidate is persisted; queued ordinary saves cannot overwrite it with the old roster', async () => {
    const h = fixture(); const pending = deferred(); h.persist.mockImplementationOnce(async next => { h.writes.push(next); await pending.promise; });
    const before = h.members()[0]; const next = { ...before, name: 'Saved', allowedTools: ['read', 'execute'] };
    const publish = vi.fn(() => { h.members()[0] = next; });
    const commit = h.editor.commit(next, before, h.editor.capture(), publish);
    const background = h.editor.save(); await Promise.resolve();
    expect(publish).not.toHaveBeenCalled(); expect(h.members()[0]).toBe(before); expect(h.persist).toHaveBeenCalledTimes(1);
    pending.resolve(); expect(await commit).toBe(true); await background;
    expect(publish).toHaveBeenCalledOnce(); expect(h.writes.map(rows => rows[0].name)).toEqual(['Saved', 'Saved']);
  });
  it('a write failure leaves the live config untouched and does not poison the write lane', async () => {
    const h = fixture(); const before = structuredClone(h.members()); h.persist.mockRejectedValueOnce(new Error('storage failed'));
    const publish = vi.fn();
    await expect(h.editor.commit({ ...before[0], name: 'not saved' }, h.members()[0], h.editor.capture(), publish)).rejects.toThrow('storage failed');
    expect(publish).not.toHaveBeenCalled(); expect(h.members()).toEqual(before);
    await h.editor.save(); expect(h.persist).toHaveBeenCalledTimes(2);
  });
  it.each(['revision', 'replacement', 'mutation', 'workspace'] as const)('refuses a stale %s before writing or publishing', async kind => {
    const h = fixture(); const current = h.members()[0]; const capture = h.editor.capture();
    if (kind === 'revision') h.change(); if (kind === 'replacement') h.replace();
    if (kind === 'mutation') current.name = 'other edit'; if (kind === 'workspace') h.stale();
    const publish = vi.fn(); expect(await h.editor.commit({ ...current, name: 'stale' }, current, capture, publish)).toBe(false);
    expect(h.persist).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  });
  it('repairs an in-flight stale write without publishing or resurrecting removed records (including A→B→A)', async () => {
    const h = fixture(); const pending = deferred(); h.persist.mockImplementationOnce(async next => { h.writes.push(next); await pending.promise; });
    const current = h.members()[0]; const publish = vi.fn();
    const commit = h.editor.commit({ ...current, name: 'candidate' }, current, h.editor.capture(), publish);
    await Promise.resolve(); h.change(); h.change(); h.members()[0].name = 'live'; pending.resolve();
    expect(await commit).toBe(false); expect(publish).not.toHaveBeenCalled();
    expect(h.writes.map(rows => rows[0].name)).toEqual(['candidate', 'live']);
  });
  it('reports failed repair rather than pretending stale persistence was rolled back', async () => {
    const h = fixture(); h.persist.mockImplementationOnce(async () => { h.change(); }).mockRejectedValueOnce(new Error('repair failed'));
    const publish = vi.fn();
    await expect(h.editor.commit(h.members()[0], h.members()[0], h.editor.capture(), publish)).rejects.toThrow('repair failed');
    expect(publish).not.toHaveBeenCalled();
  });
  it('persists a new agent before publishing it, and refuses a duplicate ID', async () => {
    const h = fixture(); const next = new AgentConfigBuilder().fromTemplate('contract-analyst').setId('B').build();
    const publish = vi.fn(() => { expect(h.writes[0]).toHaveLength(2); h.members().push(next); });
    expect(await h.editor.commit(next, undefined, h.editor.capture(), publish)).toBe(true);
    expect(await h.editor.commit(next, undefined, h.editor.capture(), publish)).toBe(false);
    expect(publish).toHaveBeenCalledOnce();
  });
  it('does not let a queued background save write into a stale workspace', async () => {
    const h = fixture(); h.stale();
    await expect(h.editor.save()).rejects.toThrow('workspace changed'); expect(h.persist).not.toHaveBeenCalled();
  });
  it('repairs storage if creation is refused after persistence', async () => {
    const h = fixture(); const next = new AgentConfigBuilder().setId('B').build();
    await expect(h.editor.commit(next, undefined, h.editor.capture(), () => { throw new Error('lane busy'); })).rejects.toThrow('lane busy');
    expect(h.writes.map(rows => rows.length)).toEqual([2, 1]); expect(h.members()).toHaveLength(1);
  });
  it('a queued integration edit cannot persist its old roster while replacement admission is reserved', async () => {
    const h = fixture(); const released = deferred();
    const replacement = h.editor.replace(h.editor.capture(), async () => { await released.promise; h.change(); });
    const publish = vi.fn(); const edit = h.editor.commitRoster(structuredClone(h.members()), h.editor.capture(), publish);
    expect(h.editor.admissionAllowed).toBe(false); released.resolve(); await replacement;
    expect(await edit).toBe(false); expect(h.persist).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  });
});
