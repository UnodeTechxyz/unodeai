import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathInsideOrEqual } from '../backend/pathContainment';
export const SKILL_RESOURCE_CHANGED_MESSAGE = 'Command not run: its skill resource grant or installed path changed while waiting. Load the skill again for its current resources; other work can continue.';

/** Readable installed resources, not a document write root or an execution grant. */
export interface SkillResourceScope {
  readonly name: string;
  readonly root: string;
  readonly digest: string;
  current(target?: string): boolean;
}

export function installedSkillResourceScope(
  document: { name: string; directory: string; digest: string },
  granted: () => boolean,
): SkillResourceScope {
  const root = document.directory;
  return { name: document.name, root, digest: document.digest, current: (target = root) => {
    try {
      if (!granted() || !isPathInsideOrEqual(root, target) || path.relative(root, fs.realpathSync(root)) !== '') return false;
      if (path.relative(root, target).split(path.sep).some(part => (process.platform === 'win32' ? part.toLowerCase() : part) === '__pycache__')) return false;
      const physical = fs.realpathSync(target);
      if (!isPathInsideOrEqual(root, physical)) return false;
      for (let cursor = path.resolve(target); ; cursor = path.dirname(cursor)) {
        const stat = fs.lstatSync(cursor);
        const atRoot = path.relative(cursor, root) === '';
        if (stat.isSymbolicLink() || (atRoot && !stat.isDirectory())) return false;
        if (atRoot) break;
        if (!isPathInsideOrEqual(root, path.dirname(cursor))) return false;
      }
      return true;
    } catch { return false; }
  } };
}
