import { describe, expect, it } from 'vitest';
import { isToolAllowedInPlan, planModeRefusal } from '../planMode';

describe('planMode', () => {
  it('allows only read-only built-in inspection tools', () => {
    expect(isToolAllowedInPlan('read_file')).toBe(true);
    expect(isToolAllowedInPlan('list_dir')).toBe(true);
    expect(isToolAllowedInPlan('list_agents')).toBe(true);
  });

  it('denies write, execution, delegation, checks, broadcasts, and MCP tools', () => {
    for (const name of [
      'write_file',
      'run_command',
      'assign_task',
      'broadcast',
      'run_checks',
      'github__create_pr',
      'filesystem__read_file',
      'unknown_tool',
    ]) {
      expect(isToolAllowedInPlan(name)).toBe(false);
    }
  });

  it('builds a clear refusal message', () => {
    expect(planModeRefusal('write_file')).toBe(
      "[Plan mode] 'write_file' is disabled. Switch to Act mode to make changes."
    );
  });
});
