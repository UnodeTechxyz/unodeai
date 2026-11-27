import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOAD_SKILL_TOOL,
  READ_SKILL_FILE_TOOL,
  SkillRegistry,
  SkillValidationError,
  copyInstructionOnlySkillProjection,
  snapshotSkillTree,
  parseSkillMarkdown,
} from '../SkillRegistry';
import { resourceText } from './skillResourceResultFixtures';
import { createCodexSkillRoot, removeCodexSkillRoot } from '../../backend/CodexSkillRoot';

const OWNER_SCRIPT_SUFFIXES = ['py', 'pyw', 'pyc', 'rb', 'pl', 'php', 'bash', 'zsh', 'vbs', 'wsf', 'psm1', 'jar'];

const VALID_SKILL = `---
name: valid-skill
description: Review an implementation with a repeatable checklist. Use when a change needs an independent quality pass.
---

# Valid Skill

1. Inspect the change.
2. Report evidence.
`;

describe('SkillRegistry', () => {
  it('loads the shipped SKILL.md library, including proof skills', () => {
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    const names = registry.metadata([
      'api-contract-review',
      'claim-sourcing-and-citation',
      'positioning-and-messaging',
      'using-superpowers',
    ]).map((skill) => skill.name);

    expect(names).toEqual(['api-contract-review', 'claim-sourcing-and-citation', 'positioning-and-messaging', 'using-superpowers']);
  });

  it('rejects invalid names while allowing descriptions in the author\'s language', () => {
    expect(() => parseSkillMarkdown(`---\nname: Claude-Tool\ndescription: Brief.\n---\nbody`, 'bad/SKILL.md'))
      .toThrow(SkillValidationError);
    expect(parseSkillMarkdown(`---\nname: valid-skill\ndescription: 简短说明。\n---\nbody`, 'valid/SKILL.md').description)
      .toBe('简短说明。');
  });

  it('progressively discloses only granted skills and confines L3 realpaths', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-skills-'));
    const skillsRoot = path.join(temp, 'skills');
    const skillDirectory = path.join(skillsRoot, 'rigor', 'valid-skill');
    const references = path.join(skillDirectory, 'references');
    const outside = path.join(temp, 'outside.md');
    await fs.mkdir(references, { recursive: true });
    await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), VALID_SKILL);
    await fs.writeFile(path.join(references, 'note.md'), 'inside reference');
    await fs.writeFile(outside, 'outside secret');

    try {
      const registry = SkillRegistry.load(skillsRoot);
      expect(registry.promptBlock(['valid-skill'])).toContain('valid-skill');
      expect(registry.toolSpecs(['valid-skill']).map((tool) => tool.function.name))
        .toEqual([LOAD_SKILL_TOOL, READ_SKILL_FILE_TOOL]);
      expect(registry.runTool(LOAD_SKILL_TOOL, { name: 'valid-skill' }, ['valid-skill'])?.output)
        .toContain('# Valid Skill');
      expect(registry.runTool(LOAD_SKILL_TOOL, { name: 'valid-skill' }, [])).toMatchObject({ status: 'refused', reason: 'capability' });
      expect(registry.runTool(READ_SKILL_FILE_TOOL, { name: 'valid-skill', relpath: 'references/note.md' }, ['valid-skill'])?.output)
        .toContain('inside reference');
      expect(registry.runTool(READ_SKILL_FILE_TOOL, { name: 'valid-skill', relpath: '../../../outside.md' }, ['valid-skill']))
        .toMatchObject({ status: 'refused', reason: 'scope' });

      const link = path.join(references, 'outside-link.md');
      try {
        await fs.symlink(outside, link, 'file');
        expect(registry.runTool(READ_SKILL_FILE_TOOL, { name: 'valid-skill', relpath: 'references/outside-link.md' }, ['valid-skill']))
          .toMatchObject({ status: 'refused', reason: 'scope' });
      } catch (error: any) {
        if (process.platform !== 'win32' || (error?.code !== 'EPERM' && error?.code !== 'EACCES')) {
          throw error;
        }
      }
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('rejects symbolic links in a packaged skill source tree', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-skill-link-source-'));
    const skillsRoot = path.join(temp, 'skills');
    const skillDirectory = path.join(skillsRoot, 'rigor', 'valid-skill');
    const outside = path.join(temp, 'outside.md');
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), VALID_SKILL);
    await fs.writeFile(outside, 'outside');

    try {
      try {
        await fs.symlink(outside, path.join(skillDirectory, 'outside-link.md'), 'file');
      } catch (error: any) {
        if (process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'EACCES')) {
          return;
        }
        throw error;
      }
      expect(SkillRegistry.load(skillsRoot).issues.join(' ')).toMatch(/symbolic links/i);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('rejects a symbolic-link skill directory instead of silently skipping it', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-skill-link-directory-'));
    const skillsRoot = path.join(temp, 'skills');
    const category = path.join(skillsRoot, 'rigor');
    const skillDirectory = path.join(category, 'valid-skill');
    const linkedDirectory = path.join(category, 'linked-skill');
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), VALID_SKILL);

    try {
      try {
        await fs.symlink(skillDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error: any) {
        if (process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'EACCES')) {
          return;
        }
        throw error;
      }
      expect(SkillRegistry.load(skillsRoot).issues.join(' ')).toMatch(/symbolic links/i);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('rejects a symbolic-link skills root before resolving it', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-skill-link-root-'));
    const target = path.join(temp, 'target-skills');
    const linkedRoot = path.join(temp, 'skills');
    const skillDirectory = path.join(target, 'rigor', 'valid-skill');
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), VALID_SKILL);

    try {
      try {
        await fs.symlink(target, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error: any) {
        if (process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'EACCES')) {
          return;
        }
        throw error;
      }
      expect(SkillRegistry.load(linkedRoot).loadBody('valid-skill', ['valid-skill'])).toMatchObject({ status: 'failed', output: expect.stringContaining('unavailable') });
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('validates executable actions, binds them to the complete tree digest, and projects only inert files', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-executable-skill-'));
    const skillsRoot = path.join(temp, 'skills');
    const skillDirectory = path.join(skillsRoot, 'rigor', 'valid-skill');
    const projection = path.join(temp, 'projection');
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), VALID_SKILL);
    await fs.writeFile(path.join(skillDirectory, 'references.md'), 'safe reference');
    await fs.writeFile(path.join(skillDirectory, 'unode-actions.json'), JSON.stringify({
      version: 1,
      actions: [{
        id: 'run-audit', description: 'Run the bounded audit.', handler: 'unode.echo-json.v1',
        declaredEffects: ['read-workspace'],
      }],
    }));

    try {
      const registry = SkillRegistry.load(skillsRoot);
      const document = registry.grantedDocuments(['valid-skill'])[0];
      const snapshot = snapshotSkillTree(skillDirectory);
      expect(document.actions).toHaveLength(1);
      expect(snapshot.digest).toBe(document.digest);
      expect(registry.loadBody('valid-skill', ['valid-skill']).output).toContain('run_skill_action');
      expect(registry.readFile('valid-skill', 'unode-actions.json', ['valid-skill']))
        .toMatchObject({ status: 'success' });
      copyInstructionOnlySkillProjection(document, projection);
      await expect(fs.stat(path.join(projection, 'references.md'))).rejects.toThrow();
      expect(await fs.readFile(path.join(projection, 'SKILL.md'), 'utf8')).toContain('load_skill');
      await expect(fs.stat(path.join(projection, 'unode-actions.json'))).rejects.toThrow();

      await fs.writeFile(path.join(skillDirectory, 'references.md'), 'changed after approval identity');
      expect(snapshot.files.get('references.md')?.toString('utf8')).toBe('safe reference');
      expect(snapshotSkillTree(skillDirectory).digest).not.toBe(snapshot.digest);
      expect(() => registry.authorizedAction('valid-skill', 'run-audit', ['valid-skill']))
        .toThrow(/changed after validation/i);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  // v0.9.106 (Owner, 2026-11-17): the script types an agent's shell can run directly, under a folder that is not called
  // scripts/ or bin/, so only the file type can refuse them.
  it('reads the Owner-approved source/resource types as data without executing them', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-skill-script-types-'));
    const skillsRoot = path.join(temp, 'skills');
    const skillDirectory = path.join(skillsRoot, 'rigor', 'valid-skill');
    await fs.mkdir(path.join(skillDirectory, 'references'), { recursive: true });
    await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), VALID_SKILL);
    await fs.writeFile(path.join(skillDirectory, 'references', 'helper.md'), 'reference text');
    try {
      // A clean tree loads; a file planted after load is still refused when read.
      const registry = SkillRegistry.load(skillsRoot);
      for (const suffix of OWNER_SCRIPT_SUFFIXES) {
        await fs.writeFile(path.join(skillDirectory, 'references', `helper.${suffix}`), 'not shipped');
        expect(registry.readFile('valid-skill', `references/helper.${suffix}`, ['valid-skill']), suffix)
          .toMatchObject({ status: 'success' });
      }
      expect(resourceText(registry.readFile('valid-skill', 'references/helper.md', ['valid-skill']).output)).toBe('reference text');

      const reloaded = SkillRegistry.load(skillsRoot); expect(reloaded.issues).toEqual([]);
      for (const suffix of OWNER_SCRIPT_SUFFIXES) expect(resourceText(reloaded.readFile('valid-skill', 'references/helper.' + suffix, ['valid-skill']).output)).toBe('not shipped');
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('allows ordinary helpers beside a compiled action while retaining its compiled handler definition', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-executable-skill-reject-'));
    const skillsRoot = path.join(temp, 'skills');
    const skillDirectory = path.join(skillsRoot, 'rigor', 'valid-skill');
    await fs.mkdir(path.join(skillDirectory, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), VALID_SKILL);
    await fs.writeFile(path.join(skillDirectory, 'scripts', 'helper.py'), 'print("not shipped")');
    await fs.writeFile(path.join(skillDirectory, 'unode-actions.json'), JSON.stringify({
      version: 1,
      actions: [{ id: 'run-audit', description: 'Run audit.', handler: 'unode.echo-json.v1', declaredEffects: [] }],
    }));
    try {
      const registry = SkillRegistry.load(skillsRoot); expect(registry.issues).toEqual([]); expect(registry.authorizedAction('valid-skill', 'run-audit', ['valid-skill'])?.action.handler).toBe('unode.echo-json.v1'); expect(resourceText(registry.readFile('valid-skill', 'scripts/helper.py', ['valid-skill']).output)).toBe('print("not shipped")');
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});

/**
 * v0.9.106 (skills spec 5.1 point 5, R7): the six adapted upstream skills through the production loader, read_skill_file
 * and the Codex native projection. Each upstream script ships only as Markdown reference text; these are the files a
 * skill's instructions point at. Deterministic: no model is called.
 */
const ADAPTED_SKILL_REFERENCES: Record<string, string[]> = {
  'frontend-design': ['LICENSE.txt', 'SOURCE.md'],
  'internal-comms': ['examples/3p-updates.md', 'examples/company-newsletter.md', 'examples/faq-answers.md', 'examples/general-comms.md', 'LICENSE.txt', 'SOURCE.md'],
  'webapp-testing': ['references/with-server-helper.md', 'references/examples.md', 'LICENSE.txt', 'SOURCE.md'],
  'mcp-builder': [
    'reference/connection-helper.md', 'reference/evaluation.md', 'reference/example-evaluation.md', 'reference/mcp_best_practices.md',
    'reference/node_mcp_server.md', 'reference/node_mcp_server_v2.md', 'reference/python_mcp_server.md', 'LICENSE.txt', 'SOURCE.md',
  ],
  'security-threat-model': ['references/prompt-template.md', 'references/security-controls-and-assets.md', 'LICENSE.txt', 'SOURCE.md'],
  'gh-fix-ci': ['references/inspect-pr-checks-helper.md', 'LICENSE.txt', 'SOURCE.md'],
};

/** Every file under a directory, as sorted POSIX relative paths. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

/** read_skill_file to the end, following the continuation each part names. */
function readWhole(registry: SkillRegistry, name: string, relpath: string): string {
  const parts: string[] = [];
  let args: Record<string, unknown> = { name, relpath };
  for (let guard = 0; guard < 50; guard++) {
    const result = registry.runTool(READ_SKILL_FILE_TOOL, args, [name])!;
    expect(result.status, `${name}/${relpath}`).toBe('success');
    const next = /call read_skill_file\(\{ name: "[^"]+", relpath: "[^"]+", offset: (\d+) \}\)/.exec(result.output);
    const note = result.output.lastIndexOf('\n\n[Skill file ');
    parts.push(note < 0 ? result.output : result.output.slice(0, note));
    if (!next) return resourceText(parts.join(''));
    args = { name, relpath, offset: Number(next[1]) };
  }
  throw new Error(`${name}/${relpath} never ended`);
}

describe('the six adapted upstream skills (v0.9.106)', () => {
  const names = Object.keys(ADAPTED_SKILL_REFERENCES);

  it('load from the shipped tree with only text files, and read_skill_file reads every reference whole', async () => {
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    expect(registry.metadata(names).map((skill) => skill.name)).toEqual(names);
    for (const [name, references] of Object.entries(ADAPTED_SKILL_REFERENCES)) {
      const document = registry.grantedDocuments([name])[0];
      expect(document.actions).toEqual([]);
      // Instruction-only: SKILL.md plus the listed text files, nothing else.
      expect(await filesUnder(document.directory)).toEqual(['SKILL.md', ...references].sort());
      expect(registry.runTool(LOAD_SKILL_TOOL, { name }, [name])?.status).toBe('success');
      for (const relpath of references) {
        const onDisk = await fs.readFile(path.join(document.directory, ...relpath.split('/')), 'utf8');
        expect(readWhole(registry, name, relpath), `${name}/${relpath}`).toBe(onDisk);
      }
      // Granting one skill reads no other skill's files.
      const other = names.find((candidate) => candidate !== name)!;
      expect(registry.runTool(READ_SKILL_FILE_TOOL, { name, relpath: references[0] }, [other]))
        .toMatchObject({ status: 'refused', reason: 'capability' });
    }
  });

  it('projects generated Codex discovery only and keeps original reference bytes at the installed root', async () => {
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    const root = createCodexSkillRoot(registry, names, 'agent-v09106');
    try {
      expect(root?.skills.map((skill) => skill.sourceName)).toEqual(names);
      for (const skill of root!.skills) {
        const source = registry.grantedDocuments([skill.sourceName])[0].directory;
        const projected = path.dirname(skill.path);
        expect(await filesUnder(projected)).toEqual(['SKILL.md', 'projection-report.json']);
        for (const relpath of ADAPTED_SKILL_REFERENCES[skill.sourceName]) expect(readWhole(registry, skill.sourceName, relpath)).toBe(await fs.readFile(path.join(source, ...relpath.split('/')), 'utf8'));
        // Only the name is namespaced; the instructions that point at the references are the source text.
        const projectedSkill = parseSkillMarkdown(await fs.readFile(skill.path, 'utf8'));
        expect(projectedSkill.name).toBe(skill.nativeName);
        expect(projectedSkill.body).toContain('load_skill'); expect(projectedSkill.body).toContain('read_skill_file'); expect(projectedSkill.body).not.toBe(registry.grantedDocuments([skill.sourceName])[0].body);
      }
    } finally {
      removeCodexSkillRoot(root);
    }
  });
});
