import { describe, expect, it } from 'vitest';
import type { InstanceView } from '../contracts';
import { managedCodexCard, type CardInput, type CardTask, type ManagedCodexCard } from '../qualify/cardState';
import type { FakeWorld } from './fakeStoresQualify';
import { codexEntry, enrolledWorld, HOST, keyOf, seedVersion, testPolicy, type Enrolled } from './qualifyFixtures';

// The design these tests realise: Revision 5 §9.5 (the state table, facts only; "'Updated' is never shown, for any
// state"), merged design §4 (the shared suspension; "Use managed Codex again", offered only while control reads as
// valid and ok), Codex's Q4 (every unusable control state offers the suspension; behind-floor keeps its recorded
// re-decision and recorded Use external CLI), merged §3.2 ((A, external): "Switching to External keeps A ...
// Switching back needs no download and no click"), Revision 5 §9.3 (an unconfirmed stop offers Check again), and
// ADAPTER §5.11.4 (a version marked bad on this computer offers Try again).

const OLD = codexEntry({ version: '0.163.0' });
const NEW = codexEntry({ version: '0.164.0' });
const NEWER = codexEntry({ version: '0.165.0' });
const policy = testPolicy([OLD, NEW, NEWER]);
const formatTime = (iso: string) => `at(${iso})`;

function card(world: FakeWorld, enrolled: Enrolled | undefined, extra: Partial<CardInput> = {}): ManagedCodexCard {
  return managedCodexCard({
    host: HOST,
    suspension: world.suspensionView(),
    control: world.controlView(),
    ...(enrolled ? { instance: world.instance().read(enrolled.ref) } : {}),
    policy,
    formatTime,
    ...extra,
  });
}

const ids = (result: ManagedCodexCard) => result.actions.map((action) => action.key ? `${action.id}:${action.key}` : action.id);
const collected: ManagedCodexCard[] = [];
const seen = (result: ManagedCodexCard) => { collected.push(result); return result; };

describe('managedCodexCard: blocked and selection states', () => {
  it('unsupported platform', () => {
    const enrolled = enrolledWorld();
    expect(seen(card(enrolled.world, enrolled, { host: { os: 'linux', arch: 'x64' } }))).toEqual({ state: 'unsupported', lines: ['Managed Codex is available on Windows x64 only.'], actions: [] });
  });

  it('the shared suspension: Use managed Codex again only while control reads ok', () => {
    const enrolled = enrolledWorld();
    enrolled.world.suspension = { kind: 'readable', reason: 'control unreadable in window 2', decidedAt: '2026-10-21T00:00:00Z' };
    const ok = seen(card(enrolled.world, enrolled));
    expect(ok.state).toBe('suspended');
    expect(ok.lines).toEqual(['Managed Codex is paused in every window. New sessions use the external Codex CLI.', 'Reason recorded: control unreadable in window 2.']);
    expect(ids(ok)).toEqual(['use-managed-again', 'details']);
    enrolled.world.controlUnusable = { reason: 'floor-unavailable', detail: 'missing' };
    enrolled.world.suspension = { kind: 'unreadable' };
    const blocked = seen(card(enrolled.world, enrolled));
    expect(blocked.lines[1]).toBe('The record of this pause cannot be read; managed Codex stays paused.');
    expect(ids(blocked)).toEqual(['details']);
  });

  it('every unusable control reason offers Use external CLI (the suspension) and Details', () => {
    const reasons = ['control-missing', 'control-unreadable', 'control-newer-schema', 'floor-unavailable', 'sealed'] as const;
    const lines = new Set<string>();
    for (const reason of reasons) {
      const enrolled = enrolledWorld();
      enrolled.world.controlUnusable = { reason, detail: `detail of ${reason}` };
      const result = seen(card(enrolled.world, enrolled));
      expect(result.state, reason).toBe('control-unusable');
      expect(ids(result), reason).toEqual(['use-external-suspend', 'details']);
      lines.add(result.lines[0]);
    }
    expect(lines.size).toBe(reasons.length);
  });

  it('behind-floor offers its review and the recorded Use external CLI, never the suspension', () => {
    const enrolled = enrolledWorld();
    enrolled.world.writeControl('reduction', (content) => content);
    enrolled.world.loseNewestControlGeneration();
    const result = seen(card(enrolled.world, enrolled));
    expect(result.state).toBe('behind-floor');
    expect(result.lines).toEqual(['UnodeAi could not confirm your last change to managed Codex after an unexpected shutdown. New managed Codex sessions are paused until you choose.']);
    expect(ids(result)).toEqual(['review-settings', 'use-external', 'details']);
  });

  it('not set up, and a store whose records cannot be read', () => {
    const fresh = enrolledWorld();
    fresh.world.controlGenerations.length = 0;
    expect(seen(card(fresh.world, undefined))).toMatchObject({ state: 'not-enrolled', actions: [{ id: 'set-up' }] });

    for (const [reason, actions] of [['store-corrupt', ['repair-store', 'use-external', 'reset', 'details']], ['store-newer-schema', ['use-external', 'reset', 'details']], ['missing', ['use-external', 'reset', 'details']]] as const) {
      const enrolled = enrolledWorld();
      const instance: InstanceView = { kind: 'unusable', reason, detail: 'a generation above the newest valid one' };
      const result = seen(card(enrolled.world, enrolled, { instance }));
      expect(result.state, reason).toBe('store-unavailable');
      expect(ids(result), reason).toEqual(actions);
    }
    // v0.9.97 (Codex's audit of 815e408, F1): an instance this window cannot open offers no Reset, which closes the gate
    // first; Use external CLI stays.
    const unopened = enrolledWorld();
    const result = seen(card(unopened.world, unopened, { instance: undefined, instanceProblem: 'the identity is damaged' }));
    expect(result.state).toBe('store-unavailable');
    expect(ids(result)).toEqual(['use-external', 'details']);
  });

  it('(A, external): set up but not used, with Use managed Codex; a verified version waits for managed Codex', () => {
    const enrolled = enrolledWorld({ selection: 'external' });
    seedVersion(enrolled, NEW);
    const result = seen(card(enrolled.world, enrolled));
    expect(result).toEqual({
      state: 'external-selected',
      lines: ['Managed Codex is set up but not used for new sessions. New sessions use the external Codex CLI.', 'Codex 0.164.0 is ready to review once managed Codex is selected again.'],
      actions: [{ id: 'use-managed', label: 'Use managed Codex' }],
    });
  });
});

describe('managedCodexCard: the managed pipeline (Revision 5 §9.5)', () => {
  it('no version yet, and every task phase with its facts', () => {
    const enrolled = enrolledWorld();
    expect(seen(card(enrolled.world, enrolled))).toMatchObject({ state: 'no-version', lines: ['No managed Codex version is downloaded yet.'], actions: [{ id: 'update-now' }, { id: 'use-external' }] });
    const tasks: Array<[CardTask, string, string]> = [
      [{ phase: 'checking' }, 'checking', 'Looking for a supported version'],
      [{ phase: 'downloading', version: '0.164.0', host: 'releases.openai.com', percent: 38.7 }, 'downloading', 'Downloading 0.164.0 from releases.openai.com — 38 %'],
      [{ phase: 'downloading', version: '0.165.0', host: 'github.com', percent: 140 }, 'downloading', 'Downloading 0.165.0 from github.com — 100 %'],
      [{ phase: 'verifying', version: '0.164.0' }, 'verifying', 'Checking file hashes and publisher signatures'],
      [{ phase: 'qualifying', version: '0.164.0' }, 'qualifying', 'Starting it once in UnodeAi\'s folder to check it (no model request)'],
      [{ phase: 'elsewhere', since: '2026-10-21T14:10:00Z' }, 'elsewhere', 'In progress in another window since at(2026-10-21T14:10:00Z)'],
      [{ phase: 'failed', version: '0.164.0', failureClass: 'network', detail: 'ECONNRESET', retryAt: '2026-10-21T15:10:00Z' }, 'failed', 'Downloading 0.164.0 failed: the network connection failed (ECONNRESET). Next try at at(2026-10-21T15:10:00Z).'],
      [{ phase: 'failed', version: '0.164.0', failureClass: 'integrity', detail: 'digest mismatch' }, 'failed', 'Downloading 0.164.0 failed: the downloaded files did not match UnodeAi\'s record (digest mismatch). Not retried automatically.'],
      [{ phase: 'failed', version: '0.164.0', failureClass: 'store-full', detail: '2.9 GiB in use' }, 'store-full', 'The managed Codex store is full, so 0.164.0 was not downloaded (2.9 GiB in use). Not retried automatically.'],
      [{ phase: 'cancelled', version: '0.164.0' }, 'cancelled', 'The download of 0.164.0 was cancelled.'],
    ];
    for (const [task, state, line] of tasks) {
      const result = seen(card(enrolled.world, enrolled, { task }));
      expect(result.state, state).toBe(state);
      expect(result.lines[0], state).toBe(line);
    }
    const available = seen(card(enrolled.world, enrolled, { task: { phase: 'available', version: '0.165.0' } }));
    expect(available.lines).toContain('0.165.0 is supported by this UnodeAi and not downloaded');
  });

  it('a failure recorded by another window comes from the instance schedule', () => {
    const enrolled = enrolledWorld();
    enrolled.world.writeInstance(enrolled.ref, (content) => ({ ...content, schedule: { failure: { class: 'store-full', entryId: NEWER.id, at: 'now', attempts: 1, detail: '3.1 GiB needed' } } }));
    expect(seen(card(enrolled.world, enrolled))).toMatchObject({ state: 'store-full', lines: ['The managed Codex store is full, so 0.165.0 was not downloaded (3.1 GiB needed). Not retried automatically.', 'No managed Codex version is downloaded yet.'] });
  });

  it('verified: Review; active: new sessions use it; a newer verified version heads the card', () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, NEW, { consent: true, probe: true, active: true });
    const active = seen(card(enrolled.world, enrolled));
    expect(active).toEqual({ state: 'active', lines: ['New sessions use 0.164.0. Running agents keep their version until restarted.'], actions: [{ id: 'use-external', label: 'Use external CLI' }] });
    seedVersion(enrolled, NEWER);
    const verified = seen(card(enrolled.world, enrolled));
    expect(verified.state).toBe('verified');
    expect(verified.lines).toEqual(['0.165.0 is downloaded and checked. It runs only after your OK.', 'New sessions use 0.164.0. Running agents keep their version until restarted.']);
    expect(ids(verified)).toEqual([`review:${keyOf(NEWER)}`, 'use-external']);
  });

  it('an unconfirmed stop offers Check again; a second entry for the version takes it away', () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, NEW, { consent: true, disabled: [{ reason: 'probe-stop-unconfirmed', detail: 'taskkill exited 128; its folder 00ab is kept' }] });
    const result = seen(card(enrolled.world, enrolled));
    expect(result.state).toBe('stop-unconfirmed');
    expect(result.lines[0]).toBe('UnodeAi could not confirm that the check\'s process of 0.164.0 stopped (taskkill exited 128; its folder 00ab is kept).');
    expect(ids(result)).toContain(`check-again:${keyOf(NEW)}`);
    enrolled.world.writeControl('reduction', (content) => ({ ...content, disabled: [...content.disabled, { storeId: enrolled.ref.storeId, key: keyOf(NEW), reason: 'policy-bad', at: 'now' }] }));
    expect(ids(seen(card(enrolled.world, enrolled)))).not.toContain(`check-again:${keyOf(NEW)}`);
  });

  it('local-bad and probe-failed offer Try again; the last-known-good is shown in use with the reason', () => {
    for (const reason of ['local-bad', 'probe-failed'] as const) {
      const enrolled = enrolledWorld();
      seedVersion(enrolled, OLD, { consent: true, probe: true, lastKnownGood: true });
      seedVersion(enrolled, NEW, { consent: true, probe: true, active: true, disabled: [{ reason, detail: 'bin/codex.exe changed' }] });
      const result = seen(card(enrolled.world, enrolled));
      expect(result.state, reason).toBe(reason);
      expect(result.lines, reason).toEqual([
        reason === 'local-bad' ? 'UnodeAi marked 0.164.0 bad on this computer (bin/codex.exe changed).' : '0.164.0 did not pass UnodeAi\'s check (bin/codex.exe changed).',
        'New sessions use 0.163.0. Running agents keep their version until restarted.',
        `0.164.0 is not used: ${reason === 'local-bad' ? 'UnodeAi marked it bad on this computer' : 'its check failed'}: bin/codex.exe changed.`,
      ]);
      expect(ids(result), reason).toEqual([`try-again:${keyOf(NEW)}`, 'use-external']);
    }
  });

  it('policy-bad and a withdrawn OK, and nothing launchable: blocked with Update now and Use external CLI', () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, NEW, { consent: true, probe: true, active: true, disabled: [{ reason: 'policy-bad', detail: 'signature revoked' }] });
    const bad = seen(card(enrolled.world, enrolled));
    expect(bad.state).toBe('bad');
    expect(bad.lines).toEqual([
      'This UnodeAi marks 0.164.0 as not to be used (signature revoked).',
      'No managed Codex version can start for new sessions: this UnodeAi marks it not to be used: signature revoked.',
    ]);
    expect(ids(bad)).toEqual(['update-now', 'use-external']);

    const withdrawn = enrolledWorld();
    seedVersion(withdrawn, NEW, { probe: true, active: true, disabled: [{ reason: 'consent-withdrawn' }] });
    expect(seen(card(withdrawn.world, withdrawn))).toMatchObject({ state: 'consent-withdrawn', lines: ['You withdrew your OK for 0.164.0.', expect.stringContaining('No managed Codex version can start')] });
  });

  it('an allowed version whose check fact was lost, and a ready version newer than the one in use', () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, NEW, { consent: true, active: true });
    expect(seen(card(enrolled.world, enrolled))).toMatchObject({ state: 'allowed', lines: ['0.164.0 is allowed, and UnodeAi checks it again before new sessions use it.', expect.stringContaining('No managed Codex version can start')] });

    const ready = enrolledWorld();
    seedVersion(ready, NEW, { consent: true, probe: true, active: true });
    seedVersion(ready, NEWER, { consent: true, probe: true });
    const result = seen(card(ready.world, ready));
    expect(result.state).toBe('ready');
    expect(result.lines).toEqual(['0.165.0 is checked and allowed.', 'New sessions use 0.164.0. Running agents keep their version until restarted.']);
    expect(ids(result)).toEqual([`use-for-new-sessions:${keyOf(NEWER)}`, 'use-external']);
  });

  it('every version comes from the inputs: two policies give two texts', () => {
    const a = enrolledWorld();
    seedVersion(a, NEW, { consent: true, probe: true, active: true });
    const b = enrolledWorld();
    seedVersion(b, NEWER, { consent: true, probe: true, active: true });
    expect(seen(card(a.world, a)).lines[0]).toContain('0.164.0');
    expect(seen(card(b.world, b)).lines[0]).toContain('0.165.0');
  });

  // v0.9.97 field preparation: merged §3.2 makes (A, managed) → Use external CLI a reduction that is always legal, and
  // USAGE promises it. A working managed Codex offered no way back but Reset.
  it('while managed Codex is selected, every managed state offers Use external CLI, once', () => {
    const states: ManagedCodexCard[] = [];
    const empty = enrolledWorld();
    states.push(seen(card(empty.world, empty)));
    const active = enrolledWorld();
    seedVersion(active, NEW, { consent: true, probe: true, active: true });
    states.push(seen(card(active.world, active)));
    states.push(seen(card(active.world, active, { task: { phase: 'downloading', version: '0.165.0', host: 'github.com', percent: 10 } })));
    const blocked = enrolledWorld();
    seedVersion(blocked, NEW, { consent: true, probe: true, active: true, disabled: [{ reason: 'policy-bad', detail: 'signature revoked' }] });
    states.push(seen(card(blocked.world, blocked)));
    for (const state of states) expect(ids(state).filter((id) => id === 'use-external'), state.state).toEqual(['use-external']);
    const external = enrolledWorld({ selection: 'external' });
    expect(ids(seen(card(external.world, external)))).not.toContain('use-external');
  });

  it('"Updated" is never shown, in any state above (Revision 5 §9.5)', () => {
    expect(collected.length).toBeGreaterThan(30);
    expect(new Set(collected.map((result) => result.state)).size).toBeGreaterThanOrEqual(24);
    for (const result of collected) {
      for (const text of [...result.lines, ...result.actions.map((action) => action.label)]) expect(text).not.toMatch(/\bupdated\b/i);
    }
  });
});
