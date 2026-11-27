import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillResourceTree, SkillResourceFile } from './SkillResourceTree';
export const SKILL_RESOURCE_MANIFEST = 'resource-manifest.json';
export interface BundledSkillIdentity { name: string; category: string; digest: string; files: SkillResourceFile[] }
export interface SkillResourceManifest { schema_version: 1; skills: BundledSkillIdentity[] }
export interface SkillIdentityCatalog { status: 'available' | 'missing' | 'unreadable'; entries: ReadonlyMap<string, BundledSkillIdentity> }
const name = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Installed identity metadata is data, not an independent publisher signature or an execution grant. */
export function readSkillIdentityCatalog(root: string): SkillIdentityCatalog {
  const file = path.join(root, SKILL_RESOURCE_MANIFEST);
  try {
    const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile()) throw Error('invalid manifest file');
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as SkillResourceManifest; if (value.schema_version !== 1 || !Array.isArray(value.skills)) throw Error('invalid resource manifest');
    const entries = new Map<string, BundledSkillIdentity>();
    for (const entry of value.skills) {
      if (!entry || !name(entry.name) || !name(entry.category) || !hash(entry.digest) || !Array.isArray(entry.files) || entries.has(entry.name)) throw Error('invalid skill identity');
      const paths = new Set<string>();
      for (const item of entry.files) {
        if (!item || typeof item.path !== 'string' || !item.path || item.path.startsWith('/') || item.path.includes('\\') || item.path.includes(':') || item.path.includes('\0') || item.path.split('/').some(part => !part || part === '.' || part === '..')
          || paths.has(item.path) || !hash(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !['text', 'binary'].includes(item.kind)) throw Error('invalid resource identity');
        paths.add(item.path);
      }
      entries.set(entry.name, entry);
    }
    return { status: 'available', entries };
  } catch (error) { return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', entries: new Map() }; }
}
export function skillResourceIdentity(tree: SkillResourceTree, category: string, name: string, catalog: SkillIdentityCatalog) {
  const expected = catalog.entries.get(name); const matches = expected?.category === category && expected.digest === tree.digest;
  return { status: matches ? 'matches-bundled-record' : expected ? 'modified' : catalog.status === 'available' ? 'unlisted' : 'unknown',
    expected_digest: expected?.digest ?? null, ignored_cache_present: tree.ignoredCachePresent,
    ...(matches ? {} : { notice: expected || catalog.status === 'available' ? 'Installed skill files were modified. Reinstalling UnodeAi restores the published files; other work can continue.' : 'Bundled skill identity is unavailable. These files cannot be reported as published; reinstalling UnodeAi restores the bundled identity record. Other work can continue.' }) };
}
