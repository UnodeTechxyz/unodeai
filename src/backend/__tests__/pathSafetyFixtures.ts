/*
 * Fixtures for the four defects the v0.9.97 P0 inventory found in released v0.9.96 (S1, A1, A2, A3). Every
 * fixture is a new temporary folder: a `.git` or `.unode` folder here is a stand-in holding one marker file, never
 * a real repository's, and a canary is a harmless marker string, never a credential.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const created: string[] = [];

/** A new temporary folder, removed by `removeTemporaryFolders`. */
export async function temporaryFolder(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  return root;
}

export async function removeTemporaryFolders(): Promise<void> {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
}

export async function exists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/** A workspace holding stand-in `.git` and `.unode` folders, each with one marker file. */
export async function protectedFixture(): Promise<string> {
  const root = await temporaryFolder('unode-s1-');
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await fs.mkdir(path.join(root, '.unode'));
  await fs.writeFile(path.join(root, '.unode', 'marker.json'), '{}', 'utf8');
  return root;
}

export async function protectedFoldersIntact(root: string): Promise<boolean> {
  return await exists(path.join(root, '.git', 'HEAD')) && await exists(path.join(root, '.unode', 'marker.json'));
}

/**
 * The 8.3 short name the volume gave the folder `longName` inside `dir`, or undefined when it has none. Whether a
 * volume makes short names is its own setting, so a test discovers the name and never assumes `GIT~1`.
 */
export function shortNameOf(dir: string, longName: string): string | undefined {
  const listing = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', '/a', dir], { encoding: 'utf8' });
  for (const line of listing.split(/\r?\n/)) {
    const match = /<DIR>\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (match && match[2].toLowerCase() === longName.toLowerCase()) {
      return match[1];
    }
  }
  return undefined;
}
