import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../WorkspaceTools';
import { isImpliedLocalReadRoot, localReadRootsForScope, SessionLocalReadScopeConsent } from '../localReadScope';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { normalizeAgentReadRoots } from '../readRoots';
import { resolveEffectiveRoots } from '../folderAccess';
const location = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => location.home || actual.homedir() };
});
const owners: WorkspaceTools[] = [];
afterEach(async () => { for (const tools of owners.splice(0)) { tools.retire(); await tools.disposeBackground(); } location.home = ''; await removeTemporaryFolders(); });
async function fixture(relative: string) {
  const root = await fs.realpath(await temporaryFolder('unode-home-read-'));
  location.home = path.join(root, 'profile'); await fs.mkdir(os.homedir());
  const workspace = path.resolve(root, relative); await fs.mkdir(workspace, { recursive: true });
  const [parent] = localReadRootsForScope('parent', workspace, true);
  const tools = new WorkspaceTools(workspace, new Set(['read']), 'agent', undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, [parent]); owners.push(tools);
  const asked: string[] = []; let allow = false;
  const consent = new SessionLocalReadScopeConsent(async target => { asked.push(target); return allow; }, undefined, { autoGrant: isImpliedLocalReadRoot });
  tools.setLocalReadScopeAccess([parent], consent); consent.beginUserRequest();
  return { root, workspace, parent, tools, asked, consent, allow: () => { allow = true; } };
}
it('keeps a real registered read_file out of home until consent, without restricting its workspace or a later grant', async () => {
  const h = await fixture(path.join('profile', 'project')); const secret = path.join(os.homedir(), '.ssh', 'fixture-key');
  await fs.mkdir(path.dirname(secret)); await fs.writeFile(secret, 'SYNTHETIC_PRIVATE_KEY_CANARY'); await fs.writeFile(path.join(h.workspace, 'own.txt'), 'workspace content');
  const denied = await h.tools.run('read_file', { path: secret }); expect(denied.status).toBe('refused'); expect(denied.output).not.toContain('SYNTHETIC_PRIVATE_KEY_CANARY'); expect(h.asked).toHaveLength(1);
  const own = await h.tools.run('read_file', { path: 'own.txt' }); expect(own.status).toBe('success'); expect(own.output).toContain('workspace content'); expect(h.asked).toHaveLength(1);
  h.allow(); h.consent.beginUserRequest(); const granted = await h.tools.run('read_file', { path: secret }); expect(granted.status, granted.output).toBe('success'); expect(granted.output).toContain('SYNTHETIC_PRIVATE_KEY_CANARY');
  expect((await h.tools.run('read_file', { path: secret })).status).toBe('success'); expect(h.asked).toHaveLength(2);
});
it.each([path.join('profile', 'projects', 'app'), path.join('outside', 'app')])('keeps ordinary sibling discovery without a question for %s', async relative => {
  const h = await fixture(relative); const sibling = path.join(h.parent, 'sibling.txt'); await fs.writeFile(sibling, 'ordinary sibling');
  const result = await h.tools.run('read_file', { path: sibling }); expect(result.status, result.output).toBe('success'); expect(result.output).toContain('ordinary sibling'); expect(h.asked).toEqual([]);
});
it('does not imply a symlink or junction alias of home', async () => {
  const h = await fixture(path.join('profile', 'project')); const alias = path.join(h.root, 'profile-alias');
  await fs.symlink(os.homedir(), alias, process.platform === 'win32' ? 'junction' : 'dir');
  try { expect(isImpliedLocalReadRoot(alias)).toBe(false); } finally { await fs.unlink(alias); }
});

it('preserves opened and registered roots through production normalization while home is declined', async () => {
  const root = await fs.realpath(await temporaryFolder('unode-home-multiroot-'));
  location.home = path.join(root, 'profile');
  const primary = path.join(os.homedir(), 'a'); const second = path.join(os.homedir(), 'b'); const notes = path.join(os.homedir(), 'notes');
  for (const folder of [primary, second, notes, path.join(os.homedir(), '.ssh')]) await fs.mkdir(folder, { recursive: true });
  const x = path.join(second, 'x'); const y = path.join(notes, 'y'); const secret = path.join(os.homedir(), '.ssh', 'key');
  for (const file of [x, y, secret]) await fs.writeFile(file, file === secret ? 'SYNTHETIC_SECRET' : 'explicit content');
  const normalized = normalizeAgentReadRoots(primary, [primary, second], [notes, os.homedir()], true);
  const effective = resolveEffectiveRoots({ fallbackPrimaryRoot: primary, fallbackReadRoots: normalized, workspaceRoots: [primary, second], isTrusted: true, grants: undefined });
  const tools = new WorkspaceTools(effective.primaryRoot, new Set(['read']), 'agent', undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, effective.readRoots); owners.push(tools);
  const ask = vi.fn(async () => false);
  const consent = new SessionLocalReadScopeConsent(ask, undefined, { autoGrant: isImpliedLocalReadRoot });
  tools.setLocalReadScopeAccess([os.homedir()], consent); consent.beginUserRequest();
  for (const file of [x, y]) expect((await tools.run('read_file', { path: file })).status).toBe('success');
  expect(ask).not.toHaveBeenCalled();
  const denied = await tools.run('read_file', { path: secret }); expect(denied.status).toBe('refused'); expect(denied.output).not.toContain('SYNTHETIC_SECRET'); expect(ask).toHaveBeenCalledTimes(1);
});
