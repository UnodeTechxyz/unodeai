/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Agent Skills registry
 *  SKILL.md files shipped with the extension are the runtime source of truth for procedural
 *  skills. The registry deliberately reads only extension-owned, validated files.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { snapshotSkillTree, skillResourceText, SkillValidationError } from './SkillResourceTree';
export { snapshotSkillTree, SkillValidationError } from './SkillResourceTree';
export type { SkillResourceTree as SkillTreeSnapshot } from './SkillResourceTree';
import { readSkillIdentityCatalog, skillResourceIdentity, type SkillIdentityCatalog } from './SkillResourceIdentity';
import { nativeSkillEntry } from './SkillNativeEntry';
import { installedSkillResourceScope, type SkillResourceScope } from './SkillResourceScope';
const skillYaml = require('js-yaml') as { load(text: string, options: { schema: unknown; json: boolean }): unknown; FAILSAFE_SCHEMA: unknown };
import type { ToolSpec } from '../backend/WorkspaceTools';
import { MODEL_TOOL_RESULT_MAX_CHARS } from '../backend/boundToolResultForModel';
import { BUNDLED_SKILL_ACTION_HANDLER_IDS } from './SkillActionHandlers';
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
/**
 * v0.9.99: the most one skill result holds, so it reaches the model whole. A longer body or reference file is read in
 * parts, each naming the call that reads the next; this is a page size, never a limit on what can be read.
 */
const SKILL_RESULT_CHARS = MODEL_TOOL_RESULT_MAX_CHARS;
const SKILL_OFFSET_PARAMETER = {
  type: 'integer',
  description: 'Optional: the character to start at, as a continuation names it. Omit to read from the beginning.',
};
const RESERVED_NAME_WORDS = new Set(['anthropic', 'claude']);
/**
 * v0.9.106 (Owner, 2026-11-17): also the script types an agent's shell can run directly, so a skill folder can carry
 * none of them under any directory name. The same list is in scripts/validate-skills.mjs and
 * scripts/check-vsix-boundary.mjs.
 */
const EXECUTABLE_SKILL_FILE = /\.(?:exe|dll|node|wasm|cmd|bat|ps1|sh|js|cjs|mjs|ts|py|pyw|pyc|rb|pl|php|bash|zsh|vbs|wsf|psm1|jar)$/i;
export const SKILL_ACTIONS_MANIFEST = 'unode-actions.json';
const MAX_SKILL_ACTIONS = 16;
const MAX_SKILL_ACTION_DESCRIPTION = 1024;
const SKILL_ACTION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SKILL_ACTION_HANDLER = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+\.v[1-9][0-9]*$/;
const SKILL_ACTION_EFFECTS = new Set(['read-workspace', 'write-workspace', 'network', 'child-process']);

export { BUNDLED_SKILL_ACTION_HANDLER_IDS } from './SkillActionHandlers';

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
  /** SHA-256 of every path and byte in the validated source tree. */
  digest: string;
  /** Explicit, fixed host-mediated handlers. Empty means instruction-only. */
  actions: readonly SkillAction[];
}

export interface SkillAction {
  id: string;
  description: string;
  /** Static handler compiled into the signed VSIX. Never a filesystem path. */
  handler: string;
  declaredEffects: readonly string[];
}

export interface SkillRegistryOptions {
  /** Test/build seam. Production uses only BUNDLED_SKILL_ACTION_HANDLER_IDS. */
  actionHandlers?: ReadonlySet<string>;
}

export interface ParsedSkillMarkdown {
  frontmatterKeys?: readonly string[];
  name: string;
  description: string;
  body: string;
}

export type SkillPromptAccess = 'tools' | 'plugin' | 'metadata';

/** Parse YAML as inert data. Only name/description enter the generated native discovery entry. */
export function parseSkillMarkdown(markdown: string, label = 'SKILL.md'): ParsedSkillMarkdown {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new SkillValidationError([`${label}: YAML frontmatter must start with ---`]);
  }
  const close = normalized.indexOf('\n---\n', 4);
  if (close === -1) {
    throw new SkillValidationError([`${label}: YAML frontmatter must end with ---`]);
  }
  let frontmatter: Record<string, unknown>;
  try { const value = skillYaml.load(normalized.slice(4, close), { schema: skillYaml.FAILSAFE_SCHEMA, json: false }); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('frontmatter must be a mapping'); frontmatter = value as Record<string, unknown>; }
  catch { throw new SkillValidationError([label + ': invalid YAML frontmatter']); }
  const name = typeof frontmatter.name === 'string' ? frontmatter.name : '';
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
  const body = normalized.slice(close + '\n---\n'.length).trim();
  validateSkillFields({ name, description, body }, label);
  return { name, description, body, frontmatterKeys: Object.keys(frontmatter) };
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
  private readonly actionHandlers: ReadonlySet<string>;
  readonly issues: readonly string[];
  private readonly catalog: SkillIdentityCatalog;
  private readonly observedResourceDigests = new Map<string, string>();
  private readonly knownInstalledNames: ReadonlySet<string>;

  private constructor(documents: SkillDocument[], actionHandlers: ReadonlySet<string>, skillsRoot: string, issues: readonly string[],
    knownInstalledNames: Iterable<string> = documents.map(document => document.name), private readonly registryUnavailable = false) {
    this.byName = new Map(documents.map((document) => [document.name, document]));
    this.actionHandlers = actionHandlers; this.issues = issues; this.catalog = readSkillIdentityCatalog(skillsRoot);
    this.knownInstalledNames = new Set(knownInstalledNames);
  }

  static load(skillsRoot: string, options: SkillRegistryOptions = {}): SkillRegistry {
    try { if (fs.lstatSync(skillsRoot).isSymbolicLink()) throw Error('symbolic skill root'); } catch { return new SkillRegistry([], options.actionHandlers ?? BUNDLED_SKILL_ACTION_HANDLER_IDS, skillsRoot, ['Installed skill folder is unavailable. Reinstalling UnodeAi restores it; other work can continue.'], [], true); }
    const documents: SkillDocument[] = [];
    const issues: string[] = [];
    const installedNames = new Set<string>();
    let root: string;
    try { root = fs.realpathSync(skillsRoot); } catch { return new SkillRegistry([], options.actionHandlers ?? BUNDLED_SKILL_ACTION_HANDLER_IDS, skillsRoot, ['Installed skill folder cannot be read. Reinstalling UnodeAi restores it.'], [], true); }
    const entries = (directory: string) => { try { return fs.readdirSync(directory, { withFileTypes: true }); } catch { issues.push(directory + ': installed skill folder cannot be read'); return []; } };

    for (const categoryEntry of entries(root)) {
      if (categoryEntry.isSymbolicLink()) {
        issues.push(`${path.join(root, categoryEntry.name)}: symbolic links are not allowed in v1 skills`);
        continue;
      }
      if (!categoryEntry.isDirectory() || categoryEntry.name.startsWith('.')) {
        continue;
      }
      const category = categoryEntry.name;
      const categoryPath = path.join(root, category);
      for (const skillEntry of entries(categoryPath)) {
        if (!skillEntry.name.startsWith('.') && (skillEntry.isDirectory() || skillEntry.isSymbolicLink())) installedNames.add(skillEntry.name);
        if (skillEntry.isSymbolicLink()) {
          issues.push(`${path.join(categoryPath, skillEntry.name)}: symbolic links are not allowed in v1 skills`);
          continue;
        }
        if (!skillEntry.isDirectory() || skillEntry.name.startsWith('.')) {
          continue;
        }
        const skillPath = path.join(categoryPath, skillEntry.name, 'SKILL.md');
        try {
        const directory = fs.realpathSync(path.join(categoryPath, skillEntry.name));
        if (!isInside(root, directory)) {
          issues.push(`${skillPath}: skill directory escapes the skills root`);
          continue;
        }
        if (!fs.existsSync(skillPath)) {
          issues.push(`${skillPath}: missing SKILL.md`);
          continue;
        }
          const actions = validateSkillTree(directory, options.actionHandlers ?? BUNDLED_SKILL_ACTION_HANDLER_IDS);
          const snapshot = snapshotSkillTree(directory); const markdown = snapshot.files.get('SKILL.md'); const decoded = markdown && skillResourceText(markdown); if (!decoded) throw new SkillValidationError([skillPath + ': SKILL.md is not readable text']);
          const parsed = parseSkillMarkdown(decoded.text, skillPath);
          if (parsed.name !== skillEntry.name) {
            throw new SkillValidationError([`${skillPath}: name must match its folder name (${skillEntry.name})`]);
          }
          documents.push({ ...parsed, category, directory, actions, digest: snapshot.digest });
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
    const duplicateNames = new Set(documents.filter((document, index) => documents.findIndex(other => other.name === document.name) !== index).map(document => document.name));
    return new SkillRegistry(documents.filter(document => !duplicateNames.has(document.name)), options.actionHandlers ?? BUNDLED_SKILL_ACTION_HANDLER_IDS, skillsRoot, issues, installedNames);
  }

  private knownUnavailable(name: string): boolean {
    return this.registryUnavailable || this.knownInstalledNames.has(name) || this.catalog.entries.has(name);
  }

  metadata(grantedNames: readonly string[] | undefined): SkillMetadata[] {
    return [...new Set(grantedNames ?? [])].filter(name => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)
      && (this.byName.has(name) || this.knownUnavailable(name))).map(name => {
      const skill = this.byName.get(name); return skill ? { name, description: skill.description, category: skill.category }
        : { name, description: 'Installed skill unavailable. Reinstalling UnodeAi restores the bundled files; other work can continue.', category: 'unavailable' };
    });
  }

  /** L1: compact names/descriptions in the system prompt. */
  promptBlock(
    grantedNames: readonly string[] | undefined,
    options: { access?: SkillPromptAccess; l1Only?: boolean; pluginName?: string; loadTool?: string; readTool?: string } = {}
  ): string {
    const skills = this.metadata(grantedNames);
    if (skills.length === 0) {
      return '';
    }
    const mode: SkillPromptAccess = options.l1Only ? 'metadata' : (options.access ?? 'tools');
    const loadTool = options.loadTool ?? LOAD_SKILL_TOOL;
    const readTool = options.readTool ?? READ_SKILL_FILE_TOOL;
    const access = mode === 'metadata'
      ? 'Only these authorized skill summaries are available in this session; do not try to use Bash or filesystem tools to load skill files.'
      : mode === 'plugin'
      ? options.pluginName
        ? 'Full instructions for these authorized skills are available through the extension-managed Claude plugin. Invoke the relevant namespaced command below when a skill is needed; do not use Bash or workspace files to load skill instructions.'
        : 'Full instructions for these authorized skills are available through the extension-managed Claude plugin. Use a relevant skill directly; do not use Bash or workspace files to load skill instructions.'
        : `Use \`${loadTool}\` to load a relevant skill's full instructions. Use \`${readTool}\` only for a file inside a granted skill.`;
    return [
      '## Authorized Agent Skills',
      access,
      ...skills.map((skill) => {
        const command = mode === 'plugin' && options.pluginName && this.byName.has(skill.name)
          ? ` Invoke \`/${options.pluginName}:${skill.name}\` for full instructions.`
          : '';
        return `- \`${skill.name}\`: ${skill.description}${command}`;
      }),
    ].join('\n');
  }

  /** L2/L3 OpenAI-compatible function declarations. */
  toolSpecs(grantedNames: readonly string[] | undefined): ToolSpec[] {
    if (this.metadata(grantedNames).length === 0) {
      return [];
    }
    return [
      {
        type: 'function',
        returnsExternalContent: true,
        function: {
          name: LOAD_SKILL_TOOL,
          description: 'Load instructions, actual installed resource_root, digest, identity/cache status and full resource inventory of one granted skill. No code, imports, hooks, installs or network are run. '
            + 'Long instructions and inventories arrive in parts; continue by offset until complete. Relative helpers/assets resolve at resource_root and run only through ordinary command authority. This grants no Commands/Write/Network.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Authorized skill name from the system prompt.' },
              offset: SKILL_OFFSET_PARAMETER,
            },
            required: ['name'],
          },
        },
      },
      {
        type: 'function',
        returnsExternalContent: true,
        function: {
          name: READ_SKILL_FILE_TOOL,
          description: 'Read source code or other resources inside one granted installed skill. Strict UTF-8 or BOM UTF-16 is decoded with actual encoding reported. Binary/undecodable files return metadata and a usable resource path, never replacement text or base64. '
            + 'Read-only and path-confined; cache artifacts are not resources. Long text arrives in parts; each part names the continuation. Reading executes nothing.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Authorized skill name from the system prompt.' },
              relpath: { type: 'string', description: 'Relative path inside that skill directory.' },
              offset: SKILL_OFFSET_PARAMETER,
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
      return this.loadBody(name, grantedNames, args.offset);
    }
    if (toolName === READ_SKILL_FILE_TOOL) {
      return this.readFile(name, typeof args.relpath === 'string' ? args.relpath : '', grantedNames, args.offset);
    }
    return undefined;
  }

  /**
   * v0.9.99: the whole authorized body, in parts when it is longer than one result. The executable-action notice goes
   * with every part, so no part reads as instruction-only when the skill has actions.
   */
  loadBody(name: string, grantedNames: readonly string[] | undefined, offset?: unknown): HostToolOutcome {
    const skill = this.authorized(name, grantedNames);
    if (!skill) {
      if (grantedNames?.includes(name)) return this.unavailableResult(name);
      return hostToolRefused(`Error: skill "${name}" is not authorized for this agent.`, 'capability');
    }
    let body: string;
    try {
      const tree = snapshotSkillTree(skill.directory); const bytes = tree.files.get('SKILL.md'); const decoded = bytes && skillResourceText(bytes); if (!decoded) throw Error('instructions unavailable');
      const parsed = parseSkillMarkdown(decoded.text); if (parsed.name !== skill.name) throw Error('skill identity changed');
      this.observedResourceDigests.set(name, tree.digest);
      body = JSON.stringify({ skill_name: name, resource_root: tree.root, digest: tree.digest, identity: skillResourceIdentity(tree, skill.category, name, this.catalog),
        runtime_hints: 'Use the available interpreter named in the instructions, under ordinary command authority. Loading executes nothing.'
          + (tree.ignoredCachePresent ? ' Ignored Python cache files are excluded from the inventory and digest. An interpreter without the host cache prefix may still use them; a matching digest does not prove what it executes.' : '') }) + '\n\n' + parsed.body
        + '\n\n## Resource inventory\n' + tree.inventory.map(file => JSON.stringify(file)).join('\n');
    } catch { return hostToolFailed('Installed skill files are modified or unavailable. Reinstalling UnodeAi restores the bundled files; other skills and work can continue.'); }
    const notice = skill.actions.length > 0 ? `\n\n${executableActionNotice(skill.actions)}` : '';
    const note = (from: number, to: number, more: boolean) => more
      ? `[Skill ${JSON.stringify(skill.name)} instructions, characters ${from}–${to} of ${body.length}. This is part of the `
        + `instructions, not the whole instructions. To read the rest, call ${LOAD_SKILL_TOOL}({ name: ${JSON.stringify(skill.name)}, offset: ${to} }).]`
      : `[Skill ${JSON.stringify(skill.name)} instructions, characters ${from}–${to} of ${body.length}: the end of the instructions.]`;
    const part = skillPart(body, offset, notice.length, note);
    if ('past' in part) {
      return hostToolFailed(`Error: offset ${part.past} is at or past the end of skill "${skill.name}" (${body.length} characters). Nothing more to read.`);
    }
    return hostToolSucceeded(part.whole
      ? withExecutableActionNotice(body, skill.actions)
      : `${body.slice(part.from, part.to)}\n\n${note(part.from, part.to, part.to < body.length)}${notice}`,
    { contentSource: 'mixed-external' });
  }

  readFile(name: string, relpath: string, grantedNames: readonly string[] | undefined, offset?: unknown): HostToolOutcome {
    const skill = this.authorized(name, grantedNames);
    if (!skill) {
      if (grantedNames?.includes(name)) return this.unavailableResult(name);
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
      const tree = snapshotSkillTree(skill.directory); const relative = path.relative(tree.root, real).replace(/\\/g, '/'); const bytes = tree.files.get(relative); const metadata = tree.inventory.find(file => file.path === relative);
      if (!bytes || !metadata) return hostToolFailed('Requested file is not an available skill resource. Cache files are not exposed; choose a path from load_skill resource inventory.');
      const decoded = skillResourceText(bytes); const information = JSON.stringify({ resource_path: real, ...metadata });
      if (!decoded) return hostToolSucceeded(information, { contentSource: 'mixed-external' });
      const text = information + '\n\n' + decoded.text;
      // v0.9.99: the whole file, in parts when it is longer than one result; nothing is cut by its length.
      const note = (from: number, to: number, more: boolean) => more
        ? `[Skill file ${JSON.stringify(relpath)} of ${JSON.stringify(skill.name)}, characters ${from}–${to} of ${text.length}. This is part `
          + `of the file, not the whole file. To read the rest, call ${READ_SKILL_FILE_TOOL}({ name: ${JSON.stringify(skill.name)}, `
          + `relpath: ${JSON.stringify(relpath)}, offset: ${to} }).]`
        : `[Skill file ${JSON.stringify(relpath)} of ${JSON.stringify(skill.name)}, characters ${from}–${to} of ${text.length}: the end of the file.]`;
      const part = skillPart(text, offset, 0, note);
      if ('past' in part) {
        return hostToolFailed(`Error: offset ${part.past} is at or past the end of ${relpath} (${text.length} characters). Nothing more to read.`);
      }
      return hostToolSucceeded(part.whole
        ? text
        : `${text.slice(part.from, part.to)}\n\n${note(part.from, part.to, part.to < text.length)}`, { contentSource: 'mixed-external' });
    } catch (error) {
      if (error instanceof SkillValidationError) return hostToolFailed('Installed skill resources are modified or unavailable. Use load_skill for the current status; reinstalling UnodeAi restores the bundled files. Other work can continue.');
      return hostToolFailed('Error: requested skill file does not exist or cannot be read.', { failureKind: 'not_found' });
    }
  }

  /** A stale grant cannot promise that reinstalling restores a skill absent from this version. */
  private unavailableResult(name: string): HostToolOutcome {
    return hostToolFailed(this.knownUnavailable(name)
      ? 'Installed skill is unavailable. Reinstalling UnodeAi restores the bundled files; other skills and work can continue.'
      : 'This granted skill is not included in the installed version. Use another granted skill; other work can continue.');
  }

  /** Per-agent source list for Claude's isolated temporary plugin. */
  grantedDocuments(grantedNames: readonly string[] | undefined): SkillDocument[] {
    return this.granted(grantedNames);
  }

  /** Live grant/root/path validation only. Ordinary helper launch never scans or hashes the resource tree. */
  resourceScopes(grantedNames: () => readonly string[] | undefined): SkillResourceScope[] {
    return this.granted(grantedNames()).map(document => installedSkillResourceScope({ ...document,
      digest: this.observedResourceDigests.get(document.name) ?? document.digest },
      () => this.authorized(document.name, grantedNames())?.directory === document.directory))
      .filter(scope => scope.current());
  }

  /** Resolve an authorized executable action and revalidate the complete source tree and digest. */
  authorizedAction(
    skillName: string,
    actionId: string,
    grantedNames: readonly string[] | undefined,
  ): { document: SkillDocument; action: SkillAction } | undefined {
    const document = this.authorized(skillName, grantedNames);
    const action = document?.actions.find((candidate) => candidate.id === actionId);
    if (!document || !action) return undefined;
    const actions = validateSkillTree(document.directory, this.actionHandlers);
    if (JSON.stringify(actions) !== JSON.stringify(document.actions)
      || computeSkillTreeDigest(document.directory) !== document.digest) {
      throw new SkillValidationError([`${document.directory}: skill content changed after validation`]);
    }
    return { document, action };
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

export function assertInstructionOnlySkillTree(root: string): void {
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

/** Validate either a legacy instruction-only tree or the narrow executable-action v1 profile. */
export function validateSkillTree(
  root: string,
  actionHandlers: ReadonlySet<string> = BUNDLED_SKILL_ACTION_HANDLER_IDS,
): readonly SkillAction[] {
  const manifestPath = path.join(root, SKILL_ACTIONS_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    snapshotSkillTree(root);
    return [];
  }
  const issues: string[] = [];
  let actions: SkillAction[] = [];
  try {
    const stat = fs.lstatSync(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) {
      throw new Error('manifest must be a regular file no larger than 64 KiB');
    }
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    if (Object.keys(parsed).some((key) => key !== 'version' && key !== 'actions')) {
      throw new Error('manifest contains an unknown top-level field');
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.actions)) {
      throw new Error('manifest must contain version 1 and an actions array');
    }
    if (parsed.actions.length < 1 || parsed.actions.length > MAX_SKILL_ACTIONS) {
      throw new Error(`manifest must declare 1-${MAX_SKILL_ACTIONS} actions`);
    }
    const seen = new Set<string>();
    actions = parsed.actions.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`action ${index + 1} must be an object`);
      const value = raw as Record<string, unknown>;
      const allowed = new Set(['id', 'description', 'handler', 'declaredEffects']);
      if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`action ${index + 1} contains an unknown field`);
      const id = typeof value.id === 'string' ? value.id : '';
      const description = typeof value.description === 'string' ? value.description.trim() : '';
      const handler = typeof value.handler === 'string' ? value.handler : '';
      const declaredEffects = Array.isArray(value.declaredEffects) ? value.declaredEffects : [];
      if (!SKILL_ACTION_ID.test(id) || seen.has(id)) throw new Error(`action ${index + 1} has an invalid or duplicate id`);
      seen.add(id);
      if (!description || description.length > MAX_SKILL_ACTION_DESCRIPTION) throw new Error(`action ${id} has an invalid description`);
      if (!SKILL_ACTION_HANDLER.test(handler) || !actionHandlers.has(handler)) {
        throw new Error(`action ${id} handler is not compiled into the UnodeAi action runner`);
      }
      if (declaredEffects.some((effect) => typeof effect !== 'string' || !SKILL_ACTION_EFFECTS.has(effect))) {
        throw new Error(`action ${id} has an invalid declared effect`);
      }
      return { id, description, handler, declaredEffects: [...new Set(declaredEffects as string[])] };
    });
  } catch (error) {
    issues.push(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { snapshotSkillTree(root); } catch (error) { issues.push(...asIssues(error, root)); }
  if (issues.length > 0) throw new SkillValidationError(issues);
  return actions;
}

/** Reproducible digest used by the approval card and rechecked immediately before execution. */
export function computeSkillTreeDigest(root: string): string {
  return snapshotSkillTree(root).digest;
}

/** Generated discovery only; original resources stay at their installed directory. */
export function copyNativeSkillProjection(document: SkillDocument, target: string, tools: { load?: string; read?: string } = {}): void {
  const snapshot = snapshotSkillTree(document.directory); const source = snapshot.files.get('SKILL.md'); const decoded = source && skillResourceText(source); if (!source || !decoded) throw new SkillValidationError(['Installed skill instructions unavailable']);
  const parsed = parseSkillMarkdown(decoded.text); if (parsed.name !== document.name) throw new SkillValidationError(['Installed skill name changed']);
  const generated = nativeSkillEntry({ name: parsed.name, description: parsed.description, source, frontmatterKeys: parsed.frontmatterKeys ?? [], resourcePaths: [...snapshot.files.keys()] }, tools.load, tools.read);
  const checked = parseSkillMarkdown(generated.markdown); if (checked.name !== parsed.name || checked.description !== parsed.description || checked.frontmatterKeys?.join(',') !== 'name,description') throw new SkillValidationError(['Native skill metadata did not round-trip']);
  fs.mkdirSync(target, { recursive: false, mode: 0o700 }); fs.writeFileSync(path.join(target, 'SKILL.md'), generated.markdown, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(target, 'projection-report.json'), JSON.stringify(generated.report), { flag: 'wx', mode: 0o600 });
}
/** Compatibility export; the projection now contains generated discovery data only. */
export const copyInstructionOnlySkillProjection = copyNativeSkillProjection;

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

/**
 * v0.9.99: which characters of `text` one skill result shows. `around` is what the result adds besides the part and
 * its note. The note is sized at its longest, so the call that reads the rest always fits beside the part, and a part
 * never starts or ends inside a surrogate pair.
 */
function skillPart(
  text: string,
  offsetRaw: unknown,
  around: number,
  note: (from: number, to: number, more: boolean) => string,
): { from: number; to: number; whole: boolean } | { past: number } {
  const value = Number(offsetRaw ?? 0);
  const requested = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (requested > 0 && requested >= text.length) return { past: requested };
  let from = requested;
  if (from > 0 && isLowSurrogate(text.charCodeAt(from)) && isHighSurrogate(text.charCodeAt(from - 1))) from -= 1;
  if (from === 0 && text.length + around <= SKILL_RESULT_CHARS) return { from: 0, to: text.length, whole: true };
  const longest = Math.max(note(text.length, text.length, true).length, note(text.length, text.length, false).length);
  let to = Math.min(text.length, from + Math.max(1, SKILL_RESULT_CHARS - around - longest - 2));
  if (to < text.length && isLowSurrogate(text.charCodeAt(to)) && isHighSurrogate(text.charCodeAt(to - 1))) to -= 1;
  // At least one whole character, so every continuation moves forward.
  if (to <= from) to = Math.min(text.length, from + (isHighSurrogate(text.charCodeAt(from)) ? 2 : 1));
  return { from, to, whole: false };
}

function withExecutableActionNotice(body: string, actions: readonly SkillAction[]): string {
  return actions.length > 0 ? `${body}\n\n${executableActionNotice(actions)}` : body;
}

function executableActionNotice(actions: readonly SkillAction[]): string {
  return [
    '## UnodeAi executable actions',
    'Compiled actions use the host-provided `run_skill_action` tool and its fresh human approval tied to the exact Skill digest. Ordinary helpers and resources use normal command authority; loading or reading them grants no execution permission.',
    ...actions.map((action) => `- \`${action.id}\`: ${action.description}`),
  ].join('\n');
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
