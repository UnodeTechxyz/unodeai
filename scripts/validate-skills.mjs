import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateSkillCatalog, SKILL_CATALOG_REGENERATE_COMMAND } from './generate-skill-catalog.mjs';
import { publishedSkillResources } from './published-skill-resources.mjs';

const project = process.cwd();
const issues = [];
let published;
try { published = publishedSkillResources(resolve(project, 'skills')); }
catch (error) { issues.push(error.message); }
if (published) {
  const catalog = JSON.parse(readFileSync(resolve(project, 'marketplace', 'skills.json'), 'utf8'));
  const catalogued = new Set(catalog.map(skill => skill.id));
  for (const skill of catalog) {
    if (!published.names.has(skill.id)) issues.push('skills/: missing catalogued skill ' + skill.id);
  }
  for (const name of published.names) {
    if (!catalogued.has(name)) issues.push('marketplace/skills.json: no entry for shipped skill ' + name + '; Agent Builder cannot offer it');
  }
  const generated = generateSkillCatalog(project);
  if (readFileSync(generated.catalogPath, 'utf8') !== generated.text) {
    const which = generated.changed.length ? 'the body of ' + generated.changed.join(', ') + ' differs from SKILL.md'
      : 'the file is not in its generated form';
    issues.push('marketplace/skills.json: ' + which + '. Run ' + SKILL_CATALOG_REGENERATE_COMMAND + ' to regenerate it from skills/.');
  }
}
if (issues.length) {
  console.error('Skill validation failed:\n- ' + issues.join('\n- '));
  process.exitCode = 1;
} else console.log('Skill validation passed (' + published.names.size + ' SKILL.md files and exact bundled resource identities).');
