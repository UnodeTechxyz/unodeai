import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPolicy } from '../CommandPolicy';
import { commandShellIdentity } from '../CommandShell';
import { gateShellCommand, type CommandApprovalContext, type ShellCommandGateOptions } from '../ShellCommandGate';
import { decideCommandPermission, claudePermissionResponse } from '../commandPermission';
import { ProjectCommandApprovals, type WorkspaceMemento } from '../../settings/ProjectCommandApprovals';

const roots: string[] = [];
vi.mock('../ShellCommandGate', async importOriginal => {
  const actual = await importOriginal<typeof import('../ShellCommandGate')>();
  return { ...actual, gateShellCommand: vi.fn(actual.gateShellCommand) };
});
const shell = commandShellIdentity('bash', 'direct-fallback');
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-shell-outward-'))); roots.push(root);
  const artifact = path.join(root, 'fixture.vsix'); await fs.writeFile(artifact, 'public artifact one');
  const policy = new CommandPolicy('all');
  const environment = { OVSX_REGISTRY_URL: 'https://registry.example.invalid' };
  const options: ShellCommandGateOptions = { command: 'ovsx publish fixture.vsix', roots: root, cwd: root, shell,
    source: 'model', environment, commandPolicy: policy };
  return { root, artifact, policy, environment, options };
}

describe('the shared shell gate binds outward decisions to exact effects', () => {
  it('discloses normalized wrapper environment uncertainty on the actual one-use card', async () => {
    const h = await fixture(); const contexts: CommandApprovalContext[] = [];
    const command = process.platform === 'win32' || process.platform === 'darwin' ? 'ENV HOME=/different GIT push origin main' : 'env HOME=/different git push origin main';
    const result = await gateShellCommand({ ...h.options, command, requestApproval: async (_command, context) => { contexts.push(context); return { allow: false }; } });
    expect(result.ok).toBe(false); expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ forcePrompt: true, singleUse: true, outward: [], outwardUnknownReason: expect.stringContaining('environment prefix') });
  });
  it('routes a host-normalized executable through the real one-use outward approval before allowing execution', async () => {
    const h = await fixture(); const contexts: CommandApprovalContext[] = [];
    const command = process.platform === 'win32' || process.platform === 'darwin' ? 'OVSX publish fixture.vsix' : 'ovsx publish fixture.vsix';
    const result = await gateShellCommand({ ...h.options, command, requestApproval: async (_command, context) => { contexts.push(context); return { allow: false }; } });
    expect(result.ok).toBe(false); expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ forcePrompt: true, singleUse: true, outward: [expect.objectContaining({ destination: 'https://registry.example.invalid/' })] });
  });
  it.each(['all', 'ask', 'allowlist'] as const)('a real stored command template cannot bypass one-use outward review in %s', async mode => {
    const h = await fixture();
    const rows = new Map<string, unknown>([['newer.theme', 'dark'], ['newer.messages', ['unrelated']], ['newer.runs', ['unrelated']]]);
    const state: WorkspaceMemento = { get: <T>(key: string) => rows.get(key) as T | undefined,
      update: async (key, value) => { rows.set(key, value); } };
    const store = new ProjectCommandApprovals(state, () => h.root);
    await store.approve({ grammar: 'posix', template: 'ovsx publish' });
    const policy = new CommandPolicy(mode, { configured: [], project: store.list() });
    expect(policy.check(h.options.command, { shell }).allowed).toBe(true);
    const contexts: CommandApprovalContext[] = [];
    const result = await gateShellCommand({ ...h.options, commandPolicy: policy,
      requestApproval: async (_command, context) => { contexts.push(context); return { allow: true }; } });
    expect(result).toMatchObject({ ok: true, revalidate: expect.any(Function) });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ forcePrompt: true, singleUse: true, cwd: h.root,
      outward: [expect.objectContaining({ destination: 'https://registry.example.invalid/', content: expect.stringContaining('SHA-256') })] });
    expect(contexts[0]).not.toHaveProperty('fingerprint'); expect(contexts[0]).not.toHaveProperty('environment');
    expect(store.list()).toEqual([{ grammar: 'posix', template: 'ovsx publish' }]);
  });

  it('combines ordinary Review and outward review into one exact approval', async () => {
    const h = await fixture(); h.policy.reload('ask', []);
    const approve = vi.fn(async () => ({ allow: true }));
    const result = await gateShellCommand({ ...h.options, requestApproval: approve });
    expect(result.ok).toBe(true); expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0][1]).toMatchObject({ singleUse: true, forcePrompt: true, outward: expect.any(Array) });
  });

  it.each(['none', 'allowlist'] as const)('honors %s before reading metadata or presenting outward approval', async mode => {
    const h = await fixture(); h.policy.reload(mode, []); let reads = 0;
    const environment = Object.defineProperty({}, 'OVSX_REGISTRY_URL', { enumerable: true, get: () => { reads++; return 'https://registry.example.invalid'; } });
    const approve = vi.fn(async () => ({ allow: true }));
    const result = await gateShellCommand({ ...h.options, environment, requestApproval: approve });
    expect(result).toMatchObject({ ok: false, kind: 'policy' }); expect(reads).toBe(0); expect(approve).not.toHaveBeenCalled();
  });

  it('keeps native unknown-environment execution on the host-tool route without inventing metadata', async () => {
    const h = await fixture();
    const approve = vi.fn(async () => ({ allow: true }));
    const result = await gateShellCommand({ ...h.options, environment: undefined, source: 'native', requestApproval: approve });
    expect(result).toMatchObject({ ok: false, kind: 'safety', reason: 'outward-environment' });
    expect(result.ok ? '' : result.message).toContain('host run_command');
    expect(approve).not.toHaveBeenCalled();
  });

  it.each(['model', 'config'] as const)('asks once for an unverified %s environment with an honest unknown-effect disclosure', async source => {
    const h = await fixture(); const contexts: CommandApprovalContext[] = [];
    const result = await gateShellCommand({ ...h.options, source, environment: undefined,
      requestApproval: async (_command, context) => { contexts.push(context); return { allow: true }; } });
    expect(result).toMatchObject({ ok: true, revalidate: expect.any(Function) });
    expect(contexts).toHaveLength(1); expect(contexts[0]).toMatchObject({ outward: [], cwd: h.root, shell,
      singleUse: true, forcePrompt: true, outwardUnknownReason: expect.stringContaining('unverified') });
  });

  it.each(['cargo publish', 'gh pr create --fill', 'git add -A && git commit -m fixture && git push',
    'npm publish --registry=https://registry.example.invalid', 'npx @vscode/vsce publish'])
  ('asks once for recognized unresolved %s instead of refusing or inventing a target', async command => {
    const h = await fixture(); h.policy.reload('ask', []); const approve = vi.fn(async () => ({ allow: true }));
    await fs.writeFile(path.join(h.root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', publisher: 'fixture',
      scripts: { prepublishOnly: 'must-not-run', 'vscode:prepublish': 'must-not-run' } }));
    const result = await gateShellCommand({ ...h.options, command, requestApproval: approve });
    expect(result).toMatchObject({ ok: true, revalidate: expect.any(Function) });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0][1]).toMatchObject({ outward: [], singleUse: true, forcePrompt: true, cwd: h.root,
      outwardUnknownReason: expect.any(String) });
  });

  it('checks a mixed dangerous-delete and real outward chain before allowing a dangerous-only decision', async () => {
    const h = await fixture(); const approve = vi.fn(async () => ({ allow: true }));
    const result = await gateShellCommand({ ...h.options, command: 'rm -rf output && ovsx publish fixture.vsix', requestApproval: approve });
    expect(result).toMatchObject({ ok: true }); expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0][1]).toMatchObject({ outward: [], outwardUnknownReason: expect.any(String), singleUse: true });
    expect(await fs.readFile(h.artifact, 'utf8')).toBe('public artifact one');
  });

  it.each(['metadata becomes ready', 'Off', 'Off then enable', 'Stop'] as const)
  ('holds an unknown outward decision through %s without blocking unrelated work or replaying', async ending => {
    const h = await fixture(); const entered = deferred<void>(); const answer = deferred<void>(); const abort = new AbortController();
    const contexts: CommandApprovalContext[] = [];
    const waiting = gateShellCommand({ ...h.options, command: 'npm publish --registry=https://registry.example.invalid', signal: abort.signal,
      requestApproval: async (_command, context) => { contexts.push(context); entered.resolve(); await answer.promise; return { allow: true }; } });
    await entered.promise; expect((await gateShellCommand({ ...h.options, command: 'npm test' })).ok).toBe(true);
    if (ending === 'metadata becomes ready') await fs.writeFile(path.join(h.root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    if (ending === 'Off') h.policy.reload('none', []);
    if (ending === 'Off then enable') { h.policy.reload('none', []); h.policy.reload('all', []); }
    if (ending === 'Stop') abort.abort();
    answer.resolve(); const result = await waiting;
    expect(contexts).toHaveLength(1); expect(contexts[0]).toMatchObject({ outward: [], outwardUnknownReason: expect.any(String), cwd: h.root, shell });
    expect(result.ok).toBe(ending === 'metadata becomes ready');
    if (result.ok) expect(await result.revalidate!()).toBeUndefined();
    else expect(result.reason).toBe(ending === 'Stop' ? 'approval-withdrawn' : 'policy-changed');
  });

  it('captures the entire unknown command cwd and shell before a held approval', async () => {
    const h = await fixture(); const entered = deferred<void>(); const answer = deferred<void>(); const contexts: CommandApprovalContext[] = [];
    const mutableShell = { ...shell }; const options = { ...h.options, shell: mutableShell, command: 'cargo publish',
      requestApproval: async (command: string, context: CommandApprovalContext) => {
        expect(command).toBe('cargo publish'); contexts.push(context); entered.resolve(); await answer.promise; return { allow: true };
      } };
    const waiting = gateShellCommand(options); await entered.promise;
    options.command = 'gh pr create'; options.cwd = '/caller-mutated-cwd'; mutableShell.fingerprint = 'caller-mutated-shell';
    answer.resolve(); const result = await waiting;
    expect(result.ok).toBe(true); expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ cwd: h.root, shell: { fingerprint: shell.fingerprint }, outward: [], outwardUnknownReason: expect.any(String) });
    if (result.ok) expect(await result.revalidate!()).toBeUndefined();
  });

  it.each(['unknown effects', 'unverified environment'] as const)
  ('retires a held %s config approval after cwd replacement and checks again at the final effect', async scenario => {
    const h = await fixture(); const cwd = path.join(h.root, 'checks'); await fs.mkdir(cwd);
    const environment = scenario === 'unknown effects' ? h.environment : undefined;
    const entered = deferred<void>(); const answer = deferred<void>(); let questions = 0;
    const options = { ...h.options, cwd, roots: cwd, source: 'config' as const, command: 'cargo publish', environment };
    const waiting = gateShellCommand({ ...options, requestApproval: async () => { questions++; entered.resolve(); await answer.promise; return { allow: true }; } });
    await entered.promise; expect((await gateShellCommand({ ...h.options, command: 'npm test' })).ok).toBe(true);
    await fs.rename(cwd, cwd + '-old'); await fs.mkdir(cwd); answer.resolve();
    expect(await waiting).toMatchObject({ ok: false, reason: 'effect-changed' }); expect(questions).toBe(1);
    const admitted = await gateShellCommand({ ...options, requestApproval: async () => { questions++; return { allow: true }; } });
    expect(admitted.ok).toBe(true); if (!admitted.ok) throw new Error('expected current folder approval');
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'new-metadata', version: '1.0.0' }));
    expect(await admitted.revalidate!()).toBeUndefined();
    await fs.rename(cwd, cwd + '-second'); await fs.mkdir(cwd);
    expect(await admitted.revalidate!()).toMatchObject({ ok: false, reason: 'effect-changed' }); expect(questions).toBe(2);
  });

  it.each(['model', 'native', 'config'] as const)('keeps %s previews on ordinary Review without an outward approval', async source => {
    const contexts: CommandApprovalContext[] = []; const policy = new CommandPolicy('all');
    const options = { command: 'npm publish --dry-run', roots: '/missing-fixture', cwd: '/missing-fixture', shell, source, commandPolicy: policy,
      requestApproval: async (_command: string, context: CommandApprovalContext) => { contexts.push(context); return { allow: true }; } };
    expect((await gateShellCommand(options)).ok).toBe(true); expect(contexts).toEqual([]);
    policy.reload('ask', []); expect((await gateShellCommand(options)).ok).toBe(true);
    expect(contexts).toHaveLength(1); expect(contexts[0].outward).toBeUndefined();
    policy.reload('none', []); expect((await gateShellCommand(options)).ok).toBe(false); expect(contexts).toHaveLength(1);
  });

  it.each(['payload', 'Off', 'Off then enable', 'Stop'] as const)('retires a pending exact outward decision after %s without another question or replay', async ending => {
    const h = await fixture(); const abort = new AbortController(); let questions = 0;
    const result = await gateShellCommand({ ...h.options, signal: abort.signal,
      requestApproval: async () => { questions++;
        if (ending === 'payload') await fs.writeFile(h.artifact, 'PUBLIC artifact one');
        if (ending === 'Off') h.policy.reload('none', []);
        if (ending === 'Off then enable') { h.policy.reload('none', []); h.policy.reload('all', []); }
        if (ending === 'Stop') abort.abort();
        return { allow: true };
      } });
    expect(result.ok).toBe(false); expect(questions).toBe(1);
    expect(result.ok ? '' : result.reason).toBe(ending === 'payload' ? 'effect-changed' : ending.startsWith('Off') ? 'policy-changed' : 'approval-withdrawn');
  });

  it('keeps unrelated work moving during an outward decision and rechecks again immediately before the effect', async () => {
    const h = await fixture(); const entered = deferred<void>(); const answer = deferred<void>(); let questions = 0;
    const waiting = gateShellCommand({ ...h.options, requestApproval: async () => { questions++; entered.resolve(); await answer.promise; return { allow: true }; } });
    await entered.promise;
    const independent = await gateShellCommand({ ...h.options, command: 'npm test' }); expect(independent.ok).toBe(true);
    answer.resolve(); const approved = await waiting; expect(approved.ok).toBe(true); expect(questions).toBe(1);
    if (!approved.ok) throw new Error('expected the original proposal approval');
    expect(await approved.revalidate!()).toBeUndefined();
    await fs.writeFile(h.artifact, 'PUBLIC artifact one');
    expect(await approved.revalidate!()).toMatchObject({ ok: false, reason: 'effect-changed' }); expect(questions).toBe(1);
  });

  it('rechecks current Off and new Review choices at the final command effect boundary', async () => {
    const h = await fixture();
    const ordinary = await gateShellCommand({ ...h.options, command: 'npm test' }); expect(ordinary.ok).toBe(true);
    if (!ordinary.ok) throw new Error('expected ordinary command admission');
    h.policy.reload('ask', []); expect(await ordinary.revalidate!()).toMatchObject({ reason: 'policy-changed' });
    h.policy.reload('all', []);
    const ready = await gateShellCommand({ ...h.options, requestApproval: async () => ({ allow: true }) });
    expect(ready.ok).toBe(true); if (!ready.ok) throw new Error('expected outward admission');
    h.policy.reload('none', []); expect(await ready.revalidate!()).toMatchObject({ reason: 'policy-changed' });
    h.policy.reload('all', []);
    const narrowed = await gateShellCommand({ ...h.options, requestApproval: async () => ({ allow: true }) });
    expect(narrowed.ok).toBe(true); if (!narrowed.ok) throw new Error('expected current-policy admission');
    h.policy.reload('allowlist', []); expect(await narrowed.revalidate!()).toMatchObject({ reason: 'policy-changed' });
  });

  it.each(['model', 'native', 'config'] as const)('keeps a human outward decline note separate from the generated %s result', async source => {
    const h = await fixture(); const privateReason = 'private reason: fixture-key-value';
    const result = await gateShellCommand({ ...h.options, source, requestApproval: async () => ({ allow: false, note: privateReason }) });
    expect(result).toMatchObject({ ok: false, kind: 'approval', userNote: privateReason });
    expect(result.ok ? '' : result.message).not.toContain(privateReason);
    expect(result).not.toHaveProperty('note');
  });

  it.each(['model', 'config'] as const)('carries an ordinary %s human decline note separately for quoting by the caller', async source => {
    const h = await fixture(); h.policy.reload('ask', []);
    const result = await gateShellCommand({ ...h.options, source, command: 'npm install public-fixture-package',
      requestApproval: async () => ({ allow: false, note: 'PRIVATE ordinary fixture note' }) });
    expect(result).toMatchObject({ ok: false, kind: 'approval' });
    expect(result).toMatchObject({ userNote: 'PRIVATE ordinary fixture note' });
    expect(result.ok ? '' : result.message).not.toContain('PRIVATE ordinary fixture note'); expect(result).not.toHaveProperty('note');
  });

  it('carries only actual human denial notes across ordinary, unknown, ready and dangerous approval branches', async () => {
    const h = await fixture(); h.policy.reload('ask', []);
    for (const command of ['npm test', 'cargo publish', h.options.command, 'rm -rf .']) {
      for (const source of ['model', 'config', 'native'] as const) {
        const human = await gateShellCommand({ ...h.options, command, source,
          requestApproval: async () => ({ allow: false, note: 'human said "choose another target"', noteOrigin: 'human' }) });
        expect(human).toMatchObject({ ok: false, kind: 'approval', userNote: 'human said "choose another target"' });
        for (const decision of [{ allow: false, note: 'host expiry', noteOrigin: 'host' as const },
          { allow: false, note: 'withdrawn notice', withdrawn: true }]) {
          const host = await gateShellCommand({ ...h.options, command, source, requestApproval: async () => decision });
          expect(host.ok).toBe(false); expect(host).not.toHaveProperty('userNote');
        }
      }
    }
  });

  it('uses the same native gate even when the command policy already allows a tool, and ignores model cwd/env', async () => {
    const h = await fixture(); const contexts: CommandApprovalContext[] = [];
    const input = { command: h.options.command, cwd: '/model-cwd-is-not-authority', env: { OVSX_REGISTRY_URL: 'https://model.example.invalid' } };
    const result = await decideCommandPermission('Bash', input, { policy: h.policy, cwd: h.root, environment: h.environment,
      requestApproval: async (_command, context) => { contexts.push(context); return { allow: true }; } });
    expect(result).toEqual({ behavior: 'allow', updatedInput: input }); expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ cwd: h.root, outward: [expect.objectContaining({ destination: 'https://registry.example.invalid/' })] });
  });

  it('native outward calls without a verified environment use fixed host-tool guidance and keep host notices separate', async () => {
    const h = await fixture(); const approve = vi.fn(async () => ({ allow: true }));
    const missing = await decideCommandPermission('Bash', { command: h.options.command }, { policy: h.policy, cwd: h.root, requestApproval: approve });
    expect(missing).toMatchObject({ behavior: 'deny', reason: 'safety-limit' }); expect(approve).not.toHaveBeenCalled();
    expect(claudePermissionResponse(missing)).toMatchObject({ message: expect.stringContaining('host run_command') });
    const denied = await decideCommandPermission('Bash', { command: h.options.command }, { policy: h.policy, cwd: h.root, environment: h.environment,
      requestApproval: async () => ({ allow: false, note: 'PRIVATE fixture note', noteOrigin: 'host' }) });
    expect(denied).toMatchObject({ behavior: 'deny', reason: 'consent' });
    expect(JSON.stringify(claudePermissionResponse(denied))).not.toContain('PRIVATE fixture note');
  });

  it('retains ordinary native outside-path capability without a new folder-access question', async () => {
    const h = await fixture(); const approve = vi.fn(async () => ({ allow: true }));
    expect(await decideCommandPermission('Bash', { command: 'cat /somewhere/outside/public-fixture.txt' }, {
      policy: h.policy, cwd: h.root, requestApproval: approve })).toMatchObject({ behavior: 'allow' });
    expect(approve).not.toHaveBeenCalled();
  });

  it.each(['trust', 'scope'] as const)('rechecks the host native %s boundary after an approval wait', async ending => {
    const h = await fixture(); let trusted = true; let readOnly = false;
    const result = await decideCommandPermission('Bash', { command: h.options.command }, {
      policy: h.policy, cwd: h.root, environment: h.environment,
      get isTrusted() { return trusted; }, get readOnly() { return readOnly; },
      requestApproval: async () => { if (ending === 'trust') trusted = false; else readOnly = true; return { allow: true }; },
    });
    expect(result).toMatchObject({ behavior: 'deny', reason: ending });
  });

  it('native permission consumes the final effect lease after the shared gate returns', async () => {
    const h = await fixture(); const actual = await vi.importActual<typeof import('../ShellCommandGate')>('../ShellCommandGate');
    vi.mocked(gateShellCommand).mockImplementationOnce(async options => {
      const result = await actual.gateShellCommand(options);
      h.policy.reload('none', []); h.policy.reload('all', []);
      return result;
    });
    const decision = await decideCommandPermission('Bash', { command: h.options.command }, {
      cwd: h.root, environment: h.environment, policy: h.policy, requestApproval: async () => ({ allow: true }),
    });
    expect(decision).toMatchObject({ behavior: 'deny', reason: 'capability' });
  });

  it('native permission keeps an unexpected effect-check exception private and does not allow the command', async () => {
    const h = await fixture();
    vi.mocked(gateShellCommand).mockResolvedValueOnce({ ok: true, revalidate: async () => { throw new Error('PRIVATE effect-check fixture'); } });
    const decision = await decideCommandPermission('Bash', { command: 'npm test' }, { cwd: h.root, policy: h.policy });
    expect(decision).toMatchObject({ behavior: 'deny', reason: 'safety-limit' });
    expect(JSON.stringify(claudePermissionResponse(decision))).not.toContain('PRIVATE effect-check fixture');
  });

  it('native unknown metadata reaches one disclosed approval without forwarding host diagnostics', async () => {
    const h = await fixture();
    await fs.writeFile(path.join(h.root, 'package.json'), JSON.stringify({ name: '@host-private-fixture/package', version: '1.0.0' }));
    const approve = vi.fn(async () => ({ allow: true }));
    const result = await decideCommandPermission('Bash', { command: 'npm publish --registry=https://registry.example.invalid' }, {
      cwd: h.root, environment: h.environment, policy: h.policy, requestApproval: approve,
    });
    expect(result).toMatchObject({ behavior: 'allow' }); expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0][1]).toMatchObject({ outwardUnknownReason: expect.any(String), outward: [] });
    expect(JSON.stringify(claudePermissionResponse(result))).not.toContain('host-private-fixture');
  });
});
