/*
 * Durable machine-local profile registry for user-configured OpenAI-compatible gateways.
 *
 * This module deliberately does not import vscode. The extension composition root will pass
 * `context.globalStorageUri.fsPath` and a thin SecretStorage adapter; this keeps the registry
 * schema, lock protocol, and restart recovery independently testable.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  CUSTOM_GATEWAY_LOCK_FILE_NAME,
  CUSTOM_GATEWAY_REGISTRY_FILE_NAME,
  CUSTOM_GATEWAY_SCHEMA_VERSION,
  CustomGatewayConnectionId,
  CustomGatewayLockRecordV1,
  CustomGatewayOperationV1,
  CustomGatewayProfileV1,
  CustomGatewayRegistrySnapshot,
  CustomGatewayRegistryV1,
  CustomGatewayTombstoneV1,
  cloneCustomGatewayRegistry,
  assertCustomGatewayConnectionId,
  assertCustomGatewaySecretRef,
  customGatewayDisplayNameKey,
  emptyCustomGatewayRegistry,
  enumerateManagedCustomGatewaySecretRefs,
  normalizeCustomGatewayDisplayName,
  parseCustomGatewayLock,
  parseCustomGatewayRegistry,
  serializeCustomGatewayLock,
  serializeCustomGatewayRegistry,
  validateCustomGatewayRegistry,
} from './CustomGatewayProfile';
import type { UserInitiatedProviderKeyStoreInput } from '../secrets/UserInitiatedProviderKeyStore';
import { requireHttpsCustomEndpoint } from '../routes/RouteContracts';

export interface CustomGatewaySecretStorage {
  /** Store an API-key value under an opaque, host-generated name. Never return the value. */
  store(secretRef: string, value: string): Promise<void>;
  delete(secretRef: string): Promise<void>;
  has(secretRef: string): Promise<boolean>;
}

export interface AddCustomGatewayInput {
  expectedRegistryRevision: number;
  displayName: string;
  endpointBase: string;
  /** Extension-host-only input. This value is never serialized or returned from this module. */
  apiKey: string;
}

/**
 * Host-only import input for the v0.9.31 legacy singleton migration. The caller persists these
 * generated identifiers before calling this method, making a crash/retry idempotent without using
 * endpoint equality as an identity or touching an existing hand-created profile.
 */
export interface ImportLegacyCustomGatewayInput {
  expectedRegistryRevision: number;
  connectionId: CustomGatewayConnectionId;
  displayName: string;
  endpointBase: string;
  secretRef?: string;
  /** Extension-host-only copied legacy key. Omitted means a visible, non-runnable keyless profile. */
  apiKey?: string;
}

export interface UpdateCustomGatewayInput {
  expectedRegistryRevision: number;
  expectedProfileRevision: number;
  connectionId: CustomGatewayConnectionId;
  displayName?: string;
  endpointBase?: string;
}

export interface ChangeCustomGatewayKeyInput {
  expectedRegistryRevision: number;
  expectedProfileRevision: number;
  connectionId: CustomGatewayConnectionId;
  /** Extension-host-only input. This value is never serialized or returned from this module. */
  apiKey: string;
}

export interface ClearCustomGatewayKeyInput {
  expectedRegistryRevision: number;
  expectedProfileRevision: number;
  connectionId: CustomGatewayConnectionId;
}

export interface ArchiveCustomGatewayInput extends ClearCustomGatewayKeyInput {
  /** Host-only guard that must reject while a current workspace/session/default/Smart Mode reference remains. */
  assertNoKnownReferences: () => Promise<void>;
}

export interface AtomicFileReplaceOptions {
  /** Used by tests to exercise Windows rename-over retries without changing production behavior. */
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRenameAttempts?: number;
}

export interface CustomGatewayProfileLockOptions {
  clock?: () => number;
  retryDelayMs?: number;
  acquireTimeoutMs?: number;
  leaseDurationMs?: number;
  randomHex?: () => string;
}

export interface CustomGatewayProfileStoreOptions extends CustomGatewayProfileLockOptions {
  storageDir: string;
  secrets: CustomGatewaySecretStorage;
  /** Built-in display names are supplied by G1 so custom names remain unambiguous in the effective registry. */
  reservedDisplayNames?: readonly string[];
  /**
   * Notified when an orphaned-secret sweep step fails. The sweep is deliberately best-effort: it must never
   * stop a valid registry from loading. Host wiring logs this; the ref is retried on the next sweep.
   */
  onOrphanCleanupFailed?: (secretRef: string, error: unknown) => void;
  /**
   * Notified when `load()` could not take the lock and served the last durable state instead. Recovery and
   * the orphan sweep were skipped for that read; the next uncontended load performs them.
   */
  onDegradedRead?: (error: unknown) => void;
  /**
   * The host's single user-initiated provider-key boundary.  Add and replace-key use it; legacy
   * import deliberately does not, because moving an existing key must never open a price prompt.
   */
  storeUserInitiatedProviderKey?: (input: Omit<
    UserInitiatedProviderKeyStoreInput,
    'promptForPriceMultiplier' | 'onCredentialChanged'
  >) => Promise<void>;
}

export class CustomGatewayLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Timed out waiting for custom gateway registry lock "${lockPath}".`);
  }
}

/**
 * Cross-window lock protocol
 *
 * 1. Contenders publish a fully fsynced lock record through a private pending file plus atomic
 *    hard-link, so a competing window can never observe a partially written lock.
 * 2. The primary lock is a fixed TTL lease. Only a lock whose persisted `leaseExpiresAt` has
 *    elapsed may be reclaimed by atomic rename-aside; an unexpired lock is never stolen. A writer
 *    that resumes after reclamation loses ownership at its next durable boundary, while the
 *    write-ahead operation remains recoverable by the new holder.
 * 3. Every mutation has a durable operation before SecretStorage changes. Therefore waiting or
 *    timing out never turns a partial operation into an implicit route, credential, or fallback.
 * 4. Registry writes are temp-file + fsync + close + rename-over-target. Windows EBUSY/EPERM/
 *    ENOTEMPTY rename-over failures retry without unlinking the destination, preserving either the
 *    old complete registry or the new complete registry.
 * 5. The lease is a crash-recovery mechanism, not a distributed transaction. All mutations carry
 *    an expected registry revision and are serialized through this lock; callers must retry after
 *    stale snapshots rather than overwrite a newer registry. A stale writer that resumes after an
 *    expired lease can still lose a narrowly-timed registry race before its next ownership check;
 *    that failure is recoverable and may at worst leave an enumerable SecretStorage generation.
 */
export class CustomGatewayProfileLock {
  private readonly clock: () => number;
  private readonly retryDelayMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly leaseDurationMs: number;
  private readonly randomHex: () => string;

  constructor(
    private readonly lockPath: string,
    options: CustomGatewayProfileLockOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.retryDelayMs = options.retryDelayMs ?? 25;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 5_000;
    this.randomHex = options.randomHex ?? randomOpaqueHex;
  }

  async runExclusive<T>(work: (lease: CustomGatewayProfileLease) => Promise<T>): Promise<T> {
    const lease = await this.acquire();
    try {
      return await work(lease);
    } finally {
      await lease.release();
    }
  }

  async acquire(): Promise<CustomGatewayProfileLease> {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
    const deadline = this.clock() + this.acquireTimeoutMs;
    while (true) {
      const directLease = await this.tryCreatePrimaryLock();
      if (directLease) {
        return directLease;
      }
      if (await this.reclaimExpiredPrimaryLock()) {
        continue;
      }
      await this.waitOrTimeout(deadline);
    }
  }

  private newRecord(): CustomGatewayLockRecordV1 {
    const acquiredAt = this.clock();
    return {
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      ownerId: this.randomHex(),
      acquiredAt,
      leaseExpiresAt: acquiredAt + this.leaseDurationMs,
    };
  }

  private async tryCreatePrimaryLock(): Promise<CustomGatewayProfileLease | undefined> {
    const record = this.newRecord();
    try {
      await createLockFile(this.lockPath, record);
      await this.cleanupExpiredLockPendingFiles();
      return new CustomGatewayProfileLease(this.lockPath, record, this.clock);
    } catch (error) {
      if (isAlreadyExists(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /** Reclaim only a fully-published malformed or expired lock; never touch an unexpired lease. */
  private async reclaimExpiredPrimaryLock(): Promise<boolean> {
    let observedRaw: string;
    let expired = false;
    try {
      observedRaw = await fs.readFile(this.lockPath, 'utf8');
      try {
        expired = parseCustomGatewayLock(observedRaw).leaseExpiresAt <= this.clock();
      } catch {
        // Atomic lock publication means malformed content cannot be an active writer's partial
        // record. Treat disk corruption or an old pre-v1 file as stale and recover fail closed.
        expired = true;
      }
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
    if (!expired) {
      return false;
    }

    const quarantinePath = `${this.lockPath}.${randomOpaqueHex()}.stale`;
    try {
      await fs.rename(this.lockPath, quarantinePath);
    } catch (error) {
      if (isNotFound(error) || isAlreadyExists(error)) {
        return false;
      }
      throw error;
    }
    try {
      const movedRaw = await fs.readFile(quarantinePath, 'utf8');
      if (movedRaw !== observedRaw) {
        // The path changed between observation and rename. Restore only if no fresh winner has
        // published a new primary; otherwise leave that winner untouched and retry acquisition.
        try {
          await fs.link(quarantinePath, this.lockPath);
        } catch (error) {
          if (!isAlreadyExists(error)) {
            throw error;
          }
        }
        return false;
      }
      return true;
    } finally {
      await removeIfPresent(quarantinePath);
    }
  }

  /** Best-effort removal of crash-only pending lock publications after we own the primary. */
  private async cleanupExpiredLockPendingFiles(): Promise<void> {
    const directory = path.dirname(this.lockPath);
    const prefix = `${path.basename(this.lockPath)}.`;
    const now = Date.now();
    try {
      const entries = await fs.readdir(directory);
      await Promise.all(entries.map(async (entry) => {
        if (!entry.startsWith(prefix) || !entry.endsWith('.pending')) {
          return;
        }
        const pendingPath = path.join(directory, entry);
        try {
          const stat = await fs.stat(pendingPath);
          if (now - stat.mtimeMs > this.leaseDurationMs) {
            await removeIfPresent(pendingPath);
          }
        } catch (error) {
          if (!isNotFound(error)) {
            throw error;
          }
        }
      }));
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  private async waitOrTimeout(deadline: number): Promise<void> {
    if (this.clock() >= deadline) {
      throw new CustomGatewayLockTimeoutError(this.lockPath);
    }
    await delay(this.retryDelayMs);
  }

}

export class CustomGatewayProfileLease {
  constructor(
    private readonly lockPath: string,
    private readonly record: CustomGatewayLockRecordV1,
    private readonly clock: () => number,
  ) {}

  async assertOwnership(): Promise<void> {
    let current: CustomGatewayLockRecordV1;
    try {
      current = parseCustomGatewayLock(await fs.readFile(this.lockPath, 'utf8'));
    } catch {
      throw new Error('Custom gateway registry lock was lost before a durable operation.');
    }
    if (!sameLockOwner(current, this.record)) {
      throw new Error('Custom gateway registry lock ownership was lost before a durable operation.');
    }
    if (this.record.leaseExpiresAt <= this.clock()) {
      throw new Error('Custom gateway registry lock lease expired before a durable operation.');
    }
  }

  async renew(): Promise<void> {
    await this.assertOwnership();
  }

  async release(): Promise<void> {
    // Once the lease is near expiry a reclaimer may race this unlink. Leave the expired record for
    // atomic reclaim instead of risking deletion of a newly published successor lock.
    if (this.record.leaseExpiresAt <= this.clock() + 1_000) {
      return;
    }
    await removeLockFileIfOwned(this.lockPath, this.record);
  }
}

/** Write complete content through a fsynced sibling temp file and retry Windows rename-over failures. */
export async function writeFileAtomically(
  targetPath: string,
  content: string,
  options: AtomicFileReplaceOptions = {},
): Promise<void> {
  const rename = options.rename ?? fs.rename;
  const sleep = options.sleep ?? delay;
  const maxRenameAttempts = options.maxRenameAttempts ?? 5;
  const tempPath = `${targetPath}.${randomOpaqueHex()}.tmp`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const handle = await fs.open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    for (let attempt = 1; attempt <= maxRenameAttempts; attempt += 1) {
      try {
        await rename(tempPath, targetPath);
        await syncDirectory(path.dirname(targetPath));
        return;
      } catch (error) {
        if (!isRetryableWindowsRenameError(error) || attempt === maxRenameAttempts) {
          throw error;
        }
        await sleep(10 * attempt);
      }
    }
  } finally {
    await removeIfPresent(tempPath);
  }
}

export class CustomGatewayProfileStore {
  private readonly registryPath: string;
  private readonly lock: CustomGatewayProfileLock;
  private readonly reservedNameKeys: ReadonlySet<string>;
  private readonly clock: () => number;
  private readonly randomHex: () => string;

  constructor(private readonly options: CustomGatewayProfileStoreOptions) {
    if (!path.isAbsolute(options.storageDir)) {
      throw new Error('Custom gateway registry storage directory must be an absolute path.');
    }
    this.registryPath = path.join(options.storageDir, CUSTOM_GATEWAY_REGISTRY_FILE_NAME);
    this.lock = new CustomGatewayProfileLock(path.join(options.storageDir, CUSTOM_GATEWAY_LOCK_FILE_NAME), options);
    this.reservedNameKeys = new Set((options.reservedDisplayNames ?? []).map((name) => customGatewayDisplayNameKey(name)));
    this.clock = options.clock ?? Date.now;
    this.randomHex = options.randomHex ?? randomOpaqueHex;
  }

  /** Startup/read entrypoint: expired locks are reclaimed and any durable operation is recovered first. */
  async load(): Promise<CustomGatewayRegistrySnapshot> {
    try {
      return await this.lock.runExclusive(async (lease) => this.snapshotOf(await this.readAndRecover(lease)));
    } catch (error) {
      if (!(error instanceof CustomGatewayLockTimeoutError)) {
        throw error;
      }
      // A read must not fail because another window happens to hold the lock. Losing the race used to
      // reject the whole load, so activating a second window (or one racing a slow sweep) disabled every
      // custom gateway for that session and reported a valid file as unreadable. The lock guards recovery,
      // the orphan sweep, and writes — not reading. The registry is replaced atomically, so a lock-free read
      // always observes one complete generation, never a torn one; the holder is doing the recovery work we
      // are skipping, and the next uncontended load performs it. Mutations still require the lock.
      this.options.onDegradedRead?.(error);
      return this.snapshotOf(await this.readRegistry());
    }
  }

  /** Managed refs are generated by this store and safe for host-only reset/cleanup workflows. */
  async managedSecretRefs(): Promise<readonly string[]> {
    return this.lock.runExclusive(async (lease) =>
      enumerateManagedCustomGatewaySecretRefs(await this.readAndRecover(lease))
    );
  }

  async add(input: AddCustomGatewayInput): Promise<CustomGatewayRegistrySnapshot> {
    const displayName = normalizeCustomGatewayDisplayName(input.displayName);
    const endpointBase = requireHttpsCustomEndpoint(input.endpointBase);
    const apiKey = requireNonEmptyApiKey(input.apiKey);
    return this.lock.runExclusive(async (lease) => {
      let registry = await this.readAndRecover(lease);
      assertExpectedRegistryRevision(registry, input.expectedRegistryRevision);
      this.assertDisplayNameAvailable(registry, displayName);
      const connectionId = this.createConnectionId(registry);
      const secretRef = this.createSecretRef(registry, connectionId);
      const profile: CustomGatewayProfileV1 = {
        schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
        connectionId,
        revision: 1,
        state: 'active',
        displayName,
        endpointBase,
        secretRef,
        billingKind: 'custom-account',
      };
      const operation: CustomGatewayOperationV1 = {
        schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
        operationId: this.randomHex(),
        kind: 'add',
        connectionId,
        expectedRegistryRevision: registry.registryRevision,
        phase: 'prepared',
        newSecretRef: secretRef,
        nextProfile: profile,
      };
      registry = this.trackGeneratedSecretRef({ ...registry, operation }, secretRef);
      await this.writeRegistry(registry, lease);

      await this.storeStagedSecretOrCleanUp(lease, secretRef, apiKey, connectionId, true);
      registry = { ...registry, operation: { ...operation, phase: 'secret-written' } };
      await this.writeRegistry(registry, lease);

      registry = this.applyOperationTarget(registry, registry.operation!);
      await this.writeRegistry(registry, lease);
      registry = await this.finishRegistryWrittenOperation(registry, lease);
      return this.snapshotOf(registry);
    });
  }

  /**
   * Import one explicitly journaled legacy profile. It is intentionally separate from `add` so
   * Settings can never supply caller-chosen connection/secret identities.
   */
  async importLegacy(input: ImportLegacyCustomGatewayInput): Promise<CustomGatewayRegistrySnapshot> {
    const displayName = normalizeCustomGatewayDisplayName(input.displayName);
    const endpointBase = requireHttpsCustomEndpoint(input.endpointBase);
    assertCustomGatewayConnectionId(input.connectionId);
    if ((input.secretRef === undefined) !== (input.apiKey === undefined)) {
      throw new Error('Legacy custom gateway import must provide both a secret reference and key, or neither.');
    }
    if (input.secretRef !== undefined) {
      assertCustomGatewaySecretRef(input.secretRef);
      if (!input.secretRef.startsWith(`custom-gateway:${input.connectionId.slice('custom:'.length)}:`)) {
        throw new Error('Legacy custom gateway import secret reference belongs to a different connection.');
      }
    }
    const apiKey = input.apiKey === undefined ? undefined : requireNonEmptyApiKey(input.apiKey);
    return this.lock.runExclusive(async (lease) => {
      let registry = await this.readAndRecover(lease);
      assertExpectedRegistryRevision(registry, input.expectedRegistryRevision);
      const existing = registry.profiles.find((profile) => profile.connectionId === input.connectionId);
      if (existing) {
        if (
          existing.displayName === displayName &&
          existing.endpointBase === endpointBase &&
          existing.secretRef === input.secretRef
        ) {
          return this.snapshotOf(registry);
        }
        throw new Error(`Legacy custom gateway import id "${input.connectionId}" conflicts with an existing profile.`);
      }
      if (registry.tombstones.some((tombstone) => tombstone.connectionId === input.connectionId)) {
        throw new Error(`Legacy custom gateway import id "${input.connectionId}" has been archived.`);
      }
      if (
        input.secretRef
        && enumerateManagedCustomGatewaySecretRefs(registry).includes(input.secretRef)
        && !this.canResumeRetiredLegacySecretRef(registry, input.secretRef)
      ) {
        throw new Error(`Legacy custom gateway import secret reference for "${input.connectionId}" is already managed.`);
      }
      this.assertDisplayNameAvailable(registry, displayName);
      const profile: CustomGatewayProfileV1 = {
        schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
        connectionId: input.connectionId,
        revision: 1,
        state: 'active',
        displayName,
        endpointBase,
        ...(input.secretRef === undefined ? {} : { secretRef: input.secretRef }),
        billingKind: 'custom-account',
      };
      const operation: CustomGatewayOperationV1 = {
        schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
        operationId: this.randomHex(),
        kind: 'add',
        connectionId: input.connectionId,
        expectedRegistryRevision: registry.registryRevision,
        phase: 'prepared',
        ...(input.secretRef === undefined ? {} : { newSecretRef: input.secretRef }),
        nextProfile: profile,
      };
      if (input.secretRef) {
        registry = this.trackGeneratedSecretRef({ ...registry, operation }, input.secretRef);
      } else {
        registry = { ...registry, operation };
      }
      await this.writeRegistry(registry, lease);

      if (input.secretRef && apiKey) {
        await this.storeStagedSecretOrCleanUp(lease, input.secretRef, apiKey);
        registry = { ...registry, operation: { ...operation, phase: 'secret-written' } };
        await this.writeRegistry(registry, lease);
      }
      registry = this.applyOperationTarget(registry, registry.operation!);
      await this.writeRegistry(registry, lease);
      registry = await this.finishRegistryWrittenOperation(registry, lease);
      return this.snapshotOf(registry);
    });
  }

  async update(input: UpdateCustomGatewayInput): Promise<CustomGatewayRegistrySnapshot> {
    if (input.displayName === undefined && input.endpointBase === undefined) {
      throw new Error('Custom gateway update must include a display name or endpoint.');
    }
    return this.lock.runExclusive(async (lease) => {
      let registry = await this.readAndRecover(lease);
      assertExpectedRegistryRevision(registry, input.expectedRegistryRevision);
      const current = findActiveProfile(registry, input.connectionId);
      assertExpectedProfileRevision(current, input.expectedProfileRevision);
      const displayName = input.displayName === undefined ? current.displayName : normalizeCustomGatewayDisplayName(input.displayName);
      if (displayName !== current.displayName) {
        this.assertDisplayNameAvailable(registry, displayName, current.connectionId);
      }
      const endpointBase = input.endpointBase === undefined ? current.endpointBase : requireHttpsCustomEndpoint(input.endpointBase);
      const endpointChanged = endpointBase !== current.endpointBase;
      const next: CustomGatewayProfileV1 = {
        ...current,
        displayName,
        endpointBase,
        revision: endpointChanged ? current.revision + 1 : current.revision,
      };
      registry = replaceProfile(registry, next);
      registry.registryRevision += 1;
      await this.writeRegistry(registry, lease);
      return this.snapshotOf(registry);
    });
  }

  async replaceApiKey(input: ChangeCustomGatewayKeyInput): Promise<CustomGatewayRegistrySnapshot> {
    const apiKey = requireNonEmptyApiKey(input.apiKey);
    return this.lock.runExclusive(async (lease) => {
      let registry = await this.readAndRecover(lease);
      assertExpectedRegistryRevision(registry, input.expectedRegistryRevision);
      const current = findActiveProfile(registry, input.connectionId);
      assertExpectedProfileRevision(current, input.expectedProfileRevision);
      const secretRef = this.createSecretRef(registry, current.connectionId);
      const next: CustomGatewayProfileV1 = { ...current, revision: current.revision + 1, secretRef };
      const operation: CustomGatewayOperationV1 = {
        schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
        operationId: this.randomHex(),
        kind: 'replace-key',
        connectionId: current.connectionId,
        expectedRegistryRevision: registry.registryRevision,
        phase: 'prepared',
        ...(current.secretRef === undefined ? {} : { oldSecretRef: current.secretRef }),
        newSecretRef: secretRef,
        previousProfile: current,
        nextProfile: next,
      };
      registry = this.trackGeneratedSecretRef({ ...registry, operation }, secretRef);
      await this.writeRegistry(registry, lease);

      await this.storeStagedSecretOrCleanUp(lease, secretRef, apiKey, current.connectionId, true);
      registry = { ...registry, operation: { ...operation, phase: 'secret-written' } };
      await this.writeRegistry(registry, lease);

      registry = this.applyOperationTarget(registry, registry.operation!);
      await this.writeRegistry(registry, lease);
      registry = await this.finishRegistryWrittenOperation(registry, lease);
      return this.snapshotOf(registry);
    });
  }

  async clearApiKey(input: ClearCustomGatewayKeyInput): Promise<CustomGatewayRegistrySnapshot> {
    return this.lock.runExclusive(async (lease) => {
      let registry = await this.readAndRecover(lease);
      assertExpectedRegistryRevision(registry, input.expectedRegistryRevision);
      const current = findActiveProfile(registry, input.connectionId);
      assertExpectedProfileRevision(current, input.expectedProfileRevision);
      if (!current.secretRef) {
        throw new Error(`Custom gateway "${current.connectionId}" does not have an API key to clear.`);
      }
      const next: CustomGatewayProfileV1 = { ...current, revision: current.revision + 1 };
      delete next.secretRef;
      const operation: CustomGatewayOperationV1 = {
        schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
        operationId: this.randomHex(),
        kind: 'clear-key',
        connectionId: current.connectionId,
        expectedRegistryRevision: registry.registryRevision,
        phase: 'prepared',
        oldSecretRef: current.secretRef,
        previousProfile: current,
        nextProfile: next,
      };
      registry = { ...registry, operation };
      await this.writeRegistry(registry, lease);
      registry = this.applyOperationTarget(registry, operation);
      await this.writeRegistry(registry, lease);
      registry = await this.finishRegistryWrittenOperation(registry, lease);
      return this.snapshotOf(registry);
    });
  }

  async archive(input: ArchiveCustomGatewayInput): Promise<CustomGatewayRegistrySnapshot> {
    return this.lock.runExclusive(async (lease) => {
      let registry = await this.readAndRecover(lease);
      assertExpectedRegistryRevision(registry, input.expectedRegistryRevision);
      const current = findActiveProfile(registry, input.connectionId);
      assertExpectedProfileRevision(current, input.expectedProfileRevision);
      await input.assertNoKnownReferences();
      await lease.renew();
      const tombstone: CustomGatewayTombstoneV1 = {
        schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
        connectionId: current.connectionId,
        archivedAt: new Date(this.clock()).toISOString(),
        lastDisplayName: current.displayName,
      };
      const operation: CustomGatewayOperationV1 = {
        schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
        operationId: this.randomHex(),
        kind: 'archive',
        connectionId: current.connectionId,
        expectedRegistryRevision: registry.registryRevision,
        phase: 'prepared',
        ...(current.secretRef === undefined ? {} : { oldSecretRef: current.secretRef }),
        previousProfile: current,
        nextTombstone: tombstone,
      };
      registry = { ...registry, operation };
      await this.writeRegistry(registry, lease);
      registry = this.applyOperationTarget(registry, operation);
      await this.writeRegistry(registry, lease);
      registry = await this.finishRegistryWrittenOperation(registry, lease);
      return this.snapshotOf(registry);
    });
  }

  private async readAndRecover(lease: CustomGatewayProfileLease): Promise<CustomGatewayRegistryV1> {
    let registry = await this.readRegistry();
    this.assertRegistryDisplayNamesAvailable(registry);
    if (registry.operation) {
      this.assertOperationTargetDisplayNameAvailable(registry, registry.operation);
      registry = await this.recoverOperation(registry, lease);
    }
    this.assertRegistryDisplayNamesAvailable(registry);
    await this.cleanupUnreferencedManagedSecrets(registry, lease);
    return registry;
  }

  private async readRegistry(): Promise<CustomGatewayRegistryV1> {
    try {
      return parseCustomGatewayRegistry(await fs.readFile(this.registryPath, 'utf8'));
    } catch (error) {
      if (isNotFound(error)) {
        return emptyCustomGatewayRegistry();
      }
      throw error;
    }
  }

  private async writeRegistry(registry: CustomGatewayRegistryV1, lease: CustomGatewayProfileLease): Promise<void> {
    await lease.renew();
    await writeFileAtomically(this.registryPath, serializeCustomGatewayRegistry(registry));
    await lease.assertOwnership();
  }

  /** A lost lease after SecretStorage resolves cannot leave its unique staging generation behind. */
  private async storeStagedSecretOrCleanUp(
    lease: CustomGatewayProfileLease,
    secretRef: string,
    apiKey: string,
    connectionId?: string,
    userInitiated = false,
  ): Promise<void> {
    await lease.renew();
    const storeSecret = () => this.options.secrets.store(secretRef, apiKey);
    if (userInitiated && this.options.storeUserInitiatedProviderKey) {
      await this.options.storeUserInitiatedProviderKey({
        secretName: secretRef,
        value: apiKey,
        connectionId,
        storeSecret,
      });
    } else {
      await storeSecret();
    }
    try {
      await lease.assertOwnership();
    } catch (error) {
      // A successor can only recover this operation by rolling it back while it is still prepared,
      // so no live profile can legitimately reference this staging generation.
      await this.options.secrets.delete(secretRef);
      throw error;
    }
  }

  private async recoverOperation(
    registry: CustomGatewayRegistryV1,
    lease: CustomGatewayProfileLease,
  ): Promise<CustomGatewayRegistryV1> {
    const operation = registry.operation;
    if (!operation) {
      return registry;
    }
    if (operation.phase === 'prepared' && operation.newSecretRef) {
      // The write may have succeeded just before a process crash but before phase advancement. No
      // active profile can reference this generation, so deleting it is an idempotent rollback.
      await lease.renew();
      await this.options.secrets.delete(operation.newSecretRef);
      registry = { ...registry };
      delete registry.operation;
      await this.writeRegistry(registry, lease);
      return registry;
    }
    if (operation.phase === 'prepared') {
      // Clear/archive do not require new user input or a new secret generation, so restart can
      // safely complete their registry switch and continue cleanup.
      registry = this.applyOperationTarget(registry, operation);
      await this.writeRegistry(registry, lease);
      return this.finishRegistryWrittenOperation(registry, lease);
    }
    if (operation.phase === 'secret-written') {
      if (!operation.newSecretRef || !await this.options.secrets.has(operation.newSecretRef)) {
        // The registry still names the previous target in this phase. Roll back rather than leave
        // a pending profile that can never be selected or recovered without lost input.
        registry = { ...registry };
        delete registry.operation;
        await this.writeRegistry(registry, lease);
        return registry;
      }
      registry = this.applyOperationTarget(registry, operation);
      await this.writeRegistry(registry, lease);
      return this.finishRegistryWrittenOperation(registry, lease);
    }
    return this.finishRegistryWrittenOperation(registry, lease);
  }

  private async finishRegistryWrittenOperation(
    registry: CustomGatewayRegistryV1,
    lease: CustomGatewayProfileLease,
  ): Promise<CustomGatewayRegistryV1> {
    const operation = registry.operation;
    if (!operation || (operation.phase !== 'registry-written' && operation.phase !== 'old-secret-cleanup')) {
      throw new Error('Custom gateway operation is not ready for cleanup.');
    }
    if (operation.newSecretRef && !await this.options.secrets.has(operation.newSecretRef)) {
      if (operation.phase === 'registry-written' && await this.canRestorePreviousProfile(operation)) {
        // Cleanup has not begun, so the old generation is still provably available.
        const rolledBack = this.rollbackRegistryWrittenOperation(registry, operation);
        await this.writeRegistry(rolledBack, lease);
        return rolledBack;
      }
      // Once old-secret cleanup begins, a crash may have deleted the old generation. Never restore
      // a profile that points to an unverifiable old key; retain the active route with no key so it
      // is non-runnable and requires an explicit replacement.
      const cleared = this.clearOperationTargetSecret(registry, operation);
      await this.writeRegistry(cleared, lease);
      return cleared;
    }
    if (operation.oldSecretRef && operation.phase === 'registry-written') {
      registry = validateCustomGatewayRegistry({
        ...registry,
        operation: { ...operation, phase: 'old-secret-cleanup' },
      });
      await this.writeRegistry(registry, lease);
    }
    if (registry.operation?.oldSecretRef) {
      await lease.renew();
      await this.options.secrets.delete(registry.operation.oldSecretRef);
    }
    const complete = { ...registry };
    delete complete.operation;
    await this.writeRegistry(complete, lease);
    return complete;
  }

  private rollbackRegistryWrittenOperation(
    registry: CustomGatewayRegistryV1,
    operation: CustomGatewayOperationV1,
  ): CustomGatewayRegistryV1 {
    const profiles = registry.profiles.filter((profile) => profile.connectionId !== operation.connectionId);
    const tombstones = registry.tombstones.filter((tombstone) => tombstone.connectionId !== operation.connectionId);
    if (operation.previousProfile) {
      profiles.push(operation.previousProfile);
    }
    return validateCustomGatewayRegistry({
      schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
      registryRevision: registry.registryRevision + 1,
      profiles,
      tombstones,
      retiredSecretRefs: registry.retiredSecretRefs,
    });
  }

  private async canRestorePreviousProfile(operation: CustomGatewayOperationV1): Promise<boolean> {
    if (!operation.previousProfile?.secretRef) {
      return true;
    }
    return this.options.secrets.has(operation.previousProfile.secretRef);
  }

  private clearOperationTargetSecret(
    registry: CustomGatewayRegistryV1,
    operation: CustomGatewayOperationV1,
  ): CustomGatewayRegistryV1 {
    const profile = registry.profiles.find((item) => item.connectionId === operation.connectionId);
    if (!profile || !profile.secretRef) {
      const complete = { ...registry };
      delete complete.operation;
      return validateCustomGatewayRegistry({
        ...complete,
        registryRevision: registry.registryRevision + 1,
      });
    }
    const cleared: CustomGatewayProfileV1 = { ...profile, revision: profile.revision + 1 };
    delete cleared.secretRef;
    const complete = { ...registry };
    delete complete.operation;
    return validateCustomGatewayRegistry({
      ...complete,
      registryRevision: registry.registryRevision + 1,
      profiles: registry.profiles.map((item) => item.connectionId === cleared.connectionId ? cleared : item),
    });
  }

  /**
   * SecretStorage cannot enumerate arbitrary keys. Every generated ref is retained in the registry
   * history, so this sweep is the only supported orphan cleanup and cannot touch another extension's
   * secrets. Retaining refs after deletion is intentional: a prior writer may finish late after it
   * lost its lease, and the next sweep must still be able to remove that generation.
   */
  private async cleanupUnreferencedManagedSecrets(
    registry: CustomGatewayRegistryV1,
    lease: CustomGatewayProfileLease,
  ): Promise<void> {
    const referenced = new Set<string>();
    for (const profile of registry.profiles) {
      if (profile.secretRef) {
        referenced.add(profile.secretRef);
      }
    }
    if (registry.operation?.oldSecretRef) {
      referenced.add(registry.operation.oldSecretRef);
    }
    if (registry.operation?.newSecretRef) {
      referenced.add(registry.operation.newSecretRef);
    }
    for (const secretRef of registry.retiredSecretRefs) {
      if (!referenced.has(secretRef)) {
        // Best-effort. This sweep runs inside `readAndRecover`, so it is on the path of every `load()` —
        // including activation. A failing SecretStorage delete (or a lease that cannot be renewed) used to
        // reject the whole load, which surfaced as "registry could not be loaded … repair the file" for a
        // registry file that was perfectly valid, and disabled every custom gateway until the user fixed a
        // file that was not broken. Deleting an ORPHANED secret is housekeeping: the ref is referenced by no
        // profile, so nothing can route to it, and it stays in `retiredSecretRefs` to be retried on the next
        // sweep. Mutating callers are unaffected — losing the lease still fails them at their own durable
        // write boundary, which is where that check belongs.
        try {
          await lease.renew();
          await this.options.secrets.delete(secretRef);
        } catch (error) {
          this.options.onOrphanCleanupFailed?.(secretRef, error);
        }
      }
    }
  }

  private applyOperationTarget(
    registry: CustomGatewayRegistryV1,
    operation: CustomGatewayOperationV1,
  ): CustomGatewayRegistryV1 {
    if (operation.nextProfile) {
      const alreadyApplied = registry.profiles.some((profile) => sameProfile(profile, operation.nextProfile!));
      if (alreadyApplied) {
        return cloneCustomGatewayRegistry(registry);
      }
      const profiles = registry.profiles.filter((profile) => profile.connectionId !== operation.connectionId);
      const tombstones = registry.tombstones.filter((tombstone) => tombstone.connectionId !== operation.connectionId);
      return validateCustomGatewayRegistry({
        ...registry,
        registryRevision: registry.registryRevision + 1,
        profiles: [...profiles, operation.nextProfile],
        tombstones,
        operation: { ...operation, phase: 'registry-written' },
      });
    }
    if (operation.nextTombstone) {
      const alreadyApplied = registry.tombstones.some((tombstone) => sameTombstone(tombstone, operation.nextTombstone!));
      if (alreadyApplied) {
        return cloneCustomGatewayRegistry(registry);
      }
      return validateCustomGatewayRegistry({
        ...registry,
        registryRevision: registry.registryRevision + 1,
        profiles: registry.profiles.filter((profile) => profile.connectionId !== operation.connectionId),
        tombstones: [...registry.tombstones.filter((tombstone) => tombstone.connectionId !== operation.connectionId), operation.nextTombstone],
        operation: { ...operation, phase: 'registry-written' },
      });
    }
    throw new Error(`Custom gateway operation "${operation.operationId}" has no target state.`);
  }

  private assertDisplayNameAvailable(
    registry: CustomGatewayRegistryV1,
    displayName: string,
    excludingConnectionId?: string,
  ): void {
    const key = customGatewayDisplayNameKey(displayName);
    if (this.reservedNameKeys.has(key)) {
      throw new Error(`Custom gateway display name "${displayName}" conflicts with a built-in connection.`);
    }
    const conflict = registry.profiles.find((profile) => profile.connectionId !== excludingConnectionId && customGatewayDisplayNameKey(profile.displayName) === key);
    if (conflict) {
      throw new Error(`Custom gateway display name "${displayName}" is already in use.`);
    }
  }

  private createConnectionId(registry: CustomGatewayRegistryV1): CustomGatewayConnectionId {
    const existing = new Set([
      ...registry.profiles.map((profile) => profile.connectionId),
      ...registry.tombstones.map((tombstone) => tombstone.connectionId),
    ]);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = `custom:${this.randomHex()}` as CustomGatewayConnectionId;
      if (!existing.has(id)) {
        return id;
      }
    }
    throw new Error('Unable to generate a unique custom gateway connection id.');
  }

  private createSecretRef(registry: CustomGatewayRegistryV1, connectionId: CustomGatewayConnectionId): string {
    const managed = new Set(enumerateManagedCustomGatewaySecretRefs(registry));
    const connectionOpaqueId = connectionId.slice('custom:'.length);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const ref = `custom-gateway:${connectionOpaqueId}:${this.randomHex()}`;
      if (!managed.has(ref)) {
        return ref;
      }
    }
    throw new Error('Unable to generate a unique custom gateway secret reference.');
  }

  private snapshotOf(registry: CustomGatewayRegistryV1): CustomGatewayRegistrySnapshot {
    const copy = cloneCustomGatewayRegistry(registry);
    return Object.freeze({
      registryRevision: copy.registryRevision,
      profiles: Object.freeze(copy.profiles.map((profile) => Object.freeze({ ...profile }))),
      tombstones: Object.freeze(copy.tombstones.map((tombstone) => Object.freeze({ ...tombstone }))),
      ...(copy.operation === undefined ? {} : { pendingOperation: Object.freeze(copy.operation) }),
    });
  }

  /** Keep generated refs enumerable until the next registry-format migration defines bounded pruning. */
  private trackGeneratedSecretRef(registry: CustomGatewayRegistryV1, secretRef: string): CustomGatewayRegistryV1 {
    return validateCustomGatewayRegistry({
      ...registry,
      retiredSecretRefs: registry.retiredSecretRefs.includes(secretRef)
        ? registry.retiredSecretRefs
        : [...registry.retiredSecretRefs, secretRef],
    });
  }

  /**
   * A crash after a journaled legacy import writes its prepared registry but before it advances
   * to `secret-written` leaves the generated reference retired after recovery. The host-owned
   * migration journal must be able to retry that exact identity. This exception is deliberately
   * limited to importLegacy: add and replace-key generations remain fresh-only.
   */
  private canResumeRetiredLegacySecretRef(registry: CustomGatewayRegistryV1, secretRef: string): boolean {
    return registry.retiredSecretRefs.includes(secretRef)
      && !registry.profiles.some((profile) => profile.secretRef === secretRef)
      && registry.operation?.oldSecretRef !== secretRef
      && registry.operation?.newSecretRef !== secretRef;
  }

  private assertRegistryDisplayNamesAvailable(registry: CustomGatewayRegistryV1): void {
    for (const profile of registry.profiles) {
      if (this.reservedNameKeys.has(customGatewayDisplayNameKey(profile.displayName))) {
        throw new Error(`Custom gateway registry profile "${profile.connectionId}" conflicts with a built-in connection display name.`);
      }
    }
  }

  private assertOperationTargetDisplayNameAvailable(
    registry: CustomGatewayRegistryV1,
    operation: CustomGatewayOperationV1,
  ): void {
    if (!operation.nextProfile) {
      return;
    }
    this.assertDisplayNameAvailable(registry, operation.nextProfile.displayName, operation.connectionId);
  }
}

function findActiveProfile(registry: CustomGatewayRegistryV1, connectionId: CustomGatewayConnectionId): CustomGatewayProfileV1 {
  const profile = registry.profiles.find((item) => item.connectionId === connectionId);
  if (!profile) {
    if (registry.tombstones.some((item) => item.connectionId === connectionId)) {
      throw new Error(`Custom gateway "${connectionId}" has been archived and cannot be modified.`);
    }
    throw new Error(`Custom gateway "${connectionId}" does not exist.`);
  }
  return profile;
}

function replaceProfile(registry: CustomGatewayRegistryV1, next: CustomGatewayProfileV1): CustomGatewayRegistryV1 {
  return validateCustomGatewayRegistry({
    ...registry,
    profiles: registry.profiles.map((profile) => profile.connectionId === next.connectionId ? next : profile),
  });
}

function assertExpectedRegistryRevision(registry: CustomGatewayRegistryV1, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new Error('Expected custom gateway registry revision is invalid.');
  }
  if (registry.registryRevision !== expected) {
    throw new Error(`Custom gateway registry changed from revision ${expected} to ${registry.registryRevision}; refresh and try again.`);
  }
}

function assertExpectedProfileRevision(profile: CustomGatewayProfileV1, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new Error('Expected custom gateway profile revision is invalid.');
  }
  if (profile.revision !== expected) {
    throw new Error(`Custom gateway "${profile.connectionId}" changed from revision ${expected} to ${profile.revision}; refresh and try again.`);
  }
}

function requireNonEmptyApiKey(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Custom gateway API key must not be empty.');
  }
  return value;
}

function sameProfile(left: CustomGatewayProfileV1, right: CustomGatewayProfileV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameTombstone(left: CustomGatewayTombstoneV1, right: CustomGatewayTombstoneV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function randomOpaqueHex(): string {
  return randomBytes(16).toString('hex');
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

function sameLockOwner(left: CustomGatewayLockRecordV1, right: CustomGatewayLockRecordV1): boolean {
  return left.ownerId === right.ownerId
    && left.acquiredAt === right.acquiredAt;
}

/** Fully write and fsync an unpublished file, then hard-link it into existence atomically. */
async function createLockFile(filePath: string, record: CustomGatewayLockRecordV1): Promise<void> {
  const stagedPath = `${filePath}.${record.ownerId}.pending`;
  const handle = await fs.open(stagedPath, 'wx', 0o600);
  try {
    await handle.writeFile(serializeCustomGatewayLock(record), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(stagedPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await removeIfPresent(stagedPath);
  }
}

async function removeLockFileIfOwned(filePath: string, owner: CustomGatewayLockRecordV1): Promise<void> {
  try {
    const current = parseCustomGatewayLock(await fs.readFile(filePath, 'utf8'));
    if (sameLockOwner(current, owner)) {
      await fs.unlink(filePath);
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function isRetryableWindowsRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows commonly rejects opening a directory for fsync. The target file has already been
    // fsynced and atomically renamed, so this is best-effort durability only.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
