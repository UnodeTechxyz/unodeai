import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_CONNECT_DEADLINE_MS,
  WorkbenchRecovery,
  type LiveWorkbenchPlacement,
  type WorkbenchRecoveryAnswer,
  type WorkbenchRecoveryQuestion,
  type WorkbenchTabCandidate,
} from '../WorkbenchRecovery';

interface Tab { name: string }

/** A window with Workbench tabs, a clock and questions the test answers. */
function windowWith(initial: Array<WorkbenchTabCandidate<Tab>>) {
  let now = 0;
  let timers: Array<{ at: number; callback: () => void; handle: number }> = [];
  let nextHandle = 1;
  const state = {
    tabs: initial,
    live: undefined as LiveWorkbenchPlacement | undefined,
    blocked: false,
    saved: true,
  };
  const questions: Array<{ question: WorkbenchRecoveryQuestion; answer: (value: WorkbenchRecoveryAnswer) => void }> = [];
  const did: string[] = [];
  const recovery = new WorkbenchRecovery<Tab>({
    candidates: () => state.tabs,
    live: () => state.live,
    blocked: () => state.blocked,
    savedDrafts: () => state.saved,
    ask: (question) => new Promise((answer) => { questions.push({ question, answer }); }),
    reopen: async (tab, viewColumn) => {
      did.push(`reopen ${tab.name} in ${viewColumn}`);
      state.live = { viewColumn, visible: true };
      state.tabs = state.tabs.filter((candidate) => candidate.tab !== tab);
      return true;
    },
    close: async (tab) => {
      did.push(`close ${tab.name}`);
      state.tabs = state.tabs.filter((candidate) => candidate.tab !== tab);
      return true;
    },
    open: () => { did.push('open'); },
    now: () => now,
    setTimer: (callback, ms) => {
      const handle = nextHandle++;
      timers.push({ at: now + ms, callback, handle });
      return handle;
    },
    clearTimer: (handle) => { timers = timers.filter((timer) => timer.handle !== handle); },
  });
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      now = due.at;
      due.callback();
      await settle();
    }
    now = end;
    await settle();
  };
  return { recovery, state, questions, did, advance };
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const tab = (name: string): Tab => ({ name });

describe('Workbench recovery after an extension host restart', () => {
  it('leaves a tab alone that the serializer restores within the deadline: the normal restore wins', async () => {
    const old = tab('workbench');
    const w = windowWith([{ tab: old, viewColumn: 2, activeInGroup: true }]);
    w.recovery.start();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS - 1);
    w.state.live = { viewColumn: 2, visible: true };
    w.recovery.changed();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS * 5);
    expect(w.questions).toHaveLength(0);
    expect(w.did).toEqual([]);
  });

  it('asks, without closing anything, about a shown tab that stays unconnected, and replaces it only on Reopen', async () => {
    const old = tab('workbench');
    const w = windowWith([{ tab: old, viewColumn: 2, activeInGroup: true }]);
    w.recovery.start();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS - 1);
    expect(w.questions).toHaveLength(0);
    await w.advance(1);
    expect(w.questions.map((entry) => entry.question)).toEqual([{ kind: 'reopen', userInitiated: false, savedDrafts: true }]);
    expect(w.did).toEqual([]);
    w.questions[0].answer('reopen');
    await settle();
    expect(w.did).toEqual(['reopen workbench in 2']);
  });

  it('does nothing when the user keeps the old tab, and does not ask again by itself', async () => {
    const old = tab('workbench');
    const w = windowWith([{ tab: old, viewColumn: 1, activeInGroup: true }]);
    w.recovery.start();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS);
    w.questions[0].answer(undefined);
    await settle();
    w.recovery.changed();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS * 3);
    expect(w.questions).toHaveLength(1);
    expect(w.did).toEqual([]);
  });

  it('abandons the replacement when a normal restore attached while the question was open', async () => {
    const old = tab('workbench');
    const w = windowWith([{ tab: old, viewColumn: 1, activeInGroup: true }]);
    w.recovery.start();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS);
    w.state.live = { viewColumn: 1, visible: true };
    w.questions[0].answer('reopen');
    await settle();
    expect(w.did).toEqual([]);
  });

  it('abandons the replacement when the old tab went away, the window began closing, or recovery was cancelled', async () => {
    for (const change of ['closed', 'blocked', 'cancelled'] as const) {
      const old = tab('workbench');
      const w = windowWith([{ tab: old, viewColumn: 1, activeInGroup: true }]);
      w.recovery.start();
      await w.advance(WORKBENCH_CONNECT_DEADLINE_MS);
      if (change === 'closed') w.state.tabs = [];
      if (change === 'blocked') w.state.blocked = true;
      if (change === 'cancelled') w.recovery.cancel();
      w.questions[0].answer('reopen');
      await settle();
      expect(w.did, change).toEqual([]);
    }
  });

  it('never asks while the window is closing or after recovery was cancelled', async () => {
    const blocked = windowWith([{ tab: tab('a'), viewColumn: 1, activeInGroup: true }]);
    blocked.state.blocked = true;
    blocked.recovery.start();
    await blocked.advance(WORKBENCH_CONNECT_DEADLINE_MS * 3);
    expect(blocked.questions).toHaveLength(0);
    const cancelled = windowWith([{ tab: tab('a'), viewColumn: 1, activeInGroup: true }]);
    cancelled.recovery.start();
    cancelled.recovery.cancel();
    await cancelled.advance(WORKBENCH_CONNECT_DEADLINE_MS * 3);
    expect(cancelled.questions).toHaveLength(0);
  });

  it('never judges a hidden tab, which VS Code revives only when shown, and starts its deadline when it is shown', async () => {
    const hidden = tab('hidden');
    const w = windowWith([{ tab: hidden, viewColumn: 1, activeInGroup: false }]);
    w.recovery.start();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS * 5);
    expect(w.questions).toHaveLength(0);
    w.state.tabs = [{ tab: hidden, viewColumn: 1, activeInGroup: true }];
    w.recovery.changed();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS - 1);
    expect(w.questions).toHaveLength(0);
    await w.advance(1);
    expect(w.questions).toHaveLength(1);
  });

  it('never judges a tab in the live Workbench\'s own group, which could be the live one', async () => {
    const w = windowWith([{ tab: tab('live-or-not'), viewColumn: 1, activeInGroup: true }]);
    w.state.live = { viewColumn: 1, visible: false };
    w.recovery.start();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS * 3);
    expect(w.questions).toHaveLength(0);
    const unknown = windowWith([{ tab: tab('x'), viewColumn: 2, activeInGroup: true }]);
    unknown.state.live = { viewColumn: undefined, visible: true };
    unknown.recovery.start();
    await unknown.advance(WORKBENCH_CONNECT_DEADLINE_MS * 3);
    expect(unknown.questions).toHaveLength(0);
  });

  it('offers to close an old tab in another group while a Workbench is live, and checks the groups again first', async () => {
    const old = tab('old');
    const w = windowWith([{ tab: old, viewColumn: 2, activeInGroup: true }]);
    w.state.live = { viewColumn: 1, visible: true };
    w.recovery.start();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS);
    expect(w.questions.map((entry) => entry.question)).toEqual([{ kind: 'close-extra' }]);
    w.questions[0].answer('close');
    await settle();
    expect(w.did).toEqual(['close old']);

    const moved = windowWith([{ tab: old, viewColumn: 2, activeInGroup: true }]);
    moved.state.live = { viewColumn: 1, visible: true };
    moved.recovery.start();
    await moved.advance(WORKBENCH_CONNECT_DEADLINE_MS);
    moved.state.live = { viewColumn: 2, visible: true };
    moved.questions[0].answer('close');
    await settle();
    expect(moved.did).toEqual([]);
  });

  it('guesses nothing when several shown tabs are unconnected', async () => {
    const w = windowWith([
      { tab: tab('a'), viewColumn: 1, activeInGroup: true },
      { tab: tab('b'), viewColumn: 2, activeInGroup: true },
    ]);
    w.recovery.start();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS);
    expect(w.questions.map((entry) => entry.question)).toEqual([{ kind: 'ambiguous' }]);
    w.questions[0].answer('reopen');
    await settle();
    expect(w.did).toEqual([]);
  });

  it('lets an explicit open create the Workbench normally when no shown tab is unconnected', () => {
    const none = windowWith([]);
    none.recovery.start();
    expect(none.recovery.interceptOpen()).toBe(false);
    const hidden = windowWith([{ tab: tab('hidden'), viewColumn: 1, activeInGroup: false }]);
    hidden.recovery.start();
    expect(hidden.recovery.interceptOpen()).toBe(false);
    const notArmed = windowWith([{ tab: tab('a'), viewColumn: 1, activeInGroup: true }]);
    expect(notArmed.recovery.interceptOpen()).toBe(false);
  });

  it('answers an explicit open beside a shown unconnected tab with the modal question, after the deadline', async () => {
    const old = tab('workbench');
    const w = windowWith([{ tab: old, viewColumn: 3, activeInGroup: true }]);
    w.recovery.start();
    await w.advance(500);
    expect(w.recovery.interceptOpen()).toBe(true);
    expect(w.recovery.interceptOpen()).toBe(true);
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS - 501);
    expect(w.questions).toHaveLength(0);
    await w.advance(1);
    expect(w.questions.map((entry) => entry.question)).toEqual([{ kind: 'reopen', userInitiated: true, savedDrafts: true }]);
    w.questions[0].answer('reopen');
    await settle();
    expect(w.did).toEqual(['reopen workbench in 3']);
  });

  it('opens normally when a restore attached during the explicit open\'s wait', async () => {
    const w = windowWith([{ tab: tab('workbench'), viewColumn: 1, activeInGroup: true }]);
    w.recovery.start();
    expect(w.recovery.interceptOpen()).toBe(true);
    w.state.live = { viewColumn: 1, visible: true };
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS);
    expect(w.questions).toHaveLength(0);
    expect(w.did).toEqual(['open']);
  });

  it('replaces the tab once though the notice and the modal were both answered Reopen', async () => {
    const old = tab('workbench');
    const w = windowWith([{ tab: old, viewColumn: 1, activeInGroup: true }]);
    w.recovery.start();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS);
    expect(w.recovery.interceptOpen()).toBe(true);
    await settle();
    expect(w.questions.map((entry) => entry.question.kind)).toEqual(['reopen', 'reopen']);
    w.questions[1].answer('reopen');
    await settle();
    w.questions[0].answer('reopen');
    await settle();
    expect(w.did).toEqual(['reopen workbench in 1']);
  });

  it('says when no saved copy of unsent text exists', async () => {
    const w = windowWith([{ tab: tab('workbench'), viewColumn: 1, activeInGroup: true }]);
    w.state.saved = false;
    w.recovery.start();
    await w.advance(WORKBENCH_CONNECT_DEADLINE_MS);
    expect(w.questions[0].question).toEqual({ kind: 'reopen', userInitiated: false, savedDrafts: false });
  });
});
