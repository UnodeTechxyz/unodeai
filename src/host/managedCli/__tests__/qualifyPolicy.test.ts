import { describe, expect, it } from 'vitest';
import type { PolicyEntry } from '../../../backend/cliCompatibilityPolicy';
import { checkAfterAgentStartFailure, classifyAgentStartFailure, type AgentStartFailureKind } from '../qualify/agentStartFailure';
import { admitManagedStart } from '../qualify/admission';
import { launchableKey, reconcilePolicy, type LaunchableKey } from '../qualify/policyReconcile';
import { codexEntry, CONSENTED_HOSTS, digestOf, enrolledWorld, harness, HOST, keyOf, seedVersion, testPolicy, type Enrolled, type ProbeScriptStep, type SeedOptions } from './qualifyFixtures';

// The design these tests realise: merged store design §3.4 ("A key K of instance A is launchable for a new session
// only when ... K is active, or LKG under Revision 5 §9.1's rule; the instance holds a probe pass fact for (K, D)
// ..."; "Facts in the instance can only permit a launch"), Revision 5 §9.1 ("A bad/revoked entry for the active key
// moves future launches to LKG when LKG is installable and passes §5.2; otherwise launches are blocked with repair"),
// ADAPTER §5.11 as amended (automatic bad by policy; a program-level agent start failure is bad only if an immediate
// re-probe of that key also fails; a passing re-probe is environmental and marks nothing), and Codex's Q1 (the
// re-probe obeys every admission rule).

const OLD = codexEntry({ version: '0.163.0' });
const NEW = codexEntry({ version: '0.164.0' });
const policy = testPolicy([OLD, NEW]);

describe('reconcilePolicy (ADAPTER §5.11.1(b))', () => {
  it('records policy-bad in one reduction for every version of the enrolled instance whose entry is now bad or revoked, once', async () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, OLD, { consent: true, probe: true, lastKnownGood: true });
    seedVersion(enrolled, NEW, { consent: true, probe: true, active: true });
    const { world, ref } = enrolled;
    const revoked = testPolicy([codexEntry({ version: '0.163.0', status: 'bad', statusReason: 'breaks approvals' }), codexEntry({ version: '0.164.0', status: 'revoked', statusReason: 'signature revoked' })]);
    const { deps } = harness(world, revoked);
    const floor = world.floor;
    const first = await reconcilePolicy(deps, revoked, deps.now);
    expect(first).toEqual({ outcome: 'published', added: [keyOf(OLD), keyOf(NEW)].sort() });
    expect(world.controlPublications.at(-1)).toMatchObject({ label: 'disable-policy-bad', kind: 'reduction', epoch: floor + 1 });
    expect(world.controlRecord().disabled).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: keyOf(OLD), reason: 'policy-bad', detail: 'breaks approvals' }),
      expect.objectContaining({ key: keyOf(NEW), reason: 'policy-bad', detail: 'signature revoked' }),
    ]));
    expect(await reconcilePolicy(deps, revoked, deps.now)).toEqual({ outcome: 'moot', added: [] });
    expect(launchableKey({ suspension: world.suspensionView(), control: world.controlView(), instance: deps.instance.read(ref), policy: revoked, host: HOST }).launchable).toBe(false);
  });

  it('includes versions only control names, and writes nothing when no version is bad', async () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, NEW, { consent: true, noFacts: true });
    const revoked = testPolicy([OLD, codexEntry({ version: '0.164.0', status: 'revoked', statusReason: 'withdrawn' })]);
    const { deps } = harness(enrolled.world, revoked);
    expect(await reconcilePolicy(deps, revoked, deps.now)).toEqual({ outcome: 'published', added: [keyOf(NEW)] });
    const generations = enrolled.world.controlGenerations.length;
    expect(await reconcilePolicy(deps, policy, deps.now)).toEqual({ outcome: 'nothing-bad', added: [] });
    expect(enrolled.world.controlGenerations.length).toBe(generations);
  });

  it('policy-bad is never passed: not by Check again, not by Try again', async () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, NEW, { consent: true, disabled: [{ reason: 'policy-bad' }] });
    const { deps, probe } = harness(enrolled.world, policy);
    for (const purpose of ['qualification', { checkAgain: true }, { tryAgain: true }] as const) {
      expect(await admitManagedStart(deps, enrolled.ref, keyOf(NEW), digestOf(NEW), purpose)).toMatchObject({ admitted: false, reason: 'disabled' });
    }
    expect(probe.calls).toHaveLength(0);
  });
});

describe('launchableKey (merged §3.4, Revision 5 §9.1)', () => {
  type Condition = 'ok' | 'no-consent' | 'no-probe' | 'local-bad' | 'probe-failed' | 'stop-unconfirmed' | 'policy-bad-entry' | 'consent-withdrawn' | 'no-facts' | 'policy-missing' | 'not-installable' | 'absent';
  const CONDITIONS: Condition[] = ['ok', 'no-consent', 'no-probe', 'local-bad', 'probe-failed', 'stop-unconfirmed', 'policy-bad-entry', 'consent-withdrawn', 'no-facts', 'policy-missing', 'not-installable', 'absent'];

  function seedFor(condition: Condition, role: 'active' | 'lkg'): SeedOptions | undefined {
    if (condition === 'absent') return undefined;
    const base: SeedOptions = { consent: true, probe: true, [role === 'active' ? 'active' : 'lastKnownGood']: true };
    switch (condition) {
      case 'no-consent': return { ...base, consent: false };
      case 'no-probe': return { ...base, probe: false };
      case 'local-bad': case 'probe-failed': case 'consent-withdrawn': return { ...base, disabled: [{ reason: condition }] };
      case 'stop-unconfirmed': return { ...base, disabled: [{ reason: 'probe-stop-unconfirmed' }] };
      case 'no-facts': return { ...base, probe: false, noFacts: true };
      default: return base;
    }
  }

  /** A world with the active version NEW and the last-known-good OLD in the given conditions. */
  function decide(active: Condition, lkg: Condition): LaunchableKey {
    const enrolled: Enrolled = enrolledWorld();
    const activeSeed = seedFor(active, 'active');
    const lkgSeed = seedFor(lkg, 'lkg');
    if (lkgSeed) seedVersion(enrolled, OLD, lkgSeed);
    if (activeSeed) seedVersion(enrolled, NEW, activeSeed);
    const entries: PolicyEntry[] = [];
    const entryFor = (entry: PolicyEntry, condition: Condition) => {
      if (condition === 'policy-missing') return;
      if (condition === 'policy-bad-entry') entries.push(codexEntry({ version: entry.version, status: 'revoked', statusReason: 'withdrawn' }));
      else if (condition === 'not-installable') entries.push(codexEntry({ version: entry.version, urls: [`https://github.com/openai/codex/releases/download/rust-v${entry.version}/codex.tar.gz`] }));
      else entries.push(entry);
    };
    entryFor(NEW, active);
    entryFor(OLD, lkg);
    if (active === 'not-installable' || lkg === 'not-installable') {
      enrolled.world.writeControl('reduction', (content) => ({ ...content, enrollment: { epoch: 1, consentedHosts: CONSENTED_HOSTS.filter((host) => host !== 'github.com'), decidedAt: content.decidedAt } }));
    }
    const { world, ref } = enrolled;
    return launchableKey({ suspension: world.suspensionView(), control: world.controlView(), instance: world.instance().read(ref), policy: testPolicy(entries), host: HOST });
  }

  // The active version needs no host check (it is already downloaded); the last-known-good must still be installable.
  const activeOk = (condition: Condition) => condition === 'ok' || condition === 'not-installable';
  const lkgOk = (condition: Condition) => condition === 'ok';

  for (const active of CONDITIONS) {
    it(`active ${active}: every last-known-good condition`, () => {
      for (const lkg of CONDITIONS) {
        const decision = decide(active, lkg);
        const expected = activeOk(active) ? { launchable: true, role: 'active', versionName: '0.164.0' }
          : lkgOk(lkg) ? { launchable: true, role: 'last-known-good', versionName: '0.163.0' }
            : { launchable: false };
        expect(decision, `active ${active}, last-known-good ${lkg}`).toMatchObject(expected);
        if (decision.launchable) expect(decision.closureDigest).toBe(digestOf(decision.role === 'active' ? NEW : OLD));
      }
    });
  }

  it('nothing is launchable while suspended, under External, in a blocked control state, or for another instance', () => {
    const states: Array<[string, (enrolled: Enrolled) => void]> = [
      ['suspended', (enrolled) => { enrolled.world.suspension = { kind: 'readable', reason: 'x', decidedAt: 'y' }; }],
      ['unreadable suspension', (enrolled) => { enrolled.world.suspension = { kind: 'unreadable' }; }],
      ['external', (enrolled) => enrolled.world.writeControl('reduction', (content) => ({ ...content, selection: 'external' }))],
      ['behind-floor', (enrolled) => { enrolled.world.writeControl('reduction', (content) => content); enrolled.world.loseNewestControlGeneration(); }],
      ['sealed', (enrolled) => { enrolled.world.floor = 4095; }],
      ['unusable', (enrolled) => { enrolled.world.controlUnusable = { reason: 'control-unreadable', detail: 'x' }; }],
    ];
    for (const [name, prepare] of states) {
      const enrolled = enrolledWorld();
      seedVersion(enrolled, NEW, { consent: true, probe: true, active: true });
      prepare(enrolled);
      const { world, ref } = enrolled;
      expect(launchableKey({ suspension: world.suspensionView(), control: world.controlView(), instance: world.instance().read(ref), policy, host: HOST }).launchable, name).toBe(false);
    }
    const enrolled = enrolledWorld();
    seedVersion(enrolled, NEW, { consent: true, probe: true, active: true });
    const other = enrolled.world.addInstance();
    expect(launchableKey({ suspension: enrolled.world.suspensionView(), control: enrolled.world.controlView(), instance: enrolled.world.instance().read(other), policy, host: HOST }).launchable).toBe(false);
  });

  it('losing the newest instance generation never revives a disabled version (merged §5, G2)', () => {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, NEW, { consent: true, probe: true, active: true });
    const { world, ref } = enrolled;
    world.writeControl('reduction', (content) => ({ ...content, disabled: [{ storeId: ref.storeId, key: keyOf(NEW), reason: 'local-bad', at: 'now' }] }));
    world.writeInstance(ref, (content) => ({ ...content, probes: {} }));
    world.loseNewestInstanceGeneration(ref);
    expect(world.instanceRecord(ref).probes[keyOf(NEW)]).toBeDefined();
    expect(launchableKey({ suspension: world.suspensionView(), control: world.controlView(), instance: world.instance().read(ref), policy, host: HOST }).launchable).toBe(false);
  });
});

describe('a failed agent start (ADAPTER §5.11.1(c) as amended)', () => {
  const PROGRAM: AgentStartFailureKind[] = ['spawn-error', 'no-initialize-response', 'malformed-json-rpc', 'version-mismatch', 'exit-before-ready'];
  const ENVIRONMENT: AgentStartFailureKind[] = ['login', 'configuration', 'workspace', 'other'];

  it('classifies the program\'s own failures apart from the environment\'s', () => {
    for (const kind of PROGRAM) expect(classifyAgentStartFailure({ kind, detail: '' }), kind).toBe('program');
    for (const kind of ENVIRONMENT) expect(classifyAgentStartFailure({ kind, detail: '' }), kind).toBe('environment');
  });

  function setup(probeSteps: ProbeScriptStep[] = []) {
    const enrolled = enrolledWorld();
    seedVersion(enrolled, NEW, { consent: true, probe: true, active: true });
    return { ...enrolled, ...harness(enrolled.world, policy, { probeSteps }) };
  }

  it('a program-level failure runs one immediate check; if it fails too, the version is local-bad (mutant L4)', async () => {
    const { world, ref, deps, probe } = setup([{ result: 'fail', detail: 'initialize never answered' }]);
    const outcome = await checkAfterAgentStartFailure(deps, ref, keyOf(NEW), { kind: 'no-initialize-response', detail: 'no answer in 20 s' });
    expect(outcome).toMatchObject({ outcome: 'local-bad', recorded: true });
    expect(probe.calls).toHaveLength(1);
    expect(world.controlRecord().disabled).toEqual([expect.objectContaining({ key: keyOf(NEW), reason: 'local-bad' })]);
    expect(world.leasesOn(ref, keyOf(NEW))).toEqual([]);
  });

  it('a passing check means the environment failed: shown, nothing marked, nothing published', async () => {
    const { world, ref, deps, probe } = setup();
    const generations = { control: world.controlGenerations.length, instance: world.instanceState(ref).generations.length };
    expect(await checkAfterAgentStartFailure(deps, ref, keyOf(NEW), { kind: 'exit-before-ready', detail: 'exited with 1' })).toEqual({ outcome: 'environmental', checked: true, detail: 'exited with 1' });
    expect(probe.calls).toHaveLength(1);
    expect(world.controlGenerations.length).toBe(generations.control);
    expect(world.instanceState(ref).generations.length).toBe(generations.instance);
    expect(world.leasesOn(ref, keyOf(NEW))).toEqual([]);
    expect(world.instanceState(ref).work.size).toBe(0);
  });

  it('an environment failure runs no check; a check that cannot be admitted marks nothing', async () => {
    const environment = setup();
    expect(await checkAfterAgentStartFailure(environment.deps, environment.ref, keyOf(NEW), { kind: 'login', detail: 'not logged in' })).toMatchObject({ outcome: 'environmental', checked: false });
    expect(environment.probe.calls).toHaveLength(0);

    const external = setup();
    external.world.writeControl('reduction', (content) => ({ ...content, selection: 'external' }));
    expect(await checkAfterAgentStartFailure(external.deps, external.ref, keyOf(NEW), { kind: 'spawn-error', detail: 'ENOENT' })).toMatchObject({ outcome: 'not-checked' });
    expect(external.probe.calls).toHaveLength(0);
    expect(external.world.controlRecord().disabled).toEqual([]);
  });

  it('an unconfirmed stop of that check is recorded as one, with its lease kept', async () => {
    const { world, ref, deps } = setup([{ result: 'stop-unconfirmed', detail: 'taskkill exited 128' }]);
    expect(await checkAfterAgentStartFailure(deps, ref, keyOf(NEW), { kind: 'malformed-json-rpc', detail: 'bad line' })).toMatchObject({ outcome: 'stop-unconfirmed', recorded: true });
    expect(world.controlRecord().disabled).toEqual([expect.objectContaining({ reason: 'probe-stop-unconfirmed' })]);
    expect(world.leasesOn(ref, keyOf(NEW))).toHaveLength(1);
  });
});
