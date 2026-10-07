import { createRequire } from 'node:module';

const root = process.cwd();
const require = createRequire(import.meta.url);
const { listFiles, PackageManager } = require('@vscode/vsce');

export async function listVsixFiles(cwd = root, { noDependencies = false } = {}) {
  // Use VSCE's installed API directly. Spawning the Windows .cmd shim loses or misquotes output in restricted
  // editor shells, which previously made a valid staging directory look like an empty package.
  return listFiles({
    cwd,
    packageManager: noDependencies ? PackageManager.None : PackageManager.Npm,
  });
}

export function assertVsixBoundary(files, { label = 'VSIX', bundled = false } = {}) {
  const commonRules = [
    { pattern: /^packages\//i, reason: 'workspace packages must not ship in the extension' },
    { pattern: /(^|\/)\.env(?:\.|$)/i, reason: 'environment files may contain secrets' },
    { pattern: /(^|\/)\.ovsx/i, reason: 'Open VSX credentials must not ship' },
    { pattern: /\.(?:pat|token|p12|pfx|pem|key)$/i, reason: 'credential material must not ship' },
    { pattern: /(^|\/)\.unode(?:\/|$)/i, reason: 'workspace runtime state must not ship' },
    { pattern: /(^|\/)\.roam(?:\/|$)/i, reason: 'legacy workspace runtime state must not ship' },
    { pattern: /\.vsix$/i, reason: 'nested extension packages must not ship' },
  ];
  const bundledRules = [
    { pattern: /\.(?:exe|dll|node|wasm|cmd|bat|ps1|sh)$/i, reason: 'bundled extension must not contain native or executable payloads' },
    { pattern: /^skills\/.*\.(?:js|cjs|mjs|ts)$/i, reason: 'v1 skills must be instruction-only, never executable code' },
    { pattern: /^skills\/.*\/(?:scripts?|bin)(?:\/|$)/i, reason: 'v1 skills must not contain executable directories' },
    { pattern: /^node_modules\/require-from-string\//i, reason: 'runtime string compilation helper is not needed' },
    { pattern: /^node_modules\/[^/]+\/(?:test|tests|spec|benchmark|examples?|\.github)(?:\/|$)/i, reason: 'dependency development files are not runtime assets' },
  ];
  const rules = bundled ? [...commonRules, ...bundledRules] : commonRules;
  const violations = [];

  for (const rawFile of files) {
    const file = rawFile.replaceAll('\\', '/');
    for (const rule of rules) {
      if (rule.pattern.test(file)) {
        violations.push(`${file} (${rule.reason})`);
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`${label} boundary check failed:\n- ${violations.join('\n- ')}`);
  }
  if (bundled && !files.some((rawFile) => /^skills\/[^/]+\/[^/]+\/SKILL\.md$/i.test(rawFile.replaceAll('\\', '/')))) {
    throw new Error(`${label} boundary check failed: bundled VSIX is missing skills/**/SKILL.md. `
      + `Listed ${files.length} files; first entries: ${files.slice(0, 12).join(', ') || '(none)'}.`);
  }
  if (bundled && !files.some((rawFile) => rawFile.replaceAll('\\', '/') === 'out/claudeToolGate.cjs')) {
    throw new Error(`${label} boundary check failed: bundled VSIX is missing out/claudeToolGate.cjs.`);
  }
  if (bundled && !files.some((rawFile) => rawFile.replaceAll('\\', '/') === 'out/skills/SkillActionRunner.js')) {
    throw new Error(`${label} boundary check failed: bundled VSIX is missing the fixed executable-Skill runner.`);
  }
  console.log(`${label} boundary check passed (${files.length} files).`);
}

if (import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  assertVsixBoundary(await listVsixFiles(), { label: 'Raw VSIX file list' });
}
