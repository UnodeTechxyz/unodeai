import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(process.cwd(), 'skills');
const legacy = JSON.parse(readFileSync(resolve(process.cwd(), 'marketplace', 'skills.json'), 'utf8'));
const issues = [];
const names = new Set();
const executable = /\.(?:exe|dll|node|wasm|cmd|bat|ps1|sh|js|cjs|mjs|ts)$/i;
const bundledActionHandlers = new Set(['unode.echo-json.v1']);

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
      validateTree(skillDir);
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

function validateTree(directory) {
  const manifestPath = join(directory, 'unode-actions.json');
  if (!existsSync(manifestPath)) {
    walkInstructionOnly(directory);
    return;
  }
  let actions = [];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (Object.keys(parsed).some((key) => key !== 'version' && key !== 'actions')) throw new Error('contains an unknown top-level field');
    if (parsed.version !== 1 || !Array.isArray(parsed.actions) || parsed.actions.length < 1 || parsed.actions.length > 16) {
      throw new Error('must contain version 1 and 1-16 actions');
    }
    const seen = new Set();
    actions = parsed.actions.map((action, index) => {
      const allowed = new Set(['id', 'description', 'handler', 'declaredEffects']);
      if (!action || typeof action !== 'object' || Array.isArray(action) || Object.keys(action).some((key) => !allowed.has(key))) {
        throw new Error(`action ${index + 1} is invalid`);
      }
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(action.id) || seen.has(action.id)) throw new Error(`action ${index + 1} has an invalid or duplicate id`);
      seen.add(action.id);
      if (!action.description || typeof action.description !== 'string' || action.description.length > 1024) throw new Error(`action ${action.id} has an invalid description`);
      if (typeof action.handler !== 'string' || !bundledActionHandlers.has(action.handler)) {
        throw new Error(`action ${action.id} handler is not compiled into the UnodeAi action runner`);
      }
      if (!Array.isArray(action.declaredEffects) || action.declaredEffects.some((effect) => !['read-workspace', 'write-workspace', 'network', 'child-process'].includes(effect))) {
        throw new Error(`action ${action.id} has invalid declaredEffects`);
      }
      return action;
    });
  } catch (error) {
    issues.push(`${manifestPath}: ${error.message}`);
  }
  walkExecutableProfile(directory, directory);
}

function walkExecutableProfile(rootDir, directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      issues.push(`${full}: symbolic links are forbidden in v1 skills`);
    } else if (entry.isDirectory()) {
      if (/^(?:scripts?|bin)$/i.test(entry.name)) issues.push(`${full}: executable Skill directories are forbidden; use a compiled handler id`);
      else walkExecutableProfile(rootDir, full);
    } else if (executable.test(entry.name)) {
      issues.push(`${full}: executable Skill payloads are forbidden; use a compiled handler id`);
    }
  }
}

function walkInstructionOnly(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) issues.push(`${full}: symbolic links are forbidden in v1 skills`);
    else if (entry.isDirectory()) {
      if (/^(?:scripts?|bin)$/i.test(entry.name)) issues.push(`${full}: executable skill directories are forbidden in v1`);
      else walkInstructionOnly(full);
    } else if (executable.test(entry.name)) issues.push(`${full}: executable skill payloads are forbidden in v1`);
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
