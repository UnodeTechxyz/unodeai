import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_READ_SCOPE_GRANT_ACTION,
  localReadRootsForScope,
  localReadScopeGuidance,
  offerLocalReadScopeRecovery,
  SessionLocalReadScopeConsent,
  type LocalReadScopePrompt,
} from '../localReadScope';
import {
  AttentionSignal, blockingPrompt, installAttentionSignal, localReadAttentionKey, untimedPrompt,
} from '../../views/attentionSignal';

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

  it('gives each agent that waits on the one prompt its own wait, and none to a root already decided', async () => {
    let answer: (allowed: boolean) => void = () => {};
    const consent = new SessionLocalReadScopeConsent(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const root = path.dirname(workspace);
    const waits: string[] = [];
    const waitingFor = (agent: string) => async <T>(wait: () => PromiseLike<T>): Promise<T> => {
      waits.push(`${agent} waits`);
      try {
        return await wait();
      } finally {
        waits.push(`${agent} done`);
      }
    };

    consent.beginUserRequest();
    const pm = consent.ensure(root, waitingFor('pm'));
    const dev = consent.ensure(root, waitingFor('dev'));
    await Promise.resolve();
    await Promise.resolve();
    // One prompt is open and both agents are waiting on it.
    expect(waits).toEqual(['pm waits', 'dev waits']);
    answer(true);
    await expect(Promise.all([pm, dev])).resolves.toEqual([true, true]);
    expect(waits.slice().sort()).toEqual(['dev done', 'dev waits', 'pm done', 'pm waits']);

    // The root is granted: nobody waits for a person now, so no clock is paused.
    waits.length = 0;
    await expect(consent.ensure(root, waitingFor('qa'))).resolves.toBe(true);
    expect(waits).toEqual([]);
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

// v0.9.88 §5.11: the prompt learns which appearance it is, so the attention sound keys on root + epoch.
describe('local read scope attention appearances', () => {
  const root = path.join(path.parse(process.cwd()).root, 'work');

  it('sounds once for agents coalescing in one request and again when the next request asks after a decline', async () => {
    const played: string[] = [];
    installAttentionSignal(new AttentionSignal({ enabled: () => true, play: (id) => { played.push(id); return 'sidebar'; }, log: () => {} }));
    try {
      const prompts: LocalReadScopePrompt[] = [];
      const consent = new SessionLocalReadScopeConsent((absoluteRoot, prompt) => {
        prompts.push(prompt);
        return Promise.resolve(blockingPrompt(
          prompt.userInitiated ? undefined : localReadAttentionKey(absoluteRoot, prompt.epoch),
          () => Promise.resolve(false),
          untimedPrompt('each waiting agent times its own wait'),
        ));
      });
      consent.beginUserRequest();
      await Promise.all([consent.ensure(root), consent.ensure(root), consent.ensure(root)]);
      await consent.ensure(root);
      expect(prompts).toEqual([{ epoch: 1, userInitiated: false }]);
      expect(played).toHaveLength(1);

      consent.beginUserRequest();
      await consent.ensure(root);
      expect(prompts.at(-1)).toEqual({ epoch: 2, userInitiated: false });
      expect(played).toHaveLength(2);

      // A grant the user asks for from the recovery notice or the Security panel is a dialog they opened.
      await consent.requestGrant(root);
      expect(prompts.at(-1)).toEqual({ epoch: 2, userInitiated: true });
      expect(played).toHaveLength(2);
    } finally {
      installAttentionSignal(undefined);
    }
  });
});

describe('localReadScopeGuidance (v0.9.89 field fix)', () => {
  const root = path.resolve('/work/projects/app');

  it('names nothing for the workspace scope or an untrusted workspace', () => {
    expect(localReadScopeGuidance('workspace', root, true)).toBe('');
    expect(localReadScopeGuidance('parent', root, false)).toBe('');
    expect(localReadScopeGuidance('parent', undefined, true)).toBe('');
  });

  it('names the canonical parent or volume root and says it is not a grant', () => {
    const parent = localReadScopeGuidance('parent', root, true);
    expect(parent).toContain(path.dirname(root));
    expect(parent).toMatch(/not granted yet/);
    expect(parent).toMatch(/Writes, deletes and shell commands stay confined/);
    const volume = localReadScopeGuidance('volume', root, true);
    expect(volume).toContain(path.parse(root).root);
    expect(volume).toMatch(/whole volume/);
  });
});
