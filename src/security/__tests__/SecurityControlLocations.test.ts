import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir) };
});
import { classifySecurityControlFileChange, type SecurityControlArtifactLocation } from '../SecurityControlArtifacts';
import { SecurityControlLocationAdapter, type SecurityControlLocationOptions } from '../SecurityControlLocations';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!path.basename(root).startsWith('unode-security-locations-')) throw new Error('Unexpected fixture root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-security-locations-')));
  roots.push(root);
  const user = path.join(root, 'User');
  const globalStorage = path.join(user, 'globalStorage', 'unode.unodeai');
  const workspaceStorage = path.join(user, 'workspaceStorage', 'workspace-id', 'unode.unodeai');
  const profiles = path.join(user, 'profiles');
  const teams = path.join(globalStorage, 'teams');
  for (const directory of [globalStorage, workspaceStorage, profiles, teams]) await fs.mkdir(directory, { recursive: true });
  const metadata = path.join(user, 'globalStorage', 'storage.json');
  const gateway = path.join(globalStorage, 'custom-gateway-profiles.v1.json');
  const options: SecurityControlLocationOptions = {
    globalStorageUri: { scheme: 'file', fsPath: globalStorage }, workspaceStorageUri: { scheme: 'file', fsPath: workspaceStorage },
    customGatewayRegistryPath: gateway, hostFileSystem: 'local-desktop',
  };
  const writeMetadata = (userDataProfiles: unknown[]) => fs.writeFile(metadata, JSON.stringify({
    'newer.normal.window': { width: 1300 }, 'newer.normal.theme': 'dark',
    'newer.normal.history': ['do not treat these as controls'], userDataProfiles,
  }));
  const adapter = (patch: Partial<SecurityControlLocationOptions> = {}) => new SecurityControlLocationAdapter({ ...options, ...patch });
  return { root, user, globalStorage, workspaceStorage, profiles, teams, metadata, gateway, options, writeMetadata, adapter };
}

const paths = (locations: readonly SecurityControlArtifactLocation[], kind: SecurityControlArtifactLocation['kind']) =>
  locations.filter(location => location.kind === kind).map(location => path.resolve(location.path)).sort();

describe('host-derived individual security control locations', () => {
  it('derives default application settings and binary state from the qualified local host layout, without constructor reads', async () => {
    const h = await fixture();
    const read = vi.mocked(fs.readFile); const directories = vi.mocked(fs.readdir);
    read.mockClear(); directories.mockClear();
    const runtime = vi.fn(() => [{ kind: 'codex-config' as const, path: path.join(h.root, 'actual-codex', 'config.toml') }]);
    const adapter = h.adapter({ runtimeLocations: runtime });
    expect(read).not.toHaveBeenCalled(); expect(directories).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled();
    const locations = await adapter.getLocations();
    expect(paths(locations, 'user-settings')).toEqual([path.join(h.user, 'settings.json')]);
    expect(paths(locations, 'global-state')).toEqual([path.join(h.user, 'globalStorage', 'state.vscdb')]);
    expect(paths(locations, 'workspace-state')).toEqual([path.join(h.user, 'workspaceStorage', 'workspace-id', 'state.vscdb')]);
    expect(locations.filter(location => location.kind.endsWith('-state')).every(location => location.binaryState === true)).toBe(true);
    expect(paths(locations, 'gateway-profiles')).toEqual([h.gateway]);
    expect(paths(locations, 'codex-config')).toEqual([path.join(h.root, 'actual-codex', 'config.toml')]);
    expect(adapter.limitations).toContain('editor-layout-field-qualification-pending');
    expect(adapter.limitations.every(value => !value.includes(h.root))).toBe(true);
  });

  it('does not invent client UI settings or state database paths for a remote extension host', async () => {
    const h = await fixture();
    await fs.writeFile(path.join(h.teams, 'personal.json'), '{}');
    const adapter = h.adapter({ hostFileSystem: 'remote-extension-host' });
    const locations = await adapter.getLocations();
    expect(paths(locations, 'user-settings')).toEqual([]);
    expect(paths(locations, 'global-state')).toEqual([]);
    expect(paths(locations, 'workspace-state')).toEqual([]);
    expect(paths(locations, 'gateway-profiles')).toEqual([h.gateway]);
    expect(paths(locations, 'saved-global-team')).toEqual([path.join(h.teams, 'personal.json')]);
    expect(adapter.limitations).toContain('remote-ui-state-unavailable');
  });

  it('keeps unknown and malformed host layouts out of the local UI location family', async () => {
    const h = await fixture();
    const wrongLayouts = [path.join(h.root, 'Cache', 'globalStorage', 'unode.unodeai'), path.join(h.root, 'User', 'cache', 'unode.unodeai')];
    for (const fsPath of wrongLayouts) {
      const adapter = h.adapter({ globalStorageUri: { scheme: 'file', fsPath } });
      const locations = await adapter.getLocations();
      expect(paths(locations, 'user-settings')).toEqual([]);
      expect(paths(locations, 'global-state')).toEqual([]);
      expect(paths(locations, 'workspace-state')).toEqual([]);
      expect(adapter.limitations).toContain('local-user-layout-unrecognized');
    }
    const unknown = h.adapter({ hostFileSystem: 'unknown' });
    expect(paths(await unknown.getLocations(), 'user-settings')).toEqual([]);
    expect(unknown.limitations).toContain('host-file-system-unqualified');
  });

  it('does not turn a non-file storage URI or relative registry name into a local control file', async () => {
    const h = await fixture();
    await fs.writeFile(path.join(h.teams, 'personal.json'), '{}');
    const adapter = h.adapter({ globalStorageUri: { scheme: 'vscode-remote', fsPath: h.globalStorage },
      customGatewayRegistryPath: 'custom-gateway-profiles.v1.json' });
    const locations = await adapter.getLocations(path.join(h.teams, 'new.json'));
    expect(locations).toEqual([]);
    const noWorkspaceFile = h.adapter({ workspaceStorageUri: { scheme: 'vscode-remote', fsPath: h.workspaceStorage } });
    expect(paths(await noWorkspaceFile.getLocations(), 'workspace-state')).toEqual([]);
  });

  it('reads actual registered profile metadata after unrelated rows, including legacy URI locations and global-state reuse', async () => {
    const h = await fixture();
    const relative = path.join(h.profiles, 'relative'); const absolute = path.join(h.profiles, 'absolute'); const legacy = path.join(h.profiles, 'legacy with spaces');
    const parentAlias = path.join(h.root, 'profiles-parent-alias');
    await fs.symlink(h.profiles, parentAlias, process.platform === 'win32' ? 'junction' : 'dir');
    await h.writeMetadata([
      { name: 'relative', location: 'relative', useDefaultFlags: { settings: true } },
      { name: 'absolute', location: absolute },
      { name: 'legacy', location: { scheme: 'vscode-userdata', path: decodeURIComponent(pathToFileURL(legacy).pathname) } },
      { name: 'parent alias', location: path.join(parentAlias, 'parent-alias') },
      { name: 'shares global state', location: 'shared', useDefaultFlags: { globalState: true, settings: false } },
    ]);
    const adapter = h.adapter(); const locations = await adapter.getLocations();
    expect(paths(locations, 'global-state')).toEqual([
      path.join(h.user, 'globalStorage', 'state.vscdb'), ...[relative, absolute, legacy, path.join(parentAlias, 'parent-alias')].map(profile => path.join(profile, 'globalStorage', 'state.vscdb')),
    ].sort());
    // Settings reuse and global-state reuse are independent; application settings still use the default file.
    expect(paths(locations, 'user-settings')).toEqual([path.join(h.user, 'settings.json')]);
  });

  it('does not accept metadata as authority to choose an arbitrary profile root or an unregistered folder', async () => {
    const h = await fixture();
    await fs.mkdir(path.join(h.profiles, 'unregistered', 'globalStorage'), { recursive: true });
    await h.writeMetadata([
      { name: 'outside', location: path.join(h.root, 'outside') },
      { name: 'traversal', location: '../outside' },
      { name: 'nested', location: 'one/two' },
      { name: 'remote', location: { scheme: 'https', path: pathToFileURL(path.join(h.profiles, 'remote')).pathname } },
      { name: '', location: 'nameless' }, { name: 'missing location' },
    ]);
    const adapter = h.adapter();
    expect(paths(await adapter.getLocations(), 'global-state')).toEqual([path.join(h.user, 'globalStorage', 'state.vscdb')]);
    expect(adapter.limitations).toContain('profile-location-unusable');
  });

  it('retains observed profile database locations when metadata is removed, replaced or damaged', async () => {
    const h = await fixture(); const adapter = h.adapter();
    const old = path.join(h.profiles, 'old', 'globalStorage', 'state.vscdb');
    await h.writeMetadata([{ name: 'Old', location: 'old' }]);
    expect(paths(await adapter.getLocations(), 'global-state')).toContain(old);
    await h.writeMetadata([{ name: 'Old now shares state', location: 'old', useDefaultFlags: { globalState: true } }, { name: 'New', location: 'new' }]);
    const newer = path.join(h.profiles, 'new', 'globalStorage', 'state.vscdb');
    expect(paths(await adapter.getLocations(), 'global-state')).toEqual([path.join(h.user, 'globalStorage', 'state.vscdb'), old, newer].sort());
    for (const text of ['{}', '{"userDataProfiles":false}', 'broken metadata']) {
      await fs.writeFile(h.metadata, text);
      expect(paths(await adapter.getLocations(), 'global-state')).toContain(old);
    }
    await fs.unlink(h.metadata);
    expect(paths(await adapter.getLocations(), 'global-state')).toContain(newer);
    expect(adapter.limitations).toContain('profile-metadata-unreadable');
  });

  it('protects the real database of a registered final profile-directory link', async () => {
    const h = await fixture();
    const actual = path.join(h.root, 'actual-profile'); const alias = path.join(h.profiles, 'linked');
    await fs.mkdir(path.join(actual, 'globalStorage'), { recursive: true });
    const database = path.join(actual, 'globalStorage', 'state.vscdb'); await fs.writeFile(database, Buffer.from([0, 255, 1]));
    await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await h.writeMetadata([{ name: 'Linked', location: 'linked' }]);
    const locations = await h.adapter().getLocations(database);
    expect(paths(locations, 'global-state')).toContain(path.join(alias, 'globalStorage', 'state.vscdb'));
    expect(await classifySecurityControlFileChange(database, 'AP8B', 'AP8C', locations, 'write'))
      .toMatchObject({ kind: 'global-state', comparison: 'raw', changed: true });
  });

  it('keeps every Memento database binary rather than ignoring changes outside the projected JSON keys', async () => {
    const h = await fixture(); await h.writeMetadata([{ name: 'Named', location: 'named' }]);
    const locations = await h.adapter().getLocations();
    const databases = locations.filter(location => location.kind === 'global-state' || location.kind === 'workspace-state');
    expect(databases).toHaveLength(3);
    for (const database of databases) {
      expect(await classifySecurityControlFileChange(database.path, '{"ordinary":1}', '{"ordinary":2}', locations, 'replace'))
        .toMatchObject({ kind: database.kind, comparison: 'raw', changed: true });
    }
  });

  it('retains observed physical profile databases when a registered directory link is retargeted or removed', async () => {
    const h = await fixture(); const alias = path.join(h.profiles, 'linked');
    const oldProfile = path.join(h.root, 'old-profile'); const newProfile = path.join(h.root, 'new-profile');
    for (const profile of [oldProfile, newProfile]) {
      await fs.mkdir(path.join(profile, 'globalStorage'), { recursive: true });
      await fs.writeFile(path.join(profile, 'globalStorage', 'state.vscdb'), 'fixture database');
    }
    await fs.symlink(oldProfile, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await h.writeMetadata([{ name: 'Linked', location: 'linked' }]);
    const adapter = h.adapter();
    const beforeRetarget = await adapter.getLocations();
    expect(paths(beforeRetarget, 'global-state')).toHaveLength(2); // Default and linked DB, no spelling duplicates.
    await fs.unlink(alias); await fs.symlink(newProfile, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(h.metadata, '{}');
    for (const locations of [await adapter.getLocations(), await adapter.getLocations()]) {
      for (const profile of [oldProfile, newProfile]) {
        expect(await classifySecurityControlFileChange(path.join(profile, 'globalStorage', 'state.vscdb'), 'old', 'new', locations, 'write'))
          .toMatchObject({ kind: 'global-state', changed: true });
      }
    }
    await fs.unlink(alias);
    const afterRemoval = await adapter.getLocations();
    for (const profile of [oldProfile, newProfile]) {
      expect(await classifySecurityControlFileChange(path.join(profile, 'globalStorage', 'state.vscdb'), 'old', 'new', afterRemoval, 'write'))
        .toMatchObject({ kind: 'global-state', changed: true });
    }
  });

  it('inventories existing direct team JSON files for folder removal without classifying ordinary storage trees', async () => {
    const h = await fixture();
    await fs.writeFile(path.join(h.teams, 'crew.json'), '{"members":[]}');
    await fs.writeFile(path.join(h.teams, 'notes.txt'), 'ordinary');
    await fs.mkdir(path.join(h.teams, 'directory.json')); await fs.mkdir(path.join(h.teams, 'nested'));
    await fs.writeFile(path.join(h.teams, 'nested', 'not-loaded.json'), '{"members":[]}');
    const history = path.join(h.globalStorage, 'history', 'normal.json'); await fs.mkdir(path.dirname(history)); await fs.writeFile(history, '{}');
    const adapter = h.adapter();
    expect(paths(await adapter.getLocations(h.globalStorage), 'saved-global-team')).toEqual([path.join(h.teams, 'crew.json')]);
    expect(paths(await adapter.getLocations(path.join(h.teams, 'directory.json')), 'saved-global-team')).toEqual([path.join(h.teams, 'crew.json')]);
    const list = await adapter.getLocations(history);
    expect(await classifySecurityControlFileChange(history, '{}', '{"members":[{"id":"not-a-team"}]}', list, 'replace')).toBeUndefined();
  });

  it('includes a prospective direct global team through a physical parent alias before its first write', async () => {
    const h = await fixture(); const alias = path.join(h.root, 'teams-alias');
    await fs.symlink(h.teams, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const newTeam = path.join(alias, 'new.json'); const adapter = h.adapter();
    const locations = await adapter.getLocations(newTeam);
    expect(paths(locations, 'saved-global-team')).toEqual([path.join(h.teams, 'new.json')]);
    expect(await classifySecurityControlFileChange(newTeam, undefined, '{"members":[{"id":"dev","autonomyMode":"full-access"}]}', locations, 'replace'))
      .toMatchObject({ kind: 'saved-global-team', changed: true, comparison: 'fields' });
    expect(paths(await adapter.getLocations(path.join(h.teams, 'nested', 'new.json')), 'saved-global-team')).toEqual([]);
    expect(paths(await adapter.getLocations(path.join(alias, 'new.txt')), 'saved-global-team')).toEqual([]);
  });

  it('compares a real global team through a hard-link write while ordinary label changes remain ordinary', async () => {
    const h = await fixture(); const team = path.join(h.teams, 'crew.json'); const alias = path.join(h.root, 'hardlink.json');
    const before = JSON.stringify({ label: 'Old label', members: [{ id: 'dev', autonomyMode: 'review' }] });
    await fs.writeFile(team, before); await fs.link(team, alias);
    const adapter = h.adapter(); const locations = await adapter.getLocations(alias);
    expect(await classifySecurityControlFileChange(alias, before, JSON.stringify({ label: 'New label', members: [{ id: 'dev', autonomyMode: 'review' }] }), locations, 'write'))
      .toMatchObject({ kind: 'saved-global-team', changed: false });
    expect(await classifySecurityControlFileChange(alias, before, JSON.stringify({ label: 'Old label', members: [{ id: 'dev', autonomyMode: 'full-access' }] }), locations, 'write'))
      .toMatchObject({ kind: 'saved-global-team', changed: true });
  });

  it('uses live exact runtime registrations, deduplicates names and does not expose a mutable registration', async () => {
    const h = await fixture();
    let runtime: SecurityControlArtifactLocation[] = [{ kind: 'claude-gate-wrapper', path: path.join(h.root, 'launch', 'wrapper.sh') }];
    const adapter = h.adapter({ runtimeLocations: () => [...runtime, ...runtime] });
    const first = await adapter.getLocations();
    expect(paths(first, 'claude-gate-wrapper')).toEqual([runtime[0].path]);
    (first.find(location => location.kind === 'claude-gate-wrapper') as { path: string }).path = path.join(h.root, 'changed');
    expect(runtime[0].path).toBe(path.join(h.root, 'launch', 'wrapper.sh'));
    runtime = [{ kind: 'codex-auth', path: path.join(h.root, 'actual-home', 'auth.json') }];
    const next = await adapter.getLocations();
    expect(paths(next, 'claude-gate-wrapper')).toEqual([]);
    expect(paths(next, 'codex-auth')).toEqual([runtime[0].path]);
  });
});
