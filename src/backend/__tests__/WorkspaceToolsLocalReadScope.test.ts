import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContentReceiptObservation } from '../../content/ContentReceipt';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { WorkspaceTools } from '../WorkspaceTools';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function toolsWithParent(workspace: string, parent: string): WorkspaceTools {
  return new WorkspaceTools(
    workspace,
    new Set(['read']),
    'agent',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    [parent],
  );
}

describe('WorkspaceTools local read scope', () => {
  it('fails closed before a local-scope file is touched, and does not ask again after a decline', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-local-scope-'));
    cleanup.push(parent);
    const workspace = path.join(parent, 'workspace');
    const sibling = path.join(parent, 'sibling.txt');
    await fs.mkdir(workspace);
    await fs.writeFile(sibling, 'private sibling content\n', 'utf8');
    const prompts: string[] = [];
    const tools = toolsWithParent(workspace, parent);
    tools.setLocalReadScopeAccess([parent], new SessionLocalReadScopeConsent(async (root) => {
      prompts.push(root);
      return false;
    }));

    const first = await tools.run('read_file', { path: sibling });
    const second = await tools.run('read_file', { path: sibling });

    expect(first).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(second).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(first.output).not.toContain('private sibling content');
    expect(first.output).not.toContain(parent);
    expect(prompts).toEqual([parent]);
  });

  it('marks file, directory, and root-wide search access with bounded local-scope receipts', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-local-scope-'));
    cleanup.push(parent);
    const workspace = path.join(parent, 'workspace');
    const sibling = path.join(parent, 'RoamCrew');
    await fs.mkdir(workspace);
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, 'source.ts'), 'export const marker = "needle";\n', 'utf8');
    const receipts: ContentReceiptObservation[] = [];
    const prompts: string[] = [];
    const tools = toolsWithParent(workspace, parent);
    tools.setContentReceiptObserver((receipt) => receipts.push(receipt));
    tools.setLocalReadScopeAccess([parent], new SessionLocalReadScopeConsent(async (root) => {
      prompts.push(root);
      return true;
    }));

    const read = await tools.run('read_file', { path: path.join(sibling, 'source.ts') });
    const listed = await tools.run('list_dir', { path: sibling });
    const searched = await tools.run('search_files', { query: 'needle' });

    expect(read.output).toContain('[local-scope receipt: local-scope-1; file-read; 1 item]');
    expect(listed.output).toContain('[local-scope receipt: local-scope-1; directory-list; 1 item]');
    expect(searched.output).toContain('[local-scope receipt: local-scope-1; tree-scan;');
    expect(prompts).toEqual([parent]);
    expect(receipts).toEqual(expect.arrayContaining([
      { contentClass: 'local-scope', action: 'file-read', rootId: 'local-scope-1', count: 1 },
      { contentClass: 'local-scope', action: 'directory-list', rootId: 'local-scope-1', count: 1 },
      expect.objectContaining({ contentClass: 'local-scope', action: 'tree-scan', rootId: 'local-scope-1' }),
    ]));
    const serialized = JSON.stringify(receipts);
    expect(serialized).not.toContain(parent);
    expect(serialized).not.toContain('source.ts');
    expect(serialized).not.toContain('needle');
  });

  it('preflights a whole-root search before it enumerates the workspace', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-local-scope-'));
    cleanup.push(parent);
    const workspace = path.join(parent, 'workspace');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'workspace-only.txt'), 'must not scan\n', 'utf8');
    const tools = toolsWithParent(workspace, parent);
    tools.setLocalReadScopeAccess([parent], { ensure: async () => false });

    const result = await tools.run('search_files', { query: 'must not scan' });

    expect(result).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(result.output).not.toContain('workspace-only.txt');
  });

  it('does not apply local-scope consent or receipts to a separately user-registered root', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-local-scope-'));
    const userRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-user-root-'));
    cleanup.push(parent, userRoot);
    const workspace = path.join(parent, 'workspace');
    const userFile = path.join(userRoot, 'registered.ts');
    await fs.mkdir(workspace);
    await fs.writeFile(userFile, 'export const registered = true;\n', 'utf8');
    const receipts: ContentReceiptObservation[] = [];
    const prompts: string[] = [];
    const tools = new WorkspaceTools(
      workspace,
      new Set(['read']),
      'agent',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      [parent, userRoot],
    );
    tools.setContentReceiptObserver((receipt) => receipts.push(receipt));
    tools.setLocalReadScopeAccess([parent], {
      ensure: async (root) => {
        prompts.push(root);
        return false;
      },
    });

    const result = await tools.run('read_file', { path: userFile });

    expect(result).toMatchObject({ status: 'success' });
    expect(result.output).toContain('registered = true');
    expect(prompts).toEqual([]);
    expect(receipts).toEqual([]);
  });
});
