import { describe, expect, it } from 'vitest';
import {
  normalizeCodexPermissionProfile,
  acceptedCodexFullAccessChoice,
  resolveCodexPermissionProfile,
} from '../CodexPermissionProfile';
import {
  assertSafeCodexSpawnArgs,
  buildCodexAppServerArgs,
  codexProtocolPermissionSettings,
} from '../CodexSpawnArgs';

describe('Codex permission profiles', () => {
  it('defaults missing and malformed stored values downward to Ask for approval', () => {
    expect(normalizeCodexPermissionProfile(undefined)).toBe('ask-for-approval');
    expect(normalizeCodexPermissionProfile('future-superuser')).toBe('ask-for-approval');
  });

  it('treats Cancel, Escape and close as preserving the previous profile', () => {
    expect(acceptedCodexFullAccessChoice('Cancel')).toBe(false);
    expect(acceptedCodexFullAccessChoice(undefined)).toBe(false);
    expect(acceptedCodexFullAccessChoice('Enable full access')).toBe(true);
  });

  it('never gives an agent limited by Folder Access an unsandboxed process', () => {
    // Claude review: Full access has no sandbox, so it cannot honour a folder grant. Before this, an agent
    // granted read-write on one folder resolved to danger-full-access and could write anywhere.
    const granted = { mode: 'act' as const, trusted: true, restricted: true, writeRoots: ['C:/repo/src'], allowedTools: [] };
    const full = resolveCodexPermissionProfile({ ...granted, configured: 'full-access' });
    expect(full.effective).toBe('ask-for-approval');
    expect(full.capReason).toMatch(/Folder Access/);
    // The workspace-write profiles do honour the grant through writableRoots, so they are kept.
    expect(resolveCodexPermissionProfile({ ...granted, configured: 'approve-for-me' }).effective).toBe('approve-for-me');
    expect(resolveCodexPermissionProfile({ ...granted, configured: 'ask-for-approval' }).effective).toBe('ask-for-approval');
    // Without explicit grants, Full access is still available.
    expect(resolveCodexPermissionProfile({ ...granted, restricted: false, configured: 'full-access' }).effective).toBe('full-access');
  });

  it('refuses the unsafe sandbox in any spelling unless the profile is Full access', () => {
    const base = buildCodexAppServerArgs(undefined, 'ask-for-approval');
    for (const smuggled of [
      ['--sandbox', 'danger-full-access'],
      ['-s', 'danger-full-access'],
      ['-c', "sandbox_mode='danger-full-access'"],
      ['-c', 'sandbox_mode=danger-full-access'],
    ]) {
      expect(() => assertSafeCodexSpawnArgs([...base, ...smuggled], 'ask-for-approval')).toThrow(/permission profile/);
      expect(() => assertSafeCodexSpawnArgs([...base, ...smuggled], 'approve-for-me')).toThrow(/permission profile/);
    }
    expect(() => buildCodexAppServerArgs(undefined, 'full-access')).not.toThrow();
  });

  it('forces Plan and every host ceiling to Read only', () => {
    const base = { configured: 'full-access', mode: 'act' as const, trusted: true, writeRoots: ['C:/repo'], allowedTools: ['write'] };
    expect(resolveCodexPermissionProfile({ ...base, mode: 'plan' }).effective).toBe('read-only');
    expect(resolveCodexPermissionProfile({ ...base, trusted: false }).effective).toBe('read-only');
    expect(resolveCodexPermissionProfile({ ...base, writeRoots: [] }).effective).toBe('read-only');
    expect(resolveCodexPermissionProfile({ ...base, allowedTools: ['read'] }).effective).toBe('read-only');
  });

  it('maps the three Act choices to Codex native settings', () => {
    expect(codexProtocolPermissionSettings('ask-for-approval')).toMatchObject({
      sandboxMode: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', networkAccess: false,
    });
    expect(codexProtocolPermissionSettings('approve-for-me')).toMatchObject({
      sandboxMode: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', networkAccess: false,
    });
    expect(codexProtocolPermissionSettings('full-access')).toMatchObject({
      sandboxMode: 'danger-full-access', approvalPolicy: 'never', networkAccess: true,
    });
  });

  it('allows the unsandboxed argv only for the resolved Full access profile', () => {
    const full = buildCodexAppServerArgs(undefined, 'full-access');
    expect(full).toContain('sandbox_mode="danger-full-access"');
    expect(() => assertSafeCodexSpawnArgs(full, 'ask-for-approval')).toThrow(/does not match/i);
    expect(() => assertSafeCodexSpawnArgs(full, 'approve-for-me')).toThrow(/does not match/i);
    expect(() => assertSafeCodexSpawnArgs(full, 'read-only')).toThrow(/does not match/i);
    expect(() => assertSafeCodexSpawnArgs(full, 'full-access')).not.toThrow();
    expect(() => assertSafeCodexSpawnArgs(['--dangerously-bypass-approvals-and-sandbox'], 'full-access')).toThrow(/unsafe/i);
  });
});
