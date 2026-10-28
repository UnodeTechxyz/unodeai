import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClosureHasher, computeCliClosure, type CliClosure } from '../../backend/cliClosure';
import { CLI_COMPATIBILITY_POLICY, CLI_REQUIRED_CANARIES, loadCliCompatibilityPolicy, type CliCompatibilityPolicy, type PolicyEntry } from '../../backend/cliCompatibilityPolicy';
import { CliRuntimeResolver, CliStartRefused, managedChoice, type CliRuntimeResolverDeps } from '../cliRuntimeResolver';
import { parseSessionRuntimePin, runtimeIdentityKey, type SessionRuntimePin } from '../cliRuntimePin';
import type { ManagedCodexStatus } from '../managedCli/managedCodexStore';
import type { ControlRecord } from '../managedCli/contracts';

// The design these tests realise: the order at every CLI start (the closure hashed at every start, the policy
// looked up, and an unqualified program asked about before anything of it runs), the session pin (taken by the
// person's own start and saved before the spawn; every other start launches exactly the pinned program or nothing),
// the refusal of an external program inside UnodeAi's own CLI store, and which program a new session uses while
// managed Codex is set up, selected, External, paused or unreadable.

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const temps: string[] = [];
let hasher: ClosureHasher;
beforeAll(() => { hasher = new ClosureHasher(); });
afterEach(() => { for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true }); });
/** The bundled policy: no entries, so every program needs the person's choice. */
function bundledPolicy() {
  const result = loadCliCompatibilityPolicy();
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.policy;
}

function program(contents = 'claude program'): string {
  const folder = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'unode-resolver-')));
  temps.push(folder);
  const exe = path.join(folder, process.platform === 'win32' ? 'claude.exe' : 'claude');
  writeFileSync(exe, contents);
  return exe;
}

function policyQualifyingClaude(digests: string[]) {
  const entry: PolicyEntry = {
    id: 'claude-cli/2.1.304/win32-x64', provider: 'claude-cli', version: '2.1.304', versionOutput: '2.1.304 (Claude Code)',
    os: 'win32', arch: 'x64', status: 'qualified', external: { executableDigests: digests },
    gates: {}, canaries: CLI_REQUIRED_CANARIES['claude-cli'].map((id) => ({ id, result: 'pass' as const, evidenceRef: 'r', ranAt: 't', model: 'm' })),
    selfUpdateReview: { sourceRef: 'tag', finding: 'none' }, qualifiedAt: 'today', qualificationRecord: 'record', leafThumbprints: [],
  };
  const result = loadCliCompatibilityPolicy({ ...structuredClone(CLI_COMPATIBILITY_POLICY) as CliCompatibilityPolicy, entries: [entry] });
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.policy;
}

function policyWithBad(digest: string) {
  const entry: PolicyEntry = {
    id: 'claude-cli/2.1.300/win32-x64', provider: 'claude-cli', version: '2.1.300', versionOutput: '2.1.300 (Claude Code)',
    os: 'win32', arch: 'x64', status: 'bad', statusReason: 'its tool gate does not load', external: { executableDigests: [digest] },
    gates: {}, canaries: [], selfUpdateReview: { sourceRef: 'tag', finding: 'none' }, qualifiedAt: 'today', qualificationRecord: 'record', leafThumbprints: [],
  };
  const result = loadCliCompatibilityPolicy({ ...structuredClone(CLI_COMPATIBILITY_POLICY) as CliCompatibilityPolicy, entries: [entry] });
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.policy;
}

interface Harness {
  resolver: CliRuntimeResolver;
  pins: Map<string, unknown>;
  saves: SessionRuntimePin[];
  spawns: Array<{ executable: string; shell: boolean }>;
  adoptions: Array<{ executable: string; digest: string }>;
  order: string[];
}

function harness(exe: string, overrides: Partial<CliRuntimeResolverDeps> = {}, adopt: 'accept' | 'decline' = 'accept'): Harness {
  const pins = new Map<string, unknown>();
  const saves: SessionRuntimePin[] = [];
  const spawns: Array<{ executable: string; shell: boolean }> = [];
  const adoptions: Array<{ executable: string; digest: string }> = [];
  const adopted = new Set<string>();
  const order: string[] = [];
  const resolver = new CliRuntimeResolver({
    platform: process.platform,
    host: { os: 'win32', arch: 'x64' },
    policy: bundledPolicy(),
    hasher,
    pins: {
      load: (sessionId) => pins.get(sessionId),
      save: async (sessionId, pin) => { order.push('save pin'); saves.push(pin); pins.set(sessionId, pin); },
    },
    externalProgram: () => ({ executable: exe, shell: false }),
    physical: (file) => realpathSync.native(file),
    externalPathInStore: () => false,
    adoption: {
      find: (_provider, executable, closure: CliClosure) => (adopted.has(`${executable}|${closure.digest}`) ? { version: '2.1.305' } : undefined),
      adopt: async (_provider, executable, closure) => {
        order.push('adopt');
        adoptions.push({ executable, digest: closure.digest });
        if (adopt === 'decline') return { ok: false, reason: 'adoption-declined', message: 'Not now.' };
        adopted.add(`${executable}|${closure.digest}`);
        return { ok: true, version: '2.1.305' };
      },
    },
    ...overrides,
  });
  return { resolver, pins, saves, spawns, adoptions, order };
}

const spawnInto = (h: Harness) => (start: { executable: string; shell: boolean }) => {
  h.order.push('spawn');
  h.spawns.push({ executable: start.executable, shell: start.shell });
  return Object.assign(new EventEmitter(), { pid: 77 }) as any;
};

describe('CliRuntimeResolver, external programs', () => {
  it('a qualified program: hashed, its version from the policy, the pin saved before the spawn, one spawn', async () => {
    const exe = program();
    const h = harness(exe, { policy: policyQualifyingClaude([sha('claude program')]) });
    const started = await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, spawnInto(h));
    expect(started).toMatchObject({ mode: 'external', qualification: 'qualified', version: '2.1.304', executable: realpathSync.native(exe) });
    expect(h.order).toEqual(['save pin', 'spawn']);
    expect(h.adoptions).toEqual([]);
    expect(h.saves[0]).toEqual({ pinVersion: 1, mode: 'external', provider: 'claude-cli', executable: realpathSync.native(exe), closureDigest: started.pin.closureDigest, version: '2.1.304' });
  });

  it('an unqualified program: the person is asked first; declining starts nothing and saves no pin', async () => {
    const exe = program();
    const h = harness(exe, {}, 'decline');
    await expect(h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, spawnInto(h))).rejects.toMatchObject({ reason: 'adoption-declined' });
    expect(h.spawns).toEqual([]);
    expect(h.saves).toEqual([]);
  });

  it('an adopted program: asked once, then started; the next start of another session uses the record without asking', async () => {
    const exe = program();
    const h = harness(exe);
    const first = await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, spawnInto(h));
    expect(first).toMatchObject({ qualification: 'adopted-unqualified', version: '2.1.305' });
    expect(h.order).toEqual(['adopt', 'save pin', 'spawn']);
    await h.resolver.start({ provider: 'claude-cli', sessionId: 's2', pin: 'take' }, spawnInto(h));
    expect(h.adoptions).toHaveLength(1);
  });

  it('a file changed during its check: repins current bytes and starts once', async () => {
    const exe = program();
    const h = harness(exe, {
      adoption: {
        find: () => undefined,
        adopt: async () => { writeFileSync(exe, 'replaced while asked'); return { ok: true, version: '2.1.305' }; },
      },
    });
    const started = await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, spawnInto(h));
    const current = await computeCliClosure({ provider: 'claude-cli', executable: exe }, hasher);
    if (!current.ok) throw new Error('closure failed');
    expect(started.pin.closureDigest).toBe(current.closure.digest);
    expect(h.spawns).toHaveLength(1);
  });

  it('a bad version: refused with its reason and the Run anyway steps, and no adoption is offered', async () => {
    const exe = program();
    const h = harness(exe, { policy: policyWithBad(sha('claude program')) });
    await expect(h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, spawnInto(h))).rejects.toMatchObject({
      reason: 'blocked-bad',
      message: expect.stringMatching(/its tool gate does not load.*Providers tab, choose Check \/ choose CLI.*Run anyway/),
    });
    expect(h.adoptions).toEqual([]);
    expect(h.spawns).toEqual([]);
  });

  it('v0.9.99 B17: a bad version the person chose to run anyway starts with a warning; another entry or other files do not', async () => {
    const exe = program();
    const asked: Array<[string, string, string]> = [];
    const policy = policyWithBad(sha('claude program'));
    const allowedPolicyId = `${policy.policyVersion}#claude-cli/2.1.300/win32-x64`;
    const h = harness(exe, { policy, runAnyway: (provider, digest, policyId) => { asked.push([provider, digest, policyId]); return policyId === allowedPolicyId; } });
    const pending: string[] = [];
    const started = await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take', onPending: (message) => pending.push(message) }, spawnInto(h));
    expect(started).toMatchObject({ qualification: 'adopted-unqualified', version: '2.1.300' });
    expect(h.spawns).toHaveLength(1);
    expect(h.adoptions).toEqual([]);
    expect(pending.some((line) => /marked bad \(its tool gate does not load\), because you chose Run anyway/.test(line))).toBe(true);
    // The pinned restart of the same session meets the same choice and warns again.
    const again: string[] = [];
    await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'reuse', onPending: (message) => again.push(message) }, spawnInto(h));
    expect(again.some((line) => line.includes('because you chose Run anyway'))).toBe(true);
    expect(asked.every(([provider]) => provider === 'claude-cli')).toBe(true);

    const other = harness(exe, { policy, runAnyway: () => false });
    await expect(other.resolver.start({ provider: 'claude-cli', sessionId: 's2', pin: 'take' }, spawnInto(other))).rejects.toMatchObject({ reason: 'blocked-bad' });
    expect(other.spawns).toEqual([]);
  });

  it('a program inside the CLI store: refused before its files are read', async () => {
    const exe = program();
    const hashRun = vi.spyOn(hasher, 'run');
    const h = harness(exe, { storeRoot: path.dirname(exe), externalPathInStore: () => true });
    await expect(h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, spawnInto(h))).rejects.toMatchObject({ reason: 'external-path-in-store' });
    expect(hashRun).not.toHaveBeenCalled();
    expect(h.spawns).toEqual([]);
    hashRun.mockRestore();
  });

  it('asks the consent with the checked program after the adoption and before the pin; declining keeps the earlier pin', async () => {
    const exe = program();
    const h = harness(exe);
    const before = async (executable: string) => { h.order.push(`consent ${path.basename(executable)}`); };
    await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take', beforeStart: before }, spawnInto(h));
    expect(h.order).toEqual(['adopt', `consent ${path.basename(exe)}`, 'save pin', 'spawn']);
    const pinBefore = h.pins.get('s1');
    const declined = async () => { throw new Error('declined'); };
    await expect(h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take', beforeStart: declined }, spawnInto(h))).rejects.toThrow('declined');
    await expect(h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'reuse', beforeStart: declined }, spawnInto(h))).rejects.toThrow('declined');
    expect(h.pins.get('s1')).toBe(pinBefore);
    expect(h.spawns).toHaveLength(1);
  });

  it('a start that belongs to no session saves no pin, and still asks before an unqualified program runs', async () => {
    const exe = program();
    const h = harness(exe);
    const started = await h.resolver.startTransient({ provider: 'codex-cli' }, spawnInto(h));
    expect(started.mode).toBe('external');
    expect(h.order).toEqual(['adopt', 'spawn']);
    expect(h.saves).toEqual([]);
  });

  it('a failed pin save starts nothing', async () => {
    const exe = program();
    const h = harness(exe, { policy: policyQualifyingClaude([sha('claude program')]), pins: { load: () => undefined, save: async () => { throw new Error('disk full'); } } });
    await expect(h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, spawnInto(h))).rejects.toThrow(/disk full.*Nothing was started/);
    expect(h.spawns).toEqual([]);
  });
});

describe('CliRuntimeResolver, pinned starts', () => {
  it('reports an update without presenting an unchecked placeholder as the new version', async () => {
    const exe = program();
    const h = harness(exe, { adoption: { find: () => undefined, adopt: async () => ({ ok: true, version: 'not-yet-checked' }) } });
    await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, spawnInto(h));
    writeFileSync(exe, 'newer unqualified program');
    const notices: string[] = [];
    await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'reuse', onPending: line => notices.push(line) }, spawnInto(h));
    expect(notices).toContain('CLI updated. Using the current program; its version is being checked.');
    expect(notices.join('\n')).not.toContain('not-yet-checked'); expect(h.spawns).toHaveLength(2);
  });
  it('a reuse start repins the current program automatically after an update', async () => {
    const exe = program();
    const h = harness(exe, { policy: policyQualifyingClaude([sha('claude program'), sha('a newer program')]) });
    await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, spawnInto(h));
    await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'reuse' }, spawnInto(h));
    expect(h.spawns).toHaveLength(2);
    // An update replaces the file with another qualified version: still not the pinned program.
    writeFileSync(exe, 'a newer program');
    const notices: string[] = [];
    await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'reuse', onPending: line => notices.push(line) }, spawnInto(h));
    expect(notices.join('\n')).toContain('2.1.304 → 2.1.304');
    expect(h.spawns).toHaveLength(3);
    expect(h.saves).toHaveLength(2);
    // The person's own start takes the new program and a new pin.
    await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, spawnInto(h));
    expect(h.saves).toHaveLength(3);
    expect(h.spawns).toHaveLength(4);
  });

  it('a reuse start refreshes a forgotten compatibility check rather than refusing', async () => {
    const exe = program();
    const h = harness(exe);
    await h.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'take' }, spawnInto(h));
    // The same saved pin, with no adoption record any more (Forget adoptions).
    const forgetting = harness(exe, { pins: { load: () => h.pins.get('s1'), save: async () => undefined } });
    await forgetting.resolver.start({ provider: 'claude-cli', sessionId: 's1', pin: 'reuse' }, spawnInto(forgetting));
    expect(forgetting.adoptions).toHaveLength(1);
    expect(forgetting.spawns).toHaveLength(1);
  });

  it('a reuse start of a session with no saved pin takes one', async () => {
    const exe = program();
    const h = harness(exe, { policy: policyQualifyingClaude([sha('claude program')]) });
    await h.resolver.start({ provider: 'claude-cli', sessionId: 'new', pin: 'reuse' }, spawnInto(h));
    expect(h.saves).toHaveLength(1);
  });

  it.each([
    ['not an object', 'pin', 'pin-unreadable'],
    ['an unknown version', { pinVersion: 2, mode: 'external', provider: 'claude-cli', executable: 'x', closureDigest: 'a'.repeat(64) }, 'pin-unreadable'],
    ['a managed pin without its store', { pinVersion: 1, mode: 'managed', provider: 'codex-cli', storeKey: '0.163.0-win32-x64-0123456789abcdef', closureDigest: 'a'.repeat(64) }, 'managed-store-replaced'],
  ])('a saved pin that is %s is refused, with zero spawns', async (_label, saved, reason) => {
    const exe = program();
    const h = harness(exe);
    h.pins.set('s1', saved);
    await expect(h.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'reuse' }, spawnInto(h))).rejects.toMatchObject({ reason });
    expect(h.spawns).toEqual([]);
  });

  it('a managed pin with no managed Codex on this host is refused as replaced, never started as external', async () => {
    const exe = program();
    const h = harness(exe);
    h.pins.set('s1', { pinVersion: 1, mode: 'managed', provider: 'codex-cli', storeId: 'a'.repeat(32), storeKey: '0.163.0-win32-x64-0123456789abcdef', closureDigest: 'b'.repeat(64) });
    await expect(h.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'reuse' }, spawnInto(h))).rejects.toBeInstanceOf(CliStartRefused);
    expect(h.spawns).toEqual([]);
    expect(h.adoptions).toEqual([]);
  });

  it('resolveExternal of a reuse start refuses a managed pin instead of resolving the external program', async () => {
    const exe = program();
    const h = harness(exe);
    h.pins.set('s1', { pinVersion: 1, mode: 'managed', provider: 'codex-cli', storeId: 'a'.repeat(32), storeKey: '0.163.0-win32-x64-0123456789abcdef', closureDigest: 'b'.repeat(64) });
    await expect(h.resolver.resolveExternal({ provider: 'codex-cli', sessionId: 's1', pin: 'reuse' })).rejects.toMatchObject({ reason: 'identity-changed' });
  });
});

describe('session pins', () => {
  it('parse only their own exact shape', () => {
    const managed = { pinVersion: 1, mode: 'managed', provider: 'codex-cli', storeId: 'a'.repeat(32), storeKey: '0.163.0-win32-x64-0123456789abcdef', closureDigest: 'b'.repeat(64) };
    expect(parseSessionRuntimePin(managed)).toEqual({ ok: true, pin: managed });
    expect(parseSessionRuntimePin({ ...managed, storeId: 'A'.repeat(32) })).toEqual({ ok: false, reason: 'pin-unreadable' });
    expect(parseSessionRuntimePin({ ...managed, storeKey: '..\\x' })).toEqual({ ok: false, reason: 'pin-unreadable' });
    expect(parseSessionRuntimePin({ ...managed, provider: 'claude-cli' })).toEqual({ ok: false, reason: 'pin-unreadable' });
    expect(parseSessionRuntimePin({ ...managed, closureDigest: 'short' })).toEqual({ ok: false, reason: 'pin-unreadable' });
    expect(parseSessionRuntimePin({ pinVersion: 1, mode: 'external', provider: 'claude-cli', executable: '', closureDigest: 'b'.repeat(64) })).toEqual({ ok: false, reason: 'pin-unreadable' });
    expect(parseSessionRuntimePin(null)).toEqual({ ok: false, reason: 'pin-unreadable' });
  });

  it('key managed identities by instance, version and closure, and external ones by the physical program without case on Windows', () => {
    const managed = { pinVersion: 1 as const, mode: 'managed' as const, provider: 'codex-cli' as const, storeId: 'a'.repeat(32), storeKey: '0.163.0-win32-x64-0123456789abcdef', closureDigest: 'b'.repeat(64) };
    expect(runtimeIdentityKey(managed)).toBe(`managed|codex-cli|${'a'.repeat(32)}|0.163.0-win32-x64-0123456789abcdef|${'b'.repeat(64)}`);
    expect(runtimeIdentityKey({ ...managed, storeId: 'c'.repeat(32) })).not.toBe(runtimeIdentityKey(managed));
    const external = { pinVersion: 1 as const, mode: 'external' as const, provider: 'claude-cli' as const, executable: 'C:\\Tools\\Claude.exe', closureDigest: 'b'.repeat(64) };
    expect(runtimeIdentityKey(external, 'win32')).toBe(runtimeIdentityKey({ ...external, executable: 'c:\\tools\\claude.exe' }, 'win32'));
    expect(runtimeIdentityKey(external, 'linux')).not.toBe(runtimeIdentityKey({ ...external, executable: 'c:\\tools\\claude.exe' }, 'linux'));
  });
});

describe('managedChoice', () => {
  const record = (fields: Partial<ControlRecord>): ControlRecord => ({
    schema: 'unodeai.cli-control/1', controlId: 'f'.repeat(32), generation: 3, previousRecordDigest: 'e'.repeat(64), reductionEpoch: 0,
    enrolledStoreId: 'a'.repeat(32), selection: 'managed', enrollment: { epoch: 1, consentedHosts: ['github.com'], decidedAt: 't' },
    scheduler: { epoch: 0, autoMode: false }, activationConsents: [], active: null, lastKnownGood: null, disabled: [], retiredInstances: [], decidedAt: 't',
    ...fields,
  });
  const readable = (fields: Partial<ControlRecord>, authority: 'ok' | 'behind-floor' = 'ok'): ManagedCodexStatus => ({
    suspension: { present: false },
    control: { kind: 'readable', authority, floor: 0, snapshot: { generation: 3, digest: 'd'.repeat(64), record: record(fields) } },
  });

  it('uses managed Codex only when it is set up, selected, readable and not paused', () => {
    expect(managedChoice(readable({}))).toEqual({ kind: 'managed' });
    expect(managedChoice(readable({ selection: 'external' }))).toEqual({ kind: 'external' });
    expect(managedChoice(readable({ enrolledStoreId: null, selection: 'external', enrollment: null }))).toEqual({ kind: 'external' });
    expect(managedChoice({ suspension: { present: false }, control: { kind: 'fresh' } })).toEqual({ kind: 'external' });
  });

  it('the shared suspension, readable or not, sends new sessions to the external program', () => {
    expect(managedChoice({ ...readable({}), suspension: { present: true, readable: false } })).toEqual({ kind: 'external' });
    expect(managedChoice({ ...readable({}), suspension: { present: true, readable: true, reason: 'r' } })).toEqual({ kind: 'external' });
  });

  it('an unusable or uncertain record starts nothing until the person chooses', () => {
    expect(managedChoice({ suspension: { present: false }, control: { kind: 'unusable', reason: 'floor-unavailable', detail: 'd' } })).toMatchObject({ kind: 'refuse', reason: 'authority-floor-unavailable' });
    expect(managedChoice({ suspension: { present: false }, control: { kind: 'unusable', reason: 'sealed', detail: 'd' } })).toMatchObject({ kind: 'refuse', reason: 'store-sealed' });
    expect(managedChoice({ suspension: { present: false }, control: { kind: 'unusable', reason: 'control-unreadable', detail: 'd' } })).toMatchObject({ kind: 'refuse', reason: 'control-unavailable' });
    expect(managedChoice(readable({}, 'behind-floor'))).toMatchObject({ kind: 'refuse', reason: 'authority-behind-floor' });
    expect(managedChoice(readable({ selection: 'external' }, 'behind-floor'))).toMatchObject({ kind: 'refuse', reason: 'authority-behind-floor' });
  });
});
