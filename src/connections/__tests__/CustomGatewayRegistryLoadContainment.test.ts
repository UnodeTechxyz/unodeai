import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CustomGatewayLockTimeoutError, CustomGatewayProfileStore } from '../CustomGatewayProfileStore';
import { loadCustomGatewayRegistryFailClosed } from '../CustomGatewayRegistryLoadContainment';
import { CUSTOM_GATEWAY_REGISTRY_FILE_NAME } from '../CustomGatewayProfile';

const TEMP_DIRECTORIES: string[] = [];

afterEach(async () => {
  await Promise.all(TEMP_DIRECTORIES.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-registry-containment-'));
  TEMP_DIRECTORIES.push(directory);
  return directory;
}

function storeFor(directory: string): CustomGatewayProfileStore {
  return new CustomGatewayProfileStore({
    storageDir: directory,
    secrets: { store: async () => {}, delete: async () => {}, has: async () => false },
  });
}

describe('custom gateway registry load containment', () => {
  it('falls back to built-ins when the registry contains corrupt JSON', async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(path.join(directory, CUSTOM_GATEWAY_REGISTRY_FILE_NAME), '{not valid json', 'utf8');

    const result = await loadCustomGatewayRegistryFailClosed(storeFor(directory));

    expect(result.snapshot).toBeUndefined();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.resolver.connectionProfile('unode')).toBeDefined();
    expect(result.resolver.connectionProfile('custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeUndefined();
  });

  it('falls back to built-ins when the registry schema has an unknown field', async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(path.join(directory, CUSTOM_GATEWAY_REGISTRY_FILE_NAME), JSON.stringify({
      schemaVersion: 1,
      registryRevision: 0,
      profiles: [],
      tombstones: [],
      retiredSecretRefs: [],
      unexpected: true,
    }), 'utf8');

    const result = await loadCustomGatewayRegistryFailClosed(storeFor(directory));

    expect(result.snapshot).toBeUndefined();
    expect(String(result.error)).toMatch(/unsupported field/i);
    expect(result.resolver.connectionProfile('roam')).toBeDefined();
  });

  it('falls back to built-ins when the registry lock times out', async () => {
    const timeout = new CustomGatewayLockTimeoutError('C:/registry/custom-gateways.json.lock');
    const result = await loadCustomGatewayRegistryFailClosed({
      load: async () => { throw timeout; },
    });

    expect(result.snapshot).toBeUndefined();
    expect(result.error).toBe(timeout);
    expect(result.resolver.connectionProfile('unode')).toBeDefined();
  });
});
