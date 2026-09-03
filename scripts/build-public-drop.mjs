#!/usr/bin/env node
/**
 * Build the PUBLIC source drop by ALLOWLIST, then scan it.
 *
 * Why an allowlist: the previous drops copied `scripts/` wholesale, so internal probe/live research
 * scripts (probe-claude-*, live-claude-*) landed in the public repo by default. Copy-everything-minus-a-
 * blocklist is fail-open — a new internal file is public until somebody remembers to exclude it. This
 * inverts that: nothing is public unless it is named here.
 *
 * Usage:
 *   node scripts/build-public-drop.mjs --out <dir>   [--dry-run]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : join(ROOT, '.public-drop');
const DRY = args.includes('--dry-run');

/** Files/dirs that go public verbatim. Anything not listed is excluded. */
const INCLUDE_FILES = [
  'README.md', 'USAGE.md', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
  'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'package.json', 'package-lock.json', 'tsconfig.json',
  'esbuild.config.mjs', 'eslint.config.cjs', 'vitest.config.ts', '.vscode-test.mjs',
  '.gitignore', '.vscodeignore', '.vscodeignore.bundle',
];
// `test-e2e` is here because the public `package.json` advertises `npm run test:e2e`, and rule 17 requires
// a shipped command to be runnable in the drop. It was omitted through v0.9.55 and the omission was quiet,
// exactly as rule 17 predicts. v0.9.56 makes it material rather than cosmetic: the extension-host proof that
// a coordinator's `cancel_task` really stops a teammate lives in this directory, and a release cannot
// publish a claim whose evidence its own source drop withholds. Codex review, 2026-08-22.
const INCLUDE_DIRS = ['src', 'images', 'marketplace', 'skills', 'docs/wiki', 'test-e2e', 'tools/skill-ingest'];

/**
 * scripts/ is allowlisted file-by-file. Internal probes and live research harnesses stay private:
 * they encode internal endpoints, experiment scaffolding, and workflow that is not part of the product.
 */
const INCLUDE_SCRIPTS = [
  'check-bundle-determinism.mjs',
  'check-canonical-artifact-rehearsal.mjs',
  'check-custom-gateway-boundary.mjs',
  'check-chat-webview-protocol-boundary.mjs',
  'check-domain-boundary.mjs',
  // v0.9.75 adds this to pretest, which its package.json advertises. Rule 17 requires the public
  // drop to supply it. Safe to publish: it proves terminal workspace-escape signals remain
  // confined to path-boundary proofs and carries no endpoint or credential data.
  'check-workspace-escape-boundary.mjs',
  // Refusal detail is only allowed through a literal-only branded channel. The source drop ships the
  // corresponding pretest gate, so it must include this checker as well.
  'check-refusal-detail-literals.mjs',
  // Webview colour literals must stay on VS Code theme tokens. The shipped pretest invokes this
  // source-only ratchet, so Rule 17 requires it in the public drop too.
  'check-webview-theme-tokens.mjs',
  'check-orchestration-boundary.mjs',
  'check-doc-version-stamps.mjs',
  'check-internal-doc-refs.mjs',
  'check-docs-ui.mjs',
  'check-frozen-publish-guard.mjs',
  'check-package-doc-links.mjs',
  // v0.9.58 added this to `pretest`, which the shipped package.json advertises, so rule 17 requires the
  // drop to supply it. Safe to publish: it reads only files under src/ and asserts that credential writes
  // stay on the reviewed boundary — it names no endpoint and carries no secret.
  'check-provider-key-storage-boundary.mjs',
  'check-public-source-drop.mjs',
  'check-public-drop-scripts.mjs',
  // v0.9.46 added this to the `check:docs` chain in package.json, which ships verbatim. Leaving it out
  // would hand the public repo a documented gate that crashes on a missing file. It is safe to publish:
  // it reads only WorkspaceTools.ts (public) and pins product-facing description text.
  'check-tool-descriptions.mjs',
  'check-harness-sensor-mutations.mjs',
  'check-vsix-boundary.mjs',
  'copy-claude-tool-gate.mjs',
  'gen-icon.js',
  'mutation-check.mjs',
  'mutation-check-v0973.mjs',
  // Release runbook step 4a: sandboxed behavioural mutations for the twelve public authority boundaries.
  // It carries no credential, endpoint, or private-workflow data and package.json advertises the command.
  'release-authority-canaries.mjs',
  'package-bundle.mjs',
  'publish-frozen.mjs',
  'run-a0-benchmark.mjs',
  'skill-harvest-candidates.mjs',
  'sign-catalog.mjs',
  'smoke-bundled-vsix.mjs',
  'validate-skills.mjs',
  'build-public-drop.mjs',
];

/** Content that must never appear in the drop. Keep this vocabulary shared with the context manifest. */
const SECRET_PATTERNS = JSON.parse(readFileSync(new URL('../src/security/secret-patterns.json', import.meta.url), 'utf8'))
  .map(({ source, label }) => [new RegExp(source), label]);
/** Internal-only artifacts whose NAMES leak strategy even without content. */
const INTERNAL_TOKEN = /\b(?:TASK|DESIGN|ADR|RESEARCH|ROADMAP|DECISION|AUDIT|FINDINGS|PLAN|PRD|EVIDENCE|PROBE|CODEX_TASK|CODEX_HANDOFF)_[A-Za-z0-9_]+\.md\b/;
/**
 * Synthetic fixture names used by the public lints' own positive controls. They name no real internal
 * document; the doc-link tests deliberately plant them to prove the checker fires.
 */
const FIXTURE_NAMES = new Set(['TASK_example.md']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) { walk(abs, out); } else { out.push(abs); }
  }
  return out;
}

function fail(msg) {
  console.error(`public drop FAILED: ${msg}`);
  process.exit(1);
}

// ── build ────────────────────────────────────────────────────────────────────
if (!DRY) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
}

const copied = [];
for (const f of INCLUDE_FILES) {
  const src = join(ROOT, f);
  if (!existsSync(src)) { continue; }
  if (!DRY) { cpSync(src, join(OUT, f)); }
  copied.push(f);
}
for (const d of INCLUDE_DIRS) {
  const src = join(ROOT, d);
  if (!existsSync(src)) { fail(`required directory missing: ${d}`); }
  if (!DRY) { cpSync(src, join(OUT, d), { recursive: true }); }
  copied.push(`${d}/`);
}
if (!DRY) { mkdirSync(join(OUT, 'scripts'), { recursive: true }); }
const availableScripts = readdirSync(join(ROOT, 'scripts'));
for (const s of INCLUDE_SCRIPTS) {
  if (!availableScripts.includes(s)) { continue; }
  if (!DRY) { cpSync(join(ROOT, 'scripts', s), join(OUT, 'scripts', s)); }
  copied.push(`scripts/${s}`);
}
const excludedScripts = availableScripts.filter((s) => !INCLUDE_SCRIPTS.includes(s));

if (DRY) {
  console.log(`[dry run] would copy ${copied.length} entries; would exclude ${excludedScripts.length} scripts:`);
  excludedScripts.forEach((s) => console.log(`  - scripts/${s}`));
  process.exit(0);
}

// ── scan the produced drop ───────────────────────────────────────────────────
const violations = [];
for (const abs of walk(OUT)) {
  const rel = relative(OUT, abs).split(sep).join('/');
  if (rel.startsWith('images/') || /\.(png|jpg|jpeg|gif|ico|webp)$/i.test(rel)) { continue; }
  let text;
  try { text = readFileSync(abs, 'utf8'); } catch { continue; }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(line)) { violations.push(`${rel}:${i + 1} — ${label}`); }
    }
    // package-lock legitimately contains long hashes; only flag internal doc names in prose/code.
    if (rel !== 'package-lock.json') {
      const m = INTERNAL_TOKEN.exec(line);
      if (m && !FIXTURE_NAMES.has(m[0])) {
        violations.push(`${rel}:${i + 1} — internal artifact name "${m[0]}"`);
      }
    }
  });
}

// Nothing under docs/ except the wiki may exist in the drop.
for (const abs of walk(join(OUT, 'docs'))) {
  const rel = relative(OUT, abs).split(sep).join('/');
  if (!rel.startsWith('docs/wiki/')) { violations.push(`${rel} — non-wiki file under docs/`); }
}

if (violations.length) {
  console.error('public drop scan found problems:');
  violations.forEach((v) => console.error(`  ✗ ${v}`));
  fail(`${violations.length} violation(s); drop left at ${OUT} for inspection.`);
}

const total = walk(OUT).length;
console.log(`OK: public drop built at ${OUT}`);
console.log(`    ${total} files from ${copied.length} allowlisted entries`);
console.log(`    ${excludedScripts.length} internal script(s) withheld: ${excludedScripts.join(', ') || '(none)'}`);
console.log('    scanned for secrets and internal artifact names — clean');
