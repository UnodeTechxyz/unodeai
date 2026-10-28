import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Workspace: 2 },
  workspace: { getConfiguration: () => ({ get: () => '', update: vi.fn() }), workspaceFolders: [] },
  window: { showInformationMessage: vi.fn(), showWarningMessage: vi.fn() },
}));
vi.mock('./backend/CommandApprovalPrompter', () => ({ promptCommandApproval: vi.fn().mockResolvedValue(false) }));

import { adaptGeneratedConfigToConnection } from './dialogs';
import {
  BUILTIN_CONNECTION_REGISTRY,
  legacyProviderIdForConnectionId,
  routeForConnectionId,
} from './routes/ConnectionRegistry';
import type { AgentConfig } from './types';

function configFor(connectionId: string, allowedTools?: string[]): AgentConfig {
  const profile = BUILTIN_CONNECTION_REGISTRY.connectionProfile(connectionId)!;
  return {
    id: `agent-${connectionId}`,
    name: connectionId,
    role: 'reviewer',
    skill: '',
    provider: { providerId: legacyProviderIdForConnectionId(connectionId, BUILTIN_CONNECTION_REGISTRY)! },
    route: routeForConnectionId(connectionId, profile.catalogModels[0]?.id ?? 'model', BUILTIN_CONNECTION_REGISTRY),
    backend: profile.backendKind,
    model: profile.catalogModels[0]?.id ?? 'model',
    systemPrompt: 'review',
    autoApprove: false,
    ...(allowedTools === undefined ? {} : { allowedTools }),
  };
}

describe('generated route capability adaptation', () => {
  it.each(BUILTIN_CONNECTION_REGISTRY.profiles.map((profile) => profile.id))(
    'preserves an absent tool ceiling for %s',
    (connectionId) => {
      const config = configFor(connectionId);
      adaptGeneratedConfigToConnection({ connectionResolver: BUILTIN_CONNECTION_REGISTRY } as any, config);
      expect(config.allowedTools).toBeUndefined();
      expect(config.toolCeiling).toBe(connectionId === 'codex-cli' ? 'native-default' : undefined);
    },
  );

  it('retains delegate when the selected Codex route can coordinate', () => {
    const config = configFor('codex-cli', ['read', 'write', 'execute', 'delegate']);
    const removed = adaptGeneratedConfigToConnection({ connectionResolver: BUILTIN_CONNECTION_REGISTRY } as any, config);
    expect(config.allowedTools).toEqual(['read', 'write', 'execute', 'delegate']);
    expect(config.toolCeiling).toBe('bounded');
    expect(removed).toEqual([]);
  });
});
