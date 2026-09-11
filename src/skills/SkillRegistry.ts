/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Agent Skills registry
 *  SKILL.md files shipped with the extension are the runtime source of truth for procedural
 *  skills. The registry deliberately reads only extension-owned, validated files.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolSpec } from '../backend/WorkspaceTools';
import {
  hostToolFailed,
  hostToolRefused,
  hostToolSucceeded,
  type HostToolOutcome,
} from '../backend/toolSummary';

export const LOAD_SKILL_TOOL = 'load_skill';
export const READ_SKILL_FILE_TOOL = 'read_skill_file';

const MIN_SKILL_NAME_LENGTH = 4;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_BODY_CHARS = 24_000;
const MAX_SKILL_FILE_CHARS = 100_000;
const RESERVED_NAME_WORDS = new Set(['anthropic', 'claude']);
const EXECUTABLE_SKILL_FILE = /\.(?:exe|dll|node|wasm|cmd|bat|ps1|sh|js|cjs|mjs|ts)$/i;

export interface SkillMetadata {
  name: string;
  description: string;
  category: string;
}

export interface SkillDocument extends SkillMetadata {
  /** Realpath of the skill directory, never a workspace path. */
  directory: string;
  /** Full text after the YAML frontmatter. */
  body: string;
}

export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  body: string;
}

export type SkillPromptAccess = 'tools' | 'plugin' | 'metadata';

export class SkillValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid skills: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'SkillValidationError';
  }
}

/** Parse the deliberately small YAML subset used by our v1 instruction-only SKILL.md files. */
export function parseSkillMarkdown(markdown: string, label = 'SKILL.md'): ParsedSkillMarkdown {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new SkillValidationError([`${label}: YAML frontmatter must start with ---`]);
  }
  const close = normalized.indexOf('\n---\n', 4);
  if (close === -1) {
    throw new SkillValidationError([`${label}: YAML frontmatter must end with ---`]);
  }
  const values = new Map<string, string>();
  for (const line of normalized.slice(4, close).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    const match = /^(name|description):\s*(.+?)\s*$/.exec(line);
    if (!match) {
      throw new SkillValidationError([`${label}: frontmatter only permits name and description scalar fields`]);
    }
    if (values.has(match[1])) {
      throw new SkillValidationError([`${label}: frontmatter field ${match[1]} appears more than once`]);
    }
    values.set(match[1], unquoteYamlScalar(match[2]));
  }
  const name = values.get('name') ?? '';
  const description = values.get('description') ?? '';
  const body = normalized.slice(close + '\n---\n'.length).trim();
  validateSkillFields({ name, description, body }, label);
  return { name, description, body };
}

export function validateSkillFields(
  skill: Pick<ParsedSkillMarkdown, 'name' | 'description' | 'body'>,
  label = 'SKILL.md'
): void {
  const issues: string[] = [];
  const name = skill.name.trim();
  if (name.length < MIN_SKILL_NAME_LENGTH || name.length > MAX_SKILL_NAME_LENGTH) {
    issues.push(`${label}: name must be ${MIN_SKILL_NAME_LENGTH}-${MAX_SKILL_NAME_LENGTH} characters`);
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    issues.push(`${label}: name must be lowercase kebab-case`);
  }
  if (name.includes('<') || name.includes('>') || name.split('-').some((word) => RESERVED_NAME_WORDS.has(word))) {
    issues.push(`${label}: name contains reserved vocabulary or markup`);
  }

  const description = skill.description.trim();
  if (!description || description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    issues.push(`${label}: description must be 1-${MAX_SKILL_DESCRIPTION_LENGTH} characters`);
  }
  if (!skill.body.trim()) {
    issues.push(`${label}: skill body must not be empty`);
  }
  if (issues.length > 0) {
    throw new SkillValidationError(issues);
  }
}

export class SkillRegistry {
  private readonly byName: Map<string, SkillDocument>;

  private constructor(documents: SkillDocument[]) {
    this.byName = new Map(documents.map((document) => [document.name, document]));
  }

  static load(skillsRoot: string): SkillRegistry {
    if (fs.lstatSync(skillsRoot).isSymbolicLink()) {
      throw new SkillValidationError([`${skillsRoot}: symbolic links are not allowed in v1 skills`]);
    }
    const root = fs.realpathSync(skillsRoot);
    const documents: SkillDocument[] = [];
    const issues: string[] = [];

    for (const categoryEntry of fs.readdirSync(root, { withFileTypes: true })) {
      if (categoryEntry.isSymbolicLink()) {
        issues.push(`${path.join(root, categoryEntry.name)}: symbolic links are not allowed in v1 skills`);
        continue;
      }
      if (!categoryEntry.isDirectory() || categoryEntry.name.startsWith('.')) {
        continue;
      }
      const category = categoryEntry.name;
      const categoryPath = path.join(root, category);
      for (const skillEntry of fs.readdirSync(categoryPath, { withFileTypes: true })) {
        if (skillEntry.isSymbolicLink()) {
          issues.push(`${path.join(categoryPath, skillEntry.name)}: symbolic links are not allowed in v1 skills`);
          continue;
        }
        if (!skillEntry.isDirectory() || skillEntry.name.startsWith('.')) {
          continue;
        }
        const directory = fs.realpathSync(path.join(categoryPath, skillEntry.name));
        const skillPath = path.join(directory, 'SKILL.md');
        if (!isInside(root, directory)) {
          issues.push(`${skillPath}: skill directory escapes the skills root`);
          continue;
        }
        if (!fs.existsSync(skillPath)) {
          issues.push(`${skillPath}: missing SKILL.md`);
          continue;
        }
        try {
          assertInstructionOnlyTree(directory);
          const parsed = parseSkillMarkdown(fs.readFileSync(skillPath, 'utf8'), skillPath);
          if (parsed.name !== skillEntry.name) {
            throw new SkillValidationError([`${skillPath}: name must match its folder name (${skillEntry.name})`]);
          }
          documents.push({ ...parsed, category, directory });
        } catch (error) {
          issues.push(...asIssues(error, skillPath));
        }
      }
    }

    const names = new Set<string>();
    for (const document of documents) {
      if (names.has(document.name)) {
        issues.push(`${document.name}: duplicate skill name`);
      }
      names.add(document.name);
    }
    if (documents.length === 0) {
      issues.push(`${skillsRoot}: no SKILL.md files found`);
    }
    if (issues.length > 0) {
      throw new SkillValidationError(issues);
    }
    return new SkillRegistry(documents);
  }

  metadata(grantedNames: readonly string[] | undefined): SkillMetadata[] {
    return this.granted(grantedNames).map(({ name, description, category }) => ({ name, description, category }));
  }

  /** L1: compact names/descriptions in the system prompt. */
  promptBlock(
    grantedNames: readonly string[] | undefined,
    options: { access?: SkillPromptAccess; l1Only?: boolean; pluginName?: string } = {}
  ): string {
    const skills = this.metadata(grantedNames);
    if (skills.length === 0) {
      return '';
    }
    const mode: SkillPromptAccess = options.l1Only ? 'metadata' : (options.access ?? 'tools');
    const access = mode === 'metadata'
      ? 'Only these authorized skill summaries are available in this session; do not try to use Bash or filesystem tools to load skill files.'
      : mode === 'plugin'
      ? options.pluginName
        ? 'Full instructions for these authorized skills are available through the extension-managed Claude plugin. Invoke the relevant namespaced command below when a skill is needed; do not use Bash or workspace files to load skill instructions.'
        : 'Full instructions for these authorized skills are available through the extension-managed Claude plugin. Use a relevant skill directly; do not use Bash or workspace files to load skill instructions.'
        : `Use \`${LOAD_SKILL_TOOL}\` to load a relevant skill's full instructions. Use \`${READ_SKILL_FILE_TOOL}\` only for a file inside a granted skill.`;
    return [
      '## Authorized Agent Skills',
      access,
      ...skills.map((skill) => {
        const command = mode === 'plugin' && options.pluginName
          ? ` Invoke \`/${options.pluginName}:${skill.name}\` for full instructions.`
          : '';
        return `- \`${skill.name}\`: ${skill.description}${command}`;
      }),
    ].join('\n');
  }

  /** L2/L3 OpenAI-compatible function declarations. */
  toolSpecs(grantedNames: readonly string[] | undefined): ToolSpec[] {
    if (this.granted(grantedNames).length === 0) {
      return [];
    }
    return [
      {
        type: 'function',
        returnsExternalContent: true,
        function: {
          name: LOAD_SKILL_TOOL,
          description: 'Load the full instruction body of one skill authorized for this agent. Read-only; no workspace files are exposed.',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Authorized skill name from the system prompt.' } },
            required: ['name'],
          },
        },
      },
      {
        type: 'function',
        returnsExternalContent: true,
        function: {
          name: READ_SKILL_FILE_TOOL,
          description: 'Read a reference file inside one authorized skill directory. Read-only and path-confined to that skill.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Authorized skill name from the system prompt.' },
              relpath: { type: 'string', description: 'Relative path inside that skill directory.' },
            },
            required: ['name', 'relpath'],
          },
        },
      },
    ];
  }

  runTool(toolName: string, args: Record<string, unknown>, grantedNames: readonly string[] | undefined): HostToolOutcome | undefined {
    const name = typeof args.name === 'string' ? args.name : '';
    if (toolName === LOAD_SKILL_TOOL) {
      return this.loadBody(name, grantedNames);
    }
    if (toolName === READ_SKILL_FILE_TOOL) {
      return this.readFile(name, typeof args.relpath === 'string' ? args.relpath : '', grantedNames);
    }
    return undefined;
  }

  loadBody(name: string, grantedNames: readonly string[] | undefined): HostToolOutcome {
    const skill = this.authorized(name, grantedNames);
    if (!skill) {
      return hostToolRefused(`Error: skill "${name}" is not authorized for this agent.`, 'capability');
    }
    if (skill.body.length > MAX_SKILL_BODY_CHARS) {
      return hostToolRefused(`Error: skill "${name}" exceeds the ${MAX_SKILL_BODY_CHARS}-character disclosure limit.`, 'scope');
    }
    return hostToolSucceeded(skill.body, { contentSource: 'mixed-external' });
  }

  readFile(name: string, relpath: string, grantedNames: readonly string[] | undefined): HostToolOutcome {
    const skill = this.authorized(name, grantedNames);
    if (!skill) {
      return hostToolRefused(`Error: skill "${name}" is not authorized for this agent.`, 'capability');
    }
    if (!relpath || path.isAbsolute(relpath) || relpath.includes('\0')) {
      return hostToolFailed('Error: relpath must be a non-empty relative path inside the authorized skill.');
    }
    try {
      const candidate = path.resolve(skill.directory, relpath);
      const real = fs.realpathSync(candidate);
      if (!isInside(skill.directory, real) || real === skill.directory) {
        return hostToolRefused('Error: requested file is outside the authorized skill directory.', 'scope');
      }
      const stat = fs.statSync(real);
      if (!stat.isFile() || EXECUTABLE_SKILL_FILE.test(real)) {
        return hostToolRefused('Error: requested skill file is not an allowed instruction/reference file.', 'scope');
      }
      const text = fs.readFileSync(real, 'utf8');
      return hostToolSucceeded(text.length > MAX_SKILL_FILE_CHARS
        ? `${text.slice(0, MAX_SKILL_FILE_CHARS)}\n\n[Truncated at ${MAX_SKILL_FILE_CHARS} characters.]`
        : text, { contentSource: 'mixed-external' });
    } catch {
      return hostToolFailed('Error: requested skill file does not exist or cannot be read.', { failureKind: 'not_found' });
    }
  }

  /** Per-agent source list for Claude's isolated temporary plugin. */
  grantedDocuments(grantedNames: readonly string[] | undefined): SkillDocument[] {
    return this.granted(grantedNames);
  }

  private granted(grantedNames: readonly string[] | undefined): SkillDocument[] {
    const seen = new Set<string>();
    const documents: SkillDocument[] = [];
    for (const name of grantedNames ?? []) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const skill = this.byName.get(name);
      if (skill) {
        documents.push(skill);
      }
    }
    return documents;
  }

  private authorized(name: string, grantedNames: readonly string[] | undefined): SkillDocument | undefined {
    return this.granted(grantedNames).find((skill) => skill.name === name);
  }
}

function assertInstructionOnlyTree(root: string): void {
  const issues: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      // v1 skills are fully self-contained instruction resources. Reject links outright rather than
      // relying on a later copy/read operation to decide whether their target is safe.
      if (entry.isSymbolicLink()) {
        issues.push(`${full}: symbolic links are not allowed in v1 skills`);
      } else if (entry.isDirectory()) {
        if (/^(?:scripts?|bin)$/i.test(entry.name)) {
          issues.push(`${full}: executable skill directories are not allowed in v1`);
          continue;
        }
        visit(full);
      } else if (EXECUTABLE_SKILL_FILE.test(entry.name)) {
        issues.push(`${full}: executable skill payloads are not allowed in v1`);
      }
    }
  };
  visit(root);
  if (issues.length > 0) {
    throw new SkillValidationError(issues);
  }
}

function unquoteYamlScalar(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function asIssues(error: unknown, fallback: string): string[] {
  if (error instanceof SkillValidationError) {
    return error.issues;
  }
  return [`${fallback}: ${error instanceof Error ? error.message : String(error)}`];
}
