export const UNTRUSTED_WORKSPACE_NOTICE_SUMMARY = 'UnodeAi is read-only in this untrusted workspace.';
export const MANAGE_WORKSPACE_TRUST_COMMAND = 'Workspaces: Manage Workspace Trust';

export interface ActivationWorkspaceTrustNoticeDeps {
  isTrusted(): boolean;
  workspaceFolderCount(): number;
  untrustedWorkspaceDescription(): unknown;
  showWarning(summary: string, detail: string): unknown;
}

/** One activation-scoped notice; granting trust permanently suppresses it for this activation. */
export class ActivationWorkspaceTrustNotice {
  private settled = false;

  constructor(private readonly deps: ActivationWorkspaceTrustNoticeDeps) {}

  showIfNeeded(): boolean {
    if (this.settled || this.deps.isTrusted() || this.deps.workspaceFolderCount() === 0) {
      return false;
    }
    const description = this.deps.untrustedWorkspaceDescription();
    if (typeof description !== 'string' || description.trim() === '') {
      return false;
    }
    this.settled = true;
    this.deps.showWarning(
      UNTRUSTED_WORKSPACE_NOTICE_SUMMARY,
      `${description.trim()}\n\nTo enable these capabilities, run ${MANAGE_WORKSPACE_TRUST_COMMAND}.`,
    );
    return true;
  }

  onDidGrantWorkspaceTrust(): void {
    this.settled = true;
  }
}
