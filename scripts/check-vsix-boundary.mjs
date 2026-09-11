import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();

export function listVsixFiles(cwd = root, { noDependencies = false } = {}) {
  const vsce = process.platform === 'win32'
    ? join(root, 'node_modules', '.bin', 'vsce.cmd')
    : join(root, 'node_modules', '.bin', 'vsce');
  const args = ['ls', ...(noDependencies ? ['--no-dependencies'] : [])];
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/c', vsce, ...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    : spawnSync(vsce, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

  if (result.status !== 0) {
    throw new Error(`vsce ls failed in ${cwd}:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
    throw new Error(`${label} boundary check failed: bundled VSIX is missing skills/**/SKILL.md.`);
  }
  if (bundled && !files.some((rawFile) => rawFile.replaceAll('\\', '/') === 'out/claudeToolGate.cjs')) {
    throw new Error(`${label} boundary check failed: bundled VSIX is missing out/claudeToolGate.cjs.`);
  }
  console.log(`${label} boundary check passed (${files.length} files).`);
}

if (import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  assertVsixBoundary(listVsixFiles(), { label: 'Raw VSIX file list' });
}
