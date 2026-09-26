/*---------------------------------------------------------------------------------------------
 *  UnodeAi - private Codex native-Skill roots
 *  Materialises only one agent's validated instruction playbooks, then atomically publishes the
 *  complete tree for that agent's dedicated App Server process.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SkillRegistry,
  assertInstructionOnlySkillTree,
  copyInstructionOnlySkillProjection,
  parseSkillMarkdown,
} from '../skills/SkillRegistry';

export interface CodexNativeSkill {
  sourceName: string;
  nativeName: string;
  path: string;
}

export interface CodexSkillRoot {
  /** Parent temporary directory owned by this backend; remove this to clean up the complete tree. */
  temporaryDirectory: string;
  /** Atomically published extra root passed to Codex. */
  root: string;
  skills: readonly CodexNativeSkill[];
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

/** Stable namespacing prevents two agents or a user Skill from silently shadowing one another. */
export function codexNativeSkillName(agentId: string, sourceName: string): string {
  const readable = sourceName.slice(0, 40).replace(/-+$/g, '') || 'playbook';
  return `unode-${shortHash(agentId)}-${readable}-${shortHash(sourceName)}`;
}

function rewriteSkillName(skillPath: string, nativeName: string): void {
  const markdown = fs.readFileSync(skillPath, 'utf8');
  const rewritten = markdown.replace(/^(name:\s*).+$/m, `$1${nativeName}`);
  if (rewritten === markdown) {
    throw new Error(`${skillPath}: could not namespace the native Skill name`);
  }
  const parsed = parseSkillMarkdown(rewritten, skillPath);
  if (parsed.name !== nativeName) {
    throw new Error(`${skillPath}: native Skill name did not round-trip`);
  }
  fs.writeFileSync(skillPath, rewritten, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Build a private root without ever exposing a partially copied Skill tree. The registry's source path is
 * re-resolved immediately before copying, and both source and staged copies are revalidated so a late link or
 * executable payload cannot enter between registry load and App Server registration.
 */
export function createCodexSkillRoot(
  registry: SkillRegistry | undefined,
  grantedNames: readonly string[] | undefined,
  agentId: string,
): CodexSkillRoot | undefined {
  const documents = registry?.grantedDocuments(grantedNames) ?? [];
  if (documents.length === 0) return undefined;

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'unodeai-codex-skills-'));
  const staging = path.join(temporaryDirectory, 'staging');
  const published = path.join(temporaryDirectory, 'skills');
  const skills: CodexNativeSkill[] = [];
  try {
    fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
    const nativeNames = new Set<string>();
    for (const document of documents) {
      const source = fs.realpathSync(document.directory);
      if (pathKey(source) !== pathKey(document.directory)) {
        throw new Error(`Codex Skill source identity changed for ${document.name}.`);
      }
      // The registry revalidates executable Skills itself; only their inert projection reaches Codex.
      const nativeName = codexNativeSkillName(agentId, document.name);
      if (nativeNames.has(nativeName)) {
        throw new Error(`Codex Skill namespace collision for ${document.name}.`);
      }
      nativeNames.add(nativeName);
      const target = path.join(staging, nativeName);
      copyInstructionOnlySkillProjection(document, target);
      assertInstructionOnlySkillTree(target);
      const skillPath = path.join(target, 'SKILL.md');
      rewriteSkillName(skillPath, nativeName);
      skills.push({ sourceName: document.name, nativeName, path: fs.realpathSync(skillPath) });
    }
    fs.renameSync(staging, published);
    const publishedRoot = fs.realpathSync(published);
    assertInstructionOnlySkillTree(publishedRoot);
    return {
      temporaryDirectory,
      root: publishedRoot,
      skills: skills.map((skill) => ({
        ...skill,
        path: path.join(publishedRoot, path.basename(path.dirname(skill.path)), 'SKILL.md'),
      })),
    };
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function removeCodexSkillRoot(root: CodexSkillRoot | undefined): void {
  if (!root) return;
  try {
    fs.rmSync(root.temporaryDirectory, { recursive: true, force: true });
  } catch {
    // Process cleanup must continue even when antivirus/indexing briefly retains a temporary file.
  }
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
