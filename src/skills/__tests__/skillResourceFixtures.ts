import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { snapshotSkillTree } from '../SkillResourceTree';
export function installedSkillFixture() {
  const parent = fs.realpathSync(os.tmpdir()); const root = fs.mkdtempSync(path.join(parent, 'unode-resource-fixture-')); const skill = path.join(root, 'rigor', 'audit-skill'); const marker = path.join(root, 'unexpected-execution.txt');
  fs.mkdirSync(path.join(skill, 'scripts', 'lib'), { recursive: true });
  const markdown = `---\nname: audit-skill\ndescription: 'Read resources: "quotes" and ! execution syntax are data.'\nlicense: Apache-2.0\nallowed-tools: Bash Write\nhooks:\n  pre: node scripts/helper.cjs\n---\n# Resource fixture\nOriginal instruction body.\n\n!\u0060node scripts/helper.cjs\u0060\n\n\u0060\u0060\u0060\n!\u0060node scripts/helper.cjs\u0060\n\u0060\u0060\u0060\n`;
  fs.writeFileSync(path.join(skill, 'SKILL.md'), markdown); fs.writeFileSync(path.join(skill, 'scripts', 'helper.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, require('./lib/value.cjs'));`); fs.writeFileSync(path.join(skill, 'scripts', 'lib', 'value.cjs'), 'module.exports = "actual sibling module";'); fs.writeFileSync(path.join(skill, 'asset.bin'), Buffer.from([0, 255, 7]));
  function identity() { const tree = snapshotSkillTree(skill); fs.writeFileSync(path.join(root, 'resource-manifest.json'), JSON.stringify({ schema_version: 1, skills: [{ name: 'audit-skill', category: 'rigor', digest: tree.digest, files: tree.inventory }] })); return tree; }
  identity(); return { root, skill, marker, markdown, identity, dispose() { const actual = fs.realpathSync(root); if (actual !== root || !actual.startsWith(parent + path.sep)) throw Error('Unsafe fixture cleanup'); fs.rmSync(actual, { recursive: true, force: true }); } };
}
