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

    // One write holding the reviewed list once per persisted grammar, never an `any` grammar.
    expect(projectApprovals.enableExecution).toHaveBeenCalledTimes(1);
    const keys = projectApprovals.enableExecution.mock.calls[0][0] as Array<{ grammar: string; template: string }>;
    for (const grammar of ['cmd', 'powershell', 'posix']) {
      expect(keys.filter((key) => key.grammar === grammar).map((key) => key.template), grammar).toEqual([...SAFE_COMMAND_PREFIXES]);
    }
    expect(new Set(keys.map((key) => key.grammar))).toEqual(new Set(['cmd', 'powershell', 'posix']));
  });

  it('does nothing when user-level command policy is already enabled', async () => {
    const projectApprovals = { enableExecution: vi.fn() };
    await expect(promptCommandApproval('ask', projectApprovals)).resolves.toBe(false);
    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(projectApprovals.enableExecution).not.toHaveBeenCalled();
  });
});
