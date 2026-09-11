import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOAD_SKILL_TOOL,
  READ_SKILL_FILE_TOOL,
  SkillRegistry,
  SkillValidationError,
  parseSkillMarkdown,
} from '../SkillRegistry';

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
        .toBe('inside reference');
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
      expect(() => SkillRegistry.load(skillsRoot)).toThrow(/symbolic links/i);
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
      expect(() => SkillRegistry.load(skillsRoot)).toThrow(/symbolic links/i);
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
      expect(() => SkillRegistry.load(linkedRoot)).toThrow(/symbolic links/i);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});
