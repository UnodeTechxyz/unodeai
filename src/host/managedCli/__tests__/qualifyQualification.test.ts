import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { admitManagedStart } from '../qualify/admission';
import { checkAgain, checkAgainWarning, type CheckAgainRequest } from '../qualify/checkAgain';
import { launchableKey } from '../qualify/policyReconcile';
import { activateVersion, qualifyVersion } from '../qualify/qualification';
import { codexEntry, digestOf, enrolledWorld, harness, keyOf, seedVersion, testPolicy, type ProbeScriptStep, type SeedOptions } from './qualifyFixtures';

// The design these tests realise: Revision 5 §9.3 (the post-click probe: a pass with a confirmed stop releases the
// lease and removes the work folder; a fail marks the version bad; an unconfirmed stop keeps the version
// `verified`, its lease and its work folder, and offers Check again, a user action that first shows the warning and
// never runs automatically), merged design §3.3 ("Check again ... publishes a generation that replaces the
// probe-stop-unconfirmed entry ... That generation counts as a reduction"), and Codex's binding ruling Q2: "write and
// durably publish the positive probe fact in the instance; then publish the floor-protected control generation that
// removes/replaces only the matching probe-stop-unconfirmed entry. If the process stops or crashes between those
// steps, the prohibition remains. The reverse order is forbidden."

const V1 = codexEntry({ version: '0.164.0' });
const V0 = codexEntry({ version: '0.163.0' });
const policy = testPolicy([V0, V1]);
const KEY = keyOf(V1);
const D = digestOf(V1);

function setup(seed: SeedOptions = { consent: true }, probeSteps: ProbeScriptStep[] = []) {
  const enrolled = enrolledWorld();
  seedVersion(enrolled, V1, seed);
  return { ...enrolled, ...harness(enrolled.world, policy, { probeSteps }) };
}

const UNCONFIRMED = { reason: 'probe-stop-unconfirmed' as const, closureDigest: D, detail: 'the tree did not end; its folder 00ff is kept' };

describe('the check after the click: outcomes (Revision 5 §9.3)', () => {
  it('a pass with a confirmed stop: the work folder is removed, the probe fact recorded, the version made active, the lease released', async () => {
    const { world, ref, deps, probe } = setup();
    const outcome = await qualifyVersion(deps, ref, KEY, 'qualification');
    expect(outcome).toMatchObject({ outcome: 'ready', key: KEY, activation: { activated: true } });
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].executable).toBe(path.join(deps.instance.versionFolder(ref, KEY), 'bin', 'codex.exe'));
    expect(world.instanceRecord(ref).probes[KEY]).toEqual({ key: KEY, closureDigest: D, versionOutput: V1.versionOutput, startedAt: expect.any(String), durationMs: 400 });
    expect(world.controlRecord().active).toEqual({ storeId: ref.storeId, key: KEY });
    expect(world.leasesOn(ref, KEY)).toEqual([]);
    expect(world.instanceState(ref).work.size).toBe(0);
    expect(world.controlRecord().disabled).toEqual([]);
  });

  it('a fail: probe-failed with the closure digest and a bounded detail; the work folder removed; the lease released; nothing activated', async () => {
    const { world, ref, deps } = setup({ consent: true }, [{ result: 'fail', detail: `config/read refused: ${'x'.repeat(2000)}` }]);
    const outcome = await qualifyVersion(deps, ref, KEY, 'qualification');
    expect(outcome).toMatchObject({ outcome: 'failed', reason: 'probe-failed', recorded: true });
    const [entry] = world.controlRecord().disabled;
    expect(entry).toMatchObject({ storeId: ref.storeId, key: KEY, reason: 'probe-failed', closureDigest: D });
    expect((entry.detail ?? '').length).toBeLessThanOrEqual(300);
    expect(world.controlPublications.at(-1)).toMatchObject({ label: 'disable-probe-failed', kind: 'reduction', outcome: 'published' });
    expect(world.instanceRecord(ref).probes[KEY]).toBeUndefined();
    expect(world.controlRecord().active).toBeNull();
    expect(world.leasesOn(ref, KEY)).toEqual([]);
    expect(world.instanceState(ref).work.size).toBe(0);
  });

  it('a pass whose version output is not the entry\'s counts as a failure', async () => {
    const { world, ref, deps } = setup({ consent: true }, [{ result: 'pass', versionOutput: 'codex-cli 9.9.9' }]);
    expect(await qualifyVersion(deps, ref, KEY, 'qualification')).toMatchObject({ outcome: 'failed', reason: 'probe-failed' });
    expect(world.instanceRecord(ref).probes[KEY]).toBeUndefined();
  });

  it('an unconfirmed stop: the version stays verified, its lease and its work folder are kept, the OK stays (mutant L6)', async () => {
    const { world, ref, deps } = setup({ consent: true }, [{ result: 'stop-unconfirmed', detail: 'taskkill exited 128' }]);
    const outcome = await qualifyVersion(deps, ref, KEY, 'qualification');
    expect(outcome).toMatchObject({ outcome: 'stop-unconfirmed', recorded: true });
    if (outcome.outcome !== 'stop-unconfirmed') return;
    const disabled = world.controlRecord().disabled;
    expect(disabled).toEqual([expect.objectContaining({ key: KEY, reason: 'probe-stop-unconfirmed', closureDigest: D })]);
    expect(disabled[0].detail).toContain('taskkill exited 128');
    expect(disabled[0].detail).toContain(outcome.workToken);
    expect(world.leasesOn(ref, KEY)).toEqual([expect.objectContaining({ kind: 'probe', child: { pid: 4242, creation: 'pending' } })]);
    expect([...world.instanceState(ref).work.keys()]).toEqual([outcome.workToken]);
    expect(world.controlRecord().activationConsents).toEqual([expect.objectContaining({ key: KEY, closureDigest: D })]);
    expect(world.instanceRecord(ref).probes[KEY]).toBeUndefined();
    expect(world.controlRecord().active).toBeNull();
    expect(launchableKey({ suspension: world.suspensionView(), control: world.controlView(), instance: deps.instance.read(ref), policy, host: deps.host }).launchable).toBe(false);
  });

  it('a probe that throws is an unconfirmed stop: its process may still run', async () => {
    const { world, ref, deps } = setup({ consent: true }, [{ throws: new Error('pipe closed') }]);
    expect(await qualifyVersion(deps, ref, KEY, 'qualification')).toMatchObject({ outcome: 'stop-unconfirmed' });
    expect(world.controlRecord().disabled.map((entry) => entry.reason)).toEqual(['probe-stop-unconfirmed']);
    expect(world.leasesOn(ref, KEY)).toHaveLength(1);
    expect(world.instanceState(ref).held).toBe(0);
  });

  it('no automatic check runs a version with an unconfirmed stop again', async () => {
    const { ref, deps, probe } = setup({ consent: true, disabled: [UNCONFIRMED] });
    expect(await qualifyVersion(deps, ref, KEY, 'qualification')).toMatchObject({ outcome: 'refused', reason: 'disabled' });
    expect(probe.calls).toHaveLength(0);
  });
});

describe('Check again (Codex Q2)', () => {
  const request = (ref: CheckAgainRequest['ref']): CheckAgainRequest => ({ ref, key: KEY, warningShown: true });

  it('publishes the probe fact first and only then the reduction that removes exactly that entry, then activates', async () => {
    const enrolled = enrolledWorld();
    const { world, ref } = enrolled;
    seedVersion(enrolled, V1, { consent: true, disabled: [UNCONFIRMED] });
    // An unconfirmed stop of another version, and another prohibition of another version, stay untouched.
    seedVersion(enrolled, V0, { consent: true, disabled: [{ ...UNCONFIRMED, closureDigest: digestOf(V0) }, { reason: 'policy-bad' }] });
    const { deps, probe } = harness(world, policy);
    const floorBefore = world.floor;

    const outcome = await checkAgain(deps, request(ref));
    expect(outcome).toMatchObject({ outcome: 'ready', activation: { activated: true } });
    expect(probe.calls).toHaveLength(1);
    const fact = world.events.indexOf('w1:instance.publish:probe-pass:published');
    const redecision = world.events.indexOf('w1:control.publish:redecide-probe-stop-unconfirmed:reduction:published');
    const activation = world.events.indexOf('w1:control.publish:activate:increase:published');
    expect(fact).toBeGreaterThan(-1);
    expect(redecision).toBeGreaterThan(fact);
    expect(activation).toBeGreaterThan(redecision);
    // The re-decision is a recorded reduction: it took a floor epoch.
    expect(world.controlPublications.find((publication) => publication.label === 'redecide-probe-stop-unconfirmed')).toMatchObject({ kind: 'reduction', epoch: floorBefore + 1 });
    expect(world.floor).toBe(floorBefore + 1);
    const disabled = world.controlRecord().disabled;
    expect(disabled.filter((entry) => entry.key === KEY)).toEqual([]);
    expect(disabled.filter((entry) => entry.key === keyOf(V0)).map((entry) => entry.reason).sort()).toEqual(['policy-bad', 'probe-stop-unconfirmed']);
  });

  it('a stop after the probe fact, before the control generation, leaves the prohibition in force', async () => {
    const { world, ref, deps } = setup({ consent: true, disabled: [UNCONFIRMED] });
    world.hooks.controlCrash = (change) => change.label.startsWith('redecide-');
    await expect(checkAgain(deps, request(ref))).rejects.toThrow('the window stopped');
    world.hooks = {};
    // The positive fact is durable; the prohibition is still recorded, so another window cannot start the version.
    expect(world.instanceRecord(ref).probes[KEY]).toMatchObject({ closureDigest: D });
    expect(world.controlRecord().disabled).toEqual([expect.objectContaining({ key: KEY, reason: 'probe-stop-unconfirmed' })]);
    const other = harness(world, policy, { window: 'w2' });
    expect(await qualifyVersion(other.deps, ref, KEY, 'qualification')).toMatchObject({ outcome: 'refused', reason: 'disabled' });
    expect(other.probe.calls).toHaveLength(0);
    world.writeControl('increase', (content) => ({ ...content, active: { storeId: ref.storeId, key: KEY } }));
    expect(launchableKey({ suspension: world.suspensionView(), control: world.controlView(), instance: other.deps.instance.read(ref), policy, host: other.deps.host }).launchable).toBe(false);
  });

  it('keeps the prohibition when the probe fact cannot be published (the reverse order would have removed it)', async () => {
    const { world, ref, deps } = setup({ consent: true, disabled: [UNCONFIRMED] });
    world.hooks.instanceCrash = (change) => change.label === 'probe-pass';
    expect(await checkAgain(deps, request(ref))).toMatchObject({ outcome: 'not-recorded', stage: 'probe-fact' });
    world.hooks = {};
    expect(world.controlRecord().disabled).toEqual([expect.objectContaining({ key: KEY, reason: 'probe-stop-unconfirmed' })]);
    expect(world.controlPublications.filter((publication) => publication.label.startsWith('redecide-'))).toEqual([]);

    // Another window unpublishes the version's facts just before the link: the fact, re-applied on the winner, is refused.
    const refused = setup({ consent: true, disabled: [UNCONFIRMED] });
    refused.world.hooks.instanceBeforeLink = (change, _window, round) => {
      if (change.label === 'probe-pass' && round === 1) refused.world.writeInstance(refused.ref, (content) => ({ ...content, versions: {}, probes: {} }));
    };
    expect(await checkAgain(refused.deps, request(refused.ref))).toMatchObject({ outcome: 'not-recorded', stage: 'probe-fact' });
    expect(refused.world.controlRecord().disabled).toEqual([expect.objectContaining({ reason: 'probe-stop-unconfirmed' })]);
    expect(refused.world.controlPublications.filter((publication) => publication.label.startsWith('redecide-'))).toEqual([]);
  });

  it('replaces the entry with the new result: a failure by probe-failed, a new unconfirmed stop by a new entry', async () => {
    const failed = setup({ consent: true, disabled: [UNCONFIRMED] }, [{ result: 'fail', detail: 'initialize timed out' }]);
    expect(await checkAgain(failed.deps, request(failed.ref))).toMatchObject({ outcome: 'failed', reason: 'probe-failed' });
    expect(failed.world.controlRecord().disabled).toEqual([expect.objectContaining({ key: KEY, reason: 'probe-failed', detail: 'initialize timed out' })]);

    const again = setup({ consent: true, disabled: [UNCONFIRMED] }, [{ result: 'stop-unconfirmed', detail: 'taskkill exited 1' }]);
    const outcome = await checkAgain(again.deps, request(again.ref));
    expect(outcome).toMatchObject({ outcome: 'stop-unconfirmed', recorded: true });
    const disabled = again.world.controlRecord().disabled;
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toMatchObject({ key: KEY, reason: 'probe-stop-unconfirmed' });
    expect(disabled[0].detail).toContain('taskkill exited 1');
    expect(again.world.leasesOn(again.ref, KEY)).toHaveLength(1);
  });

  it('never runs without the warning argument, and the warning names the version and the earlier detail', async () => {
    const { ref, deps, probe } = setup({ consent: true, disabled: [UNCONFIRMED] });
    expect(await checkAgain(deps, { ref, key: KEY, warningShown: false } as unknown as CheckAgainRequest)).toMatchObject({ outcome: 'refused', reason: 'warning' });
    expect(await checkAgain(deps, { ref, key: KEY } as unknown as CheckAgainRequest)).toMatchObject({ outcome: 'refused', reason: 'warning' });
    expect(probe.calls).toHaveLength(0);
    const warning = checkAgainWarning('0.164.0', 'taskkill exited 128');
    expect(warning).toContain('Codex 0.164.0');
    expect(warning).toContain('taskkill exited 128');
  });

  it('does not pass a suspension, another reason or another setup', async () => {
    const suspended = setup({ consent: true, disabled: [UNCONFIRMED] });
    suspended.world.suspension = { kind: 'unreadable' };
    expect(await checkAgain(suspended.deps, request(suspended.ref))).toMatchObject({ outcome: 'refused', reason: 'suspended' });
    const policyBad = setup({ consent: true, disabled: [{ reason: 'policy-bad' }] });
    expect(await checkAgain(policyBad.deps, request(policyBad.ref))).toMatchObject({ outcome: 'refused', reason: 'disabled' });
    const twoEntries = setup({ consent: true, disabled: [UNCONFIRMED, { reason: 'consent-withdrawn' }] });
    expect(await checkAgain(twoEntries.deps, request(twoEntries.ref))).toMatchObject({ outcome: 'refused', reason: 'disabled' });
    for (const run of [suspended, policyBad, twoEntries]) expect(run.probe.calls).toHaveLength(0);
  });
});

describe('activation and the last-known-good (Revision 5 §9.1, ADAPTER §5.7.2 as amended)', () => {
  it('the previous active becomes the last-known-good when it is still launchable', async () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, V0, { consent: true, probe: true, active: true });
    seedVersion(enrolled, V1, { consent: true });
    const { deps } = harness(enrolled.world, policy);
    expect(await qualifyVersion(deps, enrolled.ref, KEY, 'qualification')).toMatchObject({ outcome: 'ready', activation: { activated: true, lastKnownGood: keyOf(V0) } });
    expect(enrolled.world.controlRecord()).toMatchObject({ active: { key: KEY }, lastKnownGood: { key: keyOf(V0) } });
  });

  it('a previous active that is not launchable leaves the last-known-good unchanged', async () => {
    for (const seed of [
      { consent: true, probe: true, active: true, disabled: [{ reason: 'local-bad' as const }] },
      { consent: true, active: true },
      { probe: true, active: true },
    ]) {
      const enrolled = enrolledWorld();
      seedVersion(enrolled, V0, seed);
      seedVersion(enrolled, V1, { consent: true });
      const { deps } = harness(enrolled.world, policy);
      expect(await qualifyVersion(deps, enrolled.ref, KEY, 'qualification')).toMatchObject({ outcome: 'ready', activation: { activated: true, lastKnownGood: null } });
      expect(enrolled.world.controlRecord()).toMatchObject({ active: { key: KEY }, lastKnownGood: null });
    }
  });

  it('a previous active whose hosts are no longer allowed is not kept as the last-known-good', async () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, V0, { consent: true, probe: true, active: true });
    seedVersion(enrolled, V1, { consent: true });
    enrolled.world.writeControl('reduction', (content) => ({ ...content, enrollment: { epoch: 1, consentedHosts: ['releases.openai.com'], decidedAt: content.decidedAt } }));
    const { deps } = harness(enrolled.world, policy);
    expect(await qualifyVersion(deps, enrolled.ref, KEY, 'qualification')).toMatchObject({ outcome: 'ready' });
    expect(enrolled.world.controlRecord().lastKnownGood).toBeNull();
  });

  it('never activates without the click, a disabled version, or an older version than the active one', async () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, V1, { probe: true });
    const { deps } = harness(enrolled.world, policy);
    expect(await activateVersion(deps, enrolled.ref, KEY)).toMatchObject({ activated: false });
    expect(enrolled.world.controlRecord().active).toBeNull();

    const disabled = enrolledWorld();
    seedVersion(disabled, V1, { consent: true, probe: true, disabled: [{ reason: 'probe-failed' }] });
    expect(await activateVersion(harness(disabled.world, policy).deps, disabled.ref, KEY)).toMatchObject({ activated: false });

    const older = enrolledWorld();
    seedVersion(older, V1, { consent: true, probe: true, active: true });
    seedVersion(older, V0, { consent: true, probe: true });
    expect(await activateVersion(harness(older.world, policy).deps, older.ref, keyOf(V0))).toMatchObject({ activated: false, reason: 'a newer version is already used for new sessions' });
    expect(older.world.controlRecord().active).toMatchObject({ key: KEY });
  });

  it('an admitted start abandoned before spawning leaves no lease and no held gate', async () => {
    const { world, ref, deps } = setup();
    const admission = await admitManagedStart(deps, ref, KEY, D, 'qualification');
    expect(admission.admitted).toBe(true);
    if (admission.admitted) admission.start.abandon();
    expect(world.leasesOn(ref, KEY)).toEqual([]);
    expect(world.instanceState(ref).held).toBe(0);
  });
});
