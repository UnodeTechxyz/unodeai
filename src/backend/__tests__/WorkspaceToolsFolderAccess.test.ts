import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CommandPolicy } from '../CommandPolicy';
import { OptimisticFileCoordinator } from '../FileCoordinator';
import { intersectTaskWorkspaceAccess, resolveEffectiveRoots, writeRootsForTrust } from '../folderAccess';
import type { FolderGrant } from '../../types';
import {
  WORKSPACE_TRUST_REQUIRED_TOOLS,
  MAY_MUTATE_WORKSPACE_TOOLS,
  WorkspaceTools,
  requiresTrustedWorkspace,
} from '../WorkspaceTools';
import { asProvider, type LegacyRun } from './shellFixtures';

describe('WorkspaceTools folder access write roots', () => {
  function toolsFor(
    root: string,
    readRoots: string[],
    writeRoots: string[],
    trusted = true,
    commandExecutor: LegacyRun = async () => ({ code: 0, output: 'ok' }),
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
      asProvider(commandExecutor),
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
      ['save_attachment', { asset_id: 'content-1', path: 'no.png' }],
    ] as const) {
      expect(await tools.runText(name, args), name).toMatch(new RegExp(`not trusted.*${name}|${name}.*disabled`, 'i'));
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps the closed trust vocabulary and its shared enforcement boundary in sync', () => {
    expect(WORKSPACE_TRUST_REQUIRED_TOOLS).toEqual([
      'write_file', 'apply_edit', 'apply_patch', 'delete_file', 'delete_dir', 'run_command',
      'save_attachment',
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

  it('starts a command in the directory as a terminal spells it, whatever drive-letter case the editor gave', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-drive-'));
    // The editor reports a Windows workspace folder with a lower-case drive letter. Elsewhere a path has none.
    const asTheEditorGivesIt = process.platform === 'win32' ? root[0].toLowerCase() + root.slice(1) : root;
    let runnerCwd = '';
    const tools = toolsFor(asTheEditorGivesIt, [asTheEditorGivesIt], [asTheEditorGivesIt], true, async (_command, opts) => {
      runnerCwd = opts.cwd;
      return { code: 0, output: 'ok' };
    });

    expect(await tools.runText('run_command', { command: 'echo here' })).toContain('[exit 0]');
    expect(runnerCwd).toBe(path.resolve(root));
    expect(runnerCwd.slice(0, 1)).toBe(root.slice(0, 1));

    await fs.rm(root, { recursive: true, force: true });
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

  it('narrows a contract readwrite scope for an additional read root to read-only without granting writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-contract-write-root-'));
    const readOnly = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-contract-write-readonly-'));
    const readableFile = path.join(readOnly, 'readable.md');
    const blockedFile = path.join(readOnly, 'blocked.md');
    await fs.writeFile(readableFile, 'CONFIGURED READ ROOT', 'utf8');
    const tools = toolsFor(root, [root, readOnly], [root]);

    try {
      // The scope is intersected as a delegated task scope is: what the configured authority can only read
      // stays readable, and the readwrite the contract declared adds no write authority to it.
      expect(tools.setContractTaskScope({ folderAccess: [{ path: readOnly, permission: 'readwrite' }] })).toBe(true);
      expect(await tools.runText('read_file', { path: readableFile })).toContain('CONFIGURED READ ROOT');
      await expect(tools.run('write_file', { path: blockedFile, content: 'must stay blocked' }))
        .resolves.toMatchObject({ status: 'refused' });
      await expect(tools.run('write_file', { path: readableFile, content: 'must stay unchanged' }))
        .resolves.toMatchObject({ status: 'refused' });
      expect(tools.specs().map((spec) => spec.function.name)).not.toContain('write_file');
      await expect(fs.stat(blockedFile)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(readableFile, 'utf8')).toBe('CONFIGURED READ ROOT');
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

// A scope entry may name one existing file. It is compiled once into an exact-file grant and enforced as that
// file alone. Each case runs on the route a delegated worker takes and on the route a coordinator takes for
// its own contract; both go through the same compiler and the same intersection.
describe('WorkspaceTools exact-file grants', { timeout: 20_000 }, () => {
  interface Ceiling {
    grants?: FolderGrant[];
    trusted?: boolean;
  }

  /**
   * Tools built as the host builds them from an agent's configured Folder Access (absent = the whole root): the
   * working directory is the resolved primary root, and exact files travel apart from the directory roots.
   */
  function configuredTools(
    root: string,
    ceiling: Ceiling = {},
    commandExecutor: LegacyRun = async () => ({ code: 0, output: 'ok' }),
    editDialect: 'apply-edit' | 'apply-patch' = 'apply-edit',
  ): { tools: WorkspaceTools; configured: ReturnType<typeof resolveEffectiveRoots> } {
    const trusted = ceiling.trusted ?? true;
    const configured = resolveEffectiveRoots({
      grants: ceiling.grants,
      fallbackPrimaryRoot: root,
      fallbackReadRoots: [],
      workspaceRoots: [root],
      isTrusted: trusted,
    });
    const tools = new WorkspaceTools(
      configured.primaryRoot,
      new Set(['read', 'write', 'execute']),
      'agent',
      new OptimisticFileCoordinator(),
      new CommandPolicy('all'),
      undefined,
      undefined,
      undefined,
      undefined,
      asProvider(commandExecutor),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configured.readRoots,
      () => trusted,
      writeRootsForTrust(configured.writeRoots, trusted),
      undefined,
      undefined,
      editDialect,
      undefined,
      undefined,
      { read: configured.readFiles, write: trusted ? configured.writeFiles : [] },
    );
    return { tools, configured };
  }

  /** Scope the tools on one route. Returns false when the scope shares nothing readable with the ceiling. */
  function applyScope(
    route: 'delegated' | 'coordinator',
    root: string,
    fixture: ReturnType<typeof configuredTools>,
    scope: FolderGrant[],
    trusted = true,
  ): boolean {
    if (route === 'coordinator') {
      return fixture.tools.setContractTaskScope({ folderAccess: scope });
    }
    const requested = resolveEffectiveRoots({
      grants: scope,
      fallbackPrimaryRoot: root,
      fallbackReadRoots: [],
      workspaceRoots: [root],
      isTrusted: trusted,
    });
    expect(requested.issues).toEqual([]);
    const access = intersectTaskWorkspaceAccess(fixture.configured, requested, trusted, root);
    if (!access) return false;
    fixture.tools.setTurnWorkspaceAccess(access);
    return true;
  }

  const ROUTES = ['delegated', 'coordinator'] as const;

  async function workspace(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-file-grant-'));
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs', 'notes.md'), 'first line\n', 'utf8');
    await fs.writeFile(path.join(root, 'docs', 'sibling.md'), 'SIBLING\n', 'utf8');
    return root;
  }

  it.each(ROUTES)('lets a readwrite file grant read, edit, overwrite and delete that file (%s route)', async (route) => {
    const root = await workspace();
    const notes = path.join(root, 'docs', 'notes.md');
    const fixture = configuredTools(root);
    const { tools } = fixture;

    try {
      expect(applyScope(route, root, fixture, [{ path: 'docs/notes.md', permission: 'readwrite' }])).toBe(true);

      expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toBe('first line\n');
      expect(await tools.run('apply_edit', { path: 'docs/notes.md', old_string: 'first', new_string: 'second' }))
        .toMatchObject({ status: 'success' });
      expect(await fs.readFile(notes, 'utf8')).toBe('second line\n');
      expect(await tools.run('write_file', { path: 'docs/notes.md', content: 'third line\n' }))
        .toMatchObject({ status: 'success' });
      expect(await fs.readFile(notes, 'utf8')).toBe('third line\n');
      expect(await tools.run('delete_file', { path: 'docs/notes.md' })).toMatchObject({ status: 'success' });
      await expect(fs.stat(notes)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('writes a deleted granted file again at its own path, and nowhere else (%s route)', async (route) => {
    const root = await workspace();
    const notes = path.join(root, 'docs', 'notes.md');
    const fixture = configuredTools(root);
    const { tools } = fixture;

    try {
      expect(applyScope(route, root, fixture, [{ path: 'docs/notes.md', permission: 'readwrite' }])).toBe(true);
      expect(await tools.run('delete_file', { path: 'docs/notes.md' })).toMatchObject({ status: 'success' });
      // Gone is not refused: the grant still names the path, there is only nothing at it.
      expect(await tools.run('read_file', { path: 'docs/notes.md' }))
        .toMatchObject({ status: 'failed', failureKind: 'not_found' });

      expect(await tools.run('write_file', { path: 'docs/notes.md', content: 'written again\n' }))
        .toMatchObject({ status: 'success' });
      expect(await fs.readFile(notes, 'utf8')).toBe('written again\n');
      expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toBe('written again\n');
      expect(await tools.run('write_file', { path: 'docs/notes-2.md', content: 'no' })).toMatchObject({ status: 'refused' });
      expect((await fs.readdir(path.join(root, 'docs'))).sort()).toEqual(['notes.md', 'sibling.md']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('keeps the read-before-write check for a granted file (%s route)', async (route) => {
    const root = await workspace();
    const fixture = configuredTools(root);
    const { tools } = fixture;

    try {
      expect(applyScope(route, root, fixture, [{ path: 'docs/notes.md', permission: 'readwrite' }])).toBe(true);
      const unread = await tools.run('write_file', { path: 'docs/notes.md', content: 'blind\n' });
      expect(unread).toMatchObject({ status: 'failed' });
      expect(unread.output).toContain('You have not read');
      expect(await fs.readFile(path.join(root, 'docs', 'notes.md'), 'utf8')).toBe('first line\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('refuses a sibling write, a sibling create, a listing, a directory delete and a command under a file grant (%s route)', async (route) => {
    const root = await workspace();
    let executed = 0;
    const fixture = configuredTools(root, {}, async () => { executed += 1; return { code: 0, output: 'ran' }; });
    const { tools } = fixture;
    const sibling = path.join(root, 'docs', 'sibling.md');

    try {
      expect(applyScope(route, root, fixture, [{ path: 'docs/notes.md', permission: 'readwrite' }])).toBe(true);

      for (const [name, args] of [
        ['write_file', { path: 'docs/sibling.md', content: 'overwritten' }],
        ['apply_edit', { path: 'docs/sibling.md', old_string: 'SIBLING', new_string: 'edited' }],
        ['delete_file', { path: 'docs/sibling.md' }],
        ['read_file', { path: 'docs/sibling.md' }],
        ['write_file', { path: 'docs/created.md', content: 'new' }],
        ['write_file', { path: 'docs/notes.md/child.md', content: 'new' }],
        ['write_file', { path: 'created-at-root.md', content: 'new' }],
        ['list_dir', { path: 'docs' }],
        ['list_dir', { path: '.' }],
        ['list_dir', { path: 'docs/notes.md' }],
        ['search_files', { query: 'SIBLING', path: 'docs' }],
      ] as const) {
        expect(await tools.run(name, args), `${name} ${args.path}`).toMatchObject({ status: 'refused', reason: 'task-scope' });
      }
      // A file grant gives no folder to delete in: neither the file's folder nor the file itself is a directory to remove.
      expect(await tools.run('delete_dir', { path: 'docs' })).toMatchObject({ status: 'refused' });
      expect(await tools.run('delete_dir', { path: 'docs/notes.md' })).toMatchObject({ status: 'refused' });
      // A search walks folders. With none granted it opens no file, the sibling included, and says so.
      const search = await tools.runText('search_files', { query: 'SIBLING' });
      expect(search).toContain('(0 files)');
      expect(search).not.toContain('sibling.md');

      for (const background of [false, true]) {
        const command = await tools.run('run_command', { command: 'echo hi', background });
        expect(command).toMatchObject({ status: 'refused', reason: 'task-scope' });
        expect(command.output).toContain('no writable folder');
        expect(command.output).toContain('ask the coordinator');
      }
      expect(executed).toBe(0);
      const offered = tools.specs().map((spec) => spec.function.name);
      expect(offered).toEqual(expect.arrayContaining(['read_file', 'write_file', 'apply_edit', 'delete_file']));
      expect(offered).not.toContain('run_command');
      expect(offered).not.toContain('check_command');
      expect(offered).not.toContain('kill_command');

      expect(await fs.readFile(sibling, 'utf8')).toBe('SIBLING\n');
      expect((await fs.readdir(root)).sort()).toEqual(['docs']);
      expect((await fs.readdir(path.join(root, 'docs'))).sort()).toEqual(['notes.md', 'sibling.md']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('lets a read-only file grant read that file and change nothing (%s route)', async (route) => {
    const root = await workspace();
    let executed = 0;
    const fixture = configuredTools(root, {}, async () => { executed += 1; return { code: 0, output: 'ran' }; });
    const { tools } = fixture;

    try {
      expect(applyScope(route, root, fixture, [{ path: 'docs/notes.md', permission: 'read' }])).toBe(true);

      const read = await tools.runText('read_file', { path: 'docs/notes.md' });
      expect(read).toContain('first line');
      // The note names no working folder: this scope has none, and the path base is not offered as one.
      expect(read).toContain('[read-only in your tree - from an exact-file grant.');
      expect(read).not.toContain(root);
      for (const [name, args] of [
        ['write_file', { path: 'docs/notes.md', content: 'changed' }],
        ['apply_edit', { path: 'docs/notes.md', old_string: 'first', new_string: 'changed' }],
        ['delete_file', { path: 'docs/notes.md' }],
        ['delete_dir', { path: 'docs' }],
      ] as const) {
        expect(await tools.run(name, args), name).toMatchObject({ status: 'refused' });
      }
      expect(await tools.run('read_file', { path: 'docs/sibling.md' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.run('run_command', { command: 'echo hi' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(executed).toBe(0);
      const offered = tools.specs().map((spec) => spec.function.name);
      expect(offered).toContain('read_file');
      for (const name of ['write_file', 'apply_edit', 'delete_file', 'delete_dir', 'run_command']) {
        expect(offered, name).not.toContain(name);
      }
      expect(await fs.readFile(path.join(root, 'docs', 'notes.md'), 'utf8')).toBe('first line\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('keeps create, read, write, delete and command behaviour for a directory inside a directory (%s route)', async (route) => {
    const root = await workspace();
    let runnerCwd = '';
    const fixture = configuredTools(root, {}, async (_command, opts) => { runnerCwd = opts.cwd; return { code: 0, output: 'ok' }; });
    const { tools } = fixture;
    const docs = path.join(root, 'docs');

    try {
      expect(applyScope(route, root, fixture, [{ path: 'docs', permission: 'readwrite' }])).toBe(true);

      expect(await tools.run('write_file', { path: 'docs/created.md', content: 'created\n' })).toMatchObject({ status: 'success' });
      expect(await tools.run('write_file', { path: 'docs/deep/er/created.md', content: 'nested\n' })).toMatchObject({ status: 'success' });
      expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toBe('first line\n');
      expect(await tools.run('write_file', { path: 'docs/notes.md', content: 'rewritten\n' })).toMatchObject({ status: 'success' });
      expect(await tools.run('delete_file', { path: 'docs/sibling.md' })).toMatchObject({ status: 'success' });
      expect(await tools.runText('list_dir', { path: 'docs' })).toContain('created.md');
      expect(await tools.run('delete_dir', { path: 'docs/deep' })).toMatchObject({ status: 'success' });
      expect(await tools.run('write_file', { path: 'outside-the-scope.md', content: 'no' }))
        .toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.runText('run_command', { command: 'echo scoped' })).toContain('[exit 0]');
      expect(runnerCwd).toBe(path.resolve(docs));
      expect(tools.specs().map((spec) => spec.function.name)).toEqual(expect.arrayContaining(['run_command', 'check_command', 'kill_command']));
      expect((await fs.readdir(docs)).sort()).toEqual(['created.md', 'notes.md']);
      expect(await fs.readdir(root)).toEqual(['docs']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('narrows a directory request over a configured exact file to that file (%s route)', async (route) => {
    const root = await workspace();
    let executed = 0;
    const fixture = configuredTools(
      root,
      { grants: [{ path: 'docs/notes.md', permission: 'readwrite' }] },
      async () => { executed += 1; return { code: 0, output: 'ran' }; },
    );
    const { tools } = fixture;

    try {
      expect(applyScope(route, root, fixture, [{ path: 'docs', permission: 'readwrite' }])).toBe(true);

      expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toBe('first line\n');
      expect(await tools.run('write_file', { path: 'docs/notes.md', content: 'still exact\n' })).toMatchObject({ status: 'success' });
      // The requested directory does not come with the file: nothing else in it is readable, listable or writable.
      for (const [name, args] of [
        ['read_file', { path: 'docs/sibling.md' }],
        ['write_file', { path: 'docs/sibling.md', content: 'no' }],
        ['write_file', { path: 'docs/created.md', content: 'no' }],
        ['list_dir', { path: 'docs' }],
        ['delete_dir', { path: 'docs' }],
        ['run_command', { command: 'echo hi' }],
      ] as const) {
        expect(await tools.run(name, args), name).toMatchObject({ status: 'refused' });
      }
      expect(executed).toBe(0);
      expect(tools.specs().map((spec) => spec.function.name)).not.toContain('run_command');
      expect(await fs.readFile(path.join(root, 'docs', 'sibling.md'), 'utf8')).toBe('SIBLING\n');
      expect((await fs.readdir(path.join(root, 'docs'))).sort()).toEqual(['notes.md', 'sibling.md']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('keeps the same exact file when both sides name it, at the narrower permission (%s route)', async (route) => {
    const root = await workspace();
    const notes = path.join(root, 'docs', 'notes.md');

    try {
      const both = configuredTools(root, { grants: [{ path: 'docs/notes.md', permission: 'readwrite' }] });
      expect(applyScope(route, root, both, [{ path: 'docs/notes.md', permission: 'readwrite' }])).toBe(true);
      expect(await both.tools.runText('read_file', { path: 'docs/notes.md' })).toBe('first line\n');
      expect(await both.tools.run('write_file', { path: 'docs/notes.md', content: 'both write\n' })).toMatchObject({ status: 'success' });
      expect(await both.tools.run('write_file', { path: 'docs/sibling.md', content: 'no' })).toMatchObject({ status: 'refused' });

      // The request asks for more than the ceiling holds: the ceiling's read-only wins.
      const readCeiling = configuredTools(root, { grants: [{ path: 'docs/notes.md', permission: 'read' }] });
      expect(applyScope(route, root, readCeiling, [{ path: 'docs/notes.md', permission: 'readwrite' }])).toBe(true);
      expect(await readCeiling.tools.runText('read_file', { path: 'docs/notes.md' })).toContain('both write');
      expect(await readCeiling.tools.run('write_file', { path: 'docs/notes.md', content: 'no' })).toMatchObject({ status: 'refused' });

      // The request asks for less than the ceiling holds: the request's read-only wins.
      const readRequest = configuredTools(root, { grants: [{ path: 'docs/notes.md', permission: 'readwrite' }] });
      expect(applyScope(route, root, readRequest, [{ path: 'docs/notes.md', permission: 'read' }])).toBe(true);
      expect(await readRequest.tools.runText('read_file', { path: 'docs/notes.md' })).toContain('both write');
      expect(await readRequest.tools.run('write_file', { path: 'docs/notes.md', content: 'no' })).toMatchObject({ status: 'refused' });
      expect(await fs.readFile(notes, 'utf8')).toBe('both write\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('leaves a requested writable file read-only under a configured read-only directory (%s route)', async (route) => {
    const root = await workspace();
    const notes = path.join(root, 'docs', 'notes.md');
    const fixture = configuredTools(root, { grants: [{ path: 'docs', permission: 'read' }] });
    const { tools } = fixture;

    try {
      expect(applyScope(route, root, fixture, [{ path: notes, permission: 'readwrite' }])).toBe(true);

      expect(await tools.runText('read_file', { path: notes })).toContain('first line');
      expect(await tools.run('read_file', { path: path.join(root, 'docs', 'sibling.md') })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.run('write_file', { path: notes, content: 'no' })).toMatchObject({ status: 'refused' });
      expect(tools.specs().map((spec) => spec.function.name)).not.toContain('write_file');
      expect(await fs.readFile(notes, 'utf8')).toBe('first line\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('shares nothing between a configured exact file and another file or directory (%s route)', async (route) => {
    const root = await workspace();
    await fs.mkdir(path.join(root, 'other'));
    await fs.writeFile(path.join(root, 'other', 'elsewhere.md'), 'ELSEWHERE\n', 'utf8');

    try {
      for (const scope of [
        [{ path: 'docs/sibling.md', permission: 'readwrite' }],
        [{ path: 'other', permission: 'readwrite' }],
        [{ path: 'other/elsewhere.md', permission: 'read' }],
      ] satisfies FolderGrant[][]) {
        const fixture = configuredTools(root, { grants: [{ path: 'docs/notes.md', permission: 'readwrite' }] });
        expect(applyScope(route, root, fixture, scope), scope[0].path).toBe(false);
        // The refused scope granted nothing: only the configured file is reachable, as before it.
        expect(await fixture.tools.run('read_file', { path: scope[0].path === 'other' ? 'other/elsewhere.md' : scope[0].path }))
          .toMatchObject({ status: 'refused' });
      }
      expect(await fs.readFile(path.join(root, 'docs', 'sibling.md'), 'utf8')).toBe('SIBLING\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('keeps a writable file writable inside a directory the scope can only read (%s route)', async (route) => {
    const root = await workspace();
    const fixture = configuredTools(root);
    const { tools } = fixture;

    try {
      expect(applyScope(route, root, fixture, [
        { path: 'docs', permission: 'read' },
        { path: 'docs/notes.md', permission: 'readwrite' },
      ])).toBe(true);

      // The directory makes its files readable; only the named one is writable, and it is read as a writable file.
      expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toBe('first line\n');
      // No writable directory, so the read-only note names no command working folder: not the path base either.
      expect(await tools.runText('read_file', { path: 'docs/sibling.md' }))
        .toBe('SIBLING\n\n[read-only in your tree - from an additional read root. Your writes, edits and deletes do not change it.]');
      expect(await tools.runText('list_dir', { path: 'docs' })).toContain('sibling.md');
      expect(await tools.run('write_file', { path: 'docs/notes.md', content: 'written\n' })).toMatchObject({ status: 'success' });
      expect(await tools.run('write_file', { path: 'docs/sibling.md', content: 'no' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.run('write_file', { path: 'docs/created.md', content: 'no' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.run('run_command', { command: 'echo hi' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect((await fs.readdir(path.join(root, 'docs'))).sort()).toEqual(['notes.md', 'sibling.md']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('runs a command in a writable directory of the scope, never in a granted file or the path base (%s route)', async (route) => {
    const root = await workspace();
    await fs.mkdir(path.join(root, 'out'));
    let runnerCwd = '';
    const fixture = configuredTools(root, {}, async (_command, opts) => { runnerCwd = opts.cwd; return { code: 0, output: 'ok' }; });
    const { tools } = fixture;

    try {
      // The file comes first in the scope and is the first writable entry; it is still not where a command runs.
      expect(applyScope(route, root, fixture, [
        { path: 'docs/notes.md', permission: 'readwrite' },
        { path: 'out', permission: 'readwrite' },
        { path: 'docs/sibling.md', permission: 'read' },
      ])).toBe(true);

      expect(await tools.runText('run_command', { command: 'echo scoped' })).toContain('[exit 0]');
      expect(runnerCwd).toBe(path.resolve(root, 'out'));
      expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toBe('first line\n');
      // A read-only exact file is described as a file. It is no read root set against the working folder.
      expect(await tools.runText('read_file', { path: 'docs/sibling.md' }))
        .toBe('SIBLING\n\n[read-only in your tree - from an exact-file grant. Your writes, edits and deletes do not change it.]');
      expect(await tools.run('write_file', { path: 'docs/notes.md', content: 'beside a directory\n' })).toMatchObject({ status: 'success' });
      expect(await tools.run('write_file', { path: 'docs/sibling.md', content: 'no' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('removes write authority from a file grant in an untrusted workspace (%s route)', async (route) => {
    const root = await workspace();
    const fixture = configuredTools(root, { trusted: false });
    const { tools } = fixture;

    try {
      expect(applyScope(route, root, fixture, [{ path: 'docs/notes.md', permission: 'readwrite' }], false)).toBe(true);

      expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toContain('first line');
      const offered = tools.specs().map((spec) => spec.function.name);
      for (const name of ['write_file', 'apply_edit', 'delete_file', 'run_command']) {
        expect(offered, name).not.toContain(name);
      }
      for (const [name, args] of [
        ['write_file', { path: 'docs/notes.md', content: 'no' }],
        ['apply_edit', { path: 'docs/notes.md', old_string: 'first', new_string: 'no' }],
        ['delete_file', { path: 'docs/notes.md' }],
      ] as const) {
        expect(await tools.run(name, args), name).toMatchObject({ status: 'refused', reason: 'trust' });
      }
      expect(await fs.readFile(path.join(root, 'docs', 'notes.md'), 'utf8')).toBe('first line\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // The configured write root is still present here, as it is when Workspace Trust is withdrawn after the agent
  // started. The scope must lose its write authority at the intersection, and not only at the dispatch boundary.
  it('strips a coordinator scope of write authority when trust is withdrawn under configured write roots', async () => {
    const root = await workspace();
    const tools = new WorkspaceTools(
      root, new Set(['read', 'write', 'execute']), 'agent', undefined, new CommandPolicy('all'),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      [root], () => false, [root],
    );

    try {
      for (const scopePath of ['docs/notes.md', 'docs']) {
        expect(tools.setContractTaskScope({ folderAccess: [{ path: scopePath, permission: 'readwrite' }] })).toBe(true);
        const offered = tools.specs().map((spec) => spec.function.name);
        expect(offered, scopePath).toContain('read_file');
        for (const name of ['write_file', 'apply_edit', 'delete_file', 'delete_dir', 'run_command']) {
          expect(offered, `${scopePath}: ${name}`).not.toContain(name);
        }
        expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toContain('first line');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('serves a configured exact file outside any task scope, and restores it after one', async () => {
    const root = await workspace();
    let executed = 0;
    const fixture = configuredTools(
      root,
      { grants: [{ path: 'docs/notes.md', permission: 'readwrite' }, { path: 'docs/sibling.md', permission: 'read' }] },
      async () => { executed += 1; return { code: 0, output: 'ran' }; },
    );
    const { tools, configured } = fixture;

    try {
      // No folder is granted, so the working directory stays the agent's own and neither file becomes a root.
      expect(configured.primaryRoot).toBe(path.resolve(root));
      expect(configured.readRoots).toEqual([]);
      expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toBe('first line\n');
      expect(await tools.run('write_file', { path: 'docs/notes.md', content: 'configured write\n' })).toMatchObject({ status: 'success' });
      expect(await tools.runText('read_file', { path: 'docs/sibling.md' })).toContain('SIBLING');
      expect(await tools.run('write_file', { path: 'docs/sibling.md', content: 'no' })).toMatchObject({ status: 'refused' });
      expect(await tools.run('write_file', { path: 'docs/created.md', content: 'no' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
      expect(await tools.run('list_dir', { path: 'docs' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
      expect(await tools.run('run_command', { command: 'echo hi' })).toMatchObject({ status: 'refused' });
      expect(executed).toBe(0);

      // A task scope that leaves the writable file out puts it outside the task, not outside the workspace.
      expect(applyScope('delegated', root, fixture, [{ path: 'docs/sibling.md', permission: 'read' }])).toBe(true);
      expect(await tools.run('read_file', { path: 'docs/notes.md' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.run('write_file', { path: 'docs/notes.md', content: 'no' })).toMatchObject({ status: 'refused' });
      expect(await tools.runText('read_file', { path: 'docs/sibling.md' })).toContain('SIBLING');

      tools.setTurnWorkspaceAccess(undefined);
      expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toBe('configured write\n');
      expect(await tools.run('write_file', { path: 'docs/notes.md', content: 'restored\n' })).toMatchObject({ status: 'success' });
      expect(await fs.readFile(path.join(root, 'docs', 'sibling.md'), 'utf8')).toBe('SIBLING\n');
      expect((await fs.readdir(path.join(root, 'docs'))).sort()).toEqual(['notes.md', 'sibling.md']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('classifies a configured writable file left out of a task scope as a task-scope refusal on a write', async () => {
    const root = await workspace();
    const src = path.join(root, 'src');
    const notes = path.join(root, 'docs', 'notes.md');
    await fs.mkdir(src);
    const fixture = configuredTools(root, { grants: [
      { path: 'src', permission: 'readwrite' },
      { path: 'docs/notes.md', permission: 'readwrite' },
    ] });
    const { tools, configured } = fixture;

    try {
      // The folder is the working directory; the file beside it is reached by its own path.
      expect(configured.primaryRoot).toBe(path.resolve(src));
      expect(await tools.runText('read_file', { path: notes })).toBe('first line\n');
      expect(applyScope('coordinator', root, fixture, [{ path: src, permission: 'readwrite' }])).toBe(true);
      expect(await tools.run('write_file', { path: notes, content: 'no' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.run('read_file', { path: notes })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      // What the agent was never configured to touch stays an escape from the workspace.
      expect(await tools.run('write_file', { path: path.join(root, 'docs', 'sibling.md'), content: 'no' }))
        .toMatchObject({ status: 'refused', reason: 'workspace-escape' });
      expect(await fs.readFile(notes, 'utf8')).toBe('first line\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('gives a scope without a writable directory no command working directory, whatever the caller supplies', async () => {
    const root = await workspace();
    await fs.mkdir(path.join(root, 'out'));
    const cwds: string[] = [];
    const fixture = configuredTools(root, {}, async (_command, opts) => { cwds.push(opts.cwd); return { code: 0, output: 'ok' }; });
    const { tools } = fixture;
    const [grant] = resolveEffectiveRoots({
      grants: [{ path: 'docs/notes.md', permission: 'readwrite' }],
      fallbackPrimaryRoot: root, fallbackReadRoots: [], workspaceRoots: [root], isTrusted: true,
    }).writeFiles;

    try {
      // A caller that still names the path base, or the file itself, as the command directory gets neither.
      for (const commandCwd of [root, grant.lexicalPath, undefined]) {
        tools.setTurnWorkspaceAccess({ pathBase: root, commandCwd, readRoots: [], writeRoots: [], readFiles: [grant], writeFiles: [grant] });
        expect(await tools.run('run_command', { command: 'echo hi' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
        expect(tools.specs().map((spec) => spec.function.name)).not.toContain('run_command');
        // The last boundary before a spawn has no directory to hand out, whatever let a command reach it.
        expect(() => (tools as unknown as { commandCwd: string }).commandCwd).toThrow(/not available in this task scope/);
      }
      // A file listed as writable alone is still an exact-file scope.
      tools.setTurnWorkspaceAccess({ pathBase: root, readRoots: [], writeRoots: [], writeFiles: [grant] });
      expect(await tools.run('run_command', { command: 'echo hi' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toBe('first line\n');
      expect(cwds).toEqual([]);

      // With a writable directory the command runs there, even when the caller named the file as its directory.
      const out = path.join(root, 'out');
      tools.setTurnWorkspaceAccess({ pathBase: root, commandCwd: grant.lexicalPath, readRoots: [out], writeRoots: [out], readFiles: [grant], writeFiles: [grant] });
      expect(await tools.runText('run_command', { command: 'echo here' })).toContain('[exit 0]');
      tools.setTurnWorkspaceAccess({ pathBase: root, readRoots: [out], writeRoots: [out] });
      expect(await tools.runText('run_command', { command: 'echo here' })).toContain('[exit 0]');
      expect(cwds).toEqual([path.resolve(out), path.resolve(out)]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the capability refusal for a command an agent was never given, inside a file scope', async () => {
    const root = await workspace();
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'agent');

    try {
      expect(tools.setContractTaskScope({ folderAccess: [{ path: 'docs/notes.md', permission: 'readwrite' }] })).toBe(true);
      // Widening the scope would not bring a tool the agent does not have, so the refusal does not suggest it.
      expect(await tools.run('run_command', { command: 'echo hi' })).toMatchObject({ status: 'refused', reason: 'capability' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a coordinator scope that is empty or names a missing path, and leaves the configured authority in place', async () => {
    const root = await workspace();
    const { tools } = configuredTools(root);

    try {
      expect(tools.setContractTaskScope({ folderAccess: [] })).toBe(false);
      expect(tools.setContractTaskScope({ folderAccess: [{ path: 'docs/missing.md', permission: 'readwrite' }] })).toBe(false);
      // One entry that cannot be admitted refuses the whole scope, as it does when a task is dispatched.
      expect(tools.setContractTaskScope({ folderAccess: [
        { path: 'docs/notes.md', permission: 'read' },
        { path: 'docs/missing.md', permission: 'readwrite' },
      ] })).toBe(false);
      expect(await tools.run('write_file', { path: 'docs/created.md', content: 'configured authority\n' })).toMatchObject({ status: 'success' });
      expect(await tools.runText('run_command', { command: 'echo hi' })).toContain('[exit 0]');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
