#!/usr/bin/env node
/**
 * Candidate-only skill harvester.
 *
 * Hard constraints:
 * - This script is tooling, not extension runtime. scripts/** is excluded from the VSIX.
 * - It never writes into bundled skills/ or marketplace/skills.json.
 * - It only emits a review report. Human review + license/safety gates decide what graduates.
 */
import { writeFile } from 'node:fs/promises';

const harvestedAt = new Date().toISOString();
const defaultSources = [
  'https://www.skills.sh/',
];
const sources = (process.env.SKILL_HARVEST_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const sourceUrls = sources.length > 0 ? sources : defaultSources;
const outputPath = process.argv[2] || 'skill-harvest-candidates.json';

const candidates = [];
const failures = [];

for (const url of sourceUrls) {
  try {
    const html = await fetchText(url);
    candidates.push(...extractSkillsShCandidates(html, url));
  } catch (error) {
    failures.push({ url, error: error instanceof Error ? error.message : String(error) });
  }
}

const report = {
  harvestedAt,
  sourceUrls,
  policy: {
    mode: 'candidate-only',
    bundledAutoImport: false,
    requiredGates: [
      'license allowlist',
      'instruction-safety scan',
      'brand scrub',
      'dedup/fit review',
      'provenance and notices',
      'human approval',
    ],
  },
  candidates: dedupeCandidates(candidates),
  failures,
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (report.candidates.length === 0) {
  console.error(`No skill candidates harvested. Wrote ${outputPath}.`);
  process.exitCode = 1;
} else {
  console.log(`Harvested ${report.candidates.length} candidate skills into ${outputPath}.`);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'unode-skill-harvest/0.1 candidate-only',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function extractSkillsShCandidates(html, sourceUrl) {
  const text = decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  const found = [];
  const pattern = /\b(\d{1,4})\s+([a-z0-9][a-z0-9-]{1,80})\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.[A-Za-z]{2,})\s+(\d+(?:\.\d+)?[KMB]?)\b/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [, rank, name, repository, installs] = match;
    found.push({
      source: 'skills.sh',
      sourceUrl,
      rank: Number(rank),
      name,
      repository,
      installs,
      harvestedAt,
      status: 'candidate',
      nextReview: [
        'verify source repo and commit',
        'check SPDX-compatible license',
        'scan instructions for unsafe directives',
        'brand-scrub and rewrite into Unode vocabulary',
        'deduplicate against bundled skills',
      ],
    });
  }
  return found;
}

function dedupeCandidates(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = `${item.source}:${item.repository}:${item.name}`.toLowerCase();
    const existing = byKey.get(key);
    if (!existing || item.rank < existing.rank) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
