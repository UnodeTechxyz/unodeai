import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CUSTOM_GATEWAY_LOCK_FILE_NAME,
  CUSTOM_GATEWAY_REGISTRY_FILE_NAME,
  CUSTOM_GATEWAY_SCHEMA_VERSION,
  CustomGatewayOperationV1,
  CustomGatewayProfileV1,
  CustomGatewayRegistryV1,
  CustomGatewayTombstoneV1,
  emptyCustomGatewayRegistry,
  enumerateManagedCustomGatewaySecretRefs,
  parseCustomGatewayLock,
  serializeCustomGatewayLock,
  serializeCustomGatewayRegistry,
  validateCustomGatewayProfile,
  validateCustomGatewayRegistry,
} from '../CustomGatewayProfile';
import {
  CustomGatewayProfileLock,
  CustomGatewayLockTimeoutError,
  CustomGatewayProfileStore,
  CustomGatewaySecretStorage,
  writeFileAtomically,
} from '../CustomGatewayProfileStore';
import { createVSCodeCustomGatewayProfileStore } from '../CustomGatewayProfileStoreVscode';
import { secretStorageKey } from '../../secrets/secretStorageKey';

const TEMP_DIRECTORIES: string[] = [];
const ID_A = 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const ID_B = 'custom:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const REF_A_1 = 'custom-gateway:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:11111111111111111111111111111111';
const REF_A_2 = 'custom-gateway:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:22222222222222222222222222222222';
const REF_B_1 = 'custom-gateway:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:33333333333333333333333333333333';

afterEach(async () => {
  await Promise.all(TEMP_DIRECTORIES.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

class MemorySecrets implements CustomGatewaySecretStorage {
  private readonly values = new Map<string, string>();

  async store(secretRef: string, value: string): Promise<void> {
    this.values.set(secretRef, value);
  }

  async delete(secretRef: string): Promise<void> {
    this.values.delete(secretRef);
  }

  async has(secretRef: string): Promise<boolean> {
    return this.values.has(secretRef);
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-custom-gateways-'));
  TEMP_DIRECTORIES.push(directory);
  return directory;
}

function profile(overrides: Partial<CustomGatewayProfileV1> = {}): CustomGatewayProfileV1 {
  return {
    schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
    connectionId: ID_A,
    revision: 1,
    state: 'active',
    displayName: 'Gateway A',
    endpointBase: 'https://gateway-a.example.test/v1',
    secretRef: REF_A_1,
    billingKind: 'custom-account',
    ...overrides,
  };
}

function tombstone(overrides: Partial<CustomGatewayTombstoneV1> = {}): CustomGatewayTombstoneV1 {
  return {
    schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
    connectionId: ID_A,
    archivedAt: '2026-07-19T00:00:00.000Z',
    lastDisplayName: 'Gateway A',
    ...overrides,
  };
}

function fixedOpaqueIds(...ids: string[]): () => string {
  let index = 0;
  return () => {
    const next = ids[index];
    index += 1;
    return next ?? index.toString(16).padStart(32, '0');
  };
}

async function writeRegistry(directory: string, registry: CustomGatewayRegistryV1): Promise<void> {
  await fs.writeFile(path.join(directory, CUSTOM_GATEWAY_REGISTRY_FILE_NAME), serializeCustomGatewayRegistry(registry), 'utf8');
}

describe('CustomGatewayProfileStore provider-key boundary', () => {
  it('routes user add and replace through the shared follow-up, while legacy import stays silent', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    const calls: Array<{ connectionId?: string; secretName: string }> = [];
    const store = new CustomGatewayProfileStore({
      storageDir: directory,
      secrets,
      randomHex: fixedOpaqueIds(
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '11111111111111111111111111111111',
        '22222222222222222222222222222222',
      ),
      storeUserInitiatedProviderKey: async (input) => {
        calls.push({ connectionId: input.connectionId, secretName: input.secretName });
        await input.storeSecret();
      },
    });

    const added = await store.add({
      expectedRegistryRevision: 0,
      displayName: 'Gateway A',
      endpointBase: 'https://gateway.example.test/v1',
      apiKey: 'fixture-add-key',
    });
    const profile = added.profiles[0]!;
    await store.replaceApiKey({
      expectedRegistryRevision: added.registryRevision,
      expectedProfileRevision: profile.revision,
      connectionId: profile.connectionId,
      apiKey: 'fixture-replace-key',
    });

    expect(calls.map((call) => call.connectionId)).toEqual([profile.connectionId, profile.connectionId]);
    expect(calls.map((call) => call.secretName)).toHaveLength(2);

    const legacyDirectory = await temporaryDirectory();
    const legacyCalls: unknown[] = [];
    const legacyStore = new CustomGatewayProfileStore({
      storageDir: legacyDirectory,
      secrets: new MemorySecrets(),
      storeUserInitiatedProviderKey: async (input) => {
        legacyCalls.push(input);
        await input.storeSecret();
      },
    });
    await legacyStore.importLegacy({
      expectedRegistryRevision: 0,
      connectionId: ID_A,
      displayName: 'Migrated gateway',
      endpointBase: 'https://legacy.example.test/v1',
      secretRef: REF_A_1,
      apiKey: 'fixture-legacy-key',
    });
    expect(legacyCalls).toEqual([]);
  });
});

describe('CustomGatewayProfile schema', () => {
  it('uses strict allowlists and cannot serialize an API-key value', () => {
    const valid = profile({
      displayName: '  Local Gateway  ',
      endpointBase: ' HTTPS://Gateway.Example.test:443/v1/ ',
    });
    expect(validateCustomGatewayProfile(valid)).toMatchObject({
      displayName: 'Local Gateway',
      endpointBase: 'https://gateway.example.test/v1',
    });
    expect(() => validateCustomGatewayProfile({ ...valid, apiKey: 'fixture-key' })).toThrow(/unsupported field/);
    expect(() => validateCustomGatewayProfile({ ...valid, secretRef: REF_B_1 })).toThrow(/different connection/);
    expect(() => validateCustomGatewayProfile({ ...valid, endpointBase: 'http://gateway.example.test/v1' })).toThrow(/HTTPS/);
    expect(() => validateCustomGatewayProfile({ ...valid, displayName: 'name\nwith-control' })).toThrow(/control/);
    expect(JSON.stringify(validateCustomGatewayProfile(valid))).not.toContain('fixture-key');
  });

  it('rejects unknown schema, duplicate identifiers, duplicate case-folded names, and active tombstones', () => {
    expect(() => validateCustomGatewayRegistry({ ...emptyCustomGatewayRegistry(), schemaVersion: 2 })).toThrow(/schema version/);
    expect(() => validateCustomGatewayRegistry({ ...emptyCustomGatewayRegistry(), unsupported: true })).toThrow(/unsupported field/);
    expect(() => validateCustomGatewayRegistry({
      ...emptyCustomGatewayRegistry(),
      profiles: [profile(), profile({ connectionId: ID_B, secretRef: REF_B_1, displayName: 'gateway a' })],
    })).toThrow(/duplicate display name/);
    expect(() => validateCustomGatewayRegistry({
      ...emptyCustomGatewayRegistry(),
      profiles: [profile({ displayName: 'Straße' }), profile({ connectionId: ID_B, secretRef: REF_B_1, displayName: 'STRASSE' })],
    })).toThrow(/duplicate display name/);
    expect(() => validateCustomGatewayRegistry({
      ...emptyCustomGatewayRegistry(),
      profiles: [profile(), profile({ displayName: 'Gateway B' })],
    })).toThrow(/duplicate connection id/);
    expect(() => validateCustomGatewayRegistry({
      ...emptyCustomGatewayRegistry(),
      profiles: [profile()],
      tombstones: [tombstone()],
    })).toThrow(/active profile and tombstone/);
    expect(() => validateCustomGatewayProfile({ ...profile(), secretRef: 'not-a-secret-ref' })).toThrow(/secret reference/);
  });
});

describe('CustomGatewayProfileLock', () => {
  it('publishes a complete lock record and removes it only when its owner releases it', async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, CUSTOM_GATEWAY_LOCK_FILE_NAME);
    const lock = new CustomGatewayProfileLock(lockPath, {
      clock: () => 100,
      randomHex: fixedOpaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    });
    await lock.runExclusive(async (lease) => {
      await lease.assertOwnership();
      const acquired = parseCustomGatewayLock(await fs.readFile(lockPath, 'utf8'));
      expect(acquired.ownerId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(acquired.leaseExpiresAt).toBeGreaterThan(100);
    });
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims an expired lock so restart recovery cannot be permanently bricked', async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, CUSTOM_GATEWAY_LOCK_FILE_NAME);
    await fs.writeFile(lockPath, serializeCustomGatewayLock({
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      ownerId: 'dddddddddddddddddddddddddddddddd',
      acquiredAt: 1,
      leaseExpiresAt: 2,
    }), 'utf8');
    let now = 100;
    const contender = new CustomGatewayProfileLock(lockPath, {
      clock: () => now++,
      retryDelayMs: 1,
      acquireTimeoutMs: 3,
      randomHex: fixedOpaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    });
    await contender.runExclusive(async (lease) => {
      await lease.assertOwnership();
      expect(parseCustomGatewayLock(await fs.readFile(lockPath, 'utf8')).ownerId).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    });
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not reclaim an unexpired lock before acquire timeout', async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, CUSTOM_GATEWAY_LOCK_FILE_NAME);
    await fs.writeFile(lockPath, serializeCustomGatewayLock({
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      ownerId: 'dddddddddddddddddddddddddddddddd',
      acquiredAt: 100,
      leaseExpiresAt: 200,
    }), 'utf8');
    let now = 101;
    const contender = new CustomGatewayProfileLock(lockPath, {
      clock: () => now++,
      retryDelayMs: 1,
      acquireTimeoutMs: 3,
    });
    await expect(contender.acquire()).rejects.toBeInstanceOf(CustomGatewayLockTimeoutError);
    expect(parseCustomGatewayLock(await fs.readFile(lockPath, 'utf8')).ownerId).toBe('dddddddddddddddddddddddddddddddd');
  });

  it('removes crash-only pending lock publications once a later holder owns the primary', async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, CUSTOM_GATEWAY_LOCK_FILE_NAME);
    const pendingPath = `${lockPath}.dddddddddddddddddddddddddddddddd.pending`;
    await fs.writeFile(pendingPath, 'abandoned', 'utf8');
    const old = new Date(Date.now() - 31_000);
    await fs.utimes(pendingPath, old, old);
    const lock = new CustomGatewayProfileLock(lockPath, {
      randomHex: fixedOpaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      leaseDurationMs: 30_000,
    });
    await lock.runExclusive(async () => undefined);
    await expect(fs.access(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries Windows rename-over-target failures without deleting the prior complete file', async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, 'registry.json');
    await fs.writeFile(target, 'old-complete', 'utf8');
    let attempts = 0;
    await writeFileAtomically(target, 'new-complete', {
      rename: async (oldPath, newPath) => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
        await fs.rename(oldPath, newPath);
      },
      sleep: async () => undefined,
    });
    expect(attempts).toBe(3);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('new-complete');
  });
});

describe('CustomGatewayProfileStore CRUD', () => {
  it('serves the last durable state when another window holds the lock, instead of failing the load', async () => {
    // Reported from a real install: "registry could not be loaded ... repair the file", underlying error
    // "Timed out waiting for custom gateway registry lock". The file was valid; a second window simply held
    // the lock. acquireTimeoutMs (5s) is far below leaseDurationMs (30s), so a holder that is slow or dies
    // makes every other window fail long before the lease can be reclaimed — and each failure disabled all
    // custom gateways for that session. A read must degrade, not fail.
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    const build = (options: Record<string, unknown> = {}) => new CustomGatewayProfileStore({
      storageDir: directory,
      secrets,
      randomHex: fixedOpaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111111111111111111111111111'),
      ...options,
    });

    const added = await build().add({
      expectedRegistryRevision: 0,
      displayName: 'Gateway A',
      endpointBase: 'https://gateway.example.test/v1',
      apiKey: 'fixture-key',
    });

    // Hold the lock the way a second window would, then read with a store that gives up quickly.
    const holder = new CustomGatewayProfileLock(path.join(directory, CUSTOM_GATEWAY_LOCK_FILE_NAME));
    const lease = await holder.acquire();
    try {
      const degraded: unknown[] = [];
      const snapshot = await build({ acquireTimeoutMs: 50, onDegradedRead: (e: unknown) => degraded.push(e) }).load();
      expect(snapshot.profiles).toHaveLength(1);
      expect(snapshot.profiles[0].connectionId).toBe(added.profiles[0].connectionId);
      expect(degraded).toHaveLength(1);
    } finally {
      await lease.release();
    }
  });

  it('still loads a valid registry when the orphaned-secret sweep fails', async () => {
    // Regression: a user upgrading to 0.9.32 saw "registry could not be loaded — repair the file" for a
    // registry file that was completely valid. Archiving a gateway leaves an unreferenced retired secret
    // ref, so every later load() tries to delete it; that delete ran unguarded on the activation path, so a
    // SecretStorage failure disabled every custom gateway and blamed the file. Deleting an ORPHANED secret
    // is housekeeping — nothing routes to it — and must never veto a load.
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    const failing = {
      store: secrets.store.bind(secrets),
      has: secrets.has.bind(secrets),
      delete: async (secretRef: string) => { throw new Error(`SecretStorage unavailable for ${secretRef}`); },
    };
    const reported: string[] = [];
    const build = (secretStorage: typeof failing | MemorySecrets) => new CustomGatewayProfileStore({
      storageDir: directory,
      secrets: secretStorage as any,
      onOrphanCleanupFailed: (secretRef) => { reported.push(secretRef); },
      randomHex: fixedOpaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111111111111111111111111111'),
    });

    const added = await build(secrets).add({
      expectedRegistryRevision: 0,
      displayName: 'Gateway A',
      endpointBase: 'https://gateway.example.test/v1',
      apiKey: 'fixture-key',
    });
    const connectionId = added.profiles[0].connectionId;
    // Archiving retires the secret ref, leaving exactly the orphan the sweep tries to remove.
    await build(secrets).archive({
      expectedRegistryRevision: added.registryRevision,
      expectedProfileRevision: added.profiles[0].revision,
      connectionId,
      assertNoKnownReferences: async () => undefined,
    } as any);

    const snapshot = await build(failing).load();
    expect(snapshot.registryRevision).toBeGreaterThan(0);
    expect(reported.length).toBeGreaterThan(0);
  });

  it('binds storage to ExtensionContext.globalStorageUri and uses only opaque SecretStorage refs', async () => {
    const directory = await temporaryDirectory();
    const values = new Map<string, string>();
    const store = createVSCodeCustomGatewayProfileStore({
      globalStorageUri: { fsPath: directory },
      secrets: {
        store: async (key: string, value: string) => { values.set(key, value); },
        get: async (key: string) => values.get(key),
        delete: async (key: string) => { values.delete(key); },
      },
    } as any, {
      randomHex: fixedOpaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111111111111111111111111111'),
    });
    const added = await store.add({
      expectedRegistryRevision: 0,
      displayName: 'Gateway A',
      endpointBase: 'https://gateway.example.test/v1',
      apiKey: 'fixture-key',
    });
    expect(values.has(secretStorageKey(added.profiles[0].secretRef!))).toBe(true);
    expect(await fs.readFile(path.join(directory, CUSTOM_GATEWAY_REGISTRY_FILE_NAME), 'utf8')).not.toContain('fixture-key');
  });

  it('keeps 0, 1, 2, and 10 profiles stable across reload without serializing API keys', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    const opaqueIds = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111111111111111111111111111', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '22222222222222222222222222222222',
      'cccccccccccccccccccccccccccccccc', '33333333333333333333333333333333', 'dddddddddddddddddddddddddddddddd', '44444444444444444444444444444444',
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '55555555555555555555555555555555', 'ffffffffffffffffffffffffffffffff', '66666666666666666666666666666666',
      '11111111111111111111111111111111', '77777777777777777777777777777777', '22222222222222222222222222222222', '88888888888888888888888888888888',
      '33333333333333333333333333333333', '99999999999999999999999999999999', '44444444444444444444444444444444', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ];
    const store = new CustomGatewayProfileStore({
      storageDir: directory,
      secrets,
      reservedDisplayNames: ['Unode'],
      randomHex: fixedOpaqueIds(...opaqueIds),
    });
    expect((await store.load()).profiles).toHaveLength(0);
    let revision = 0;
    for (let index = 0; index < 10; index += 1) {
      const snapshot = await store.add({
        expectedRegistryRevision: revision,
        displayName: `Gateway ${String.fromCharCode(74 - index)}`,
        endpointBase: `https://gateway-${index}.example.test/v1/`,
        apiKey: `fixture-key-${index}`,
      });
      revision = snapshot.registryRevision;
      if (index < 2) {
        const reloadedEarly = await new CustomGatewayProfileStore({ storageDir: directory, secrets, reservedDisplayNames: ['Unode'] }).load();
        expect(reloadedEarly.profiles).toHaveLength(index + 1);
        expect(reloadedEarly.registryRevision).toBe(index + 1);
      }
    }
    const reloaded = await new CustomGatewayProfileStore({ storageDir: directory, secrets, reservedDisplayNames: ['Unode'] }).load();
    expect(reloaded.registryRevision).toBe(10);
    expect(reloaded.profiles).toHaveLength(10);
    expect(reloaded.profiles.map((item) => item.displayName)).toEqual([
      'Gateway A', 'Gateway B', 'Gateway C', 'Gateway D', 'Gateway E',
      'Gateway F', 'Gateway G', 'Gateway H', 'Gateway I', 'Gateway J',
    ]);
    const disk = await fs.readFile(path.join(directory, CUSTOM_GATEWAY_REGISTRY_FILE_NAME), 'utf8');
    expect(disk).not.toContain('fixture-key-');
    await expect(store.add({
      expectedRegistryRevision: 10,
      displayName: 'unode',
      endpointBase: 'https://conflict.example.test/v1',
      apiKey: 'fixture-key-conflict',
    })).rejects.toThrow(/built-in/);
  }, 15_000);

  it('uses fresh secret generations and durable revisions for endpoint/key/lifecycle changes', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    const store = new CustomGatewayProfileStore({
      storageDir: directory,
      secrets,
      randomHex: fixedOpaqueIds(
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111111111111111111111111111',
        '22222222222222222222222222222222', '33333333333333333333333333333333',
      ),
      clock: () => Date.parse('2026-07-19T00:00:00.000Z'),
    });
    const added = await store.add({
      expectedRegistryRevision: 0,
      displayName: 'Gateway A',
      endpointBase: 'https://gateway.example.test/v1',
      apiKey: 'fixture-first',
    });
    const original = added.profiles[0];
    expect(await secrets.has(original.secretRef!)).toBe(true);

    const renamed = await store.update({
      expectedRegistryRevision: 1,
      expectedProfileRevision: 1,
      connectionId: original.connectionId,
      displayName: 'Gateway Renamed',
    });
    expect(renamed.profiles[0].revision).toBe(1);

    const endpointChanged = await store.update({
      expectedRegistryRevision: 2,
      expectedProfileRevision: 1,
      connectionId: original.connectionId,
      endpointBase: 'https://gateway.example.test/v2/',
    });
    expect(endpointChanged.profiles[0]).toMatchObject({ endpointBase: 'https://gateway.example.test/v2', revision: 2 });

    const replaced = await store.replaceApiKey({
      expectedRegistryRevision: 3,
      expectedProfileRevision: 2,
      connectionId: original.connectionId,
      apiKey: 'fixture-second',
    });
    const replacedProfile = replaced.profiles[0];
    expect(replacedProfile.revision).toBe(3);
    expect(replacedProfile.secretRef).not.toBe(original.secretRef);
    expect(await secrets.has(original.secretRef!)).toBe(false);
    expect(await secrets.has(replacedProfile.secretRef!)).toBe(true);

    const cleared = await store.clearApiKey({
      expectedRegistryRevision: 4,
      expectedProfileRevision: 3,
      connectionId: original.connectionId,
    });
    expect(cleared.profiles[0]).toMatchObject({ revision: 4 });
    expect(cleared.profiles[0].secretRef).toBeUndefined();
    expect(await secrets.has(replacedProfile.secretRef!)).toBe(false);

    const archived = await store.archive({
      expectedRegistryRevision: 5,
      expectedProfileRevision: 4,
      connectionId: original.connectionId,
      assertNoKnownReferences: async () => undefined,
    });
    expect(archived.profiles).toHaveLength(0);
    expect(archived.tombstones).toEqual([tombstone({ connectionId: original.connectionId, lastDisplayName: 'Gateway Renamed' })]);
    await expect(store.update({
      expectedRegistryRevision: 6,
      expectedProfileRevision: 4,
      connectionId: original.connectionId,
      displayName: 'Never Reused',
    })).rejects.toThrow(/archived/);
  }, 15_000);

  it('imports a journaled legacy profile idempotently without serializing or reusing its legacy key name', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    const store = new CustomGatewayProfileStore({
      storageDir: directory,
      secrets,
      randomHex: fixedOpaqueIds('11111111111111111111111111111111'),
    });
    const imported = await store.importLegacy({
      expectedRegistryRevision: 0,
      connectionId: ID_A,
      displayName: 'Migrated gateway 1',
      endpointBase: 'https://legacy.example.test/v1/',
      secretRef: REF_A_1,
      apiKey: 'legacy-key-value',
    });
    expect(imported.profiles).toMatchObject([{
      connectionId: ID_A,
      endpointBase: 'https://legacy.example.test/v1',
      secretRef: REF_A_1,
    }]);
    expect(await secrets.has(REF_A_1)).toBe(true);
    const disk = await fs.readFile(path.join(directory, CUSTOM_GATEWAY_REGISTRY_FILE_NAME), 'utf8');
    expect(disk).not.toContain('legacy-key-value');
    expect(disk).not.toContain('CUSTOM_API_KEY');

    const replay = await store.importLegacy({
      expectedRegistryRevision: 1,
      connectionId: ID_A,
      displayName: 'Migrated gateway 1',
      endpointBase: 'https://legacy.example.test/v1',
      secretRef: REF_A_1,
      apiKey: 'legacy-key-value',
    });
    expect(replay.registryRevision).toBe(1);
    expect(replay.profiles).toHaveLength(1);
  });

  it('imports a missing legacy key as an explicit keyless profile', async () => {
    const directory = await temporaryDirectory();
    const store = new CustomGatewayProfileStore({
      storageDir: directory,
      secrets: new MemorySecrets(),
      randomHex: fixedOpaqueIds('11111111111111111111111111111111'),
    });
    const imported = await store.importLegacy({
      expectedRegistryRevision: 0,
      connectionId: ID_A,
      displayName: 'Migrated gateway 1',
      endpointBase: 'https://legacy.example.test/v1',
    });
    expect(imported.profiles[0].secretRef).toBeUndefined();
    expect(imported.registryRevision).toBe(1);
  });
});

describe('CustomGatewayProfileStore operation recovery', () => {
  it('reclaims an expired lock before recovering a crash-persisted operation', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    const lockPath = path.join(directory, CUSTOM_GATEWAY_LOCK_FILE_NAME);
    await secrets.store(REF_A_1, 'fixture-staged');
    const operation: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '11111111111111111111111111111111',
      kind: 'add',
      connectionId: ID_A,
      expectedRegistryRevision: 0,
      phase: 'prepared',
      newSecretRef: REF_A_1,
      nextProfile: profile(),
    };
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), operation });
    await fs.writeFile(lockPath, serializeCustomGatewayLock({
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      ownerId: 'dddddddddddddddddddddddddddddddd',
      acquiredAt: 1,
      leaseExpiresAt: 2,
    }), 'utf8');
    const recovered = await new CustomGatewayProfileStore({
      storageDir: directory,
      secrets,
      clock: () => 100,
      randomHex: fixedOpaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    }).load();
    expect(recovered.profiles).toHaveLength(0);
    expect(recovered.pendingOperation).toBeUndefined();
    expect(await secrets.has(REF_A_1)).toBe(false);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back a prepared add and enumerates its staged secret before cleanup', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    await secrets.store(REF_A_1, 'fixture-staged');
    const operation: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '11111111111111111111111111111111',
      kind: 'add',
      connectionId: ID_A,
      expectedRegistryRevision: 0,
      phase: 'prepared',
      newSecretRef: REF_A_1,
      nextProfile: profile(),
    };
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), operation });
    expect(enumerateManagedCustomGatewaySecretRefs({ ...emptyCustomGatewayRegistry(), operation })).toEqual([REF_A_1]);
    const snapshot = await new CustomGatewayProfileStore({ storageDir: directory, secrets }).load();
    expect(snapshot.profiles).toHaveLength(0);
    expect(snapshot.pendingOperation).toBeUndefined();
    expect(await secrets.has(REF_A_1)).toBe(false);
  });

  it('retries a journaled legacy import after recovery rolls back its prepared operation', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    await secrets.store(REF_A_1, 'fixture-staged-before-crash');
    const operation: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '11111111111111111111111111111111',
      kind: 'add',
      connectionId: ID_A,
      expectedRegistryRevision: 0,
      phase: 'prepared',
      newSecretRef: REF_A_1,
      nextProfile: profile({ displayName: 'Migrated gateway 1', endpointBase: 'https://legacy.example.test/v1' }),
    };
    await writeRegistry(directory, {
      ...emptyCustomGatewayRegistry(),
      retiredSecretRefs: [REF_A_1],
      operation,
    });

    const store = new CustomGatewayProfileStore({
      storageDir: directory,
      secrets,
      randomHex: fixedOpaqueIds('22222222222222222222222222222222'),
    });
    const recovered = await store.load();
    expect(recovered.profiles).toHaveLength(0);
    expect(recovered.pendingOperation).toBeUndefined();
    expect(await secrets.has(REF_A_1)).toBe(false);

    const retried = await store.importLegacy({
      expectedRegistryRevision: recovered.registryRevision,
      connectionId: ID_A,
      displayName: 'Migrated gateway 1',
      endpointBase: 'https://legacy.example.test/v1',
      secretRef: REF_A_1,
      apiKey: 'fixture-retried-legacy-key',
    });
    expect(retried.profiles).toMatchObject([{ connectionId: ID_A, secretRef: REF_A_1 }]);
    expect(retried.profiles).toHaveLength(1);
    expect(await secrets.has(REF_A_1)).toBe(true);
  });

  it('finishes secret-written add and clear/archive operations after restart', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    await secrets.store(REF_A_1, 'fixture-staged');
    const addOperation: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '11111111111111111111111111111111',
      kind: 'add',
      connectionId: ID_A,
      expectedRegistryRevision: 0,
      phase: 'secret-written',
      newSecretRef: REF_A_1,
      nextProfile: profile(),
    };
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), operation: addOperation });
    const store = new CustomGatewayProfileStore({ storageDir: directory, secrets });
    const added = await store.load();
    expect(added.profiles).toEqual([profile()]);
    expect(await secrets.has(REF_A_1)).toBe(true);

    const replayed = await store.importLegacy({
      expectedRegistryRevision: added.registryRevision,
      connectionId: ID_A,
      displayName: 'Gateway A',
      endpointBase: 'https://gateway-a.example.test/v1',
      secretRef: REF_A_1,
      apiKey: 'fixture-staged',
    });
    expect(replayed.registryRevision).toBe(1);
    expect(replayed.profiles).toEqual([profile()]);

    const clearOperation: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '22222222222222222222222222222222',
      kind: 'clear-key',
      connectionId: ID_A,
      expectedRegistryRevision: 1,
      phase: 'prepared',
      oldSecretRef: REF_A_1,
      previousProfile: profile(),
      nextProfile: profile({ revision: 2, secretRef: undefined }),
    };
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), registryRevision: 1, profiles: [profile()], operation: clearOperation });
    const cleared = await new CustomGatewayProfileStore({ storageDir: directory, secrets }).load();
    expect(cleared.profiles[0].secretRef).toBeUndefined();
    expect(cleared.profiles[0].revision).toBe(2);
    expect(await secrets.has(REF_A_1)).toBe(false);
  });

  it('finishes registry-written add and secret-written replacement after restart', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    await secrets.store(REF_A_1, 'fixture-new');
    const add: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '11111111111111111111111111111111',
      kind: 'add',
      connectionId: ID_A,
      expectedRegistryRevision: 0,
      phase: 'registry-written',
      newSecretRef: REF_A_1,
      nextProfile: profile(),
    };
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), registryRevision: 1, profiles: [profile()], operation: add });
    const addCompleted = await new CustomGatewayProfileStore({ storageDir: directory, secrets }).load();
    expect(addCompleted.profiles).toEqual([profile()]);
    expect(addCompleted.pendingOperation).toBeUndefined();

    await secrets.store(REF_A_2, 'fixture-replacement');
    const previous = profile();
    const next = profile({ revision: 2, secretRef: REF_A_2 });
    const replace: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '22222222222222222222222222222222',
      kind: 'replace-key',
      connectionId: ID_A,
      expectedRegistryRevision: 1,
      phase: 'secret-written',
      oldSecretRef: REF_A_1,
      newSecretRef: REF_A_2,
      previousProfile: previous,
      nextProfile: next,
    };
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), registryRevision: 1, profiles: [previous], operation: replace });
    const replaceCompleted = await new CustomGatewayProfileStore({ storageDir: directory, secrets }).load();
    expect(replaceCompleted.profiles).toEqual([next]);
    expect(await secrets.has(REF_A_1)).toBe(false);
    expect(await secrets.has(REF_A_2)).toBe(true);
  });

  it('finishes registry-written replacement cleanup and rolls back missing staged keys fail-closed', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    await secrets.store(REF_A_1, 'fixture-old');
    await secrets.store(REF_A_2, 'fixture-new');
    const previous = profile();
    const next = profile({ revision: 2, secretRef: REF_A_2 });
    const replacement: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '22222222222222222222222222222222',
      kind: 'replace-key',
      connectionId: ID_A,
      expectedRegistryRevision: 1,
      phase: 'registry-written',
      oldSecretRef: REF_A_1,
      newSecretRef: REF_A_2,
      previousProfile: previous,
      nextProfile: next,
    };
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), registryRevision: 2, profiles: [next], operation: replacement });
    const completed = await new CustomGatewayProfileStore({ storageDir: directory, secrets }).load();
    expect(completed.profiles).toEqual([next]);
    expect(await secrets.has(REF_A_1)).toBe(false);
    expect(await secrets.has(REF_A_2)).toBe(true);

    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), registryRevision: 2, profiles: [next], operation: replacement });
    await secrets.delete(REF_A_2);
    await secrets.store(REF_A_1, 'fixture-old-restored');
    const rolledBack = await new CustomGatewayProfileStore({ storageDir: directory, secrets }).load();
    expect(rolledBack.profiles).toEqual([previous]);
    expect(rolledBack.registryRevision).toBe(3);
    expect(rolledBack.pendingOperation).toBeUndefined();
  });

  it('recovers prepared replacement, prepared clear, and registry-written archive idempotently', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    await secrets.store(REF_A_1, 'fixture-old');
    const previous = profile();
    const replacement: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '22222222222222222222222222222222',
      kind: 'replace-key',
      connectionId: ID_A,
      expectedRegistryRevision: 1,
      phase: 'prepared',
      oldSecretRef: REF_A_1,
      newSecretRef: REF_A_2,
      previousProfile: previous,
      nextProfile: profile({ revision: 2, secretRef: REF_A_2 }),
    };
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), registryRevision: 1, profiles: [previous], operation: replacement });
    const replacementRolledBack = await new CustomGatewayProfileStore({ storageDir: directory, secrets }).load();
    expect(replacementRolledBack.profiles).toEqual([previous]);
    expect(await secrets.has(REF_A_1)).toBe(true);
    expect(await secrets.has(REF_A_2)).toBe(false);

    const clear: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '33333333333333333333333333333333',
      kind: 'clear-key',
      connectionId: ID_A,
      expectedRegistryRevision: 1,
      phase: 'prepared',
      oldSecretRef: REF_A_1,
      previousProfile: previous,
      nextProfile: profile({ revision: 2, secretRef: undefined }),
    };
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), registryRevision: 1, profiles: [previous], operation: clear });
    const clearCompleted = await new CustomGatewayProfileStore({ storageDir: directory, secrets }).load();
    expect(clearCompleted.profiles[0].secretRef).toBeUndefined();
    expect(await secrets.has(REF_A_1)).toBe(false);

    await secrets.store(REF_A_1, 'fixture-old-prepared-archive');
    const preparedArchive: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '44444444444444444444444444444444',
      kind: 'archive',
      connectionId: ID_A,
      expectedRegistryRevision: 2,
      phase: 'prepared',
      oldSecretRef: REF_A_1,
      previousProfile: previous,
      nextTombstone: tombstone(),
    };
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), registryRevision: 2, profiles: [previous], operation: preparedArchive });
    const preparedArchiveCompleted = await new CustomGatewayProfileStore({ storageDir: directory, secrets }).load();
    expect(preparedArchiveCompleted.tombstones).toEqual([tombstone()]);
    expect(await secrets.has(REF_A_1)).toBe(false);

    await secrets.store(REF_A_1, 'fixture-old-again');
    const archived = tombstone();
    const archive: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '44444444444444444444444444444444',
      kind: 'archive',
      connectionId: ID_A,
      expectedRegistryRevision: 2,
      phase: 'registry-written',
      oldSecretRef: REF_A_1,
      previousProfile: previous,
      nextTombstone: archived,
    };
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), registryRevision: 3, tombstones: [archived], operation: archive });
    const archiveCompleted = await new CustomGatewayProfileStore({ storageDir: directory, secrets }).load();
    expect(archiveCompleted.tombstones).toEqual([archived]);
    expect(archiveCompleted.profiles).toHaveLength(0);
    expect(await secrets.has(REF_A_1)).toBe(false);
  });

  it('rejects malformed generation reuse and non-monotonic key operation revisions', () => {
    const previous = profile();
    expect(() => validateCustomGatewayRegistry({
      ...emptyCustomGatewayRegistry(),
      registryRevision: 1,
      profiles: [previous],
      operation: {
        schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
        operationId: '22222222222222222222222222222222',
        kind: 'replace-key',
        connectionId: ID_A,
        expectedRegistryRevision: 1,
        phase: 'prepared',
        oldSecretRef: REF_A_1,
        newSecretRef: REF_A_1,
        previousProfile: previous,
        nextProfile: profile({ revision: 2, secretRef: REF_A_1 }),
      },
    })).toThrow(/fresh secret generation/);
    expect(() => validateCustomGatewayRegistry({
      ...emptyCustomGatewayRegistry(),
      registryRevision: 1,
      profiles: [previous],
      operation: {
        schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
        operationId: '22222222222222222222222222222222',
        kind: 'clear-key',
        connectionId: ID_A,
        expectedRegistryRevision: 1,
        phase: 'prepared',
        oldSecretRef: REF_A_1,
        previousProfile: previous,
        nextProfile: profile({ secretRef: undefined }),
      },
    })).toThrow(/increment the profile revision/);
    expect(() => validateCustomGatewayRegistry({
      ...emptyCustomGatewayRegistry(),
      registryRevision: 1,
      profiles: [previous],
      operation: {
        schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
        operationId: '22222222222222222222222222222222',
        kind: 'replace-key',
        connectionId: ID_A,
        expectedRegistryRevision: 1,
        phase: 'prepared',
        oldSecretRef: REF_A_1,
        newSecretRef: REF_A_2,
        previousProfile: previous,
        nextProfile: profile({ revision: 2, secretRef: REF_A_2, endpointBase: 'https://attacker.example.test/v1' }),
      },
    })).toThrow(/must not change display name or endpoint/);
    expect(() => validateCustomGatewayRegistry({
      ...emptyCustomGatewayRegistry(),
      registryRevision: 1,
      profiles: [profile()],
      operation: {
        schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
        operationId: '11111111111111111111111111111111',
        kind: 'add',
        connectionId: ID_A,
        expectedRegistryRevision: 0,
        phase: 'registry-written',
        oldSecretRef: REF_A_1,
        newSecretRef: REF_A_1,
        nextProfile: profile(),
      },
    })).toThrow(/add operation shape/);
  });

  it('fails closed to a keyless profile when both replacement generations are unavailable after old cleanup begins', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    const previous = profile();
    const next = profile({ revision: 2, secretRef: REF_A_2 });
    const operation: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '22222222222222222222222222222222',
      kind: 'replace-key',
      connectionId: ID_A,
      expectedRegistryRevision: 1,
      phase: 'old-secret-cleanup',
      oldSecretRef: REF_A_1,
      newSecretRef: REF_A_2,
      previousProfile: previous,
      nextProfile: next,
    };
    await writeRegistry(directory, {
      ...emptyCustomGatewayRegistry(),
      registryRevision: 2,
      profiles: [next],
      operation,
    });
    const recovered = await new CustomGatewayProfileStore({ storageDir: directory, secrets }).load();
    expect(recovered.pendingOperation).toBeUndefined();
    expect(recovered.profiles[0].secretRef).toBeUndefined();
    expect(recovered.profiles[0].revision).toBe(3);
    expect(recovered.registryRevision).toBe(3);
  });

  it('requires the host reference guard before archiving', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    const store = new CustomGatewayProfileStore({
      storageDir: directory,
      secrets,
      randomHex: fixedOpaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111111111111111111111111111'),
    });
    const added = await store.add({
      expectedRegistryRevision: 0,
      displayName: 'Gateway A',
      endpointBase: 'https://gateway.example.test/v1',
      apiKey: 'fixture-key',
    });
    await expect(store.archive({
      expectedRegistryRevision: 1,
      expectedProfileRevision: 1,
      connectionId: added.profiles[0].connectionId,
      assertNoKnownReferences: async () => { throw new Error('Referenced by the active default.'); },
    })).rejects.toThrow(/Referenced by the active default/);
    expect((await store.load()).profiles).toHaveLength(1);
  });

  it('fails closed when a persisted profile collides with a built-in display name', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), profiles: [profile({ displayName: 'Unode' })] });
    await expect(new CustomGatewayProfileStore({
      storageDir: directory,
      secrets,
      reservedDisplayNames: ['Unode'],
    }).load()).rejects.toThrow(/conflicts with a built-in/);
  });

  it('fails closed when a recovered operation introduces a built-in display name', async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecrets();
    await secrets.store(REF_A_1, 'fixture-key');
    const operation: CustomGatewayOperationV1 = {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      operationId: '11111111111111111111111111111111',
      kind: 'add',
      connectionId: ID_A,
      expectedRegistryRevision: 0,
      phase: 'secret-written',
      newSecretRef: REF_A_1,
      nextProfile: profile({ displayName: 'Unode' }),
    };
    await writeRegistry(directory, { ...emptyCustomGatewayRegistry(), operation });
    await expect(new CustomGatewayProfileStore({
      storageDir: directory,
      secrets,
      reservedDisplayNames: ['Unode'],
    }).load()).rejects.toThrow(/conflicts with a built-in/);
  });
});
