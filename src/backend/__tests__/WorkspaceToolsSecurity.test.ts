import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceTools } from '../WorkspaceTools';
import { asProvider, CMD_SHELL, WINDOWS_POWERSHELL_SHELL } from './shellFixtures';
import { CommandPolicy } from '../CommandPolicy';
import { intersectTaskWorkspaceAccess, resolveEffectiveRoots } from '../folderAccess';
import { summarizeToolResult } from '../toolSummary';
import type { FolderGrant } from '../../types';

describe('WorkspaceTools sandbox hardening', () => {
  it('captures old and new content for write_file metadata without changing string output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-write-meta-'));
    await fs.writeFile(path.join(root, 'note.txt'), 'before\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['write']));

    const output = await tools.runText('write_file', { path: 'note.txt', content: 'after\n' });
    const result = tools.takeLastRunResult();

    expect(output).toBe('Wrote 6 bytes to note.txt.');
    expect(result).toMatchObject({
      name: 'write_file',
      kind: 'write',
      path: 'note.txt',
      oldContent: 'before\n',
      newContent: 'after\n',
    });

    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects an empty/parameterless write_file without writing to the sandbox root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-empty-write-'));
    const tools = new WorkspaceTools(root, new Set(['write']));

    // Simulates a model emitting a write_file tool call with no/empty arguments (args -> {}).
    const noPath = await tools.runText('write_file', { content: 'x' });          // missing-param validator
    const emptyPath = await tools.runText('write_file', { path: '   ', content: 'x' }); // whitespace-path guard

    expect(noPath).toMatch(/missing required parameter\(s\): path/);
    expect(emptyPath).toMatch(/requires a non-empty 'path'/);
    // The sandbox root must be untouched (still a directory, not overwritten as a file).
    expect((await fs.stat(root)).isDirectory()).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects any tool called with missing required parameters, without executing it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-missing-args-'));
    const tools = new WorkspaceTools(root, new Set(['read', 'write', 'execute', 'message']));

    expect(await tools.runText('read_file', {})).toMatch(/missing required parameter\(s\): path/);
    expect(await tools.runText('run_command', {})).toMatch(/missing required parameter\(s\): command/);
    expect(await tools.runText('send_message', { target: 'pm' })).toMatch(/missing required parameter\(s\): message/);
    // A legitimately-empty value is NOT "missing": write_file with empty content writes an empty file.
    expect(await tools.runText('write_file', { path: 'empty.txt', content: '' })).toMatch(/Wrote 0 bytes/);

    await fs.rm(root, { recursive: true, force: true });
  });

  it('applies the shared public-web policy before a gateway fetch can leave the host', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-web-policy-'));
    let approvals = 0;
    let policy: 'ask' | 'off' = 'off';
    const tools = new WorkspaceTools(
      root,
      new Set(['read']),
      'researcher',
      undefined, // coordinator
      undefined, // command policy
      undefined, // command timeout
      undefined, // command approver
      undefined, // message bus
      undefined, // command normalizer
      undefined, // command executor
      undefined, // checkpoint recorder
      undefined, // write-approval mode
      undefined, // write approver
      undefined, // memory writer
      undefined, // outside-root callback
      undefined, // shared read root
      undefined, // additional read roots
      undefined, // workspace trust
      undefined, // write roots
      undefined, // checkpoint observer
      {
        policy: () => policy,
        requestApproval: async () => { approvals++; return { allow: false, reason: 'test denied at C:\\private\\notes token=secret-value' }; },
      },
    );

    expect(tools.specs().map((spec) => spec.function.name)).not.toContain('fetch_url');
    // Public-web policy blocks fetching, not the separately consent-gated reader for a user-supplied
    // image asset a coordinator may have handed this worker.
    expect(tools.specs().map((spec) => spec.function.name)).toContain('send_image_asset_to_model');
    const policyRefusal = await tools.run('fetch_url', { url: 'https://example.test' });
    expect(policyRefusal).toMatchObject({ status: 'refused', reason: 'capability' });
    expect(summarizeToolResult('fetch_url', { url: 'https://example.test' }, policyRefusal))
      .toMatchObject({ ok: false, failureKind: 'blocked' });
    expect(policyRefusal.output).toMatch(/Web access denied: capability/i);
    expect(approvals).toBe(0);
    policy = 'ask';
    expect(tools.specs().map((spec) => spec.function.name)).toContain('fetch_url');
    expect(tools.specs().map((spec) => spec.function.name)).toContain('send_image_asset_to_model');
    const consentRefusal = await tools.run('fetch_url', { url: 'https://example.test' });
    expect(consentRefusal).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(consentRefusal.output).toMatch(/Web access denied: consent/i);
    // The user's free-form denial reason is not a host-authored literal detail and stays redacted.
    expect(consentRefusal.output).not.toMatch(/test denied|C:\\private|secret-value|token=/i);
    expect(approvals).toBe(1);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps generic refusals byte-identical and appends only the reviewed artifact detail', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-refusal-detail-'));
    const tools = new WorkspaceTools(root, new Set());

    await expect(tools.runText('read_file', { path: 'anything.txt' }))
      .resolves.toBe('read_file refused: capability. Use an allowed tool or ask for the required capability.');
    await expect(tools.runText('publish_task_artifact', { content: 'artifact' }))
      .resolves.toBe(
        'publish_task_artifact refused: capability. Use an allowed tool or ask for the required capability.\n\n'
        + 'This tool is available only while executing a live contracted task attempt.',
      );

    await fs.rm(root, { recursive: true, force: true });
  });

  it('derives run_command success from the observed exit code, not subprocess wording', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-command-outcome-'));
    const makeTools = (code: number, output: string) => new WorkspaceTools(
      root,
      new Set(['execute']),
      'agent',
      undefined,
      new CommandPolicy('all'),
      120_000,
      undefined,
      undefined,
      undefined,
      asProvider(async () => ({ code, output })),
    );

    const successful = await makeTools(0, 'Error: words are subprocess data').run('run_command', { command: 'fixture-command' });
    const failed = await makeTools(7, 'plain output').run('run_command', { command: 'fixture-command' });

    expect(successful).toMatchObject({ status: 'success', exitCode: 0, contentSource: 'mixed-external' });
    expect(failed).toMatchObject({ status: 'failed', exitCode: 7, contentSource: 'mixed-external' });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not advertise or execute an allowlisted PowerShell cmdlet through Windows cmd.exe', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-cmdlet-'));
    let executions = 0;
    const tools = new WorkspaceTools(
      root,
      new Set(['execute']),
      'agent',
      undefined,
      new CommandPolicy('allowlist', ['npm test', 'copy-item']),
      120_000,
      undefined,
      undefined,
      undefined,
      asProvider(async () => {
        executions++;
        return { code: 0, output: 'ran' };
      }, CMD_SHELL)
    );

    // v0.9.96: the prepared shell decides, on every host. Here the invocation is prepared for cmd.exe.
    const result = await tools.run('run_command', { command: 'copy-item source dest' });
    expect(executions).toBe(0);
    expect(result).toMatchObject({ status: 'refused', reason: 'shell-compatibility' });
    expect(result.output).toMatch(/copy-item.*PowerShell cmdlet.*cmd\.exe.*copy or xcopy/i);
    expect(result.output).not.toMatch(/npm test/i);

    // The same allowlisted cmdlet runs where the prepared shell is PowerShell.
    const underPowerShell = new WorkspaceTools(
      root, new Set(['execute']), 'agent', undefined, new CommandPolicy('allowlist', ['npm test', 'copy-item']), 120_000,
      undefined, undefined, undefined,
      asProvider(async () => { executions++; return { code: 0, output: 'ran' }; }, WINDOWS_POWERSHELL_SHELL),
    );
    expect(await underPowerShell.run('run_command', { command: 'copy-item source dest' })).toMatchObject({ status: 'success' });
    expect(executions).toBe(1);

    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses a PowerShell-only cmdlet before prompting and names the cmd.exe equivalent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-cmdlet-approval-'));
    let executions = 0;
    let approvals = 0;
    const tools = new WorkspaceTools(
      root,
      new Set(['execute']),
      'agent',
      undefined,
      new CommandPolicy('ask', ['copy-item']),
      120_000,
      async () => {
        approvals++;
        return { allow: true };
      },
      undefined,
      undefined,
      asProvider(async () => {
        executions++;
        return { code: 0, output: 'ran' };
      }, CMD_SHELL)
    );

    const result = await tools.run('run_command', { command: 'Start-Sleep -Seconds 120' });
    expect(approvals).toBe(0);
    expect(executions).toBe(0);
    expect(result).toMatchObject({ status: 'refused', reason: 'shell-compatibility' });
    expect(result.output).toMatch(/PowerShell cmdlet.*cmd\.exe.*ping -n 121 127\.0\.0\.1 >nul/i);
    expect(result.output).not.toMatch(/User consent was not granted/i);

    const ordinary = await tools.run('run_command', { command: 'echo ordinary' });
    expect(approvals).toBe(1);
    expect(executions).toBe(1);
    expect(ordinary).toMatchObject({ status: 'success' });

    await fs.rm(root, { recursive: true, force: true });
  });

  it('blocks a catastrophic whole-file truncation, leaving the original intact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-shrink-'));
    const big = 'x'.repeat(10000);
    await fs.writeFile(path.join(root, 'big.ts'), big, 'utf8');
    const tools = new WorkspaceTools(root, new Set(['write']));

    // Replacing a 10 KB file with a tiny fragment (a weak model treating write_file as a patch).
    const out = await tools.runText('write_file', { path: 'big.ts', content: 'const x = 1;' });
    expect(out).toMatch(/Write blocked: this would shrink/);
    expect(out).toMatch(/read_file/);
    expect(await fs.readFile(path.join(root, 'big.ts'), 'utf8')).toBe(big); // untouched

    await fs.rm(root, { recursive: true, force: true });
  });

  it('allows normal edits and small files (the shrink guard only catches extreme truncation)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-shrink2-'));
    const tools = new WorkspaceTools(root, new Set(['write']));

    // A normal edit that removes ~20% of a 10 KB file — allowed.
    await fs.writeFile(path.join(root, 'a.ts'), 'a'.repeat(10000), 'utf8');
    expect(await tools.runText('write_file', { path: 'a.ts', content: 'a'.repeat(8000) })).toMatch(/Wrote 8000 bytes/);
    // A small file shrunk hard — below the size floor, allowed (not the catastrophic case).
    await fs.writeFile(path.join(root, 'b.ts'), 'b'.repeat(1000), 'utf8');
    expect(await tools.runText('write_file', { path: 'b.ts', content: 'b' })).toMatch(/Wrote 1 bytes/);

    await fs.rm(root, { recursive: true, force: true });
  });

  it('V2: blocks a write when the user denies it, and writes when approved (write approval)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-write-approval-'));
    const calls: Array<{ path: string; before: string | null }> = [];

    const deny = new WorkspaceTools(
      root, new Set(['write']), 'a1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => true, async (req) => { calls.push({ path: req.path, before: req.before }); return 'deny'; }
    );
    const denied = await deny.run('write_file', { path: 'blocked.txt', content: 'nope' });
    expect(denied).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(calls).toEqual([{ path: 'blocked.txt', before: null }]); // approver saw the pending write
    const wroteFile = await fs.access(path.join(root, 'blocked.txt')).then(() => true).catch(() => false);
    expect(wroteFile).toBe(false); // nothing written

    const allow = new WorkspaceTools(
      root, new Set(['write']), 'a1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => true, async () => 'once'
    );
    const wrote = await allow.runText('write_file', { path: 'ok.txt', content: 'yes' });
    expect(wrote).toMatch(/Wrote 3 bytes/);
    expect(await fs.readFile(path.join(root, 'ok.txt'), 'utf8')).toBe('yes');

    await fs.rm(root, { recursive: true, force: true });
  });

  it('V2: default (no approval mode) writes freely without invoking an approver', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-write-noapproval-'));
    let asked = false;
    // writeApprovalMode defaults to 'none' — approver should never be consulted.
    const tools = new WorkspaceTools(
      root, new Set(['write']), 'a1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, async () => { asked = true; return 'deny'; }
    );
    const out = await tools.runText('write_file', { path: 'free.txt', content: 'hi' });
    expect(out).toMatch(/Wrote 2 bytes/);
    expect(asked).toBe(false);
    expect(await fs.readFile(path.join(root, 'free.txt'), 'utf8')).toBe('hi');

    await fs.rm(root, { recursive: true, force: true });
  });

  it('blocks reads and writes through a symlink or junction that points outside the workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');

    try {
      await fs.symlink(outside, path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    await expect(tools.run('read_file', { path: 'outside/secret.txt' })).resolves.toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    await expect(tools.run('write_file', { path: 'outside/new.txt', content: 'nope' })).resolves.toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    // apply_edit must run the sandbox check BEFORE reading, so it can't even probe the outside file's
    // contents (whether old_string is present / how often) before the write would be blocked.
    await expect(tools.run('apply_edit', { path: 'outside/secret.txt', old_string: 'secret', new_string: 'x' })).resolves.toMatchObject({ status: 'refused', reason: 'workspace-escape' });
  });

  // A link whose target is gone resolves to nothing, so the check used to fall back to the directory the link
  // sits in, which is inside. The write then went through the link and created the target where it pointed.
  it('writes through no link whose target does not exist, and judges one that points outside as an escape', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-dangling-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-dangling-outside-'));
    // A file symlink needs a privilege most Windows accounts lack. A junction needs none, and one whose target is
    // gone is the same case to the check: something holds the name and nothing resolves at it.
    const kind = process.platform === 'win32' ? 'junction' : 'file';
    try {
      await fs.symlink(path.join(outside, 'created-through-the-link.txt'), path.join(root, 'out.txt'), kind);
      await fs.symlink(path.join(root, 'later.txt'), path.join(root, 'in.txt'), kind);
      await fs.mkdir(path.join(root, 'sub'));
      // The link's own target is named inside the root, through a live link that leads out of it.
      await fs.symlink(outside, path.join(root, 'way-out'), process.platform === 'win32' ? 'junction' : 'dir');
      await fs.symlink(path.join(root, 'way-out', 'chained.txt'), path.join(root, 'chain.txt'), kind);
      const linkedOut = ['out.txt', 'chain.txt'];
      if (process.platform !== 'win32') {
        // A relative link is read against the directory that holds it. A junction is always absolute.
        await fs.symlink(path.join('..', '..', path.basename(outside), 'relative.txt'), path.join(root, 'sub', 'rel.txt'), kind);
        // The same link, named through a directory link two levels down: read from there, `../..` would stay inside.
        await fs.mkdir(path.join(root, 'p', 'q'), { recursive: true });
        await fs.symlink(path.join(root, 'sub'), path.join(root, 'p', 'q', 'alias'), 'dir');
        linkedOut.push('sub/rel.txt', 'p/q/alias/rel.txt');
      }
      const tools = new WorkspaceTools(root, new Set(['read', 'write']));

      for (const linked of linkedOut) {
        expect(await tools.run('write_file', { path: linked, content: 'escaped' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
        expect(await tools.run('apply_edit', { path: linked, old_string: 'a', new_string: 'b' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
        expect(await tools.run('delete_file', { path: linked })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
        expect(await tools.run('delete_dir', { path: linked })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
      }
      expect(await fs.readdir(outside)).toEqual([]);

      // A link that points inside is not an escape, and is still not written through: where it leads is not shown.
      const inside = await tools.run('write_file', { path: 'in.txt', content: 'created' });
      expect(inside.status).toBe('failed');
      expect(inside.output).toBe('Error: "in.txt" is a link whose target does not exist. Nothing was changed: '
        + 'a write would go through the link and create a file wherever it points.');
      await expect(fs.lstat(path.join(root, 'later.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

      // Every link is still the link it was, and a file beside them is written as before.
      for (const linked of [...linkedOut, 'in.txt']) {
        expect((await fs.lstat(path.join(root, linked))).isSymbolicLink()).toBe(true);
      }
      expect(await tools.run('write_file', { path: 'sub/plain.txt', content: 'ok' })).toMatchObject({ status: 'success' });
      expect(await fs.readFile(path.join(root, 'sub', 'plain.txt'), 'utf8')).toBe('ok');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('names the workspace path a hallucinated absolute path (foreign prefix) could mean, and reads nothing (v0.9.97)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-reroot-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), 'hello', 'utf8');
    await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const x = 1;', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));

    // A Claude model prepends a fake sandbox prefix. Where it ends cannot be told, so the read is refused with the
    // workspace path named, and the next call names it.
    const readme = await tools.run('read_file', { path: '/Users/dev/workspace-0073b507/README.md' });
    expect(readme.status).toBe('failed');
    expect(readme.output).toContain('"README.md"');
    expect(readme.output).not.toContain('hello');
    const app = await tools.run('read_file', { path: '/Users/dev/workspace-0073b507/src/app.ts' });
    expect(app.output).toContain('"src/app.ts"');
    expect(app.output).not.toContain('export const x');
    expect(await tools.runText('read_file', { path: 'src/app.ts' })).toContain('export const x');
    // A genuine outside path with NO in-workspace twin still hits the boundary block (not recovered).
    expect(await tools.run('read_file', { path: '/etc/shadow' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
  });

  it('falls back to the shared read overlay without making writes touch the shared file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-own-'));
    const shared = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-shared-'));
    await fs.writeFile(path.join(shared, 'merged.txt'), 'from integration\n', 'utf8');

    const tools = workspaceToolsWithShared(root, shared);
    const read = await tools.runText('read_file', { path: 'merged.txt' });
    expect(read).toContain('from integration');
    expect(read).toContain('shared integration view');

    const wrote = await tools.runText('write_file', { path: 'merged.txt', content: 'local fork\n' });
    expect(wrote).toMatch(/Wrote/);
    expect(await fs.readFile(path.join(root, 'merged.txt'), 'utf8')).toBe('local fork\n');
    expect(await fs.readFile(path.join(shared, 'merged.txt'), 'utf8')).toBe('from integration\n');

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(shared, { recursive: true, force: true });
  });

  it('merges list_dir entries from own and shared roots, with own entries winning', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-own-list-'));
    const shared = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-shared-list-'));
    await fs.writeFile(path.join(root, 'local.txt'), 'local', 'utf8');
    await fs.writeFile(path.join(root, 'same.txt'), 'own', 'utf8');
    await fs.writeFile(path.join(shared, 'same.txt'), 'shared', 'utf8');
    await fs.mkdir(path.join(shared, 'team-dir'));

    const listed = await workspaceToolsWithShared(root, shared).runText('list_dir', { path: '.' });
    expect(listed.split(/\r?\n/)).toEqual(['local.txt', 'same.txt', 'team-dir/']);

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(shared, { recursive: true, force: true });
  });

  it('allows reads and search hits in a second read root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-primary-'));
    const second = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-second-'));
    await fs.writeFile(path.join(second, 'lib.ts'), 'export const needle = 1;\n', 'utf8');

    const tools = workspaceToolsWithReadRoots(root, [second]);
    expect(await tools.runText('read_file', { path: path.join(second, 'lib.ts') })).toContain('needle');
    const search = await tools.runText('search_files', { query: 'needle' });
    expect(search).toMatch(/lib\.ts:1:/);

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(second, { recursive: true, force: true });
  });

  it('refuses writes targeting a second read root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-write-primary-'));
    const second = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-write-second-'));
    const target = path.join(second, 'lib.ts');
    await fs.writeFile(target, 'original\n', 'utf8');

    const tools = workspaceToolsWithReadRoots(root, [second]);
    const out = await tools.run('write_file', { path: target, content: 'changed\n' });
    expect(out).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    expect(await fs.readFile(target, 'utf8')).toBe('original\n');

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(second, { recursive: true, force: true });
  });

  it('rejects an absolute read path outside all read roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-outside-primary-'));
    const second = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-outside-second-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-outside-'));
    const target = path.join(outside, 'secret.txt');
    await fs.writeFile(target, 'secret\n', 'utf8');

    const tools = workspaceToolsWithReadRoots(root, [second]);
    expect(await tools.run('read_file', { path: target })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(second, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('does NOT let a shell command reach a second read root (writes stay in the primary root)', async () => {
    // Security invariant: read-only roots are reachable only through fixed read tools (read/list/search or
    // inspect_git_tag). A shell
    // command can WRITE, so it must stay scoped to the primary root — otherwise `prettier --write
    // C:\extra\x.ts` could mutate a read-only root. run_command's path guard uses this.root only.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-cmd-primary-'));
    const second = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-cmd-second-'));
    const target = path.join(second, 'lib.ts');
    await fs.writeFile(target, 'x\n', 'utf8');

    const ran: string[] = [];
    const tools = new WorkspaceTools(
      root, new Set(['read', 'write', 'execute']), 'a1',
      undefined,                       // coordinator
      new CommandPolicy('all', []),    // permissive policy → only the path guard can block
      undefined, undefined, undefined, undefined, // timeout, requestApproval, bus, commandNormalizer
      asProvider(async (command: string) => { ran.push(command); return { code: 0, output: 'ran' }; }), // command execution
      undefined, undefined, undefined, undefined, undefined, undefined, // checkpoint..sharedReadRoot
      [second]                         // additionalReadRoots
    );

    const out = await tools.runText('run_command', { command: `type ${target}` });
    expect(out).toMatch(/working folder|outside/i); // blocked before execution
    expect(ran).toEqual([]);                          // executor never ran the command

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(second, { recursive: true, force: true });
  });

  it('catches symlink or junction escapes from a second read root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-link-primary-'));
    const second = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-link-second-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-link-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');

    try {
      await fs.symlink(outside, path.join(second, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(second, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
      return;
    }

    const tools = workspaceToolsWithReadRoots(root, [second]);
    await expect(tools.run('read_file', { path: path.join(second, 'escape', 'secret.txt') })).resolves.toMatchObject({ status: 'refused', reason: 'workspace-escape' });

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(second, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
});

function workspaceToolsWithShared(root: string, shared: string): WorkspaceTools {
  return new WorkspaceTools(
    root,
    new Set(['read', 'write']),
    'a1',
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
    shared
  );
}

function workspaceToolsWithReadRoots(root: string, readRoots: string[]): WorkspaceTools {
  return new WorkspaceTools(
    root,
    new Set(['read', 'write']),
    'a1',
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
    readRoots
  );
}

/** Scope `tools` as a delegated worker receives a task scope (the host's two calls) or as a coordinator sets its own. */
function scopeOnRoute(route: 'delegated' | 'coordinator', tools: WorkspaceTools, root: string, scope: FolderGrant[]): boolean {
  if (route === 'coordinator') {
    return tools.setContractTaskScope({ folderAccess: scope });
  }
  const options = { fallbackPrimaryRoot: root, fallbackReadRoots: [], workspaceRoots: [root], isTrusted: true };
  const access = intersectTaskWorkspaceAccess(
    resolveEffectiveRoots({ ...options, grants: undefined }),
    resolveEffectiveRoots({ ...options, grants: scope }),
    true,
    root,
  );
  if (!access) {
    return false;
  }
  tools.setTurnWorkspaceAccess(access);
  return true;
}

// An exact-file grant is admitted for one physical file. A link that is changed afterwards must not carry the
// grant to another file. The junction cases run on Windows as well as on POSIX; a file symlink needs a privilege
// most Windows accounts lack, so those cases return early there and run where the system allows the link.
describe('WorkspaceTools exact-file grants behind links', { timeout: 20_000 }, () => {
  const ROUTES = ['delegated', 'coordinator'] as const;
  const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';

  async function linkedWorkspace(): Promise<{ root: string; first: string; second: string; link: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-file-link-'));
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const link = path.join(root, 'link');
    await fs.mkdir(first);
    await fs.mkdir(second);
    await fs.writeFile(path.join(first, 'notes.md'), 'FIRST\n', 'utf8');
    await fs.symlink(first, link, directoryLink);
    return { root, first, second, link };
  }

  async function repoint(link: string, target: string): Promise<void> {
    await fs.rm(link, { recursive: true, force: true });
    await fs.symlink(target, link, directoryLink);
  }

  it.each(ROUTES)('refuses a granted file once a junction on its path leads to another file (%s route)', async (route) => {
    const { root, first, second, link } = await linkedWorkspace();
    await fs.writeFile(path.join(second, 'notes.md'), 'SECOND\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'a1');

    try {
      expect(scopeOnRoute(route, tools, root, [{ path: 'link/notes.md', permission: 'readwrite' }])).toBe(true);
      expect(await tools.runText('read_file', { path: 'link/notes.md' })).toBe('FIRST\n');

      await repoint(link, second);

      const read = await tools.run('read_file', { path: 'link/notes.md' });
      expect(read).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(read.output).not.toContain('SECOND');
      for (const [name, args] of [
        ['write_file', { path: 'link/notes.md', content: 'redirected\n' }],
        ['apply_edit', { path: 'link/notes.md', old_string: 'SECOND', new_string: 'redirected' }],
        ['delete_file', { path: 'link/notes.md' }],
      ] as const) {
        expect(await tools.run(name, args), name).toMatchObject({ status: 'refused', reason: 'task-scope' });
      }
      expect(await fs.readFile(path.join(second, 'notes.md'), 'utf8')).toBe('SECOND\n');
      expect(await fs.readFile(path.join(first, 'notes.md'), 'utf8')).toBe('FIRST\n');

      // Led back to the admitted file, the same grant serves it again.
      await repoint(link, first);
      expect(await tools.runText('read_file', { path: 'link/notes.md' })).toBe('FIRST\n');
    } finally {
      await fs.rm(link, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // The backend applies a coordinator attempt's scope again after each of its team calls. Resolving the scope
  // anew each time would admit whatever a link leads to by then.
  it('keeps what a coordinator scope resolved to when the same scope is applied again, until the turn ends', async () => {
    const { root, first, second, link } = await linkedWorkspace();
    await fs.writeFile(path.join(second, 'notes.md'), 'SECOND\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'a1');
    const scope = { folderAccess: [{ path: 'link/notes.md', permission: 'readwrite' as const }] };

    try {
      expect(tools.setContractTaskScope(scope)).toBe(true);
      await repoint(link, second);
      expect(tools.setContractTaskScope(scope)).toBe(true);

      expect(await tools.run('read_file', { path: 'link/notes.md' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.run('write_file', { path: 'link/notes.md', content: 'redirected\n' }))
        .toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await fs.readFile(path.join(second, 'notes.md'), 'utf8')).toBe('SECOND\n');
      expect(await fs.readFile(path.join(first, 'notes.md'), 'utf8')).toBe('FIRST\n');

      // The next turn ends the attempt. A scope admitted after that is a new grant, resolved as the path is then.
      tools.setTurnWorkspaceAccess(undefined);
      expect(tools.setContractTaskScope(scope)).toBe(true);
      expect(await tools.runText('read_file', { path: 'link/notes.md' })).toBe('SECOND\n');
    } finally {
      await fs.rm(link, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('writes a deleted granted file again only in the directory it was admitted in (%s route)', async (route) => {
    const { root, first, second, link } = await linkedWorkspace();
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'a1');

    try {
      expect(scopeOnRoute(route, tools, root, [{ path: 'link/notes.md', permission: 'readwrite' }])).toBe(true);
      expect(await tools.run('delete_file', { path: 'link/notes.md' })).toMatchObject({ status: 'success' });
      await expect(fs.stat(path.join(first, 'notes.md'))).rejects.toMatchObject({ code: 'ENOENT' });

      // The name is free in both directories now. Only the admitted one may take the file back.
      await repoint(link, second);
      expect(await tools.run('write_file', { path: 'link/notes.md', content: 'in the wrong directory\n' }))
        .toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await fs.readdir(second)).toEqual([]);

      await repoint(link, first);
      expect(await tools.run('write_file', { path: 'link/notes.md', content: 'back where it was\n' }))
        .toMatchObject({ status: 'success' });
      expect(await fs.readFile(path.join(first, 'notes.md'), 'utf8')).toBe('back where it was\n');
      expect(await fs.readdir(second)).toEqual([]);
    } finally {
      await fs.rm(link, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('does not write through a link to nothing left in the place of a granted file (%s route)', async (route) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-file-dangling-'));
    const notes = path.join(root, 'notes.md');
    const elsewhere = path.join(root, 'created-through-the-link');
    await fs.writeFile(notes, 'NOTES\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'a1');

    try {
      expect(scopeOnRoute(route, tools, root, [{ path: 'notes.md', permission: 'readwrite' }])).toBe(true);
      // The file is gone and its name is not free: a link holds it, and leads to a path that does not exist.
      // A write to the name would pass a "nothing is there" check and then create whatever the link names.
      await fs.rm(notes);
      await fs.symlink(elsewhere, notes, directoryLink);

      expect(await tools.run('write_file', { path: 'notes.md', content: 'through the link\n' }))
        .toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.run('read_file', { path: 'notes.md' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      await expect(fs.stat(elsewhere)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.lstat(notes)).isSymbolicLink()).toBe(true);
    } finally {
      await fs.rm(notes, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // The identity a turn keeps a refused or made change by is the file the tool acts on. For a granted file that
  // is the grant's own path, physically, and never a file of the same name that a writable folder holds.
  it('names a granted file as the target of a call for it, physically, and no file of its name in a writable folder', async () => {
    const { root, first } = await linkedWorkspace();
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-file-other-'));
    const grantedPath = path.join(other, 'x', 'app', 'f.md');
    await fs.mkdir(path.join(root, 'app'));
    await fs.mkdir(path.dirname(grantedPath), { recursive: true });
    await fs.writeFile(path.join(root, 'app', 'f.md'), 'TWIN\n', 'utf8');
    await fs.writeFile(grantedPath, 'GRANTED\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'a1');

    try {
      const options = { fallbackPrimaryRoot: root, fallbackReadRoots: [], workspaceRoots: [root], isTrusted: true };
      const access = intersectTaskWorkspaceAccess(
        resolveEffectiveRoots({ ...options, grants: [{ path: root, permission: 'readwrite' }, { path: other, permission: 'readwrite' }] }),
        resolveEffectiveRoots({ ...options, grants: [
          { path: path.join(root, 'app'), permission: 'readwrite' },
          { path: grantedPath, permission: 'readwrite' },
          { path: path.join(root, 'link', 'notes.md'), permission: 'readwrite' },
        ] }),
        true,
        root,
      );
      expect(access).toBeDefined();
      tools.setTurnWorkspaceAccess(access!);

      // The granted path ends in `app/f.md`, and a file of that name is inside the writable folder. A path outside
      // the folders is recovered to such a file, but not when it is itself a granted file: the tool writes the grant.
      const granted = tools.fileEffectTarget('write_file', { path: grantedPath });
      expect(granted).not.toBe(tools.fileEffectTarget('write_file', { path: 'app/f.md' }));
      expect(await tools.run('write_file', { path: grantedPath, content: 'WRITTEN\n' })).toMatchObject({ status: 'success' });
      expect(await fs.readFile(grantedPath, 'utf8')).toBe('WRITTEN\n');
      expect(await fs.readFile(path.join(root, 'app', 'f.md'), 'utf8')).toBe('TWIN\n');
      // A granted file behind a junction is the file the junction leads to.
      const real = await fs.realpath(path.join(first, 'notes.md'));
      expect(tools.fileEffectTarget('write_file', { path: 'link/notes.md' })).toBe(process.platform === 'win32' ? real.toLowerCase() : real);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('refuses a granted file symlink once it is replaced, dangling, or made a plain file (%s route)', async (route) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wt-file-symlink-'));
    const target = path.join(root, 'target.md');
    const decoy = path.join(root, 'decoy.md');
    const link = path.join(root, 'link.md');
    await fs.writeFile(target, 'TARGET\n', 'utf8');
    await fs.writeFile(decoy, 'DECOY\n', 'utf8');
    try {
      await fs.symlink(target, link, 'file');
    } catch (err: any) {
      await fs.rm(root, { recursive: true, force: true });
      if (process.platform === 'win32' && (err?.code === 'EPERM' || err?.code === 'EACCES')) {
        return; // No privilege to create a file symlink here; the junction cases above cover the redirect.
      }
      throw err;
    }
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'a1');

    try {
      expect(scopeOnRoute(route, tools, root, [{ path: 'link.md', permission: 'readwrite' }])).toBe(true);
      expect(await tools.runText('read_file', { path: 'link.md' })).toBe('TARGET\n');
      // The grant names the link, not what it points at: the target's own path is another path.
      expect(await tools.run('read_file', { path: 'target.md' })).toMatchObject({ status: 'refused', reason: 'task-scope' });

      await fs.rm(link);
      await fs.symlink(decoy, link, 'file');
      expect(await tools.run('read_file', { path: 'link.md' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.run('write_file', { path: 'link.md', content: 'redirected\n' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await fs.readFile(decoy, 'utf8')).toBe('DECOY\n');

      // A link to nothing would be written through, creating its target.
      await fs.rm(link);
      await fs.symlink(path.join(root, 'created-through-the-link.md'), link, 'file');
      expect(await tools.run('write_file', { path: 'link.md', content: 'created\n' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      await expect(fs.stat(path.join(root, 'created-through-the-link.md'))).rejects.toMatchObject({ code: 'ENOENT' });

      // A plain file in the link's place is not the file that was admitted.
      await fs.rm(link);
      await fs.writeFile(link, 'PLAIN\n', 'utf8');
      expect(await tools.run('read_file', { path: 'link.md' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.run('write_file', { path: 'link.md', content: 'overwritten\n' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await fs.readFile(link, 'utf8')).toBe('PLAIN\n');
      expect(await fs.readFile(target, 'utf8')).toBe('TARGET\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
