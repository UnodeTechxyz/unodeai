import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import { summarizeToolResult } from '../toolSummary';

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
      async () => ({ code, output }),
    );

    const successful = await makeTools(0, 'Error: words are subprocess data').run('run_command', { command: 'test-command' });
    const failed = await makeTools(7, 'plain output').run('run_command', { command: 'test-command' });

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
      async () => {
        executions++;
        return { code: 0, output: 'ran' };
      }
    );

    const result = await tools.run('run_command', { command: 'copy-item source dest' });

    if (process.platform === 'win32') {
      expect(executions).toBe(0);
      expect(result).toMatchObject({ status: 'refused', reason: 'capability' });
      expect(result.output).not.toMatch(/copy-item|npm test/i);
    } else {
      // The compatibility filter is deliberately cmd.exe-specific: a backend with another shell
      // must keep its existing policy behavior.
      expect(executions).toBe(1);
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  it('marks a cmd.exe approval request so the host can warn before persisting a cmdlet', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-cmdlet-approval-'));
    let executions = 0;
    let activeShell: string | undefined;
    const tools = new WorkspaceTools(
      root,
      new Set(['execute']),
      'agent',
      undefined,
      new CommandPolicy('ask', ['copy-item']),
      120_000,
      async (_command, context) => {
        activeShell = context?.activeShell;
        return { allow: false };
      },
      undefined,
      undefined,
      async () => {
        executions++;
        return { code: 0, output: 'ran' };
      }
    );

    const result = await tools.run('run_command', { command: 'copy-item source dest' });

    if (process.platform === 'win32') {
      expect(activeShell).toBe('cmd');
      expect(executions).toBe(0);
      expect(result).toMatchObject({ status: 'refused', reason: 'consent' });
    } else {
      expect(activeShell).toBeUndefined();
      expect(executions).toBe(1);
    }

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

  it('re-roots a hallucinated absolute path (foreign prefix) to the matching in-workspace file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-reroot-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), 'hello', 'utf8');
    await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const x = 1;', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));

    // A Claude model prepends a fake sandbox prefix — recover by the longest in-sandbox suffix.
    expect(await tools.runText('read_file', { path: '/Users/dev/workspace-0073b507/README.md' })).toContain('hello');
    expect(await tools.runText('read_file', { path: '/Users/dev/workspace-0073b507/src/app.ts' })).toContain('export const x');
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
    // Security invariant: read-only roots are reachable ONLY via read_file/list_dir/search_files. A shell
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
      async (command: string) => { ran.push(command); return { code: 0, output: 'ran' }; }, // commandExecutor
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
