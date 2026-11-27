import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
const LIMIT = 4 * 1024 * 1024;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const same = (left: string, right: string) => path.relative(left, right) === '';
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
export class SkillValidationError extends Error {
  constructor(public readonly issues: string[]) { super(`Invalid skills: ${issues.slice(0, 5).join('; ')}`); this.name = 'SkillValidationError'; }
}
const fail = (issue: string): never => { throw new SkillValidationError([issue]); };
export type SkillResourceEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';
export function skillResourceText(bytes: Buffer): { text: string; encoding: SkillResourceEncoding } | undefined {
  const encoding: SkillResourceEncoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  try { const text = new TextDecoder(encoding, { fatal: true }).decode(bytes); if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) return undefined; return { text, encoding }; } catch { return undefined; }
}
export interface SkillResourceFile { path: string; bytes: number; sha256: string; kind: 'text' | 'binary'; encoding?: SkillResourceEncoding }
export interface SkillResourceTree { root: string; digest: string; files: ReadonlyMap<string, Buffer>; inventory: SkillResourceFile[]; ignoredCachePresent: boolean; bytes: number }
/** Common byte-capture/digest: regular resources of every language, no execution and no snapshot copy. */
export function snapshotSkillTree(root: string): SkillResourceTree {
  const rootInfo = fs.lstatSync(root); const realRoot = fs.realpathSync(root); if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || !same(root, realRoot)) return fail('skill root identity changed');
  const files = new Map<string, Buffer>(); const inventory: SkillResourceFile[] = []; let ignoredCachePresent = false; let total = 0;
  const visit = (directory: string) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const full = path.join(directory, entry.name); const relative = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isSymbolicLink()) return fail('symbolic links are not allowed in skills');
    if (entry.isDirectory() && (process.platform === 'win32' ? entry.name.toLowerCase() : entry.name) === '__pycache__') { ignoredCachePresent = true; continue; }
    if (entry.isDirectory()) { if (!same(fs.realpathSync(full), full) || fs.lstatSync(full).isSymbolicLink()) return fail('skill directory identity changed'); visit(full); continue; }
    if (!entry.isFile()) return fail('skill resource is not a regular file');
    const before = fs.lstatSync(full); const realBefore = fs.realpathSync(full); if (before.isSymbolicLink() || !before.isFile() || !inside(realRoot, realBefore)) return fail('skill file resolves outside root');
    if (before.size > LIMIT - total) return fail('skill tree exceeds the 4 MiB limit');
    const descriptor = fs.openSync(full, 'r'); let bytes: Buffer;
    try { const opened = fs.fstatSync(descriptor); if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return fail('skill file identity changed');
      const chunks: Buffer[] = []; let length = 0;
      for (;;) { const chunk = Buffer.allocUnsafe(Math.min(65536, LIMIT - total - length + 1)); const count = fs.readSync(descriptor, chunk, 0, chunk.length, null); if (!count) break; length += count; if (total + length > LIMIT) return fail('skill tree exceeds the 4 MiB limit'); chunks.push(chunk.subarray(0, count)); }
      bytes = Buffer.concat(chunks, length);
    } finally { fs.closeSync(descriptor); }
    const after = fs.lstatSync(full); if (after.isSymbolicLink() || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || !same(fs.realpathSync(full), realBefore)) return fail('skill file changed while reading');
    total += bytes.length; const decoded = skillResourceText(bytes); files.set(relative, bytes); inventory.push({ path: relative, bytes: bytes.length, sha256: sha(bytes), kind: decoded ? 'text' : 'binary', ...(decoded ? { encoding: decoded.encoding } : {}) });
  } };
  visit(root); const hash = createHash('sha256'); const sorted = new Map([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  for (const [relative, bytes] of sorted) { hash.update(relative, 'utf8'); hash.update('\0'); hash.update(bytes); hash.update('\0'); }
  return { root: realRoot, digest: hash.digest('hex'), files: sorted, inventory: inventory.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), ignoredCachePresent, bytes: total };
}
