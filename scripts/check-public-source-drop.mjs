#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Keep the published extension and public source repository auditable as one release boundary.
 *
 * The source drop is intentionally a separate, allowlisted repository. This check is run for a
 * version tag after that drop has been pushed: it refuses a tag if the public source package is
 * not the same version as the candidate, or if it has somehow fallen behind Open VSX.
 *--------------------------------------------------------------------------------------------*/
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const publicPackageUrl = process.env.UNODE_PUBLIC_SOURCE_PACKAGE_URL
  ?? 'https://raw.githubusercontent.com/UnodeTechxyz/unodeai/main/package.json';
const openVsxUrl = process.env.UNODE_OPEN_VSX_API_URL
  ?? 'https://open-vsx.org/api/unode/unodeai';

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version).trim());
  return match ? match.slice(1, 4).map(Number) : undefined;
}

/** Returns negative iff a is older than b. Release versions must be numeric semver. */
export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) throw new Error(`expected numeric semver versions, got "${a}" and "${b}".`);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function checkVersions({ candidate, publicDrop, openVsx }) {
  if (candidate !== publicDrop) {
    return `public source drop is ${publicDrop}, but this release candidate is ${candidate}. ` +
      'Build and push the allowlisted public source drop from this exact release commit before tagging.';
  }
  if (compareVersions(publicDrop, openVsx) < 0) {
    return `public source drop ${publicDrop} is older than published Open VSX ${openVsx}. ` +
      'Sync the public source drop before making any further release claim.';
  }
  return undefined;
}

async function readJson(url, label) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} did not return JSON.`);
  }
}

async function main() {
  if (process.argv.includes('--self-test')) {
    if (checkVersions({ candidate: '0.9.56', publicDrop: '0.9.56', openVsx: '0.9.55' })) {
      throw new Error('self-test failed: current public source was rejected.');
    }
    if (!checkVersions({ candidate: '0.9.56', publicDrop: '0.9.55', openVsx: '0.9.55' })) {
      throw new Error('self-test failed: stale public source was accepted.');
    }
    if (!checkVersions({ candidate: '0.9.56', publicDrop: '0.9.56', openVsx: '0.9.57' })) {
      throw new Error('self-test failed: public source older than Open VSX was accepted.');
    }
    console.log('public source-drop freshness self-test passed.');
    return;
  }

  const candidate = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const [publicPackage, registry] = await Promise.all([
    readJson(publicPackageUrl, 'public source package.json'),
    readJson(openVsxUrl, 'Open VSX metadata'),
  ]);
  const publicDrop = publicPackage?.version;
  const openVsx = registry?.version;
  if (typeof candidate !== 'string' || typeof publicDrop !== 'string' || typeof openVsx !== 'string') {
    throw new Error('candidate, public source drop, and Open VSX metadata must each declare a version string.');
  }
  const violation = checkVersions({ candidate, publicDrop, openVsx });
  if (violation) throw new Error(violation);
  console.log(`OK: candidate ${candidate}; public source drop ${publicDrop}; Open VSX ${openVsx}.`);
}

main().catch((error) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
