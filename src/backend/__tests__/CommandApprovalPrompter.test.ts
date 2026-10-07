import { beforeEach, describe, expect, it, vi } from 'vitest';

const showInformationMessage = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  window: { showInformationMessage },
}));

import { promptCommandApproval } from '../CommandApprovalPrompter';
import { SAFE_COMMAND_PREFIXES } from '../CommandPolicy';

describe('promptCommandApproval', () => {
  beforeEach(() => showInformationMessage.mockReset());

  it('enables only the supplied project store and never needs a configuration writer', async () => {
    showInformationMessage.mockResolvedValue('Enable Command Execution');
    const projectApprovals = { enableExecution: vi.fn().mockResolvedValue(true) };

    await expect(promptCommandApproval('none', projectApprovals)).resolves.toBe(true);

    expect(projectApprovals.enableExecution).toHaveBeenCalledWith(SAFE_COMMAND_PREFIXES);
  });

  it('does nothing when user-level command policy is already enabled', async () => {
    const projectApprovals = { enableExecution: vi.fn() };
    await expect(promptCommandApproval('ask', projectApprovals)).resolves.toBe(false);
    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(projectApprovals.enableExecution).not.toHaveBeenCalled();
  });
});
