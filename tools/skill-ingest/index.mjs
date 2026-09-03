/**
 * Skill ingestion gates.
 *
 * Hard constraints:
 * - This tooling is not extension runtime and is excluded from the VSIX via tools/**.
 * - It never auto-installs, auto-enables, or writes into bundled skills/.
 * - A PASS/FLAG result only makes a candidate reviewable; human approval is still required.
 * - The license allowlist is closed. Missing or unclear license data is a REJECT.
 */
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'CC0-1.0',
  'Unlicense',
  'CC-BY-4.0',
]);

const REJECTED_LICENSE_PATTERNS = [
  /^AGPL/i,
  /^GPL/i,
  /^LGPL/i,
  /GPL-\d/i,
  /AGPL-\d/i,
  /LGPL-\d/i,
  /^CC-BY-SA/i,
  /^CC-BY-NC/i,
  /^CC-BY-ND/i,
  /NonCommercial/i,
  /NoDerivatives/i,
  /all rights reserved/i,
];

const EXECUTABLE_PAYLOAD = /\.(?:exe|dll|node|wasm|cmd|bat|ps1|sh|js|cjs|mjs|ts)$/i;
const CATEGORY_NAMES = new Set([
  'development',
  'testing',
  'design',
  'documentation',
  'management',
  'security',
  'infrastructure',
  'data',
  'external',
  'rigor',
  'marketing',
]);

const BRAND_REPLACEMENTS = [
  { token: 'OmniSolu', pattern: /\bOmniSolu\b/g, replacement: 'Unode' },
  { token: 'omnisolu', pattern: /\bomnisolu\b/g, replacement: 'unode' },
  { token: 'weroamxyz', pattern: /\bweroamxyz\b/gi, replacement: 'Unode' },
  { token: 'Codeep', pattern: /\bCodeep\b/gi, replacement: 'Unode' },
  { token: 'Reasonix', pattern: /\bReasonix\b/gi, replacement: 'Unode' },
];

const SAFETY_PATTERNS = [
  {
    code: 'remote_exec_pipe',
    message: 'Remote download piped into a shell/interpreter',
    pattern: /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b.*\|.*\b(?:sh|bash|zsh|iex|invoke-expression)\b/i,
  },
  {
    code: 'base64_decode_then_run',
    message: 'Base64 decode followed by execution',
    pattern: /\bbase64\b.*(?:-d|--decode|decode).*[\|;&&]+\s*(?:sh|bash|zsh|iex|invoke-expression|powershell|pwsh|node|python)\b/i,
  },
  {
    code: 'credential_path',
    message: 'Instruction references credential or secret locations',
    pattern: /(?:~\/\.ssh|~\/\.aws|\b\.env\b|id_rsa|Authorization:|AWS_ACCESS_KEY|SECRET_KEY|API_KEY|ACCESS_TOKEN|PRIVATE KEY)/i,
  },
  {
    code: 'exfiltration_shape',
    message: 'Instruction appears to send local contents to an external URL',
    pattern: /\b(?:send|post|upload|include|exfiltrate)\b.*\b(?:contents?|file|secret|token|key)\b.*https?:\/\//i,
  },
  {
    code: 'destructive_command',
    message: 'Instruction references a destructive command that requires human review',
    pattern: /\b(?:rm\s+-rf|rmdir\s+\/s|rd\s+\/s|Remove-Item\b.*-Recurse|DROP\s+TABLE|git\s+push\s+--force)\b/i,
  },
  {
    code: 'prompt_injection',
    message: 'Instruction contains prompt-injection or role-reassignment language',
    pattern: /\b(?:ignore\s+(?:all\s+)?(?:previous|above)\s+instructions|disregard\s+(?:your\s+)?system\s+prompt|you\s+are\s+now|developer\s+mode)\b/i,
  },
  {
    code: 'overbroad_user_data_collection',
    message: 'Instruction asks for broad collection of user files or machine data',
    pattern: /\b(?:collect|read|scan)\b.*\b(?:all|entire|every)\b.*\b(?:home directory|user files|machine|computer|drive)\b/i,
  },
];

export async function checkCandidateRoot(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const bundledSkillsRoot = options.bundledSkillsRoot === false
    ? undefined
    : path.resolve(options.bundledSkillsRoot || 'skills');
  const bundled = bundledSkillsRoot && existsSync(bundledSkillsRoot)
    ? await loadBundledSkillIndex(bundledSkillsRoot)
    : [];
  const candidateDirs = await findCandidateDirs(root);
  const candidates = [];
  for (const dir of candidateDirs) {
    candidates.push(await checkCandidate(dir, { root, bundled }));
  }
  candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    summary: summarize(candidates),
    candidates,
  };
}

export async function checkCandidate(candidateDir, context = {}) {
  const abs = path.resolve(candidateDir);
  const root = context.root ? path.resolve(context.root) : path.dirname(abs);
  const relativePath = slash(path.relative(root, abs) || '.');
  const findings = [];
  const skillPath = path.join(abs, 'SKILL.md');
  let skillText = '';
  let parsed = { name: path.basename(abs), description: '', body: '' };

  await validateInstructionOnlyTree(abs, findings);

  try {
    skillText = await readFile(skillPath, 'utf8');
    parsed = parseSkillMarkdown(skillText, skillPath, findings);
  } catch (error) {
    reject(findings, 'format', 'missing_skill', `Missing or unreadable SKILL.md: ${errorMessage(error)}`);
  }

  const provenance = await readProvenance(abs, findings);
  const license = await resolveLicense(abs, skillText, provenance, findings);
  const brand = scrubBrands(skillText, parsed.name, findings);
  const category = inferCategory(abs, root, parsed, skillText);
  checkDuplicates(parsed, skillText, context.bundled || [], findings);

  const safetyFindings = scanInstructionSafety(skillText);
  findings.push(...safetyFindings);

  findings.sort(compareFindings);
  const status = findings.some((f) => f.severity === 'reject')
    ? 'REJECT'
    : findings.some((f) => f.severity === 'flag')
      ? 'FLAG'
      : 'PASS';

  return {
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
    relativePath,
    category,
    status,
    provenance,
    license,
    findings,
    ...(brand.changed ? { scrubbedBody: brand.scrubbedBody, scrubDiff: brand.diff } : {}),
  };
}

export function parseSkillMarkdown(text, filePath = 'SKILL.md', findings = []) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    reject(findings, 'format', 'frontmatter_missing', `${filePath}: frontmatter must start with ---`);
    return { name: path.basename(path.dirname(filePath)), description: '', body: normalized };
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) {
    reject(findings, 'format', 'frontmatter_unclosed', `${filePath}: frontmatter must end with ---`);
    return { name: path.basename(path.dirname(filePath)), description: '', body: normalized };
  }
  const values = new Map();
  for (const line of normalized.slice(4, end).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^(name|description):\s*(.+?)\s*$/.exec(line);
    if (!match || values.has(match[1])) {
      reject(findings, 'format', 'frontmatter_invalid', `${filePath}: frontmatter only permits one name and one description scalar`);
      continue;
    }
    values.set(match[1], unquote(match[2]));
  }
  const name = (values.get('name') || '').trim();
  const description = (values.get('description') || '').trim();
  const body = normalized.slice(end + '\n---\n'.length).trim();
  if (name.length < 4 || name.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    reject(findings, 'format', 'invalid_name', `${filePath}: name must be 4-64 lowercase kebab-case characters`);
  }
  if (description.length === 0 || description.length > 1024 || !/\b(?:when|whenever|during|use)\b/i.test(description) || words(description).length < 5) {
    reject(findings, 'format', 'invalid_description', `${filePath}: description must state what it does and when to use it`);
  }
  if (!body) {
    reject(findings, 'format', 'empty_body', `${filePath}: body must not be empty`);
  }
  return { name, description, body };
}

export function scanInstructionSafety(text) {
  const findings = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const item of SAFETY_PATTERNS) {
      if (item.pattern.test(line)) {
        flag(findings, 'instruction-safety', item.code, item.message, i + 1, line);
      }
    }
  }
  return findings;
}

export function classifyLicenseId(raw) {
  const id = String(raw || '').trim().replace(/[()]/g, '');
  if (!id) return { state: 'missing', id: '', message: 'Missing license id' };
  if (ALLOWED_LICENSES.has(id)) return { state: 'allowed', id, message: `${id} is allowed` };
  if (REJECTED_LICENSE_PATTERNS.some((pattern) => pattern.test(id))) {
    return { state: 'rejected', id, message: `${id} is not allowed for redistribution` };
  }
  return { state: 'unknown', id, message: `${id} is not on the closed allowlist` };
}

export async function resolveLicense(candidateDir, skillText, provenance, findings = []) {
  const evidence = [];
  if (provenance?.spdxLicenseId) {
    evidence.push({ source: 'provenance.spdxLicenseId', id: provenance.spdxLicenseId });
  }
  const packageJson = await readJsonIfExists(path.join(candidateDir, 'package.json'));
  if (packageJson?.license) {
    evidence.push({ source: 'package.json.license', id: String(packageJson.license) });
  }
  const header = /SPDX-License-Identifier:\s*([A-Za-z0-9+.\-]+)\b/.exec(skillText);
  if (header) {
    evidence.push({ source: 'SKILL.md SPDX header', id: header[1] });
  }
  const licenseText = await readFirstExisting(candidateDir, ['LICENSE', 'LICENSE.md', 'COPYING']);
  const detected = licenseText ? detectLicenseFromText(licenseText) : undefined;
  if (detected) {
    evidence.push({ source: 'LICENSE text', id: detected });
  }

  if (evidence.length === 0) {
    reject(findings, 'license', 'no_license', 'No license evidence found; absent license is rejected');
    return { status: 'REJECT', selected: undefined, evidence: [] };
  }

  const classified = evidence.map((item) => ({ ...item, ...classifyLicenseId(item.id) }));
  for (const item of classified) {
    if (item.state === 'rejected') {
      reject(findings, 'license', 'disallowed_license', `${item.source}: ${item.message}`);
    } else if (item.state === 'unknown') {
      reject(findings, 'license', 'unknown_license', `${item.source}: ${item.message}`);
    }
  }
  const allowed = classified.filter((item) => item.state === 'allowed');
  if (allowed.length === 0 && !classified.some((item) => item.state === 'rejected' || item.state === 'unknown')) {
    reject(findings, 'license', 'no_allowed_license', 'No allowed license id found');
  }
  const uniqueAllowed = [...new Set(allowed.map((item) => item.id))].sort();
  return {
    status: classified.some((item) => item.state !== 'allowed') ? 'REJECT' : 'PASS',
    selected: uniqueAllowed[0],
    evidence: classified.map(({ source, id, state, message }) => ({ source, id, state, message })),
  };
}

export async function readProvenance(candidateDir, findings = []) {
  const file = path.join(candidateDir, 'provenance.json');
  const provenance = await readJsonIfExists(file);
  if (!provenance) {
    reject(findings, 'provenance', 'missing_provenance', 'Missing provenance.json');
    return undefined;
  }
  const required = ['sourceUrl', 'commitSha', 'spdxLicenseId', 'licenseUrl', 'author', 'harvestedAt'];
  for (const key of required) {
    if (typeof provenance[key] !== 'string' || provenance[key].trim() === '') {
      reject(findings, 'provenance', 'missing_provenance_field', `provenance.json missing ${key}`);
    }
  }
  if (typeof provenance.sourceUrl === 'string' && !/^https?:\/\//i.test(provenance.sourceUrl)) {
    reject(findings, 'provenance', 'invalid_source_url', 'provenance.sourceUrl must be an http(s) URL');
  }
  if (typeof provenance.licenseUrl === 'string' && !/^https?:\/\//i.test(provenance.licenseUrl)) {
    reject(findings, 'provenance', 'invalid_license_url', 'provenance.licenseUrl must be an http(s) URL');
  }
  if (typeof provenance.commitSha === 'string' && !/^[a-f0-9]{7,64}$/i.test(provenance.commitSha)) {
    reject(findings, 'provenance', 'invalid_commit_sha', 'provenance.commitSha must be a git SHA');
  }
  if (typeof provenance.harvestedAt === 'string' && Number.isNaN(Date.parse(provenance.harvestedAt))) {
    reject(findings, 'provenance', 'invalid_harvest_date', 'provenance.harvestedAt must be parseable as a date');
  }
  return provenance;
}

export function scrubBrands(text, skillName, findings = []) {
  const identityHit = BRAND_REPLACEMENTS.find((item) => new RegExp(item.token, 'i').test(skillName));
  if (identityHit) {
    reject(findings, 'brand-scrub', 'brand_token_in_identity', `Skill identity contains old/external brand token "${identityHit.token}"`);
  }
  let scrubbedBody = text;
  for (const item of BRAND_REPLACEMENTS) {
    scrubbedBody = scrubbedBody.replace(item.pattern, item.replacement);
  }
  const changed = scrubbedBody !== text;
  const diff = changed ? buildLineDiff(text, scrubbedBody) : [];
  if (changed) {
    flag(findings, 'brand-scrub', 'brand_scrub_applied', 'External/old brand tokens were scrubbed for human review');
  }
  return { changed, scrubbedBody, diff };
}

export function checkDuplicates(parsed, skillText, bundled, findings = []) {
  const candidateTokens = tokenSet(`${parsed.name} ${parsed.description} ${parsed.body || skillText}`);
  for (const skill of bundled) {
    if (skill.name === parsed.name) {
      reject(findings, 'dedup-fit', 'duplicate_skill', `Candidate duplicates bundled skill "${skill.name}"`);
      return;
    }
    const score = jaccard(candidateTokens, skill.tokens);
    if (score >= 0.9) {
      reject(findings, 'dedup-fit', 'near_duplicate_skill', `Candidate is near-duplicate of bundled skill "${skill.name}"`);
      return;
    }
  }
}

export async function loadBundledSkillIndex(skillsRoot) {
  const dirs = await findCandidateDirs(skillsRoot);
  const items = [];
  for (const dir of dirs) {
    const text = await readFile(path.join(dir, 'SKILL.md'), 'utf8');
    const parsed = parseSkillMarkdown(text, path.join(dir, 'SKILL.md'), []);
    items.push({
      name: parsed.name,
      description: parsed.description,
      tokens: tokenSet(`${parsed.name} ${parsed.description} ${parsed.body}`),
    });
  }
  return items;
}

export async function findCandidateDirs(rootDir) {
  const root = path.resolve(rootDir);
  const found = [];
  await walk(root, 0);
  return found.sort((a, b) => slash(a).localeCompare(slash(b)));

  async function walk(dir, depth) {
    if (existsSync(path.join(dir, 'SKILL.md'))) {
      found.push(dir);
      return;
    }
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }
}

export async function checkNotices(skillsRoot, noticesPath) {
  const noticesText = existsSync(noticesPath) ? await readFile(noticesPath, 'utf8') : '';
  const dirs = await findCandidateDirs(skillsRoot);
  const missing = [];
  for (const dir of dirs) {
    const provenance = await readJsonIfExists(path.join(dir, 'provenance.json'));
    if (!provenance) continue;
    const skillText = await readFile(path.join(dir, 'SKILL.md'), 'utf8');
    const parsed = parseSkillMarkdown(skillText, path.join(dir, 'SKILL.md'), []);
    const expected = [parsed.name, provenance.sourceUrl, provenance.spdxLicenseId].filter(Boolean);
    if (!expected.every((piece) => noticesText.includes(piece))) {
      missing.push({ skill: parsed.name, missing: expected.filter((piece) => !noticesText.includes(piece)) });
    }
  }
  return { status: missing.length > 0 ? 'REJECT' : 'PASS', missing };
}

function inferCategory(candidateDir, root, parsed, skillText) {
  const relParts = slash(path.relative(root, candidateDir)).split('/');
  const pathCategory = relParts.find((part) => CATEGORY_NAMES.has(part));
  if (pathCategory) return pathCategory;
  const text = `${parsed.name} ${parsed.description} ${skillText}`.toLowerCase();
  if (/\b(test|tdd|coverage|flaky)\b/.test(text)) return 'testing';
  if (/\b(security|auth|secret|owasp|threat)\b/.test(text)) return 'security';
  if (/\b(api|code|debug|implementation|refactor)\b/.test(text)) return 'development';
  if (/\b(doc|readme|writing|guide)\b/.test(text)) return 'documentation';
  if (/\b(design|ui|ux|accessibility)\b/.test(text)) return 'design';
  if (/\b(data|schema|metric|sql)\b/.test(text)) return 'data';
  return 'management';
}

async function validateInstructionOnlyTree(dir, findings) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    reject(findings, 'format', 'unreadable_directory', `Cannot read candidate directory: ${errorMessage(error)}`);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) {
      reject(findings, 'format', 'symbolic_link', `${slash(full)}: symbolic links are forbidden`);
    } else if (stat.isDirectory()) {
      if (/^(?:scripts?|bin)$/i.test(entry.name)) {
        reject(findings, 'format', 'executable_directory', `${slash(full)}: executable skill directories are forbidden`);
      } else {
        await validateInstructionOnlyTree(full, findings);
      }
    } else if (EXECUTABLE_PAYLOAD.test(entry.name)) {
      reject(findings, 'format', 'executable_payload', `${slash(full)}: executable payloads are forbidden`);
    }
  }
}

async function readJsonIfExists(file) {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function readFirstExisting(dir, names) {
  for (const name of names) {
    const file = path.join(dir, name);
    if (existsSync(file)) return readFile(file, 'utf8');
  }
  return undefined;
}

function detectLicenseFromText(text) {
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(text)) return 'AGPL-3.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(text)) return 'LGPL-3.0';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) return 'GPL-3.0';
  if (/Creative Commons Attribution-NonCommercial/i.test(text) || /\bCC-BY-NC\b/i.test(text)) return 'CC-BY-NC-4.0';
  if (/Creative Commons Attribution-NoDerivatives/i.test(text) || /\bCC-BY-ND\b/i.test(text)) return 'CC-BY-ND-4.0';
  if (/Creative Commons Attribution-ShareAlike/i.test(text) || /\bCC-BY-SA\b/i.test(text)) return 'CC-BY-SA-4.0';
  if (/Creative Commons Attribution 4\.0/i.test(text) || /\bCC-BY-4\.0\b/i.test(text)) return 'CC-BY-4.0';
  if (/Creative Commons Zero/i.test(text) || /\bCC0\b/i.test(text)) return 'CC0-1.0';
  if (/Apache License\s+Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/BSD 3-Clause License/i.test(text) || /Redistribution and use in source and binary forms.*Neither the name/is.test(text)) return 'BSD-3-Clause';
  if (/BSD 2-Clause License/i.test(text) || /Redistribution and use in source and binary forms/s.test(text)) return 'BSD-2-Clause';
  if (/ISC License/i.test(text)) return 'ISC';
  if (/The Unlicense/i.test(text)) return 'Unlicense';
  if (/MIT License/i.test(text) || /Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/all rights reserved/i.test(text)) return 'all rights reserved';
  return undefined;
}

function buildLineDiff(before, after) {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  const diff = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      diff.push({ line: i + 1, before: a[i] ?? '', after: b[i] ?? '' });
    }
  }
  return diff;
}

function tokenSet(text) {
  return new Set(words(text).filter((word) => word.length > 2));
}

function words(text) {
  return String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / new Set([...a, ...b]).size;
}

function summarize(candidates) {
  const summary = { pass: 0, flag: 0, reject: 0, total: candidates.length };
  for (const candidate of candidates) {
    if (candidate.status === 'PASS') summary.pass++;
    if (candidate.status === 'FLAG') summary.flag++;
    if (candidate.status === 'REJECT') summary.reject++;
  }
  return summary;
}

function flag(findings, gate, code, message, line, excerpt) {
  findings.push({ gate, severity: 'flag', code, message, ...(line ? { line } : {}), ...(excerpt ? { excerpt: excerpt.trim() } : {}) });
}

function reject(findings, gate, code, message, line, excerpt) {
  findings.push({ gate, severity: 'reject', code, message, ...(line ? { line } : {}), ...(excerpt ? { excerpt: excerpt.trim() } : {}) });
}

function compareFindings(a, b) {
  return `${a.severity}:${a.gate}:${a.code}:${a.line || 0}:${a.message}`
    .localeCompare(`${b.severity}:${b.gate}:${b.code}:${b.line || 0}:${b.message}`);
}

function unquote(value) {
  return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1)
    : value;
}

function slash(value) {
  return value.replace(/\\/g, '/');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === 'check') {
    const { positional, options } = parseArgs(rest);
    const root = positional[0];
    if (!root) usage(1);
    const report = await checkCandidateRoot(root, { bundledSkillsRoot: options['bundled-skills'] || 'skills' });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.json) {
      await writeFile(options.json, json, 'utf8');
    } else {
      process.stdout.write(json);
    }
    if (report.summary.reject > 0) process.exitCode = 1;
    return;
  }
  if (command === 'check-notices') {
    const { positional } = parseArgs(rest);
    const [skillsRoot = 'skills', noticesPath = 'THIRD_PARTY_NOTICES.md'] = positional;
    const report = await checkNotices(skillsRoot, noticesPath);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status === 'REJECT') process.exitCode = 1;
    return;
  }
  usage(command ? 1 : 0);
}

function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' || arg === '--bundled-skills') {
      options[arg.slice(2)] = args[++i];
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function usage(exitCode) {
  process.stderr.write(`Usage:
  skill-ingest check <dir-of-candidate-skills> [--json report.json] [--bundled-skills skills]
  skill-ingest check-notices [skills-root] [THIRD_PARTY_NOTICES.md]
`);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
