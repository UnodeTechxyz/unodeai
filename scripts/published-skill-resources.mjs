import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundledResourceTrees } from './generate-skill-resource-manifest.mjs';
import { parseSkillMarkdown, validateSkillTree, skillResourceText } from './skill-runtime-validation.mjs';

export const BINARY_INVENTORY_FILE = 'binary-resource-inventory.json';
const compiledSuffix = /\.(?:exe|dll|node|wasm|pyc|jar|class|so|dylib|pyd|o|a|lib)$/i;
const nativeHeader = bytes => (bytes.length >= 64 && bytes.subarray(0, 2).toString('ascii') === 'MZ'
  && bytes.readUInt32LE(60) <= bytes.length - 4 && bytes.subarray(bytes.readUInt32LE(60), bytes.readUInt32LE(60) + 4).equals(Buffer.from('PE\0\0')))
  || ['7f454c46', '0061736d', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(bytes.subarray(0, 4).toString('hex'));

/** Published source/resource admission. The 107 selected bundled executable-binary inventory is empty. */
export function publishedSkillResources(skillsRoot, listedFiles) {
  const records = bundledResourceTrees(skillsRoot);
  if (!records.length) throw Error('Published skills contain no SKILL.md files');
  const inventory = JSON.parse(readFileSync(join(skillsRoot, BINARY_INVENTORY_FILE), 'utf8'));
  if (inventory.schema_version !== 1 || !Array.isArray(inventory.resources) || inventory.resources.length !== 0
    || Object.keys(inventory).some(key => !['schema_version', 'resources'].includes(key))) {
    throw Error('v0.9.107 bundled skill executable-binary inventory must be explicitly empty; a binary addition needs a reviewed amendment');
  }
  const names = new Set(); const admitted = new Set();
  for (const { identity, tree } of records) {
    if (names.has(identity.name)) throw Error('Duplicate published skill name: ' + identity.name);
    names.add(identity.name);
    validateSkillTree(tree.root);
    const decoded = skillResourceText(tree.files.get('SKILL.md'));
    if (!decoded) throw Error('Published SKILL.md is not readable text: ' + identity.name);
    const parsed = parseSkillMarkdown(decoded.text, identity.name + '/SKILL.md');
    if (parsed.name !== identity.name) throw Error('Published skill name does not match its folder: ' + identity.name);
    if (!/\b(?:when|whenever|during|use)\b/i.test(parsed.description) || parsed.description.split(/\s+/).filter(Boolean).length < 5) {
      throw Error(identity.name + ': description must state what it does and when to use it');
    }
    for (const [relative, bytes] of tree.files) {
      if (compiledSuffix.test(relative) || nativeHeader(bytes)) throw Error('Uninventoried bundled executable/loadable binary: ' + identity.name + '/' + relative);
      admitted.add('skills/' + identity.category + '/' + identity.name + '/' + relative);
    }
  }
  const expected = JSON.stringify({ schema_version: 1, skills: records.map(record => record.identity) }, null, 2) + '\n';
  if (readFileSync(join(skillsRoot, 'resource-manifest.json'), 'utf8') !== expected) {
    throw Error('Bundled skill resource identities differ; run node scripts/generate-skill-resource-manifest.mjs');
  }
  if (listedFiles) {
    const listed = new Set(listedFiles.map(file => file.replaceAll('\\', '/')));
    for (const file of [...admitted, 'skills/resource-manifest.json', 'skills/' + BINARY_INVENTORY_FILE]) {
      if (!listed.has(file)) throw Error('Bundled VSIX is missing a recorded skill resource: ' + file);
    }
    for (const file of listed) {
      if (/^skills\/[^/]+\/[^/]+\//.test(file) && !admitted.has(file)) throw Error('Bundled VSIX contains an unrecorded skill resource: ' + file);
    }
  }
  return { records, admitted, names };
}
