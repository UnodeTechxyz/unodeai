import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
// Compile only this fixed, pure host scanner. No skill-supplied module is imported or executed.
const scannerPath = fileURLToPath(new URL('../src/skills/SkillResourceTree.ts', import.meta.url));
const { code } = await transform(fs.readFileSync(scannerPath, 'utf8'), { loader: 'ts', format: 'esm', target: 'node18' });
const { snapshotSkillTree } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
export function bundledResourceTrees(root) {
  const skills = [];
  if (fs.lstatSync(root).isSymbolicLink()) throw Error('Symbolic skill root');
  for (const category of fs.readdirSync(root, { withFileTypes: true })) {
    if (category.isSymbolicLink()) throw Error('Symbolic skill category');
    if (!category.isDirectory() || category.name.startsWith('.')) continue;
    for (const entry of fs.readdirSync(path.join(root, category.name), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('Symbolic skill folder');
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const tree = snapshotSkillTree(path.join(root, category.name, entry.name));
      if (tree.ignoredCachePresent) throw Error('Publishing rejects __pycache__ inside ' + entry.name);
      if (!tree.files.has('SKILL.md')) throw Error('Missing SKILL.md: ' + entry.name);
      skills.push({ identity: { name: entry.name, category: category.name, digest: tree.digest, files: tree.inventory }, tree });
    }
  }
  return skills.sort((left, right) => left.identity.name < right.identity.name ? -1 : left.identity.name > right.identity.name ? 1 : 0);
}
export function bundledResourceManifest(root) {
  return { schema_version: 1, skills: bundledResourceTrees(root).map(record => record.identity) };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = path.resolve('skills'); const file = path.join(root, 'resource-manifest.json'); const text = JSON.stringify(bundledResourceManifest(root), null, 2) + '\n';
  if (process.argv.includes('--check')) { if (fs.readFileSync(file, 'utf8') !== text) throw Error('Bundled skill resource identities differ; regenerate with node scripts/generate-skill-resource-manifest.mjs'); }
  else fs.writeFileSync(file, text);
  console.log('Bundled skill resource identities ' + (process.argv.includes('--check') ? 'checked' : 'generated') + '.');
}
