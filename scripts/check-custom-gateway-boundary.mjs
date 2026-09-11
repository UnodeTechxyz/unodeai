import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SOURCE_ROOT = join(ROOT, 'src');
const LEGACY_MIGRATION = 'connections/LegacyCustomGatewayMigration.ts';
const HOST_MIGRATION = 'extension.ts';

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') { return []; }
      return sourceFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

function fail(message) {
  console.error(`custom gateway boundary check failed: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(SOURCE_ROOT)) {
  fail('src directory is missing.');
} else {
  const files = sourceFiles(SOURCE_ROOT);
  const forbiddenAuthorities = [
    'DEFAULT_PROVIDERS',
    'DEFAULT_PROVIDER_CONFIGS',
    'OPENAI_COMPAT_PROVIDERS',
    '_endpointDefaults',
    '_pickModel',
  ];
  for (const file of files) {
    const relativePath = relative(SOURCE_ROOT, file).replaceAll('\\', '/');
    const text = readFileSync(file, 'utf8');
    for (const authority of forbiddenAuthorities) {
      if (text.includes(authority)) {
        fail(`${relativePath} retains forbidden static authority ${authority}.`);
      }
    }
    // The retired singleton 'custom' connection identity must never be compared or created directly, in ANY
    // spelling. Anchored to providerId/connectionId ONLY — bare 'custom' is a legitimate ROLE key /
    // systemPromptSource value elsewhere, so a broader match would flood false positives. Covers strict and
    // loose equality, the reversed (yoda) order, template-literal quotes, and object-literal assignment.
    const singletonCustom = [
      /\b(?:providerId|connectionId)\s*===?\s*[`'"]custom[`'"]/,          // id === 'custom' | id == `custom`
      /[`'"]custom[`'"]\s*===?\s*(?:\w+\.)?(?:providerId|connectionId)\b/, // 'custom' === (obj.)providerId (yoda)
      /\b(?:providerId|connectionId)\s*:\s*[`'"]custom[`'"]/,             // { providerId: 'custom' }
    ];
    if (singletonCustom.some((pattern) => pattern.test(text))) {
      fail(`${relativePath} creates or compares the retired singleton custom identity directly.`);
    }
    if (text.includes('customBaseUrl') && relativePath !== HOST_MIGRATION) {
      fail(`${relativePath} reads the migration-only unode.customBaseUrl setting.`);
    }
    if (relativePath !== LEGACY_MIGRATION && relativePath !== HOST_MIGRATION && /['"]CUSTOM_API_KEY['"]/.test(text)) {
      fail(`${relativePath} references the retired singleton credential name outside its migration contract.`);
    }
  }
  if (process.exitCode !== 1) {
    console.log(`custom gateway boundary check passed (${files.length} production TypeScript files).`);
  }
}
