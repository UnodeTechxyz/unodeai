import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Owner-approved vsce MSAL major override', () => {
  it('pins only the packaging subtree and can load Azure identity with patched MSAL without authenticating', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    // Keyed at @azure/identity, not nested under @vscode/vsce: npm 10 (Node 22, CI) ignores the deeper nesting and
    // `npm ci` then refuses the lock. The scope is unchanged while @vscode/vsce is identity's only dependent.
    expect(manifest.overrides['@azure/identity']['@azure/msal-node']).toBe('7.1.1');
    expect(manifest.overrides['@vscode/vsce']).toBeUndefined();
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const identityDependents = Object.entries(lock.packages as Record<string, { dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }>)
      .filter(([, entry]) => ({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies })['@azure/identity'])
      .map(([key]) => key);
    expect(identityDependents).toEqual(['node_modules/@vscode/vsce']);
    const msal = Object.entries(lock.packages).filter(([key]) => key.endsWith('node_modules/@azure/msal-node'));
    expect(msal).toHaveLength(1); expect(msal[0][1]).toMatchObject({ version: '7.1.1', dev: true });
    const root = createRequire(path.resolve('package.json'));
    const vsce = createRequire(root.resolve('@vscode/vsce/package.json'));
    const identity = createRequire(vsce.resolve('@azure/identity'));
    expect(identity('@azure/msal-node').PublicClientApplication).toBeTypeOf('function');
    const azure = vsce('@azure/identity');
    expect(new azure.AzureCliCredential()).toBeInstanceOf(azure.AzureCliCredential);
    expect(vsce('@vscode/vsce').createVSIX).toBeTypeOf('function');
    // No getToken, publishing, packaging or real credentials are used in this focused load check.
  });
});
