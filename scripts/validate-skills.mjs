import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(process.cwd(), 'skills');
const legacy = JSON.parse(readFileSync(resolve(process.cwd(), 'marketplace', 'skills.json'), 'utf8'));
const issues = [];
const names = new Set();
const executable = /\.(?:exe|dll|node|wasm|cmd|bat|ps1|sh|js|cjs|mjs|ts)$/i;

if (!existsSync(root)) {
  issues.push('skills/: missing directory');
} else if (lstatSync(root).isSymbolicLink()) {
  issues.push('skills/: symbolic links are forbidden in v1 skills');
} else {
  const realRoot = realpathSync(root);
  for (const category of readdirSync(root, { withFileTypes: true })) {
    if (category.isSymbolicLink()) {
      issues.push(`${join(root, category.name)}: symbolic links are forbidden in v1 skills`);
      continue;
    }
    if (!category.isDirectory() || category.name.startsWith('.')) continue;
    const categoryPath = join(root, category.name);
    for (const skill of readdirSync(categoryPath, { withFileTypes: true })) {
      if (skill.isSymbolicLink()) {
        issues.push(`${join(categoryPath, skill.name)}: symbolic links are forbidden in v1 skills`);
        continue;
      }
      if (!skill.isDirectory() || skill.name.startsWith('.')) continue;
      const skillDir = realpathSync(join(categoryPath, skill.name));
      if (!inside(realRoot, skillDir)) {
        issues.push(`${skillDir}: escapes skills root`);
        continue;
      }
      walkInstructionOnly(skillDir);
      const file = join(skillDir, 'SKILL.md');
      if (!existsSync(file)) {
        issues.push(`${file}: missing`);
        continue;
      }
      validate(file, skill.name);
    }
  }
}

for (const skill of legacy) {
  if (!names.has(skill.id)) {
    issues.push(`skills/: missing migrated legacy skill ${skill.id}`);
  }
}

if (issues.length) {
  console.error(`Skill validation failed:\n- ${issues.join('\n- ')}`);
  process.exit(1);
}
console.log(`Skill validation passed (${names.size} SKILL.md files).`);

function validate(file, folderName) {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    issues.push(`${file}: frontmatter must start with ---`);
    return;
  }
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) {
    issues.push(`${file}: frontmatter must end with ---`);
    return;
  }
  const values = new Map();
  for (const line of text.slice(4, end).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^(name|description):\s*(.+?)\s*$/.exec(line);
    if (!match || values.has(match?.[1])) {
      issues.push(`${file}: frontmatter only permits one name and one description scalar`);
      return;
    }
    values.set(match[1], unquote(match[2]));
  }
  const name = (values.get('name') || '').trim();
  const description = (values.get('description') || '').trim();
  const body = text.slice(end + '\n---\n'.length).trim();
  if (name.length < 4 || name.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    issues.push(`${file}: name must be 4-64 lowercase kebab-case characters`);
  }
  if (name.includes('<') || name.includes('>') || name.split('-').some((word) => word === 'anthropic' || word === 'claude')) {
    issues.push(`${file}: name contains reserved vocabulary or markup`);
  }
  if (!description || description.length > 1024 || !/\b(?:when|whenever|during|use)\b/i.test(description) || description.split(/\s+/).filter(Boolean).length < 5) {
    issues.push(`${file}: description must be <=1024 characters and state what it does and when to use it`);
  }
  if (!body) issues.push(`${file}: body must not be empty`);
  if (name !== folderName) issues.push(`${file}: name must match folder ${folderName}`);
  if (names.has(name)) issues.push(`${file}: duplicate skill name ${name}`);
  names.add(name);
}

function walkInstructionOnly(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      issues.push(`${full}: symbolic links are forbidden in v1 skills`);
    } else if (entry.isDirectory()) {
      if (/^(?:scripts?|bin)$/i.test(entry.name)) {
        issues.push(`${full}: executable skill directories are forbidden in v1`);
      } else {
        walkInstructionOnly(full);
      }
    } else if (executable.test(entry.name)) {
      issues.push(`${full}: executable skill payloads are forbidden in v1`);
    }
  }
}

function inside(rootPath, candidate) {
  const rel = relative(rootPath, candidate);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('..');
}

function unquote(value) {
  return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1)
    : value;
}
