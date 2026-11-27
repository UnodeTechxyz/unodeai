/*
 * v0.9.106 (D1): an agent's command that installs outside the project reaches the existing command card once, also
 * when commands otherwise run without asking. These cases go through the production shell gate, the real
 * WorkspaceTools run_command route with its direct execution provider, and the Claude native-tool decider.
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPolicy, type CommandApprovalMode } from '../CommandPolicy';
import { AgentCommandPolicy } from '../AgentCommandPolicy';
import { gateShellCommand, type CommandApprovalContext, type CommandApprover, type ShellCommandGateOptions } from '../ShellCommandGate';
import { decideCommandPermission } from '../commandPermission';
import { WorkspaceTools } from '../WorkspaceTools';
import { createDirectCommandPreparer, createDirectExecutionProvider } from '../DirectCommandExecution';
import { BASH_SHELL } from './shellFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { modelFacingToolOutput } from '../toolSummary';

afterEach(removeTemporaryFolders);

/** A project that declares typescript (installed, with its `tsc` command) and nothing else. */
async function project(): Promise<string> {
  const root = await fs.realpath(await temporaryFolder('unode-global-install-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', devDependencies: { typescript: '^5' } }));
  await fs.mkdir(path.join(root, 'node_modules', 'typescript'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', bin: { tsc: 'bin/tsc' } }));
  return root;
}

function recorder(answer: (context: CommandApprovalContext) => { allow: boolean; note?: string; withdrawn?: boolean } = () => ({ allow: true })) {
  const contexts: CommandApprovalContext[] = [];
  const approve: CommandApprover = async (_command, context) => { contexts.push(context); return answer(context); };
  return { contexts, approve };
}

async function gate(command: string, root: string, mode: CommandApprovalMode, approve?: CommandApprover,
  extra: Partial<ShellCommandGateOptions> = {}) {
  return gateShellCommand({ command, roots: root, cwd: root, source: 'model', shell: BASH_SHELL,
    environment: { PATH: '' }, commandPolicy: new CommandPolicy(mode), ...(approve ? { requestApproval: approve } : {}), ...extra });
}

describe('the shell gate sends an install outside the project to the existing card', () => {
  it.each([
    ['npm install -g cowsay', "npm's global folder"],
    ['npx playwright install chromium', 'ms-playwright'],
    ['winget install Git.Git', 'through winget'],
    ['pip install requests', 'not a project virtual environment'],
    ['npx cowsay hello', '_npx folder'],
  ])('asks once for %s although commands run automatically', async (command, where) => {
    const root = await project();
    const { contexts, approve } = recorder();
    const result = await gate(command, root, 'all', approve);
    expect(result).toMatchObject({ ok: true });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ singleUse: true, forcePrompt: true, cwd: root,
      warning: expect.stringContaining('This command installs outside the project:') });
    expect(contexts[0].warning).toContain(where);
    expect(contexts[0].warning).toContain('Size: ');
  });

  it.each([
    'npm install -D vitest',
    'npm install',
    'npm run build',
    'npx tsc --noEmit',
    'pip install --target ./vendor requests',
    'python -m venv .venv && .venv/bin/pip install requests',
  ])('runs %s, a project-local command, without a card', async (command) => {
    const root = await project();
    const { contexts, approve } = recorder();
    expect(await gate(command, root, 'all', approve)).toMatchObject({ ok: true });
    expect(contexts).toEqual([]);
  });

  it('finds the install in a compound command, and asks once for the whole command', async () => {
    const root = await project();
    const { contexts, approve } = recorder();
    expect(await gate('npm test && npm install -g cowsay && pip install requests', root, 'all', approve)).toMatchObject({ ok: true });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].warning).toContain('- npm install -g cowsay');
    expect(contexts[0].warning).toContain('- pip install requests');
  });

  it('asks once when Ask would have asked anyway, and offers no remembered grant', async () => {
    const root = await project();
    const { contexts, approve } = recorder();
    expect(await gate('npm install -g cowsay', root, 'ask', approve)).toMatchObject({ ok: true });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ singleUse: true, forcePrompt: true });
  });

  it('adds the note to the one outward card of a command that is also outward', async () => {
    const root = await project();
    const { contexts, approve } = recorder();
    await gate('npm publish --registry=https://registry.invalid && npm install -g cowsay', root, 'all', approve);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ outward: expect.any(Array), singleUse: true,
      installNote: expect.stringContaining('npm install -g cowsay'), warning: expect.stringContaining('installs outside the project') });
  });

  it('adds the note to the one destructive-command confirmation of a command that is also destructive', async () => {
    const root = await project();
    const { contexts, approve } = recorder();
    await gate('rm -rf . && npm install -g cowsay', root, 'all', approve);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ dangerous: true, installNote: expect.stringContaining('npm install -g cowsay') });
  });

  it('carries an out-of-root path on the same single card', async () => {
    const root = await project();
    const { contexts, approve } = recorder();
    const outside = path.join(path.dirname(root), 'elsewhere-requirements.txt');
    const result = await gate(`pip install -r ${outside}`, root, 'all', approve);
    expect(result).toMatchObject({ ok: true, outsidePath: outside });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].warning).toContain('installs outside the project');
    expect(contexts[0].warning).toContain(`names "${outside}"`);
  });

  it('a declined install is not run, and tells the agent to report it and go on', async () => {
    const root = await project();
    const { approve } = recorder(() => ({ allow: false, note: 'not on this machine' }));
    const result = await gate('npm install -g cowsay', root, 'all', approve);
    expect(result).toMatchObject({ ok: false, kind: 'approval', reason: 'global-install-unapproved', userNote: 'not on this machine' });
    expect(result.ok ? '' : result.message).toContain('continue with the work that does not need it');
  });

  it('with no one to ask, the install is not run and nothing waits', async () => {
    const root = await project();
    const result = await gate('npx playwright install', root, 'all');
    expect(result).toMatchObject({ ok: false, kind: 'outside-unattended', reason: 'global-install-unattended' });
    expect(result.ok ? '' : result.message).toContain('Tell the user what is missing and the exact command');
  });

  it('explicit Off stays Off: no card, and an approval cannot run it', async () => {
    const root = await project();
    const { contexts, approve } = recorder();
    expect(await gate('npm install -g cowsay', root, 'none', approve)).toMatchObject({ ok: false, kind: 'policy' });
    expect(contexts).toEqual([]);
  });

  it('a command the allowlist refuses stays refused, with no card', async () => {
    const root = await project();
    const { contexts, approve } = recorder();
    expect(await gate('npm install -g cowsay', root, 'allowlist', approve)).toMatchObject({ ok: false, kind: 'policy' });
    expect(contexts).toEqual([]);
  });

  it('Commands turned Off while the card waits wins over the approval', async () => {
    const root = await project();
    const policy = new CommandPolicy('all');
    const approve: CommandApprover = async () => { policy.reload('none', []); policy.reload('all', []); return { allow: true }; };
    const result = await gate('npm install -g cowsay', root, 'all', approve, { commandPolicy: policy });
    expect(result).toMatchObject({ ok: false, kind: 'policy', reason: 'policy-changed' });
  });

  it('does not read the person\'s own configured verify command', async () => {
    const root = await project();
    const { contexts, approve } = recorder();
    expect(await gate('npx cowsay hello', root, 'all', approve, { source: 'config' })).toMatchObject({ ok: true });
    expect(contexts).toEqual([]);
  });
});

describe('permission the person already gave explicitly is not asked again', () => {
  it.each(['all', 'allowlist', 'ask'] as const)('a configured allowedCommands entry runs the install without a card in %s', async (mode) => {
    const root = await project();
    const { contexts, approve } = recorder();
    const policy = new CommandPolicy(mode, { configured: ['npm install'], project: [] });
    expect(await gate('npm install -g cowsay', root, mode, approve, { commandPolicy: policy })).toMatchObject({ ok: true });
    expect(contexts).toEqual([]);
  });

  it.each(['all', 'ask'] as const)('a remembered project approval runs the install without a card in %s', async (mode) => {
    const root = await project();
    const { contexts, approve } = recorder();
    const policy = new CommandPolicy(mode, { configured: [], project: [{ grammar: 'posix', template: 'npx playwright' }] });
    expect(await gate('npx playwright install', root, mode, approve, { commandPolicy: policy })).toMatchObject({ ok: true });
    expect(contexts).toEqual([]);
  });

  it('with no approval surface, an explicitly granted install runs as before', async () => {
    const root = await project();
    const policy = new CommandPolicy('all', { configured: ['pip install'], project: [] });
    expect(await gate('pip install requests', root, 'all', undefined, { commandPolicy: policy })).toMatchObject({ ok: true });
  });

  it('a grant of another command, or of one segment only, is not a grant of the install', async () => {
    const root = await project();
    const other = recorder();
    await gate('npm install -g cowsay', root, 'all', other.approve, { commandPolicy: new CommandPolicy('all', { configured: ['npm test'], project: [] }) });
    expect(other.contexts).toHaveLength(1);
    const partial = recorder();
    await gate('npm test && npm install -g cowsay', root, 'all', partial.approve,
      { commandPolicy: new CommandPolicy('all', { configured: ['npm test'], project: [] }) });
    expect(partial.contexts).toHaveLength(1);
    // A grammar-bound approval given in another shell grants nothing here.
    const elsewhere = recorder();
    await gate('npm install -g cowsay', root, 'all', elsewhere.approve,
      { commandPolicy: new CommandPolicy('all', { configured: [], project: [{ grammar: 'powershell', template: 'npm install' }] }) });
    expect(elsewhere.contexts).toHaveLength(1);
  });

  it('a grant does not lift explicit Off', async () => {
    const root = await project();
    const { contexts, approve } = recorder();
    const policy = new CommandPolicy('none', { configured: ['npm install'], project: [] });
    expect(policy.explicitlyGranted('npm install -g cowsay', { shell: BASH_SHELL })).toBe(false);
    expect(await gate('npm install -g cowsay', root, 'none', approve, { commandPolicy: policy })).toMatchObject({ ok: false, kind: 'policy' });
    expect(contexts).toEqual([]);
  });

  it('an agent sees the workspace grant, and under a narrowing only the templates it selected', async () => {
    const root = await project();
    const global = new CommandPolicy('all', { configured: ['npm install'], project: [] });
    const inherits = recorder();
    await gate('npm install -g cowsay', root, 'all', inherits.approve, { commandPolicy: new AgentCommandPolicy(global, undefined, 'Dev') });
    expect(inherits.contexts).toEqual([]);
    const selected = recorder();
    await gate('npm install -g cowsay', root, 'all', selected.approve,
      { commandPolicy: new AgentCommandPolicy(global, { approvalMode: 'all', allowedCommands: ['npm install'] }, 'Dev') });
    expect(selected.contexts).toEqual([]);
    const notSelected = recorder();
    await gate('npm install -g cowsay', root, 'all', notSelected.approve,
      { commandPolicy: new AgentCommandPolicy(global, { approvalMode: 'all', allowedCommands: [] }, 'Dev') });
    expect(notSelected.contexts).toHaveLength(1);
  });
});

describe('a project venv pip sent outside the project, through the Claude native shell tool', () => {
  it.each([
    './.venv/Scripts/pip.exe install --target ../user-site-packages requests',
    './.venv/Scripts/pip.exe install --prefix ../global-python-prefix requests',
  ])('%s takes one card, and a denial refuses it', async (command) => {
    const root = await project();
    await fs.mkdir(path.join(root, '.venv', 'Scripts'), { recursive: true });
    await fs.writeFile(path.join(root, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    const { contexts, approve } = recorder(() => ({ allow: false }));
    const decision = await decideCommandPermission('Bash', { command }, { policy: new CommandPolicy('all'), cwd: root, roots: root,
      environment: { PATH: '' }, requestApproval: approve });
    expect(decision).toMatchObject({ behavior: 'deny', reason: 'consent' });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].warning).toContain('the folder pip was told to install into (../');
  });

  it('the same venv pip into a folder of the project takes no card', async () => {
    const root = await project();
    await fs.mkdir(path.join(root, '.venv', 'Scripts'), { recursive: true });
    const { contexts, approve } = recorder(() => ({ allow: false }));
    expect(await decideCommandPermission('Bash', { command: './.venv/Scripts/pip.exe install --target ./vendor requests' }, {
      policy: new CommandPolicy('all'), cwd: root, roots: root, environment: { PATH: '' }, requestApproval: approve,
    })).toMatchObject({ behavior: 'allow' });
    expect(contexts).toEqual([]);
  });
});

describe('the Claude native shell tool takes the same card', () => {
  it('asks once, and allows only when approved', async () => {
    const root = await project();
    const policy = new CommandPolicy('all');
    const allowed = recorder();
    expect(await decideCommandPermission('Bash', { command: 'npm install -g cowsay' }, { policy, cwd: root, roots: root,
      environment: { PATH: '' }, requestApproval: allowed.approve })).toMatchObject({ behavior: 'allow' });
    expect(allowed.contexts).toHaveLength(1);
    expect(allowed.contexts[0].warning).toContain('installs outside the project');

    const declined = recorder(() => ({ allow: false }));
    const refusal = await decideCommandPermission('Bash', { command: 'npm install -g cowsay' }, { policy, cwd: root, roots: root,
      environment: { PATH: '' }, requestApproval: declined.approve });
    expect(refusal).toMatchObject({ behavior: 'deny', reason: 'consent', message: expect.stringContaining('continue with the work that does not need it') });

    const unattended = await decideCommandPermission('Bash', { command: 'npm install -g cowsay' }, { policy, cwd: root, roots: root,
      environment: { PATH: '' } });
    expect(unattended).toMatchObject({ behavior: 'deny', reason: 'scope', message: expect.stringContaining('no one is available to approve it') });
  });

  it('runs a project-local install without a card', async () => {
    const root = await project();
    const { contexts, approve } = recorder();
    expect(await decideCommandPermission('Bash', { command: 'npm install -D vitest' }, { policy: new CommandPolicy('all'), cwd: root,
      roots: root, environment: { PATH: '' }, requestApproval: approve })).toMatchObject({ behavior: 'allow' });
    expect(contexts).toEqual([]);
  });
});

describe('run_command through WorkspaceTools and the direct execution provider', () => {
  async function host(approve?: CommandApprover) {
    const root = await project();
    const spawned: string[] = [];
    const prepare = createDirectCommandPreparer({
      shell: () => ({ identity: BASH_SHELL, executable: '/not-a-real-shell' }), env: () => ({ PATH: '' }),
      spawn: (command) => {
        spawned.push(command);
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter() });
        queueMicrotask(() => { child.emit('spawn'); child.emit('close', 0); });
        return child;
      },
    });
    const provider = createDirectExecutionProvider(prepare);
    const tools = new WorkspaceTools(root, new Set(['read', 'write', 'execute']), 'dev', undefined, new CommandPolicy('all'), undefined,
      approve, undefined, undefined, provider);
    return { tools, spawned };
  }

  it('a declined install starts no process, and the next ordinary command runs', async () => {
    const approve = vi.fn<CommandApprover>(async () => ({ allow: false }));
    const h = await host(approve);
    const refused = await h.tools.run('run_command', { command: 'npm install -g cowsay' });
    expect(refused).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(modelFacingToolOutput(refused)).toContain('continue with the work that does not need it');
    expect(h.spawned).toEqual([]);
    expect(approve).toHaveBeenCalledTimes(1);

    expect(await h.tools.run('run_command', { command: 'npm test' })).toMatchObject({ status: 'success', exitCode: 0 });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toContain('npm test');
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('an approved install runs once; the next one asks again', async () => {
    const approve = vi.fn<CommandApprover>(async () => ({ allow: true }));
    const h = await host(approve);
    expect(await h.tools.run('run_command', { command: 'npm install -g cowsay' })).toMatchObject({ status: 'success' });
    expect(await h.tools.run('run_command', { command: 'npm install -g cowsay' })).toMatchObject({ status: 'success' });
    expect(approve).toHaveBeenCalledTimes(2);
    expect(h.spawned).toHaveLength(2);
  });

  it('with no approval surface, the install is refused and the agent can go on', async () => {
    const h = await host(undefined);
    const refused = await h.tools.run('run_command', { command: 'pip install requests' });
    expect(refused).toMatchObject({ status: 'refused', reason: 'scope' });
    expect(modelFacingToolOutput(refused)).toContain('Tell the user what is missing and the exact command');
    expect(h.spawned).toEqual([]);
    expect(await h.tools.run('run_command', { command: 'npm test' })).toMatchObject({ status: 'success' });
  });
});
