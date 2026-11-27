import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isPathInsideOrEqual } from './pathContainment';

const VARIABLE = 'PYTHONPYCACHEPREFIX';
type Environment = Readonly<Record<string, string | null | undefined>>;
export type PythonCacheSource = 'user' | 'unode' | 'unavailable';

function explicitEntry(environment: Environment, platform: NodeJS.Platform) {
  return Object.entries(environment).reverse().find(([key, value]) => value !== undefined
    && (platform === 'win32' ? key.toUpperCase() : key) === VARIABLE);
}

/** Preserve explicit empty values and Windows-cased values. Status contains no user environment contents. */
export function pythonCacheEnvironment(
  environment: NodeJS.ProcessEnv,
  ownedRoot: string | undefined,
  platform: NodeJS.Platform = process.platform,
  agentEnvironment: NodeJS.ProcessEnv = {},
): { environment: NodeJS.ProcessEnv; source: PythonCacheSource } {
  const user = explicitEntry(agentEnvironment, platform) ?? explicitEntry(environment, platform);
  if (user) {
    const merged = { ...environment };
    for (const key of Object.keys(merged)) if ((platform === 'win32' ? key.toUpperCase() : key) === VARIABLE) delete merged[key];
    merged[user[0]] = user[1] ?? undefined;
    return { environment: merged, source: 'user' };
  }
  return ownedRoot ? { environment: { ...environment, [VARIABLE]: ownedRoot }, source: 'unode' }
    : { environment: { ...environment }, source: 'unavailable' };
}

/** Creation env overrides terminal.integrated.env; never resurrect a value the person removed there. */
export function terminalPythonCacheEnvironment(
  inherited: NodeJS.ProcessEnv,
  terminalSetting: Environment,
  ownedRoot: string | undefined,
  platform: NodeJS.Platform = process.platform,
  agentEnvironment: NodeJS.ProcessEnv = {},
): { environment: Record<string, string>; source: PythonCacheSource } {
  if (explicitEntry(terminalSetting, platform)) return { environment: {}, source: 'user' };
  const agent = explicitEntry(agentEnvironment, platform);
  if (agent && typeof agent[1] === 'string') return { environment: { [agent[0]]: agent[1] }, source: 'user' };
  if (explicitEntry(inherited, platform)) return { environment: {}, source: 'user' };
  return ownedRoot ? { environment: { [VARIABLE]: ownedRoot }, source: 'unode' }
    : { environment: {}, source: 'unavailable' };
}

export interface OwnedPythonCache {
  readonly root: string;
  /** Recheck before starting a child or granting this exact owned root to a native sandbox. */
  current(): boolean;
}

/** Optional infrastructure only: a cache failure must not pause an otherwise usable agent. */
export function prepareOwnedPythonCache(
  storageRoot: string | undefined,
  workspaceRoots: readonly string[],
  agentId = '@host',
  workspaceIdentity = JSON.stringify(workspaceRoots.map(root => path.resolve(root)).sort()),
): OwnedPythonCache | undefined {
  if (!storageRoot || !path.isAbsolute(storageRoot)) return undefined;
  // Only the leaf is ever added to a native sandbox. Neither the shared parent nor another member's cache is granted.
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const root = path.join(storageRoot, 'python-cache', digest(workspaceIdentity), digest(agentId));
  const same = (left: string, right: string) => path.relative(left, right) === '';
  const outsideWorkspaces = () => !workspaceRoots.some(workspace => {
    let physical = workspace;
    try { physical = fs.realpathSync(workspace); } catch { /* lexical scope still applies */ }
    return isPathInsideOrEqual(workspace, root) || isPathInsideOrEqual(physical, root);
  });
  const physicalDirectory = (directory: string) => {
    const stat = fs.lstatSync(directory);
    return !stat.isSymbolicLink() && stat.isDirectory() && same(fs.realpathSync(directory), directory);
  };
  try {
    if (!outsideWorkspaces()) return undefined;
    // Never create through an existing redirected ancestor, including a linked global-storage path.
    let ancestor = root;
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return undefined;
      ancestor = parent;
    }
    if (!physicalDirectory(ancestor)) return undefined;
    fs.mkdirSync(root, { recursive: true });
    if (!physicalDirectory(root) || !outsideWorkspaces()) return undefined;
    const identity = fs.lstatSync(root, { bigint: true });
    return { root: fs.realpathSync(root), current: () => {
      try {
        const now = fs.lstatSync(root, { bigint: true });
        return physicalDirectory(root) && outsideWorkspaces() && now.dev === identity.dev && now.ino === identity.ino;
      } catch { return false; }
    } };
  } catch { return undefined; }
}
