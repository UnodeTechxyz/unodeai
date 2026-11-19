import { afterEach, describe, expect, it } from 'vitest';
import { cliStoreVersionKey } from '../../../backend/cliCompatibilityPolicy';
import { HostShutdown } from '../../../backend/processTree';
import type { InstanceRef, ProcessIdentity, VersionKey } from '../contracts';
import type { DownloadTaskKind, DownloadTaskResult } from '../updater/downloadTask';
import { ManagedCodexUpdater, UPDATER_IDLE_RECHECK_MS, type UpdaterTaskEvent } from '../updater/updater';
import { ManagedCodexStore } from '../managedCodexStore';
import { ManagedCodexActions, cardTaskFor } from '../../managedCodexActions';
import type { ManagedCodexHost } from '../../cliRuntimeHost';
import { controlChanges, FakeControlStore, FakeInstanceStore } from './fakeStoresPipeline';
import {
  ALL_HOSTS,
  ASSET_HOST,
  GITHUB_HOST,
  PRIMARY_HOST,
  fakeFetch,
  fakePowerShell,
  githubUrl,
  manualTimers,
  okResponse,
  primaryUrl,
  stalledResponse,
  testPackage,
  testPolicy,
  until,
  type Route,
  type TestPackage,
} from './pipelineFixtures';

// ADAPTER §5.10 as amended (Revision 5 §1): no traffic before enrolment; with automatic mode on, at most one attempt
// per 24 h per provider across windows, the first 2 minutes after the window starts and only in a trusted window that
// is not shutting down; an extension update that adds entries triggers the same check within the 24 h rule; retries
// by class at +1 h and +6 h, then stop; never for integrity; a verified key awaiting its click is never downloaded
// again or re-notified in a window session; Update now at once, with a valid enrolment and consented hosts.
// BRIEF §5: one task per provider per window; dispose() aborts it.

const WINDOWS = { os: 'win32', arch: 'x64' };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const stores: FakeInstanceStore[] = [];
const updaters: ManagedCodexUpdater[] = [];
afterEach(() => {
  for (const updater of updaters.splice(0)) updater.dispose();
  for (const store of stores.splice(0)) store.dispose();
});

interface Store {
  control: FakeControlStore;
  instances: FakeInstanceStore;
  ref?: InstanceRef;
}

async function store(options: { enrol?: boolean; hosts?: string[]; autoMode?: boolean } = {}): Promise<Store> {
  const instances = new FakeInstanceStore();
  stores.push(instances);
  const control = new FakeControlStore([], instances);
  await control.initialize();
  if (options.enrol === false) return { control, instances };
  const created = await instances.create();
  if (!created.ok) throw new Error('no instance');
  await control.publish(controlChanges.enrol(created.ref.storeId, options.hosts ?? [...ALL_HOSTS], options.autoMode ?? true));
  return { control, instances, ref: created.ref };
}

type Serve = 'ok' | 'network' | 'tampered' | 'stalled';

interface WindowOptions {
  packages: TestPackage[];
  timers: ReturnType<typeof manualTimers>;
  identity?: ProcessIdentity;
  serve?: () => Serve;
  onTask?: (event: UpdaterTaskEvent) => void;
}

/** One window's updater on a shared store, with its own fetch, PowerShell and listeners. */
function window(s: Store, options: WindowOptions) {
  const ended: Array<{ result: DownloadTaskResult; kind: DownloadTaskKind }> = [];
  const verified: VersionKey[] = [];
  const shutdown = new HostShutdown();
  const state = { allowed: true };
  const primaryCalls: string[] = [];
  const attemptTimes: number[] = [];
  const routes: Record<string, Route> = {};
  for (const pkg of options.packages) {
    routes[primaryUrl(pkg.version)] = (init) => {
      primaryCalls.push(pkg.version);
      attemptTimes.push(options.timers.now());
      const serve = options.serve?.() ?? 'ok';
      if (serve === 'network') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      if (serve === 'stalled') return stalledResponse(pkg.archive.length, init.signal);
      if (serve === 'tampered') {
        const bytes = Buffer.from(pkg.archive);
        bytes[100] ^= 1;
        return okResponse(bytes);
      }
      return okResponse(pkg.archive);
    };
    routes[githubUrl(pkg.version)] = () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); };
  }
  const fetched = fakeFetch(routes);
  const powerShell = fakePowerShell('honest');
  const updater = new ManagedCodexUpdater({
    control: s.control,
    instances: s.instances,
    policy: testPolicy(options.packages.map((pkg) => pkg.entry)),
    host: WINDOWS,
    timers: options.timers,
    windowAllowed: () => state.allowed,
    shutdown,
    task: {
      fetch: fetched.fetch,
      hostIdentity: () => options.identity ?? { pid: 1000, creation: 'one' },
      ownerLiveness: async () => 'alive',
      writeRoots: () => [],
      authenticode: powerShell.deps,
      stopTree: powerShell.stopTree,
    },
    onTaskEnded: (result, kind) => ended.push({ result, kind }),
    onVerified: (key) => verified.push(key),
    ...(options.onTask ? { onTask: options.onTask } : {}),
  });
  updaters.push(updater);
  return { updater, ended, verified, shutdown, state, primaryCalls, attemptTimes, fetched };
}

/** Moves the manual clock to `at` from one due timer to the next, and lets every task that starts on the way end first. */
async function advanceTo(timers: ReturnType<typeof manualTimers>, at: number, windows: Array<ReturnType<typeof window>>): Promise<void> {
  for (;;) {
    const next = timers.nextAt();
    if (next === undefined || next > at) {
      if (at > timers.now()) timers.advance(at - timers.now());
      break;
    }
    timers.advance(Math.max(0, next - timers.now()));
    // A task that started here ends on real I/O; the manual clock waits for it.
    await new Promise((resolve) => setImmediate(resolve));
    if (windows.some((item) => item.updater.running !== undefined)) {
      await until(() => windows.every((item) => item.updater.running === undefined));
    }
  }
}

const p164 = testPackage('0.164.0');
const p165 = testPackage('0.165.0');
const T0 = Date.parse('2026-10-21T08:00:00Z');

describe('the window\'s schedule', () => {
  it('sends nothing before enrolment, ever', async () => {
    const s = await store({ enrol: false });
    const timers = manualTimers(T0);
    const w = window(s, { packages: [p164], timers });
    w.updater.start();
    await advanceTo(timers, T0 + 72 * HOUR, [w]);
    expect(w.fetched.calls).toHaveLength(0);
    expect(w.ended).toHaveLength(0);
    expect(await w.updater.updateNow()).toEqual({ ran: false, reason: 'not-enrolled' });
    expect(w.fetched.calls).toHaveLength(0);
  });

  it('makes its first automatic attempt 2 minutes after the window starts, and not before', async () => {
    const s = await store();
    const timers = manualTimers(T0);
    const w = window(s, { packages: [p164], timers });
    w.updater.start();
    await advanceTo(timers, T0 + 2 * MINUTE - 1, [w]);
    expect(w.fetched.calls).toHaveLength(0);
    await advanceTo(timers, T0 + 2 * MINUTE, [w]);
    await until(() => w.ended.length === 1);
    expect(w.ended[0]).toMatchObject({ kind: 'automatic', result: { outcome: 'verified', alreadyPromoted: false } });
    expect(s.instances.record(s.ref!).schedule.lastAttemptAt).toBe(new Date(T0 + 2 * MINUTE).toISOString());
  });

  it('attempts nothing with automatic mode off, and nothing in an untrusted window or after shutdown began', async () => {
    const off = await store({ autoMode: false });
    const timers = manualTimers(T0);
    const a = window(off, { packages: [p164], timers });
    a.updater.start();
    await advanceTo(timers, T0 + 48 * HOUR, [a]);
    expect(a.fetched.calls).toHaveLength(0);

    const untrusted = await store();
    const t2 = manualTimers(T0);
    const b = window(untrusted, { packages: [p164], timers: t2 });
    b.state.allowed = false;
    b.updater.start();
    await advanceTo(t2, T0 + 5 * HOUR, [b]);
    expect(b.fetched.calls).toHaveLength(0);
    // Trusted later: the next look, at most an hour away, attempts.
    b.state.allowed = true;
    await advanceTo(t2, T0 + 6 * HOUR + MINUTE, [b]);
    expect(b.ended).toHaveLength(1);

    const closing = await store();
    const t3 = manualTimers(T0);
    const c = window(closing, { packages: [p164], timers: t3 });
    c.updater.start();
    c.shutdown.begin();
    await advanceTo(t3, T0 + 48 * HOUR, [c]);
    expect(c.fetched.calls).toHaveLength(0);
    expect(await c.updater.updateNow()).toEqual({ ran: false, reason: 'disposed' });
  });

  it('counts the 24 hours from an attempt another window recorded', async () => {
    const s = await store();
    await s.instances.publish(s.ref!, { label: 'other window attempt', apply: (current) => ({ ...current, schedule: { lastAttemptAt: new Date(T0 - HOUR).toISOString() } }) });
    const timers = manualTimers(T0);
    const w = window(s, { packages: [p164], timers });
    w.updater.start();
    await advanceTo(timers, T0 + 23 * HOUR - MINUTE, [w]);
    expect(w.fetched.calls).toHaveLength(0);
    await advanceTo(timers, T0 + 23 * HOUR + MINUTE, [w]);
    expect(w.ended).toHaveLength(1);
    expect(w.ended[0].result.outcome).toBe('verified');
  });

  it('makes one attempt for two windows that start together; the other skips, and nothing is retried for integrity', async () => {
    const s = await store();
    const timers = manualTimers(T0);
    const a = window(s, { packages: [p164], timers, identity: { pid: 1, creation: 'a' }, serve: () => 'tampered' });
    const b = window(s, { packages: [p164], timers, identity: { pid: 2, creation: 'b' }, serve: () => 'tampered' });
    a.updater.start();
    b.updater.start();
    await advanceTo(timers, T0 + 2 * MINUTE, [a, b]);
    await until(() => a.ended.length + b.ended.length === 2);
    const outcomes = [...a.ended, ...b.ended].map((item) => item.result.outcome).sort();
    expect(outcomes).toEqual(['failed', 'skipped']);
    expect(a.primaryCalls.length + b.primaryCalls.length).toBe(1);
    await advanceTo(timers, T0 + 96 * HOUR, [a, b]);
    expect(a.primaryCalls.length + b.primaryCalls.length).toBe(1);
    expect(s.instances.record(s.ref!).schedule.failure).toMatchObject({ class: 'integrity', attempts: 1 });
  });

  it('retries a network failure at +1 hour and then +6 hours, and then stops', async () => {
    const s = await store();
    const timers = manualTimers(T0);
    const w = window(s, { packages: [p164], timers, serve: () => 'network' });
    w.updater.start();
    await advanceTo(timers, T0 + 96 * HOUR, [w]);
    const first = T0 + 2 * MINUTE;
    expect(w.attemptTimes).toEqual([first, first + HOUR, first + HOUR + 6 * HOUR]);
    expect(s.instances.record(s.ref!).schedule.failure).toMatchObject({ class: 'network', attempts: 3 });
    expect(s.instances.record(s.ref!).schedule.failure?.retryAt).toBeUndefined();
  });

  it('lets the user\'s Update now try at once after a failure that is never retried automatically', async () => {
    const s = await store();
    const timers = manualTimers(T0);
    let serve: 'tampered' | 'ok' = 'tampered';
    const w = window(s, { packages: [p164], timers, serve: () => serve });
    w.updater.start();
    await advanceTo(timers, T0 + 2 * MINUTE, [w]);
    await until(() => w.ended.length === 1);
    expect(w.ended[0].result).toMatchObject({ outcome: 'failed', failure: 'integrity' });
    serve = 'ok';
    const outcome = await w.updater.updateNow();
    expect(outcome).toMatchObject({ ran: true, result: { outcome: 'verified' } });
    expect(w.ended[1].kind).toBe('manual');
    expect(s.instances.record(s.ref!).schedule.failure).toBeUndefined();
  });

  it('never downloads again a verified key awaiting its click, and tells this window about it once', async () => {
    const s = await store();
    const timers = manualTimers(T0);
    const w = window(s, { packages: [p164], timers });
    w.updater.start();
    await advanceTo(timers, T0 + 96 * HOUR, [w]);
    expect(w.primaryCalls).toEqual(['0.164.0']);
    expect(w.verified).toEqual([cliStoreVersionKey(p164.entry)]);
    expect(await w.updater.updateNow()).toMatchObject({ ran: false, reason: 'already-promoted', key: cliStoreVersionKey(p164.entry) });
    // Another window session tells its own window once, and downloads nothing.
    const later = manualTimers(T0 + 100 * HOUR);
    const next = window(s, { packages: [p164], timers: later });
    next.updater.start();
    await advanceTo(later, T0 + 200 * HOUR, [next]);
    expect(next.primaryCalls).toEqual([]);
    expect(next.verified).toEqual([cliStoreVersionKey(p164.entry)]);
  });

  // ADAPTER §5.10.3: a UnodeAi update that adds entries triggers the same check, within the 24 h rule.
  it('downloads an entry an extension update added at the new window\'s check, within the 24-hour rule', async () => {
    const s = await store();
    const timers = manualTimers(T0);
    const old = window(s, { packages: [p164], timers });
    old.updater.start();
    await advanceTo(timers, T0 + 3 * MINUTE, [old]);
    expect(old.ended).toHaveLength(1);
    old.updater.dispose();
    // The extension updates and its window reloads an hour later, with a policy holding 0.165.0.
    const reloaded = manualTimers(T0 + HOUR);
    const updated = window(s, { packages: [p164, p165], timers: reloaded });
    updated.updater.start();
    await advanceTo(reloaded, T0 + 2 * MINUTE + 24 * HOUR - MINUTE, [updated]);
    expect(updated.primaryCalls).toEqual([]);
    await advanceTo(reloaded, T0 + 2 * MINUTE + 24 * HOUR + MINUTE, [updated]);
    expect(updated.primaryCalls).toEqual(['0.165.0']);
    expect(updated.ended[0].result).toMatchObject({ outcome: 'verified', key: cliStoreVersionKey(p165.entry) });
  });

  // Codex Q3: no automatic task retries a disabled key; the user's Try again is a separate action.
  it('never downloads a key control disables for this instance, automatically or by Update now', async () => {
    for (const reason of ['local-bad', 'probe-failed', 'probe-stop-unconfirmed', 'policy-bad', 'consent-withdrawn'] as const) {
      const s = await store();
      await s.control.publish(controlChanges.disable(s.ref!.storeId, cliStoreVersionKey(p164.entry), reason));
      const timers = manualTimers(T0);
      const w = window(s, { packages: [p164], timers });
      w.updater.start();
      await advanceTo(timers, T0 + 72 * HOUR, [w]);
      expect(w.fetched.calls).toHaveLength(0);
      expect(await w.updater.updateNow()).toEqual({ ran: false, reason: 'disabled', entry: p164.entry, key: cliStoreVersionKey(p164.entry) });
      expect(w.fetched.calls).toHaveLength(0);
    }
  });

  it('looks again within an hour and sees automatic mode turned on in another window', async () => {
    const s = await store({ autoMode: false });
    const timers = manualTimers(T0);
    const w = window(s, { packages: [p164], timers });
    w.updater.start();
    await advanceTo(timers, T0 + 3 * HOUR, [w]);
    expect(w.fetched.calls).toHaveLength(0);
    await s.control.publish(controlChanges.autoMode(true));
    await advanceTo(timers, T0 + 3 * HOUR + UPDATER_IDLE_RECHECK_MS + MINUTE, [w]);
    expect(w.ended).toHaveLength(1);
  });
});

describe('Update now', () => {
  it('runs at once, before the first automatic check and with automatic mode off', async () => {
    const s = await store({ autoMode: false });
    const timers = manualTimers(T0);
    const w = window(s, { packages: [p164], timers });
    w.updater.start();
    const outcome = await w.updater.updateNow();
    expect(outcome).toMatchObject({ ran: true, result: { outcome: 'verified', snapshot: { kind: 'manual' } } });
  });

  it('needs a trusted window', async () => {
    const s = await store();
    const w = window(s, { packages: [p164], timers: manualTimers(T0) });
    w.updater.start();
    w.state.allowed = false;
    expect(await w.updater.updateNow()).toEqual({ ran: false, reason: 'untrusted' });
    expect(w.fetched.calls).toHaveLength(0);
  });

  // ADAPTER §5.1.4: a new host requires a new consent before the entry is downloaded.
  it('asks for a new consent, and downloads nothing, when the newest entry names a host outside it', async () => {
    const s = await store({ hosts: [PRIMARY_HOST, GITHUB_HOST] });
    const w = window(s, { packages: [p164], timers: manualTimers(T0) });
    w.updater.start();
    expect(await w.updater.updateNow()).toEqual({ ran: false, reason: 'needs-host-consent', entry: p164.entry, hosts: [ASSET_HOST] });
    expect(w.fetched.calls).toHaveLength(0);
  });

  it('runs one task at a time in a window', async () => {
    const s = await store();
    const timers = manualTimers(T0);
    const w = window(s, { packages: [p164], timers, serve: () => 'stalled' });
    w.updater.start();
    const first = w.updater.updateNow();
    await until(() => w.primaryCalls.length === 1);
    expect(w.updater.running).toBe('manual');
    expect(await w.updater.updateNow()).toEqual({ ran: false, reason: 'busy' });
    w.updater.dispose();
    expect(await first).toMatchObject({ ran: true, result: { outcome: 'aborted' } });
  });
});

describe('dispose and shutdown', () => {
  it('dispose() aborts the window\'s task and leaves nothing behind', async () => {
    const s = await store();
    const timers = manualTimers(T0);
    const w = window(s, { packages: [p164], timers, serve: () => 'stalled' });
    w.updater.start();
    await advanceTo(timers, T0 + 2 * MINUTE, [] as Array<ReturnType<typeof window>>);
    await until(() => w.primaryCalls.length === 1);
    w.updater.dispose();
    await until(() => w.ended.length === 1);
    expect(w.ended[0].result).toMatchObject({ outcome: 'aborted', phase: 'V1' });
    expect(s.instances.stagingFolders(s.ref!)).toEqual([]);
    expect(s.instances.record(s.ref!).stagingIntents).toEqual({});
    expect(s.instances.leases.every((lease) => lease.released)).toBe(true);
    expect(timers.pending()).toBe(0);
  });

  it('ends the task when the extension host begins to shut down', async () => {
    const s = await store();
    const timers = manualTimers(T0);
    const w = window(s, { packages: [p164], timers, serve: () => 'stalled' });
    w.updater.start();
    const running = w.updater.updateNow();
    await until(() => w.primaryCalls.length === 1);
    w.shutdown.begin();
    expect(await running).toMatchObject({ ran: true, result: { outcome: 'aborted' } });
  });
});

describe('the card follows this window\'s task (v0.9.97, Codex audit of 87092b9 F4)', () => {
  /** The card of one window, on the same stores as its updater. */
  function card(s: Store, updater: () => ManagedCodexUpdater, policy: ReturnType<typeof testPolicy>) {
    const refreshes: number[] = [];
    const managed = {
      store: new ManagedCodexStore({ control: s.control, instances: s.instances }),
      control: s.control,
      instances: s.instances,
      policy,
      storeRefusal: () => undefined,
      get updater() { return updater(); },
      ready: Promise.resolve(),
    } as unknown as ManagedCodexHost;
    const actions = new ManagedCodexActions(managed, {
      ask: async () => undefined, inform: () => undefined, refresh: () => refreshes.push(1), forgetAdoptions: () => 0,
      storeFolder: 'C:\\cli-store', formatTime: (iso) => iso.slice(11, 16),
    });
    return { actions, refreshes, lines: () => actions.card().lines.join('\n') };
  }

  it('shows the steps and the percentage of Update now through the real pipeline, redrawing once per change, and its end', async () => {
    const s = await store({ autoMode: false });
    const timers = manualTimers(T0);
    const events: UpdaterTaskEvent[] = [];
    const seen: string[] = [];
    const view = card(s, () => w.updater, testPolicy([p164.entry]));
    const w = window(s, { packages: [p164], timers, onTask: (event) => { events.push(event); view.actions.taskEvent(event); seen.push(view.lines()); } });
    expect(await w.updater.updateNow()).toMatchObject({ ran: true, result: { outcome: 'verified' } });
    expect(events.map((event) => event.type === 'phase' ? event.phase : event.type)).toEqual(expect.arrayContaining(['admission', 'V1', 'progress', 'V2', 'V4', 'promote', 'ended']));
    expect(seen.some((line) => line.includes('Looking for a supported version'))).toBe(true);
    const percents = seen.map((line) => /Downloading 0\.164\.0 from [\w.-]+ — (\d+) %/.exec(line)?.[1]).filter((value): value is string => value !== undefined).map(Number);
    expect(percents.length).toBeGreaterThan(1);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(percents.at(-1)).toBe(100);
    expect(seen.some((line) => line.includes('Checking file hashes and publisher signatures'))).toBe(true);
    // One redraw per change the card shows, not one per chunk.
    const progress = events.filter((event) => event.type === 'progress').length;
    expect(view.refreshes.length).toBeLessThanOrEqual(new Set(seen).size + 1);
    expect(view.refreshes.length).toBeLessThan(events.length - progress + 102);
    // Ended: the records say the version waits for the click; no task row is left.
    expect(view.lines()).not.toMatch(/Downloading|Checking file hashes|Looking for/);
    expect(view.lines()).toContain('0.164.0 is downloaded and checked. It runs only after your OK.');
  });

  it('shows a manual task\'s failure and a stopped task as such; the steps of a task that is no longer the window\'s, or after the updater was disposed, reach nothing', async () => {
    const s = await store({ autoMode: false });
    const timers = manualTimers(T0);
    const events: UpdaterTaskEvent[] = [];
    const tasks: Array<{ deps: { onPhase?: (phase: any) => void }; finish: (result: DownloadTaskResult) => void }> = [];
    const updater = new ManagedCodexUpdater({
      control: s.control, instances: s.instances, policy: testPolicy([p164.entry]), host: WINDOWS, timers,
      windowAllowed: () => true, shutdown: new HostShutdown(),
      task: { fetch: async () => { throw new Error('unused'); }, hostIdentity: () => ({ pid: 1, creation: 'one' }), ownerLiveness: async () => 'alive', writeRoots: () => [] },
      runTask: (_input, deps) => new Promise((resolve) => { tasks.push({ deps, finish: resolve }); }),
      onTask: (event) => events.push(event),
    });
    updaters.push(updater);
    const key = cliStoreVersionKey(p164.entry);
    const first = updater.updateNow();
    await until(() => tasks.length === 1);
    tasks[0]!.deps.onPhase?.('V1');
    tasks[0]!.finish({ outcome: 'failed', phase: 'V1', failure: 'network', detail: 'reset', key, treeStops: [] } as never);
    await first;
    const failed = events.at(-1)!;
    expect(cardTaskFor(failed, '2026-10-21T08:00:00.000Z')).toEqual({ phase: 'failed', version: '0.164.0', failureClass: 'network', detail: 'reset' });
    expect(cardTaskFor({ ...failed, kind: 'automatic' } as UpdaterTaskEvent, 'now')).toBeUndefined();
    expect(cardTaskFor({ type: 'ended', kind: 'manual', entry: p164.entry, result: { outcome: 'aborted', phase: 'V1', detail: 'stopped', key } as never }, 'now')).toEqual({ phase: 'cancelled', version: '0.164.0' });

    // The first task's late step, after a second task began, is not reported.
    const second = updater.updateNow();
    await until(() => tasks.length === 2);
    const before = events.length;
    tasks[0]!.deps.onPhase?.('V4');
    expect(events).toHaveLength(before);
    tasks[1]!.deps.onPhase?.('V2');
    expect(events).toHaveLength(before + 1);
    updater.dispose();
    tasks[1]!.deps.onPhase?.('V3');
    expect(events).toHaveLength(before + 1);
    tasks[1]!.finish({ outcome: 'aborted', phase: 'V3', detail: 'disposed', key, treeStops: [] } as never);
    await second;
    expect(events).toHaveLength(before + 1);
  });

  it('a card whose window is closing takes no step', async () => {
    const s = await store({ autoMode: false });
    const view = card(s, () => undefined as never, testPolicy([p164.entry]));
    view.actions.taskEvent({ type: 'phase', kind: 'manual', entry: p164.entry, phase: 'V1' });
    expect(view.lines()).toContain('Downloading 0.164.0');
    view.actions.dispose();
    view.actions.taskEvent({ type: 'phase', kind: 'manual', entry: p164.entry, phase: 'V2' });
    expect(view.lines()).toContain('Downloading 0.164.0');
  });
});
