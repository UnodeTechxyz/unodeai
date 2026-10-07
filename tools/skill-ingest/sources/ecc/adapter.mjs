#!/usr/bin/env node
/**
 * ECC source adapter M0.
 *
 * Reads a clean checkout at one pinned commit, projects untrusted Skill Markdown into temporary
 * instruction-only candidates, and invokes the existing source-neutral ingestion gate. It never imports,
 * installs, enables, or executes candidate content. Persisted reports deliberately contain metadata and
 * reason codes only: no upstream descriptions, bodies, excerpts, scripts, attachments, or rewrites.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCandidateRoot, classifyLicenseId } from '../../index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '../../../..');
const DEFAULT_DESCRIPTOR = JSON.parse(readFileSync(path.join(HERE, 'source.json'), 'utf8'));
const EXECUTABLE = /\.(?:exe|dll|node|wasm|cmd|bat|ps1|sh|js|cjs|mjs|ts|tsx|py|rb|pl|jar|swift)$/i;
const ATTACHMENT = /\.(?:png|jpe?g|gif|webp|svg|pdf|zip|tar|gz|mp[34]|mov|avi|bin)$/i;
const STANDARD_FIELDS = new Set(['name', 'description']);
const DOMAIN_ORDER = ['Engineering', 'Marketing', 'Compliance', 'HR/People', 'Research', 'Operations', 'unclassified'];
const DOMAIN_ROLE_FIT = {
  Engineering: { roleIds: ['architect', 'senior-dev', 'reviewer', 'tester'], teamPresetIds: ['full-stack-delivery', 'reliability-engineering'], requiresCustomRole: false },
  Marketing: { roleIds: ['content-strategist', 'growth-marketer', 'market-researcher', 'seo-analyst'], teamPresetIds: ['marketing', 'brand-lifecycle'], requiresCustomRole: false },
  Compliance: { roleIds: ['contract-analyst', 'privacy-data-protection-officer', 'grc-analyst'], teamPresetIds: ['contract-compliance', 'security-governance'], requiresCustomRole: false },
  'HR/People': { roleIds: ['business-analyst', 'knowledge-manager'], teamPresetIds: [], requiresCustomRole: true },
  Research: { roleIds: ['market-researcher', 'data-analyst', 'knowledge-manager'], teamPresetIds: ['business-analysis', 'data-intelligence'], requiresCustomRole: false },
  Operations: { roleIds: ['workflow-automation-specialist', 'procurement-analyst', 'support-operations-analyst'], teamPresetIds: ['business-operations'], requiresCustomRole: false },
  unclassified: { roleIds: [], teamPresetIds: [], requiresCustomRole: true },
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function slash(value) {
  return value.replace(/\\/g, '/');
}

function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function pathSafetyFindings(entries) {
  const findings = [];
  for (const entry of entries) {
    const rel = slash(String(entry.path || ''));
    if (!rel || path.posix.isAbsolute(rel) || rel.split('/').includes('..') || rel.includes('\0')) {
      findings.push({ severity: 'reject', code: 'path_escape' });
      continue;
    }
    if (entry.type === 'symlink') findings.push({ severity: 'reject', code: 'symbolic_link' });
    if (entry.type === 'directory' && /(^|\/)(?:scripts?|bin)(?:\/|$)/i.test(rel)) {
      findings.push({ severity: 'reject', code: 'executable_directory' });
    }
    if (entry.type === 'file' && EXECUTABLE.test(rel)) findings.push({ severity: 'reject', code: 'executable_payload' });
    if (entry.type === 'file' && ATTACHMENT.test(rel)) findings.push({ severity: 'flag', code: 'attachment_companion' });
  }
  return uniqueFindings(findings);
}

function decodeScalar(raw, continuation) {
  const value = raw.trim();
  if (/^[>|][+-]?$/.test(value)) {
    const lines = continuation.map((line) => line.replace(/^\s+/, '')).filter((line) => line.trim());
    return value.startsWith('>') ? lines.join(' ') : lines.join('\n');
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseEccFrontmatter(raw, label = 'SKILL.md') {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const findings = [];
  if (!text.startsWith('---\n')) {
    return { name: '', description: '', body: text, fields: {}, sourceMetadata: emptyMetadata(), findings: [{ severity: 'reject', code: 'frontmatter_missing' }] };
  }
  const close = text.indexOf('\n---\n', 4);
  if (close < 0) {
    return { name: '', description: '', body: text, fields: {}, sourceMetadata: emptyMetadata(), findings: [{ severity: 'reject', code: 'frontmatter_unclosed' }] };
  }
  const lines = text.slice(4, close).split('\n');
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#') || /^\s/.test(line)) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))$/.exec(line);
    if (!match) {
      findings.push({ severity: 'reject', code: 'frontmatter_malformed' });
      continue;
    }
    let end = i + 1;
    while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]))) end++;
    records.push({ key: match[1], raw: match[2] ?? '', continuation: lines.slice(i + 1, end) });
    i = end - 1;
  }
  const fields = {};
  const fieldBlocks = {};
  const nestedScalars = {};
  for (const record of records) {
    if (Object.hasOwn(fields, record.key)) {
      findings.push({ severity: 'reject', code: 'frontmatter_duplicate_key' });
      continue;
    }
    fields[record.key] = decodeScalar(record.raw, record.continuation);
    fieldBlocks[record.key] = [record.raw, ...record.continuation].join('\n');
    for (const line of record.continuation) {
      const nested = /^\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
      if (nested && nested[2] && !/^[>|][+-]?$/.test(nested[2])) nestedScalars[`${record.key}.${nested[1]}`] = decodeScalar(nested[2], []);
    }
  }
  const body = text.slice(close + '\n---\n'.length).trim();
  if (!String(fields.name || '').trim()) findings.push({ severity: 'reject', code: 'source_name_missing' });
  if (!String(fields.description || '').trim()) findings.push({ severity: 'reject', code: 'source_description_missing' });
  if (!body) findings.push({ severity: 'reject', code: 'source_body_empty' });
  const unknownKeys = Object.keys(fields).filter((key) => !STANDARD_FIELDS.has(key)).sort();
  const unknownFieldHashes = Object.fromEntries(unknownKeys.map((key) => [key, sha256(fieldBlocks[key] ?? '')]));
  const nestedKeys = Object.keys(nestedScalars).sort();
  return {
    name: String(fields.name || '').trim(),
    description: String(fields.description || '').trim(),
    body,
    fields,
    nestedScalars,
    sourceMetadata: {
      keys: Object.keys(fields).sort(),
      unknownKeys,
      unknownFieldHashes,
      nestedKeys,
      nestedFieldHashes: Object.fromEntries(nestedKeys.map((key) => [key, sha256(nestedScalars[key])])),
      frontmatterSha256: sha256(text.slice(4, close)),
    },
    findings: uniqueFindings(findings),
    label,
  };
}

function emptyMetadata() {
  return { keys: [], unknownKeys: [], unknownFieldHashes: {}, nestedKeys: [], nestedFieldHashes: {}, frontmatterSha256: sha256('') };
}

async function collectEntries(root, current = root, entries = []) {
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    const relativePath = slash(path.relative(root, absolute));
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      entries.push({ path: relativePath, type: 'symlink', size: stat.size });
    } else if (stat.isDirectory()) {
      entries.push({ path: relativePath, type: 'directory', size: 0 });
      await collectEntries(root, absolute, entries);
    } else if (stat.isFile()) {
      entries.push({ path: relativePath, type: 'file', size: stat.size });
    }
  }
  return entries;
}

async function discoverSkills(sourceRoot, descriptor) {
  const found = [];
  const sourceFindings = [];
  for (const declared of descriptor.skillRoots) {
    const root = path.resolve(sourceRoot, declared);
    if (!isInside(sourceRoot, root) || !existsSync(root)) throw new Error(`Declared ECC skill root is missing or escapes the source: ${declared}`);
    const entries = await collectEntries(root);
    sourceFindings.push(...pathSafetyFindings(entries).filter((item) => item.code === 'path_escape' || item.code === 'symbolic_link'));
    for (const entry of entries) {
      if (entry.type === 'file' && path.posix.basename(entry.path) === descriptor.skillFile) {
        const absolute = path.join(root, ...entry.path.split('/'));
        const originalPath = slash(path.relative(sourceRoot, absolute));
        if (!isInside(sourceRoot, absolute)) throw new Error(`Discovered ECC path escapes the source: ${originalPath}`);
        found.push({ absolute, directory: path.dirname(absolute), originalPath });
      }
    }
  }
  found.sort((a, b) => a.originalPath.localeCompare(b.originalPath));
  return { found, sourceFindings: uniqueFindings(sourceFindings) };
}

function runGit(sourceRoot, args) {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_EXTERNAL_DIFF: '',
  };
  // Repository-local config is untrusted too. In particular, core.fsmonitor can name an executable;
  // disable it and hooks even though the two read-only subcommands below do not intentionally invoke one.
  const safeArgs = [
    '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${path.join(HERE, 'fixtures', 'disabled-hooks')}`,
    '-c', 'diff.external=',
    '-c', 'core.pager=cat',
    '-C', sourceRoot,
    ...args,
  ];
  const result = spawnSync('git', safeArgs, { encoding: 'utf8', shell: false, env, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ECC source identity check failed: ${(result.stderr || result.stdout || 'git failed').trim()}`);
  return result.stdout.trim();
}

export function sourceIdentityViolations({ expectedCommit, observedCommit, dirtyPaths = '' }) {
  const violations = [];
  if (observedCommit !== expectedCommit) violations.push('source_commit_mismatch');
  if (String(dirtyPaths).trim()) violations.push('source_checkout_dirty');
  return violations;
}

async function verifyGitIdentity(sourceRoot, descriptor) {
  const observedCommit = runGit(sourceRoot, ['rev-parse', 'HEAD']);
  const dirtyPaths = runGit(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...descriptor.skillRoots, descriptor.rootLicense.path]);
  const violations = sourceIdentityViolations({ expectedCommit: descriptor.pinnedCommit, observedCommit, dirtyPaths });
  if (violations.length) throw new Error(`ECC source identity refused: ${violations.join(', ')}`);
  const rootLicense = await readFile(path.join(sourceRoot, descriptor.rootLicense.path));
  if (sha256(rootLicense) !== descriptor.rootLicense.sha256) throw new Error('ECC source identity refused: root_license_hash_mismatch');
  return { kind: 'clean-git-checkout', commit: observedCommit };
}

function sourceUrl(descriptor, originalPath) {
  return `${descriptor.repositoryUrl}/blob/${descriptor.pinnedCommit}/${originalPath}`;
}

function detectLicenseText(text) {
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(text)) return 'AGPL-3.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(text)) return 'LGPL-3.0';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) return 'GPL-3.0';
  if (/Apache License\s+Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/MIT License/i.test(text) || /Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/BSD 3-Clause License/i.test(text)) return 'BSD-3-Clause';
  if (/BSD 2-Clause License/i.test(text)) return 'BSD-2-Clause';
  if (/ISC License/i.test(text)) return 'ISC';
  if (/Creative Commons Attribution 4\.0/i.test(text)) return 'CC-BY-4.0';
  return undefined;
}

function thirdPartyOrigin(parsed, descriptor) {
  const origin = String(parsed.fields.origin || parsed.nestedScalars?.['metadata.origin'] || parsed.fields.repo || parsed.fields.homepage || '').trim();
  const author = String(parsed.fields.author || parsed.nestedScalars?.['metadata.author'] || '').trim();
  const repositoryOrigin = /^(?:ECC|ECC direct-port adaptation)$/i.test(origin) || /affaan-m\/(?:ECC|everything-claude-code)/i.test(origin);
  if (origin && !repositoryOrigin) return true;
  return Boolean(author && author.toLowerCase() !== descriptor.defaultAuthor.toLowerCase());
}

async function nearestLicenseFile(sourceRoot, candidateDir, descriptor) {
  let current = candidateDir;
  while (isInside(sourceRoot, current)) {
    for (const name of ['LICENSE', 'LICENSE.md', 'COPYING']) {
      const absolute = path.join(current, name);
      if (!existsSync(absolute)) continue;
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) return { spdx: undefined, path: slash(path.relative(sourceRoot, absolute)), reason: 'license_file_unsafe' };
      const text = await readFile(absolute, 'utf8');
      return { spdx: detectLicenseText(text), path: slash(path.relative(sourceRoot, absolute)), reason: detectLicenseText(text) ? undefined : 'license_file_unknown' };
    }
    if (path.resolve(current) === path.resolve(sourceRoot)) break;
    current = path.dirname(current);
  }
  return undefined;
}

export async function resolveEccLicense({ sourceRoot, candidateDir, parsed, descriptor = DEFAULT_DESCRIPTOR }) {
  const findings = [];
  const declared = String(parsed.fields.license || '').trim();
  const fileEvidence = await nearestLicenseFile(sourceRoot, candidateDir, descriptor);
  const repositoryEvidence = {
    spdx: descriptor.rootLicense.spdxLicenseId,
    path: descriptor.rootLicense.path,
    url: descriptor.rootLicense.url,
    scope: 'repository',
  };
  let selected;
  if (declared) {
    selected = { spdx: declared, path: slash(path.relative(sourceRoot, path.join(candidateDir, descriptor.skillFile))), url: sourceUrl(descriptor, slash(path.relative(sourceRoot, path.join(candidateDir, descriptor.skillFile)))), scope: 'candidate-frontmatter' };
    if (fileEvidence && slash(path.dirname(fileEvidence.path)) === slash(path.relative(sourceRoot, candidateDir)) && fileEvidence.spdx && fileEvidence.spdx !== declared) {
      findings.push({ severity: 'reject', code: 'license_conflict' });
    }
  } else if (fileEvidence) {
    selected = { ...fileEvidence, url: sourceUrl(descriptor, fileEvidence.path), scope: fileEvidence.path === descriptor.rootLicense.path ? 'repository' : 'ancestor-file' };
    if (fileEvidence.reason) findings.push({ severity: 'reject', code: fileEvidence.reason });
  } else {
    selected = repositoryEvidence;
  }
  if (thirdPartyOrigin(parsed, descriptor) && selected.scope === 'repository') {
    findings.push({ severity: 'reject', code: 'ambiguous_third_party_origin' });
    selected = { ...selected, spdx: undefined };
  }
  const classification = classifyLicenseId(selected.spdx || '');
  if (classification.state === 'missing') findings.push({ severity: 'reject', code: 'no_license' });
  if (classification.state === 'unknown') findings.push({ severity: 'reject', code: 'unknown_license' });
  if (classification.state === 'rejected') findings.push({ severity: 'reject', code: 'disallowed_license' });
  return {
    status: findings.some((item) => item.severity === 'reject') ? 'REJECT' : 'PASS',
    spdxLicenseId: selected.spdx,
    sourcePath: selected.path,
    sourceUrl: selected.url,
    scope: selected.scope,
    findings: uniqueFindings(findings),
  };
}

function inferDomain(parsed) {
  // Domain is a positioning handoff, so classify from identity and activation description only. Full bodies
  // commonly mention an audit or policy as one step and would otherwise mislabel engineering procedures.
  const text = `${parsed.name} ${parsed.description}`.toLowerCase();
  if (/\b(?:compliance|legal|regulat|hipaa|gdpr|privacy|customs|trade control|policy compliance)\b/.test(text)) return 'Compliance';
  if (/\b(?:human resources|hr|people ops|people operations|recruit|hiring|employee|onboarding|performance review|career|resume)\b/.test(text)) return 'HR/People';
  if (/\b(?:marketing|brand|campaign|seo|content strategy|content engine|social media|social publisher|copywriting|newsletter|article writing|investor outreach|investor materials|growth)\b/.test(text)) return 'Marketing';
  if (/\b(?:research|literature review|market research|source verification|competitive intelligence|competitive report|competitive platform|scholar|pubmed|uspto)\b/.test(text)) return 'Research';
  if (/\b(?:operations|logistics|inventory|procurement|supply chain|scheduling|quality management|carrier|warehouse|billing ops|workspace ops|project flow)\b/.test(text)) return 'Operations';
  if (/\b(?:code|coding|engineering|software|api|frontend|backend|database|debug|test|testing|deploy|architecture|runtime|framework|pattern|security|network|docker|kubernetes|workflow|pipeline|ui|agent)\b/.test(text)) return 'Engineering';
  return 'unclassified';
}

function dependencyClasses(parsed, entries, bodyLimit) {
  const text = `${Object.values(parsed.fields).join(' ')}\n${parsed.body}`.toLowerCase();
  const classes = new Set();
  if (/\bclaude code\b|\.claude\b|claude\.md/.test(text)) classes.add('claude-code');
  if (/\bmcp\b|model context protocol/.test(text)) classes.add('mcp');
  if (/\bhooks?\b|pretooluse|posttooluse/.test(text)) classes.add('hook');
  if (/\b(?:cli|command line|terminal|bash|shell)\b/.test(text)) classes.add('cli');
  if (/\b(?:npm|pnpm|yarn|pip|uv|brew|apt)(?:\s+|\s+run\s+)(?:install|add|i)\b|package-install/.test(text)) classes.add('package-install');
  if (/https?:\/\/|\b(?:curl|wget|fetch|web search|network)\b/.test(text)) classes.add('network');
  if (entries.some((entry) => entry.type === 'file' && EXECUTABLE.test(entry.path))) classes.add('script-companion');
  if (entries.some((entry) => entry.type === 'file' && ATTACHMENT.test(entry.path))) classes.add('attachment');
  if (parsed.body.length > bodyLimit) classes.add('oversize');
  return [...classes].sort();
}

function permissionClasses(parsed, dependencies) {
  const text = `${Object.values(parsed.fields).join(' ')}\n${parsed.body}`.toLowerCase();
  const permissions = new Set();
  if (/\bread\b|\bgrep\b|\bglob\b/.test(text)) permissions.add('file-read');
  if (/\bwrite\b|\bedit\b|\bcreate file\b/.test(text)) permissions.add('file-write');
  if (dependencies.includes('cli') || dependencies.includes('script-companion')) permissions.add('shell');
  if (dependencies.includes('network')) permissions.add('network');
  if (dependencies.includes('mcp')) permissions.add('mcp');
  return [...permissions].sort();
}

export function classifyCompatibility({ parsed, entries = [], ingestionStatus = 'PASS', bodyLimit = 24000, adapterFindings = [] }) {
  const dependencies = dependencyClasses(parsed, entries, bodyLimit);
  const domain = inferDomain(parsed);
  const hard = adapterFindings.some((item) => item.severity === 'reject' && ['path_escape', 'symbolic_link', 'executable_directory', 'executable_payload'].includes(item.code));
  let status = 'native';
  if (hard) status = 'incompatible';
  else if (ingestionStatus === 'REJECT') status = 'manual-review';
  else if (dependencies.some((item) => ['claude-code', 'mcp', 'hook', 'cli', 'package-install', 'network', 'script-companion', 'attachment'].includes(item))) status = 'needs-dependency';
  else if (parsed.sourceMetadata.unknownKeys.length > 0 || dependencies.includes('oversize')) status = 'needs-transform';
  return {
    status,
    dependencyClasses: dependencies,
    permissionClasses: permissionClasses(parsed, dependencies),
    domain,
    roleTeamFit: { basis: 'domain-only-static-candidate', ...DOMAIN_ROLE_FIT[domain] },
    progressiveDisclosure: parsed.body.length <= bodyLimit ? 'native' : 'requires-split',
    behaviouralEffectiveness: 'not-measured',
    pilotEligible: ingestionStatus !== 'REJECT' && !['incompatible', 'manual-review'].includes(status),
  };
}

function uniqueFindings(findings) {
  const map = new Map();
  for (const finding of findings) map.set(`${finding.severity}:${finding.code}`, { severity: finding.severity, code: finding.code });
  return [...map.values()].sort((a, b) => `${a.severity}:${a.code}`.localeCompare(`${b.severity}:${b.code}`));
}

function combinedStatus(findings) {
  if (findings.some((item) => item.severity === 'reject')) return 'REJECT';
  if (findings.some((item) => item.severity === 'flag')) return 'FLAG';
  return 'PASS';
}

function normalizeName(name, originalPath, duplicate) {
  const valid = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) && name.length >= 4 && name.length <= 64;
  let base = valid ? name : slash(path.dirname(originalPath)).split('/').at(-1).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!base || !/^[a-z]/.test(base)) base = `ecc-${base || 'candidate'}`;
  base = base.slice(0, 50).replace(/-$/, '');
  return duplicate || !valid ? `${base}-${sha256(originalPath).slice(0, 8)}` : base;
}

function normalizedMarkdown(id, parsed) {
  const description = parsed.description.replace(/\s+/g, ' ').trim();
  return `---\nname: ${id}\ndescription: ${description}\n---\n${parsed.body}\n`;
}

async function materializeCandidate(tempRoot, index, candidate, descriptor) {
  const folder = `${String(index).padStart(4, '0')}-${sha256(candidate.originalPath).slice(0, 12)}`;
  const directory = path.join(tempRoot, folder);
  await mkdir(directory, { recursive: true });
  const normalized = normalizedMarkdown(candidate.id, candidate.parsed);
  const selectedLicense = candidate.license.spdxLicenseId || 'UNKNOWN';
  const provenance = {
    sourceUrl: sourceUrl(descriptor, candidate.originalPath),
    commitSha: descriptor.pinnedCommit,
    spdxLicenseId: selectedLicense,
    licenseUrl: candidate.license.sourceUrl || descriptor.rootLicense.url,
    author: String(candidate.parsed.fields.author || descriptor.defaultAuthor),
    harvestedAt: descriptor.snapshotDate,
    originalPath: candidate.originalPath,
  };
  await writeFile(path.join(directory, 'SKILL.md'), normalized, 'utf8');
  await writeFile(path.join(directory, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  return { folder, normalizedSha256: sha256(normalized) };
}

function aggregate(candidates) {
  const domains = Object.fromEntries(DOMAIN_ORDER.map((domain) => [domain, {
    discovered: 0, licenseResolved: 0, structurallyNormalized: 0, PASS: 0, FLAG: 0, REJECT: 0,
    dependencyClasses: {}, pilotEligible: 0,
  }]));
  for (const candidate of candidates) {
    const row = domains[candidate.compatibility.domain];
    row.discovered++;
    if (candidate.license.status === 'PASS') row.licenseResolved++;
    if (!candidate.ingestion.reasonCodes.some((code) => code.startsWith('frontmatter_') || code.startsWith('source_'))) row.structurallyNormalized++;
    row[candidate.ingestion.status]++;
    if (candidate.compatibility.pilotEligible) row.pilotEligible++;
    for (const dependency of candidate.compatibility.dependencyClasses) row.dependencyClasses[dependency] = (row.dependencyClasses[dependency] || 0) + 1;
  }
  for (const row of Object.values(domains)) row.dependencyClasses = Object.fromEntries(Object.entries(row.dependencyClasses).sort(([a], [b]) => a.localeCompare(b)));
  return domains;
}

function publicCandidate(candidate, gateCandidate, normalizedSha256, descriptor) {
  const gateFindings = (gateCandidate?.findings || []).map(({ severity, code }) => ({ severity, code }));
  const findings = uniqueFindings([...candidate.findings, ...candidate.license.findings, ...gateFindings]);
  const ingestionStatus = combinedStatus(findings);
  const compatibility = classifyCompatibility({
    parsed: candidate.parsed,
    entries: candidate.entries,
    ingestionStatus,
    bodyLimit: descriptor.limits.bodyChars,
    adapterFindings: findings,
  });
  return {
    id: candidate.id,
    sourcePath: candidate.originalPath,
    rawSha256: candidate.rawSha256,
    rawBytes: candidate.rawBytes,
    sourceMetadata: candidate.parsed.sourceMetadata,
    provenance: {
      status: candidate.license.status === 'PASS' ? 'resolved' : 'unresolved',
      sourceUrl: sourceUrl(descriptor, candidate.originalPath),
      commit: descriptor.pinnedCommit,
      originalPath: candidate.originalPath,
      originClass: thirdPartyOrigin(candidate.parsed, descriptor) ? 'declared-third-party' : 'repository',
    },
    license: {
      status: candidate.license.status,
      spdxLicenseId: candidate.license.spdxLicenseId || null,
      sourcePath: candidate.license.sourcePath || null,
      sourceUrl: candidate.license.sourceUrl || null,
      scope: candidate.license.scope,
    },
    transformation: {
      normalizedSha256,
      operations: ['line-endings-normalized', 'frontmatter-projected-to-name-description', 'candidate-local-provenance-generated'],
    },
    ingestion: {
      measurement: 'ingestion',
      status: ingestionStatus,
      reasonCodes: findings.map((item) => item.code).sort(),
    },
    compatibility,
    citation: {
      measurement: 'ingestion',
      source: descriptor.repositoryUrl,
      commit: descriptor.pinnedCommit,
      path: candidate.originalPath,
    },
  };
}

export async function runEccAdapter({ sourceRoot, descriptor = DEFAULT_DESCRIPTOR, fixtureIdentity, bundledSkillsRoot = path.join(PROJECT_ROOT, 'skills') }) {
  const root = path.resolve(sourceRoot);
  let sourceIdentity;
  if (fixtureIdentity) {
    const fixtureRoot = path.join(HERE, 'fixtures');
    if (!descriptor.id.endsWith('-synthetic-fixture') || !isInside(fixtureRoot, root)) {
      throw new Error('ECC source identity refused: fixture_identity_outside_test_fixture');
    }
    sourceIdentity = fixtureIdentity;
  } else {
    sourceIdentity = await verifyGitIdentity(root, descriptor);
  }
  if (sourceIdentity.commit !== descriptor.pinnedCommit) throw new Error('ECC source identity refused: source_commit_mismatch');
  const { found, sourceFindings } = await discoverSkills(root, descriptor);
  if (sourceFindings.length) throw new Error(`ECC source identity refused: ${sourceFindings.map((item) => item.code).join(', ')}`);
  if (found.length !== descriptor.expectedSkillCount) {
    throw new Error(`ECC inventory mismatch: discovered ${found.length}, expected ${descriptor.expectedSkillCount}`);
  }

  const prepared = [];
  for (const item of found) {
    const raw = await readFile(item.absolute);
    const parsed = parseEccFrontmatter(raw.toString('utf8'), item.originalPath);
    const entries = await collectEntries(item.directory);
    const findings = [...parsed.findings, ...pathSafetyFindings(entries)];
    if (raw.byteLength > descriptor.limits.sourceFileBytes) findings.push({ severity: 'reject', code: 'source_file_oversize' });
    if (parsed.body.length > descriptor.limits.bodyChars) findings.push({ severity: 'flag', code: 'body_over_disclosure_limit' });
    const license = await resolveEccLicense({ sourceRoot: root, candidateDir: item.directory, parsed, descriptor });
    prepared.push({ ...item, rawSha256: sha256(raw), rawBytes: raw.byteLength, parsed, entries, findings: uniqueFindings(findings), license });
  }
  const nameCounts = new Map();
  for (const candidate of prepared) nameCounts.set(candidate.parsed.name, (nameCounts.get(candidate.parsed.name) || 0) + 1);
  for (const candidate of prepared) {
    const duplicate = Boolean(candidate.parsed.name && nameCounts.get(candidate.parsed.name) > 1);
    candidate.id = normalizeName(candidate.parsed.name, candidate.originalPath, duplicate);
    if (duplicate) candidate.findings = uniqueFindings([...candidate.findings, { severity: 'reject', code: 'duplicate_source_name' }]);
    if (candidate.id !== candidate.parsed.name && !duplicate) candidate.findings = uniqueFindings([...candidate.findings, { severity: 'reject', code: 'invalid_source_name' }]);
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'unode-ecc-candidates-'));
  try {
    const normalized = [];
    for (let i = 0; i < prepared.length; i++) normalized.push(await materializeCandidate(tempRoot, i, prepared[i], descriptor));
    const gate = await checkCandidateRoot(tempRoot, { bundledSkillsRoot });
    const gateByFolder = new Map(gate.candidates.map((candidate) => [candidate.relativePath, candidate]));
    const candidates = prepared.map((candidate, i) => publicCandidate(candidate, gateByFolder.get(normalized[i].folder), normalized[i].normalizedSha256, descriptor));
    candidates.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    const summary = {
      discovered: candidates.length,
      ingestion: Object.fromEntries(['PASS', 'FLAG', 'REJECT'].map((status) => [status, candidates.filter((item) => item.ingestion.status === status).length])),
      compatibility: Object.fromEntries(['native', 'needs-transform', 'needs-dependency', 'manual-review', 'incompatible'].map((status) => [status, candidates.filter((item) => item.compatibility.status === status).length])),
      domains: aggregate(candidates),
    };
    return {
      schemaVersion: 1,
      source: {
        id: descriptor.id,
        repositoryUrl: descriptor.repositoryUrl,
        commit: descriptor.pinnedCommit,
        snapshotLabel: descriptor.snapshotLabel,
        identityKind: sourceIdentity.kind,
        expectedSkillCount: descriptor.expectedSkillCount,
      },
      measurement: {
        kind: 'ingestion',
        compatibilityIsBehaviouralEffectiveness: false,
        candidateContentExecuted: false,
        candidateContentInstalled: false,
        candidateContentBundled: false,
        candidateContentEnabled: false,
      },
      summary,
      candidates,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export function renderHumanSummary(report) {
  const lines = [
    '# ECC Source Adapter M0 — compatibility snapshot',
    '',
    `Pinned source: \`${report.source.repositoryUrl}@${report.source.commit}\` (${report.source.snapshotLabel}).`,
    '',
    '**What this measured:** deterministic source inventory, provenance/licence resolution, the existing UnodeAI ingestion gates, and static host/runtime dependency signals.',
    '',
    '**What this did not measure:** behavioural effectiveness. Compatibility is not effectiveness, and PASS is not approval. No ECC Skill was installed, bundled, enabled, available to the extension, or executed.',
    '',
    '| Domain | Discovered | Licence resolved | Structurally normalized | PASS | FLAG | REJECT | Dependency classes | Later pilot eligible |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
  ];
  for (const domain of DOMAIN_ORDER) {
    const row = report.summary.domains[domain];
    const dependencies = Object.entries(row.dependencyClasses).map(([name, count]) => `${name}:${count}`).join(', ') || 'none';
    lines.push(`| ${domain} | ${row.discovered} | ${row.licenseResolved} | ${row.structurallyNormalized} | ${row.PASS} | ${row.FLAG} | ${row.REJECT} | ${dependencies} | ${row.pilotEligible} |`);
  }
  lines.push('', 'Every per-candidate citation in the machine report is labelled `measurement: ingestion`; no row is evidence that a Skill can complete a job.', '');
  return lines.join('\n');
}

function metadataOnly(value) {
  if (Array.isArray(value)) return value.every(metadataOnly);
  if (!value || typeof value !== 'object') return true;
  const forbiddenKeys = new Set(['description', 'body', 'excerpt', 'scrubbedBody', 'scrubDiff']);
  return Object.entries(value).every(([key, child]) => !forbiddenKeys.has(key) && metadataOnly(child));
}

async function selfTest() {
  const fixtureRoot = path.join(HERE, 'fixtures', 'source');
  const descriptor = JSON.parse(await readFile(path.join(HERE, 'fixtures', 'source.json'), 'utf8'));
  const options = { sourceRoot: fixtureRoot, descriptor, fixtureIdentity: { kind: 'synthetic-fixture', commit: descriptor.pinnedCommit }, bundledSkillsRoot: false };
  const first = await runEccAdapter(options);
  const second = await runEccAdapter(options);
  const firstText = `${JSON.stringify(first, null, 2)}\n`;
  if (firstText !== `${JSON.stringify(second, null, 2)}\n`) throw new Error('ECC adapter self-test failed: identical inputs were not deterministic');
  if (!metadataOnly(first)) throw new Error('ECC adapter self-test failed: report leaked candidate content');
  if (first.summary.discovered !== descriptor.expectedSkillCount) throw new Error('ECC adapter self-test failed: fixture inventory mismatch');
  if (!first.candidates.every((item) => item.citation.measurement === 'ingestion')) throw new Error('ECC adapter self-test failed: an unlabeled compatibility citation escaped');
  console.log(`ECC adapter self-test passed (${first.summary.discovered} synthetic candidates; metadata-only deterministic report).`);
}

function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' || args[i] === '--summary') options[args[i].slice(2)] = args[++i];
    else positional.push(args[i]);
  }
  return { positional, options };
}

async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseArgs(argv);
  if (positional[0] === 'self-test') return selfTest();
  if (positional[0] !== 'check' || !positional[1]) {
    process.stderr.write('Usage: ecc-source-adapter check <clean-pinned-checkout> [--json report.json] [--summary summary.md]\n       ecc-source-adapter self-test\n');
    process.exitCode = positional.length ? 1 : 0;
    return;
  }
  const report = await runEccAdapter({ sourceRoot: positional[1] });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const summary = renderHumanSummary(report);
  if (options.json) {
    const output = path.resolve(options.json);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, json, 'utf8');
  } else {
    process.stdout.write(json);
  }
  if (options.summary) {
    const output = path.resolve(options.summary);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, summary, 'utf8');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
