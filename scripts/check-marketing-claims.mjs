#!/usr/bin/env node
/**
 * Version ratchet for user-reachable runtime claims containing "this release".
 *
 * This checker parses TypeScript syntax rather than grepping text: comments never become claims. Every
 * string in non-test src/** code is treated as potentially user-reachable. The manifest is inert JSON;
 * paths and source strings are compared as data and are never imported or executed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'scripts', 'marketing-claims.json');
const CLAIM_PATTERN = /\bthis release\b/i;

function slash(value) {
  return value.split(sep).join('/');
}

function sourceFiles(dir, result = []) {
  for (const entry of readdirSync(dir).sort()) {
    const absolute = join(dir, entry);
    const normalized = slash(relative(ROOT, absolute));
    if (statSync(absolute).isDirectory()) {
      if (entry !== '__tests__') sourceFiles(absolute, result);
    } else if (/\.tsx?$/.test(entry) && !/\.(?:test|spec)\.tsx?$/.test(entry)) {
      result.push({ absolute, path: normalized });
    }
  }
  return result;
}

function templateText(node) {
  let value = node.head.text;
  for (const span of node.templateSpans) value += '${…}' + span.literal.text;
  return value;
}

function claimSegments(value) {
  if (!value.includes('\n')) return CLAIM_PATTERN.test(value) ? [value] : [];
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => CLAIM_PATTERN.test(line));
}

export function discoverClaims(root = ROOT) {
  const claims = [];
  for (const file of sourceFiles(join(root, 'src'))) {
    const text = readFileSync(file.absolute, 'utf8');
    const source = ts.createSourceFile(file.path, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      let candidates = [];
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        candidates = claimSegments(node.text);
      } else if (ts.isTemplateExpression(node)) {
        candidates = claimSegments(templateText(node));
      }
      if (candidates.length > 0) {
        candidates.forEach((claimText, index) => claims.push({ path: file.path, text: claimText, start: node.getStart(source) + index }));
        if (ts.isTemplateExpression(node)) return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  claims.sort((a, b) => `${a.path}:${String(a.start).padStart(12, '0')}`.localeCompare(`${b.path}:${String(b.start).padStart(12, '0')}`));
  const seen = new Map();
  return claims.map(({ path, text }) => {
    const key = `${path}\0${text}`;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return { path, text, occurrence };
  });
}

function claimKey(claim) {
  return `${claim.path}\0${claim.text}\0${claim.occurrence}`;
}

export function marketingClaimViolations({ version, manifest, discovered }) {
  const violations = [];
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.claims)) {
    return ['invalid_manifest: scripts/marketing-claims.json must use schemaVersion 1 with a claims array'];
  }
  const manifestByKey = new Map();
  for (const claim of manifest.claims) {
    const key = claimKey(claim);
    if (manifestByKey.has(key)) violations.push(`duplicate_manifest_claim: ${claim.id ?? key}`);
    manifestByKey.set(key, claim);
    if (claim.lastAffirmed !== version) {
      violations.push(`stale_affirmation: ${claim.id ?? key} was affirmed for ${claim.lastAffirmed ?? '(missing)'}, expected ${version}`);
    }
  }
  const discoveredByKey = new Map(discovered.map((claim) => [claimKey(claim), claim]));
  for (const [key, claim] of discoveredByKey) {
    if (!manifestByKey.has(key)) violations.push(`unregistered_claim: ${claim.path} occurrence ${claim.occurrence}: ${JSON.stringify(claim.text)}`);
  }
  for (const [key, claim] of manifestByKey) {
    if (!discoveredByKey.has(key)) violations.push(`manifest_claim_missing: ${claim.id ?? key}`);
  }
  return violations.sort();
}

function currentInputs() {
  return {
    version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
    manifest: JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')),
    discovered: discoverClaims(),
  };
}

function selfTest() {
  const inputs = currentInputs();
  const planted = { path: 'src/planted.ts', text: 'A planted limit applies in this release.', occurrence: 1 };
  const added = marketingClaimViolations({ ...inputs, discovered: [...inputs.discovered, planted] });
  if (!added.some((item) => item.startsWith('unregistered_claim:'))) {
    throw new Error('self-test failed: a planted new runtime claim did not go red');
  }
  const removed = marketingClaimViolations({ ...inputs, discovered: inputs.discovered.slice(1) });
  if (!removed.some((item) => item.startsWith('manifest_claim_missing:'))) {
    throw new Error('self-test failed: a planted removed runtime claim did not go red');
  }
  const changedReleaseNumber = marketingClaimViolations({ ...inputs, version: `${inputs.version}.next` });
  if (!changedReleaseNumber.some((item) => item.startsWith('stale_affirmation:'))) {
    throw new Error('self-test failed: a planted release-number change without re-affirmation did not go red');
  }
  console.log('check:marketing-claims self-test passed (new, removed, and un-affirmed claims fail).');
}

if (process.argv.includes('--print-discovered')) {
  process.stdout.write(`${JSON.stringify(discoverClaims(), null, 2)}\n`);
} else if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const inputs = currentInputs();
  const violations = marketingClaimViolations(inputs);
  if (violations.length > 0) throw new Error(`check:marketing-claims failed:\n- ${violations.join('\n- ')}`);
  console.log(`check:marketing-claims passed (${inputs.discovered.length} current runtime claim literals affirmed for ${inputs.version}).`);
}
