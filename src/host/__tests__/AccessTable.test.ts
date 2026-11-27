import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AccessTable, type AccessConsumer, type AccessJudgement, type AccessTableChange } from '../AccessTable';
import type { FolderPermission } from '../../types';

/*
 * v0.9.101 (the access table design, R1-R3): the table's own rules, with the host's facts replaced by a small world:
 * folders granted per agent, agents limited to read, and a map of named paths to physical identities.
 */

const root = path.resolve('/x');
const out = path.join(root, 'out');
const file = path.join(out, 'summary.docx');
const lease = path.join(root, 'in', 'lease.docx');

function world() {
  const grants: Array<{ folder: string; permission: FolderPermission; id: string }> = [];
  const limited = new Set<string>();
  const links = new Map<string, string>();
  let judged = 0;
  const physical = (named: string) => {
    for (const [from, to] of links) {
      if (named === from || named.startsWith(from + path.sep)) return to + named.slice(from.length);
    }
    return named;
  };
  const table = new AccessTable({
    identity: (named) => physical(path.resolve(named)),
    remote: (named) => named.startsWith('\\\\') || named.startsWith('//'),
    isDirectory: (named) => !/\.[a-z]+$/.test(named),
    judge: (consumer: AccessConsumer, _requestId, named, needed, observed): AccessJudgement => {
      judged++;
      const at = observed ?? physical(named);
      const covering = grants.filter((grant) => at === grant.folder || at.startsWith(grant.folder + path.sep));
      const granted: 'none' | FolderPermission = covering.some((grant) => grant.permission === 'readwrite') ? 'readwrite'
        : covering.length ? 'read' : 'none';
      if (limited.has(consumer.agentId) && needed === 'readwrite') {
        return { state: 'limit', effective: granted === 'none' ? 'none' : 'read', source: granted === 'none' ? 'none' : 'grant', granted, grantIds: [] };
      }
      const state = granted === 'readwrite' || (granted === 'read' && needed === 'read') ? 'met'
        : granted === 'read' ? 'partial' : 'missing';
      return { state, effective: granted, source: granted === 'none' ? 'none' : 'grant', granted, grantIds: covering.map((grant) => grant.id) };
    },
  });
  const changes: AccessTableChange[] = [];
  table.onChange((change) => changes.push(change));
  return {
    table, changes, grants, limited, links,
    judged: () => judged,
    grant: (folder: string, permission: FolderPermission) => {
      grants.push({ folder, permission, id: `g${grants.length}` });
      table.inputsChanged();
    },
  };
}

const pm: AccessConsumer = { agentId: 'pm' };
const devA: AccessConsumer = { agentId: 'devA', handle: 'wait-a' };
const devB: AccessConsumer = { agentId: 'devB', handle: 'wait-b' };

describe('the access table', () => {
  it('a file needed inside a folder the person named is shown on that folder, whichever arrived first', () => {
    const first = world();
    first.table.addNeed('r1', out, pm, 'read', 'named');
    first.table.addNeed('r1', file, devA, 'readwrite', 'output');
    const folder = first.table.findTarget('r1', out)!;
    expect(first.table.findTarget('r1', file)!.shownOn).toBe(folder.id);
    expect(first.table.shownRows(folder.id).map((row) => row.named).sort()).toEqual([out, file].sort());

    const later = world();
    later.table.addNeed('r1', file, devA, 'readwrite', 'output');
    expect(later.table.findTarget('r1', file)!.shownOn).toBe(later.table.findTarget('r1', file)!.id);
    later.table.addNeed('r1', out, pm, 'read', 'named');
    expect(later.table.findTarget('r1', file)!.shownOn).toBe(later.table.findTarget('r1', out)!.id);
  });

  it('a child folder whose name starts with two dots is inside its folder: it is shown on the folder\'s item', () => {
    const w = world();
    const dotted = path.join(out, '..notes', 'x.txt');
    w.table.addNeed('r1', out, pm, 'readwrite', 'named');
    w.table.addNeed('r1', dotted, devA, 'readwrite', 'output');
    expect(w.table.findTarget('r1', dotted)!.shownOn).toBe(w.table.findTarget('r1', out)!.id);
    // A real parent is not.
    const parent = path.join(root, 'other.txt');
    w.table.addNeed('r1', parent, devA, 'read', 'input');
    expect(w.table.findTarget('r1', parent)!.shownOn).toBe(w.table.findTarget('r1', parent)!.id);
  });

  it('a remote spelling keeps its own item; another request keeps its own rows', () => {
    const w = world();
    w.table.addNeed('r1', '\\\\server\\share', pm, 'read', 'named');
    w.table.addNeed('r1', '\\\\server\\share\\out.docx', devA, 'readwrite', 'output');
    const remote = w.table.findTarget('r1', '\\\\server\\share\\out.docx')!;
    expect(remote.shownOn).toBe(remote.id);
    w.table.addNeed('r2', file, devA, 'readwrite', 'output');
    w.table.addNeed('r1', out, pm, 'read', 'named');
    expect(w.table.findTarget('r2', file)!.shownOn).toBe(w.table.findTarget('r2', file)!.id);
  });

  it('a Read on the folder leaves the write need inside partial, and Read + Write then meets it', () => {
    const w = world();
    w.table.addNeed('r1', out, pm, 'read', 'named');
    w.table.addNeed('r1', file, devA, 'readwrite', 'output');
    w.grant(out, 'read');
    expect(w.table.needState('r1', out, pm)).toBe('met');
    expect(w.table.needState('r1', file, devA)).toBe('partial');
    expect(w.table.unmet('r1').map((need) => [need.label, need.needed])).toEqual([['File summary.docx', 'readwrite']]);
    w.grant(out, 'readwrite');
    expect(w.table.needState('r1', file, devA)).toBe('met');
    expect(w.table.unmet('r1')).toEqual([]);
  });

  it('D1: one target, two consumers: each has its own state; a limited one blocks nothing else', () => {
    const w = world();
    w.limited.add('devB');
    w.table.addNeed('r1', out, devA, 'readwrite', 'output');
    w.table.addNeed('r1', out, devB, 'readwrite', 'output');
    w.grant(out, 'readwrite');
    expect(w.table.needState('r1', out, devA)).toBe('met');
    expect(w.table.needState('r1', out, devB)).toBe('limit');
    // A limit is not something a grant could still give: it is not listed as missing.
    expect(w.table.unmet('r1')).toEqual([]);
  });

  it('needs of one consumer on one target merge to the stronger access', () => {
    const w = world();
    const first = w.table.addNeed('r1', out, devA, 'read', 'input');
    const second = w.table.addNeed('r1', out, devA, 'readwrite', 'output');
    expect(second).toBe(first);
    w.grant(out, 'read');
    expect(w.table.needState('r1', out, devA)).toBe('partial');
  });

  it('D2: closing a request keeps what was not met at that moment; access state and lifecycle stay separate', () => {
    const w = world();
    w.table.addNeed('r1', lease, devA, 'read', 'input');
    w.table.addNeed('r1', out, devA, 'readwrite', 'output');
    w.table.setLifecycle('r1', 'waiting');
    w.grant(path.dirname(lease), 'read');
    w.table.setLifecycle('r1', 'closed', 'stopped');
    expect(w.table.request('r1')).toMatchObject({ lifecycle: 'closed', closeReason: 'stopped' });
    expect(w.table.request('r1')!.unmetAtClose!.map((need) => need.label)).toEqual(['Folder out']);
    // The rows keep their access state; nothing is re-judged for a closed request, and it does not reopen.
    w.grant(out, 'readwrite');
    expect(w.table.needState('r1', out, devA)).toBe('missing');
    w.table.setLifecycle('r1', 'running');
    expect(w.table.request('r1')!.lifecycle).toBe('closed');
  });

  it('R3: an applicable report writes identity and state together; a stale one is history only, and nothing goes back later', () => {
    const w = world();
    const child = path.join(out, 'child');
    w.table.addNeed('r1', child, devA, 'readwrite', 'output');
    w.grant(out, 'readwrite');
    expect(w.table.needState('r1', child, devA)).toBe('met');
    const atStart = w.table.revisionOf('r1', child)!;
    // The child becomes a link outside the tree. A call starts at `atStart`; its report is held back.
    w.links.set(child, path.resolve('/elsewhere/p2'));
    const held = { requestId: 'r1', consumer: devA, namedPath: child, observedPhysical: path.resolve('/elsewhere/p2'),
      observedAt: 'late', startRevision: atStart, outcome: 'access-missing' as const };
    // A prompt call at the same revision reports first: applicable.
    expect(w.table.report({ ...held, observedAt: 'prompt' })).toBe(true);
    expect(w.table.needState('r1', child, devA)).toBe('missing');
    expect(w.table.findTarget('r1', child)!.observed).toBe(path.resolve('/elsewhere/p2'));
    // The person repairs it and chooses Grant access on the item: re-judged, met again.
    w.links.delete(child);
    w.table.rejudge('r1');
    expect(w.table.needState('r1', child, devA)).toBe('met');
    const repaired = w.table.findTarget('r1', child)!;
    expect(repaired.observed).toBe(child);
    // The held-back report arrives: history only.
    expect(w.table.report(held)).toBe(false);
    expect(repaired.history.at(-1)).toMatchObject({ observedAt: 'late', applied: false });
    expect(repaired.observed).toBe(child);
    expect(w.table.needState('r1', child, devA)).toBe('met');
    // A later related event re-judges from the operative identity, never from history: still met.
    w.grant(lease, 'read');
    expect(w.table.needState('r1', child, devA)).toBe('met');
    expect(w.table.findTarget('r1', child)!.observed).toBe(child);
  });

  it('a not-access report changes no access state; a closed request takes reports as history only', () => {
    const w = world();
    w.table.addNeed('r1', out, devA, 'readwrite', 'output');
    w.grant(out, 'readwrite');
    const revision = w.table.revisionOf('r1', out)!;
    expect(w.table.report({ requestId: 'r1', consumer: devA, namedPath: out, observedAt: 't', startRevision: revision, outcome: 'not-access' })).toBe(false);
    expect(w.table.needState('r1', out, devA)).toBe('met');
    w.table.setLifecycle('r1', 'closed', 'done');
    expect(w.table.report({ requestId: 'r1', consumer: devA, namedPath: out, observedAt: 't', startRevision: w.table.revisionOf('r1', out)!, outcome: 'access-missing' })).toBe(false);
    expect(w.table.needState('r1', out, devA)).toBe('met');
  });

  it('one event is one transaction: listeners hear it once, with the rows it changed', () => {
    const w = world();
    w.table.addNeed('r1', out, pm, 'read', 'named');
    w.changes.length = 0;
    w.table.transact(() => {
      w.table.addNeed('r1', file, devA, 'readwrite', 'output');
      w.table.addNeed('r1', lease, devA, 'read', 'input');
    });
    expect(w.changes).toHaveLength(1);
    const folder = w.table.findTarget('r1', out)!.id;
    expect(w.changes[0].targets.has(folder)).toBe(true);
    expect(w.changes[0].requests.has('r1')).toBe(true);
  });

  it('R1 §2.4: a stored table restored after a reload closes its requests as ended by the reload, keeps what was missing, and grants nothing', () => {
    const w = world();
    w.table.addNeed('r1', lease, devA, 'read', 'input');
    w.table.addNeed('r1', out, devA, 'readwrite', 'output');
    w.table.setLifecycle('r1', 'waiting');
    w.grant(path.dirname(lease), 'read');
    const stored = JSON.parse(JSON.stringify(w.table.toSnapshot()));
    const after = world();
    after.table.restore(stored);
    expect(after.table.request('r1')).toMatchObject({ lifecycle: 'closed', closeReason: 'reload' });
    expect(after.table.request('r1')!.unmetAtClose!.map((need) => need.label)).toEqual(['Folder out']);
    // A grant after the reload changes nothing of it: its rows are a record.
    after.grant(out, 'readwrite');
    expect(after.table.needState('r1', out, devA)).toBe('missing');
    // A new request gets rows of its own, with ids that never meet the stored ones.
    after.table.addNeed('r2', out, devA, 'readwrite', 'output');
    expect(after.table.findTarget('r2', out)!.id).not.toBe(after.table.findTarget('r1', out)!.id);
    expect(after.table.needState('r2', out, devA)).toBe('met');
  });

  it('a consumer dropped takes only its own rows', () => {
    const w = world();
    w.table.addNeed('r1', out, devA, 'readwrite', 'output');
    w.table.addNeed('r1', out, devB, 'readwrite', 'output');
    w.table.dropConsumer('r1', devA);
    expect(w.table.needState('r1', out, devA)).toBeUndefined();
    expect(w.table.needState('r1', out, devB)).toBe('missing');
  });

  it('audit of cc0b6bc6, F1: the rows of a dropped consumer are released, not deleted: still judged for the item, read by nothing that waits, and live again when needed again', () => {
    const w = world();
    w.table.addNeed('r1', out, devA, 'readwrite', 'output');
    w.grant(out, 'readwrite');
    w.table.dropConsumer('r1', devA);
    const target = w.table.findTarget('r1', out)!;
    expect([...w.table.needsOf(target.id)]).toEqual([expect.objectContaining({ released: true, judgement: expect.objectContaining({ state: 'met', granted: 'readwrite' }) })]);
    expect(w.table.needState('r1', out, devA)).toBeUndefined();
    expect(w.table.targetState('r1', out)).toBeUndefined();
    expect(w.table.snapshot('r1')).toEqual([]);
    // Revoked: the released row is judged again, so an item drawn from it says so.
    w.grants.splice(0);
    w.table.inputsChanged();
    expect([...w.table.needsOf(target.id)][0].judgement.state).toBe('missing');
    expect(w.table.unmet('r1')).toEqual([]);
    // Needed again by the same consumer: live again, at what it needs now.
    w.table.addNeed('r1', out, devA, 'read', 'input');
    expect(w.table.needState('r1', out, devA)).toBe('missing');
    expect(w.table.snapshot('r1')).toEqual([expect.objectContaining({ needed: 'read' })]);
  });

  it('audit of cc0b6bc6, F2: once a request is closed, releasing its rows changes nothing: its close record stays whole', () => {
    const w = world();
    const a = path.join(root, 'a', 'a.txt');
    const b = path.join(root, 'b', 'b.txt');
    w.table.addNeed('r1', a, devA, 'readwrite', 'output');
    w.table.addNeed('r1', b, devB, 'readwrite', 'output');
    w.table.setLifecycle('r1', 'closed', 'stopped');
    const before = w.changes.length;
    w.table.dropConsumer('r1', devA);
    w.table.dropConsumer('r1', devB);
    expect(w.changes.length).toBe(before);
    expect(w.table.request('r1')!.unmetAtClose!.map((need) => need.path).sort()).toEqual([a, b].sort());
    expect(w.table.targetState('r1', a)).toBe('missing');
  });
});

// v0.9.102 (the PM live strip): what a PM's strip says it waits for comes from that PM's waiting requests only.
describe('the waiting needs one PM\'s strip shows', () => {
  it('lists the unmet needs of the waiting requests anchored to that PM, each target and access once, and nothing else', () => {
    const w = world();
    const other = path.join(root, 'other');
    w.table.addNeed('r1', lease, pm, 'read', 'input');
    w.table.addNeed('r1', out, devA, 'readwrite', 'output');
    w.table.addNeed('r1', out, devB, 'readwrite', 'output');
    w.table.setLifecycle('r1', 'waiting');
    w.table.setStatusAnchor('r1', { agentId: 'pm', turnId: 't1' });
    // Another PM's waiting request, and a request of this PM that is running, not waiting.
    w.table.addNeed('r2', other, { agentId: 'pm2' }, 'read', 'input');
    w.table.setLifecycle('r2', 'waiting');
    w.table.setStatusAnchor('r2', { agentId: 'pm2', turnId: 't2' });
    w.table.addNeed('r3', other, pm, 'readwrite', 'output');
    w.table.setLifecycle('r3', 'running');
    w.table.setStatusAnchor('r3', { agentId: 'pm', turnId: 't3' });
    const needs = (agentId: string) => w.table.waitingNeedsOf(agentId).map((need) => [need.path, need.needed]);
    expect(needs('pm')).toEqual([[lease, 'read'], [out, 'readwrite']]);
    expect(needs('pm2')).toEqual([[other, 'read']]);
    // A grant that meets a need takes it off the strip.
    w.grant(out, 'readwrite');
    expect(needs('pm')).toEqual([[lease, 'read']]);
    expect(needs('nobody')).toEqual([]);
  });
});
