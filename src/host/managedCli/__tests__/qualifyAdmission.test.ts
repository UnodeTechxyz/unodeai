import { describe, expect, it } from 'vitest';
import type { ControlChange, DisabledReason } from '../contracts';
import { checkAfterAgentStartFailure } from '../qualify/agentStartFailure';
import { admitManagedStart, type ManagedStartPurpose } from '../qualify/admission';
import { checkAgain } from '../qualify/checkAgain';
import { qualifyVersion } from '../qualify/qualification';
import { tryAgain } from '../qualify/tryAgain';
import { codexEntry, digestOf, enrolledWorld, harness, keyOf, seedVersion, testPolicy, type SeedOptions } from './qualifyFixtures';

// The design these tests realise: the one final admission check of every managed check start (Codex's binding
// rulings on the P6 store design: Q1 "every path that can spawn a managed Codex root process checks both
// enrolledStoreId = pin.storeId and selection = managed at its final admission point"; Q2/Q3 "only the explicit
// Check again / Try again may bypass that exact reason"; Q4.2 "an operation that completed its final admission before
// suspension publication may finish under the old decision; every operation whose admission linearizes afterwards
// refuses"), with the order of the immutable-instance design §8: gate, identity through the handle, control re-read,
// lease, closure check, spawn, then the gate is released.

const V1 = codexEntry({ version: '0.164.0' });
const policy = testPolicy([V1]);
const KEY = keyOf(V1);
const D = digestOf(V1);

function setup(seed: SeedOptions = { consent: true }, options: { selection?: 'managed' | 'external' } = {}) {
  const enrolled = enrolledWorld(options);
  const version = seedVersion(enrolled, V1, seed);
  return { ...enrolled, version, ...harness(enrolled.world, policy) };
}

const useManaged: ControlChange = { label: 'use-managed', kind: 'increase', apply: (current) => ({ ...current, selection: 'managed' }) };
const useExternal: ControlChange = { label: 'use-external', kind: 'reduction', apply: (current) => ({ ...current, selection: 'external' }) };

describe('admitManagedStart: the order of the final admission', () => {
  it('acquires the gate before reading control, holds it through the closure check, and releases it once the child spawned', async () => {
    const { world, ref, deps, probe } = setup();
    const heldDuringRead: number[] = [];
    const resetDuringRead: boolean[] = [];
    world.hooks.onControlRead = () => {
      heldDuringRead.push(world.instanceState(ref).held);
    };
    world.hooks.onSuspensionRead = () => {
      heldDuringRead.push(world.instanceState(ref).held);
    };
    const admission = await admitManagedStart(deps, ref, KEY, D, 'qualification');
    expect(admission.admitted).toBe(true);
    // A Reset in another window (the gate's rename) fails while the decision is held.
    const reset = await world.instance('w2').closeAdmission(ref);
    resetDuringRead.push(reset.ok);
    expect(heldDuringRead).toEqual([1, 1]);
    expect(resetDuringRead).toEqual([false]);
    if (!admission.admitted) return;
    const work = deps.instance.createWorkFolder(ref, world.token());
    const result = await admission.start.spawn(work);
    expect(result.result).toBe('pass');
    expect(world.instanceState(ref).held).toBe(0);
    const order = world.events.filter((event) => !event.startsWith('w2:'));
    const at = (name: string) => order.findIndex((event) => event.endsWith(name));
    expect(at('gate.acquire')).toBeLessThan(at('suspension.read'));
    expect(at('suspension.read')).toBeLessThan(at('control.read'));
    expect(at('control.read')).toBeLessThan(at('lease.create:probe'));
    expect(at('lease.create:probe')).toBeLessThan(at('closure.check'));
    expect(at('closure.check')).toBeLessThan(at('probe.spawn'));
    expect(at('lease.child')).toBeLessThan(at('gate.release'));
    expect(at('gate.release')).toBeLessThan(at('probe.end'));
    expect(probe.calls).toHaveLength(1);
  });

  it('reads the instance identity through the gate handle: a gate naming another instance refuses before any read', async () => {
    const { world, ref, deps, probe } = setup();
    world.instanceState(ref).foreignGate = true;
    const admission = await admitManagedStart(deps, ref, KEY, D, 'qualification');
    expect(admission).toMatchObject({ admitted: false, reason: 'gate' });
    expect(world.events.some((event) => event.endsWith('control.read'))).toBe(false);
    expect(world.instanceState(ref).held).toBe(0);
    expect(probe.calls).toHaveLength(0);
  });

  it('refuses a closed gate (a Reset in progress) with no lease and no read of control', async () => {
    const { world, ref, deps } = setup();
    expect((await world.instance('w2').closeAdmission(ref)).ok).toBe(true);
    const admission = await admitManagedStart(deps, ref, KEY, D, 'qualification');
    expect(admission).toMatchObject({ admitted: false, reason: 'gate' });
    expect(world.leasesOn(ref, KEY)).toEqual([]);
    expect(world.events.some((event) => event.endsWith('control.read'))).toBe(false);
  });

  it('creates the lease only after the final check: a refusal there leaves no lease and releases the gate', async () => {
    const { world, ref, deps } = setup({});
    const admission = await admitManagedStart(deps, ref, KEY, D, 'qualification');
    expect(admission).toMatchObject({ admitted: false, reason: 'no-consent' });
    expect(world.events.some((event) => event.includes('lease.create'))).toBe(false);
    expect(world.instanceState(ref).held).toBe(0);
  });

  it('re-reads the facts after the lease: a version unpublished meanwhile refuses, deletes the lease and releases the gate', async () => {
    const { world, ref, deps, probe } = setup();
    world.hooks.afterLeaseCreated = () => {
      world.writeInstance(ref, (content) => ({ ...content, versions: {}, probes: {} }));
    };
    const admission = await admitManagedStart(deps, ref, KEY, D, 'qualification');
    expect(admission).toMatchObject({ admitted: false, reason: 'version-gone' });
    expect(world.leasesOn(ref, KEY)).toEqual([]);
    expect(world.instanceState(ref).held).toBe(0);
    expect(probe.calls).toHaveLength(0);
  });

  it('records local-bad and refuses when the files differ from the allowed closure (Revision 5 §5.2)', async () => {
    const { world, ref, deps, probe } = setup();
    world.folderDigests.set(deps.instance.versionFolder(ref, KEY), 'f'.repeat(64));
    const outcome = await qualifyVersion(deps, ref, KEY, 'qualification');
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'closure-changed' });
    expect(probe.calls).toHaveLength(0);
    const disabled = world.controlRecord().disabled;
    expect(disabled).toEqual([expect.objectContaining({ storeId: ref.storeId, key: KEY, closureDigest: D, reason: 'local-bad' })]);
    expect(disabled[0].detail).toMatch(/its files changed after they were checked/);
    expect(world.controlPublications.at(-1)).toMatchObject({ label: 'disable-local-bad', kind: 'reduction', outcome: 'published' });
    expect(world.leasesOn(ref, KEY)).toEqual([]);
    expect(world.instanceState(ref).held).toBe(0);
  });

  it('records local-bad when a file is missing, and refuses without marking when only the hash run failed (Revision 5 §5.3)', async () => {
    const missing = setup();
    missing.world.folderDigests.delete(missing.deps.instance.versionFolder(missing.ref, KEY));
    expect(await qualifyVersion(missing.deps, missing.ref, KEY, 'qualification')).toMatchObject({ outcome: 'refused', reason: 'closure-changed' });
    expect(missing.world.controlRecord().disabled.map((entry) => entry.reason)).toEqual(['local-bad']);

    const timeout = setup();
    const deps = { ...timeout.deps, checkClosure: async () => ({ ok: false as const, reason: 'hash-timeout' as const, message: 'took longer than 60 s' }) };
    expect(await qualifyVersion(deps, timeout.ref, KEY, 'qualification')).toMatchObject({ outcome: 'refused', reason: 'closure-unchecked' });
    expect(timeout.world.controlRecord().disabled).toEqual([]);
    expect(timeout.probe.calls).toHaveLength(0);
  });

  it('refuses a version the policy now marks bad even with the user\'s click, and a click for other files', async () => {
    const bad = setup();
    const badPolicy = testPolicy([codexEntry({ version: '0.164.0', status: 'revoked', statusReason: 'withdrawn by the vendor' })]);
    expect(await admitManagedStart({ ...bad.deps, policy: badPolicy }, bad.ref, KEY, D, 'qualification')).toMatchObject({ admitted: false, reason: 'policy' });

    const other = setup({ consent: 'e'.repeat(64) });
    expect(await admitManagedStart(other.deps, other.ref, KEY, D, 'qualification')).toMatchObject({ admitted: false, reason: 'no-consent' });
    expect(await admitManagedStart(other.deps, other.ref, KEY, 'e'.repeat(64), 'qualification')).toMatchObject({ admitted: false, reason: 'policy' });
  });

  it('refuses when another instance is enrolled, or control is not ok', async () => {
    const { world, ref, deps } = setup();
    const other = world.addInstance();
    world.writeControl('reduction', (content) => ({ ...content, enrolledStoreId: other.storeId, active: null, lastKnownGood: null }));
    expect(await admitManagedStart(deps, ref, KEY, D, 'qualification')).toMatchObject({ admitted: false, reason: 'not-enrolled' });

    const behind = setup();
    behind.world.writeControl('reduction', (content) => ({ ...content }));
    behind.world.loseNewestControlGeneration();
    expect(await admitManagedStart(behind.deps, behind.ref, KEY, D, 'qualification')).toMatchObject({ admitted: false, reason: 'control' });

    const unusable = setup();
    unusable.world.controlUnusable = { reason: 'floor-unavailable', detail: 'missing' };
    expect(await admitManagedStart(unusable.deps, unusable.ref, KEY, D, 'qualification')).toMatchObject({ admitted: false, reason: 'control' });
  });
});

describe('admitManagedStart: the bypasses (Codex Q2, Q3)', () => {
  const reasons: DisabledReason[] = ['local-bad', 'probe-failed', 'probe-stop-unconfirmed', 'policy-bad', 'consent-withdrawn'];
  const admitted = async (disabled: DisabledReason[], purpose: ManagedStartPurpose) => {
    const { ref, deps, world } = setup({ consent: true, disabled: disabled.map((reason) => ({ reason })) });
    const admission = await admitManagedStart(deps, ref, KEY, D, purpose);
    if (admission.admitted) admission.start.abandon();
    expect(world.instanceState(ref).held).toBe(0);
    return admission;
  };

  it('admits no automatic check of a version with any disabled entry', async () => {
    for (const reason of reasons) {
      expect(await admitted([reason], 'qualification'), reason).toMatchObject({ admitted: false, reason: 'disabled' });
    }
  });

  it('lets Check again pass exactly one entry for an unconfirmed stop, and nothing else', async () => {
    const pass = await admitted(['probe-stop-unconfirmed'], { checkAgain: true });
    expect(pass.admitted).toBe(true);
    if (pass.admitted) expect(pass.start.bypassed).toMatchObject({ reason: 'probe-stop-unconfirmed', key: KEY });
    for (const reason of reasons.filter((candidate) => candidate !== 'probe-stop-unconfirmed')) {
      expect(await admitted([reason], { checkAgain: true }), reason).toMatchObject({ admitted: false, reason: 'disabled' });
    }
    expect(await admitted(['probe-stop-unconfirmed', 'policy-bad'], { checkAgain: true })).toMatchObject({ admitted: false });
    expect(await admitted(['probe-stop-unconfirmed', 'probe-stop-unconfirmed'], { checkAgain: true })).toMatchObject({ admitted: false });
    expect(await admitted([], { checkAgain: true })).toMatchObject({ admitted: false, reason: 'disabled' });
  });

  it('lets Try again pass exactly one local-bad or probe-failed entry when it is the only one, never policy-bad', async () => {
    for (const reason of ['local-bad', 'probe-failed'] as const) {
      const pass = await admitted([reason], { tryAgain: true });
      expect(pass.admitted, reason).toBe(true);
    }
    for (const reason of ['probe-stop-unconfirmed', 'policy-bad', 'consent-withdrawn'] as const) {
      expect(await admitted([reason], { tryAgain: true }), reason).toMatchObject({ admitted: false, reason: 'disabled' });
    }
    expect(await admitted(['local-bad', 'policy-bad'], { tryAgain: true })).toMatchObject({ admitted: false });
    expect(await admitted(['local-bad', 'local-bad'], { tryAgain: true })).toMatchObject({ admitted: false });
    expect(await admitted([], { tryAgain: true })).toMatchObject({ admitted: false, reason: 'disabled' });
  });

  it('refuses a purpose that names no single action', async () => {
    const both = { checkAgain: true, tryAgain: true } as unknown as ManagedStartPurpose;
    expect(await admitted(['probe-stop-unconfirmed'], both)).toMatchObject({ admitted: false, reason: 'purpose' });
    expect(await admitted([], 'qualify' as unknown as ManagedStartPurpose)).toMatchObject({ admitted: false, reason: 'purpose' });
  });
});

describe('Codex Q1: no managed check starts while External is selected', () => {
  it('refuses every purpose under (A, external) with zero probe runs, and admits again after Use managed Codex with no download and no new click', async () => {
    const enrolled = enrolledWorld();
    const { world, ref } = enrolled;
    const V2 = codexEntry({ version: '0.165.0' });
    const V3 = codexEntry({ version: '0.166.0' });
    const both = testPolicy([V1, V2, V3]);
    seedVersion(enrolled, V1, { consent: true, active: true });
    seedVersion(enrolled, V2, { consent: true, disabled: [{ reason: 'probe-stop-unconfirmed' }] });
    seedVersion(enrolled, V3, { consent: true, probe: true, disabled: [{ reason: 'local-bad' }] });
    const { deps, probe, download } = harness(world, both);
    expect((await deps.control.publish(useExternal)).outcome).toBe('published');

    expect(await qualifyVersion(deps, ref, KEY, 'qualification')).toMatchObject({ outcome: 'refused', reason: 'external' });
    expect(await checkAfterAgentStartFailure(deps, ref, KEY, { kind: 'exit-before-ready', detail: 'exited with 1' })).toMatchObject({ outcome: 'not-checked' });
    expect(await checkAgain(deps, { ref, key: keyOf(V2), warningShown: true })).toMatchObject({ outcome: 'refused', reason: 'external' });
    const repaired = await tryAgain(deps, { ref, key: keyOf(V3), userChoice: 'try-again', askForNewClick: async () => true, signal: new AbortController().signal });
    expect(repaired).toMatchObject({ outcome: 'refused', reason: 'external' });
    expect(probe.calls).toHaveLength(0);
    expect(download.calls).toHaveLength(0);
    expect(world.events.filter((event) => event.endsWith(':retire'))).toEqual([]);
    expect(world.controlRecord().selection).toBe('external');
    // External is not Reset: the instance, its versions and its OKs are all still there.
    expect(world.controlRecord().enrolledStoreId).toBe(ref.storeId);
    expect(world.controlRecord().activationConsents).toHaveLength(3);

    const before = world.controlPublications.length;
    expect((await deps.control.publish(useManaged)).outcome).toBe('published');
    const outcome = await qualifyVersion(deps, ref, KEY, 'qualification');
    expect(outcome).toMatchObject({ outcome: 'ready', key: KEY });
    expect(probe.calls).toHaveLength(1);
    expect(download.calls).toHaveLength(0);
    expect(world.controlPublications.slice(before).filter((publication) => publication.label === 'activation-consent')).toEqual([]);
  });

  it('lets a check that was admitted before External was chosen finish, and refuses the next one', async () => {
    const { world, ref, deps, probe } = setup({ consent: true });
    const runs = harness(world, policy, {
      probeSteps: [{ during: async () => { expect((await world.control('w2').publish(useExternal)).outcome).toBe('published'); } }],
    });
    const outcome = await qualifyVersion({ ...deps, runManagedProbe: runs.probe.run }, ref, KEY, 'qualification');
    expect(outcome).toMatchObject({ outcome: 'ready' });
    expect(runs.probe.calls).toHaveLength(1);
    expect(world.instanceRecord(ref).probes[KEY]).toMatchObject({ closureDigest: D });
    expect(await qualifyVersion(deps, ref, KEY, 'qualification')).toMatchObject({ outcome: 'refused', reason: 'external' });
    expect(probe.calls).toHaveLength(0);
  });
});

describe('Codex Q4: a present suspension refuses every admission', () => {
  for (const suspension of [
    { kind: 'readable' as const, reason: 'control unreadable', decidedAt: '2026-10-21T00:00:00Z' },
    { kind: 'unreadable' as const },
  ]) {
    it(`refuses every purpose while the suspension file is present (${suspension.kind}), with zero probe runs`, async () => {
      for (const [seed, purpose] of [
        [{ consent: true }, 'qualification'],
        [{ consent: true, disabled: [{ reason: 'probe-stop-unconfirmed' as const }] }, { checkAgain: true }],
        [{ consent: true, disabled: [{ reason: 'local-bad' as const }] }, { tryAgain: true }],
      ] as Array<[SeedOptions, ManagedStartPurpose]>) {
        const { world, ref, deps, probe } = setup(seed);
        world.suspension = suspension;
        expect(await admitManagedStart(deps, ref, KEY, D, purpose)).toMatchObject({ admitted: false, reason: 'suspended' });
        expect(await qualifyVersion(deps, ref, KEY, purpose)).toMatchObject({ outcome: 'refused', reason: 'suspended' });
        expect(probe.calls).toHaveLength(0);
        expect(world.leasesOn(ref, KEY)).toEqual([]);
        expect(world.instanceState(ref).held).toBe(0);
      }
    });
  }

  it('refuses an admission whose final check reads a suspension published after the gate was taken', async () => {
    const { world, ref, deps, probe } = setup();
    world.hooks.onSuspensionRead = () => {
      world.suspension = { kind: 'unreadable' };
    };
    expect(await qualifyVersion(deps, ref, KEY, 'qualification')).toMatchObject({ outcome: 'refused', reason: 'suspended' });
    expect(probe.calls).toHaveLength(0);
  });

  it('lets an admission that passed its final check before the suspension was published finish', async () => {
    const { world, ref, deps, probe } = setup();
    world.hooks.afterLeaseCreated = () => {
      world.suspension = { kind: 'readable', reason: 'another window', decidedAt: '2026-10-21T00:00:00Z' };
    };
    const outcome = await qualifyVersion(deps, ref, KEY, 'qualification');
    expect(probe.calls).toHaveLength(1);
    // The check's positive fact is recorded; the activation, an increase, is refused while suspended.
    expect(outcome).toMatchObject({ outcome: 'ready', activation: { activated: false } });
    expect(world.instanceRecord(ref).probes[KEY]).toBeDefined();
    expect(world.controlRecord().active).toBeNull();
    world.hooks = {};
    expect(await qualifyVersion(deps, ref, KEY, 'qualification')).toMatchObject({ outcome: 'refused', reason: 'suspended' });
    expect(probe.calls).toHaveLength(1);
  });
});
