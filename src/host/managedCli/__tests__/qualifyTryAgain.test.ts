import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clickOffer, VerifiedKeyNotices, type ActivationDialog } from '../qualify/activation';
import { checkAfterAgentStartFailure } from '../qualify/agentStartFailure';
import { managedCodexCard } from '../qualify/cardState';
import { launchableKey, reconcilePolicy } from '../qualify/policyReconcile';
import { qualifyVersion } from '../qualify/qualification';
import { tryAgain, type TryAgainDeps, type TryAgainRequest } from '../qualify/tryAgain';
import { codexEntry, digestOf, enrolledWorld, fakeDownload, harness, HOST, keyOf, seedVersion, testPolicy, type ProbeScriptStep, type SeedOptions } from './qualifyFixtures';

// The design these tests realise: Codex's binding ruling Q3 ("no automatic task may retry, clear, or repromote a
// local-bad key; a user may explicitly choose Try again for that same key; the old disabled entry remains
// authoritative throughout the attempt; with no live or unknown lease that could use the folder, the attempt retires
// the suspect local copy, downloads to staging, and repeats the complete V1–V4, closure, and probe qualification
// path; only after all positive facts are durably published may a floor-protected user re-decision remove the
// matching local-bad entry; and failure leaves the prohibition in place and never starts an automatic retry loop. If
// the repaired closure is exactly the already-consented (storeId, key, closureDigest), the existing consent remains
// exact and no second click is needed. A different closure cannot inherit that consent."), and ADAPTER §5.11.4 as
// amended. Our recorded choice: Try again also repairs `probe-failed`, which Revision 5 §9.3 calls localBad.

const V1 = codexEntry({ version: '0.164.0' });
const policy = testPolicy([V1]);
const KEY = keyOf(V1);
const D = digestOf(V1);
const LOCAL_BAD = { reason: 'local-bad' as const, closureDigest: D, detail: 'its files changed after they were checked (bin/codex.exe changed)' };

function setup(seed: SeedOptions = { consent: true, probe: true, active: true, disabled: [LOCAL_BAD] }, probeSteps: ProbeScriptStep[] = [], usePolicy = policy) {
  const enrolled = enrolledWorld();
  seedVersion(enrolled, V1, seed);
  // The suspect copy: its files no longer give the allowed closure.
  enrolled.world.folderDigests.set(enrolled.world.instance().versionFolder(enrolled.ref, KEY), 'c'.repeat(64));
  return { ...enrolled, ...harness(enrolled.world, usePolicy, { probeSteps }) };
}

function request(ref: TryAgainRequest['ref'], askForNewClick: (dialog: ActivationDialog) => Promise<boolean> = async () => { throw new Error('no new click expected'); }): TryAgainRequest {
  return { ref, key: KEY, userChoice: 'try-again', askForNewClick, signal: new AbortController().signal };
}

describe('Try again (Codex Q3)', () => {
  it('repairs byte-identical qualified bytes and keeps the existing OK: no second click', async () => {
    const { world, ref, deps, probe, download } = setup();
    const consentsBefore = world.controlRecord().activationConsents;
    const outcome = await tryAgain(deps, request(ref));
    expect(outcome).toMatchObject({ outcome: 'ready', key: KEY, activation: { activated: true } });
    expect(download.calls).toEqual([{ key: KEY }]);
    expect(probe.calls).toHaveLength(1);
    expect(world.controlRecord().disabled).toEqual([]);
    expect(world.controlRecord().activationConsents).toEqual(consentsBefore);
    expect(world.controlPublications.filter((publication) => publication.label === 'activation-consent')).toEqual([]);
    const order = ['w1:retire', 'download', 'w1:promote', 'probe.spawn', 'w1:instance.publish:probe-pass:published', 'w1:control.publish:redecide-local-bad:reduction:published']
      .map((event) => world.events.indexOf(event));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(world.instanceRecord(ref).probes[KEY]).toMatchObject({ closureDigest: D });
  });

  it('keeps the old entry in force throughout the attempt, until the probe fact is published', async () => {
    const seen: string[][] = [];
    const holder: { world?: ReturnType<typeof setup>['world'] } = {};
    const note = () => { seen.push(holder.world ? holder.world.controlRecord().disabled.map((entry) => entry.reason) : []); };
    const run = setup(undefined, [{ during: note }]);
    holder.world = run.world;
    run.world.hooks.instanceBeforeLink = (change) => { if (change.label === 'probe-pass') note(); };
    const download = fakeDownload(run.world);
    const deps: TryAgainDeps = { ...run.deps, downloadAndPromote: async (ref, entry, signal) => { note(); return download.run(ref, entry, signal); } };
    expect(await tryAgain(deps, request(run.ref))).toMatchObject({ outcome: 'ready' });
    expect(seen).toEqual([['local-bad'], ['local-bad'], ['local-bad']]);
  });

  it('a different closure cannot inherit the OK: it needs a new click, and without it the version stays verified', async () => {
    // The OK was given for files an older policy described; this UnodeAi's entry for the same key lists other files.
    const changed = codexEntry({ version: '0.164.0', layoutSalt: 'new layout' });
    const newPolicy = testPolicy([changed]);
    const declined = setup(undefined, [], newPolicy);
    const dialogs: ActivationDialog[] = [];
    const outcome = await tryAgain(declined.deps, request(declined.ref, async (dialog) => { dialogs.push(dialog); return false; }));
    expect(outcome).toEqual({ outcome: 'not-now' });
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].title).toBe('Allow Codex CLI 0.164.0 to run?');
    expect(declined.probe.calls).toHaveLength(0);
    expect(declined.world.controlRecord().disabled).toEqual([expect.objectContaining({ reason: 'local-bad' })]);
    expect(declined.world.instanceRecord(declined.ref).versions[KEY]).toBeDefined();
    expect(declined.world.instanceRecord(declined.ref).probes[KEY]).toBeUndefined();

    const allowed = setup(undefined, [], newPolicy);
    const result = await tryAgain(allowed.deps, request(allowed.ref, async () => true));
    expect(result).toMatchObject({ outcome: 'ready' });
    expect(allowed.world.controlRecord().activationConsents.map((consent) => consent.closureDigest)).toEqual([D, digestOf(changed)]);
    expect(allowed.world.controlRecord().disabled).toEqual([]);
  });

  it('a failed retry stays disabled and retries nothing: a failing check replaces the entry by probe-failed', async () => {
    const failing = setup(undefined, [{ result: 'fail', detail: 'config/read refused' }]);
    expect(await tryAgain(failing.deps, request(failing.ref))).toMatchObject({ outcome: 'failed', reason: 'probe-failed' });
    expect(failing.world.controlRecord().disabled).toEqual([expect.objectContaining({ key: KEY, reason: 'probe-failed' })]);
    expect(failing.world.instanceRecord(failing.ref).probes[KEY]).toBeUndefined();
    expect(failing.probe.calls).toHaveLength(1);
    expect(failing.download.calls).toHaveLength(1);

    const unconfirmed = setup(undefined, [{ result: 'stop-unconfirmed', detail: 'taskkill exited 128' }]);
    expect(await tryAgain(unconfirmed.deps, request(unconfirmed.ref))).toMatchObject({ outcome: 'stop-unconfirmed' });
    expect(unconfirmed.world.controlRecord().disabled).toEqual([expect.objectContaining({ reason: 'probe-stop-unconfirmed' })]);

    const download = setup();
    const failingDownload = fakeDownload(download.world, 'w1', { fail: 'the artifact digest did not match' });
    expect(await tryAgain({ ...download.deps, downloadAndPromote: failingDownload.run }, request(download.ref))).toMatchObject({ outcome: 'download-failed' });
    expect(download.world.controlRecord().disabled).toEqual([expect.objectContaining({ reason: 'local-bad' })]);
    expect(download.probe.calls).toHaveLength(0);

    const changedAgain = setup();
    const otherFiles = fakeDownload(changedAgain.world, 'w1', { digest: 'e'.repeat(64) });
    expect(await tryAgain({ ...changedAgain.deps, downloadAndPromote: otherFiles.run }, request(changedAgain.ref))).toMatchObject({ outcome: 'refused', reason: 'closure-changed' });
    expect(changedAgain.world.controlRecord().disabled).toEqual([expect.objectContaining({ reason: 'local-bad', detail: expect.stringContaining('its files changed after they were checked') })]);
  });

  it('a live or unknown lease refuses the replacement, with nothing changed', async () => {
    for (const liveness of ['alive', 'unknown'] as const) {
      const { world, ref, deps, probe, download } = setup();
      const session = world.instance('w2').createLease(ref, KEY, 'session', { pid: 77, creation: 'x' });
      const state = world.instanceState(ref);
      const lease = state.leases.get(session.token);
      if (lease) lease.liveness = liveness;
      const facts = world.instanceRecord(ref);
      const generations = world.controlGenerations.length;
      expect(await tryAgain(deps, request(ref)), liveness).toMatchObject({ outcome: 'in-use' });
      expect(download.calls).toHaveLength(0);
      expect(probe.calls).toHaveLength(0);
      expect(world.instanceRecord(ref)).toEqual(facts);
      expect(world.controlGenerations.length).toBe(generations);
      expect(world.instanceState(ref).folders.has(KEY)).toBe(true);
    }
  });

  it('repairs a probe-failed version the same way (our recorded choice)', async () => {
    const { world, ref, deps } = setup({ consent: true, active: true, disabled: [{ reason: 'probe-failed', closureDigest: D }] });
    expect(await tryAgain(deps, request(ref))).toMatchObject({ outcome: 'ready' });
    expect(world.controlRecord().disabled).toEqual([]);
  });

  it('is refused for policy-bad, consent-withdrawn, an unconfirmed stop, two entries, External, a suspension, and without the user\'s choice', async () => {
    const cases: Array<[string, SeedOptions, (run: ReturnType<typeof setup>) => void]> = [
      ['policy-bad', { consent: true, disabled: [{ reason: 'policy-bad' }] }, () => undefined],
      ['consent-withdrawn', { consent: true, disabled: [{ reason: 'consent-withdrawn' }] }, () => undefined],
      ['unconfirmed stop', { consent: true, disabled: [{ reason: 'probe-stop-unconfirmed' }] }, () => undefined],
      ['two entries', { consent: true, disabled: [LOCAL_BAD, { reason: 'policy-bad' }] }, () => undefined],
      ['External', { consent: true, disabled: [LOCAL_BAD] }, (run) => run.world.writeControl('reduction', (content) => ({ ...content, selection: 'external' }))],
      ['suspension', { consent: true, disabled: [LOCAL_BAD] }, (run) => { run.world.suspension = { kind: 'unreadable' }; }],
    ];
    for (const [name, seed, prepare] of cases) {
      const run = setup(seed);
      prepare(run);
      expect(await tryAgain(run.deps, request(run.ref)), name).toMatchObject({ outcome: 'refused' });
      expect(run.download.calls, name).toHaveLength(0);
      expect(run.world.events.filter((event) => event.endsWith(':retire')), name).toEqual([]);
    }
    const run = setup();
    expect(await tryAgain(run.deps, { ...request(run.ref), userChoice: undefined } as unknown as TryAgainRequest)).toMatchObject({ outcome: 'refused', reason: 'user-action' });
    expect(run.download.calls).toHaveLength(0);
  });

  it('no automatic path calls Try again: every scheduler-facing function leaves a local-bad version alone', async () => {
    const { world, ref, deps, probe, download } = setup();
    const before = world.controlRecord().disabled;
    // The automatic check again of an allowed version, the check after an agent start failed, the policy
    // reconciliation, the click offer and its notification, the launch decision and the card.
    expect(await qualifyVersion(deps, ref, KEY, 'qualification')).toMatchObject({ outcome: 'refused', reason: 'disabled' });
    expect(await checkAfterAgentStartFailure(deps, ref, KEY, { kind: 'spawn-error', detail: 'ENOENT' })).toMatchObject({ outcome: 'not-checked' });
    await reconcilePolicy(deps, policy, deps.now);
    const offer = clickOffer({ suspension: deps.control.readSuspension(), control: deps.control.read(), instance: deps.instance.read(ref), policy, host: HOST, key: KEY });
    expect(new VerifiedKeyNotices().next(offer, true)).toBeUndefined();
    expect(launchableKey({ suspension: deps.control.readSuspension(), control: deps.control.read(), instance: deps.instance.read(ref), policy, host: HOST }).launchable).toBe(false);
    const card = managedCodexCard({ host: HOST, suspension: deps.control.readSuspension(), control: deps.control.read(), instance: deps.instance.read(ref), policy, formatTime: (iso) => iso });
    expect(card.actions).toContainEqual({ id: 'try-again', label: 'Try again', key: KEY });
    expect(download.calls).toHaveLength(0);
    expect(probe.calls).toHaveLength(0);
    expect(world.events.filter((event) => event.endsWith(':retire'))).toEqual([]);
    expect(world.controlRecord().disabled).toEqual(before);
  });

  it('only the Try again module refers to Try again', () => {
    const folder = path.join(__dirname, '..', 'qualify');
    for (const file of readdirSync(folder).filter((name) => name.endsWith('.ts') && name !== 'tryAgain.ts')) {
      expect(readFileSync(path.join(folder, file), 'utf8'), file).not.toMatch(/from '\.\/tryAgain'|\btryAgain\(/);
    }
  });
});
