import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CommandPolicy } from '../CommandPolicy';
import {
  WORKSPACE_TRUST_REQUIRED_TOOLS,
  MAY_MUTATE_WORKSPACE_TOOLS,
  WorkspaceTools,
  requiresTrustedWorkspace,
  type CommandExecutor,
} from '../WorkspaceTools';

describe('WorkspaceTools folder access write roots', () => {
  function toolsFor(
    root: string,
    readRoots: string[],
    writeRoots: string[],
    trusted = true,
    commandExecutor: CommandExecutor = async () => ({ code: 0, output: 'ok' }),
    requestApproval?: (command: string) => Promise<boolean>,
  ): WorkspaceTools {
    return new WorkspaceTools(
      root,
      new Set(['read', 'write', 'execute']),
      'agent',
      undefined,
      new CommandPolicy('all'),
      undefined,
      requestApproval,
      undefined,
      undefined,
      commandExecutor,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readRoots,
      trusted ? () => true : () => false,
      writeRoots
    );
  }

  it('allows writes in any configured write root and blocks outside them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-root-'));
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-other-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-out-'));
    const tools = new WorkspaceTools(
      root,
      new Set(['read', 'write']),
      'agent',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [root, other],
      undefined,
      [root, other]
    );

    expect(await tools.runText('write_file', { path: path.join(other, 'ok.txt'), content: 'ok' })).toContain('Wrote');
    expect(await fs.readFile(path.join(other, 'ok.txt'), 'utf8')).toBe('ok');
    expect(await tools.run('write_file', { path: path.join(outside, 'no.txt'), content: 'no' }))
      .toMatchObject({ status: 'refused', reason: 'workspace-escape' });

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('blocks write-root escapes via traversal, absolute paths, and symlink ancestors', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-escape-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-escape-out-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    const tools = toolsFor(root, [root], [root]);

    expect(await tools.runText('write_file', { path: path.join('..', path.basename(outside), 'no.txt'), content: 'no' }))
      .toContain('outside the configured working boundary');
    expect(await tools.runText('write_file', { path: path.join(outside, 'absolute.txt'), content: 'no' }))
      .toContain('outside the configured working boundary');

    const link = path.join(root, 'escape');
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      expect(await tools.runText('write_file', { path: path.join('escape', 'secret.txt'), content: 'no' }))
        .toContain('outside the configured working boundary');
      expect(await tools.runText('write_file', { path: path.join('escape', 'new', 'created.txt'), content: 'no' }))
        .toContain('outside the configured working boundary');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('sandboxes run_command to write roots only, never read-only roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-run-root-'));
    const readOnly = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-run-read-'));
    const tools = toolsFor(root, [root, readOnly], [root]);

    expect(await tools.runText('list_dir', { path: readOnly })).toContain('(empty)');
    expect(await tools.runText('run_command', { command: `node ${path.join(readOnly, 'script.js')}` }))
      .toContain('outside the assigned scope');
    expect(await tools.runText('run_command', { command: `node ${path.join(root, 'script.js')}` }))
      .toContain('[exit 0]');

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(readOnly, { recursive: true, force: true });
  });

  it('refuses every workspace-write surface at the shared trust boundary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-untrusted-'));
    const tools = toolsFor(root, [root], [root], false);

    for (const [name, args] of [
      ['write_file', { path: 'no.txt', content: 'no' }],
      ['apply_edit', { path: 'no.txt', old_string: 'a', new_string: 'b' }],
      ['apply_patch', { patch: '*** Begin Patch\n*** End Patch' }],
      ['delete_file', { path: 'no.txt' }],
      ['delete_dir', { path: 'no-dir' }],
    ] as const) {
      expect(await tools.runText(name, args), name).toMatch(new RegExp(`not trusted.*${name}|${name}.*disabled`, 'i'));
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps the closed trust vocabulary and its shared enforcement boundary in sync', () => {
    expect(WORKSPACE_TRUST_REQUIRED_TOOLS).toEqual([
      'write_file', 'apply_edit', 'apply_patch', 'delete_file', 'delete_dir', 'run_command',
    ]);
    expect(WORKSPACE_TRUST_REQUIRED_TOOLS.every(requiresTrustedWorkspace)).toBe(true);
    // Every tool that may mutate the workspace requires trust. Running a command is not a file write,
    // which is why the two vocabularies are separate names over the same membership rather than one.
    expect([...MAY_MUTATE_WORKSPACE_TOOLS].sort()).toEqual([...WORKSPACE_TRUST_REQUIRED_TOOLS].sort());
    expect(requiresTrustedWorkspace('run_command')).toBe(true);
    expect(requiresTrustedWorkspace('future_write_tool')).toBe(false);
  });

  // Not masked by the upstream rule: an untrusted workspace normally arrives with zero writable roots, so
  // run_command would meet 'no writable folders' and never reach the trust decision. This constructs the
  // case that rule cannot cover -- writable roots present, execute granted, workspace untrusted -- so the
  // assertion is about Workspace Trust itself and not about a neighbouring refusal.
  it('refuses run_command for the trust reason with write roots present, and never reaches the executor', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-shell-untrusted-'));
    let executed = 0;
    let approvalsAsked = 0;
    const tools = toolsFor(
      root, [root], [root], false,
      async () => { executed += 1; return { code: 0, output: 'ran' }; },
      async () => { approvalsAsked += 1; return true; },
    );

    const output = await tools.runText('run_command', { command: 'node -e "0"' });

    expect(output).toMatch(/not trusted/i);
    expect(output).toMatch(/workspace trust/i);
    // The wrong remedy before this fix: it told the agent to ask for a Read+Write folder.
    expect(output).not.toMatch(/writable folder/i);
    expect(executed).toBe(0);
    expect(approvalsAsked).toBe(0);

    await fs.rm(root, { recursive: true, force: true });
  });

  it('accepts only an exact host-declared workflow label and exposes no prose matcher', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-branch-'));
    const tools = toolsFor(root, [root], [root]);
    tools.beginTurn();
    tools.setWorkflowBranchLabels(['approved', 'needs-rework']);

    expect(await tools.runText('select_workflow_branch', { label: 'not approved' })).toMatch(/undeclared/i);
    expect(tools.takeWorkflowBranchLabel()).toBeUndefined();
    expect(await tools.runText('select_workflow_branch', { label: 'approved' })).toContain('approved');
    expect(tools.takeWorkflowBranchLabel()).toBe('approved');

    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses writes and shell commands when no write roots are configured', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-readonly-'));
    const tools = new WorkspaceTools(
      root,
      new Set(['read', 'write', 'execute']),
      'agent',
      undefined,
      new CommandPolicy('all'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [root],
      undefined,
      []
    );

    expect(await tools.run('write_file', { path: 'no.txt', content: 'no' })).toMatchObject({ status: 'refused', reason: 'capability' });
    expect(await tools.run('run_command', { command: 'echo hi' })).toMatchObject({ status: 'refused', reason: 'capability' });

    const noAccess = new WorkspaceTools(
      root,
      new Set(['read']),
      'agent',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      []
    );
    expect(await noAccess.run('read_file', { path: 'no.txt' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });

    await fs.rm(root, { recursive: true, force: true });
  });

  it('applies a read-only task scope for one turn and restores the configured roots afterward', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-task-scope-'));
    const tools = toolsFor(root, [root], [root]);

    tools.setTurnWorkspaceAccess({ pathBase: root, commandCwd: root, readRoots: [root], writeRoots: [] });
    expect(await tools.run('write_file', { path: 'blocked.txt', content: 'no' })).toMatchObject({ status: 'refused', reason: 'capability' });
    expect(await tools.run('run_command', { command: 'echo no' })).toMatchObject({ status: 'refused', reason: 'capability' });
    expect(await tools.runText('list_dir', { path: '.' })).toContain('(empty)');

    tools.setTurnWorkspaceAccess(undefined);
    expect(await tools.runText('write_file', { path: 'restored.txt', content: 'yes' })).toContain('Wrote');
    expect(await fs.readFile(path.join(root, 'restored.txt'), 'utf8')).toBe('yes');

    await fs.rm(root, { recursive: true, force: true });
  });

  it('distinguishes a recoverable task-scope refusal from an escape outside the configured workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-task-boundary-'));
    const granted = path.join(root, 'granted');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-task-boundary-out-'));
    await fs.mkdir(granted);
    const tools = toolsFor(root, [root], [root]);
    tools.setTurnWorkspaceAccess({ pathBase: root, commandCwd: root, readRoots: [granted], writeRoots: [] });

    const taskScope = await tools.run('list_dir', { path: '.' });
    expect(taskScope).toMatchObject({ status: 'refused', reason: 'task-scope' });
    expect(taskScope.output).toContain('inputs granted in the task card');
    expect(taskScope.output).not.toContain(root);
    expect(taskScope.output).not.toContain('User consent was not granted');

    await expect(tools.run('list_dir', { path: outside })).resolves.toMatchObject({ status: 'refused', reason: 'workspace-escape' });

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('re-derives an out-of-scope commandCwd before it reaches the command runner', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-cwd-root-'));
    const scoped = path.join(root, 'research');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-cwd-out-'));
    await fs.mkdir(scoped);
    let runnerCwd = '';
    const tools = toolsFor(root, [root], [root], true, async (_command, opts) => {
      runnerCwd = opts.cwd;
      return { code: 0, output: 'ok' };
    });

    tools.setTurnWorkspaceAccess({
      pathBase: root,
      commandCwd: outside,
      readRoots: [scoped],
      writeRoots: [scoped],
    });

    expect(await tools.runText('run_command', { command: 'echo contained' })).toContain('[exit 0]');
    expect(runnerCwd).toBe(path.resolve(scoped));

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('resolves scoped model paths once from pathBase on coordinator and delegated read/write paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-scope-base-'));
    const research = path.join(root, 'research');
    await fs.mkdir(path.join(research, 'research'), { recursive: true });
    await fs.writeFile(path.join(research, 'article.md'), 'RIGHT FILE', 'utf8');
    await fs.writeFile(path.join(research, 'research', 'article.md'), 'WRONG DUPLICATED FILE', 'utf8');
    await fs.writeFile(path.join(root, 'root-note.md'), 'WORKSPACE ROOT INPUT', 'utf8');

    const rootScoped = toolsFor(root, [root], [root]);
    expect(rootScoped.setContractTaskScope({ folderAccess: [{ path: '.', permission: 'read' }] })).toBe(true);
    expect(await rootScoped.runText('read_file', { path: 'root-note.md' })).toContain('WORKSPACE ROOT INPUT');

    let coordinatorCwd = '';
    const coordinator = toolsFor(root, [root], [root], true, async (_command, opts) => {
      coordinatorCwd = opts.cwd;
      return { code: 0, output: 'ok' };
    });
    expect(coordinator.setContractTaskScope({ folderAccess: [{ path: 'research', permission: 'readwrite' }] })).toBe(true);
    expect(await coordinator.runText('read_file', { path: 'research/article.md' })).toContain('RIGHT FILE');
    expect(await coordinator.runText('read_file', { path: 'research/article.md' })).not.toContain('WRONG DUPLICATED FILE');
    expect(await coordinator.runText('write_file', { path: 'research/coordinator.md', content: 'coordinator' })).toContain('Wrote');
    expect(await coordinator.runText('run_command', { command: 'echo scoped' })).toContain('[exit 0]');
    expect(coordinatorCwd).toBe(path.resolve(research));
    expect(await fs.readFile(path.join(research, 'coordinator.md'), 'utf8')).toBe('coordinator');
    await expect(fs.stat(path.join(research, 'research', 'coordinator.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    let delegatedCwd = '';
    const delegated = toolsFor(root, [root], [root], true, async (_command, opts) => {
      delegatedCwd = opts.cwd;
      return { code: 0, output: 'ok' };
    });
    delegated.setTurnWorkspaceAccess({
      pathBase: root,
      commandCwd: research,
      readRoots: [research],
      writeRoots: [research],
    });
    expect(await delegated.runText('read_file', { path: 'research/article.md' })).toContain('RIGHT FILE');
    expect(await delegated.runText('write_file', { path: 'research/worker.md', content: 'worker' })).toContain('Wrote');
    expect(await delegated.runText('run_command', { command: 'echo scoped' })).toContain('[exit 0]');
    expect(delegatedCwd).toBe(path.resolve(research));
    expect(await fs.readFile(path.join(research, 'worker.md'), 'utf8')).toBe('worker');
    await expect(fs.stat(path.join(research, 'research', 'worker.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses a contract read scope outside configured roots without granting access', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-contract-read-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-contract-read-outside-'));
    const privateFile = path.join(outside, 'private.md');
    await fs.writeFile(privateFile, 'OUTSIDE CONTRACT INPUT', 'utf8');
    const tools = toolsFor(root, [root], [root]);

    try {
      expect(tools.setContractTaskScope({ folderAccess: [{ path: outside, permission: 'read' }] })).toBe(false);
      await expect(tools.run('read_file', { path: privateFile }))
        .resolves.toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a contract readwrite scope for an additional read root without granting writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-contract-write-root-'));
    const readOnly = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-contract-write-readonly-'));
    const readableFile = path.join(readOnly, 'readable.md');
    const blockedFile = path.join(readOnly, 'blocked.md');
    await fs.writeFile(readableFile, 'CONFIGURED READ ROOT', 'utf8');
    const tools = toolsFor(root, [root, readOnly], [root]);

    try {
      // This root reaches the read guard, so a rejection below specifically proves the write-root guard.
      expect(await tools.runText('read_file', { path: readableFile })).toContain('CONFIGURED READ ROOT');
      expect(tools.setContractTaskScope({ folderAccess: [{ path: readOnly, permission: 'readwrite' }] })).toBe(false);
      await expect(tools.run('write_file', { path: blockedFile, content: 'must stay blocked' }))
        .resolves.toMatchObject({ status: 'refused', reason: 'workspace-escape' });
      await expect(fs.stat(blockedFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(readOnly, { recursive: true, force: true });
    }
  });

  it('keeps one workspace-relative meaning when a task scope names parallel roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-scope-parallel-'));
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await fs.mkdir(first);
    await fs.mkdir(path.join(second, 'second'), { recursive: true });
    await fs.writeFile(path.join(second, 'target.md'), 'SECOND ROOT TARGET', 'utf8');
    await fs.writeFile(path.join(second, 'second', 'target.md'), 'WRONG SECOND-ROOT PROJECTION', 'utf8');
    const tools = toolsFor(root, [root], [root]);

    tools.setTurnWorkspaceAccess({
      pathBase: root,
      commandCwd: first,
      readRoots: [first, second],
      writeRoots: [first, second],
    });

    const result = await tools.runText('read_file', { path: 'second/target.md' });
    expect(result).toContain('SECOND ROOT TARGET');
    expect(result).not.toContain('WRONG SECOND-ROOT PROJECTION');
    await fs.rm(root, { recursive: true, force: true });
  });
});
