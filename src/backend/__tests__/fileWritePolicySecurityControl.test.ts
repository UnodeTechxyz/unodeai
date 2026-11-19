import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileWritePolicy, prepareNativeFileChanges, recheckNativeFileChanges, type OverwriteDecisionRequest, type SecurityControlWrite, type OverwriteDecision } from '../fileWritePolicy';
import type { SecurityControlArtifactLocation } from '../../security/SecurityControlArtifacts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-controls-'));
  roots.push(root);
  const file = path.join(root, 'settings.json');
  const original = Buffer.from('{"unode.commandApproval":"ask","editor.fontSize":14}');
  await fs.writeFile(file, original);
  const state = { turn: 'first', request: 'request-one', locations: [{ kind: 'user-settings', path: file }] as SecurityControlArtifactLocation[] };
  let answer: (request: OverwriteDecisionRequest) => Promise<OverwriteDecision> = async () => 'once';
  const decide = vi.fn((request: OverwriteDecisionRequest) => answer(request));
  const policy = new FileWritePolicy({ workspaceId: () => root, securityControls: () => state.locations });
  const writes = policy.forAgent({ agentId: 'agent', requestId: () => state.request, turnId: () => state.turn, decide });
  const change = async (after?: Buffer, effect: SecurityControlWrite['effect'] = 'replace'): Promise<SecurityControlWrite> => {
    const observed = await writes.observe(file);
    return { physical: file, display: 'User settings', observed: observed.state, before: observed.bytes, after, effect };
  };
  return { root, file, original, state, decide, writes, change, setAnswer: (next: typeof answer) => { answer = next; } };
}

describe('security controls through the existing file-write policy', () => {
  it('a per-call human note survives normalization, while a cancelled decline note is discarded and no note is remembered', async () => {
    const h = await fixture(); const stop = new AbortController(); const note = 'HUMAN-CONTROL-NOTE';
    h.setAnswer(async () => ({ action: 'deny', userNote: note }));
    const proposal = await h.change(Buffer.from('{"unode.commandApproval":"all"}'));
    expect(await h.writes.authorizeSecurityControlChange(proposal)).toMatchObject({ status: 'refused', reason: 'declined', userNote: note });
    h.setAnswer(async () => { stop.abort(); return { action: 'deny', userNote: 'LATE-NOTE' }; });
    expect(await h.writes.authorizeSecurityControlChange({ ...proposal, signal: stop.signal })).toEqual({ status: 'refused', reason: 'ended' });
    h.setAnswer(async () => 'deny');
    expect(await h.writes.authorizeSecurityControlChange(proposal)).toEqual({ status: 'refused', reason: 'declined' });
  });
  it('does not ask for ordinary settings, identical bytes or an ordinary file', async () => {
    const h = await fixture();
    for (const after of [h.original, Buffer.from('{"unode.commandApproval":"ask","editor.fontSize":18}')]) {
      const authorization = await h.writes.authorizeSecurityControlChange(await h.change(after));
      expect(authorization.status).toBe('ready');
      if (authorization.status === 'ready') { expect(authorization.required).toBe(false); expect(await authorization.recheck()).toBeUndefined(); }
    }
    h.state.locations = [];
    const authorization = await h.writes.authorizeSecurityControlChange(await h.change(Buffer.from('ordinary source text')));
    expect(authorization).toMatchObject({ status: 'ready', required: false });
    expect(h.decide).not.toHaveBeenCalled();
  });

  it('asks once for the exact security change and revalidates the actual file before committing it', async () => {
    const h = await fixture();
    const after = Buffer.from('{"unode.commandApproval":"all","editor.fontSize":14}');
    const authorization = await h.writes.authorizeSecurityControlChange(await h.change(after));
    expect(authorization).toMatchObject({ status: 'ready', required: true });
    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(h.decide.mock.calls[0][0]).toMatchObject({ purpose: 'security-control', before: h.original.toString(), after: after.toString() });
    if (authorization.status === 'ready' && !await authorization.recheck()) await fs.writeFile(h.file, after);
    expect(await fs.readFile(h.file)).toEqual(after);
  });

  it('a denied change cannot write and a missing approver never supplies consent', async () => {
    const h = await fixture(); h.setAnswer(async () => 'deny');
    const proposal = await h.change(Buffer.from('{"unode.commandApproval":"all"}'));
    expect(await h.writes.authorizeSecurityControlChange(proposal)).toMatchObject({ status: 'refused', reason: 'declined' });
    expect(await fs.readFile(h.file)).toEqual(h.original);
    const policy = new FileWritePolicy({ workspaceId: () => h.root, securityControls: () => h.state.locations });
    expect(await policy.forAgent({ agentId: 'no-ui' }).authorizeSecurityControlChange(proposal))
      .toMatchObject({ status: 'refused', reason: 'unavailable' });
  });

  it('unknown native contents cannot approve a security change while ordinary native targets remain usable', async () => {
    const h = await fixture();
    expect(await h.writes.authorizeSecurityControlChange(await h.change()))
      .toMatchObject({ status: 'refused', reason: 'content-unknown' });
    expect(h.decide).not.toHaveBeenCalled();
    h.state.locations = [];
    expect(await h.writes.authorizeSecurityControlChange(await h.change())).toMatchObject({ status: 'ready', required: false });
  });

  it('removing authority keys or the whole settings file requires its own exact decision', async () => {
    const h = await fixture();
    expect(await h.writes.authorizeSecurityControlChange(await h.change(undefined, 'remove')))
      .toMatchObject({ status: 'ready', required: true });
    expect(h.decide.mock.calls[0][0].operation).toBe('delete');
    expect(await h.writes.authorizeSecurityControlChange(await h.change(Buffer.from('{"editor.fontSize":14}'))))
      .toMatchObject({ status: 'ready', required: true });
    expect(h.decide).toHaveBeenCalledTimes(2);
  });

  it('replacement contents, target state, authority location and turn remain bound after the decision', async () => {
    for (const ending of ['bytes', 'file', 'location', 'turn', 'request', 'stop'] as const) {
      const h = await fixture(); const stop = new AbortController();
      const after = Buffer.from('{"unode.commandApproval":"all"}');
      const authorization = await h.writes.authorizeSecurityControlChange({ ...await h.change(after), signal: stop.signal });
      expect(authorization.status).toBe('ready');
      if (ending === 'bytes') after.fill(32);
      if (ending === 'file') await fs.writeFile(h.file, h.original.toString().replace('14', '18'));
      if (ending === 'location') h.state.locations = [];
      if (ending === 'turn') h.state.turn = 'next';
      if (ending === 'request') h.state.request = 'request-two';
      if (ending === 'stop') stop.abort();
      if (authorization.status === 'ready') expect(await authorization.recheck(), ending).toContain('Nothing was changed');
      expect(h.decide).toHaveBeenCalledTimes(1);
    }
  });

  it('a newly protected location cannot reuse an ordinary preparation', async () => {
    const h = await fixture(); h.state.locations = [];
    const authorization = await h.writes.authorizeSecurityControlChange(await h.change(Buffer.from('{"unode.commandApproval":"all"}')));
    expect(authorization).toMatchObject({ status: 'ready', required: false });
    h.state.locations = [{ kind: 'user-settings', path: h.file }];
    if (authorization.status === 'ready') expect(await authorization.recheck()).toContain('Nothing was changed');
    expect(h.decide).not.toHaveBeenCalled();
  });

  it('distinct invalid UTF-8 bytes in a control artifact cannot compare as identical text', async () => {
    const h = await fixture(); h.state.locations = [{ kind: 'global-state', path: h.file, binaryState: true }];
    await fs.writeFile(h.file, Buffer.from([0x80]));
    const authorization = await h.writes.authorizeSecurityControlChange(await h.change(Buffer.from([0x81])));
    expect(authorization).toMatchObject({ status: 'ready', required: true });
    expect(h.decide).toHaveBeenCalledTimes(1);
  });

  it('native patches derive their proposal from admitted bytes before the one security decision', async () => {
    const h = await fixture();
    const prepared = await prepareNativeFileChanges(h.writes, [h.root], h.root, [{ path: h.file, operation: 'update',
      deriveAfter: before => Buffer.from(before!.toString().replace('"ask"', '"all"')) }]);
    expect(prepared.ok).toBe(true);
    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(h.decide.mock.calls[0][0]).toMatchObject({ purpose: 'security-control', after: h.original.toString().replace('"ask"', '"all"') });
    if (prepared.ok) {
      expect(prepared.changes[0].controls?.required).toBe(true);
      expect(prepared.changes[0].expected).toMatch(/^[a-f0-9]{64}$/);
      expect(await recheckNativeFileChanges(h.writes, prepared.changes)).toBeUndefined();
      h.state.turn = 'replacement-turn';
      expect(await recheckNativeFileChanges(h.writes, prepared.changes)).toContain('Nothing was changed');
      h.state.turn = 'first';
      await fs.writeFile(h.file, 'another request changed it');
      expect(await recheckNativeFileChanges(h.writes, prepared.changes)).toContain('Nothing was changed');
    }
  });

  it('an inapplicable native control patch asks nothing and an ordinary patch keeps the unknown-result behavior', async () => {
    const h = await fixture();
    const intent = { path: h.file, operation: 'update' as const, deriveAfter: () => { throw new Error('patch mismatch'); } };
    expect(await prepareNativeFileChanges(h.writes, [h.root], h.root, [intent]))
      .toMatchObject({ ok: false, refusal: 'safety-limit', reason: expect.stringContaining('exact proposed') });
    expect(h.decide).not.toHaveBeenCalled();
    h.state.locations = [];
    const ordinary = await prepareNativeFileChanges(h.writes, [h.root], h.root, [intent]);
    expect(ordinary.ok).toBe(true);
    if (ordinary.ok) expect(ordinary.changes[0].expected).toBeUndefined();
  });

  it('a late human answer cannot authorize a security change from an ended request', async () => {
    for (const ending of ['stop', 'turn', 'request'] as const) for (let repeat = 0; repeat < 25; repeat++) {
      const h = await fixture(); const stop = new AbortController();
      let enter!: () => void, answer!: (value: 'once') => void;
      const entered = new Promise<void>(done => { enter = done; });
      const pending = new Promise<'once'>(done => { answer = done; });
      h.setAnswer(async () => { enter(); return pending; });
      const authorization = h.writes.authorizeSecurityControlChange({
        ...await h.change(Buffer.from('{"unode.commandApproval":"all"}')), signal: stop.signal,
      });
      await entered;
      if (ending === 'stop') stop.abort();
      if (ending === 'turn') h.state.turn = 'replacement-turn';
      if (ending === 'request') h.state.request = 'replacement-request';
      answer('once');
      expect(await authorization).toEqual({ status: 'refused', reason: 'ended' });
      expect(await fs.readFile(h.file)).toEqual(h.original);
    }
  }, 30_000);
});
