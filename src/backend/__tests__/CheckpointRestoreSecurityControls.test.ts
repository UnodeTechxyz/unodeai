import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitCheckpointRestore, prepareCheckpointRestore, type CheckpointRestoreAuthority } from '../CheckpointRestore';
import { FileWritePolicy } from '../fileWritePolicy';
import type { SecurityControlArtifactLocation } from '../../security/SecurityControlArtifacts';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const after = Buffer.from('{"unode.commandApproval":"all","editor.fontSize":14}');
const before = Buffer.from('{"unode.commandApproval":"ask","editor.fontSize":14}');
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-restore-security-'))); folders.push(root);
  const file = path.join(root, 'settings.json'); await fs.writeFile(file, after);
  const state = { locations: [{ kind: 'user-settings', path: file }] as SecurityControlArtifactLocation[] };
  const policy = new FileWritePolicy({ workspaceId: () => root, securityControls: async () => state.locations });
  const authority: CheckpointRestoreAuthority = { isTrusted: () => true, writeRoots: () => [root], hasUnsavedChanges: () => false,
    securityControlChange: change => policy.securityControlChange(change) };
  const request = { target: file, content: { kind: 'bytes' as const, bytes: Buffer.from(before) }, expected: { kind: 'bytes' as const, sha256: sha(after) } };
  return { root, file, state, policy, authority, request };
}

describe('user restore and the real shared security classifier', () => {
  it('captures the exact security change for the existing confirmation, then restores without an agent decision', async () => {
    const h = await fixture(); const preparation = await prepareCheckpointRestore(h.request, h.authority);
    expect(preparation.status).toBe('ready'); if (preparation.status !== 'ready') throw new Error('not ready');
    expect(preparation.prepared.securityControlPreview).toMatchObject({ kind: 'user-settings', operation: 'write',
      before: after.toString(), after: before.toString(), binary: false });
    // No running agent, signal, broker or AgentFileWrites is required for the person's restore action.
    expect(await commitCheckpointRestore(preparation.prepared, h.authority)).toMatchObject({ status: 'restored' });
    expect((await fs.readFile(h.file)).equals(before)).toBe(true);
  });

  it('adds no security warning for an ordinary font change or an exact no-op', async () => {
    const h = await fixture();
    for (const bytes of [after, Buffer.from('{"unode.commandApproval":"all","editor.fontSize":18}')]) {
      const prepared = await prepareCheckpointRestore({ ...h.request, content: { kind: 'bytes', bytes } }, h.authority);
      expect(prepared.status).toBe('ready'); if (prepared.status !== 'ready') throw new Error('not ready');
      expect(prepared.prepared.securityControlPreview).toBeUndefined();
      expect(await commitCheckpointRestore(prepared.prepared, h.authority)).toMatchObject({ status: 'restored' });
      await fs.writeFile(h.file, after);
    }
  });

  it('refuses mutated proposed bytes both after confirmation wait and at the final effect boundary', async () => {
    for (let iteration = 0; iteration < 25; iteration++) for (const when of ['waiting', 'before-commit']) {
      const h = await fixture(); const preparation = await prepareCheckpointRestore(h.request, h.authority);
      if (preparation.status !== 'ready') throw new Error('not ready');
      const change = async () => { h.request.content.bytes.fill(0x78); };
      if (when === 'waiting') await change();
      const outcome = await commitCheckpointRestore(preparation.prepared, h.authority, when === 'before-commit' ? { beforeCommit: change } : {});
      expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringContaining('restore point contents changed') });
      expect((await fs.readFile(h.file)).equals(after)).toBe(true);
      expect((await fs.readdir(h.root)).sort()).toEqual(['settings.json']);
    }
  }, 30_000);

  it('refuses a changed live control list, including an ordinary file newly classified while the confirmation waits', async () => {
    for (let iteration = 0; iteration < 25; iteration++) for (const initial of ['control', 'ordinary']) for (const when of ['waiting', 'before-commit']) {
      const h = await fixture(); if (initial === 'ordinary') h.state.locations = [];
      const preparation = await prepareCheckpointRestore(h.request, h.authority); if (preparation.status !== 'ready') throw new Error('not ready');
      const change = async () => { h.state.locations = [{ kind: 'codex-auth', path: h.file }]; };
      if (when === 'waiting') await change();
      const outcome = await commitCheckpointRestore(preparation.prepared, h.authority, when === 'before-commit' ? { beforeCommit: change } : {});
      expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringContaining('classification changed') });
      expect((await fs.readFile(h.file)).equals(after)).toBe(true);
    }
  }, 30_000);

  it('refuses deletion if the control classification changes after its single confirmation', async () => {
    const h = await fixture(); const preparation = await prepareCheckpointRestore({ ...h.request, content: { kind: 'absent' } }, h.authority);
    if (preparation.status !== 'ready') throw new Error('not ready');
    expect(preparation.prepared.securityControlPreview).toMatchObject({ operation: 'delete' });
    const outcome = await commitCheckpointRestore(preparation.prepared, h.authority, {
      beforeCommit: async () => { h.state.locations = []; },
    });
    expect(outcome).toMatchObject({ status: 'refused' }); expect((await fs.readFile(h.file)).equals(after)).toBe(true);
  });

  it('discloses a mixed binary state replacement as a whole artifact and refuses an unavailable current classifier', async () => {
    const h = await fixture(); h.state.locations = [{ kind: 'global-state', path: h.file, binaryState: true }];
    const preparation = await prepareCheckpointRestore(h.request, h.authority); if (preparation.status !== 'ready') throw new Error('not ready');
    expect(preparation.prepared.securityControlPreview).toMatchObject({ kind: 'global-state', binary: true });
    h.authority.securityControlChange = async () => { throw new Error('PRIVATE-PATH-ERROR'); };
    expect(await commitCheckpointRestore(preparation.prepared, h.authority)).toEqual({ status: 'refused', reason: 'the current security-control classification could not be checked.' });
    expect((await fs.readFile(h.file)).equals(after)).toBe(true);
  });
});
