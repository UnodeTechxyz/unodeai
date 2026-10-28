import { describe, expect, it } from 'vitest';
import type { ControlChange, InstanceRef } from '../contracts';
import {
  ACTIVATION_ALLOW,
  ACTIVATION_NOT_NOW,
  activationDialog,
  clickOffer,
  decideActivation,
  recordActivationConsent,
  VerifiedKeyNotices,
  type ClickOffer,
} from '../qualify/activation';
import { launchableKey } from '../qualify/policyReconcile';
import { qualifyVersion } from '../qualify/qualification';
import type { FakeWorld } from './fakeStoresQualify';
import { codexEntry, digestOf, enrolledWorld, harness, HOST, keyOf, promotedFacts, seedVersion, testPolicy } from './qualifyFixtures';

// The design these tests realise: Revision 5 §9.2 (the click: "Every new managed Codex version needs this click,
// whether or not every file is signed"; "Every line comes from that key's V1–V4 results and its policy entry. A
// package with no unsigned file omits the 'Not verified' line, and the click is still required"; "With auto mode
// on, the background task stops at verified and notifies once per version per window session ... Not now leaves the
// key verified"), §9.1 ("verified is not launchable"), §11.16 (rule A tests), and Codex's ruling Q1 (nothing managed
// runs while External is selected; our reading: the click is offered only while managed Codex is selected, and the
// card says the version is ready to review once it is selected again).

const V1 = codexEntry({ version: '0.164.0' });
const SIGNED = codexEntry({ version: '0.165.0', fullySigned: true });
const policy = testPolicy([V1, SIGNED]);
const KEY = keyOf(V1);

function offerFor(world: FakeWorld, ref: InstanceRef, key: string, window = 'w1'): ClickOffer {
  return clickOffer({
    suspension: world.control(window).readSuspension(),
    control: world.control(window).read(),
    instance: world.instance(window).read(ref),
    policy,
    host: HOST,
    key,
  });
}

describe('the activation dialog (Revision 5 §9.2)', () => {
  it('says what was checked, from the version\'s own record and policy entry', () => {
    const result = activationDialog(V1, promotedFacts(V1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dialog).toEqual({
      title: 'Allow Codex CLI 0.164.0 to run?',
      intro: 'UnodeAi downloaded it from releases.openai.com or github.com and checked it on this computer:',
      facts: [
        'All 5 files match, byte for byte, the files UnodeAi recorded when it tested this version before release.',
        '2 files carry a valid OpenAI OpCo, LLC signature, and 1 a valid Microsoft signature, checked now.',
        'Not verified: codex-path/rg.exe has no publisher signature. Its bytes match UnodeAi\'s record, but nothing proves that OpenAI published it. Codex runs it when an agent searches files.',
        'Revocation: confirmed online.',
      ],
      closing: 'If you allow it, UnodeAi starts it once in its own folder to check it, with no model request. If that passes, new agent sessions use it. Agents already running keep their version.',
      buttons: [ACTIVATION_ALLOW, ACTIVATION_NOT_NOW],
    });
  });

  it('takes every count, host and the revocation state from its inputs', () => {
    const offline = activationDialog(V1, promotedFacts(V1, { revocation: 'not-confirmed-offline' }));
    expect(offline.ok && offline.dialog.facts).toContain('Revocation: not confirmed (offline).');
    const oneHost = codexEntry({ version: '0.164.0', urls: ['https://releases.openai.com/codex/0.164.0/codex.tar.gz'] });
    const single = activationDialog(oneHost, promotedFacts(oneHost));
    expect(single.ok && single.dialog.intro).toBe('UnodeAi downloaded it from releases.openai.com and checked it on this computer:');
    const signed = activationDialog(SIGNED, promotedFacts(SIGNED));
    expect(signed.ok && signed.dialog.facts[0]).toBe('All 4 files match, byte for byte, the files UnodeAi recorded when it tested this version before release.');
  });

  it('omits the "Not verified" line for a package with no unsigned file, and still asks for the click', () => {
    const result = activationDialog(SIGNED, promotedFacts(SIGNED));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dialog.facts.some((line) => line.startsWith('Not verified'))).toBe(false);
    expect(result.dialog.buttons).toEqual([ACTIVATION_ALLOW, ACTIVATION_NOT_NOW]);
  });

  it('offers no dialog when the download record does not describe the entry\'s files', () => {
    expect(activationDialog(V1, promotedFacts(V1, { files: 4 })).ok).toBe(false);
    expect(activationDialog(V1, promotedFacts(V1, { unsigned: [] })).ok).toBe(false);
    expect(activationDialog(V1, promotedFacts(V1, { signed: { openai: 3, microsoftCrt: 1 } })).ok).toBe(false);
    expect(activationDialog(V1, { ...promotedFacts(V1), artifactSha256: 'a'.repeat(64) }).ok).toBe(false);
    expect(activationDialog(V1, promotedFacts(SIGNED)).ok).toBe(false);
  });
});

describe('the click (rule A, Revision 5 §11.16)', () => {
  it('a verified version is not launchable, and the click is offered for it', () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, V1, { active: true });
    const { world, ref } = enrolled;
    const offer = offerFor(world, ref, KEY);
    expect(offer).toMatchObject({ offered: true, key: KEY, version: '0.164.0', closureDigest: digestOf(V1) });
    expect(launchableKey({ suspension: world.suspensionView(), control: world.controlView(), instance: world.instance().read(ref), policy, host: HOST }).launchable).toBe(false);
  });

  it('runs nothing before the click, and the click is recorded before the check starts (mutant K3)', async () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, V1);
    const { world, ref } = enrolled;
    const { deps, probe } = harness(world, policy);
    expect(await qualifyVersion(deps, ref, KEY, 'qualification')).toMatchObject({ outcome: 'refused', reason: 'no-consent' });
    expect(probe.calls).toHaveLength(0);

    const outcome = await decideActivation(deps, ref, KEY, ACTIVATION_ALLOW);
    expect(outcome).toMatchObject({ outcome: 'ready', activation: { activated: true } });
    const consent = world.events.indexOf('w1:control.publish:activation-consent:increase:published');
    expect(consent).toBeGreaterThan(-1);
    expect(world.events.indexOf('probe.spawn')).toBeGreaterThan(consent);
    expect(world.controlRecord().activationConsents).toEqual([{ storeId: ref.storeId, key: KEY, closureDigest: digestOf(V1), decidedAt: expect.any(String) }]);
    expect(world.controlRecord().active).toEqual({ storeId: ref.storeId, key: KEY });
  });

  it('"Not now" writes nothing, starts nothing, and leaves the version verified with Review offered (mutant K5)', async () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, V1);
    const { world, ref } = enrolled;
    const { deps, probe } = harness(world, policy);
    const generations = world.controlGenerations.length;
    expect(await decideActivation(deps, ref, KEY, ACTIVATION_NOT_NOW)).toEqual({ outcome: 'not-now' });
    expect(world.controlGenerations.length).toBe(generations);
    expect(world.controlPublications).toEqual([]);
    expect(probe.calls).toHaveLength(0);
    expect(offerFor(world, ref, KEY).offered).toBe(true);
  });

  it('a fully signed package still needs the click: without it nothing starts (mutant K6)', async () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, SIGNED);
    const { world, ref } = enrolled;
    const { deps, probe } = harness(world, policy);
    expect(offerFor(world, ref, keyOf(SIGNED)).offered).toBe(true);
    expect(await qualifyVersion(deps, ref, keyOf(SIGNED), 'qualification')).toMatchObject({ outcome: 'refused', reason: 'no-consent' });
    expect(probe.calls).toHaveLength(0);
    expect(world.controlRecord().active).toBeNull();
  });

  it('the click is visible across windows: the other window offers it no more and runs the check without a new click', async () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, V1);
    const { world, ref } = enrolled;
    const first = harness(world, policy, { window: 'w1' });
    const second = harness(world, policy, { window: 'w2' });
    expect(offerFor(world, ref, KEY, 'w2').offered).toBe(true);
    expect((await recordActivationConsent(first.deps, ref, KEY, digestOf(V1))).outcome).toBe('published');
    expect(offerFor(world, ref, KEY, 'w2')).toMatchObject({ offered: false, reason: 'not-verified' });
    expect(await qualifyVersion(second.deps, ref, KEY, 'qualification')).toMatchObject({ outcome: 'ready' });
    expect(second.probe.calls).toHaveLength(1);
    expect(world.controlPublications.filter((publication) => publication.label === 'activation-consent')).toHaveLength(1);
  });

  it('records the click only for exactly that closure, and not twice', async () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, V1);
    const { world, ref } = enrolled;
    const { deps, probe } = harness(world, policy);
    expect((await recordActivationConsent(deps, ref, KEY, 'd'.repeat(64))).outcome).toBe('published');
    expect(await qualifyVersion(deps, ref, KEY, 'qualification')).toMatchObject({ outcome: 'refused', reason: 'no-consent' });
    expect(probe.calls).toHaveLength(0);
    expect((await recordActivationConsent(deps, ref, KEY, digestOf(V1))).outcome).toBe('published');
    expect((await recordActivationConsent(deps, ref, KEY, digestOf(V1))).outcome).toBe('moot');
  });

  it('does not record the click for a disabled version, another setup, or while suspended', async () => {
    const disabled = enrolledWorld();
    seedVersion(disabled, V1, { disabled: [{ reason: 'local-bad' }] });
    expect(await recordActivationConsent(harness(disabled.world, policy).deps, disabled.ref, KEY, digestOf(V1))).toMatchObject({ outcome: 'refused' });
    expect(offerFor(disabled.world, disabled.ref, KEY)).toMatchObject({ offered: false, reason: 'not-verified' });

    const other = enrolledWorld();
    const stranger = other.world.addInstance();
    expect(await recordActivationConsent(harness(other.world, policy).deps, stranger, KEY, digestOf(V1))).toMatchObject({ outcome: 'refused' });

    const suspended = enrolledWorld();
    seedVersion(suspended, V1);
    suspended.world.suspension = { kind: 'unreadable' };
    expect(await recordActivationConsent(harness(suspended.world, policy).deps, suspended.ref, KEY, digestOf(V1))).toMatchObject({ outcome: 'refused' });
    expect(offerFor(suspended.world, suspended.ref, KEY)).toMatchObject({ offered: false, reason: 'unavailable' });
  });

  it('under (A, external) the click is not offered: the version is ready to review once managed Codex is selected again', async () => {
    const enrolled = enrolledWorld({ selection: 'external' });
    seedVersion(enrolled, V1);
    const { world, ref } = enrolled;
    expect(offerFor(world, ref, KEY)).toEqual({ offered: false, reason: 'later', detail: 'Codex 0.164.0 is ready to review once managed Codex is selected again.' });
    expect(await recordActivationConsent(harness(world, policy).deps, ref, KEY, digestOf(V1))).toMatchObject({ outcome: 'refused' });
    const useManaged: ControlChange = { label: 'use-managed', kind: 'increase', apply: (current) => ({ ...current, selection: 'managed' }) };
    expect((await world.control().publish(useManaged)).outcome).toBe('published');
    expect(offerFor(world, ref, KEY).offered).toBe(true);
  });

  it('asks for no click for a version older than the one new sessions use: that OK could not make it used', () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, SIGNED, { consent: true, probe: true, active: true });
    seedVersion(enrolled, V1);
    const { world, ref } = enrolled;
    expect(offerFor(world, ref, KEY)).toEqual({ offered: false, reason: 'not-verified', detail: 'Codex 0.164.0 is older than the version new sessions use.' });
  });
});

describe('automatic mode and the notification (Revision 5 §9.2, ADAPTER §5.10 as amended)', () => {
  it('automatic mode never activates without a click: a verified version only gets one notification', async () => {
    const enrolled = enrolledWorld({ autoMode: true });
    seedVersion(enrolled, V1);
    seedVersion(enrolled, SIGNED);
    const { world, ref } = enrolled;
    const { probe } = harness(world, policy);
    const notices = new VerifiedKeyNotices();
    expect(notices.next(offerFor(world, ref, KEY), true)).toEqual({ key: KEY, text: 'Codex 0.164.0 is downloaded and checked. It runs only after your OK.', buttons: ['Review', 'Not now'] });
    expect(notices.next(offerFor(world, ref, keyOf(SIGNED)), true)).toMatchObject({ key: keyOf(SIGNED), text: 'Codex 0.165.0 is downloaded and checked. It runs only after your OK.' });
    expect(world.controlPublications).toEqual([]);
    expect(probe.calls).toHaveLength(0);
    expect(world.controlRecord()).toMatchObject({ active: null, activationConsents: [] });
  });

  it('notifies once per version per window session, never again, and not with automatic mode off or under External', () => {
    const enrolled = enrolledWorld({ autoMode: true });
    seedVersion(enrolled, V1);
    const { world, ref } = enrolled;
    const notices = new VerifiedKeyNotices();
    const offer = offerFor(world, ref, KEY);
    expect(notices.next(offer, true)).toBeDefined();
    expect(notices.next(offer, true)).toBeUndefined();
    expect(notices.next(offerFor(world, ref, KEY), true)).toBeUndefined();
    expect(new VerifiedKeyNotices().next(offer, true), 'another window session').toBeDefined();
    expect(new VerifiedKeyNotices().next(offer, false), 'automatic mode off').toBeUndefined();

    const external = enrolledWorld({ autoMode: true, selection: 'external' });
    seedVersion(external, V1);
    expect(new VerifiedKeyNotices().next(offerFor(external.world, external.ref, KEY), true)).toBeUndefined();
  });
});
