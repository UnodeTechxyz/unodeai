import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../types';
import {
  LEGACY_CUSTOM_GATEWAY_MIGRATION_DECLINED_KEY,
  PersistentLegacyCustomMigrationDeclines,
} from '../PersistentLegacyCustomMigrationDeclines';

function legacy(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    name: id,
    role: 'custom',
    skill: 'read',
    provider: { providerId: 'custom', apiKeySecretName: 'CUSTOM_API_KEY' },
    model: 'legacy-model',
    backend: 'openai-compat',
    baseUrl: 'https://gateway.example/v1',
    systemPrompt: 'Repair this member.',
    autoApprove: false,
    allowedTools: ['read'],
    ...overrides,
  };
}

function memoryWorkspaceState() {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined { return values.get(key) as T | undefined; },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) { values.delete(key); } else { values.set(key, value); }
    },
    values,
  };
}

describe('PersistentLegacyCustomMigrationDeclines', () => {
  it('suppresses an unchanged declined roster across activations, reopens when it changes, and never suppresses a confirmed journal', async () => {
    const workspaceState = memoryWorkspaceState();
    const roster = [legacy('a')];

    // Activation 1: the migration modal is shown and the user declines it.
    const activationOne = new PersistentLegacyCustomMigrationDeclines(workspaceState);
    expect(activationOne.shouldSuppressPrompt(false, roster)).toBe(false);
    await activationOne.remember(roster);

    // Activation 2: a fresh tracker sees the persisted decision and does not show the modal/import path.
    const activationTwo = new PersistentLegacyCustomMigrationDeclines(workspaceState);
    expect(activationTwo.shouldSuppressPrompt(false, roster)).toBe(true);

    // Activation 3: changed legacy input is a new decision, so its modal may appear again.
    expect(activationTwo.shouldSuppressPrompt(false, [...roster, legacy('b')])).toBe(false);

    // A confirmed, journaled migration is never hidden by a prior decline.
    expect(activationTwo.shouldSuppressPrompt(true, roster)).toBe(false);
  });

  it('persists only a fixed digest, not the legacy endpoint, secret reference, or key value', async () => {
    const workspaceState = memoryWorkspaceState();
    const declines = new PersistentLegacyCustomMigrationDeclines(workspaceState);
    const keyValue = 'super-secret-value-not-for-workspace-state';
    await declines.remember([legacy('a', {
      baseUrl: 'https://gateway.example/private-path',
      provider: { providerId: 'custom', apiKeySecretName: 'CUSTOM_API_KEY' },
      systemPrompt: keyValue,
    })]);

    const persisted = workspaceState.values.get(LEGACY_CUSTOM_GATEWAY_MIGRATION_DECLINED_KEY);
    expect(persisted).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain('gateway.example');
    expect(JSON.stringify(persisted)).not.toContain('CUSTOM_API_KEY');
    expect(JSON.stringify(persisted)).not.toContain(keyValue);
  });

  it('clears the stale decision after every legacy member is resolved', async () => {
    const workspaceState = memoryWorkspaceState();
    const declines = new PersistentLegacyCustomMigrationDeclines(workspaceState);
    await declines.remember([legacy('a')]);
    await declines.clear();

    expect(workspaceState.values.has(LEGACY_CUSTOM_GATEWAY_MIGRATION_DECLINED_KEY)).toBe(false);
  });
});
