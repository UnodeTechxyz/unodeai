import { describe, expect, it } from 'vitest';
import { CHAT_DRAFT_LIMITS, CHAT_DRAFT_MIRROR_KEY, ChatDraftMirror, type ChatDraftMirrorStore } from '../chatDraftMirror';

/** A workspace-state stand-in whose updates settle only when the test says so. */
function controlledStore(initial?: unknown) {
  const values = new Map<string, unknown>(initial === undefined ? [] : [[CHAT_DRAFT_MIRROR_KEY, initial]]);
  const pending: Array<{ value: unknown; settle: (ok: boolean) => void }> = [];
  let available = true;
  const store: ChatDraftMirrorStore = {
    available: () => available,
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: (key, value) => new Promise<void>((resolve, reject) => {
      pending.push({
        value,
        settle: (ok) => {
          if (ok) {
            values.set(key, JSON.parse(JSON.stringify(value)));
            resolve();
          } else {
            reject(new Error('the disk is full'));
          }
        },
      });
    }),
  };
  return {
    store,
    pending,
    stored: () => values.get(CHAT_DRAFT_MIRROR_KEY) as { drafts: Record<string, { text: string }> } | undefined,
    setAvailable: (next: boolean) => { available = next; },
    settleAll: async (ok = true) => {
      while (pending.length > 0) {
        pending.shift()!.settle(ok);
        await flushMicrotasks();
      }
    },
  };
}

/** A store whose updates settle at once. */
function immediateStore(initial?: unknown) {
  const values = new Map<string, unknown>(initial === undefined ? [] : [[CHAT_DRAFT_MIRROR_KEY, initial]]);
  const writes: unknown[] = [];
  const store: ChatDraftMirrorStore = {
    available: () => true,
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => {
      writes.push(value);
      values.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
  return { store, writes, value: () => values.get(CHAT_DRAFT_MIRROR_KEY) };
}


const flushMicrotasks = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

const live = (...ids: string[]) => new Set(ids);

/** A copy that has seen the roster, as the host's copy has once the roster is restored. */
function started(store: ChatDraftMirrorStore, ...agents: string[]) {
  const mirror = new ChatDraftMirror(store);
  mirror.rosterLoaded(live(...(agents.length ? agents : ['pm', 'dev', 'qa'])));
  return { mirror, ep: (agentId: string) => mirror.epochOf(agentId) };
}

describe('ChatDraftMirror: the Workbench composer\'s saved copy', () => {
  it('answers saved only once the workspace-state update settled, not when the edit arrived', async () => {
    const backing = controlledStore();
    const { mirror, ep } = started(backing.store);
    await backing.settleAll();
    const surface = mirror.beginSurface();
    let answer: unknown;
    void mirror.edit(surface, { agentId: 'pm', text: 'half a thought', revision: 1, epoch: ep('pm') }, true)!.then((results) => { answer = results; });
    await flushMicrotasks();
    expect(answer).toBeUndefined();
    expect(mirror.writePending()).toBe(true);
    await backing.settleAll();
    expect(answer).toEqual([{ agentId: 'pm', revision: 1, state: 'saved', basis: expect.any(Number) }]);
    expect(backing.stored()?.drafts.pm.text).toBe('half a thought');
    expect(mirror.writePending()).toBe(false);
  });

  it('reports a failed write as failed, never rejects, and a later edit writes again', async () => {
    const backing = controlledStore();
    const { mirror, ep } = started(backing.store);
    await backing.settleAll();
    const surface = mirror.beginSurface();
    const first = mirror.edit(surface, { agentId: 'pm', text: 'one', revision: 1, epoch: ep('pm') }, true)!;
    await backing.settleAll(false);
    expect((await first)[0].state).toBe('failed');
    expect(await Promise.race([mirror.flush().then((saved) => `flush ${saved}`), Promise.resolve('pending')])).toBe('pending');
    const second = mirror.edit(surface, { agentId: 'pm', text: 'two', revision: 2, epoch: ep('pm') }, true)!;
    await backing.settleAll(true);
    expect((await second)[0].state).toBe('saved');
    expect(backing.stored()?.drafts.pm.text).toBe('two');
  });

  it('treats empty text as a deletion that a reload cannot bring back', async () => {
    const backing = immediateStore();
    const { mirror, ep } = started(backing.store);
    const surface = mirror.beginSurface();
    await mirror.edit(surface, { agentId: 'pm', text: 'draft', revision: 1, epoch: ep('pm') }, true);
    expect((await mirror.edit(surface, { agentId: 'pm', text: '', revision: 2, epoch: ep('pm') }, true))?.[0].state).toBe('saved');
    const reloaded = new ChatDraftMirror(backing.store);
    expect(reloaded.seed(live('pm'))).toEqual([]);
    expect(reloaded.hasDrafts(live('pm'))).toBe(false);
  });

  it('keeps no copy of a draft over the per-draft limit, and drops the older copy instead of truncating', async () => {
    const { mirror, ep } = started(immediateStore().store);
    const surface = mirror.beginSurface();
    await mirror.edit(surface, { agentId: 'pm', text: 'short', revision: 1, epoch: ep('pm') }, true);
    const tooLong = 'x'.repeat(CHAT_DRAFT_LIMITS.draftChars + 1);
    expect((await mirror.edit(surface, { agentId: 'pm', text: tooLong, revision: 2, epoch: ep('pm') }, true))?.[0].state).toBe('too-long');
    expect(mirror.seed(live('pm'))).toEqual([]);
    await mirror.edit(surface, { agentId: 'pm', text: 'short again', revision: 3, epoch: ep('pm') }, true);
    // The page says it holds an over-limit draft without sending it.
    expect((await mirror.edit(surface, { agentId: 'pm', text: '', revision: 4, epoch: ep('pm'), overLimit: true }, true))?.[0].state).toBe('too-long');
    expect(mirror.seed(live('pm'))).toEqual([]);
  });

  it('keeps the newest 20 drafts and 2,000,000 characters, and names each draft it gave up', async () => {
    const ids = Array.from({ length: 21 }, (_, index) => `agent-${index}`);
    const { mirror, ep } = started(immediateStore().store, ...ids);
    const surface = mirror.beginSurface();
    let lastResults: unknown[] = [];
    for (const [index, agentId] of ids.entries()) {
      lastResults = (await mirror.edit(surface, { agentId, text: `draft ${index}`, revision: index + 1, epoch: ep(agentId) }, true))!;
    }
    expect(lastResults).toContainEqual({ agentId: 'agent-0', revision: 0, state: 'over-budget', basis: expect.any(Number) });
    expect(mirror.seed(live(...ids)).map((draft) => draft.agentId)).toEqual(ids.slice(1));

    const big = 'y'.repeat(CHAT_DRAFT_LIMITS.draftChars);
    await mirror.edit(surface, { agentId: 'agent-1', text: big, revision: 100, epoch: ep('agent-1') }, true);
    const results = (await mirror.edit(surface, { agentId: 'agent-2', text: big, revision: 101, epoch: ep('agent-2') }, true))!;
    const total = mirror.seed(live(...ids)).reduce((sum, draft) => sum + draft.text.length, 0);
    expect(total).toBeLessThanOrEqual(CHAT_DRAFT_LIMITS.surfaceChars);
    expect(results[0]).toMatchObject({ agentId: 'agent-2', state: 'saved' });
    expect(results.filter((result) => result.state === 'over-budget').length).toBeGreaterThan(0);
    expect(mirror.seed(live(...ids)).map((draft) => draft.agentId)).toContain('agent-2');
  });

  it('ignores an edit from another page generation, an older revision, an unknown agent or an earlier incarnation', async () => {
    const { mirror, ep } = started(immediateStore().store);
    const old = mirror.beginSurface();
    const current = mirror.beginSurface();
    expect(mirror.edit(old, { agentId: 'pm', text: 'from the replaced page', revision: 9, epoch: ep('pm') }, true)).toBeUndefined();
    await mirror.edit(current, { agentId: 'pm', text: 'newer', revision: 5, epoch: ep('pm') }, true);
    expect(mirror.edit(current, { agentId: 'pm', text: 'older', revision: 4, epoch: ep('pm') }, true)).toBeUndefined();
    expect(mirror.edit(current, { agentId: 'gone', text: 'x', revision: 6, epoch: 0 }, false)).toBeUndefined();
    const firstDev = ep('dev');
    mirror.removeAgent('dev');
    expect(mirror.edit(current, { agentId: 'dev', text: 'for the removed dev', revision: 7, epoch: firstDev }, true)).toBeUndefined();
    // Untagged text belongs to no agent created after the copy began.
    expect(mirror.edit(current, { agentId: 'dev', text: 'untagged', revision: 8, epoch: 0 }, true)).toBeUndefined();
    expect(mirror.seed(live('pm', 'dev')).map((draft) => draft.text)).toEqual(['newer']);
  });

  it('retires the copy of exactly the sent revision, and a late copy of that text cannot bring it back', async () => {
    const { mirror, ep } = started(immediateStore().store);
    const surface = mirror.beginSurface();
    await mirror.edit(surface, { agentId: 'pm', text: 'send me', revision: 3, epoch: ep('pm') }, true);
    const mark = mirror.acceptSend(surface, 'pm', 3);
    expect(mark).toBeGreaterThan(0);
    expect(mirror.seed(live('pm'))).toEqual([]);
    expect(mirror.edit(surface, { agentId: 'pm', text: 'send me', revision: 3, epoch: ep('pm') }, true)).toBeUndefined();
    await mirror.edit(surface, { agentId: 'pm', text: 'the next message', revision: 4, epoch: ep('pm') }, true);
    expect(mirror.seed(live('pm')).map((draft) => draft.text)).toEqual(['the next message']);
    // A send of a revision this copy never saw as an edit still retires every revision up to it.
    await mirror.edit(surface, { agentId: 'pm', text: 'typed, then sent at once', revision: 5, epoch: ep('pm') }, true);
    mirror.acceptSend(surface, 'pm', 7);
    expect(mirror.edit(surface, { agentId: 'pm', text: 'typed, then sent at once', revision: 7, epoch: ep('pm') }, true)).toBeUndefined();
    expect(mirror.edit(surface, { agentId: 'pm', text: 'typed, then sent at once', revision: 6, epoch: ep('pm') }, true)).toBeUndefined();
    await mirror.edit(surface, { agentId: 'pm', text: 'the next message', revision: 8, epoch: ep('pm') }, true);
    // A send from a page this copy does not accept retires nothing.
    expect(mirror.acceptSend(undefined, 'pm', 4)).toBeUndefined();
    expect(mirror.acceptSend('another-page', 'pm', 4)).toBeUndefined();
    expect(mirror.seed(live('pm')).map((draft) => draft.text)).toEqual(['the next message']);
  });

  it('answers each edit with the sequence it was recorded at, not a later send\'s', async () => {
    const backing = controlledStore();
    const { mirror, ep } = started(backing.store);
    await backing.settleAll();
    const surface = mirror.beginSurface();
    const answer = mirror.edit(surface, { agentId: 'pm', text: 'about to be sent', revision: 3, epoch: ep('pm') }, true)!;
    // The send is accepted while the edit's write is still under way.
    const mark = mirror.acceptSend(surface, 'pm', 3)!;
    await backing.settleAll();
    const [result] = await answer;
    expect(result.basis).toBeLessThan(mark);
  });

  it('takes a restored page\'s drafts as the truth, except text a later send or an earlier incarnation made stale', async () => {
    const backing = immediateStore();
    const { mirror: first, ep } = started(backing.store);
    const page = first.beginSurface();
    const pmEpoch = ep('pm');
    const oldQa = ep('qa');
    await first.edit(page, { agentId: 'pm', text: 'sent text', revision: 10, epoch: pmEpoch }, true);
    const mark = first.acceptSend(page, 'pm', 10)!;
    first.removeAgent('qa');
    const newQa = ep('qa');
    expect(newQa).not.toBe(oldQa);
    await first.flush();

    // Reload: the page's own state still holds the sent text (the acknowledgement never reached it), text typed for
    // dev after that send, and a draft for the qa agent that was removed and created again with the same id.
    const reloaded = new ChatDraftMirror(backing.store);
    reloaded.rosterLoaded(live('pm', 'dev', 'qa'));
    const restored = reloaded.beginSurface();
    const outcome = reloaded.sync(restored, [
      { agentId: 'pm', text: 'sent text', revision: 10, epoch: pmEpoch, basis: mark - 1 },
      { agentId: 'dev', text: 'kept', revision: 11, epoch: ep('dev'), basis: 0 },
      { agentId: 'qa', text: 'for the old qa', revision: 9, epoch: oldQa, basis: 0 },
    ], live('pm', 'dev', 'qa'))!;
    expect(outcome.dropped.sort()).toEqual(['pm', 'qa']);
    expect((await outcome.results).map((result) => [result.agentId, result.state])).toEqual([['dev', 'saved']]);
    expect(reloaded.seed(live('pm', 'dev', 'qa')).map((draft) => draft.agentId)).toEqual(['dev']);
  });

  it('keeps text typed after a send even when a reload came before the page heard the send was accepted', async () => {
    const backing = immediateStore();
    const { mirror: first, ep } = started(backing.store);
    const page = first.beginSurface();
    const mark = first.acceptSend(page, 'pm', 10)!;
    await first.flush();
    const reloaded = new ChatDraftMirror(backing.store);
    reloaded.rosterLoaded(live('pm', 'dev', 'qa'));
    const restored = reloaded.beginSurface();
    const outcome = reloaded.sync(restored, [{ agentId: 'pm', text: 'typed after Send', revision: 11, epoch: ep('pm'), basis: mark - 1 }], live('pm'))!;
    expect(outcome.dropped).toEqual([]);
    expect(reloaded.seed(live('pm')).map((draft) => draft.text)).toEqual(['typed after Send']);
  });

  it('takes one start report per page, before any edit, so a repeated or late one cannot undo newer text', async () => {
    const { mirror, ep } = started(immediateStore().store);
    const surface = mirror.beginSurface();
    await mirror.sync(surface, [{ agentId: 'pm', text: 'start', revision: 1, epoch: ep('pm'), basis: 0 }], live('pm'))!.results;
    await mirror.edit(surface, { agentId: 'pm', text: 'newer text', revision: 20, epoch: ep('pm') }, true);
    for (const replay of [[{ agentId: 'pm', text: 'old text', revision: 10, epoch: ep('pm'), basis: 0 }], []]) {
      const outcome = mirror.sync(surface, replay, live('pm'))!;
      expect(outcome.dropped).toEqual([]);
      expect(await outcome.results).toEqual([]);
    }
    expect(mirror.seed(live('pm')).map((draft) => draft.text)).toEqual(['newer text']);

    // An edit first also closes the start report.
    const second = mirror.beginSurface();
    await mirror.edit(second, { agentId: 'dev', text: 'typed at once', revision: 30, epoch: ep('dev') }, true);
    await mirror.sync(second, [], live('pm', 'dev'))!.results;
    expect(mirror.seed(live('pm', 'dev')).map((draft) => draft.text)).toEqual(['newer text', 'typed at once']);
  });

  it('adds a created page\'s report to the copy without deleting drafts the page does not hold', async () => {
    const { mirror, ep } = started(immediateStore().store);
    const restoredPage = mirror.beginSurface();
    await mirror.sync(restoredPage, [
      { agentId: 'pm', text: 'pm draft', revision: 1, epoch: ep('pm'), basis: 0 },
      { agentId: 'dev', text: 'dev draft', revision: 2, epoch: ep('dev'), basis: 0 },
    ], live('pm', 'dev'))!.results;
    // A Workbench created before the roster was known got no seed, so it reports nothing.
    const created = mirror.beginSurface();
    await mirror.sync(created, [], live('pm', 'dev'), false)!.results;
    expect(mirror.seed(live('pm', 'dev')).map((draft) => draft.text)).toEqual(['pm draft', 'dev draft']);
  });

  it('gives an agent created again with a removed agent\'s id a new incarnation that inherits nothing, also after a reload', async () => {
    const backing = immediateStore();
    const { mirror, ep } = started(backing.store);
    const surface = mirror.beginSurface();
    const firstPm = ep('pm');
    await mirror.edit(surface, { agentId: 'pm', text: 'for the first pm', revision: 1, epoch: firstPm }, true);
    mirror.removeAgent('pm');
    const secondPm = ep('pm');
    expect(secondPm).toBeGreaterThan(firstPm);
    expect(mirror.epochsFor(['pm', 'dev'])).toEqual({ pm: secondPm, dev: ep('dev') });
    expect(mirror.seed(live('pm'))).toEqual([]);
    await mirror.flush();
    const reloaded = new ChatDraftMirror(backing.store);
    reloaded.rosterLoaded(live('pm', 'dev', 'qa'));
    expect(reloaded.epochOf('pm')).toBe(secondPm);
    const restored = reloaded.beginSurface();
    expect(reloaded.sync(restored, [
      { agentId: 'pm', text: 'for the first pm', revision: 1, epoch: firstPm, basis: 0 },
    ], live('pm'))!.dropped).toEqual(['pm']);
  });

  it('keeps nothing for removed agents, so 300 removals neither revive a predecessor nor drop a current draft', async () => {
    const backing = immediateStore();
    const others = Array.from({ length: 300 }, (_, index) => `gone-${index}`);
    const { mirror, ep } = started(backing.store, 'dev', ...others);
    const firstDev = ep('dev');
    mirror.removeAgent('dev');
    const surface = mirror.beginSurface();
    const currentDev = ep('dev');
    await mirror.edit(surface, { agentId: 'dev', text: 'current draft', revision: 1, epoch: currentDev }, true);
    for (const agentId of others) mirror.removeAgent(agentId);
    await mirror.flush();
    expect(mirror.seed(live('dev')).map((draft) => draft.text)).toEqual(['current draft']);
    const stored = backing.value() as { incarnations: Record<string, unknown>; sent: Record<string, unknown> };
    expect(Object.keys(stored.incarnations)).toEqual(['dev']);
    const reloaded = new ChatDraftMirror(backing.store);
    reloaded.rosterLoaded(live('dev'));
    expect(reloaded.seed(live('dev')).map((draft) => draft.text)).toEqual(['current draft']);
    const page = reloaded.beginSurface();
    const outcome = reloaded.sync(page, [
      { agentId: 'dev', text: 'for the first dev', revision: 1, epoch: firstDev, basis: 0 },
    ], live('dev'))!;
    expect(outcome.dropped).toEqual(['dev']);
  });

  it('lets untagged text from an earlier UnodeAi be taken over only by agents of the first roster it saw', async () => {
    const backing = immediateStore();
    const { mirror, ep } = started(backing.store, 'pm', 'dev');
    expect(mirror.adoptingAgents(['pm', 'dev'])).toEqual(['pm', 'dev']);
    const page = mirror.beginSurface();
    const outcome = mirror.sync(page, [{ agentId: 'pm', text: 'typed in 0.9.95', revision: 1, epoch: 0, basis: 0 }], live('pm', 'dev'))!;
    expect(outcome.dropped).toEqual([]);
    await outcome.results;
    expect(mirror.seed(live('pm'))).toEqual([expect.objectContaining({ text: 'typed in 0.9.95', epoch: ep('pm') })]);
    // An agent created later, or created again after a removal, does not take untagged text over.
    mirror.removeAgent('dev');
    expect(mirror.adoptingAgents(['pm', 'dev', 'qa'])).toEqual(['pm']);
    await mirror.flush();
    const reloaded = new ChatDraftMirror(backing.store);
    reloaded.rosterLoaded(live('pm', 'dev', 'qa'));
    expect(reloaded.adoptingAgents(['pm', 'dev', 'qa'])).toEqual(['pm']);
    const next = reloaded.beginSurface();
    expect(reloaded.sync(next, [
      { agentId: 'dev', text: 'untagged', revision: 1, epoch: 0, basis: 0 },
      { agentId: 'qa', text: 'untagged', revision: 2, epoch: 0, basis: 0 },
    ], live('pm', 'dev', 'qa'))!.dropped.sort()).toEqual(['dev', 'qa']);
  });

  it('forgets agents that are not in the loaded roster, with their drafts, marks and selection', async () => {
    const backing = immediateStore();
    // 'idle' has an incarnation and nothing else: no draft, no send mark.
    const { mirror, ep } = started(backing.store, 'pm', 'dev', 'qa', 'idle');
    const oldIdle = ep('idle');
    const surface = mirror.beginSurface();
    await mirror.edit(surface, { agentId: 'qa', text: 'qa draft', revision: 1, epoch: ep('qa') }, true);
    mirror.acceptSend(surface, 'pm', 9);
    mirror.setSelected('qa');
    const oldQa = ep('qa');
    await mirror.flush();
    // Between two windows, qa left the team file, and pm too.
    const next = new ChatDraftMirror(backing.store);
    next.rosterLoaded(live('dev'));
    await next.flush();
    const stored = backing.value() as { incarnations: Record<string, unknown>; sent: Record<string, unknown>; drafts: Record<string, unknown> };
    expect(Object.keys(stored.incarnations)).toEqual(['dev']);
    expect(stored.sent).toEqual({});
    expect(stored.drafts).toEqual({});
    expect(next.selectedAgentId()).toBeUndefined();
    // qa and idle return later as new agents with the same ids.
    expect(next.epochOf('qa')).not.toBe(oldQa);
    expect(next.epochOf('idle')).not.toBe(oldIdle);
  });

  it('writes one at a time, each the whole newest copy, so a slow older write never lands after a deletion', async () => {
    const backing = controlledStore();
    const { mirror, ep } = started(backing.store);
    await backing.settleAll();
    const surface = mirror.beginSurface();
    void mirror.edit(surface, { agentId: 'pm', text: 'secret draft', revision: 1, epoch: ep('pm') }, true);
    void mirror.edit(surface, { agentId: 'pm', text: '', revision: 2, epoch: ep('pm') }, true);
    await flushMicrotasks();
    expect(backing.pending).toHaveLength(1);
    await backing.settleAll();
    expect(backing.stored()?.drafts).toEqual({});
  });

  it('reads and writes nothing, and rejects nothing, when no workspace root is bound', async () => {
    const backing = controlledStore({ version: 1, seq: 3, adopted: true, drafts: { pm: { text: 'other root', seq: 3, epoch: 1 } }, incarnations: { pm: { epoch: 1, adoptsUntagged: false } }, sent: {} });
    backing.setAvailable(false);
    const mirror = new ChatDraftMirror(backing.store);
    mirror.rosterLoaded(live('pm'));
    expect(mirror.hasDrafts(live('pm'))).toBe(false);
    expect(mirror.epochsFor(['pm'])).toEqual({});
    const surface = mirror.beginSurface();
    expect(await mirror.edit(surface, { agentId: 'pm', text: 'x', revision: 1, epoch: 0 }, true)).toEqual([
      { agentId: 'pm', revision: 1, state: 'unavailable', basis: 0 },
    ]);
    expect(mirror.acceptSend(surface, 'pm', 1)).toBeUndefined();
    mirror.removeAgent('pm');
    mirror.setSelected('pm');
    mirror.clearDrafts();
    expect(backing.pending).toHaveLength(0);
    expect(await mirror.flush()).toBe(true);
  });

  it('trusts no unknown version or malformed entry, and loads within its own bounds', () => {
    // A well-formed record of another version is not read either.
    const otherVersion = {
      version: 2, seq: 2, adopted: true, drafts: { pm: { text: 'x', seq: 2, epoch: 1 } },
      incarnations: { pm: { epoch: 1, adoptsUntagged: false } }, sent: {},
    };
    expect(new ChatDraftMirror(immediateStore(otherVersion).store).hasDrafts(live('pm'))).toBe(false);
    expect(new ChatDraftMirror(immediateStore({ ...otherVersion, version: 1 }).store).hasDrafts(live('pm'))).toBe(true);
    const incarnations: Record<string, unknown> = {
      ok: { epoch: 1, adoptsUntagged: false },
      future: { epoch: 2, adoptsUntagged: false },
      notText: { epoch: 3, adoptsUntagged: false },
      wrongEpoch: { epoch: 4, adoptsUntagged: false },
      zero: { epoch: 0, adoptsUntagged: false },
      beyond: { epoch: 99, adoptsUntagged: false },
      malformed: { epoch: 5 },
    };
    const drafts: Record<string, unknown> = {
      ok: { text: 'fine', seq: 6, epoch: 1 },
      future: { text: 'from a later sequence', seq: 99, epoch: 2 },
      notText: { text: 42, seq: 6, epoch: 3 },
      wrongEpoch: { text: 'old incarnation', seq: 6, epoch: 1 },
      zero: { text: 'no incarnation', seq: 6, epoch: 0 },
      noIncarnation: { text: 'unknown agent', seq: 6, epoch: 5 },
      [`${'a'.repeat(CHAT_DRAFT_LIMITS.agentIdChars + 1)}`]: { text: 'long id', seq: 1, epoch: 1 },
    };
    const mirror = new ChatDraftMirror(immediateStore({ version: 1, seq: 7, adopted: true, drafts, incarnations, sent: {} }).store);
    const ids = ['ok', 'future', 'notText', 'wrongEpoch', 'zero', 'noIncarnation', 'beyond', 'malformed'];
    expect(mirror.seed(live(...ids)).map((draft) => draft.agentId)).toEqual(['ok']);
  });

  it('clears the drafts when the user closes the Workbench, and keeps the incarnations', async () => {
    const backing = immediateStore();
    const { mirror, ep } = started(backing.store);
    const surface = mirror.beginSurface();
    await mirror.edit(surface, { agentId: 'pm', text: 'draft', revision: 1, epoch: ep('pm') }, true);
    const qa = ep('qa');
    mirror.clearDrafts();
    await mirror.flush();
    const reloaded = new ChatDraftMirror(backing.store);
    expect(reloaded.hasDrafts(live('pm'))).toBe(false);
    expect(reloaded.epochOf('qa')).toBe(qa);
  });

  it('remembers the agent the user chose, as a preference only', async () => {
    const backing = immediateStore();
    const { mirror } = started(backing.store);
    mirror.setSelected('dev');
    await mirror.flush();
    expect(new ChatDraftMirror(backing.store).selectedAgentId()).toBe('dev');
    mirror.removeAgent('dev');
    await mirror.flush();
    expect(new ChatDraftMirror(backing.store).selectedAgentId()).toBeUndefined();
  });

  it('writes nothing more once retired by Reset, and waits for a write already under way', async () => {
    const backing = controlledStore();
    const { mirror, ep } = started(backing.store);
    await backing.settleAll();
    const surface = mirror.beginSurface();
    void mirror.edit(surface, { agentId: 'pm', text: 'draft', revision: 1, epoch: ep('pm') }, true);
    mirror.removeAgent('qa');
    await flushMicrotasks();
    let retired = false;
    void mirror.retire().then(() => { retired = true; });
    await flushMicrotasks();
    expect(retired).toBe(false);
    await backing.settleAll();
    expect(retired).toBe(true);
    expect(backing.pending).toHaveLength(0);
    expect(mirror.available()).toBe(false);
    expect(await mirror.edit(mirror.beginSurface(), { agentId: 'pm', text: 'after', revision: 2, epoch: 0 }, true))
      .toEqual([{ agentId: 'pm', revision: 2, state: 'unavailable', basis: expect.any(Number) }]);
    mirror.removeAgent('pm');
    mirror.setSelected('pm');
    mirror.rosterLoaded(live('dev'));
    await flushMicrotasks();
    expect(backing.pending).toHaveLength(0);
  });

  it('stores text, its agent, incarnations and host ordering only', async () => {
    const backing = immediateStore();
    const { mirror, ep } = started(backing.store, 'pm');
    const surface = mirror.beginSurface();
    await mirror.edit(surface, { agentId: 'pm', text: 'draft', revision: 1, epoch: ep('pm') }, true);
    expect(backing.value()).toEqual({
      version: 1, seq: 2, adopted: true,
      drafts: { pm: { text: 'draft', seq: 2, epoch: 1 } },
      incarnations: { pm: { epoch: 1, adoptsUntagged: true } },
      sent: {},
    });
  });
});
