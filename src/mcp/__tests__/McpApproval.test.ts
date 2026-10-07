import { describe, it, expect } from 'vitest';
import { approvalKey, needsApproval, autoMountable } from '../McpApproval';
import { MCPServerConfig } from '../../types';

const fs: MCPServerConfig = { id: 'fs', name: 'Filesystem', transport: 'stdio', requiresApproval: true };
const gh: MCPServerConfig = { id: 'gh', name: 'GitHub', transport: 'stdio', requiresApproval: true };
const play: MCPServerConfig = { id: 'play', name: 'Playwright', transport: 'stdio', requiresApproval: false };
const workspace = 'C:\\repo';

describe('MCP approval gate (P1#4)', () => {
  it('requires approval for a sensitive server that is not yet approved', () => {
    expect(needsApproval(fs, new Set(), workspace)).toBe(true);
  });

  it('does not require approval once the server is approved', () => {
    expect(needsApproval(fs, new Set([approvalKey(fs, workspace)]), workspace)).toBe(false);
  });

  // Security: a stdio (subprocess) server ALWAYS needs approval — requiresApproval:false must NOT bypass it,
  // so a mutable/hosted catalog entry can't silently mount a subprocess or swap its command.
  it('always requires approval for a stdio server, even with requiresApproval:false', () => {
    expect(needsApproval({ ...play, requiresApproval: undefined }, new Set(), workspace)).toBe(true);
    expect(needsApproval(play, new Set(), workspace)).toBe(true); // false does NOT bypass a subprocess
    // …and once explicitly approved, it auto-mounts.
    expect(needsApproval(play, new Set([approvalKey(play, workspace)]), workspace)).toBe(false);
  });

  it('autoMountable returns only servers already approved (sensitive ones are never auto-mounted)', () => {
    const mountable = autoMountable([fs, gh, play], new Set([approvalKey(gh, workspace)]), workspace);
    expect(mountable.map((s) => s.id).sort()).toEqual(['gh']); // only the approved one; fs + play still gated
  });

  it('invalidates approval when the launch spec changes', () => {
    const approved = new Set([approvalKey(fs, workspace)]);
    expect(needsApproval({ ...fs, args: ['.'] }, approved, workspace)).toBe(true);
  });
});
