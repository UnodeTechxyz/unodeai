import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SecurityControlArtifactLocation } from './SecurityControlArtifacts';

export interface SecurityControlStorageUri {
  readonly scheme: string;
  readonly fsPath: string;
}

export type SecurityControlHostFileSystem = 'local-desktop' | 'remote-extension-host' | 'unknown';
export type SecurityControlLocationLimitation = 'editor-layout-field-qualification-pending'
  | 'local-user-layout-unrecognized' | 'remote-ui-state-unavailable' | 'host-file-system-unqualified'
  | 'profile-metadata-unreadable' | 'profile-location-unusable';

export interface SecurityControlLocationOptions {
  /** Actual ExtensionContext storage locations; never workspace/team/model configuration. */
  readonly globalStorageUri?: SecurityControlStorageUri;
  readonly workspaceStorageUri?: SecurityControlStorageUri;
  readonly customGatewayRegistryPath?: string;
  /** The host must qualify this; remoteName alone does not identify every local UI extension host. */
  readonly hostFileSystem: SecurityControlHostFileSystem;
  /** Exact files published by the host's active Claude/Codex launches. No config-directory trees. */
  readonly runtimeLocations?: () => readonly SecurityControlArtifactLocation[];
}

/**
 * Supplies individual control-file locations to the existing effect owner. It makes no permission decision,
 * reads no credential/control-file contents, starts no task/program and does not scan in the constructor.
 * Only the host's profile metadata and direct saved-team filenames are inspected when getLocations is called.
 */
export class SecurityControlLocationAdapter {
  private readonly retainedProfileDatabases = new Set<string>();
  private readonly observedLimitations = new Set<SecurityControlLocationLimitation>();
  private readonly ownGlobalStorage?: string;
  private readonly localUserRoot?: string;

  constructor(private readonly options: SecurityControlLocationOptions) {
    this.ownGlobalStorage = fileStoragePath(options.globalStorageUri);
    if (options.hostFileSystem === 'local-desktop') {
      const globalHome = this.ownGlobalStorage && path.dirname(this.ownGlobalStorage);
      const userRoot = globalHome && path.dirname(globalHome);
      // Qualified VS Code-compatible layout: extension files use DEFAULT-profile globalStorage, even when
      // the window's Memento uses a named profile. All listed User security keys are application-scoped.
      if (globalHome && userRoot && sameName(path.basename(globalHome), 'globalStorage')
        && sameName(path.basename(userRoot), 'User')) this.localUserRoot = userRoot;
      else this.observedLimitations.add('local-user-layout-unrecognized');
      this.observedLimitations.add('editor-layout-field-qualification-pending');
    } else if (options.hostFileSystem === 'remote-extension-host') {
      // Server extension files do not identify the client UI's settings or Memento database.
      this.observedLimitations.add('remote-ui-state-unavailable');
    } else this.observedLimitations.add('host-file-system-unqualified');
  }

  /** Host-private status codes only: no paths, filenames, excerpts or credentials for a log/ledger. */
  get limitations(): readonly SecurityControlLocationLimitation[] { return [...this.observedLimitations]; }

  async getLocations(target?: string): Promise<readonly SecurityControlArtifactLocation[]> {
    const locations: SecurityControlArtifactLocation[] = [];
    if (this.localUserRoot) {
      locations.push({ kind: 'user-settings', path: path.join(this.localUserRoot, 'settings.json') });
      locations.push({ kind: 'global-state', path: path.join(this.localUserRoot, 'globalStorage', 'state.vscdb'), binaryState: true });
      await this.readRegisteredProfileLocations(this.localUserRoot);
      for (const database of [...this.retainedProfileDatabases]) {
        const physical = await physicalFuturePath(database);
        if (physical) this.retainedProfileDatabases.add(physical);
      }
      for (const database of this.retainedProfileDatabases) locations.push({ kind: 'global-state', path: database, binaryState: true });
      const workspaceStorage = fileStoragePath(this.options.workspaceStorageUri);
      if (workspaceStorage) locations.push({ kind: 'workspace-state', path: path.join(path.dirname(workspaceStorage), 'state.vscdb'), binaryState: true });
    }
    if (this.options.customGatewayRegistryPath && path.isAbsolute(this.options.customGatewayRegistryPath)) {
      locations.push({ kind: 'gateway-profiles', path: this.options.customGatewayRegistryPath });
    }
    if (this.ownGlobalStorage) await this.addSavedTeamLocations(locations, path.join(this.ownGlobalStorage, 'teams'), target);
    for (const location of this.options.runtimeLocations?.() ?? []) {
      // These are exact host-published files; cloning keeps callers from mutating a backend's registration.
      locations.push({ ...location });
    }
    const seen = new Set<string>();
    const distinct: SecurityControlArtifactLocation[] = [];
    for (const location of locations) {
      const physical = await physicalFuturePath(location.path);
      const key = `${location.kind}\0${pathKey(physical ?? location.path)}\0${location.binaryState === true}`;
      if (seen.has(key)) continue;
      seen.add(key); distinct.push(location);
    }
    return distinct;
  }

  private async readRegisteredProfileLocations(userRoot: string): Promise<void> {
    let metadata: unknown;
    try { metadata = JSON.parse(await fs.readFile(path.join(userRoot, 'globalStorage', 'storage.json'), 'utf8')); }
    catch (error) {
      if (errorCode(error) !== 'ENOENT') this.observedLimitations.add('profile-metadata-unreadable');
      return; // Already seen host profile paths remain protected after malformed/replaced metadata.
    }
    if (!record(metadata) || !Array.isArray(metadata.userDataProfiles)) {
      if (!record(metadata) || metadata.userDataProfiles !== undefined) this.observedLimitations.add('profile-metadata-unreadable');
      return;
    }
    const profilesHome = path.join(userRoot, 'profiles');
    const physicalHome = await physicalFuturePath(profilesHome);
    if (!physicalHome) { this.observedLimitations.add('profile-location-unusable'); return; }
    for (const entry of metadata.userDataProfiles) {
      if (!record(entry) || typeof entry.name !== 'string' || !entry.name.trim()) continue;
      if (record(entry.useDefaultFlags) && entry.useDefaultFlags.globalState === true) continue;
      const location = profileLocation(entry.location, profilesHome);
      const physicalParent = location && await physicalFuturePath(path.dirname(location));
      if (!location || !physicalParent || pathKey(physicalParent) !== pathKey(physicalHome)
        || sameName(path.basename(location), '.') || sameName(path.basename(location), '..')) {
        this.observedLimitations.add('profile-location-unusable'); continue;
      }
      // A registered final profile-directory link is real host storage too. Do not apply a file-grant
      // subtree escape rule to that actual host DB: the classifier follows its physical identity.
      this.retainedProfileDatabases.add(path.join(location, 'globalStorage', 'state.vscdb'));
    }
  }

  private async addSavedTeamLocations(locations: SecurityControlArtifactLocation[], teamsRoot: string, target?: string): Promise<void> {
    try {
      for (const entry of await fs.readdir(teamsRoot, { withFileTypes: true })) {
        // Same direct-file/lowercase .json family the real saved-team loader reads. No sessions or subtrees.
        if (entry.isFile() && entry.name.endsWith('.json')) locations.push({ kind: 'saved-global-team', path: path.join(teamsRoot, entry.name) });
      }
    } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    if (!target || !path.isAbsolute(target)) return;
    const physicalTarget = await physicalFuturePath(target);
    const physicalRoot = await physicalFuturePath(teamsRoot);
    if (!physicalTarget || !physicalRoot || !path.basename(physicalTarget).endsWith('.json')
      || pathKey(path.dirname(physicalTarget)) !== pathKey(physicalRoot)) return;
    try { if (!(await fs.stat(physicalTarget)).isFile()) return; }
    catch (error) { if (errorCode(error) !== 'ENOENT') return; }
    // A newly created direct JSON team becomes host-owned when the existing loader reads it. Include its
    // precise prospective name before that first write; a members-field comparison still ignores label edits.
    locations.push({ kind: 'saved-global-team', path: physicalTarget });
  }
}

function fileStoragePath(uri: SecurityControlStorageUri | undefined): string | undefined {
  return uri?.scheme === 'file' && path.isAbsolute(uri.fsPath) ? path.resolve(uri.fsPath) : undefined;
}

function profileLocation(value: unknown, profilesHome: string): string | undefined {
  if (typeof value === 'string' && value) return path.resolve(profilesHome, value);
  if (!record(value) || (value.scheme !== 'file' && value.scheme !== 'vscode-userdata') || typeof value.path !== 'string') return undefined;
  const authority = typeof value.authority === 'string' ? value.authority : '';
  if (process.platform === 'win32') {
    const native = authority ? `\\\\${authority}${value.path.replace(/\//g, '\\')}` : value.path.replace(/^\/([a-z]:\/)/i, '$1');
    return path.isAbsolute(native) ? path.resolve(native) : undefined;
  }
  return !authority && path.isAbsolute(value.path) ? path.resolve(value.path) : undefined;
}

/** Resolve an existing referent, or a prospective path through its nearest existing physical parent. */
async function physicalFuturePath(target: string): Promise<string | undefined> {
  try { return await fs.realpath(target); }
  catch (error) { if (errorCode(error) !== 'ENOENT') return undefined; }
  const parent = path.dirname(target);
  if (parent === target) return undefined;
  const physicalParent = await physicalFuturePath(parent);
  return physicalParent ? path.join(physicalParent, path.basename(target)) : undefined;
}

function pathKey(value: string): string { const normalized = path.resolve(value); return process.platform === 'win32' ? normalized.toLowerCase() : normalized; }
function sameName(left: string, right: string): boolean { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function errorCode(error: unknown): string | undefined { return error !== null && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined; }
