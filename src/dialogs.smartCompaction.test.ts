import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Workspace: 2 },
  workspace: { getConfiguration: () => ({ get: () => '', update: vi.fn() }), workspaceFolders: [] },
  commands: { executeCommand: vi.fn(async () => undefined) },
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
  },
}));
vi.mock('vscode', () => vscodeMock);
vi.mock('./backend/CommandApprovalPrompter', () => ({ promptCommandApproval: vi.fn().mockResolvedValue(false) }));

import { showEditAgentDialog } from './dialogs';
import type { AgentConfig } from './types';

function deps(config: Partial<AgentConfig>) {
  return {
    sessionManager: { get: () => ({ config: { id: 'a1', name: 'Researcher', model: 'm', provider: { providerId: 'openrouter' }, ...config } }) },
    onRosterChanged: vi.fn(),
    output: { info: vi.fn() },
  } as any;
}

beforeEach(() => vi.clearAllMocks());

describe('roster gear Smart compaction row', () => {
  it('shows the saved choice and opens the agent\'s settings on the Smart compaction group', async () => {
    vscodeMock.window.showQuickPick.mockImplementationOnce(async (items: Array<{ key: string; detail: string }>) => {
      const row = items.find((item) => item.key === 'smartCompaction');
      expect(row?.detail).toBe('Current: Custom — 60% or 200,000 tokens');
      return row;
    });
    const d = deps({ smartCompactionMode: 'custom', smartCompactionWindowPercent: 60, smartCompactionCeilingTokens: 200_000 });
    await showEditAgentDialog(d, 'a1');
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith('unode.openAgentBuilder', { agentId: 'a1', focus: 'smart-compaction' });
    // It edits nothing itself: Agent Settings is the one editor.
    expect(d.onRosterChanged).not.toHaveBeenCalled();
  });
});
