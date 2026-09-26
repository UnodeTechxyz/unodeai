/*
 * Machine-local, non-sensitive contracts for custom OpenAI-compatible gateways.
 *
 * The types in this module intentionally have no field that can hold an API-key value. A key may
 * cross the extension-host input boundary into SecretStorage, but it cannot be serialized in the
 * profile registry, a route, or a webview payload.
 */

import { requireHttpsCustomEndpoint } from '../routes/RouteContracts';

export const CUSTOM_GATEWAY_SCHEMA_VERSION = 1 as const;
export const CUSTOM_GATEWAY_REGISTRY_FILE_NAME = 'custom-gateway-profiles.v1.json';
export const CUSTOM_GATEWAY_LOCK_FILE_NAME = 'custom-gateway-profiles.lock';

export type CustomGatewayConnectionId = `custom:${string}`;
export type CustomGatewayOperationKind = 'add' | 'replace-key' | 'clear-key' | 'archive';
export type CustomGatewayOperationPhase = 'prepared' | 'secret-written' | 'registry-written' | 'old-secret-cleanup';

export interface CustomGatewayProfileV1 {
  schemaVersion: typeof CUSTOM_GATEWAY_SCHEMA_VERSION;
  connectionId: CustomGatewayConnectionId;
  /** Changes only when endpoint, key identity, or lifecycle state changes. */
  revision: number;
  state: 'active';
  /** Presentation only. Never use this to resolve a route, credential, or cache namespace. */
  displayName: string;
  /** Canonical HTTPS base URL without credentials, query, or fragment. */
  endpointBase: string;
  /** Opaque SecretStorage key name. This is never an API-key value. */
  secretRef?: string;
  billingKind: 'custom-account';
}

export interface CustomGatewayTombstoneV1 {
  schemaVersion: typeof CUSTOM_GATEWAY_SCHEMA_VERSION;
  connectionId: CustomGatewayConnectionId;
  archivedAt: string;
  lastDisplayName: string;
}

/**
 * A durable write-ahead record for changes that cross the registry/SecretStorage boundary.
 * `nextProfile` and `previousProfile` contain only non-sensitive profile data and let restart
 * recovery finish or roll back without attempting to re-prompt for a key.
 */
export interface CustomGatewayOperationV1 {
  schemaVersion: typeof CUSTOM_GATEWAY_SCHEMA_VERSION;
  operationId: string;
  kind: CustomGatewayOperationKind;
  connectionId: CustomGatewayConnectionId;
  expectedRegistryRevision: number;
  phase: CustomGatewayOperationPhase;
  oldSecretRef?: string;
  newSecretRef?: string;
  previousProfile?: CustomGatewayProfileV1;
  nextProfile?: CustomGatewayProfileV1;
  nextTombstone?: CustomGatewayTombstoneV1;
}

export interface CustomGatewayRegistryV1 {
  schemaVersion: typeof CUSTOM_GATEWAY_SCHEMA_VERSION;
  registryRevision: number;
  profiles: CustomGatewayProfileV1[];
  tombstones: CustomGatewayTombstoneV1[];
  /** Never reused. Retained so a late SecretStorage write remains enumerable for cleanup. */
  retiredSecretRefs: string[];
  operation?: CustomGatewayOperationV1;
}

export interface CustomGatewayRegistrySnapshot {
  registryRevision: number;
  profiles: readonly CustomGatewayProfileV1[];
  tombstones: readonly CustomGatewayTombstoneV1[];
  pendingOperation?: CustomGatewayOperationV1;
}

export interface CustomGatewayLockRecordV1 {
  schemaVersion: typeof CUSTOM_GATEWAY_SCHEMA_VERSION;
  ownerId: string;
  acquiredAt: number;
  leaseExpiresAt: number;
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const CONNECTION_ID = /^custom:[a-f0-9]{32}$/;
const SECRET_REF = /^custom-gateway:[a-f0-9]{32}:[a-f0-9]{32}$/;
const OPAQUE_ID = /^[a-f0-9]{32}$/;

/** Normalize the user-visible name without making it an identity. */
export function normalizeCustomGatewayDisplayName(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('Custom gateway display name must be a string.');
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 80) {
    throw new Error('Custom gateway display name must contain 1 to 80 characters after trimming.');
  }
  if (CONTROL_CHARACTER.test(normalized)) {
    throw new Error('Custom gateway display name must not contain control characters.');
  }
  return normalized;
}

/** Deterministic comparison key only; the original display name remains presentation data. */
export function customGatewayDisplayNameKey(value: string): string {
  // JavaScript has no full Unicode case-folding primitive. Uppercase then lowercase handles the
  // important multi-code-point and contextual folds (for example Straße/STRASSE and final sigma)
  // after NFKC compatibility normalization, without ever turning this presentation key into an id.
  return normalizeCustomGatewayDisplayName(value).normalize('NFKC').toUpperCase().toLowerCase().normalize('NFC');
}

export function assertCustomGatewayConnectionId(value: unknown): asserts value is CustomGatewayConnectionId {
  if (typeof value !== 'string' || !CONNECTION_ID.test(value)) {
    throw new Error('Custom gateway connection id must be a host-generated custom:<opaque-id> value.');
  }
}

export function assertCustomGatewaySecretRef(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SECRET_REF.test(value)) {
    throw new Error('Custom gateway secret reference is invalid.');
  }
}

export function assertCustomGatewayOpaqueId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new Error('Custom gateway opaque id is invalid.');
  }
}

function assertSecretRefBelongsToConnection(connectionId: CustomGatewayConnectionId, secretRef: string): void {
  const connectionOpaqueId = connectionId.slice('custom:'.length);
  if (!secretRef.startsWith(`custom-gateway:${connectionOpaqueId}:`)) {
    throw new Error('Custom gateway secret reference belongs to a different connection.');
  }
}

export function validateCustomGatewayProfile(value: unknown): CustomGatewayProfileV1 {
  assertPlainObject(value, 'Custom gateway profile');
  assertExactKeys(value, [
    'schemaVersion', 'connectionId', 'revision', 'state', 'displayName', 'endpointBase', 'secretRef', 'billingKind',
  ], 'Custom gateway profile');
  if (value.schemaVersion !== CUSTOM_GATEWAY_SCHEMA_VERSION) {
    throw new Error('Custom gateway profile schema version is not supported.');
  }
  assertCustomGatewayConnectionId(value.connectionId);
  assertPositiveInteger(value.revision, 'Custom gateway profile revision');
  if (value.state !== 'active') {
    throw new Error('Custom gateway profile state is invalid.');
  }
  const displayName = normalizeCustomGatewayDisplayName(value.displayName as string);
  if (value.billingKind !== 'custom-account') {
    throw new Error('Custom gateway profile billing kind is invalid.');
  }
  const endpointBase = requireHttpsCustomEndpoint(assertString(value.endpointBase, 'Custom gateway endpoint base'));
  const secretRef = value.secretRef;
  if (secretRef !== undefined) {
    assertCustomGatewaySecretRef(secretRef);
    assertSecretRefBelongsToConnection(value.connectionId, secretRef);
  }
  return {
    schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
    connectionId: value.connectionId,
    revision: value.revision,
    state: 'active',
    displayName,
    endpointBase,
    ...(secretRef === undefined ? {} : { secretRef }),
    billingKind: 'custom-account',
  };
}

export function validateCustomGatewayTombstone(value: unknown): CustomGatewayTombstoneV1 {
  assertPlainObject(value, 'Custom gateway tombstone');
  assertExactKeys(value, ['schemaVersion', 'connectionId', 'archivedAt', 'lastDisplayName'], 'Custom gateway tombstone');
  if (value.schemaVersion !== CUSTOM_GATEWAY_SCHEMA_VERSION) {
    throw new Error('Custom gateway tombstone schema version is not supported.');
  }
  assertCustomGatewayConnectionId(value.connectionId);
  const archivedAt = assertString(value.archivedAt, 'Custom gateway tombstone archivedAt');
  if (!Number.isFinite(Date.parse(archivedAt))) {
    throw new Error('Custom gateway tombstone archivedAt is invalid.');
  }
  return {
    schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
    connectionId: value.connectionId,
    archivedAt,
    lastDisplayName: normalizeCustomGatewayDisplayName(value.lastDisplayName as string),
  };
}

export function validateCustomGatewayOperation(value: unknown): CustomGatewayOperationV1 {
  assertPlainObject(value, 'Custom gateway operation');
  assertExactKeys(value, [
    'schemaVersion', 'operationId', 'kind', 'connectionId', 'expectedRegistryRevision', 'phase',
    'oldSecretRef', 'newSecretRef', 'previousProfile', 'nextProfile', 'nextTombstone',
  ], 'Custom gateway operation');
  if (value.schemaVersion !== CUSTOM_GATEWAY_SCHEMA_VERSION) {
    throw new Error('Custom gateway operation schema version is not supported.');
  }
  const operationId = assertString(value.operationId, 'Custom gateway operation id');
  assertCustomGatewayOpaqueId(operationId);
  if (value.kind !== 'add' && value.kind !== 'replace-key' && value.kind !== 'clear-key' && value.kind !== 'archive') {
    throw new Error('Custom gateway operation kind is invalid.');
  }
  assertCustomGatewayConnectionId(value.connectionId);
  assertNonNegativeInteger(value.expectedRegistryRevision, 'Custom gateway expected registry revision');
  if (value.phase !== 'prepared' && value.phase !== 'secret-written' && value.phase !== 'registry-written' && value.phase !== 'old-secret-cleanup') {
    throw new Error('Custom gateway operation phase is invalid.');
  }
  if (value.oldSecretRef !== undefined) {
    assertCustomGatewaySecretRef(value.oldSecretRef);
    assertSecretRefBelongsToConnection(value.connectionId, value.oldSecretRef);
  }
  if (value.newSecretRef !== undefined) {
    assertCustomGatewaySecretRef(value.newSecretRef);
    assertSecretRefBelongsToConnection(value.connectionId, value.newSecretRef);
  }
  const previousProfile = value.previousProfile === undefined ? undefined : validateCustomGatewayProfile(value.previousProfile);
  const nextProfile = value.nextProfile === undefined ? undefined : validateCustomGatewayProfile(value.nextProfile);
  const nextTombstone = value.nextTombstone === undefined ? undefined : validateCustomGatewayTombstone(value.nextTombstone);
  validateOperationShape({
    schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
    operationId,
    kind: value.kind,
    connectionId: value.connectionId,
    expectedRegistryRevision: value.expectedRegistryRevision,
    phase: value.phase,
    ...(value.oldSecretRef === undefined ? {} : { oldSecretRef: value.oldSecretRef }),
    ...(value.newSecretRef === undefined ? {} : { newSecretRef: value.newSecretRef }),
    ...(previousProfile === undefined ? {} : { previousProfile }),
    ...(nextProfile === undefined ? {} : { nextProfile }),
    ...(nextTombstone === undefined ? {} : { nextTombstone }),
  });
  return {
    schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
    operationId,
    kind: value.kind,
    connectionId: value.connectionId,
    expectedRegistryRevision: value.expectedRegistryRevision,
    phase: value.phase,
    ...(value.oldSecretRef === undefined ? {} : { oldSecretRef: value.oldSecretRef }),
    ...(value.newSecretRef === undefined ? {} : { newSecretRef: value.newSecretRef }),
    ...(previousProfile === undefined ? {} : { previousProfile }),
    ...(nextProfile === undefined ? {} : { nextProfile }),
    ...(nextTombstone === undefined ? {} : { nextTombstone }),
  };
}

export function validateCustomGatewayRegistry(value: unknown): CustomGatewayRegistryV1 {
  assertPlainObject(value, 'Custom gateway registry');
  assertExactKeys(value, ['schemaVersion', 'registryRevision', 'profiles', 'tombstones', 'retiredSecretRefs', 'operation'], 'Custom gateway registry');
  if (value.schemaVersion !== CUSTOM_GATEWAY_SCHEMA_VERSION) {
    throw new Error('Custom gateway registry schema version is not supported.');
  }
  assertNonNegativeInteger(value.registryRevision, 'Custom gateway registry revision');
  if (!Array.isArray(value.profiles) || !Array.isArray(value.tombstones) || !Array.isArray(value.retiredSecretRefs)) {
    throw new Error('Custom gateway registry profiles, tombstones, and retired secret references must be arrays.');
  }
  const profiles = value.profiles.map(validateCustomGatewayProfile);
  const tombstones = value.tombstones.map(validateCustomGatewayTombstone);
  const retiredSecretRefs = value.retiredSecretRefs.map((ref) => {
    assertCustomGatewaySecretRef(ref);
    return ref;
  });
  if (new Set(retiredSecretRefs).size !== retiredSecretRefs.length) {
    throw new Error('Custom gateway registry contains duplicate retired secret references.');
  }
  const operation = value.operation === undefined ? undefined : validateCustomGatewayOperation(value.operation);
  assertRegistryUniqueness(profiles, tombstones);
  const registry: CustomGatewayRegistryV1 = {
    schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
    registryRevision: value.registryRevision,
    profiles: sortProfiles(profiles),
    tombstones: sortTombstones(tombstones),
    retiredSecretRefs: [...retiredSecretRefs].sort(),
    ...(operation === undefined ? {} : { operation }),
  };
  assertOperationMatchesRegistry(registry);
  return registry;
}

/** Serializer projects through strict validators so key values are structurally unrepresentable. */
export function serializeCustomGatewayRegistry(registry: CustomGatewayRegistryV1): string {
  const valid = validateCustomGatewayRegistry(registry);
  return `${JSON.stringify(valid, null, 2)}\n`;
}

export function parseCustomGatewayRegistry(content: string): CustomGatewayRegistryV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Custom gateway registry is not valid JSON.');
  }
  return validateCustomGatewayRegistry(parsed);
}

export function emptyCustomGatewayRegistry(): CustomGatewayRegistryV1 {
  return {
    schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
    registryRevision: 0,
    profiles: [],
    tombstones: [],
    retiredSecretRefs: [],
  };
}

export function serializeCustomGatewayLock(record: CustomGatewayLockRecordV1): string {
  validateCustomGatewayLock(record);
  return `${JSON.stringify(record)}\n`;
}

export function parseCustomGatewayLock(content: string): CustomGatewayLockRecordV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Custom gateway lock is not valid JSON.');
  }
  return validateCustomGatewayLock(parsed);
}

export function validateCustomGatewayLock(value: unknown): CustomGatewayLockRecordV1 {
  assertPlainObject(value, 'Custom gateway lock');
  assertExactKeys(value, ['schemaVersion', 'ownerId', 'acquiredAt', 'leaseExpiresAt'], 'Custom gateway lock');
  if (value.schemaVersion !== CUSTOM_GATEWAY_SCHEMA_VERSION) {
    throw new Error('Custom gateway lock schema version is not supported.');
  }
  const ownerId = assertString(value.ownerId, 'Custom gateway lock owner id');
  assertCustomGatewayOpaqueId(ownerId);
  assertNonNegativeInteger(value.acquiredAt, 'Custom gateway lock acquiredAt');
  assertNonNegativeInteger(value.leaseExpiresAt, 'Custom gateway lock leaseExpiresAt');
  if (value.leaseExpiresAt <= value.acquiredAt) {
    throw new Error('Custom gateway lock lease must expire after acquisition.');
  }
  return {
    schemaVersion: CUSTOM_GATEWAY_SCHEMA_VERSION,
    ownerId,
    acquiredAt: value.acquiredAt,
    leaseExpiresAt: value.leaseExpiresAt,
  };
}

/** All refs are registry-owned or durable-operation-owned and are therefore recoverable. */
export function enumerateManagedCustomGatewaySecretRefs(registry: CustomGatewayRegistryV1): readonly string[] {
  const valid = validateCustomGatewayRegistry(registry);
  const refs = new Set<string>();
  for (const profile of valid.profiles) {
    if (profile.secretRef) {
      refs.add(profile.secretRef);
    }
  }
  for (const ref of valid.retiredSecretRefs) {
    refs.add(ref);
  }
  if (valid.operation?.oldSecretRef) {
    refs.add(valid.operation.oldSecretRef);
  }
  if (valid.operation?.newSecretRef) {
    refs.add(valid.operation.newSecretRef);
  }
  return [...refs].sort();
}

export function cloneCustomGatewayRegistry(registry: CustomGatewayRegistryV1): CustomGatewayRegistryV1 {
  return validateCustomGatewayRegistry(JSON.parse(JSON.stringify(registry)));
}

function validateOperationShape(operation: CustomGatewayOperationV1): void {
  const previousMatches = operation.previousProfile?.connectionId === operation.connectionId;
  const nextProfileMatches = operation.nextProfile?.connectionId === operation.connectionId;
  const nextTombstoneMatches = operation.nextTombstone?.connectionId === operation.connectionId;
  if (!previousMatches && operation.previousProfile !== undefined) {
    throw new Error('Custom gateway operation previous profile has a different connection id.');
  }
  if (!nextProfileMatches && operation.nextProfile !== undefined) {
    throw new Error('Custom gateway operation next profile has a different connection id.');
  }
  if (!nextTombstoneMatches && operation.nextTombstone !== undefined) {
    throw new Error('Custom gateway operation tombstone has a different connection id.');
  }
  if (operation.kind === 'add') {
    if (operation.oldSecretRef || !operation.nextProfile || operation.previousProfile || operation.nextTombstone) {
      throw new Error('Custom gateway add operation shape is invalid.');
    }
    if (operation.nextProfile.secretRef !== operation.newSecretRef) {
      throw new Error('Custom gateway add operation must stage the next profile secret reference.');
    }
    if (operation.nextProfile.revision !== 1) {
      throw new Error('Custom gateway add operation must create profile revision 1.');
    }
    if (operation.phase === 'old-secret-cleanup') {
      throw new Error('Custom gateway add does not have an old-secret-cleanup phase.');
    }
    if (operation.phase === 'secret-written' && !operation.newSecretRef) {
      throw new Error('Custom gateway add secret-written phase requires a staged secret reference.');
    }
    return;
  }
  if (operation.kind === 'replace-key') {
    if (!operation.newSecretRef || !operation.previousProfile || !operation.nextProfile || operation.nextTombstone) {
      throw new Error('Custom gateway key replacement operation shape is invalid.');
    }
    if (operation.nextProfile.secretRef !== operation.newSecretRef) {
      throw new Error('Custom gateway key replacement must switch to the new secret reference.');
    }
    if (operation.oldSecretRef !== operation.previousProfile.secretRef) {
      throw new Error('Custom gateway key replacement old secret reference is invalid.');
    }
    if (operation.oldSecretRef === operation.newSecretRef) {
      throw new Error('Custom gateway key replacement must use a fresh secret generation.');
    }
    assertOnlySecretIdentityChanged(operation.previousProfile, operation.nextProfile);
    if (operation.phase === 'secret-written' && !operation.newSecretRef) {
      throw new Error('Custom gateway key replacement secret-written phase requires a staged secret reference.');
    }
    return;
  }
  if (operation.kind === 'clear-key') {
    if (!operation.oldSecretRef || !operation.previousProfile || !operation.nextProfile || operation.newSecretRef || operation.nextTombstone) {
      throw new Error('Custom gateway key clear operation shape is invalid.');
    }
    if (operation.previousProfile.secretRef !== operation.oldSecretRef || operation.nextProfile.secretRef !== undefined) {
      throw new Error('Custom gateway key clear references are invalid.');
    }
    assertOnlySecretIdentityChanged(operation.previousProfile, operation.nextProfile);
    if (operation.phase === 'secret-written') {
      throw new Error('Custom gateway key clear does not have a secret-written phase.');
    }
    return;
  }
  if (!operation.previousProfile || operation.newSecretRef || operation.nextProfile || !operation.nextTombstone) {
    throw new Error('Custom gateway archive operation shape is invalid.');
  }
  if (operation.oldSecretRef !== operation.previousProfile.secretRef) {
    throw new Error('Custom gateway archive old secret reference is invalid.');
  }
  if (operation.phase === 'secret-written') {
    throw new Error('Custom gateway archive does not have a secret-written phase.');
  }
}

function assertRegistryUniqueness(
  profiles: readonly CustomGatewayProfileV1[],
  tombstones: readonly CustomGatewayTombstoneV1[],
): void {
  const ids = new Set<string>();
  const tombstoneIds = new Set<string>();
  const names = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.connectionId)) {
      throw new Error(`Custom gateway registry contains duplicate connection id "${profile.connectionId}".`);
    }
    ids.add(profile.connectionId);
    const nameKey = customGatewayDisplayNameKey(profile.displayName);
    if (names.has(nameKey)) {
      throw new Error(`Custom gateway registry contains duplicate display name "${profile.displayName}".`);
    }
    names.add(nameKey);
  }
  for (const tombstone of tombstones) {
    if (ids.has(tombstone.connectionId)) {
      throw new Error(`Custom gateway registry contains an active profile and tombstone for "${tombstone.connectionId}".`);
    }
    if (tombstoneIds.has(tombstone.connectionId)) {
      throw new Error(`Custom gateway registry contains duplicate tombstone id "${tombstone.connectionId}".`);
    }
    tombstoneIds.add(tombstone.connectionId);
    ids.add(tombstone.connectionId);
  }
}

function assertOnlySecretIdentityChanged(previous: CustomGatewayProfileV1, next: CustomGatewayProfileV1): void {
  if (next.revision !== previous.revision + 1) {
    throw new Error('Custom gateway key operation must increment the profile revision exactly once.');
  }
  if (next.displayName !== previous.displayName || next.endpointBase !== previous.endpointBase) {
    throw new Error('Custom gateway key operation must not change display name or endpoint.');
  }
}

/** A durable operation phase must exactly match the persisted target state it describes. */
function assertOperationMatchesRegistry(registry: CustomGatewayRegistryV1): void {
  const operation = registry.operation;
  if (!operation) {
    return;
  }
  const active = registry.profiles.find((profile) => profile.connectionId === operation.connectionId);
  const tombstone = registry.tombstones.find((item) => item.connectionId === operation.connectionId);
  if (operation.phase === 'registry-written' || operation.phase === 'old-secret-cleanup') {
    if (registry.registryRevision !== operation.expectedRegistryRevision + 1) {
      throw new Error('Custom gateway registry-written operation has an unexpected registry revision.');
    }
    if (operation.nextProfile && JSON.stringify(active) !== JSON.stringify(operation.nextProfile)) {
      throw new Error('Custom gateway registry-written operation profile target is not present.');
    }
    if (operation.nextTombstone && JSON.stringify(tombstone) !== JSON.stringify(operation.nextTombstone)) {
      throw new Error('Custom gateway registry-written operation tombstone target is not present.');
    }
    return;
  }
  if (registry.registryRevision !== operation.expectedRegistryRevision) {
    throw new Error('Pending custom gateway operation has an unexpected registry revision.');
  }
  if (operation.kind === 'add') {
    if (active || tombstone) {
      throw new Error('Pending custom gateway add operation already changed the registry target.');
    }
    return;
  }
  if (JSON.stringify(active) !== JSON.stringify(operation.previousProfile) || tombstone) {
    throw new Error('Pending custom gateway operation does not match its previous profile state.');
  }
}

function sortProfiles(profiles: readonly CustomGatewayProfileV1[]): CustomGatewayProfileV1[] {
  return [...profiles].sort((left, right) => {
    const byName = customGatewayDisplayNameKey(left.displayName).localeCompare(customGatewayDisplayNameKey(right.displayName), 'und');
    return byName || left.connectionId.localeCompare(right.connectionId, 'en');
  });
}

function sortTombstones(tombstones: readonly CustomGatewayTombstoneV1[]): CustomGatewayTombstoneV1[] {
  return [...tombstones].sort((left, right) => left.connectionId.localeCompare(right.connectionId, 'en'));
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${label} contains unsupported field "${key}".`);
    }
  }
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}
