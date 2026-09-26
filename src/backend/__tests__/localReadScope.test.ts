import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_READ_SCOPE_GRANT_ACTION,
  localReadRootsForScope,
  offerLocalReadScopeRecovery,
  SessionLocalReadScopeConsent,
} from '../localReadScope';

describe('localReadRootsForScope', () => {
  const workspace = path.join(path.parse(process.cwd()).root, 'work', 'unode');

  it('keeps the workspace-only boundary when selected or unknown', () => {
    expect(localReadRootsForScope('workspace', workspace, true)).toEqual([]);
    expect(localReadRootsForScope(undefined, workspace, true)).toEqual([]);
  });

  it('adds only the immediate parent for sibling-project discovery', () => {
    expect(localReadRootsForScope('parent', workspace, true)).toEqual([path.dirname(workspace)]);
  });

  it('adds the current filesystem volume only after Workspace Trust', () => {
    expect(localReadRootsForScope('volume', workspace, true)).toEqual([path.parse(workspace).root]);
    expect(localReadRootsForScope('parent', workspace, false)).toEqual([]);
    expect(localReadRootsForScope('volume', workspace, false)).toEqual([]);
  });

  it('coalesces concurrent decisions, latches a decline for the request, and re-asks on a new user request', async () => {
    const requests: string[] = [];
    const consent = new SessionLocalReadScopeConsent(async (root) => {
      requests.push(root);
      return requests.length > 1;
    });
    const root = path.dirname(workspace);

    consent.beginUserRequest();
    await expect(Promise.all([consent.ensure(root), consent.ensure(root)])).resolves.toEqual([false, false]);
    await expect(consent.ensure(root)).resolves.toBe(false);
    consent.beginUserRequest();
    await expect(consent.ensure(root)).resolves.toBe(true);
    await expect(consent.ensure(root)).resolves.toBe(true);
    expect(requests).toEqual([root, root]);
    expect(consent.list()).toEqual([{ absoluteRoot: root, status: 'granted' }]);
  });

  it('fails closed without recording a decision or re-spamming a failed dialog in the same request', async () => {
    let attempts = 0;
    const consent = new SessionLocalReadScopeConsent(async () => {
      attempts++;
      throw new Error('window unavailable');
    });

    consent.beginUserRequest();
    await expect(consent.ensure(workspace)).resolves.toBe(false);
    await expect(consent.ensure(workspace)).resolves.toBe(false);
    expect(attempts).toBe(1);
    expect(consent.list()).toEqual([]);
    consent.beginUserRequest();
    await expect(consent.ensure(workspace)).resolves.toBe(false);
    expect(attempts).toBe(2);
    expect(consent.list()).toEqual([]);
  });

  it('shows one modal and one recovery notice per root across a coordinator and its delegates', async () => {
    let prompts = 0;
    let notices = 0;
    const consent = new SessionLocalReadScopeConsent(
      async () => { prompts++; return false; },
      () => { notices++; },
    );

    consent.beginUserRequest();
    // Coordinator, delegate one, and delegate two all share the current top-level user-request epoch.
    await expect(consent.ensure(workspace)).resolves.toBe(false);
    await expect(consent.ensure(workspace)).resolves.toBe(false);
    await expect(consent.ensure(workspace)).resolves.toBe(false);
    expect({ prompts, notices }).toEqual({ prompts: 1, notices: 1 });

    consent.beginUserRequest();
    await expect(consent.ensure(workspace)).resolves.toBe(false);
    expect({ prompts, notices }).toEqual({ prompts: 2, notices: 2 });
  });

  it('binds the recovery action to the declined root and grants it for the session', async () => {
    const requests: string[] = [];
    let recovery: { root: string; grant: () => Promise<boolean> } | undefined;
    const consent = new SessionLocalReadScopeConsent(
      async (root) => {
        requests.push(root);
        return requests.length > 1;
      },
      (root, grant) => { recovery = { root, grant }; },
    );
    const root = path.dirname(workspace);

    consent.beginUserRequest();
    await expect(consent.ensure(root)).resolves.toBe(false);
    expect(recovery).toBeDefined();
    expect(recovery!.root).toBe(root);
    await expect(recovery!.grant()).resolves.toBe(true);
    await expect(consent.ensure(root)).resolves.toBe(true);
    expect(requests).toEqual([root, root]);
  });

  it('offers the named recovery action for the refused root and runs only that bound grant', async () => {
    const root = path.dirname(workspace);
    const notices: Array<{ message: string; action: string }> = [];
    let grants = 0;

    await expect(offerLocalReadScopeRecovery(
      root,
      async () => { grants++; return true; },
      async (message, action) => {
        notices.push({ message, action });
        return action;
      },
    )).resolves.toBe(true);

    expect(notices).toEqual([{ message: expect.stringContaining(root), action: LOCAL_READ_SCOPE_GRANT_ACTION }]);
    expect(grants).toBe(1);
  });

  it('revokes a grant before the next call and permits a later user request to re-ask', async () => {
    const decisions = [true, false];
    let attempts = 0;
    const consent = new SessionLocalReadScopeConsent(async () => {
      attempts++;
      return decisions.shift() ?? false;
    });

    consent.beginUserRequest();
    await expect(consent.ensure(workspace)).resolves.toBe(true);
    await expect(consent.ensure(workspace)).resolves.toBe(true);
    expect(attempts).toBe(1);
    expect(consent.revoke(workspace)).toBe(true);
    await expect(consent.ensure(workspace)).resolves.toBe(false);
    expect(attempts).toBe(1);
    consent.beginUserRequest();
    await expect(consent.ensure(workspace)).resolves.toBe(false);
    expect(attempts).toBe(2);
    expect(consent.list()).toEqual([{ absoluteRoot: path.resolve(workspace), status: 'declined' }]);
  });
});
