import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SOURCE_ROOT = join(ROOT, 'src');

function fail(message) {
  console.error(`provider-key storage boundary check failed: ${message}`);
  process.exitCode = 1;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) {
    fail(message);
  }
}

/**
 * Credential storage has a deliberately tiny set of low-level adapters. Scan the whole production
 * surface so a new UI door cannot create another `secrets.set()` bypass in an otherwise uninspected file.
 * This is purposefully broad over common SecretStorage variable names; a false positive asks the author to
 * make the storage ownership explicit, whereas a false negative recreates the defect this gate prevents.
 */
const CREDENTIAL_WRITE = /\b(?:[A-Za-z_$][\w$]*\.)*(?:secrets|secretStorage|storage)\.(?:set|store)\s*\(/gi;
const ALLOWED_CREDENTIAL_WRITE_FILES = new Set([
  'extension.ts', // two silent exceptional writes and two callbacks into the user-initiated boundary
  'connections/CustomGatewayProfileStore.ts', // staged custom gateway write; checked below for boundary routing
  'connections/CustomGatewayProfileStoreVscode.ts', // VS Code SecretStorage adapter only
  'secrets/SecretsManager.ts', // VS Code SecretStorage adapter only
]);

function collectCredentialWrites(sources) {
  const writes = [];
  for (const [path, text] of sources) {
    for (const match of text.matchAll(CREDENTIAL_WRITE)) {
      const offset = match.index ?? 0;
      const line = text.slice(0, offset).split(/\r?\n/).length;
      writes.push({ path, line, surface: match[0].replace(/\s+/g, ' ') });
    }
  }
  return writes;
}

if (!existsSync(SOURCE_ROOT)) {
  fail('src directory is missing.');
} else {
  const sources = new Map(sourceFiles(SOURCE_ROOT).map((file) => [
    relative(SOURCE_ROOT, file).replaceAll('\\', '/'),
    readFileSync(file, 'utf8'),
  ]));
  const required = [
    ['secrets/UserInitiatedProviderKeyStore.ts', /export\s+async\s+function\s+storeUserInitiatedProviderKey\b/],
    ['dialogs.ts', /storeUserInitiatedProviderKey\s*:/],
    ['extension.ts', /storeUserInitiatedProviderKey\s*:\s*persistUserInitiatedProviderKey/],
    ['connections/CustomGatewayProfileStore.ts', /storeUserInitiatedProviderKey\s*\?:/],
  ];
  for (const [path, marker] of required) {
    if (!marker.test(sources.get(path) ?? '')) {
      fail(`${path} no longer participates in the shared user-initiated provider-key boundary.`);
    }
  }

  const dialogs = sources.get('dialogs.ts') ?? '';
  if (/d\.secrets\.(?:set|promptAndStore)\s*\(/.test(dialogs)) {
    fail('dialogs.ts stores a credential directly instead of calling storeUserInitiatedProviderKey.');
  }
  const creationDoorCalls = countMatches(dialogs, /await\s+promptAndStoreProviderKey\s*\(\s*d\s*,\s*secretName\s*\)/g);
  if (creationDoorCalls !== 3) {
    fail(`expected Team, Solo, and Add Agent to share the provider-key prompt helper; found ${creationDoorCalls} callers.`);
  }
  requireMatch(
    dialogs,
    /await\s+d\.storeUserInitiatedProviderKey\s*\(\s*secretName\s*,/,
    'the command-palette key dialog bypasses the shared user-initiated provider-key boundary.',
  );

  const settingsBridge = sources.get('settings/SettingsBridge.ts') ?? '';
  if (/\bset\s*\(\s*name\s*:\s*string\s*,\s*value\s*:\s*string\s*\)/.test(settingsBridge)
    || /this\.secrets\.set\s*\(/.test(settingsBridge)) {
    fail('SettingsBridge retains a credential-store bypass. Route it or delete it.');
  }

  const extension = sources.get('extension.ts') ?? '';
  requireMatch(
    extension,
    /promptAndStoreSecret\s*:\s*\(\s*secretName\s*\)\s*=>\s*dialogs\.promptAndStoreProviderKey\s*\(\s*dialogDeps\(\)\s*,\s*secretName\s*\)/,
    'Settings > Edit does not use the provider-key prompt and storage boundary.',
  );
  requireMatch(
    extension,
    /if\s*\(\s*apiKey\s*&&\s*profile\.apiKeySecretName\s*\)\s*\{\s*await\s+persistUserInitiatedProviderKey\s*\(/,
    'the onboarding wizard does not use the provider-key storage boundary.',
  );

  const writes = collectCredentialWrites(sources);
  for (const write of writes) {
    if (!ALLOWED_CREDENTIAL_WRITE_FILES.has(write.path)) {
      fail(`${write.path}:${write.line} has an unrecognised credential write surface (${write.surface}). Add a reviewed boundary route instead.`);
    }
  }

  const extensionWrites = writes.filter((write) => write.path === 'extension.ts');
  if (extensionWrites.length !== 4
    || !/await\s+secrets\.set\s*\(\s*['"]UNODE_API_KEY['"]\s*,\s*roamKey\s*\)/.test(extension)
    || !/await\s+secrets\.set\s*\(\s*['"]UNODE_API_KEY['"]\s*,\s*['"]sk-e2e-offline['"]\s*\)/.test(extension)
    || countMatches(extension, /storeSecret\s*:\s*\(\s*\)\s*=>\s*secrets\.set\s*\(/g) !== 2) {
    fail('extension.ts credential writes must be exactly the two silent exceptions and two callbacks into persistUserInitiatedProviderKey.');
  }

  const customStore = sources.get('connections/CustomGatewayProfileStore.ts') ?? '';
  const customWrites = writes.filter((write) => write.path === 'connections/CustomGatewayProfileStore.ts');
  if (customWrites.length !== 1) {
    fail(`expected one staged custom-gateway credential write surface, found ${customWrites.length}.`);
  }
  requireMatch(
    customStore,
    /storeStagedSecretOrCleanUp\s*\(\s*lease\s*,\s*secretRef\s*,\s*apiKey\s*,\s*connectionId\s*,\s*true\s*\)/,
    'custom gateway add is not routed through the user-initiated key boundary.',
  );
  requireMatch(
    customStore,
    /storeStagedSecretOrCleanUp\s*\(\s*lease\s*,\s*secretRef\s*,\s*apiKey\s*,\s*current\.connectionId\s*,\s*true\s*\)/,
    'custom gateway replace-key is not routed through the user-initiated key boundary.',
  );
  requireMatch(
    customStore,
    /if\s*\(\s*userInitiated\s*&&\s*this\.options\.storeUserInitiatedProviderKey\s*\)/,
    'custom gateway staged storage can bypass the user-initiated key boundary.',
  );

  if (!process.exitCode) {
    console.log(`provider-key storage boundary check passed (${sources.size} production TypeScript files; ${writes.length} reviewed credential write surfaces).`);
  }
}
