import { describe, expect, it, vi } from 'vitest';
import manifest from '../package.json';
import {
  ActivationWorkspaceTrustNotice,
  MANAGE_WORKSPACE_TRUST_COMMAND,
  UNTRUSTED_WORKSPACE_NOTICE_SUMMARY,
} from './workspaceTrustNotice';

function fixture(options: { trusted?: boolean; folders?: number } = {}) {
  let trusted = options.trusted ?? false;
  const showWarning = vi.fn();
  const notice = new ActivationWorkspaceTrustNotice({
    isTrusted: () => trusted,
    workspaceFolderCount: () => options.folders ?? 1,
    untrustedWorkspaceDescription: () => manifest.capabilities.untrustedWorkspaces.description,
    showWarning,
  });
  return { notice, showWarning, grantTrust: () => { trusted = true; notice.onDidGrantWorkspaceTrust(); } };
}

describe('untrusted workspace activation notice', () => {
  it('shows exactly once in an untrusted window with a folder', () => {
    const { notice, showWarning } = fixture();

    expect(notice.showIfNeeded()).toBe(true);
    expect(notice.showIfNeeded()).toBe(false);
    expect(showWarning).toHaveBeenCalledTimes(1);
    expect(showWarning).toHaveBeenCalledWith(
      UNTRUSTED_WORKSPACE_NOTICE_SUMMARY,
      expect.stringContaining(manifest.capabilities.untrustedWorkspaces.description),
    );
    expect(showWarning.mock.calls[0][1]).toContain(MANAGE_WORKSPACE_TRUST_COMMAND);
  });

  it('never shows in a trusted window', () => {
    const { notice, showWarning } = fixture({ trusted: true });

    expect(notice.showIfNeeded()).toBe(false);
    expect(showWarning).not.toHaveBeenCalled();
  });

  it('never shows in a folderless window', () => {
    const { notice, showWarning } = fixture({ folders: 0 });

    expect(notice.showIfNeeded()).toBe(false);
    expect(showWarning).not.toHaveBeenCalled();
  });

  it('never shows after workspace trust is granted', () => {
    const { notice, showWarning, grantTrust } = fixture({ folders: 1 });

    grantTrust();
    expect(notice.showIfNeeded()).toBe(false);
    expect(showWarning).not.toHaveBeenCalled();
  });
});
