import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');

function readTextTree(relative) {
  const values = {};
  const visit = (directory, displayPrefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const display = `${displayPrefix}/${entry.name}`;
      if (entry.isDirectory()) visit(absolute, display);
      else if (entry.isFile()) values[display] = readFileSync(absolute, 'utf8');
    }
  };
  visit(resolve(root, relative), relative);
  return values;
}

function shippedRoadmapViolations({ version, readme, usage, security, changelog, shippedText = {} }) {
  const current = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!current) return [];

  const currentMajor = Number(current[1]);
  const currentMinor = Number(current[2]);
  const currentPatch = Number(current[3]);
  const documents = {
    'README.md': readme,
    'USAGE.md': usage,
    'SECURITY.md': security,
    'CHANGELOG.md': changelog,
    ...shippedText,
  };
  const violations = [];

  for (const [name, source] of Object.entries(documents)) {
    // Shipped documentation may describe current behaviour and current limitations. Release scheduling belongs
    // in internal docs/** only. Catch both "v0.9.83" and bare "0.9.83" in the active release train.
    const versionPattern = /\bv?(\d+)\.(\d+)\.(\d+)\b/g;
    for (const match of source.matchAll(versionPattern)) {
      const major = Number(match[1]);
      const minor = Number(match[2]);
      const patch = Number(match[3]);
      if (major === currentMajor && minor === currentMinor && patch > currentPatch) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push(`${name}:${line} names unreleased ${match[0]}; future release plans belong only in internal docs/**`);
      }
    }

    const roadmapPhrasePattern = /\bscheduled for (?:later|a future|the future) releases?\b/gi;
    for (const match of source.matchAll(roadmapPhrasePattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${name}:${line} contains "${match[0]}"; shipped docs must state the present limitation without a roadmap promise`);
    }
  }

  return violations;
}

export function versionStampViolations({ version, usage, wikiIndex, wikiReadme, readme, security, changelog, shippedText, lockfile }) {
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
  violations.push(...shippedRoadmapViolations({ version, readme, usage, security, changelog, shippedText }));
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
    security: read('SECURITY.md'),
    changelog: read('CHANGELOG.md'),
    shippedText: {
      'package.json': read('package.json'),
      'LICENSE': read('LICENSE'),
      'THIRD_PARTY_NOTICES.md': read('THIRD_PARTY_NOTICES.md'),
      ...readTextTree('marketplace'),
      ...readTextTree('skills'),
    },
  };
}

function runSelfTest() {
  const inputs = currentInputs();
  const changedVersion = `${inputs.version}.next`;
  const violations = versionStampViolations({ ...inputs, version: changedVersion });
  const requiredStampFailures = [
    'package-lock.json root version',
    'package-lock.json packages[""]',
    'README.md must contain',
    'USAGE.md must contain',
    'docs/wiki/README.md must contain',
    'docs/wiki/index.html hero',
    'docs/wiki/index.html footer',
  ];
  if (!requiredStampFailures.every((expected) => violations.some((violation) => violation.includes(expected)))) {
    throw new Error('self-test failed: a planted package version bump did not fail every required stamp');
  }

  const [major, minor, patch] = inputs.version.split('.').map(Number);
  const futureVersion = `${major}.${minor}.${patch + 1}`;
  const futureVersionViolations = versionStampViolations({
    ...inputs,
    readme: `${inputs.readme}\nA future promise for v${futureVersion}.\n`,
  });
  if (!futureVersionViolations.some((violation) => violation.includes(`names unreleased v${futureVersion}`))) {
    throw new Error('self-test failed: a planted future release promise was not rejected');
  }

  const futureRoadmapViolations = versionStampViolations({
    ...inputs,
    usage: `${inputs.usage}\nScheduled for later releases.\n`,
  });
  if (!futureRoadmapViolations.some((violation) => violation.includes('without a roadmap promise'))) {
    throw new Error('self-test failed: a planted future-roadmap phrase was not rejected');
  }

  console.log('check:doc-version-stamps self-test passed (planted stamp and shipped-roadmap drift fail).');
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
