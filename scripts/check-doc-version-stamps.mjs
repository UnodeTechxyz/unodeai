import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');

export function versionStampViolations({ version, usage, wikiIndex, wikiReadme, readme, lockfile }) {
  const violations = [];
  // package-lock.json drifted to 0.9.53 and stayed there through the whole of v0.9.54 — it is not in the
  // VSIX and no gate read it, so nothing said so. `npm version` writes both files; a hand-edited
  // package.json writes one. Cheap to check, and a lockfile that disagrees with its manifest is the kind of
  // thing a release-provenance claim should not have to explain afterwards.
  if (lockfile) {
    if (lockfile.version !== version) {
      violations.push(`package-lock.json root version is ${lockfile.version}, expected ${version}`);
    }
    const self = lockfile.packages && lockfile.packages[''];
    if (self && self.version !== version) {
      violations.push(`package-lock.json packages[""].version is ${self.version}, expected ${version}`);
    }
  }
  // README.md is the Open VSX / Marketplace overview page. It drifted three releases behind
  // (0.9.33 and 0.9.34 both shipped an overview headed "New in v0.9.32") precisely because it was
  // the one release-facing document with no stamp here.
  if (!readme.includes(`## New in v${version}`)) {
    violations.push(`README.md must contain a "## New in v${version}" section (it is the store overview page)`);
  }
  // Owner rule: the store overview carries the latest THREE releases and nothing older. It drifted to five
  // plus a stale catch-all section because the rule lived only in memory, so it lives here now.
  const releaseSections = [...readme.matchAll(/^## (?:New in|Previously in|Earlier release)/gm)];
  if (releaseSections.length !== 3) {
    violations.push(`README.md must carry exactly 3 release sections (1 "New in" + 2 "Previously in"); found ${releaseSections.length}`);
  }
  if (!usage.includes(`Version covered: UnodeAi ${version}`)) {
    violations.push(`USAGE.md must contain "Version covered: UnodeAi ${version}"`);
  }
  if (!wikiReadme.includes(`Version covered: UnodeAi ${version}`)) {
    violations.push(`docs/wiki/README.md must contain "Version covered: UnodeAi ${version}"`);
  }
  if (!wikiIndex.includes(`<p class="eyebrow">UnodeAi ${version}</p>`)) {
    violations.push(`docs/wiki/index.html hero must contain "UnodeAi ${version}"`);
  }
  if (!wikiIndex.includes(`UnodeAi documentation for version ${version}.`)) {
    violations.push(`docs/wiki/index.html footer must contain version ${version}`);
  }
  return violations;
}

function currentInputs() {
  return {
    version: JSON.parse(read('package.json')).version,
    lockfile: JSON.parse(read('package-lock.json')),
    usage: read('USAGE.md'),
    wikiIndex: read('docs/wiki/index.html'),
    wikiReadme: read('docs/wiki/README.md'),
    readme: read('README.md'),
  };
}

function runSelfTest() {
  const inputs = currentInputs();
  const changedVersion = `${inputs.version}.next`;
  const violations = versionStampViolations({ ...inputs, version: changedVersion });
  if (violations.length !== 5) {
    throw new Error('self-test failed: a planted package version bump did not fail every required stamp');
  }
  console.log('check:doc-version-stamps self-test passed (a planted version bump fails).');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const violations = versionStampViolations(currentInputs());
  if (violations.length > 0) {
    throw new Error(`check:doc-version-stamps failed:\n- ${violations.join('\n- ')}`);
  }
  console.log('check:doc-version-stamps passed.');
}
