import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { listVsixFiles } from './check-vsix-boundary.mjs';

const root = process.cwd();
const SHIPPED_DOCS = ['README.md', 'USAGE.md', 'SECURITY.md', 'CHANGELOG.md'];
const EXTERNAL_LINK = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function lineForOffset(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function linkTargets(text) {
  const links = [];
  const markdown = /!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g;
  const href = /\bhref\s*=\s*["']([^"']+)["']/gi;
  for (const pattern of [markdown, href]) {
    let match;
    while ((match = pattern.exec(text))) {
      links.push({ target: match[1], offset: match.index });
    }
  }
  return links;
}

function packagedTarget(file, target) {
  const bare = target.trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0];
  if (!bare || EXTERNAL_LINK.test(bare)) { return undefined; }
  const resolved = posix.normalize(posix.join(posix.dirname(file), bare.replaceAll('\\', '/')));
  return /\.(?:md|markdown|html?)$/i.test(resolved) ? resolved : undefined;
}

export function packageDocLinkViolations({ docTexts, shippedFiles }) {
  const violations = [];
  for (const [file, text] of docTexts) {
    for (const { target, offset } of linkTargets(text)) {
      const resolved = packagedTarget(file, target);
      if (resolved && !shippedFiles.has(resolved)) {
        violations.push(`${file}:${lineForOffset(text, offset)} -> ${target} (not in the VSIX)`);
      }
    }
  }
  return violations;
}

function currentInputs() {
  const shippedFiles = new Set(listVsixFiles(root, { noDependencies: true }).map((file) => file.replaceAll('\\', '/')));
  const docTexts = SHIPPED_DOCS
    .filter((file) => shippedFiles.has(file))
    .map((file) => [file, readFileSync(resolve(root, file), 'utf8')]);
  return { docTexts, shippedFiles };
}

function runSelfTest() {
  const violations = packageDocLinkViolations({
    docTexts: [['SECURITY.md', 'Safe line.\n[missing](docs/' + 'TASK_example.md)']],
    shippedFiles: new Set(['SECURITY.md']),
  });
  if (violations.length !== 1 || !violations[0].includes('SECURITY.md:2 -> docs/TASK_example.md')) {
    throw new Error('self-test failed: a planted packaged-doc dead link did not fail with file and line');
  }
  console.log('check:package-doc-links self-test passed (a planted excluded-doc link fails).');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const violations = packageDocLinkViolations(currentInputs());
  if (violations.length > 0) {
    throw new Error(`check:package-doc-links failed:\n- ${violations.join('\n- ')}`);
  }
  console.log('check:package-doc-links passed.');
}
