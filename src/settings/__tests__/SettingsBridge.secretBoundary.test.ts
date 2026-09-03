import { describe, expect, it, vi } from 'vitest';
import { SettingsBridge, ConfigStore, McpStateSource, ProviderDef, SecretStore } from '../SettingsBridge';
import type { MCPServerConfig } from '../../types';

/*---------------------------------------------------------------------------------------------
 *  UX7 row 7 — "No API key, secret reference, hidden credential header, or forbidden evidence
 *  field in webview state." That row was a claim with nothing behind it: the suite had tests that
 *  CONSTRUCT `apiKeySecretName` fixtures, which is the opposite of proving a value never escapes.
 *
 *  Note the row cannot mean the secret NAME. The product deliberately shows it — SettingsPanel
 *  renders "Credential: ROAM_API_KEY" — so a user can tell which stored credential a card uses.
 *  What must never cross is the VALUE, and anything that would let the webview obtain one.
 *
 *  These are negative tests. They plant a canary in every place a credential can live and assert
 *  it does not appear in the snapshot the panel is built from. The scan is structural, not a list
 *  of field names, so a field added later is covered the day it is added rather than the day
 *  someone remembers to extend an allowlist.
 *--------------------------------------------------------------------------------------------*/

/** Distinctive enough that a substring hit anywhere is a leak and never a coincidence. */
const CANARY = 'sk-live-CANARY-b7f3e21d9c4a-DO-NOT-LEAK';

/** Every string anywhere in the value, at any depth, including object KEYS. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      allStrings(item, out);
    }
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      allStrings(item, out);
    }
  }
  return out;
}

const provider = (over: Partial<ProviderDef> = {}): ProviderDef => ({
  providerId: 'roam',
  connectionId: 'roam',
  name: 'Roam',
  apiKeySecretName: 'ROAM_API_KEY',
  authKind: 'api-key',
  presentation: {} as ProviderDef['presentation'],
  ...over,
});

const config: ConfigStore = { get: <T,>(_k: string, fallback: T) => fallback, update: async () => {} };

describe('SettingsBridge — the secret boundary (UX7 row 7)', () => {
  it('cannot read a key value at all: the injected store exposes no reader, and none is reached for', async () => {
    // `SecretStore` is has/delete — there is deliberately no `get`. A store that also offers one
    // proves the stronger claim: the bridge does not reach for a reader even when handed it, so the
    // guarantee is structural rather than "this particular snapshot happened to omit it".
    const illicitGet = vi.fn(async () => CANARY);
    const secrets = {
      has: async () => true,
      delete: async () => {},
      get: illicitGet,
    } as SecretStore & { get: () => Promise<string> };

    const snapshot = await new SettingsBridge(secrets, config, [provider()]).getSnapshot();

    expect(illicitGet).not.toHaveBeenCalled();
    expect(allStrings(snapshot)).not.toContain(CANARY);
  });

  it('reports possession as a boolean, never as the thing possessed', async () => {
    const secrets: SecretStore = { has: async () => true, delete: async () => {} };
    const [status] = await new SettingsBridge(secrets, config, [provider()]).getProviderStatuses();

    expect(status.hasApiKey).toBe(true);
    expect(typeof status.hasApiKey).toBe('boolean');
    // The NAME is public on purpose — the panel shows it as "Credential: …". The value is what is at stake.
    expect(status.apiKeySecretName).toBe('ROAM_API_KEY');
    expect(allStrings(status)).not.toContain(CANARY);
  });

  it('drops an MCP server\'s env, where stdio credentials actually live', async () => {
    // `MCPServerConfig.env` is where a GITHUB_TOKEN or API key for a stdio server is carried. The
    // mapping in getMcpServers is an allowlist and therefore drops it; a refactor to `...cfg` would
    // publish every MCP credential into webview state without changing a single test that names fields.
    const registry = new Map<string, MCPServerConfig>([
      ['gh', {
        id: 'gh',
        name: 'GitHub',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-github'],
        env: { GITHUB_TOKEN: CANARY, API_KEY: CANARY },
        requiresApproval: true,
      }],
    ]);
    const mcp: McpStateSource = {
      registry,
      connected: () => ({ ready: true, toolCount: 3 }),
      grantedTo: () => ['agent-1'],
    };
    const secrets: SecretStore = { has: async () => false, delete: async () => {} };

    const snapshot = await new SettingsBridge(secrets, config, [provider()], () => 1, mcp).getSnapshot();
    const [server] = snapshot.mcpServers;

    expect(server.name).toBe('GitHub'); // the row is still rendered, so this is not passing by omission
    expect(server).not.toHaveProperty('env');
    const strings = allStrings(snapshot);
    expect(strings).not.toContain(CANARY);
    expect(strings).not.toContain('GITHUB_TOKEN'); // the key name is a credential reference too
  });

  it('keeps a credential out even when a provider definition smuggles one in an unexpected field', async () => {
    // Defence in depth: the panel is built from whatever a caller passes, and callers change. A field
    // the bridge does not know about must not be forwarded just because it was present on the input.
    const secrets: SecretStore = { has: async () => true, delete: async () => {} };
    const smuggled = provider({ name: 'Roam' }) as ProviderDef & Record<string, unknown>;
    smuggled.authorizationHeader = `Bearer ${CANARY}`;
    smuggled.apiKey = CANARY;

    const snapshot = await new SettingsBridge(secrets, config, [smuggled]).getSnapshot();

    expect(allStrings(snapshot)).not.toContain(CANARY);
    expect(allStrings(snapshot)).not.toContain(`Bearer ${CANARY}`);
  });
});
