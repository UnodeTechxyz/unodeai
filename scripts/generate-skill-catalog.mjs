#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * v0.9.105 (ADR-105-1): SKILL.md is the only source of a shipped skill's text.
 *
 * marketplace/skills.json keeps its `body` field for compatibility (Agent Builder reads whether an entry has
 * one), but the value is derived: it is the SKILL.md body after the frontmatter, exactly as the runtime skill
 * registry reads it. Before this, 13 bodies were older hand-kept copies that differed from SKILL.md.
 *
 *   node scripts/generate-skill-catalog.mjs          rewrite marketplace/skills.json from skills/
 *
 * Every other field, the entry order and the ids are kept as they are. An entry with no readable SKILL.md is
 * left unchanged; scripts/validate-skills.mjs reports it. The output is the same on every run for the same input.
 * scripts/validate-skills.mjs fails when the file differs from what this script would write.
 *--------------------------------------------------------------------------------------------*/
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillResourceText } from './skill-runtime-validation.mjs';

export const SKILL_CATALOG_REGENERATE_COMMAND = 'node scripts/generate-skill-catalog.mjs';

/** The body of a SKILL.md: the text after the closing frontmatter line, trimmed, as SkillRegistry reads it. */
export function skillMarkdownBody(markdown) {
  const normalized = markdown.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return undefined;
  const close = normalized.indexOf('\n---\n', 4);
  if (close < 0) return undefined;
  return normalized.slice(close + '\n---\n'.length).trim();
}

/** skills/<category>/<id>/SKILL.md bodies by folder name (the skill id). Symbolic links are not followed. */
export function readSkillBodies(skillsRoot) {
  const bodies = new Map();
  if (!existsSync(skillsRoot)) return bodies;
  for (const category of readdirSync(skillsRoot, { withFileTypes: true }).sort(byName)) {
    if (!category.isDirectory() || category.name.startsWith('.')) continue;
    for (const skill of readdirSync(join(skillsRoot, category.name), { withFileTypes: true }).sort(byName)) {
      if (!skill.isDirectory() || skill.name.startsWith('.') || bodies.has(skill.name)) continue;
      const file = join(skillsRoot, category.name, skill.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      const decoded = skillResourceText(readFileSync(file));
      const body = decoded && skillMarkdownBody(decoded.text);
      if (body) bodies.set(skill.name, body);
    }
  }
  return bodies;
}

/**
 * The catalog with every body derived from SKILL.md. Returns the exact file text, and the ids whose body the
 * current catalog gets wrong (an absent body counts as wrong).
 */
export function generateSkillCatalog(projectRoot) {
  const catalogPath = resolve(projectRoot, 'marketplace', 'skills.json');
  const current = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (!Array.isArray(current)) throw new Error('marketplace/skills.json must be a JSON array');
  const bodies = readSkillBodies(resolve(projectRoot, 'skills'));
  const changed = [];
  const entries = current.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !bodies.has(entry.id)) return entry;
    const body = bodies.get(entry.id);
    if (entry.body !== body) changed.push(entry.id);
    // Spreading keeps the key order, so an existing body stays where it is and only its value changes.
    return { ...entry, body };
  });
  return { catalogPath, text: `${JSON.stringify(entries, null, 2)}\n`, changed };
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { catalogPath, text, changed } = generateSkillCatalog(process.cwd());
  const before = readFileSync(catalogPath, 'utf8');
  if (before === text) {
    console.log('marketplace/skills.json is already generated from skills/.');
  } else {
    writeFileSync(catalogPath, text);
    console.log(`marketplace/skills.json regenerated from skills/${changed.length ? ` (bodies changed: ${changed.join(', ')})` : ''}.`);
  }
}
