import { expect, it, vi } from 'vitest';
import { TeamRosterOrder } from '../TeamRosterOrder';

it('retains a saved order through an empty and partial startup restore, then reloads it', async () => {
  let live: string[] = []; let saved = ['pm2', 'dev', 'pm']; const save = vi.fn(async (ids: string[]) => { saved = ids; });
  const order = new TeamRosterOrder(saved, save, () => live, () => {}, () => {});
  order.observe(); live = ['pm']; order.observe(); expect(save).not.toHaveBeenCalled();
  live = ['pm', 'dev', 'pm2']; order.rosterSettled(); await order.idle(); expect(order.project(live)).toEqual(['pm2', 'dev', 'pm']);
  expect(await order.reorder(['dev', 'pm', 'pm2'], order.revision)).toBe(true);
  const reload = new TeamRosterOrder(saved, save, () => live, () => {}, () => {}); reload.rosterSettled(); await reload.idle(); expect(reload.project(live)).toEqual(['dev', 'pm', 'pm2']);
});
it('preserves preferences if startup is empty until the complete roster can be projected', async () => {
  let live: string[] = []; const save = vi.fn(async () => {}); const order = new TeamRosterOrder(['b', 'a'], save, () => live, () => {}, () => {});
  order.rosterSettled(); await order.idle(); expect(save).not.toHaveBeenCalled(); live = ['a', 'b']; order.observe(); await order.idle(); expect(order.project(live)).toEqual(['b', 'a']);
});
it('appends new ids, prunes removed ids, and rejects a stale snapshot and malformed permutations', async () => {
  let live = ['a', 'b']; let saved = ['b', 'a']; const save = vi.fn(async (ids: string[]) => { saved = ids; }); const order = new TeamRosterOrder(saved, save, () => live, () => {}, () => {});
  order.rosterSettled(); const revision = order.revision; live = ['a', 'b', 'c']; order.observe(); await order.idle(); expect(saved).toEqual(['b', 'a', 'c']);
  expect(await order.reorder(['a', 'b'], revision)).toBe(false);
  for (const invalid of [['a', 'a', 'c'], ['a', 'b', 'unknown'], ['a', 'b'], 'a,b,c', [1, 'b', 'c']]) expect(await order.reorder(invalid, order.revision)).toBe(false);
  live = ['a', 'c']; order.observe(); await order.idle(); expect(saved).toEqual(['a', 'c']);
});
it('refuses a reorder crossing membership changes during persistence and restores the previous relative order', async () => {
  let live = ['a', 'b']; let saved = ['a', 'b']; let release!: () => void; let first = true;
  const order = new TeamRosterOrder(saved, async ids => { if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); } saved = ids; }, () => live, () => {}, () => {});
  order.rosterSettled(); const move = order.reorder(['b', 'a'], order.revision); await Promise.resolve(); await Promise.resolve();
  live = ['a', 'b', 'c']; order.observe(); release(); expect(await move).toBe(false); await order.idle(); expect(saved).toEqual(['a', 'b', 'c']); expect(order.project(live)).toEqual(saved);
});
it('restores the previous visible order and reports a failed save without changing the semantic roster', async () => {
  const roster = Object.freeze([{ id: 'pm', role: 'pm' }, { id: 'dev', role: 'developer' }, { id: 'pm2', role: 'pm' }]); const original = JSON.stringify(roster);
  const failed = vi.fn(); const redraw = vi.fn(); const order = new TeamRosterOrder(roster.map(agent => agent.id), async () => { throw Error('disk'); }, () => roster.map(agent => agent.id), redraw, failed);
  order.rosterSettled(); expect(await order.reorder(['pm2', 'dev', 'pm'], order.revision)).toBe(false);
  expect(order.project(roster.map(agent => agent.id))).toEqual(['pm', 'dev', 'pm2']); expect(failed).toHaveBeenCalledOnce(); expect(redraw).toHaveBeenCalled(); expect(JSON.stringify(roster)).toBe(original);
});
it('serializes rapid valid moves so the last completed preference wins', async () => {
  let saved = ['a', 'b', 'c']; const order = new TeamRosterOrder(saved, async ids => { await Promise.resolve(); saved = ids; }, () => ['a', 'b', 'c'], () => {}, () => {});
  order.rosterSettled(); const revision = order.revision; const first = order.reorder(['b', 'a', 'c'], revision); const second = order.reorder(['c', 'b', 'a'], revision);
  expect(await first).toBe(true); expect(await second).toBe(true); expect(saved).toEqual(['c', 'b', 'a']);
});
it('rejects a stale reorder even when an add/remove round trip restores the same live id set', async () => {
  let live = ['a', 'b']; let saved = ['b', 'a']; const save = vi.fn(async (ids: string[]) => { saved = ids; }); const order = new TeamRosterOrder(saved, save, () => live, () => {}, () => {});
  order.rosterSettled(); const oldRevision = order.revision; live = ['a', 'b', 'new']; order.observe(); await order.idle(); live = ['a', 'b']; order.observe(); await order.idle();
  const writesBefore = save.mock.calls.length; expect(await order.reorder(['a', 'b'], oldRevision)).toBe(false); expect(saved).toEqual(['b', 'a']); expect(save).toHaveBeenCalledTimes(writesBefore);
});
it('restores saved order when a storage operation changed bytes before rejecting', async () => {
  let saved = ['a', 'b']; let first = true;
  const order = new TeamRosterOrder(saved, async ids => { saved = ids; if (first) { first = false; throw Error('partial write'); } }, () => ['a', 'b'], () => {}, () => {});
  order.rosterSettled(); expect(await order.reorder(['b', 'a'], order.revision)).toBe(false); expect(saved).toEqual(['a', 'b']); expect(order.project(['a', 'b'])).toEqual(saved);
});
