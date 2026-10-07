import { CHAT_HISTORY_LIMIT } from '../chatHistory';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('vscode', () => ({}));

import { ChatAgent, ChatViewDeps, ChatViewProvider, attachmentMetadata, delegatingCountsFrom, delegatingOutFrom, delegationRenderKey, capToolPayload, readFilePathFromActivity, splitTruncatedDetail } from '../ChatViewProvider';
import { SessionPresentationModel } from '../sessionPresentation';
import { renderMarkdown } from '../markdown';
import { WEBVIEW_STREAM_PACING_SOURCE } from '../streamPacing';
import { malformedWebviewMessages, overlongWebviewIdentityMessages } from './support/chatWebviewProtocolMessages';
import { TurnOutcomeAccumulator } from '../../session/turnOutcomeReceipt';
import { chatToolsKey } from '../chatToolHistory';

const agent: ChatAgent = {
  id: 'agent-1',
  name: 'Dev',
  role: 'Developer',
  backend: 'openai',
};

it('keeps task.partial in the production chat terminal filter', () => {
  const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
  expect(source).toContain(
    "msg.type === 'task.complete' || msg.type === 'task.partial' || msg.type === 'system.error'",
  );
});

function depsFor(agents: ChatAgent[] = [agent]): ChatViewDeps {
  const store = new Map<string, unknown>();
  return {
    listAgents: () => agents,
    send: vi.fn(),
    interject: vi.fn(),
    interrupt: vi.fn(),
    onReply: () => vi.fn(),
    state: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
  } as ChatViewDeps;
}

function providerWith(deps = depsFor()): ChatViewProvider {
  const provider = new ChatViewProvider({} as never, deps);
  provider.selectAgent(agent.id);
  return provider;
}

function emittedFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`webview must emit ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`webview emitted an unclosed ${name}`);
}

/** Runs the exact RAF pacing source injected into the production webview. */
function webviewLiveDeliveryHarness() {
  const painted: unknown[][] = [];
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  let now = 0;
  const replaceLiveBlocks = (root: { blocks?: unknown[] }, replaceFrom: number, blocks: unknown[]) => {
    root.blocks = (root.blocks || []).slice(0, replaceFrom).concat(blocks);
    painted.push(root.blocks);
  };
  const requestAnimationFrame = (callback: () => void) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (id: number) => { frames.delete(id); };
  const fn = new Function(
    'replaceLiveBlocks',
    'smoothStreamingOn',
    'nowMs',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    `${WEBVIEW_STREAM_PACING_SOURCE}
return { applyPacedLiveBlocks };`,
  );
  const { applyPacedLiveBlocks } = fn(
    replaceLiveBlocks,
    () => true,
    () => now,
    requestAnimationFrame,
    cancelAnimationFrame,
  ) as {
    applyPacedLiveBlocks: (root: { blocks?: unknown[]; isConnected: boolean }, message: Record<string, unknown>) => void;
  };
  return {
    applyPacedLiveBlocks,
    painted,
    pendingFrames: () => frames.size,
    drainAnimationFrames: () => {
      for (let safety = 0; frames.size && safety < 32; safety++) {
        const callbacks = [...frames.values()];
        frames.clear();
        now += 16;
        callbacks.forEach((callback) => callback());
      }
      expect(frames.size, 'the real RAF delivery must settle within the pacing budget').toBe(0);
    },
  };
}

describe('attachment persistence boundary', () => {
  it('keeps a local PDF filename and metadata out of durable chat history', () => {
    expect(attachmentMetadata([{
      name: 'confidential-local-report.pdf',
      mime: 'application/pdf',
      kind: 'pdf',
      dataBase64: 'JVBERi0=',
      size: 5,
    }])).toBeUndefined();
  });
});

describe('ChatViewProvider webview boundary', () => {
  it('drops every malformed command before it can dispatch and records the rejection', () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);

    const rejected = [...Object.values(malformedWebviewMessages), ...overlongWebviewIdentityMessages.map(([, message]) => message)];
    for (const message of rejected) {
      sidebar.fireMessage(message);
    }

    expect(provider.rejectedWebviewMessageCount()).toBe(rejected.length);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.interrupt).not.toHaveBeenCalled();
    expect(deps.setApproval).not.toHaveBeenCalled();
  });
});

describe('the approval bar states live authority', () => {
  it('re-syncs the Codex permission control when the host refuses a change', () => {
    // A refused change used to return without posting state, so the control kept the refused choice.
    const deps = depsFor();
    const setCodexPermissionProfile = vi.fn();
    deps.setCodexPermissionProfile = setCodexPermissionProfile;
    deps.listAgents = () => [{ ...agent, backend: 'codex', codexPermissionCapReason: 'Workspace Trust limits this agent to read only.' }] as never;
    const provider = providerWith(deps);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    sidebar.view.webview.postMessage.mockClear();

    sidebar.fireMessage({ command: 'setCodexPermissionProfile', agentId: agent.id, profile: 'full-access' });

    expect(setCodexPermissionProfile).not.toHaveBeenCalled();
    const states = sidebar.view.webview.postMessage.mock.calls.filter(([message]) => (message as { command?: string }).command === 'state');
    expect(states.length).toBeGreaterThan(0);
  });

  it('lets the hidden attribute actually hide a control', () => {
    // Field, round 4 step 10: a Codex agent showed Commands, Writes AND Permissions at once. The bar
    // sets `hidden` on the controls it does not want, but `.approval-bar label { display: flex }` is an
    // author rule, and an author display beats the user-agent rule for [hidden].
    const provider = providerWith();
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    const html = sidebar.view.webview.html as string;

    expect(html).toContain('id="commandApprovalControl"');
    expect(html).toContain('id="writeApprovalControl"');
    expect(html).toContain('id="codexPermissionControl"');
    expect(html).toMatch(/\.approval-bar label\[hidden\]\s*\{[^}]*display:\s*none/);
  });


  it('echoes state only after the asynchronous setting write lands, so the first change sticks', async () => {
    // Field report (v0.9.84 round 3, step 10): changing Commands did nothing the first time and worked on
    // the second try. The setting write round-trips through VS Code configuration; echoing state before it
    // resolved sent the OLD value back and the <select> snapped to it.
    let approvals = { command: 'ask' as string, write: 'none' as string };
    let releaseWrite: (() => void) | undefined;
    const deps = depsFor();
    deps.getApprovals = () => approvals as never;
    deps.setApproval = vi.fn((kind: string, value: string) => new Promise<void>((resolve) => {
      releaseWrite = () => {
        approvals = kind === 'write' ? { ...approvals, write: value } : { ...approvals, command: value };
        resolve();
      };
    })) as never;

    const provider = providerWith(deps);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    sidebar.view.webview.postMessage.mockClear();

    sidebar.fireMessage({ command: 'setApproval', kind: 'command', value: 'allowlist' });
    await Promise.resolve();

    const posted = () => sidebar.view.webview.postMessage.mock.calls
      .map(([message]) => message as { command?: string; state?: { approvals?: { command?: string } } })
      .filter((message) => message?.command === 'state' && message.state?.approvals);
    expect(posted().some((message) => message.state?.approvals?.command === 'ask')).toBe(false);

    releaseWrite?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posted().at(-1)?.state?.approvals?.command).toBe('allowlist');
  });
});

describe('critical chat delivery under the real batchers', () => {
  it('keeps every critical fact ordered through the host frame coalescer and the webview RAF', () => {
    vi.useFakeTimers();
    try {
      const provider = providerWith();
      const sidebar = webviewViewForTest();
      provider.resolveWebviewView(sidebar.view as never);
      sidebar.view.webview.postMessage.mockClear();

      const criticalFacts = ['consent', 'approval', 'cancellation', 'evidence', 'error', 'final-answer'];
      const streamed = criticalFacts.map((fact) => `[${fact}]`).join('\n\n');
      // These are separate host arrivals. scheduleLiveMarkdownFrame is the production coalescer that
      // must turn them into exactly one liveBlocks delivery, never six independent deliveries.
      for (const chunk of [streamed.slice(0, 13), streamed.slice(13, 37), streamed.slice(37)]) {
        provider.appendDelta(agent.id, chunk);
      }

      expect(sidebar.view.webview.postMessage.mock.calls
        .map(([message]: [any]) => message)
        .filter((message: any) => message.command === 'liveBlocks')).toHaveLength(0);

      vi.advanceTimersByTime(16);
      const hostFrames = sidebar.view.webview.postMessage.mock.calls
        .map(([message]: [any]) => message)
        .filter((message: any) => message.command === 'liveBlocks');
      expect(hostFrames).toHaveLength(1);

      const webview = webviewLiveDeliveryHarness();
      const root: { blocks?: unknown[]; isConnected: boolean } = { isConnected: true };
      for (const frame of hostFrames) {
        webview.applyPacedLiveBlocks(root, frame);
      }
      expect(webview.pendingFrames()).toBeGreaterThan(0);
      webview.drainAnimationFrames();

      const delivered = JSON.stringify(root.blocks);
      let previous = -1;
      for (const fact of criticalFacts) {
        const next = delivered.indexOf(`[${fact}]`);
        expect(next, `${fact} was lost by real batched delivery`).toBeGreaterThan(previous);
        previous = next;
      }
      expect(webview.painted.length, 'the assertion must exercise animation frames, not an immediate paint').toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function textNode(): { node: { textContent: string }; values: string[] } {
  const values: string[] = [];
  let current = '';
  return {
    node: {
      get textContent() { return current; },
      set textContent(value: string) {
        current = value;
        values.push(value);
      },
    },
    values,
  };
}

function webviewViewForTest() {
  const disposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  let disposeListener: (() => void) | undefined;
  let messageListener: ((message: unknown) => void) | undefined;
  const listen = (listener?: () => void, _thisArg?: unknown, bucket?: Array<{ dispose: ReturnType<typeof vi.fn> }>) => {
    const disposable = { dispose: vi.fn() };
    disposables.push(disposable);
    bucket?.push(disposable);
    return disposable;
  };
  return {
    disposables,
    fireDispose: () => disposeListener?.(),
    fireMessage: (message: unknown) => messageListener?.(message),
    view: {
      visible: true,
      webview: {
        cspSource: 'test:',
        html: '',
        options: {},
        postMessage: vi.fn(),
        onDidReceiveMessage: vi.fn((listener: (message: unknown) => void, _thisArg?: unknown, bucket?: Array<{ dispose: ReturnType<typeof vi.fn> }>) => {
          messageListener = listener;
          return listen(listener, _thisArg, bucket);
        }),
      },
      onDidChangeVisibility: vi.fn(listen),
      onDidDispose: vi.fn((listener: () => void, _thisArg?: unknown, bucket?: Array<{ dispose: ReturnType<typeof vi.fn> }>) => {
        disposeListener = listener;
        return listen(undefined, _thisArg, bucket);
      }),
      show: vi.fn(),
    },
  };
}

function webviewPanelForTest() {
  const disposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  let disposeListener: (() => void) | undefined;
  let visibilityListener: (() => void) | undefined;
  let messageListener: ((message: unknown) => void) | undefined;
  const listen = (listener?: () => void, _thisArg?: unknown, bucket?: Array<{ dispose: ReturnType<typeof vi.fn> }>) => {
    const disposable = { dispose: vi.fn() };
    disposables.push(disposable);
    bucket?.push(disposable);
    return disposable;
  };
  const panel: any = {
    visible: true,
    viewColumn: 1,
    webview: {
      cspSource: 'test:',
      html: '',
      options: {},
      postMessage: vi.fn(),
      onDidReceiveMessage: vi.fn((listener: (message: unknown) => void, _thisArg?: unknown, bucket?: Array<{ dispose: ReturnType<typeof vi.fn> }>) => {
        messageListener = listener;
        return listen(listener, _thisArg, bucket);
      }),
    },
    reveal: vi.fn(),
    onDidChangeViewState: vi.fn((listener: () => void, _thisArg?: unknown, bucket?: Array<{ dispose: ReturnType<typeof vi.fn> }>) => {
      visibilityListener = listener;
      return listen(undefined, _thisArg, bucket);
    }),
    onDidDispose: vi.fn((listener: () => void, _thisArg?: unknown, bucket?: Array<{ dispose: ReturnType<typeof vi.fn> }>) => {
      disposeListener = listener;
      return listen(undefined, _thisArg, bucket);
    }),
  };
  panel.dispose = vi.fn(() => disposeListener?.());
  return {
    panel,
    disposables,
    fireDispose: () => disposeListener?.(),
    fireVisibility: () => visibilityListener?.(),
    fireMessage: (message: unknown) => messageListener?.(message),
  };
}

describe('ChatViewProvider interject UI', () => {
  it('renders a visible opt-in action when a reviewed safe command is awaiting approval', () => {
    const provider = providerWith();
    const html = (provider as any).getHtml({ cspSource: 'test:' }, 'sidebar');

    expect(html).toContain('req.safeCommandOffer');
    expect(html).toContain("label: 'Enable safe commands'");
  });

  it('names the persistent command choice as project-scoped and shows its saved pattern in the card', () => {
    const provider = providerWith();
    const html = (provider as any).getHtml({ cspSource: 'test:' }, 'sidebar');

    expect(html).toContain("{ action: 'project', label: 'Allow for project'");
    expect(html).toContain('Allow for project will save this pattern:');
    expect(html).not.toContain("'Allow for \"' + req.template");
  });

  it('inserts an editor selection into the selected agent’s composer without sending a turn', () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    const workbench = webviewPanelForTest();
    provider.restoreWorkbench(workbench.panel as never);

    expect(provider.insertIntoSelectedComposer('Selected code block')).toBe(true);
    expect(deps.send).not.toHaveBeenCalled();
    expect(workbench.panel.reveal).toHaveBeenCalled();
    const stateMessages = workbench.panel.webview.postMessage.mock.calls
      .map(([message]: [any]) => message)
      .filter((message: any) => message.command === 'state');
    expect(stateMessages.at(-1).state.composerInsertion).toMatchObject({
      agentId: agent.id,
      text: 'Selected code block',
      revision: 1,
    });

    const html = (provider as any).getHtml({ cspSource: 'test:' }, 'workbench');
    expect(html).toContain('function applyComposerInsertion(insertion)');
    expect(html).toContain("vscode.postMessage({ command: 'composerInsertionApplied', revision });");
  });

  it('does not create a Workbench or an action target when no team exists', () => {
    const provider = new ChatViewProvider({} as never, depsFor([]));
    expect(provider.insertIntoSelectedComposer('Selected code block')).toBe(false);
  });

  it('uses the host-owned presentation state when a second surface attaches', () => {
    const presentation = new SessionPresentationModel();
    const deps = { ...depsFor(), presentation } as ChatViewDeps;
    const sidebar = providerWith(deps);

    (sidebar as any).append(agent.id, { role: 'user', text: 'Shared session state', ts: new Date().toISOString() });

    // This is the seam UX2 consumes: a new UI surface sees the same selection and
    // transcript without copying sidebar-owned state or sending a backend turn.
    const workbenchSurface = new ChatViewProvider({} as never, deps);
    const state = (workbenchSurface as any).currentState();
    expect(state.selectedAgentId).toBe(agent.id);
    expect(state.messages).toMatchObject([{ text: 'Shared session state' }]);
  });

  it('disposes old sidebar listeners before resolve and after view disposal', () => {
    const provider = providerWith();
    const first = webviewViewForTest();
    const second = webviewViewForTest();

    provider.resolveWebviewView(first.view as never);
    expect(first.disposables).toHaveLength(3);

    provider.resolveWebviewView(second.view as never);
    expect(first.disposables.every((disposable) => disposable.dispose.mock.calls.length === 1)).toBe(true);
    expect(provider.canPromptApproval()).toBe(true);

    second.fireDispose();
    expect(second.disposables.every((disposable) => disposable.dispose.mock.calls.length === 1)).toBe(true);
    expect(provider.canPromptApproval()).toBe(false);
  });

  // UX7 row 5: "Closing a UI surface does not stop or duplicate a backend run unless the user explicitly
  // cancels." The listener-hygiene test above proves we do not leak subscriptions; it says nothing about
  // the agent. This one holds the claim that actually matters to a user who closes a tab while a crew is
  // working — a surface is a window onto the run, never its owner.
  it('closing a surface never stops or restarts the backend run behind it', () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    const sidebar = webviewViewForTest();
    const workbench = webviewPanelForTest();
    provider.resolveWebviewView(sidebar.view as never);
    provider.restoreWorkbench(workbench.panel as never);

    // Close the Workbench, then the sidebar — the user now has no UnodeAi surface open at all.
    provider.closeWorkbench();
    sidebar.fireDispose();

    // Nothing was cancelled on the user's behalf, and nothing was re-sent to compensate.
    expect(deps.interrupt).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    // With no surface attached the provider stops offering to host a decision, so the caller falls back
    // to a native prompt rather than the run deadlocking on a webview nobody can see.
    expect(provider.canPromptApproval()).toBe(false);
  });

  it('uses one renderer for sidebar and Workbench, broadcasting only to visible containers', () => {
    const provider = providerWith();
    const sidebar = webviewViewForTest();
    const workbench = webviewPanelForTest();
    provider.resolveWebviewView(sidebar.view as never);
    provider.restoreWorkbench(workbench.panel as never);

    expect(sidebar.view.webview.html).toContain('container-sidebar');
    expect(workbench.panel.webview.html).toContain('container-workbench');
    expect(workbench.panel.webview.html).toContain('function renderTranscript()');

    provider.refresh();
    expect(sidebar.view.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(workbench.panel.webview.postMessage).toHaveBeenCalledTimes(1);

    workbench.panel.visible = false;
    provider.refresh();
    expect(sidebar.view.webview.postMessage).toHaveBeenCalledTimes(2);
    expect(workbench.panel.webview.postMessage).toHaveBeenCalledTimes(1);

    // A moved/hidden editor tab receives a full shared-state refresh when it becomes visible again.
    workbench.panel.visible = true;
    workbench.fireVisibility();
    expect(workbench.panel.webview.postMessage).toHaveBeenCalledTimes(2);

    // Closing only the sidebar cannot make an inline approval fall back to a native modal while the
    // Workbench remains alive; the host queue and transcript stay shared.
    sidebar.fireDispose();
    expect(provider.canPromptApproval()).toBe(true);
  });

  it('does not replace the active editor for an agent-initiated approval and restores shared state', () => {
    const provider = providerWith();
    const first = webviewPanelForTest();
    (provider as any).append(agent.id, { role: 'user', text: 'Do not duplicate this turn', ts: new Date().toISOString() });
    provider.restoreWorkbench(first.panel as never);

    void provider.requestApproval({ kind: 'command', agentName: 'Dev', command: 'npm test' });
    expect(first.panel.reveal).not.toHaveBeenCalled();

    first.fireDispose();
    const restored = webviewPanelForTest();
    provider.restoreWorkbench(restored.panel as never);
    const state = (provider as any).currentState();
    expect(state.messages).toMatchObject([{ text: 'Do not duplicate this turn' }]);
    expect((provider as any).deps.send).not.toHaveBeenCalled();
  });

  it('floats the composer out of the flex column, with nothing in flow left under it', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' }, 'workbench');

    // Everything from the attachment status down to the approval bar lives INSIDE the dock. Anything
    // left in normal flow after a fixed dock would be rendered underneath it and become unreachable.
    const dock = html.slice(html.indexOf('<div class="composer-dock"'), html.indexOf('<aside class="inspector"'));
    for (const inside of ['id="attachmentStatus"', 'id="attachmentChips"', 'id="composer"', 'id="steerHint"', 'class="approval-bar"']) {
      expect(dock, `${inside} must be inside the dock`).toContain(inside);
    }

    // The dock is out of flow. The transcript uses its full height: a floating composer must not leave
    // a permanent empty band below every conversation.
    expect(html).toContain('body.container-workbench .composer-dock');
    expect(html).toContain('position: fixed');
    expect(html).not.toContain('padding-bottom: var(--composer-dock-h');

    // The newest line must clear the floating composer, and WHICH element carries the trailing space is
    // the whole point. On the body it is a fixed dead strip nothing can scroll into — that was the
    // original defect, and it is why the card appeared to float over solid black. On #transcript, which
    // owns overflow-y, the same space is scrollable: history still slides through the region behind the
    // card, and at rest the last line sits above it. Assert the selector, not just the property.
    expect(html).toContain('body.container-workbench #transcript { padding-bottom: calc(var(--composer-dock-h, 0px) + 8px); }');

    expect(html).toContain('body.container-workbench #approvals:not([hidden]) {\n      margin-bottom: calc(var(--composer-dock-h, 0px) + 16px);\n    }');
    expect(html).toContain('.composer { display: grid; gap: 6px; }');
    expect(dock).toContain('<div class="composer-actions">');
    // One context reading per view (Owner, 2026-10-02). The Workbench's is at the end of the session bar, before
    // the menu. The sidebar is narrow and has no session bar: its reading stays in the row of controls, beside
    // Compact. A row of its own above the message box was tried and taken back the same day, because that row
    // cost the transcript height and vanished altogether in a short Chat section.
    const sessionBar = (page: string) => page.slice(page.indexOf('<div class="session-summary"'), page.indexOf('<details class="plan"'));
    expect(dock).not.toContain('id="ctxMeter"');
    expect(sessionBar(html).indexOf('id="ctxMeter"')).toBeGreaterThan(sessionBar(html).indexOf('class="session-actions-row"'));
    expect(sessionBar(html).indexOf('id="ctxMeter"')).toBeLessThan(sessionBar(html).indexOf('id="sessionMenuTrigger"'));
    // Field run, 2026-10-02: the facts on the left stood a few pixels above the meter on the right. The bar is a
    // grid whose right cell centres its text around the menu button; the row has to be centred as a whole.
    expect(html).toMatch(/body.container-workbench .session-summary {[^}]*align-items: center;/);
    const sidebar = (providerWith() as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string;
    expect(sessionBar(sidebar)).not.toContain('id="ctxMeter"');
    const aboveInput = sidebar.slice(sidebar.indexOf('<div class="composer-shell">'), sidebar.indexOf('<div class="approval-bar">'));
    expect(aboveInput).not.toContain('id="ctxMeter"');
    const controls = sidebar.slice(sidebar.indexOf('<div class="composer-actions">'));
    expect(controls.indexOf('id="ctxMeter"')).toBeGreaterThan(0);
    expect(controls.indexOf('id="ctxMeter"')).toBeLessThan(controls.indexOf('id="ctxCompact"'));
    expect(sidebar.split('id="ctxMeter"')).toHaveLength(2);
    expect(html.split('id="ctxMeter"')).toHaveLength(2);
    expect(dock).toContain('aria-label="Attach image, text file, or PDF"');
    expect(dock).toContain('aria-label="Agent permissions">⚙</span>');

    // ONE control row (Owner, 2026-08-02): Insert/Send/Stop moved into the auto-approve row. Three rows
    // of chrome under the input is what pushed Stop off the edge of a ~300px sidebar behind a horizontal
    // scrollbar. Assert the STRUCTURE — buttons inside the approval row — not a CSS value.
    const approvalRow = dock.slice(dock.indexOf('class="approval-bar"'));
    expect(approvalRow).not.toContain('id="ctxMeter"');
    expect(approvalRow).toContain('id="ctxCompact"');
    expect(approvalRow, 'the action buttons share the auto-approve row').toContain('<div class="composer-actions">');
    expect(approvalRow).toContain('id="cmdApproval"');
    expect(approvalRow).toContain('id="writeApproval"');
    expect(approvalRow).toContain('id="codexPermissionControl" hidden');
    expect(approvalRow).toContain('id="codexPermissions"');
    expect(approvalRow).toContain('Ask for approval');
    expect(approvalRow).toContain('Approve for me');
    expect(approvalRow).toContain('Full access (unsafe)');
    expect(approvalRow).toContain('Full access: unsandboxed, network on, no prompts or checkpoints');
    expect(approvalRow.indexOf('id="cmdApproval"')).toBeLessThan(approvalRow.indexOf('id="send"'));

    // The sentence is no longer painted, but it must still be REACHABLE: it is the only place that says
    // a message steers a running agent rather than queueing behind it, and no glyph says that. Clipped,
    // not deleted — deleting it would trade a layout complaint for an accessibility regression.
    expect(dock, 'the steering sentence stays in the DOM for assistive tech').toContain('id="steerHint"');
    expect(html).toContain('clip: rect(0 0 0 0)');

    // Wordless buttons: the arrow ships in the markup and the word ships in the accessible name.
    expect(approvalRow).toContain('aria-label="Send"');
    expect(approvalRow).toContain('aria-label="Stop the running agent"');

    // The "Commands"/"Writes" words are hidden below 620px so the row keeps to one line. Each select
    // therefore needs its OWN accessible name — the label text used to supply it, and hiding text that
    // is doing double duty is how a control silently becomes unlabelled for a screen reader at exactly
    // the width where it is hardest to use. The current VALUE is never hidden; only the word is.
    expect(approvalRow).toContain('aria-label="Command approval"');
    expect(approvalRow).toContain('aria-label="Write approval"');
    expect(approvalRow).toContain('aria-label="Codex permissions"');
    expect(html).toContain('.approval-bar .appr-word { display: none; }');

    const renderApprovalBar = html.match(/function renderApprovalBar\(\) \{[\s\S]*?\n    \}/)?.[0] ?? '';
    expect(renderApprovalBar).toContain("selected.backend === 'codex'");
    expect(renderApprovalBar).toContain('commandApprovalControl.hidden = !!isCodex');
    expect(renderApprovalBar).toContain('writeApprovalControl.hidden = !!isCodex');
    expect(renderApprovalBar).toContain('codexPermissionControl.hidden = !isCodex');
    expect(renderApprovalBar).toContain("state.mode === 'plan' ? 'read-only'");
    expect(renderApprovalBar).toContain('selected.codexPermissionCapReason');
    expect(html).toContain("command: 'setCodexPermissionProfile'");
    expect(html).toContain("label: 'Approve anyway'");
    // Field, round 7: Read only was selectable in Act, the host rejected it silently, and the control went on
    // showing Read only while Codex ran under the stored writable profile. It is display-only now, and the
    // change handler sends only the three storable profiles, snapping back to the truth otherwise.
    expect(renderApprovalBar).toContain('readOnlyOption.disabled = true');
    const permissionChange = html.match(/codexPermissionsSel\.addEventListener\('change'[\s\S]*?\n    \}\);/)?.[0] ?? '';
    expect(permissionChange).toContain("choice !== 'ask-for-approval' && choice !== 'approve-for-me' && choice !== 'full-access'");
    expect(permissionChange).toContain('renderApprovalBar();');

    // The sidebar keeps its own layout: one renderer, two containers, no second behaviour.
    expect(html).toContain('.composer-dock, .composer-shell { display: contents; }');
    // position:sticky on the composer was a no-op here — its scrolling ancestor is not its parent.
    expect(html).not.toContain('.composer { position: sticky');
  });

  it('keeps the input readable while making the floating dock edge and control gaps nearly transparent', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' }, 'workbench');

    // Assert the RELATIONSHIPS, not the numbers. These values are tuned by eye against a real host and
    // have already moved once (20/72 -> 10/48 on 2026-08-02); a test naming them fails on every tuning
    // pass while still passing if the relationship that makes the design work were inverted.
    // Read the color-mix alpha out of ONE named rule block. Searching the whole stylesheet for a token
    // finds whichever rule happens to mention it first — which is how the first version of this test
    // read 88% for both surfaces from some unrelated rule and still looked like it was working.
    const alphaOf = (source: string, selector: string) => {
      const at = source.indexOf(selector);
      if (at < 0) { throw new Error(`rule not found: ${selector}`); }
      const block = source.slice(at, source.indexOf('}', at));
      const match = /(\d+)%,\s*transparent/.exec(block);
      if (!match) { throw new Error(`no color-mix alpha in: ${selector}`); }
      return Number(match[1]);
    };
    const blurred = html.slice(0, html.indexOf('@supports not (backdrop-filter'));
    const noBlur = html.slice(html.indexOf('@supports not (backdrop-filter'));

    // 1. The dock edge and the gaps around the controls are clearer than the surface you type on — the
    //    transcript shows through the frame, while the input keeps enough fill to read text against.
    const shellAlpha = alphaOf(blurred, 'body.container-workbench .composer-shell {');
    const inputAlpha = alphaOf(blurred, 'body.container-workbench textarea {');
    expect(shellAlpha).toBeLessThan(inputAlpha);

    // 2. Where the host has no backdrop-filter — Cursor, found on the 0.9.33 trip — translucency is not
    //    a frosted surface, it is the transcript showing through your own text at full contrast. Both
    //    surfaces must therefore be MORE opaque there. Legibility cannot depend on a filter that is
    //    absent, and this is the assertion that stops a future tuning pass from forgetting Cursor.
    expect(noBlur, 'a no-blur fallback must exist').toContain('composer-shell');
    expect(alphaOf(noBlur, 'body.container-workbench .composer-shell {')).toBeGreaterThan(shellAlpha);
    expect(alphaOf(noBlur, 'body.container-workbench textarea {')).toBeGreaterThan(inputAlpha);

    // 3. When the composer stops floating it stops being translucent: nothing passes beneath it there.
    const shortViewport = html.slice(html.indexOf('@media (max-height: 560px)'));
    expect(shortViewport).toContain('body.container-workbench .composer-shell textarea { background: var(--vscode-input-background); }');
  });

  it('keeps a pending approval above the measured dock after a Workbench reflow', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' }, 'workbench');

    // A fixed dock is out of flow. A pending approval must create real scrollable room equal to its
    // measured height, but ordinary transcript turns must not regain a permanent composer band.
    expect(html).toContain('body.container-workbench #approvals:not([hidden]) .appr-card {');
    expect(html).toContain('scroll-margin-bottom: calc(var(--composer-dock-h, 0px) + 16px);');
    expect(html).not.toContain('padding-bottom: var(--composer-dock-h');
    const measurement = html.match(/function measureApprovalDockHeight\(\)[\s\S]*?\n    \}/)?.[0] ?? '';
    expect(measurement).toContain("dock.getBoundingClientRect().height");
    expect(measurement).toContain("document.body.style.setProperty('--composer-dock-h'");
    const reservation = html.match(/function recomputeApprovalReservation\(\)[\s\S]*?\n    \}/)?.[0] ?? '';
    expect(reservation).toContain('measureApprovalDockHeight()');
    expect(reservation).toContain("revealApproval(id, 'auto')");
    const resizeStart = html.indexOf("if (typeof ResizeObserver === 'function' && document.body.classList.contains('container-workbench'))");
    const resize = html.slice(resizeStart, html.indexOf('const TICK', resizeStart));
    expect(resize).toContain('requestAnimationFrame');
    expect(resize).toContain('approvalReflowObserver.observe(document.body)');
    expect(resize).toContain('approvalReflowObserver.observe(composerDockForReservation)');
    expect(resize).toContain('recomputeApprovalReservation()');
  });

  it('renders consent_required as a waiting inline approval state, not an error', () => {
    const consentAgent: ChatAgent = { ...agent, status: 'consent_required', consentMessage: 'Reply to the host consent dialog.' };
    const provider = providerWith(depsFor([consentAgent]));
    const html = (provider as any).getHtml({ cspSource: 'test:' }, 'workbench');

    expect(html).toContain("selected.status === 'consent_required'");
    expect(html).toContain('Consent required — waiting for you');
    expect(html).toContain('Reply to the host consent dialog.');
    expect(html).toContain("card.className = 'appr-card consent-required'");
  });

  it('renders all three runnable-workspace repair states in the shared renderer', async () => {
    const noTeam = new ChatViewProvider({} as never, depsFor([]));
    const missingConnection = providerWith({
      ...depsFor(),
      getRepairState: async () => 'missing-connection',
    } as ChatViewDeps);
    const missingCredential = providerWith({
      ...depsFor(),
      getRepairState: async () => 'missing-credential',
    } as ChatViewDeps);

    expect((noTeam as any).currentState().repair).toBe('no-team');
    await Promise.all([missingConnection, missingCredential].map((provider) =>
      (provider as any).refreshRepairState()
    ));

    expect((missingConnection as any).currentState().repair).toBe('missing-connection');
    expect((missingCredential as any).currentState().repair).toBe('missing-credential');

    expect((noTeam as any).currentState().repairCopy).toMatchObject({
      title: 'Create a team to start working',
      action: 'Create a team',
    });
    expect((missingConnection as any).currentState().repairCopy).toMatchObject({
      title: 'No runnable connection is configured',
      action: 'Open Settings',
    });
    expect((missingCredential as any).currentState().repairCopy).toMatchObject({
      title: 'This connection needs a credential',
      action: 'Open Settings',
    });

    const html = (missingCredential as any).getHtml({ cspSource: 'test:' }, 'workbench');
    expect(html).toContain('const copy = state.repairCopy');
    expect(html).toContain("command: 'repairAction'");
  });

  it('announces approvals safely and keeps a separate sequence for repeated events', () => {
    const provider = providerWith();

    void provider.requestApproval({
      kind: 'command', agentId: agent.id, sessionId: agent.id, agentName: 'Dev', command: 'npm test -- --secret',
    });
    const first = (provider as any).currentState().announcement;
    expect(first).toMatchObject({ politeness: 'assertive', text: 'Dev needs your approval to run a command.' });
    expect(first.text).not.toContain('npm test');

    void provider.requestApproval({
      kind: 'command', agentId: agent.id, sessionId: agent.id, agentName: 'Dev', command: 'npm test -- --secret',
    });
    const second = (provider as any).currentState().announcement;
    expect(second).toMatchObject({ politeness: 'assertive', text: first.text });
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  it('announces a turn only at its boundaries and reports an approval timeout politely', async () => {
    vi.useFakeTimers();
    try {
      const provider = providerWith();
      (provider as any).appendDelta(agent.id, 'first token');
      const started = (provider as any).currentState().announcement;
      expect(started).toMatchObject({ politeness: 'polite', text: 'Dev started a reply.' });

      (provider as any).appendDelta(agent.id, ' second token');
      expect((provider as any).currentState().announcement.seq).toBe(started.seq);

      (provider as any).onReply({ from: agent.id, fromName: 'Dev', text: 'completed', isError: false });
      expect((provider as any).currentState().announcement).toMatchObject({
        politeness: 'polite', text: 'Dev finished its reply.',
      });

      (provider as any).appendDelta(agent.id, 'next turn');
      (provider as any).onReply({ from: agent.id, fromName: 'Dev', text: 'failed', isError: true });
      expect((provider as any).currentState().announcement).toMatchObject({
        politeness: 'polite', text: 'Dev could not finish its reply.',
      });

      const pending = provider.requestApproval({
        kind: 'tool', agentId: agent.id, sessionId: agent.id, agentName: 'Dev', toolName: 'Web access',
      }, 60);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toMatchObject({ action: 'deny', note: 'The approval window expired.', expired: true });
      expect((provider as any).currentState().announcement).toMatchObject({
        politeness: 'polite', text: 'Approval for Dev timed out and was denied.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces a repair card only when it replaces an already-rendered conversation', () => {
    const provider = providerWith();
    expect((provider as any).currentState().announcement).toBeUndefined();

    (provider as any).repairState = 'missing-connection';
    (provider as any).postState();
    expect((provider as any).currentState().announcement).toMatchObject({
      politeness: 'polite',
      text: 'No runnable connection is configured. This team has no available connection. Choose one in Settings before sending a task.',
    });
  });

  it('delivers each live event to one visible container and never replays it after focus changes', () => {
    const provider = providerWith();
    const sidebar = webviewViewForTest();
    const workbench = webviewPanelForTest();
    provider.resolveWebviewView(sidebar.view as never);
    provider.restoreWorkbench(workbench.panel as never);
    sidebar.view.webview.postMessage.mockClear();
    workbench.panel.webview.postMessage.mockClear();

    void provider.requestApproval({ kind: 'tool', agentName: 'Dev', toolName: 'Web access' });
    expect(workbench.panel.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      command: 'state', announce: true,
    }));
    expect(sidebar.view.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      command: 'state', announce: false,
    }));

    sidebar.fireMessage({ command: 'accessibilityFocus', focused: true });
    sidebar.view.webview.postMessage.mockClear();
    workbench.panel.webview.postMessage.mockClear();
    void provider.requestApproval({ kind: 'tool', agentName: 'Dev', toolName: 'Web access' });
    expect(sidebar.view.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      command: 'state', announce: true,
    }));
    expect(workbench.panel.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      command: 'state', announce: false,
    }));
  });

  it('keeps a collapsed sidebar collapsed for a background approval, but still calls an expanded sidebar', () => {
    const provider = providerWith();
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);

    void provider.requestApproval({
      kind: 'command', agentId: agent.id, sessionId: agent.id, agentName: 'Dev', command: 'npm test',
    });
    expect(sidebar.view.show).toHaveBeenCalledWith(true);

    sidebar.view.show.mockClear();
    sidebar.view.visible = false;
    void provider.requestApproval({
      kind: 'write', agentId: agent.id, sessionId: agent.id, agentName: 'Dev', path: 'src/app.ts', verb: 'overwrite', diff: 'change',
    });

    expect(sidebar.view.show).not.toHaveBeenCalled();
    expect((provider as any).currentState().pendingApprovals).toHaveLength(2);
  });

  it('clears an approval on both attached surfaces whichever surface decides, including timeout', async () => {
    vi.useFakeTimers();
    try {
      const provider = providerWith();
      const sidebar = webviewViewForTest();
      const workbench = webviewPanelForTest();
      provider.resolveWebviewView(sidebar.view as never);
      provider.restoreWorkbench(workbench.panel as never);

      const assertClearedEverywhere = () => {
        for (const post of [sidebar.view.webview.postMessage, workbench.panel.webview.postMessage]) {
          expect(post).toHaveBeenLastCalledWith(expect.objectContaining({
            command: 'state', state: expect.objectContaining({ pendingApprovals: [] }),
          }));
        }
      };

      const sidebarDecision = provider.requestApproval({
        kind: 'command', agentId: agent.id, sessionId: agent.id, agentName: 'Dev', command: 'npm test',
      });
      const firstId = (provider as any).currentState().pendingApprovals[0].id;
      sidebar.fireMessage({ command: 'approvalDecision', id: firstId, action: 'deny' });
      await expect(sidebarDecision).resolves.toMatchObject({ action: 'deny' });
      assertClearedEverywhere();

      const workbenchDecision = provider.requestApproval({
        kind: 'tool', agentId: agent.id, sessionId: agent.id, agentName: 'Dev', toolName: 'Web access',
      });
      const secondId = (provider as any).currentState().pendingApprovals[0].id;
      workbench.fireMessage({ command: 'approvalDecision', id: secondId, action: 'once' });
      await expect(workbenchDecision).resolves.toMatchObject({ action: 'once' });
      assertClearedEverywhere();

      const expired = provider.requestApproval({
        kind: 'tool', agentId: agent.id, sessionId: agent.id, agentName: 'Dev', toolName: 'Web access',
      }, 60);
      await vi.advanceTimersByTimeAsync(60);
      await expect(expired).resolves.toMatchObject({ action: 'deny', note: 'The approval window expired.', expired: true });
      assertClearedEverywhere();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders initially empty live regions and ignores the state announcement it booted with', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' }, 'workbench');
    expect(html).toContain('id="announcement-polite" class="live-announcer" aria-live="polite" aria-atomic="true"></div>');
    expect(html).toContain('id="announcement-assertive" class="live-announcer" aria-live="assertive" aria-atomic="true"></div>');

    const functions = html.match(/function announcementSeq\(announcement\) \{[\s\S]*?function renderAnnouncement\(announcement, deliver\) \{[\s\S]*?\n    \}\n\n/)?.[0];
    expect(functions).toBeTruthy();
    const source = `let lastAnnouncementSeq = announcementSeq(initialState.announcement);\n${functions}`;
    const polite = textNode();
    const assertive = textNode();
    const createRenderer = new Function('initialState', 'politeAnnouncement', 'assertiveAnnouncement', 'setTimeout', `${source}\nreturn renderAnnouncement;`);
    // Capture what gets DEFERRED rather than written inline. Clearing a live region and rewriting the
    // same string inside one task is not a change by the time the accessibility tree is computed, so a
    // repeated identical announcement is silent — which is the exact case the sequence number exists for.
    // The deferral is the behaviour under test, not an implementation detail.
    const scheduled: Array<() => void> = [];
    const renderAnnouncement = createRenderer(
      { announcement: { seq: 4, text: 'Earlier event', politeness: 'polite' } },
      polite.node,
      assertive.node,
      (fn: () => void) => { scheduled.push(fn); },
    );

    renderAnnouncement({ seq: 4, text: 'Earlier event', politeness: 'polite' }, true);
    expect(polite.values).toEqual([]);
    renderAnnouncement({ seq: 5, text: 'Same words', politeness: 'polite' }, false);
    renderAnnouncement({ seq: 6, text: 'Same words', politeness: 'polite' }, true);

    expect(polite.values).toEqual(['']);
    scheduled.shift()?.();
    expect(polite.values).toEqual(['', 'Same words']);
  });

  it('accepts only known repair actions from the webview', () => {
    const runRepairAction = vi.fn();
    const provider = providerWith({ ...depsFor(), runRepairAction } as ChatViewDeps);

    (provider as any).onMessage({ command: 'repairAction', kind: 'missing-credential' });
    (provider as any).onMessage({ command: 'repairAction', kind: 'forged-command' });

    expect(runRepairAction).toHaveBeenCalledTimes(1);
    expect(runRepairAction).toHaveBeenCalledWith('missing-credential');
  });

  it('runs a delegate-empty repair only for its host-issued outcome and makes duplicate retry delivery idempotent', async () => {
    let resolveRetry!: (started: boolean) => void;
    const retry = vi.fn(() => new Promise<boolean>((resolve) => { resolveRetry = resolve; }));
    const openAgentModelSettings = vi.fn();
    const onOutcomeRepair = vi.fn();
    const pm: ChatAgent = { ...agent, id: 'pm-1', name: 'PM', role: 'Project Manager', status: 'idle' };
    const provider = providerWith({
      ...depsFor([agent, pm]), openAgentModelSettings, onOutcomeRepair,
    } as ChatViewDeps);
    provider.selectAgent(pm.id);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    provider.recordDelegationEmptyOutcome({
      outcomeId: 'delegate-empty-1', agentId: agent.id, sessionId: 'pm-1', correlationId: 'dispatch-1', retry,
    });

    expect((provider as any).currentState().outcomeRepairs).toEqual([
      expect.objectContaining({ outcomeId: 'delegate-empty-1', state: 'offered', action: { kind: 'configure-agent-model', label: 'Edit agent model' } }),
    ]);
    sidebar.fireMessage({ command: 'repairAction', kind: 'configure-agent-model', outcomeId: 'delegate-empty-1' });
    await vi.waitFor(() => expect(openAgentModelSettings).toHaveBeenCalledWith(agent.id));
    expect(onOutcomeRepair).toHaveBeenCalledWith(expect.objectContaining({ category: 'delegate-empty', state: 'invoked', agentId: agent.id }));

    sidebar.fireMessage({ command: 'repairAction', kind: 'retry-delegation', outcomeId: 'delegate-empty-1' });
    sidebar.fireMessage({ command: 'repairAction', kind: 'retry-delegation', outcomeId: 'delegate-empty-1' });
    expect(retry).toHaveBeenCalledTimes(1);
    resolveRetry(true);
    await vi.waitFor(() => expect((provider as any).currentState().outcomeRepairs[0]).toMatchObject({
      state: 'invoked', action: undefined,
    }));
  });

  it('offers the three next steps of a first-action deadline together and takes none of them itself', async () => {
    const retry = vi.fn(async () => true);
    const openAgentModelSettings = vi.fn();
    const onOutcomeRepair = vi.fn();
    // The deadline stopped the coordinator: its card must work for a stopped session.
    const pm: ChatAgent = { ...agent, id: 'pm-1', name: 'PM', role: 'Project Manager', status: 'stopped' };
    const provider = providerWith({ ...depsFor([agent, pm]), openAgentModelSettings, onOutcomeRepair } as ChatViewDeps);
    provider.selectAgent(pm.id);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    const card = () => (provider as any).currentState().outcomeRepairs.find((entry: any) => entry.category === 'first-action-deadline');

    provider.recordFirstActionDeadline({ turnId: 'turn-1', agentId: pm.id, retry });
    // The same deadline reported again adds no second card.
    provider.recordFirstActionDeadline({ turnId: 'turn-1', agentId: pm.id, retry });
    expect((provider as any).currentState().outcomeRepairs).toHaveLength(1);
    expect(card()).toMatchObject({
      outcomeId: 'first-action-deadline:turn-1',
      state: 'offered',
      title: 'No first action within 60 seconds',
      detail: expect.stringMatching(/Nothing was dispatched or changed, and nothing is retried for you.*same route as a new request.*does not continue the ended attempt/),
      actions: [
        { kind: 'retry-same-route', label: 'Retry same route' },
        { kind: 'switch-route', label: 'Switch route' },
        { kind: 'stop-request', label: 'Stop' },
      ],
    });
    // The resubmission never leaves the host, and offering the card started nothing.
    expect(card().retry).toBeUndefined();
    expect(retry).not.toHaveBeenCalled();
    expect(openAgentModelSettings).not.toHaveBeenCalled();

    // Switch route opens the agent's editor and switches nothing; the request is started again only on a click.
    sidebar.fireMessage({ command: 'repairAction', kind: 'switch-route', outcomeId: 'first-action-deadline:turn-1' });
    await vi.waitFor(() => expect(openAgentModelSettings).toHaveBeenCalledWith(pm.id));
    expect(retry).not.toHaveBeenCalled();
    expect(card()).toMatchObject({
      state: 'invoked',
      detail: expect.stringMatching(/Nothing was switched for you/),
      actions: [{ kind: 'retry-same-route', label: 'Start this request again' }, { kind: 'stop-request', label: 'Stop' }],
    });

    // Two clicks start the request once.
    sidebar.fireMessage({ command: 'repairAction', kind: 'retry-same-route', outcomeId: 'first-action-deadline:turn-1' });
    sidebar.fireMessage({ command: 'repairAction', kind: 'retry-same-route', outcomeId: 'first-action-deadline:turn-1' });
    await vi.waitFor(() => expect(card()).toMatchObject({ state: 'invoked', detail: expect.stringMatching(/started again.*as a new request/) }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(card().actions).toBeUndefined();
    // The attempt belongs to no run, so its card leaves nothing in the run ledger.
    expect(onOutcomeRepair).not.toHaveBeenCalled();
  });

  it('stops a first-action deadline card without starting anything, and refuses an action it does not offer', async () => {
    const retry = vi.fn(async () => true);
    const openAgentModelSettings = vi.fn();
    const pm: ChatAgent = { ...agent, id: 'pm-1', name: 'PM', role: 'Project Manager', status: 'stopped' };
    const provider = providerWith({ ...depsFor([agent, pm]), openAgentModelSettings } as ChatViewDeps);
    provider.selectAgent(pm.id);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    const card = (id: string) => (provider as any).outcomeRepairs.get(id);

    provider.recordFirstActionDeadline({ turnId: 'turn-2', agentId: pm.id, retry });
    // A crafted message naming an action of another card kind does nothing.
    sidebar.fireMessage({ command: 'repairAction', kind: 'retry-delegation', outcomeId: 'first-action-deadline:turn-2' });
    sidebar.fireMessage({ command: 'repairAction', kind: 'configure-agent-model', outcomeId: 'first-action-deadline:turn-2' });
    await Promise.resolve();
    expect(card('first-action-deadline:turn-2')).toMatchObject({ state: 'offered' });

    sidebar.fireMessage({ command: 'repairAction', kind: 'stop-request', outcomeId: 'first-action-deadline:turn-2' });
    await vi.waitFor(() => expect(card('first-action-deadline:turn-2')).toMatchObject({
      state: 'invoked', actions: undefined, detail: expect.stringMatching(/Stopped\. Nothing was dispatched or changed/),
    }));
    // After Stop the card offers nothing, so a late retry click starts nothing.
    sidebar.fireMessage({ command: 'repairAction', kind: 'retry-same-route', outcomeId: 'first-action-deadline:turn-2' });
    await Promise.resolve();
    expect(retry).not.toHaveBeenCalled();
    expect(openAgentModelSettings).not.toHaveBeenCalled();
  });

  it('withdraws a first-action deadline card when its agent is gone or the retry could not start', async () => {
    const pm: ChatAgent = { ...agent, id: 'pm-1', name: 'PM', role: 'Project Manager', status: 'stopped' };
    const agents = [agent, pm];
    const failing = vi.fn(async () => false);
    const provider = providerWith({ ...depsFor(agents), openAgentModelSettings: vi.fn() } as ChatViewDeps);
    provider.selectAgent(pm.id);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    const card = (id: string) => (provider as any).outcomeRepairs.get(id);

    provider.recordFirstActionDeadline({ turnId: 'turn-3', agentId: pm.id, retry: failing });
    sidebar.fireMessage({ command: 'repairAction', kind: 'retry-same-route', outcomeId: 'first-action-deadline:turn-3' });
    await vi.waitFor(() => expect(card('first-action-deadline:turn-3')).toMatchObject({
      state: 'unavailable', actions: undefined, detail: expect.stringMatching(/can no longer be started again from here/),
    }));
    expect(failing).toHaveBeenCalledTimes(1);

    const retry = vi.fn(async () => true);
    provider.recordFirstActionDeadline({ turnId: 'turn-4', agentId: pm.id, retry });
    agents.splice(agents.indexOf(pm), 1);
    sidebar.fireMessage({ command: 'repairAction', kind: 'retry-same-route', outcomeId: 'first-action-deadline:turn-4' });
    await vi.waitFor(() => expect(card('first-action-deadline:turn-4')).toMatchObject({ state: 'unavailable', actions: undefined }));
    expect(retry).not.toHaveBeenCalled();
  });

  it('revalidates a delegate-empty repair at invocation and removes its action when the host target vanished', async () => {
    const pm: ChatAgent = { ...agent, id: 'pm-1', name: 'PM', role: 'Project Manager', status: 'idle' };
    const agents = [agent, pm];
    const openAgentModelSettings = vi.fn();
    const onOutcomeRepair = vi.fn();
    const provider = providerWith({
      ...depsFor(agents), openAgentModelSettings, onOutcomeRepair,
    } as ChatViewDeps);
    provider.selectAgent(pm.id);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    provider.recordDelegationEmptyOutcome({
      outcomeId: 'delegate-empty-vanished', agentId: agent.id, sessionId: 'pm-1', correlationId: 'dispatch-1', retry: vi.fn(async () => true),
    });
    agents.splice(0, 1);

    sidebar.fireMessage({ command: 'repairAction', kind: 'configure-agent-model', outcomeId: 'delegate-empty-vanished' });
    await vi.waitFor(() => expect(onOutcomeRepair).toHaveBeenCalledWith(expect.objectContaining({
      outcomeId: 'delegate-empty-vanished', state: 'unavailable',
    })));
    expect(openAgentModelSettings).not.toHaveBeenCalled();
    expect((provider as any).outcomeRepairs.get('delegate-empty-vanished')).toMatchObject({
      state: 'unavailable', action: undefined,
    });

    // Mutation canary: if this selected-agent / live-roster check is removed, a stale webview card
    // opens Agent Builder for an agent the host no longer recognizes.
  });

  it('revalidates coordinator-session reachability after render before it runs a delegate-empty repair', async () => {
    const pm: ChatAgent = { ...agent, id: 'pm-1', name: 'PM', role: 'Project Manager', status: 'idle' };
    const agents = [agent, pm];
    const openAgentModelSettings = vi.fn();
    const provider = providerWith({
      ...depsFor(agents), openAgentModelSettings,
    } as ChatViewDeps);
    provider.selectAgent(pm.id);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    provider.recordDelegationEmptyOutcome({
      outcomeId: 'delegate-empty-ended-session', agentId: agent.id, sessionId: pm.id,
      correlationId: 'dispatch-1', retry: vi.fn(async () => true),
    });
    pm.status = 'stopped';

    sidebar.fireMessage({ command: 'repairAction', kind: 'configure-agent-model', outcomeId: 'delegate-empty-ended-session' });
    await vi.waitFor(() => expect((provider as any).outcomeRepairs.get('delegate-empty-ended-session')).toMatchObject({
      state: 'unavailable', action: undefined,
    }));
    expect(openAgentModelSettings).not.toHaveBeenCalled();

    // Mutation canary: replacing outcomeSessionReachable(record.sessionId) with true opens an editor
    // and can later dispatch work even though this coordinator cannot receive the fresh result.
  });

  it('requires the exact currently offered action before invoking a delegate-empty repair', async () => {
    const pm: ChatAgent = { ...agent, id: 'pm-1', name: 'PM', role: 'Project Manager', status: 'idle' };
    const openAgentModelSettings = vi.fn();
    const retry = vi.fn(async () => true);
    const provider = providerWith({
      ...depsFor([agent, pm]), openAgentModelSettings,
    } as ChatViewDeps);
    provider.selectAgent(pm.id);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    provider.recordDelegationEmptyOutcome({
      outcomeId: 'delegate-empty-wrong-action', agentId: agent.id, sessionId: pm.id,
      correlationId: 'dispatch-1', retry,
    });

    // The card offers model configuration first, not the later retry. A crafted retry message cannot skip it.
    sidebar.fireMessage({ command: 'repairAction', kind: 'retry-delegation', outcomeId: 'delegate-empty-wrong-action' });
    await Promise.resolve();
    expect(retry).not.toHaveBeenCalled();
    expect(openAgentModelSettings).not.toHaveBeenCalled();

    // Even with every identity/reachability check true, no rendered offer means no authority.
    const unavailable = (provider as any).outcomeRepairs.get('delegate-empty-wrong-action');
    unavailable.state = 'unavailable';
    unavailable.action = undefined;
    sidebar.fireMessage({ command: 'repairAction', kind: 'retry-delegation', outcomeId: 'delegate-empty-wrong-action' });
    sidebar.fireMessage({ command: 'repairAction', kind: 'configure-agent-model', outcomeId: 'delegate-empty-wrong-action' });
    await Promise.resolve();
    expect(retry).not.toHaveBeenCalled();
    expect(openAgentModelSettings).not.toHaveBeenCalled();

    // Mutation canary: deleting record.action?.kind !== kind makes both crafted messages actionable.
  });

  it('ignores a duplicate delegate-empty receipt without regressing its evidence state', async () => {
    const pm: ChatAgent = { ...agent, id: 'pm-1', name: 'PM', role: 'Project Manager', status: 'idle' };
    const openAgentModelSettings = vi.fn();
    const onOutcomeRepair = vi.fn();
    const provider = providerWith({
      ...depsFor([agent, pm]), openAgentModelSettings, onOutcomeRepair,
    } as ChatViewDeps);
    provider.selectAgent(pm.id);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    const receipt = {
      outcomeId: 'delegate-empty-duplicate', agentId: agent.id, sessionId: pm.id,
      correlationId: 'dispatch-1', retry: vi.fn(async () => true),
    };
    provider.recordDelegationEmptyOutcome(receipt);
    sidebar.fireMessage({ command: 'repairAction', kind: 'configure-agent-model', outcomeId: receipt.outcomeId });
    await vi.waitFor(() => expect(openAgentModelSettings).toHaveBeenCalledWith(agent.id));
    provider.recordDelegationEmptyOutcome(receipt);

    expect((provider as any).outcomeRepairs.get(receipt.outcomeId)).toMatchObject({
      state: 'invoked', action: { kind: 'retry-delegation', label: 'Retry delegation' },
    });
    expect(onOutcomeRepair.mock.calls.filter(([event]) => event.state === 'offered')).toHaveLength(1);

    // Mutation canary: deleting the Map.has() return overwrites this invoked receipt with a fake offered one.
  });

  it('refuses an outcome repair rendered for a different selected agent', async () => {
    const other: ChatAgent = { ...agent, id: 'agent-2', name: 'Reviewer' };
    const pm: ChatAgent = { ...agent, id: 'pm-1', name: 'PM', role: 'Project Manager', status: 'idle' };
    const openAgentModelSettings = vi.fn();
    const provider = providerWith({
      ...depsFor([agent, other, pm]), openAgentModelSettings,
    } as ChatViewDeps);
    provider.selectAgent(pm.id);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    provider.recordDelegationEmptyOutcome({
      outcomeId: 'delegate-empty-other-agent', agentId: agent.id, sessionId: 'pm-1', correlationId: 'dispatch-1', retry: vi.fn(async () => true),
    });
    provider.selectAgent(other.id);

    sidebar.fireMessage({ command: 'repairAction', kind: 'configure-agent-model', outcomeId: 'delegate-empty-other-agent' });
    await vi.waitFor(() => expect((provider as any).outcomeRepairs.get('delegate-empty-other-agent')).toMatchObject({
      state: 'unavailable', action: undefined,
    }));
    expect(openAgentModelSettings).not.toHaveBeenCalled();

    // Mutation canary: deleting `this.selectedAgentId === record.agentId` lets an untrusted webview
    // invoke the model editor for an outcome rendered in another agent's conversation.
  });

  it('does not paint a previous agent’s readiness result over a newly selected agent', async () => {
    const secondAgent: ChatAgent = { ...agent, id: 'agent-2', name: 'Reviewer' };
    const pending: Array<{ agentId: string; resolve: (state: 'missing-credential' | undefined) => void }> = [];
    const getRepairState = vi.fn((agentId: string) => new Promise<'missing-credential' | undefined>((resolve) => {
      pending.push({ agentId, resolve });
    }));
    const provider = new ChatViewProvider({} as never, {
      ...depsFor([agent, secondAgent]),
      getRepairState,
    } as ChatViewDeps);

    provider.selectAgent(agent.id);
    provider.selectAgent(secondAgent.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].agentId).toBe(agent.id);

    pending[0].resolve('missing-credential');
    await Promise.resolve();
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    expect(pending[1].agentId).toBe(secondAgent.id);

    pending[1].resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect((provider as any).currentState().repair).toBeUndefined();
  });

  it('takes a user from the global signal to the same inline card without focusing an allow action', () => {
    const provider = providerWith();
    const workbench = webviewPanelForTest();
    provider.restoreWorkbench(workbench.panel as never);
    void provider.requestApproval({ kind: 'command', agentId: agent.id, sessionId: agent.id, agentName: 'Dev', command: 'npm test' });

    provider.focusPendingApproval(agent.id);
    expect(workbench.panel.reveal).toHaveBeenCalledWith(1, false);
    expect(workbench.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'focusApproval' }));

    const html = (provider as any).getHtml({ cspSource: 'test:' }, 'workbench');
    const reveal = html.match(/function revealApproval\(id, behavior = 'smooth'\)[\s\S]*?\n    \}/)?.[0] ?? '';
    expect(reveal).toContain('scrollIntoView');
    expect(reveal).not.toContain('.focus(');
  });

  it('keeps an expired approval visible as denied — timed out instead of clearing it on view', async () => {
    vi.useFakeTimers();
    try {
      const provider = providerWith();
      const pending = provider.requestApproval({ kind: 'tool', agentId: agent.id, sessionId: agent.id, agentName: 'Dev', toolName: 'Web access' }, 60);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toMatchObject({ action: 'deny', note: 'The approval window expired.', expired: true });

      expect((provider as any).currentState().approvalAttention).toMatchObject({ state: 'timed_out', approvalId: expect.stringMatching(/^appr-/) });
      const html = (provider as any).getHtml({ cspSource: 'test:' }, 'workbench');
      expect(html).toContain('Approval denied — timed out');
      expect(html).toContain('cannot be approved after the timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps two expired approvals for one agent as two distinct unavailable outcomes', async () => {
    vi.useFakeTimers();
    try {
      const outcomeEvents: unknown[] = [];
      const deps = { ...depsFor(), onOutcomeRepair: (event: unknown) => outcomeEvents.push(event) };
      const provider = providerWith(deps);
      const first = provider.requestApproval({ kind: 'tool', agentId: agent.id, sessionId: agent.id, agentName: 'Dev', toolName: 'First tool' }, 60);
      const second = provider.requestApproval({ kind: 'tool', agentId: agent.id, sessionId: agent.id, agentName: 'Dev', toolName: 'Second tool' }, 60);

      await vi.advanceTimersByTimeAsync(60);
      await Promise.all([first, second]);

      const state = (provider as any).currentState();
      expect(state.approvalOutcomes).toHaveLength(2);
      expect(state.approvalOutcomes.map((outcome: any) => outcome.approvalId)).toEqual([
        expect.stringMatching(/^appr-/), expect.stringMatching(/^appr-/),
      ]);
      expect(state.approvalOutcomes[0].approvalId).not.toBe(state.approvalOutcomes[1].approvalId);
      expect(outcomeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: 'consent-timeout', state: 'unavailable', agentId: agent.id }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the status-bar signal to host consent when no in-chat approval is queued', () => {
    const consentAgent: ChatAgent = { ...agent, id: 'agent-2', name: 'Researcher', status: 'consent_required' };
    const provider = providerWith(depsFor([agent, consentAgent]));
    const workbench = webviewPanelForTest();
    provider.restoreWorkbench(workbench.panel as never);

    provider.focusPendingApproval();

    expect((provider as any).currentState().selectedAgentId).toBe('agent-2');
    expect(workbench.panel.reveal).toHaveBeenCalledWith(1, false);
  });

  it('keeps per-agent Workbench drafts in merged VS Code webview state and exposes the approved focus toggle', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' }, 'workbench');
    expect(html).toContain('savedUiState.draftsByAgent');
    expect(html).toContain('const MAX_AGENT_DRAFTS = 20');
    expect(html).toContain('Object.assign({}, previous, { draftsByAgent, expandedToolIdsByAgent })');
    expect(html).toContain('persistUiState(agentId, true)');
    expect(html).toContain('id="sessionSummary"');
    expect(html).toContain('renderSessionSummary()');
    expect(html).toContain("event.data.command === 'toggleComposerFocus'");
    expect(html).toContain("command: 'focusEditor'");
  });

  it('keeps drafts with their agent, drops a sent draft, and evicts the least recently edited entry', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' }, 'workbench');
    const draftFunctions = html.match(/function readSavedDrafts\(raw\) \{[\s\S]*?function restoreDraftForAgent\(agentId\) \{[\s\S]*?\n    \}/)?.[0];
    const persistSnapshot = html.match(/function persistUiSnapshot\(\) \{[\s\S]*?\n    \}/)?.[0];
    const persist = html.match(/function persistUiState\(agentId = state\.selectedAgentId, drop = false\) \{[\s\S]*?\n    \}/)?.[0];
    expect(draftFunctions).toBeTruthy();
    expect(persistSnapshot).toBeTruthy();
    expect(persist).toBeTruthy();

    const agents = Array.from({ length: 21 }, (_, index) => ({ id: `agent-${index + 1}` }));
    const raw = Object.fromEntries(agents.map((entry, index) => [entry.id, { text: `draft ${index + 1}`, editedAt: index + 1 }]));
    const saved: unknown[] = [];
    const run = new Function('state', 'input', 'vscode', 'raw', `
      const MAX_AGENT_DRAFTS = 20;
      const MAX_TOOL_EXPANSION_AGENTS = 20;
      const MAX_EXPANDED_TOOL_IDS_PER_AGENT = 60;
      let draftRevision = 0;
      const draftsByAgent = readSavedDrafts(raw);
      const expandedToolIdsByAgent = {};
      ${draftFunctions}
      ${persistSnapshot}
      ${persist}
      pruneDrafts();
      const evictedOldest = !draftsByAgent['agent-1'] && Object.keys(draftsByAgent).length === 20;
      input.value = 'draft for the current agent';
      persistUiState('agent-2');
      input.value = '';
      restoreDraftForAgent('agent-2');
      const restored = input.value;
      persistUiState('agent-2', true);
      return { evictedOldest, restored, dropped: !draftsByAgent['agent-2'] };
    `);
    const input = { value: '' };
    const vscode = {
      getState: () => ({ futureField: 'preserved', draft: 'legacy global draft' }),
      setState: (next: unknown) => saved.push(next),
    };
    const result = run({ agents, selectedAgentId: 'agent-2' }, input, vscode, raw) as any;

    expect(result.evictedOldest).toBe(true);
    expect(result.restored).toBe('draft for the current agent');
    expect(result.dropped).toBe(true);
    expect(saved.at(-1)).toMatchObject({ futureField: 'preserved' });
    expect(saved.at(-1)).not.toHaveProperty('draft');
  });

  it('routes busy Send to interject', () => {
    const deps = depsFor();
    const provider = providerWith(deps);

    provider.appendDelta(agent.id, 'working');
    (provider as any).onMessage({ command: 'send', agentId: agent.id, text: ' use read_file ', mode: 'act' });

    expect(deps.interject).toHaveBeenCalledWith(agent.id, 'use read_file');
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('routes idle Send to send', () => {
    const deps = depsFor();
    const provider = providerWith(deps);

    (provider as any).onMessage({ command: 'send', agentId: agent.id, text: 'start task', mode: 'plan' });

    expect(deps.send).toHaveBeenCalledWith(agent.id, 'start task', 'plan', [], 1);
    expect(deps.interject).not.toHaveBeenCalled();
  });

  it('keeps an unacknowledged composer draft when the named agent no longer exists', () => {
    const rejected = vi.fn();
    const deps = { ...depsFor(), onSendRejected: rejected } as ChatViewDeps;
    const provider = providerWith(deps);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);

    sidebar.fireMessage({ command: 'send', requestId: 'send-stale', agentId: 'removed-agent', text: 'keep this draft', mode: 'act' });

    expect(deps.send).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledWith({
      clause: 'unknown-agent',
      requestedAgentId: 'removed-agent',
      selectedAgentId: agent.id,
      requestId: 'send-stale',
    });
    expect(sidebar.view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'sendRejected',
      requestId: 'send-stale',
      requestedAgentId: 'removed-agent',
      selectedAgentId: agent.id,
    }));
  });

  it('reports an empty composer post instead of silently returning', () => {
    const rejected = vi.fn();
    const deps = { ...depsFor(), onSendRejected: rejected } as ChatViewDeps;
    const provider = providerWith(deps);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);

    sidebar.fireMessage({ command: 'send', requestId: 'send-empty', agentId: agent.id, text: '   ', attachments: [] });

    expect(deps.send).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({
      clause: 'empty',
      requestedAgentId: agent.id,
      selectedAgentId: agent.id,
    }));
    expect(sidebar.view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'sendRejected',
      requestId: 'send-empty',
    }));
  });

  it('treats an existing agent named by a stale composer as an intentional send', () => {
    const other: ChatAgent = { id: 'agent-2', name: 'Reviewer', role: 'Reviewer', backend: 'openai' };
    const deps = depsFor([agent, other]);
    const provider = providerWith(deps);
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);

    sidebar.fireMessage({ command: 'send', requestId: 'send-agent-2', agentId: other.id, text: 'Review this', mode: 'act' });

    expect(deps.send).toHaveBeenCalledWith(other.id, 'Review this', 'act', [], 1);
    expect((provider as any).currentState().selectedAgentId).toBe(other.id);
    expect(sidebar.view.webview.postMessage).toHaveBeenCalledWith({ command: 'sendAccepted', requestId: 'send-agent-2' });
  });

  it('flips the composer label and hint from running state', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    const match = html.match(/function updateComposer\(\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    function selectedIsRunning/);
    expect(match).toBeTruthy();
    const updateComposer = match![0].replace(/\r?\n\r?\n    function selectedIsRunning$/, '');
    const run = (runningAgentIds: string[], selectedAgent: ChatAgent = agent) => {
      const input: any = {};
      const labels: Record<string, string> = {};
      const sendButton: any = { setAttribute: (k: string, v: string) => { labels[k] = v; }, labels };
      const stopButton: any = {};
      const steerHint: any = {};
      const ctxCompact: any = { classList: { remove: () => {}, toggle: () => {} }, setAttribute: () => {} };
      const ctxMeter: any = { classList: { remove: () => {}, toggle: () => {} } };
      const state = { selectedAgentId: agent.id, runningAgentIds, mode: 'act', agents: [selectedAgent] };
      const fn = new Function('state', 'input', 'sendButton', 'stopButton', 'steerHint', 'planMode', 'actMode', 'agentSelect', 'ctxCompact', 'ctxMeter', 'compactInFlight', 'COMPACT_GLYPH', `${updateComposer}\nupdateComposer();`);
      fn(state, input, sendButton, stopButton, steerHint, {}, {}, {}, ctxCompact, ctxMeter, false, '⤓');
      return { input, sendButton, stopButton, steerHint };
    };

    // Icon-only since 2026-08-02. Three states, three glyphs -- and the WORD has to survive somewhere,
    // so every state is asserted on both the glyph and the accessible name. An icon whose aria-label
    // still said "Send" while it steered would look right and read wrong.
    const idle = run([]);
    expect(idle.sendButton.textContent).toBe('↑');
    expect(idle.sendButton.labels['aria-label']).toBe('Send');
    expect(idle.steerHint.hidden).toBe(true);
    expect(idle.stopButton.hidden).toBe(true);

    const running = run([agent.id]);
    expect(running.sendButton.textContent).toBe('⚡');
    expect(running.sendButton.labels['aria-label']).toContain('steering message');
    expect(running.sendButton.title).toContain('steering message');
    expect(running.stopButton.hidden).toBe(false);
    expect(running.stopButton.disabled).toBe(false);
    // Painted at 1px, but still spoken: it is the only place that says a message STEERS rather than
    // queues, which no glyph conveys.
    expect(running.steerHint.hidden).toBe(false);

    const queued = run([agent.id], { ...agent, canSteer: false });
    expect(queued.sendButton.textContent).toBe('↓');
    expect(queued.sendButton.labels['aria-label']).toContain('Queue a follow-up');
    expect(queued.sendButton.title).toContain('Queue a follow-up');
    expect(queued.steerHint.textContent).toContain('cannot accept mid-turn steering');
  });

  it('persists a finalized tool card so its diff survives a reload (0.6.13)', () => {
    const deps = depsFor();
    const provider = providerWith(deps);

    // A write tool runs and finishes with a diff.
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-write_file', name: 'write_file', input: { path: 'a.txt' } });
    provider.appendToolActivity(agent.id, { phase: 'result', callId: 'call-write_file', name: 'write_file', outcome: { status: 'success', observedBy: 'host' }, summary: 'Wrote 3 bytes', diff: '--- a.txt\n+++ a.txt\n+x' });

    // Simulate a window reload: a brand-new provider over the SAME persisted store.
    const reloaded = new ChatViewProvider({} as never, deps);
    const items = (reloaded as any).transcriptItems(agent.id) as Array<{ kind: string; name?: string; diff?: string; phase?: string; completedAt?: string }>;
    const card = items.find((i) => i.kind === 'tool' && i.name === 'write_file');
    expect(card).toBeTruthy();
    expect(card!.diff).toContain('+x');
    expect(card!.phase).toBe('result'); // never a phantom "Running" after reload
    expect(Date.parse(card!.completedAt || '')).toBeGreaterThan(0); // the use→result transition measured it
  });

  it('does not invent a timing measurement for a result that had no recorded use phase', () => {
    const provider = providerWith();
    provider.appendToolActivity(agent.id, { phase: 'result', callId: 'call-write_file', name: 'write_file', outcome: { status: 'refused', observedBy: 'host', reason: 'consent' } });
    const [card] = ((provider as any).transcriptItems(agent.id) as Array<{ kind: string; completedAt?: string }>)
      .filter((item) => item.kind === 'tool');
    expect(card.completedAt).toBeUndefined();
  });

  it('keeps the time a person took to decide during a call on its card, across a reload', () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'c1', name: 'list_dir', input: { path: '.' } });
    provider.appendToolActivity(agent.id, {
      phase: 'result', callId: 'c1', name: 'list_dir', outcome: { status: 'success', observedBy: 'host' }, summary: 'Listed', humanWaitMs: 40_000,
    });
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'c2', name: 'read_file', input: { path: 'a' } });
    provider.appendToolActivity(agent.id, {
      phase: 'result', callId: 'c2', name: 'read_file', outcome: { status: 'success', observedBy: 'host' }, summary: 'Read', humanWaitMs: Number.NaN,
    });

    const reloaded = new ChatViewProvider({} as never, deps);
    const cards = (reloaded as any).transcriptItems(agent.id).filter((item: { kind: string }) => item.kind === 'tool');
    expect(cards.map((card: { humanWaitMs?: number }) => card.humanWaitMs)).toEqual([40_000, undefined]);
  });

  it('does not persist a tool card that never finished', () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-run_command', name: 'run_command', input: { command: 'npm test' } });

    const reloaded = new ChatViewProvider({} as never, deps);
    const items = (reloaded as any).transcriptItems(agent.id) as Array<{ kind: string }>;
    expect(items.some((i) => i.kind === 'tool')).toBe(false);
  });

  it('clearing the selected agent also wipes its persisted tool cards', () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    provider.appendToolActivity(agent.id, { phase: 'result', callId: 'call-write_file', name: 'write_file', outcome: { status: 'success', observedBy: 'host' }, summary: 'Wrote', diff: '+x' });
    provider.clearSelectedAgent();

    const reloaded = new ChatViewProvider({} as never, deps);
    const items = (reloaded as any).transcriptItems(agent.id) as Array<{ kind: string }>;
    expect(items.some((i) => i.kind === 'tool')).toBe(false);
  });

  it('posts an unacknowledged steer without clearing its composer draft, then interrupts from Stop', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    const match = html.match(/function selectedIsRunning\(\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    function setMode/);
    expect(match).toBeTruthy();
    const sendAndStop = match![0].replace(/\r?\n\r?\n    function setMode$/, '');
    const posts: unknown[] = [];
    const state = { selectedAgentId: agent.id, runningAgentIds: [agent.id], mode: 'act', agents: [agent] };
    const input = { value: ' steer this turn ' };
    const agentSelect = { value: agent.id };
    const vscode = { postMessage: (msg: unknown) => posts.push(msg) };

    const fn = new Function('state', 'input', 'agentSelect', 'vscode', 'setTimeout', `const draftsByAgent = {}; let draftRevision = 0; const MAX_AGENT_DRAFTS = 20; let pendingSend; let unconfirmedSend; let attachmentGeneration = 0; const SEND_ACK_TIMEOUT_MS = 10000; let sendRequestSequence = 0; const sendStatus = {}; function pruneDrafts() {} function nextSendRequestId() { sendRequestSequence += 1; return 'send-' + sendRequestSequence; } function setSendStatus() {}\n${sendAndStop}\nsend();\nstop();`);
    fn(state, input, agentSelect, vscode, () => 0);

    expect(posts[0]).toMatchObject({
      command: 'send',
      agentId: agent.id,
      text: 'steer this turn',
      mode: 'act',
      attachments: [],
      requestId: expect.stringMatching(/^send-[a-z0-9]+-1$/),
    });
    expect(posts[1]).toEqual({ command: 'interrupt', agentId: agent.id });
    expect(input.value).toBe(' steer this turn ');
  });

  it('keeps a composer draft until its exact host acknowledgement', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    const match = html.match(/function setSendStatus\(message\) \{[\s\S]*?\n    \}\n\n    function stop/);
    expect(match).toBeTruthy();
    const composerSend = match![0].replace(/\n\n    function stop$/, '');
    const posts: any[] = [];
    const saved: any[] = [];
    const input: any = { value: 'do not lose this', style: {}, focus: vi.fn() };
    const sendStatus: any = { textContent: '', hidden: true };
    const state = { selectedAgentId: agent.id, mode: 'act' };
    const agentSelect = { value: agent.id };
    const vscode = {
      postMessage: (message: any) => posts.push(message),
      getState: () => ({}),
      setState: (next: any) => saved.push(next),
    };
    const run = new Function('state', 'input', 'agentSelect', 'sendStatus', 'vscode', 'posts', 'saved', `
      const MAX_AGENT_DRAFTS = 20;
      let draftRevision = 0;
      const draftsByAgent = {};
      let pendingAttachments = [];
      let pendingSend;
      let unconfirmedSend;
      let attachmentGeneration = 0;
      const SEND_ACK_TIMEOUT_MS = 10000;
      let sendRequestSequence = 0;
      function pruneDrafts() {}
      function persistUiState(agentId, drop) {
        if (drop || !input.value) delete draftsByAgent[agentId];
        else draftsByAgent[agentId] = { text: input.value, editedAt: 1 };
        vscode.setState({ draftsByAgent });
      }
      function resetComposerHeight() {}
      function renderAttachmentChips() {}
      function setAttachmentStatus() {}
      ${composerSend}
      send();
      const request = posts[0];
      rejectComposerSend({ requestId: request.requestId, reason: 'That agent is no longer available. Your message was kept.' });
      const afterReject = { value: input.value, status: sendStatus.textContent, draft: draftsByAgent['agent-1']?.text };
      send();
      acceptComposerSend({ requestId: posts[1].requestId });
      return { afterReject, afterAccept: input.value, saved };
    `);

    const result = run(state, input, agentSelect, sendStatus, vscode, posts, saved);
    expect(result.afterReject).toEqual({
      value: 'do not lose this',
      status: 'That agent is no longer available. Your message was kept.',
      draft: 'do not lose this',
    });
    expect(result.afterAccept).toBe('');
    expect(result.saved.at(-1).draftsByAgent).toEqual({});
  });

  // F7-13 (v0.9.88): the extension host restarted under a live chat; nobody answered the send, and the composer
  // sat on "Sending…" for ever. The webview now gives the composer back, and a late answer is generation-safe.
  function composerHarness() {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    const match = html.match(/function setSendStatus\(message\) \{[\s\S]*?\n    \}\n\n    function stop/);
    expect(match).toBeTruthy();
    const composerSend = match![0].replace(/\n\n    function stop$/, '');
    const posts: any[] = [];
    const timers: Array<() => void> = [];
    const input: any = { value: 'first draft', style: {}, focus: vi.fn() };
    const sendStatus: any = { textContent: '', hidden: true };
    const env = { state: { selectedAgentId: agent.id, mode: 'act' }, agentSelect: { value: agent.id } };
    const api = new Function('state', 'input', 'agentSelect', 'sendStatus', 'vscode', 'setTimeout', 'clearTimeout', `
      const MAX_AGENT_DRAFTS = 20;
      let draftRevision = 0;
      const draftsByAgent = {};
      let pendingAttachments = [];
      let pendingSend;
      let unconfirmedSend;
      let attachmentGeneration = 0;
      let knownHostInstanceId;
      const SEND_ACK_TIMEOUT_MS = 10000;
      const SEND_UNCONFIRMED_NOTICE = 'UnodeAi did not confirm this message. Your draft was kept. If it does not appear above, send it again. If this keeps happening, reload the window.';
      let sendRequestSequence = 0;
      function pruneDrafts() {}
      function persistUiState(agentId, drop) {
        if (drop || !input.value) delete draftsByAgent[agentId];
        else { draftRevision += 1; draftsByAgent[agentId] = { text: input.value, editedAt: draftRevision }; }
      }
      function resetComposerHeight() {}
      function renderAttachmentChips() {}
      function setAttachmentStatus() {}
      ${composerSend}
      return {
        send, acceptComposerSend, rejectComposerSend, noteHostInstance,
        edit(text) { input.value = text; persistUiState(agentSelect.value); },
      };
    `)(env.state, input, env.agentSelect, sendStatus, { postMessage: (message: any) => posts.push(message) },
      (callback: () => void) => { timers.push(callback); return timers.length; }, () => undefined);
    return { api, posts, timers, input, sendStatus };
  }

  it('gives the composer back with the draft when no acknowledgement arrives, and never resends', () => {
    const { api, posts, timers, input, sendStatus } = composerHarness();
    api.send();
    expect(sendStatus.textContent).toBe('Sending…');
    timers[0]();
    expect(input.value).toBe('first draft');
    expect(sendStatus.textContent).toMatch(/^UnodeAi did not confirm this message\. Your draft was kept\./);
    expect(posts).toHaveLength(1);
    // The composer is usable again: the person can send it themselves.
    api.send();
    expect(posts).toHaveLength(2);
    expect(posts[1].requestId).not.toBe(posts[0].requestId);
  });

  it('clears the composer on a late acknowledgement only when it still holds exactly what was sent', () => {
    const unchanged = composerHarness();
    unchanged.api.send();
    unchanged.timers[0]();
    unchanged.api.acceptComposerSend({ requestId: unchanged.posts[0].requestId });
    expect(unchanged.input.value).toBe('');
    expect(unchanged.sendStatus.textContent).toBe('');

    // Edit, then edit back to the same text: still a change, so the late acknowledgement keeps the draft.
    const edited = composerHarness();
    edited.api.send();
    edited.timers[0]();
    edited.api.edit('first draft, more');
    edited.api.edit('first draft');
    edited.api.acceptComposerSend({ requestId: edited.posts[0].requestId });
    expect(edited.input.value).toBe('first draft');
    expect(edited.sendStatus.textContent).toBe('');

    // A newer send is pending: the older acknowledgement never clears it.
    const resent = composerHarness();
    resent.api.send();
    resent.timers[0]();
    resent.api.send();
    resent.api.acceptComposerSend({ requestId: resent.posts[0].requestId });
    expect(resent.input.value).toBe('first draft');
  });

  it('resolves a pending send at once when a state arrives from a different host instance', () => {
    const { api, sendStatus, input } = composerHarness();
    api.noteHostInstance({ hostInstanceId: 'host-a' });
    api.send();
    api.noteHostInstance({ hostInstanceId: 'host-a' });
    expect(sendStatus.textContent).toBe('Sending…');
    api.noteHostInstance({ hostInstanceId: 'host-b' });
    expect(sendStatus.textContent).toMatch(/^UnodeAi did not confirm this message/);
    expect(input.value).toBe('first draft');
  });

  it('acknowledges Stop locally when the backend does not reply synchronously', () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    provider.appendDelta(agent.id, 'working', 1);

    (provider as any).onMessage({ command: 'interrupt', agentId: agent.id });

    expect(deps.interrupt).toHaveBeenCalledWith(agent.id);
    const state = (provider as any).currentState();
    expect(state.runningAgentIds).toEqual([]);
    const last = state.messages.at(-1);
    expect(last).toMatchObject({
      kind: 'message',
      role: 'agent',
      text: 'Stopped by user.',
      fromName: 'UnodeAi',
    });
  });

  it('keeps the text a stopped turn already streamed, followed by the Stop notice (field finding F5)', () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    provider.appendDelta(agent.id, 'The history of compilers begins with', 1);

    (provider as any).onMessage({ command: 'interrupt', agentId: agent.id });

    const texts = (provider as any).currentState().messages.map((m: { text?: string }) => m.text);
    const partial = texts.indexOf('The history of compilers begins with');
    expect(partial).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf('Stopped by user.')).toBeGreaterThan(partial);
  });

  it('drops stale deltas after Stop bumps the epoch, then accepts the next turn', () => {
    const deps = depsFor();
    const provider = providerWith(deps);

    provider.appendDelta(agent.id, 'old turn', 1);
    (provider as any).onMessage({ command: 'interrupt', agentId: agent.id });
    provider.appendDelta(agent.id, ' stale', 1);

    let state = (provider as any).currentState();
    expect(JSON.stringify(state.messages)).not.toContain('stale');
    expect(state.turnEpochs[agent.id]).toBe(2);

    provider.appendDelta(agent.id, 'new turn', 3);
    state = (provider as any).currentState();
    expect(state.turnEpochs[agent.id]).toBe(3);
    expect(JSON.stringify(state.messages)).toContain('new turn');
  });

  it('does not bump the epoch for Steer, so same-turn continuation tokens still land', () => {
    const deps = depsFor();
    const provider = providerWith(deps);

    provider.appendDelta(agent.id, 'working', 1);
    (provider as any).onMessage({ command: 'send', agentId: agent.id, text: ' steer ', mode: 'act' });
    provider.appendDelta(agent.id, ' continued', 1);

    expect(deps.interject).toHaveBeenCalledWith(agent.id, 'steer');
    expect(deps.send).not.toHaveBeenCalled();
    const state = (provider as any).currentState();
    expect(state.turnEpochs[agent.id]).toBe(1);
    expect(JSON.stringify(state.messages)).toContain('working continued');
  });

  it('clear bumps the epoch so stale in-flight deltas do not recreate a live bubble', () => {
    const provider = providerWith();

    provider.appendDelta(agent.id, 'before clear', 1);
    provider.clearSelectedAgent();
    provider.appendDelta(agent.id, 'stale after clear', 1);

    let state = (provider as any).currentState();
    expect(state.turnEpochs[agent.id]).toBe(2);
    expect(JSON.stringify(state.messages)).not.toContain('stale after clear');

    provider.appendDelta(agent.id, 'fresh after clear', 3);
    state = (provider as any).currentState();
    expect(JSON.stringify(state.messages)).toContain('fresh after clear');
  });

  it('prunes turn epochs when an agent is removed, without clearing surviving agents', () => {
    const other: ChatAgent = { id: 'agent-2', name: 'Reviewer', role: 'Reviewer', backend: 'openai' };
    let roster = [agent, other];
    const deps = { ...depsFor(), listAgents: () => roster } as ChatViewDeps;
    const provider = new ChatViewProvider({} as never, deps);

    provider.appendDelta(agent.id, 'keep me', 1);
    provider.appendDelta(other.id, 'remove me', 1);
    expect((provider as any).turnEpochs.has(agent.id)).toBe(true);
    expect((provider as any).turnEpochs.has(other.id)).toBe(true);

    roster = [agent];
    provider.clearAgent(other.id);

    expect((provider as any).turnEpochs.has(agent.id)).toBe(true);
    expect((provider as any).turnEpochs.has(other.id)).toBe(false);
  });
});

describe('ChatViewProvider Solo handoff', () => {
  const pm: ChatAgent = { id: 'pm', name: 'PM', role: 'pm', backend: 'openai' };
  const solo: ChatAgent = { id: 'solo', name: 'Solo', role: 'solo', backend: 'openai' };

  it('does not infer a Solo routing suggestion from a user command', () => {
    const deps = depsFor([pm, solo]);
    const provider = new ChatViewProvider({} as never, deps);
    provider.selectAgent(pm.id);

    (provider as any).onMessage({ command: 'send', agentId: pm.id, text: '看 docs/brief.docx 和 slides/方案.pptx，按要求修改。', mode: 'act' });

    expect((provider as any).transcriptItems(pm.id).some((item: { kind: string }) => item.kind === 'soloSuggestion')).toBe(false);
    expect(deps.send).toHaveBeenCalledWith(pm.id, expect.any(String), 'act', [], expect.any(Number));
  });

  it('keeps a human-requested handoff executable without classifying the message text', () => {
    const deps = depsFor([pm, solo]);
    const provider = new ChatViewProvider({} as never, deps);
    provider.selectAgent(pm.id);
    (provider as any).suggestSoloHandoff(pm.id, solo.id, 'Update src/format.ts to trim trailing spaces.', 'act', 1);

    const [id] = Array.from((provider as any).soloSuggestions.keys()) as string[];
    (provider as any).onMessage({ command: 'handoffToSolo', id });
    expect(deps.send).toHaveBeenLastCalledWith(solo.id, 'Update src/format.ts to trim trailing spaces.', 'act', [], expect.any(Number));
    expect((provider as any).getSelectedAgentId()).toBe(solo.id);
  });
});

describe('ChatViewProvider context manifest card', () => {
  it('places the estimated source summary beside its user turn and keeps unknown fields explicit', () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    (provider as any).onMessage({ command: 'send', agentId: agent.id, text: 'Inspect src/app.ts', mode: 'act' });
    provider.setContextManifest(agent.id, {
      schemaVersion: 1,
      sourceCount: 1,
      totalBytes: 72,
      estimatedTextTokens: 18,
      tokenEstimateLabel: 'Estimated from text bytes (bytes / 4); non-text sources excluded',
      entries: [{
        kind: 'user-request', label: 'Current task', location: 'chat', bytes: 72,
        estimatedTokens: 18, tokenEstimate: 'bytes / 4', reason: 'message routed to this agent',
        staleness: 'unpopulated', sensitivity: 'unpopulated',
      }],
    }, 1);

    const items = (provider as any).transcriptItems(agent.id) as Array<{ kind: string; manifest?: { estimatedTextTokens: number } }>;
    expect(items.find((item) => item.kind === 'contextManifest')?.manifest?.estimatedTextTokens).toBe(18);
    const html = (provider as any).getHtml({ cspSource: 'test:' });
    // The receipt must name its own scope. Reported 2026-08-11: "~9,147 text tokens" sat beside a gateway
    // rejecting the turn as too large, and the two appeared to contradict each other. They measured
    // different things; only the error said which.
    expect(html).toContain("'Attached context: '");
    expect(html).toContain("' text tokens (estimate, attached sources only)'");
    expect(html).not.toContain("'Context: ' + count + ' sources'");
    expect(html).toContain("entry.staleness === 'unchanged-90-days-or-more'");
    expect(html).toContain("entry.sensitivity === 'potentially-sensitive'");
  });
});

describe('ChatViewProvider archive', () => {
  const seed = (provider: ChatViewProvider, text: string) =>
    (provider as any).append(agent.id, { role: 'user', text, ts: new Date().toISOString() });

  it('archives the selected transcript (saved) then wipes the live view', () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    seed(provider, 'remember this');

    const count = provider.archiveSelectedAgent();
    expect(count).toBe(1);

    // Saved: one archive entry holding the message.
    const archives = provider.listArchivedChats();
    expect(archives).toHaveLength(1);
    expect(archives[0].agentId).toBe(agent.id);
    expect(archives[0].messages[0].text).toBe('remember this');

    // Hidden: a reloaded provider over the same store shows no live transcript for the agent.
    const reloaded = new ChatViewProvider({} as never, deps);
    const items = (reloaded as any).transcriptItems(agent.id) as Array<{ kind: string }>;
    expect(items.some((i) => i.kind === 'message')).toBe(false);
  });

  it('archiving an empty chat is a no-op (nothing saved)', () => {
    const provider = providerWith();
    expect(provider.archiveSelectedAgent()).toBe(0);
    expect(provider.listArchivedChats()).toHaveLength(0);
  });

  it('restores an archived chat back into its agent and drops it from the archive', () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    seed(provider, 'bring me back');
    provider.archiveSelectedAgent();

    const archiveId = provider.listArchivedChats()[0].id;
    const result = provider.restoreArchive(archiveId);
    expect(result.ok).toBe(true);
    expect(provider.getMessageCount(agent.id)).toBe(1);
    expect(provider.listArchivedChats()).toHaveLength(0); // it's live again, no longer archived
  });

  it("refuses to restore into an agent that's no longer on the team", () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    seed(provider, 'orphan me');
    provider.archiveSelectedAgent();
    const archiveId = provider.listArchivedChats()[0].id;

    // A new provider whose roster no longer contains the agent, sharing the same store.
    const goneDeps = { ...deps, listAgents: () => [] as ChatAgent[] } as ChatViewDeps;
    const goneProvider = new ChatViewProvider({} as never, goneDeps);
    const result = goneProvider.restoreArchive(archiveId);
    expect(result).toEqual({ ok: false, reason: 'agent-gone' });
    expect(goneProvider.listArchivedChats()).toHaveLength(1); // not consumed on failure
  });
});

// Tool cards used to render their input/output inline, so a turn with many tool calls pushed the actual
// reply off-screen. Each card now shows only its title row, with a chevron that reveals the rest — except
// a blocked call, whose error is the whole reason to look at the card.
describe('ChatViewProvider streamed turn segmentation', () => {
  const reply = (provider: ChatViewProvider, text: string, isError = false) =>
    (provider as any).onReply({ from: agent.id, fromName: agent.name, text, isError });

  const items = (provider: ChatViewProvider) =>
    (provider as any).transcriptItems(agent.id) as Array<{ kind: string; role?: string; text?: string; live?: boolean; name?: string }>;

  const messages = (provider: ChatViewProvider) =>
    items(provider).filter((item) => item.kind === 'message' && item.role === 'agent');

  it('flushes each narration/reasoning segment before the visible tool card', () => {
    const provider = providerWith();

    provider.appendReasoning(agent.id, 'The user wants section 9 added. Let me read the file first.');
    provider.appendDelta(agent.id, "I'll read PROPOSAL.md first.");
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-read_file', name: 'read_file', input: { path: 'PROPOSAL.md' } });
    provider.appendToolActivity(agent.id, { phase: 'result', callId: 'call-read_file', name: 'read_file', outcome: { status: 'success', observedBy: 'host' }, summary: 'read 581 lines' });
    provider.appendReasoning(agent.id, 'Now renumber 6->7, then insert Section 9.');
    provider.appendDelta(agent.id, 'Now I will renumber the sections.');
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-write_file', name: 'write_file', input: { path: 'PROPOSAL.md' } });
    provider.appendToolActivity(agent.id, { phase: 'result', callId: 'call-write_file', name: 'write_file', outcome: { status: 'success', observedBy: 'host' }, summary: 'wrote 12 KB' });
    reply(provider, 'Done. 13 sections.');

    const transcript = items(provider);
    expect(transcript.map((item) => item.kind)).toEqual([
      'reasoning',
      'message',
      'tool',
      'reasoning',
      'message',
      'tool',
      'message',
    ]);
    expect(transcript[1]).toMatchObject({ kind: 'message', text: "I'll read PROPOSAL.md first." });
    expect(transcript[4]).toMatchObject({ kind: 'message', text: 'Now I will renumber the sections.' });
  });

  it('does not render whitespace-only reasoning and bounds blank reasoning lines', () => {
    const provider = providerWith();

    provider.appendReasoning(agent.id, `\n${'  \n'.repeat(200)}`);
    expect(items(provider).filter((item) => item.kind === 'reasoning')).toEqual([]);

    provider.appendReasoning(agent.id, `\n\n- inspect${'\n'.repeat(200)}- run`);
    (provider as any).finalizeReasoning(agent.id);
    expect(items(provider).filter((item) => item.kind === 'reasoning')).toEqual([
      expect.objectContaining({ text: '- inspect\n\n- run' }),
    ]);
  });

  // Field run of v0.9.92: an Analysis card read "Reviewing documentation report requirementsChecking for
  // existing review report" on one line. The gateway relays each part of a reasoning summary as a bold title
  // and puts nothing between two parts.
  it('starts a paragraph for a reasoning title that follows another with nothing between them', () => {
    const reasoningText = (deltas: string[]): string => {
      const provider = providerWith();
      for (const delta of deltas) provider.appendReasoning(agent.id, delta);
      (provider as any).finalizeReasoning(agent.id);
      const [card] = items(provider).filter((item) => item.kind === 'reasoning');
      return (card as { text: string }).text;
    };

    // One delta per part, the markers split over deltas, and both parts in one delta.
    expect(reasoningText(['**Reviewing requirements**', '**Checking for a report**']))
      .toBe('**Reviewing requirements**\n\n**Checking for a report**');
    expect(reasoningText(['**Verifying*', '*', '*', '*Planning**', '**Deciding**']))
      .toBe('**Verifying**\n\n**Planning**\n\n**Deciding**');
    expect(reasoningText(['**One****Two**'])).toBe('**One**\n\n**Two**');
    // A title already followed by a break gets no second one, and a body keeps its own line.
    expect(reasoningText(['**One**\n\n', '**Two**\n\nIts body.'])).toBe('**One**\n\n**Two**\n\nIts body.');
    // Not titles: bold inside a sentence, bold and italic together, and an operator.
    expect(reasoningText(['Use **a** and **b** here.'])).toBe('Use **a** and **b** here.');
    expect(reasoningText(['***both***', ' then **bold**.'])).toBe('***both*** then **bold**.');
    expect(reasoningText(['x = 2**3**', '4'])).toBe('x = 2**3**4');
  });

  it('persists flushed message and reasoning segments across a fresh provider', () => {
    const deps = depsFor();
    const provider = providerWith(deps);

    provider.appendReasoning(agent.id, 'Read first.');
    provider.appendDelta(agent.id, 'I will read first.');
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-read_file', name: 'read_file', input: { path: 'PROPOSAL.md' } });
    provider.appendToolActivity(agent.id, { phase: 'result', callId: 'call-read_file', name: 'read_file', outcome: { status: 'success', observedBy: 'host' }, summary: 'read' });

    const reloaded = new ChatViewProvider({} as never, deps);
    const transcript = items(reloaded);
    expect(transcript.some((item) => item.kind === 'reasoning' && item.text === 'Read first.')).toBe(true);
    expect(transcript.some((item) => item.kind === 'message' && item.text === 'I will read first.')).toBe(true);
  });

  // v0.9.88 (Codex audit round 1, finding 5): a repeated segment is promoted in place only when nothing followed
  // it. Promoting one that a tool card followed would put the conclusion before the work it concludes.
  it('appends the conclusion after the tool card when the final reply repeats a segment that a tool followed', () => {
    const provider = providerWith();

    provider.appendDelta(agent.id, 'Let me fix that.');
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-write_file', name: 'write_file', input: { path: 'a.txt' } });
    reply(provider, 'Let me fix that.');

    const all = items(provider) as Array<{ kind: string; text?: string; turnFinal?: true }>;
    expect(all.map((item) => item.kind)).toEqual(['message', 'tool', 'message']);
    expect(all[0]).toMatchObject({ text: 'Let me fix that.' });
    expect(all[0].turnFinal).toBeUndefined();
    expect(all[2]).toMatchObject({ text: 'Let me fix that.', turnFinal: true });
  });

  it('promotes a repeated segment in place when it is the turn\'s last item, so its footer is not lost', () => {
    const provider = providerWith();

    provider.appendDelta(agent.id, 'All done.');
    (provider as any).flushLiveMessage(agent.id);
    (provider as any).onReply({
      from: agent.id, fromName: agent.name, text: 'All done.', isError: false,
      turnId: 'turn-1', delegationReceipt: { accepted: 1, refused: 0, pending: 0 },
      timing: { startedAt: '2026-09-26T00:00:00.000Z', settledAt: '2026-09-26T00:00:39.000Z', durationMs: 39_000, approvalWaitMs: 0 },
    });

    const all = messages(provider) as Array<{ text?: string; turnFinal?: true; turnId?: string; delegationReceipt?: unknown; turnTiming?: unknown }>;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      text: 'All done.',
      turnFinal: true,
      turnId: 'turn-1',
      delegationReceipt: { accepted: 1, refused: 0, pending: 0 },
      turnTiming: { durationMs: 39_000 },
    });
  });

  it('v0.9.91: keeps the turn outcome receipt on the stored conclusion, and never sends it to the webview', () => {
    const turn = new TurnOutcomeAccumulator();
    turn.use('call-1');
    turn.result('call-1', { status: 'refused', observedBy: 'host', reason: 'consent' });
    const turnOutcome = turn.finish({
      turnId: 'turn-9', agentId: agent.id, recordedAt: '2026-09-30T10:00:00.000Z', delivery: { kind: 'reply' },
    })!;
    for (const promoted of [false, true]) {
      const provider = providerWith();
      if (promoted) {
        provider.appendDelta(agent.id, 'Done.');
        (provider as any).flushLiveMessage(agent.id);
      }
      (provider as any).onReply({ from: agent.id, fromName: agent.name, text: 'Done.', isError: false, turnId: 'turn-9', turnOutcome });

      const stored = (provider as any).loadHistory(agent.id) as Array<{ turnFinal?: true; turnOutcome?: unknown }>;
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ turnFinal: true, turnOutcome });
      expect(messages(provider)[0]).not.toHaveProperty('turnOutcome');
    }
  });

  it('marks only the reply that ends a turn, never the segments flushed before tool calls', () => {
    const provider = providerWith();

    provider.appendDelta(agent.id, 'I will read the file now.');
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-read_file', name: 'read_file', input: { path: 'a.txt' } });
    provider.appendToolActivity(agent.id, { phase: 'result', callId: 'call-read_file', name: 'read_file', outcome: { status: 'success', observedBy: 'host' }, summary: 'read' });
    provider.appendDelta(agent.id, 'Showing the final content.');
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-publish_content_receipt', name: 'publish_content_receipt', input: {} });
    provider.appendToolActivity(agent.id, { phase: 'result', callId: 'call-publish_content_receipt', name: 'publish_content_receipt', outcome: { status: 'success', observedBy: 'host' }, summary: 'ok' });
    reply(provider, 'The file now reads: first version / rework ok.');

    const agentMessages = messages(provider) as Array<{ text?: string; turnFinal?: true }>;
    expect(agentMessages.map((item) => item.turnFinal === true)).toEqual([false, false, true]);
  });

  // F7-20 (v0.9.88): restored cards return to their places from durable times, not to the next render point.
  it('places restored delegation cards by their start time among persisted items, older ones first', () => {
    const provider = providerWith();
    const at = (minute: number) => `2026-09-26T10:${String(minute).padStart(2, '0')}:00.000Z`;
    const history = [
      { role: 'user', text: 'Request A', ts: at(0), seq: 0 },
      { role: 'agent', text: 'Dispatched A.', ts: at(2), seq: 1, turnFinal: true },
      { role: 'user', text: 'Request B', ts: at(5), seq: 2 },
      { role: 'agent', text: 'Dispatched B.', ts: at(7), seq: 3, turnFinal: true },
    ];
    (provider as any).presentation.replaceTranscript(agent.id, history);
    const card = (id: string, startedAt: string) => ({
      id, restored: true, coordinatorId: agent.id, coordinatorName: agent.name, startedAt,
      total: 1, done: 1, partial: 0, blocked: 0, working: 0, items: [],
    });
    provider.setDelegationProgress([
      card('delegation-run-older', '2026-09-26T09:00:00.000Z'),
      card('delegation-run-a', at(1)),
      card('delegation-run-b', at(6)),
    ] as never);

    const order = ((provider as any).transcriptItems(agent.id) as Array<{ kind: string; text?: string; id?: string }>)
      .map((item) => item.kind === 'delegation' ? item.id : item.text);
    expect(order).toEqual([
      'delegation-run-older',
      'Request A',
      'delegation-run-a',
      'Dispatched A.',
      'Request B',
      'delegation-run-b',
      'Dispatched B.',
    ]);
  });

  // Field test 2026-09-26: a worker's chat opened after the PM's runs showed every live card after all of the
  // worker's messages, as if the chat had no ending. Live cards now take the same time-derived places.
  it('places live cards by time in a chat first opened after later messages, the same as after a reload', () => {
    const worker: ChatAgent = { id: 'agent-2', name: 'Frontend Engineer', role: 'Developer', backend: 'openai' };
    const provider = providerWith(depsFor([agent, worker]));
    const at = (minute: number) => `2026-09-26T10:${String(minute).padStart(2, '0')}:00.000Z`;
    (provider as any).presentation.replaceTranscript(worker.id, [
      { role: 'user', text: 'Task A', ts: at(1), seq: 0 },
      { role: 'agent', text: 'Did A.', ts: at(2), seq: 1, turnFinal: true },
      { role: 'user', text: 'Task B', ts: at(6), seq: 2 },
      { role: 'agent', text: 'Did B.', ts: at(7), seq: 3, turnFinal: true },
    ]);
    const card = (id: string, startedAt: string) => ({
      id, coordinatorId: agent.id, coordinatorName: agent.name, startedAt,
      total: 1, done: 1, partial: 0, blocked: 0, working: 0,
      items: [{ id: `${id}-item`, coordinatorId: agent.id, coordinatorName: agent.name, agentId: worker.id, agentName: worker.name, status: 'done', startedAt, stepCount: 1 }],
    });
    // Live cards (not restored), first rendered in the worker's chat only now.
    provider.setDelegationProgress([card('delegation-run-a', at(0)), card('delegation-run-b', at(5))] as never);

    const order = ((provider as any).transcriptItems(worker.id) as Array<{ kind: string; text?: string; id?: string }>)
      .map((item) => item.kind === 'delegation' ? item.id : item.text);
    expect(order).toEqual(['delegation-run-a', 'Task A', 'Did A.', 'delegation-run-b', 'Task B', 'Did B.']);
  });

  it('patches a late delegation receipt into the reply of its turn without appending or stopping anything', () => {
    const provider = providerWith();
    (provider as any).onReply({
      from: agent.id, fromName: agent.name, text: 'Dispatched and waiting.', isError: false, epoch: 1,
      turnId: 'turn-7', delegationReceipt: { accepted: 0, refused: 0, pending: 1 },
    });
    (provider as any).onReply({
      from: agent.id, fromName: agent.name, text: 'Answered a follow-up.', isError: false, epoch: 2,
      turnId: 'turn-8', delegationReceipt: { accepted: 0, refused: 0, pending: 0 },
    });
    // The coordinator starts its next turn before turn 7's queued dispatch is admitted.
    provider.appendDelta(agent.id, 'Working on the next step.');
    expect((provider as any).runningAgentIds.has(agent.id)).toBe(true);

    provider.updateTurnReceipt(agent.id, 'turn-7', { accepted: 1, refused: 0, pending: 0 });
    provider.updateTurnReceipt(agent.id, 'unknown-turn', { accepted: 9, refused: 9, pending: 9 });

    const finalized = (provider as any).loadHistory(agent.id) as Array<{ text: string; turnId?: string; delegationReceipt?: unknown }>;
    expect(finalized.map((message) => [message.turnId, message.delegationReceipt])).toEqual([
      ['turn-7', { accepted: 1, refused: 0, pending: 0 }],
      ['turn-8', { accepted: 0, refused: 0, pending: 0 }],
    ]);
    expect((provider as any).runningAgentIds.has(agent.id)).toBe(true);
  });

  // Field report, 2026-08-09: a long PM summary was re-sent because the user could not see it, and it
  // vanished again with no trace. The dedup compared text alone, so a deliberate second statement in a
  // later turn was indistinguishable from a gateway emitting one turn's text twice.
  it('keeps an identical reply that belongs to a later turn, and drops one that repeats the same turn', () => {
    const provider = providerWith();
    const summary = 'Round summary: 4 delegations, 3 accepted, 1 needs-rework.';
    const send = (text: string, epoch: number) =>
      (provider as any).onReply({ from: agent.id, fromName: agent.name, text, epoch });

    send(summary, 1);
    send(summary, 1);   // same turn — a double-emit, correctly suppressed
    expect(messages(provider).map((item) => item.text)).toEqual([summary]);

    send(summary, 2);   // a later turn — a deliberate resend, and it must survive
    expect(messages(provider).map((item) => item.text)).toEqual([summary, summary]);
  });

  // A gateway rejected a turn on 2026-08-10 with "exceeds the context window of this model" while UnodeAi
  // was compacting against an assumed 1,048,576. The number was invisible, so nobody could see the
  // assumption was wrong. The meter shows it, and the same control acts on it.
  it('surfaces context usage and compacts on request', () => {
    const compacted: string[] = [];
    const provider = providerWith({
      ...depsFor(),
      contextMeter: () => ({
        kind: 'usage' as const,
        usage: { tokens: 900_000, window: 1_048_576, ratio: 0.86, source: 'assumed' as const },
      }),
      compactContext: (id: string) => compacted.push(id),
    });

    const state = (provider as any).currentState();
    expect(state.contextMeter).toEqual({
      kind: 'usage',
      usage: { tokens: 900_000, window: 1_048_576, ratio: 0.86, source: 'assumed' },
    });

    (provider as any).onMessage({ command: 'compactContext' });
    expect(compacted).toEqual([agent.id]);
  });

  // Compaction calls a summarizer model, so it runs for seconds. The transcript used to say nothing for all
  // of it and then print an outcome — the same silence that made an unlabelled control read as broken. A
  // user who pressed a button is owed an acknowledgement immediately, not an outcome eventually.
  it('says a compaction started before it knows how it ended', async () => {
    let settle: (() => void) | undefined;
    const provider = providerWith({
      ...depsFor(),
      compactContext: () => new Promise<void>((resolve) => { settle = () => resolve(); }),
    });

    (provider as any).onMessage({ command: 'compactContext' });

    const running = ((provider as any).transcriptItems(agent.id) as Array<{ text?: string }>)
      .filter((item) => String(item.text ?? '').includes('Compacting'));
    expect(running).toHaveLength(1);

    settle!();
    await Promise.resolve();
    await Promise.resolve();

    const after = ((provider as any).transcriptItems(agent.id) as Array<{ text?: string }>)
      .filter((item) => String(item.text ?? '').includes('Compacting'));
    expect(after).toHaveLength(0);
  });

  // A compaction that throws must not leave the transcript claiming it is still running.
  it('clears the in-progress marker when the compaction fails', async () => {
    const provider = providerWith({
      ...depsFor(),
      compactContext: () => Promise.reject(new Error('summarizer unreachable')),
    });

    await (provider as any).runCompaction(agent.id).catch(() => undefined);

    const stuck = ((provider as any).transcriptItems(agent.id) as Array<{ text?: string }>)
      .filter((item) => String(item.text ?? '').includes('Compacting'));
    expect(stuck).toHaveLength(0);
  });

  // Reported on 2026-08-11 as "I installed 0.9.50 and there is no Compact button." There was one. It had
  // nothing to say and said nothing — a blank pill, because the runtime could not report and the code that
  // meant to hide it could not: an author `display` rule outranks the user agent's [hidden] rule, so the
  // attribute never took effect. Both halves are asserted here: what the meter SAYS, and that hiding is
  // expressed as a class rather than an attribute the stylesheet defeats.
  it('says why there is no number instead of rendering a blank control', () => {
    const notStarted = providerWith({ ...depsFor(), contextMeter: () => ({ kind: 'not-started' as const }) });
    expect((notStarted as any).currentState().contextMeter).toEqual({ kind: 'not-started' });

    const unsupported = providerWith({ ...depsFor(), contextMeter: () => ({ kind: 'unsupported' as const }) });
    expect((unsupported as any).currentState().contextMeter).toEqual({ kind: 'unsupported' });

    const rendered = webviewViewForTest();
    unsupported.resolveWebviewView(rendered.view as never);
    const html = rendered.view.webview.html as string;
    // Hiding must be a CLASS. The attribute is inert here and asserting its absence is the regression:
    // reintroducing `hidden` would compile, pass every state test, and ship a blank pill again.
    expect(html).toContain('.ctx-meter.is-gone, .composer-actions .ctx-compact.is-gone { display: none; }');
    expect(html).toMatch(/id="ctxCompact"/);
    expect(html).not.toMatch(/id="ctxCompact"[^>]*\shidden[\s>]/);
  });

  // The panel keeps CHAT_HISTORY_LIMIT messages and drops the oldest once full. v0.9.50 announced each drop
  // in the transcript; because the trim runs on EVERY appended message, past the limit that produced one
  // notice per message, forever. A disclosure that repeats on every message is a line the reader learns to
  // skip, sitting between them and their conversation. (Owner, 2026-08-11.) The regression is the ABSENCE:
  // reinstating a per-message notice would look like a disclosure improvement and would restore the noise.
  it('does not narrate the panel limit once per message', () => {
    const provider = providerWith();
    for (let i = 0; i < CHAT_HISTORY_LIMIT + 30; i++) {
      (provider as any).onReply({ from: agent.id, fromName: agent.name, text: `msg ${i}`, epoch: i + 1 });
    }

    const markers = items(provider).filter((item) => item.kind === 'marker');
    expect(markers.filter((m) => /no longer shown in this panel/.test(m.text ?? ''))).toHaveLength(0);
    expect(markers.filter((m) => /kept the most recent/.test(m.text ?? ''))).toHaveLength(0);
  });

  // Track U1. A push that does not arrive is now a fact the extension holds. It is counted, never retried:
  // retrying an unmeasured failure destroys the signal that would tell us whether pushes fail at all.
  it('counts a state push the webview did not receive', async () => {
    const provider = providerWith();
    (provider as any).sidebarView = { visible: true, webview: { postMessage: async () => false } };

    (provider as any).postState();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((provider as any).undeliveredPushCount()).toBeGreaterThan(0);
  });

  it('records the webview report when a later full state omitted rendered transcript text', () => {
    const onRenderedTranscriptDisappearance = vi.fn();
    const provider = providerWith({ ...depsFor(), onRenderedTranscriptDisappearance });
    (provider as any).undeliveredStatePushes = 2;
    (provider as any).lastUndeliveredSurface = 'sidebar';

    (provider as any).onMessage({
      command: 'renderedTranscriptItemsMissing',
      agentId: agent.id,
      cause: 'unexplained',
      previousItemCount: 1,
      nextItemCount: 0,
      missing: [{ id: 'msg:7', delivery: 'committed' }],
      previousTurnEpoch: 7,
      nextTurnEpoch: 8,
      epochChanged: true,
    }, 'workbench');

    expect(onRenderedTranscriptDisappearance).toHaveBeenCalledWith(expect.objectContaining({
      source: 'workbench', agentId: agent.id, cause: 'unexplained', previousItemCount: 1, nextItemCount: 0,
      missing: [{ id: 'msg:7', delivery: 'committed' }],
      previousTurnEpoch: 7, nextTurnEpoch: 8, epochChanged: true,
      undeliveredStatePushes: 2, lastUndeliveredSurface: 'sidebar',
    }));
    expect((provider as any).renderedTranscriptDisappearanceLog()).toHaveLength(1);
  });

  it('counts a classified FIFO window trim without waking or evicting unexplained observations', () => {
    const onRenderedTranscriptDisappearance = vi.fn();
    const provider = providerWith({ ...depsFor(), onRenderedTranscriptDisappearance });

    (provider as any).onMessage({
      command: 'renderedTranscriptItemsMissing',
      agentId: agent.id,
      cause: 'window-trim',
      previousItemCount: CHAT_HISTORY_LIMIT,
      nextItemCount: CHAT_HISTORY_LIMIT,
      missing: [{ id: 'msg:oldest', delivery: 'committed' }],
      previousTurnEpoch: 7,
      nextTurnEpoch: 8,
      epochChanged: true,
    }, 'workbench');

    expect((provider as any).renderedTranscriptWindowTrimCount()).toBe(1);
    expect((provider as any).renderedTranscriptDisappearanceLog()).toHaveLength(0);
    expect(onRenderedTranscriptDisappearance).not.toHaveBeenCalled();
  });

  // Field report, 2026-08-10: "I watch it print line by line, then it flashes once and it is all gone."
  // SessionManager bumps the turn epoch when ANY message reaches the session, so a delegate's result waking
  // a PM starts turn N+1 while turn N is still streaming. The higher-epoch event used to clear the rendered
  // text, and turn N's final reply then arrived with the lower epoch and was refused — so nothing put it
  // back. The streamed text is committed before the turn advances.
  it('keeps streamed text when a later turn starts before the reply lands', () => {
    const provider = providerWith();

    provider.appendDelta(agent.id, 'Round summary: 4 delegations, 3 accepted.', 1);
    // A delegate's result reaches the PM and starts turn 2 while turn 1 is still streaming.
    provider.appendDelta(agent.id, 'Picking up the next task.', 2);

    const texts = messages(provider).map((item) => item.text);
    expect(texts).toContain('Round summary: 4 delegations, 3 accepted.');
  });

  // The exact-match half was fixed and tested on its own; the prefix-strip half was not, and it is the
  // shape a coordinator actually produces — it re-sends the summary AND adds the conclusion it was asked
  // for. Stripping the prefix without checking the turn ate the summary and kept only the addition.
  it('keeps a resent summary when a later turn appends to it', () => {
    const provider = providerWith();
    const summary = 'Round summary: 4 delegations, 3 accepted, 1 needs-rework.';
    const send = (text: string, epoch: number) =>
      (provider as any).onReply({ from: agent.id, fromName: agent.name, text, epoch });

    send(summary, 1);
    send(summary + '\n\nConclusion: the round is closed.', 2);

    expect(messages(provider).map((item) => item.text)).toEqual([
      summary,
      summary + '\n\nConclusion: the round is closed.',
    ]);
  });

  // The same shape WITHIN one turn is the flush-then-final case the strip exists for, and must still strip.
  it('still strips the flushed prefix when the final reply belongs to the same turn', () => {
    const provider = providerWith();
    const send = (text: string, epoch: number) =>
      (provider as any).onReply({ from: agent.id, fromName: agent.name, text, epoch });

    send('Let me fix that.', 7);
    send('Let me fix that.\n\nChanges not verified.', 7);

    expect(messages(provider).map((item) => item.text)).toEqual([
      'Let me fix that.',
      'Changes not verified.',
    ]);
  });


  it('appends only the framework suffix when the final reply is the flushed segment plus a note', () => {
    const provider = providerWith();

    provider.appendDelta(agent.id, 'Let me fix that.');
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-write_file', name: 'write_file', input: { path: 'a.txt' } });
    reply(provider, 'Let me fix that.\n\n⚠ Changes not verified: checks were not run.');

    expect(messages(provider).map((item) => item.text)).toEqual([
      'Let me fix that.',
      '⚠ Changes not verified: checks were not run.',
    ]);
  });

  it('orders same-millisecond items by append sequence, not source-array order', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const provider = providerWith();

      provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-read_file', name: 'read_file', input: { path: 'a.txt' } });
      provider.appendReasoning(agent.id, 'Reason after the tool.');
      (provider as any).finalizeReasoning(agent.id);

      const transcript = items(provider);
      expect(transcript.map((item) => item.kind)).toEqual(['tool', 'reasoning']);
      expect(transcript[0]).toMatchObject({ kind: 'tool', name: 'read_file' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps update_todos suppressed without flushing the live segment', () => {
    const provider = providerWith();

    provider.appendDelta(agent.id, 'I will update the plan, then continue.');
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-update_todos', name: 'update_todos', input: { todos: [] } });

    const transcript = items(provider);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      kind: 'message',
      text: 'I will update the plan, then continue.',
      live: true,
    });
    expect((provider as any).loadHistory(agent.id)).toHaveLength(0);
  });
});

describe('read_file receipt parity', () => {
  it('derives Markdown blocks and truncation metadata while keeping the full-file action host-owned', () => {
    const openWorkspaceFile = vi.fn();
    const provider = providerWith({ ...depsFor(), openWorkspaceFile } as ChatViewDeps);
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-read_file', name: 'read_file', input: { path: 'docs/guide.md' } });
    provider.appendToolActivity(agent.id, {
      phase: 'result',
      callId: 'call-read_file',
      name: 'read_file',
      outcome: { status: 'success', observedBy: 'host' },
      summary: 'Markdown content receipt — docs/guide.md (13.7 KB; preview truncated by 9770 chars)',
      detail: '# Guide\n\nUse **carefully**.\n[detail truncated 9770 chars]',
    });

    const tool = ((provider as any).transcriptItems(agent.id) as any[]).find((item) => item.kind === 'tool');
    expect(tool).toMatchObject({
      name: 'read_file',
      canOpenFile: true,
      detailTruncatedChars: 9770,
      title: expect.stringContaining('Markdown content receipt'),
    });
    expect(tool.detailBlocks[0]).toMatchObject({ type: 'heading', level: 1 });

    (provider as any).onMessage({ command: 'openToolFile', agentId: agent.id, toolId: tool.id });
    expect(openWorkspaceFile).toHaveBeenCalledWith(agent.id, 'docs/guide.md');

    (provider as any).onMessage({ command: 'openToolFile', agentId: agent.id, toolId: 'forged-tool-id' });
    (provider as any).onMessage({ command: 'openToolFile', agentId: 'other-agent', toolId: tool.id });
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  it('refuses a real receipt from another valid agent while a different agent is selected', () => {
    const otherAgent: ChatAgent = { ...agent, id: 'agent-2', name: 'Reviewer' };
    const openWorkspaceFile = vi.fn();
    const provider = providerWith({ ...depsFor([agent, otherAgent]), openWorkspaceFile } as ChatViewDeps);

    const appendReadReceipt = (agentId: string, path: string) => {
      provider.appendToolActivity(agentId, { phase: 'use', callId: 'call-read_file', name: 'read_file', input: { path } });
      provider.appendToolActivity(agentId, { phase: 'result', callId: 'call-read_file', name: 'read_file', outcome: { status: 'success', observedBy: 'host' }, summary: `Read ${path}` });
      return ((provider as any).transcriptItems(agentId) as any[]).find((item) => item.kind === 'tool' && item.name === 'read_file');
    };

    const selectedTool = appendReadReceipt(agent.id, 'docs/selected.md');
    const otherTool = appendReadReceipt(otherAgent.id, 'docs/other-agent.md');

    (provider as any).onMessage({ command: 'openToolFile', agentId: otherAgent.id, toolId: otherTool.id });
    expect(openWorkspaceFile).not.toHaveBeenCalled();

    (provider as any).onMessage({ command: 'openToolFile', agentId: agent.id, toolId: selectedTool.id });
    expect(openWorkspaceFile).toHaveBeenCalledExactlyOnceWith(agent.id, 'docs/selected.md');
  });

  it('parses only a host-recorded read_file path and splits the visible truncation receipt', () => {
    expect(readFilePathFromActivity({ name: 'read_file', input: '{"path":"docs/a.md"}' })).toBe('docs/a.md');
    expect(readFilePathFromActivity({ name: 'run_command', input: '{"path":"docs/a.md"}' })).toBeUndefined();
    expect(readFilePathFromActivity({ name: 'read_file', input: 'not-json' })).toBeUndefined();
    expect(splitTruncatedDetail('preview\n[detail truncated 42 chars]')).toEqual({ preview: 'preview', truncatedChars: 42 });
  });

  it('uses the existing structured block renderer and presents truncation together with the editor exit', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    const detailSource = html.match(/function renderToolDetail\(label, text, open, blocks, truncatedChars\) \{[\s\S]*?\n    \}/)?.[0] ?? '';

    expect(detailSource).toContain('details.appendChild(renderBlocks(blocks))');
    expect(detailSource).not.toContain('innerHTML');
    expect(renderMarkdown('<img src=x onerror="steal()">')).toEqual([{
      type: 'paragraph',
      spans: [{ type: 'text', text: '<img src=x onerror="steal()">' }],
    }]);
    expect(html).toContain('Receipt preview truncated by ');
    expect(html).toContain('Open full file in editor');
    expect(html).toContain("command: 'openToolFile'");
  });
});

describe('tool card collapse', () => {
  function fakeElement(): any {
    const classes = new Set<string>();
    return {
      className: '',
      textContent: '',
      children: [] as any[],
      attrs: {} as Record<string, string>,
      handlers: {} as Record<string, () => void>,
      classList: {
        add: (c: string) => classes.add(c),
        contains: (c: string) => classes.has(c),
        toggle: (c: string) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
      },
      append: function (...kids: any[]) { this.children.push(...kids); },
      appendChild: function (kid: any) { this.children.push(kid); },
      addEventListener: function (event: string, fn: () => void) { this.handlers[event] = fn; },
      setAttribute: function (k: string, v: string) { this.attrs[k] = v; },
    };
  }

  function renderToolWith(tool: Record<string, unknown>) {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    const match = html.match(/function renderTool\(tool\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    function renderToolDetail/);
    expect(match).toBeTruthy();
    const source = match![0].replace(/\r?\n\r?\n    function renderToolDetail$/, '');

    const document = { createElement: () => fakeElement() };
    const stub = () => fakeElement();
    const toggleCalls: boolean[] = [];
    const handleToolCardToggle = (open: boolean) => { toggleCalls.push(open); };
    const measuredToolTiming = (value: any) => {
      const start = Date.parse(String(value.ts || ''));
      const end = Date.parse(String(value.completedAt || ''));
      return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { durationMs: end - start } : undefined;
    };
    const formatMeasuredDuration = (durationMs: number) => (durationMs / 1000).toFixed(1) + 's';
    const fn = new Function('document', 'toolIcon', 'statusDot', 'renderToolDetail', 'renderDiffDetail', 'renderToolTiming', 'measuredToolTiming', 'formatMeasuredDuration', 'humanWaitText', 'handleToolCardToggle', 'isToolExpanded', 'setToolExpanded', 'vscode', 'state',
      `${source}\nreturn renderTool;`);
    const node = fn(document, stub, stub, stub, stub, stub, measuredToolTiming, formatMeasuredDuration, () => '', handleToolCardToggle, () => false, vi.fn(), { postMessage: vi.fn() }, { selectedAgentId: agent.id })(tool);
    const [head] = node.children;
    const right = head.children[1];
    const expand = right.children[1];
    const title = head.children[0];
    const rightState = right.children[0];
    return { node, head, expand, title, rightState, toggleCalls };
  }

  it('collapses a successful card and exposes an expand control', () => {
    const { node, expand } = renderToolWith({ name: 'read_file', phase: 'result', ok: true, summary: 'read 3 lines' });
    expect(node.classList.contains('expanded')).toBe(false);
    expect(expand.className).toBe('tool-expand');
    expect(expand.attrs['aria-expanded']).toBe('false');
  });

  it('opens a blocked card so its error is not hidden behind a click', () => {
    const { node, expand, rightState } = renderToolWith({ name: 'run_command', phase: 'result', ok: false, failureKind: 'blocked', detail: 'denied' });
    expect(node.classList.contains('expanded')).toBe(true);
    expect(expand.attrs['aria-expanded']).toBe('true');
    expect(rightState.textContent).toBe('Blocked · duration not recorded');
  });

  it('labels not-found failures without auto-expanding them as security blocks', () => {
    const { node, expand, rightState } = renderToolWith({ name: 'read_file', phase: 'result', ok: false, failureKind: 'not_found', detail: 'missing' });
    expect(node.classList.contains('expanded')).toBe(false);
    expect(expand.attrs['aria-expanded']).toBe('false');
    expect(rightState.textContent).toBe('Not found · duration not recorded');
  });

  it('toggles on a click anywhere in the title row, keeping aria in sync', () => {
    const { node, head, expand, toggleCalls } = renderToolWith({ name: 'read_file', phase: 'result', ok: true });

    head.handlers.click();
    expect(node.classList.contains('expanded')).toBe(true);
    expect(expand.attrs['aria-expanded']).toBe('true');
    expect(expand.attrs['aria-label']).toBe('Hide details');
    expect(toggleCalls).toEqual([true]);

    head.handlers.click();
    expect(node.classList.contains('expanded')).toBe(false);
    expect(expand.attrs['aria-expanded']).toBe('false');
    expect(expand.attrs['aria-label']).toBe('Show details');
    expect(toggleCalls).toEqual([true, false]);
  });
});

describe('chat autoscroll script', () => {
  it('uses wheel-up disable plus auto/smooth settle scrolls without webview-crashing instant behavior', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });

    expect(html).toContain('let disableAutoScroll = false');
    expect(html).toContain("window.addEventListener('wheel', onTranscriptWheel, { passive: true })");
    expect(html).toContain('if (event.deltaY < 0)');
    expect(html).toContain("transcript.addEventListener('scroll', onTranscriptScroll, { passive: true })");
    expect(html).toContain("setTimeout(() => pinTranscriptToBottom('auto'), 40)");
    expect(html).toContain("setTimeout(() => pinTranscriptToBottom('auto'), 70)");
    expect(html).toContain("setTimeout(() => pinTranscriptToBottom('auto'), 500)");
    expect(html).toContain("pinTranscriptToBottom(smooth ? 'smooth' : 'auto')");
    expect(html).not.toContain("behavior: 'instant'");
    expect(html).not.toContain('behavior: "instant"');
  });
});

describe('chat cancel epoch script', () => {
  it('drops stale streamed and incremental transcript events in the webview reducer', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });

    expect(html).toContain('function acceptStreamedEvent(msg)');
    expect(html).toContain('return epoch === undefined || epoch === currentTurnEpoch(msg.agentId)');
    expect(html).toContain('if (!acceptStreamedEvent(msg)) return;');
    expect(html).toContain("event.data.command === 'delta'");
    expect(html).toContain("event.data.agentId === state.selectedAgentId && acceptStreamedEvent(event.data)");
    expect(html).toContain('event.data.item && acceptStreamedEvent(event.data)');
  });
});

describe('persistent liveness evidence', () => {
  function livenessHelpers() {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    const match = html.match(/function pendingTool\(items\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    function markStreamedRunning/);
    expect(match).toBeTruthy();
    const source = match![0].replace(/\r?\n\r?\n    function markStreamedRunning[\s\S]*$/, '');
    const build = new Function('state', 'selectedAgent', `${source}\nreturn currentLiveness;`);
    return (state: any) => build(state, () => state.agents.find((candidate: any) => candidate.id === state.selectedAgentId));
  }

  it('keeps the tail visible after the first live block, and only reports a real pending tool', () => {
    const currentLiveness = livenessHelpers();
    const startedAt = '2026-07-12T00:00:00.000Z';
    const state: any = {
      selectedAgentId: agent.id,
      agents: [agent],
      runningAgentIds: [agent.id],
      turnStartedAt: { [agent.id]: startedAt },
      messages: [{ kind: 'message', live: true, text: 'already streamed', ts: startedAt }],
    };

    // Before the host has reported a phase the line claims nothing about the model.
    expect(currentLiveness(state)(state.messages)).toEqual({ label: 'Working', startedAt, turnStartedAt: startedAt });

    state.messages.push({
      kind: 'tool', phase: 'use', category: 'run', title: 'Run npm test', name: 'run_command', ts: '2026-07-12T00:00:05.000Z',
    });
    expect(currentLiveness(state)(state.messages)).toEqual({
      label: 'Running npm test', startedAt: '2026-07-12T00:00:05.000Z', turnStartedAt: startedAt,
    });

    state.runningAgentIds = [];
    expect(currentLiveness(state)(state.messages)).toBeUndefined();
  });

  it('labels the live line from the phase the host reported, and never calls provider silence thinking', () => {
    const currentLiveness = livenessHelpers();
    const turnStartedAt = '2026-07-12T00:00:00.000Z';
    const phaseStartedAt = '2026-07-12T00:00:10.000Z';
    const observedAt = '2026-07-12T00:00:30.000Z';
    const state: any = {
      selectedAgentId: agent.id,
      agents: [agent],
      runningAgentIds: [agent.id],
      turnStartedAt: { [agent.id]: '2026-07-12T00:00:02.000Z' },
      turnPhases: {},
      messages: [],
    };
    const phase = (overrides: Record<string, unknown>) => {
      state.turnPhases[agent.id] = {
        phase: 'provider-wait', phaseStartedAt, turnStartedAt, openTools: 0, approvalPending: false, provider: 'Claude',
        // 30 s after the turn began the host had counted 12 s of turn time, 2 s of them in this phase: the
        // phase began 20 s earlier and a person took 18 s of it to decide.
        activeMs: 12_000, phaseActiveMs: 2_000, observedAt,
        ...overrides,
      };
      return currentLiveness(state)(state.messages);
    };
    // Clocks started here read the host's times: 12 s of turn and 2 s of phase at the observed instant.
    const turnClockStartedAt = '2026-07-12T00:00:18.000Z';
    const phaseClockStartedAt = '2026-07-12T00:00:28.000Z';

    // Neither clock counts the person's 18 s: not the turn clock, and not the phase clock beside the label.
    expect(phase({})).toEqual({ label: 'Waiting for Claude', startedAt: phaseClockStartedAt, turnStartedAt: turnClockStartedAt });
    expect(phase({ provider: 'OpenRouter' }).label).toBe('Waiting for OpenRouter');
    expect(phase({ provider: '' }).label).toBe('Waiting for the provider');
    expect(phase({ phase: 'reasoning' }).label).toBe('Reasoning');
    expect(phase({ phase: 'responding' }).label).toBe('Responding');
    expect(phase({ phase: 'host' }).label).toBe('Preparing the request');
    expect(phase({ phase: 'tool', openTools: 1, phaseToolCalls: 1 }).label).toBe('Running a tool');
    for (const kind of ['provider-wait', 'host', 'reasoning', 'responding', 'tool']) {
      expect(phase({ phase: kind }).label).not.toMatch(/think/i);
    }

    // A tool card names the tool only while the host says the turn is in its tool phase.
    state.messages.push({
      kind: 'tool', phase: 'use', category: 'run', title: 'Run npm test', name: 'run_command', ts: '2026-07-12T00:00:40.000Z',
    });
    // The card gives the name; the time is the host's tool phase, not the card's own start. With one call in
    // the phase that time is the call's own, so the name may stand beside it.
    expect(phase({ phase: 'tool', openTools: 1, phaseToolCalls: 1 })).toEqual({
      label: 'Running npm test', startedAt: phaseClockStartedAt, turnStartedAt: turnClockStartedAt,
    });
    // Calls overlapped: the phase time belongs to no single tool, so no tool is named beside it. That holds
    // while two are open, and after the first has finished and only the later one is left.
    expect(phase({ phase: 'tool', openTools: 2, phaseToolCalls: 2 })).toEqual({
      label: 'Tool work, 2 calls open', startedAt: phaseClockStartedAt, turnStartedAt: turnClockStartedAt,
    });
    expect(phase({ phase: 'tool', openTools: 1, phaseToolCalls: 2 }).label).toBe('Tool work, 1 call open');
    // A host that does not say how many calls shared the phase gets no tool name either.
    expect(phase({ phase: 'tool', openTools: 1 }).label).toBe('Tool work, 1 call open');
    expect(phase({ phase: 'provider-wait' }).label).toBe('Waiting for Claude');

    // An open human decision is shown ahead of the tool behind it, on its own clock, and the turn clock stands
    // at the turn time it had reached.
    expect(phase({ phase: 'tool', openTools: 1, approvalPending: true, approvalStartedAt: '2026-07-12T00:00:45.000Z' })).toEqual({
      label: 'Waiting for your approval', startedAt: '2026-07-12T00:00:45.000Z', turnPausedMs: 12_000,
    });
  });

  it('does not let the end of an earlier turn clear the phase of the running one', () => {
    const posted: any[] = [];
    const provider = providerWith(depsFor([{ ...agent, backend: 'claude' }]));
    (provider as any).postToVisible = (message: unknown) => posted.push(message);
    const snapshot = {
      phase: 'reasoning' as const, phaseStartedAt: '2026-07-12T00:00:01.000Z', turnStartedAt: '2026-07-12T00:00:00.000Z',
      openTools: 0, activeMs: 1_000, phaseActiveMs: 0, observedAt: '2026-07-12T00:00:01.000Z', approvalPending: false,
    };
    provider.setTurnPhase(agent.id, snapshot, 5);

    posted.length = 0;
    provider.setTurnPhase(agent.id, undefined, 4);
    expect(posted).toEqual([]);
    expect((provider as any).currentState().turnPhases[agent.id]).toMatchObject({ phase: 'reasoning' });

    // The end of the running turn itself does clear it.
    provider.setTurnPhase(agent.id, undefined, 5);
    expect(posted).toEqual([{ command: 'turnPhase', agentId: agent.id }]);
    expect((provider as any).currentState().turnPhases).toEqual({});
  });

  it('keeps the host phase per agent, drops a stale one and shows a host-started turn as running', () => {
    const posted: any[] = [];
    const provider = providerWith(depsFor([{ ...agent, backend: 'claude' }]));
    (provider as any).postToVisible = (message: unknown) => posted.push(message);
    // The provider's name on the live line is the host's: the backend, else the route's display label.
    expect((providerWith() as any).providerLabel(agent.id)).toBe('the provider');
    expect((providerWith(depsFor([{ ...agent, backend: 'codex' }])) as any).providerLabel(agent.id)).toBe('Codex');
    expect((providerWith(depsFor([{ ...agent, backend: 'openai-compat', routeLabel: ' OpenRouter ' }])) as any).providerLabel(agent.id))
      .toBe('OpenRouter');
    const snapshot = {
      phase: 'provider-wait' as const, phaseStartedAt: '2026-07-12T00:00:01.000Z', turnStartedAt: '2026-07-12T00:00:00.000Z',
      openTools: 0, activeMs: 1_000, phaseActiveMs: 0, observedAt: '2026-07-12T00:00:01.000Z', approvalPending: false,
    };

    // No user send marked this turn running: the host woke the agent itself.
    provider.setTurnPhase(agent.id, snapshot, 3);
    expect((provider as any).currentState()).toMatchObject({
      runningAgentIds: [agent.id],
      turnPhases: { [agent.id]: { ...snapshot, provider: 'Claude' } },
    });

    posted.length = 0;
    provider.setTurnPhase(agent.id, { ...snapshot, phase: 'reasoning' }, 3);
    expect(posted).toEqual([{ command: 'turnPhase', agentId: agent.id, turnPhase: { ...snapshot, phase: 'reasoning', provider: 'Claude' } }]);

    // A phase of an earlier turn epoch is not this turn's.
    provider.setTurnPhase(agent.id, { ...snapshot, phase: 'tool' }, 2);
    expect((provider as any).currentState().turnPhases[agent.id].phase).toBe('reasoning');

    posted.length = 0;
    provider.setTurnPhase(agent.id, undefined);
    expect(posted).toEqual([{ command: 'turnPhase', agentId: agent.id }]);
    expect((provider as any).currentState().turnPhases).toEqual({});
    // Ending twice, or a phase for an agent this chat does not hold, posts nothing.
    posted.length = 0;
    provider.setTurnPhase(agent.id, undefined);
    provider.setTurnPhase('not-an-agent', snapshot, 1);
    expect(posted).toEqual([]);
  });

  it('uses one local timer and clears it for an idle or hidden panel', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T00:00:04.000Z'));
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    expect(html).toContain("window.addEventListener('unload', clearLivenessClock)");
    const match = html.match(/let livenessTimer;[\s\S]*?\r?\n    \}\r?\n\r?\n    function pendingTool/);
    expect(match).toBeTruthy();
    const source = `${emittedFunctionSource(html, 'delegationMinutes')}\n${emittedFunctionSource(html, 'delegationLiveStatus')}\n`
      + match![0].replace(/\r?\n\r?\n    function pendingTool[\s\S]*$/, '');
    const elapsed = { dataset: { elapsedStart: new Date(Date.now() - 4_000).toISOString() }, textContent: '' };
    let hasLiveness = true;
    const document = { hidden: false, getElementById: () => hasLiveness ? {} : null, createElement: vi.fn() };
    const transcript = {
      querySelectorAll: (selector: string) => selector === '[data-elapsed-start]' ? [elapsed] : [],
      querySelector: () => null,
    };
    const setInterval = vi.fn(() => 42 as never);
    const clearInterval = vi.fn();
    const clock = new Function('document', 'transcript', 'setInterval', 'clearInterval', `${source}\nreturn { syncLivenessClock, clearLivenessClock };`)(
      document, transcript, setInterval, clearInterval
    );

    clock.syncLivenessClock();
    expect(elapsed.textContent).toMatch(/^4s$/);
    expect(setInterval).toHaveBeenCalledOnce();

    hasLiveness = false;
    clock.syncLivenessClock();
    expect(clearInterval).toHaveBeenCalledWith(42);

    hasLiveness = true;
    document.hidden = true;
    clock.syncLivenessClock();
    expect(setInterval).toHaveBeenCalledOnce();
  });

  it('stamps a real turn start once and removes it when the turn completes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T03:04:05.000Z'));
    const provider = providerWith();

    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-run_command', name: 'run_command', input: { command: 'npm test' } });
    expect((provider as any).currentState().turnStartedAt).toEqual({ [agent.id]: '2026-07-12T03:04:05.000Z' });

    (provider as any).onReply({ from: agent.id, fromName: agent.name, text: 'done', isError: false });
    const state = (provider as any).currentState();
    expect(state.runningAgentIds).toEqual([]);
    expect(state.turnStartedAt).toEqual({});
  });

  it('finalizes a partial reply, clears Stop state, and preserves structured completion state', () => {
    const provider = providerWith();
    provider.appendDelta(agent.id, 'Report so far.', 1);

    (provider as any).onReply({
      from: agent.id,
      fromName: agent.name,
      text: 'Report so far.',
      isError: false,
      epoch: 1,
      completionState: 'partial',
    });

    const state = (provider as any).currentState();
    expect(state.runningAgentIds).toEqual([]);
    expect(state.messages.at(-1)).toMatchObject({
      role: 'agent', text: 'Report so far.', completionState: 'partial',
    });
  });
});

describe('chat legibility', () => {
  function planRenderer() {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    const match = html.match(/const TICK = \{[\s\S]*?\r?\n    \}\r?\n\r?\n    function renderCompact/);
    expect(match).toBeTruthy();
    const source = match![0].replace(/\r?\n\r?\n    function renderCompact[\s\S]*$/, '');
    const listeners: Record<string, () => void> = {};
    const planEl: any = {
      hidden: true,
      open: true,
      classList: { toggle: vi.fn() },
      addEventListener: (name: string, listener: () => void) => { listeners[name] = listener; },
    };
    const planList: any = { replaceChildren: vi.fn(), appendChild: vi.fn() };
    const planCount: any = { textContent: '' };
    const document = {
      createElement: () => ({ className: '', textContent: '', append: vi.fn() }),
    };
    const state: any = { todos: [] };
    const renderer = new Function('state', 'planEl', 'planList', 'planCount', 'document', `${source}\nreturn { renderPlan };`)(
      state, planEl, planList, planCount, document
    );
    return { state, planEl, planList, planCount, listeners, renderer };
  }

  it('renders a collapsed honest todo summary, and nothing at all without update_todos state', () => {
    const view = planRenderer();
    view.renderer.renderPlan();
    expect(view.planEl.hidden).toBe(true);
    expect(view.planCount.textContent).toBe('');

    view.state.todos = [
      { content: 'Inspect the feature', status: 'completed' },
      { content: 'Wire the command', status: 'in_progress' },
      { content: 'Run tests', status: 'pending' },
    ];
    view.renderer.renderPlan();

    expect(view.planEl.hidden).toBe(false);
    expect(view.planEl.open).toBe(false);
    expect(view.planCount.textContent).toBe('1 of 3 done · Wire the command');
    expect(view.planList.replaceChildren).toHaveBeenCalled();
  });

  it('maps known tool kinds to codicon names and keeps a safe fallback for an unknown tool', () => {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    const match = html.match(/const TOOL_ICON_BY_NAME = \{[\s\S]*?\r?\n    \}\r?\n\r?\n    function toolIcon\(tool\)/);
    expect(match).toBeTruthy();
    const source = match![0].replace(/\r?\n\r?\n    function toolIcon\(tool\)[\s\S]*$/, '');
    const { toolIconSpec } = new Function(`${source}\nreturn { toolIconSpec };`)();

    expect(toolIconSpec({ name: 'read_file', category: 'read' }).codicon).toBe('file');
    expect(toolIconSpec({ name: 'write_file', category: 'edit' }).codicon).toBe('new-file');
    expect(toolIconSpec({ name: 'apply_edit', category: 'edit' }).codicon).toBe('edit');
    expect(toolIconSpec({ name: 'search_files', category: 'read' }).codicon).toBe('search');
    expect(toolIconSpec({ name: 'run_command', category: 'run' }).codicon).toBe('terminal');
    expect(toolIconSpec({ name: 'assign_task', category: 'tool' }).codicon).toBe('organization');
    expect(toolIconSpec({ name: 'run_checks', category: 'run' }).codicon).toBe('beaker');
    expect(toolIconSpec({ name: 'future_tool', category: 'unknown' }).codicon).toBe('tools');
  });
});

describe('tool expansion durability', () => {
  function expansionHarness(raw: unknown = {}) {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    const source = html.match(/function readSavedToolExpansion\(raw\) \{[\s\S]*?\n    \}\n\n    function pruneDrafts/)?.[0]
      .replace(/\n\n    function pruneDrafts[\s\S]*$/, '') ?? '';
    expect(source).toContain('function setToolExpanded');
    const build = new Function('raw', `
      const MAX_EXPANDED_TOOL_IDS_PER_AGENT = 60;
      const MAX_TOOL_EXPANSION_AGENTS = 20;
      const state = { selectedAgentId: '${agent.id}' };
      const expandedToolIdsByAgent = readSavedToolExpansion(raw);
      let persisted = JSON.parse(JSON.stringify(expandedToolIdsByAgent));
      function persistUiSnapshot() { persisted = JSON.parse(JSON.stringify(expandedToolIdsByAgent)); }
      ${source}
      return { isToolExpanded, setToolExpanded, snapshot: () => persisted };
    `);
    return build(raw) as {
      isToolExpanded: (item: any) => boolean;
      setToolExpanded: (item: any, open: boolean) => void;
      snapshot: () => unknown;
    };
  }

  it('keeps an expanded card open after a second adjacent event re-keys its group and after reload', () => {
    const first = expansionHarness();
    const original = { kind: 'tool', id: 'tool-1' };
    first.setToolExpanded(original, true);

    const regrouped = { kind: 'toolGroup', tools: [original, { kind: 'tool', id: 'tool-2' }] };
    expect(first.isToolExpanded(regrouped)).toBe(true); // the second event changed the group key
    expect(first.isToolExpanded(regrouped)).toBe(true); // a transcript refresh uses the same durable state

    const reloaded = expansionHarness(first.snapshot());
    expect(reloaded.isToolExpanded({
      kind: 'toolGroup',
      tools: [...regrouped.tools, { kind: 'tool', id: 'tool-3' }],
    })).toBe(true);
  });

  it('stores group expansion against a member tool id and lets an explicit close clear it', () => {
    const state = expansionHarness();
    const group = { kind: 'toolGroup', tools: [{ id: 'a' }, { id: 'b' }] };
    state.setToolExpanded(group, true);
    expect(state.isToolExpanded(group)).toBe(true);
    state.setToolExpanded(group, false);
    expect(state.isToolExpanded(group)).toBe(false);
  });
});

describe('read tool card coalescing', () => {
  function groupingHelpers() {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    const match = html.match(/function coalesceReadToolRuns\(items\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    let livenessTimer/);
    expect(match).toBeTruthy();
    const source = match![0].replace(/\r?\n\r?\n    let livenessTimer[\s\S]*$/, '');
    const fn = new Function(`${source}\nreturn { coalesceReadToolRuns, readGroupTitle, measuredToolTiming, measuredToolGroupTiming, formatMeasuredDuration };`);
    return fn() as {
      coalesceReadToolRuns: (items: any[]) => any[];
      readGroupTitle: (tools: any[]) => string;
      measuredToolTiming: (tool: any) => { durationMs: number } | undefined;
      measuredToolGroupTiming: (tools: any[]) => { complete: boolean; spanMs?: number };
      formatMeasuredDuration: (durationMs: number) => string;
    };
  }

  const read = (seq: number, name = 'read_file', ok: boolean | undefined = true, phase = 'result') => ({
    kind: 'tool',
    id: `t-${seq}`,
    ts: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    seq,
    phase,
    name,
    title: name,
    summary: name,
    category: 'read',
    ok,
  });

  it('groups three adjacent completed reads into one render-time group', () => {
    const { coalesceReadToolRuns, readGroupTitle } = groupingHelpers();

    const grouped = coalesceReadToolRuns([read(1), read(2), read(3)]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].kind).toBe('toolGroup');
    expect(grouped[0].tools.map((t: any) => t.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(readGroupTitle(grouped[0].tools)).toBe('Read 3 files');
  });

  it('does not cross a narration segment boundary', () => {
    const { coalesceReadToolRuns } = groupingHelpers();
    const narration = { kind: 'message', role: 'agent', text: 'I read one file; now another.', ts: '2026-01-01T00:00:00.000Z', seq: 2 };

    const grouped = coalesceReadToolRuns([read(1), narration, read(3)]);

    expect(grouped.map((item) => item.kind)).toEqual(['tool', 'message', 'tool']);
  });

  it('keeps blocked and pending reads standalone and visible', () => {
    const { coalesceReadToolRuns } = groupingHelpers();

    const grouped = coalesceReadToolRuns([
      read(1),
      read(2),
      read(3, 'read_file', false),
      read(4),
      read(5),
      read(6, 'read_file', undefined, 'use'),
    ]);

    expect(grouped.map((item) => item.kind)).toEqual(['toolGroup', 'tool', 'toolGroup', 'tool']);
    expect(grouped[1]).toMatchObject({ id: 't-3', ok: false });
    expect(grouped[3]).toMatchObject({ id: 't-6', phase: 'use' });
  });

  it('coalesces adjacent completed writes and commands into leading outcome summaries', () => {
    const { coalesceReadToolRuns, readGroupTitle } = groupingHelpers();
    const edit = (seq: number) => ({ ...read(seq), category: 'edit', name: 'apply_edit' });
    const run = (seq: number) => ({ ...read(seq), category: 'run', name: 'run_command' });

    const grouped = coalesceReadToolRuns([edit(1), edit(2), run(3), run(4)]);

    expect(grouped.map((item) => item.kind)).toEqual(['toolGroup', 'toolGroup']);
    expect(readGroupTitle(grouped[0].tools)).toBe('Changed 2 items');
    expect(readGroupTitle(grouped[1].tools)).toBe('Ran 2 commands');
  });

  it('uses measured start/end pairs for cards and a group span, while marking legacy members partial', () => {
    const { measuredToolTiming, measuredToolGroupTiming, formatMeasuredDuration } = groupingHelpers();
    const first = { ...read(1), ts: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.400Z' };
    const second = { ...read(2), ts: '2026-01-01T00:00:02.000Z', completedAt: '2026-01-01T00:00:04.000Z' };

    expect(measuredToolTiming(first)).toMatchObject({ durationMs: 1400 });
    expect(formatMeasuredDuration(measuredToolTiming(first)!.durationMs)).toBe('1.4s');
    expect(measuredToolTiming({ ...first, completedAt: undefined })).toBeUndefined();
    expect(measuredToolGroupTiming([first, second])).toEqual({ complete: true, spanMs: 4000 });
    // A decision made during a call is in its span and in no clock: the duration leaves it out and names it.
    expect(measuredToolTiming({ ...first, humanWaitMs: 1_000 })).toMatchObject({ durationMs: 400, humanWaitMs: 1_000 });
    expect(measuredToolGroupTiming([{ ...first, humanWaitMs: 1_000 }, { ...second, humanWaitMs: 500 }]))
      .toEqual({ complete: true, spanMs: 2_500, humanWaitMs: 1_500 });
    // Calls that overlapped may have waited on one decision, so only the longest wait is certain.
    const overlapping = { ...second, ts: first.ts, humanWaitMs: 1_000 };
    expect(measuredToolGroupTiming([{ ...first, humanWaitMs: 1_000 }, overlapping]))
      .toEqual({ complete: true, spanMs: 3_000, humanWaitMs: 1_000 });
    expect(measuredToolGroupTiming([first, { ...second, completedAt: undefined }])).toEqual({ complete: false });
  });
});

describe('chat transcript rendering', () => {
  function emittedFunction(source: string, name: string): string {
    const start = source.indexOf(`function ${name}(`);
    expect(start, `webview must emit ${name}`).toBeGreaterThanOrEqual(0);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < source.length; index++) {
      if (source[index] === '{') depth++;
      if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`webview emitted an unclosed ${name}`);
  }

  function fullTranscriptRenderer(
    transcript: { scrollTop: number; clientHeight: number; replaceChildren: (...nodes: any[]) => void; appendChild: (node: any) => void },
    state: { selectedAgentId: string; messages: any[] },
    nodeByKey: Map<string, any>,
    renderMessage: (message: any) => any,
  ) {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' });
    const renderTranscript = emittedFunction(html, 'renderTranscript');
    const document = {
      createDocumentFragment: () => {
        const children: any[] = [];
        return { children, appendChild: (node: any) => { children.push(node); return node; } };
      },
    };
    const fn = new Function(
      'state', 'transcript', 'nodeByKey', 'renderMessage', 'document',
      `
      let lastRenderedAgentId = '';
      const shouldAutoScroll = () => false;
      const isNearBottom = () => false;
      const coalesceReadToolRuns = (items) => items;
      const itemKey = (item) => 'critical:' + item.seq;
      const currentLiveness = () => undefined;
      const scheduleBottomSettle = () => undefined;
      const syncLivenessClock = () => undefined;
      const clearLivenessClock = () => undefined;
      const selectedAgent = () => undefined;
      const pmSoloHint = () => undefined;
      const empty = () => undefined;
      ${renderTranscript}
      return renderTranscript;
    `,
    );
    return fn(state, transcript, nodeByKey, renderMessage, document) as () => void;
  }

  it('keeps an expanded card across full-transcript state renders without rebuilding its cached content', () => {
    const transcript = {
      scrollTop: 0,
      clientHeight: 72,
      replaceChildren(...nodes: any[]) {
        const expanded = nodes.flatMap((node) => node.children ?? [node]);
        expanded.forEach((node) => { node.isConnected = true; });
      },
      appendChild(node: any) { node.isConnected = true; },
    };
    const state = {
      selectedAgentId: agent.id,
      messages: Array.from({ length: 140 }, (_, seq) => ({ kind: 'message', seq, role: 'assistant', ts: '', text: `critical ${seq}` })),
    };
    const nodeByKey = new Map<string, { isConnected: boolean; seq: number; expanded: boolean; content: string }>();
    const renderMessage = vi.fn((message: { seq: number }) => ({
      isConnected: false,
      seq: message.seq,
      expanded: message.seq === 4,
      content: message.seq === 4 ? 'evidence fact' : '',
    }));
    const render = fullTranscriptRenderer(transcript, state, nodeByKey, renderMessage);

    render();
    const retained = nodeByKey.get('critical:4');
    expect(retained).toMatchObject({ expanded: true, content: 'evidence fact' });
    expect(nodeByKey.size).toBe(140);

    render();
    render();

    expect(nodeByKey.get('critical:4')).toBe(retained);
    expect(renderMessage.mock.calls.filter(([message]) => message.seq === 4)).toHaveLength(1);
  });

  /**
   * This executes the listener emitted into the production webview and dispatches a real event through
   * its `addEventListener` registration. `renderTranscript` simulates the old pin-to-bottom behavior by
   * causing another scroll event, so a scroll -> render -> pin feedback loop cannot hide in a unit stub.
   */
  type TranscriptContainer = 'sidebar' | 'workbench';

  function transcriptScrollCanary(handlerSource?: string, container: TranscriptContainer = 'sidebar') {
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' }, container);
    const onTranscriptScroll = handlerSource || emittedFunction(html, 'onTranscriptScroll');
    expect(html).toContain("transcript.addEventListener('scroll', onTranscriptScroll, { passive: true })");
    return new Function(`
      const state = { messages: Array.from({ length: 121 }, () => ({})) };
      let disableAutoScroll = false;
      const AUTO_SCROLL_RESUME_PX = 10;
      const frames = [];
      const timers = [];
      let replaceChildrenCalls = 0;
      let listenerFailure;
      const transcript = {
        scrollTop: 800,
        scrollHeight: 1000,
        clientHeight: 200,
        listeners: new Map(),
        addEventListener(type, listener) { this.listeners.set(type, listener); },
        dispatchEvent(event) {
          const listener = this.listeners.get(event.type);
          if (!listener) return;
          try { listener(event); } catch (error) { listenerFailure = error; }
        },
        replaceChildren() { replaceChildrenCalls++; },
        scrollTo({ top }) { this.scrollTop = top; this.dispatchEvent({ type: 'scroll' }); },
      };
      const requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
      const setTimeout = (callback) => { timers.push(callback); return timers.length; };
      function bottomGap() { return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight; }
      function isNearBottom(threshold) { return bottomGap() < (threshold === undefined ? 48 : threshold); }
      function renderTranscript() {
        transcript.replaceChildren({});
        transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'auto' });
      }
      ${onTranscriptScroll}
      transcript.addEventListener('scroll', onTranscriptScroll, { passive: true });
      return {
        scroll() {
          transcript.dispatchEvent({ type: 'scroll' });
          if (listenerFailure) {
            const match = /([A-Za-z_$][\\w$]*) is not defined/.exec(String(listenerFailure.message || listenerFailure));
            const missing = match ? match[1] : 'unknown';
            throw new Error('transcript scroll canary harness lacks binding "' + missing + '" required by the emitted handler');
          }
        },
        replaceChildrenCalls: () => replaceChildrenCalls,
        pending: () => frames.length + timers.length,
        drain(limit = 32) {
          for (let turns = 0; turns < limit && (frames.length || timers.length); turns++) {
            const work = frames.splice(0).concat(timers.splice(0));
            work.forEach((callback) => callback());
          }
          return !(frames.length || timers.length);
        },
      };
    `)() as {
      scroll: () => void;
      replaceChildrenCalls: () => number;
      pending: () => number;
      drain: (limit?: number) => boolean;
    };
  }

  function assertTranscriptScrollStatics(html: string, handler: string): void {
    expect(handler).not.toContain('renderTranscript');
    expect(html).not.toContain('TRANSCRIPT_VIRTUALIZE_AFTER');
    expect(html).not.toContain('transcriptSpacer');
  }

  it('never redraws the transcript in response to its real scroll event', () => {
    for (const container of ['sidebar', 'workbench'] as const) {
      const html = (providerWith() as any).getHtml({ cspSource: 'test:' }, container);
      const handler = emittedFunction(html, 'onTranscriptScroll');
      // These must precede event delivery: the shipped v0.9.63 handler would otherwise die on an
      // absent harness binding before the assertion that actually identifies the regression can run.
      assertTranscriptScrollStatics(html, handler);
      const canary = transcriptScrollCanary(handler, container);

      for (let event = 0; event < 20; event++) canary.scroll();

      expect(canary.drain()).toBe(true);
      expect(canary.pending()).toBe(0);
      expect(canary.replaceChildrenCalls()).toBe(0);
    }
  });

  it('rejects the real v0.9.63 handler statically and names a missing harness binding if it is executed', () => {
    const formerV0963Handler = `
      function onTranscriptScroll() {
        if (isNearBottom(AUTO_SCROLL_RESUME_PX)) disableAutoScroll = false;
        if (!virtualRenderScheduled && (state.messages || []).length > TRANSCRIPT_VIRTUALIZE_AFTER) {
          virtualRenderScheduled = true;
          const render = () => {
            virtualRenderScheduled = false;
            renderTranscript();
          };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(render);
          else setTimeout(render, 0);
        }
      }
    `;
    const html = (providerWith() as any).getHtml({ cspSource: 'test:' }, 'sidebar');

    expect(() => assertTranscriptScrollStatics(html, formerV0963Handler)).toThrow(/renderTranscript/);
    expect(() => transcriptScrollCanary(formerV0963Handler).scroll())
      .toThrow('transcript scroll canary harness lacks binding "virtualRenderScheduled"');
  });

  it('detects the former scroll -> render -> pin feedback loop', () => {
    const selfSchedulingHandler = `
      function onTranscriptScroll() {
        if (isNearBottom(AUTO_SCROLL_RESUME_PX)) disableAutoScroll = false;
        requestAnimationFrame(renderTranscript);
      }
    `;
    const canary = transcriptScrollCanary(selfSchedulingHandler);

    canary.scroll();

    expect(canary.drain()).toBe(false);
    expect(canary.pending()).toBeGreaterThan(0);
    expect(canary.replaceChildrenCalls()).toBeGreaterThanOrEqual(32);
  });
});

/**
 * A coordinator in delegate mode is idle by design, and looked stopped.
 *
 * Claude keeps a verb and an ellipsis moving while it works; Codex keeps a clock. This surface had a clock
 * for its own turns and nothing at all for the state a coordinator spends most of its time in — dispatched,
 * turn ended, three teammates working. Owner, 2026-08-21.
 *
 * A count would not have fixed it. "3 out" says work exists; it does not say which teammate has been quiet
 * for four minutes, and that is the thing a person watching is actually looking for.
 */
describe('delegating — who is out, and for how long', () => {
  const item = (agentId: string, agentName: string, startedAt: string, status = 'working') =>
    ({ id: agentId, coordinatorId: 'pm', coordinatorName: 'PM', agentId, agentName, instruction: 'x', status, startedAt }) as never;
  const withItems = (items: unknown[]) =>
    ({ id: 's', coordinatorId: 'pm', coordinatorName: 'PM', startedAt: '', total: items.length, done: 0, blocked: 0, working: items.length, items }) as never;

  it('names each teammate still out and when their work started', () => {
    const out = delegatingOutFrom([withItems([
      item('a', 'Content Strategist', '2026-08-21T10:00:10.000Z'),
      item('b', 'Frontend Engineer', '2026-08-21T10:00:00.000Z'),
    ])]);

    // Longest-waiting first: the one that has been out longest is the one worth looking at.
    expect(out.pm).toEqual([
      { agentName: 'Frontend Engineer', startedAt: '2026-08-21T10:00:00.000Z' },
      { agentName: 'Content Strategist', startedAt: '2026-08-21T10:00:10.000Z' },
    ]);
  });

  it('reports only what is still working — a finished teammate must not keep a clock running', () => {
    const out = delegatingOutFrom([withItems([
      item('a', 'Content Strategist', '2026-08-21T10:00:00.000Z', 'done'),
      item('b', 'Frontend Engineer', '2026-08-21T10:00:05.000Z'),
    ])]);

    expect(out.pm).toEqual([{ agentName: 'Frontend Engineer', startedAt: '2026-08-21T10:00:05.000Z' }]);
  });

  it('says nothing at all once every delegation has landed', () => {
    expect(delegatingOutFrom([withItems([item('a', 'A', '2026-08-21T10:00:00.000Z', 'done')])])).toEqual({});
    expect(delegatingOutFrom([])).toEqual({});
  });
});

describe('delegating — N out (a free PM must not look idle-and-broken)', () => {
  // v0.9.28 smoke report: after the PM dispatched async work its Steer/Stop turned into Send while the
  // Senior Developer was still working, then it "suddenly" became Steer/Stop again on the auto-wake.
  // The buttons were RIGHT — a PM that released its turn IS idle and reachable — but nothing told the user
  // work was still in flight, so correct behavior read as a glitch.
  const summary = (coordinatorId: string, working: number) =>
    ({ id: 's', coordinatorId, coordinatorName: 'PM', startedAt: '', total: 1, done: 0, blocked: 0, working, items: [] }) as never;

  it('counts a coordinator in-flight delegations while it is idle', () => {
    expect(delegatingCountsFrom([summary('pm', 1)])).toEqual({ pm: 1 });
    expect(delegatingCountsFrom([summary('pm', 2), summary('pm', 1)])).toEqual({ pm: 3 });
  });

  it('reports NOTHING once the work lands — a stuck hint is its own bug', () => {
    expect(delegatingCountsFrom([summary('pm', 0)])).toEqual({});
    expect(delegatingCountsFrom([])).toEqual({});
  });

  it('changes the delegation transcript key when task.status publishes new activity (N6)', () => {
    const base = {
      id: 'delegation-1', coordinatorId: 'pm', coordinatorName: 'PM', startedAt: '', total: 1,
      done: 0, blocked: 0, working: 1,
      items: [{ id: 'task-1', coordinatorId: 'pm', coordinatorName: 'PM', agentId: 'dev', agentName: 'Dev', instruction: 'Implement', status: 'working', startedAt: '' }],
    } as never;
    const afterStatus = {
      ...base,
      items: [{ ...base.items[0], activity: 'Reading project context.', updatedAt: '2026-08-08T00:00:00.000Z' }],
    } as never;

    expect(delegationRenderKey(afterStatus)).not.toBe(delegationRenderKey(base));
    // Mutation: retaining the old counter-only key hides task.status again.
  });

  it('changes the delegation transcript key when a coordinator amends a prior verdict', () => {
    const base = {
      id: 'delegation-1', coordinatorId: 'pm', coordinatorName: 'PM', startedAt: '', total: 1,
      done: 1, blocked: 0, working: 0,
      items: [{ id: 'task-1', coordinatorId: 'pm', coordinatorName: 'PM', agentId: 'dev', agentName: 'Dev', instruction: 'Implement', status: 'verified', startedAt: '', evidenceOutcome: 'verified' }],
    } as never;
    const amended = {
      ...base,
      items: [{ ...base.items[0], status: 'coordinator-rejected', amendedFrom: 'verified', dispositionReason: 'Acceptance table missing.', dispositionAt: '2026-08-09T09:17:17.000Z' }],
    } as never;

    expect(delegationRenderKey(amended)).not.toBe(delegationRenderKey(base));
  });

  it('changes the delegation transcript key when only completion state or partial count changes', () => {
    const base = {
      id: 'summary', done: 1, partial: 0, blocked: 0, working: 0,
      items: [{ id: 'h', status: 'verified' }],
    } as never;
    const itemPartial = {
      ...(base as any), items: [{ id: 'h', status: 'verified', completionState: 'partial' }],
    } as never;
    const countPartial = { ...(base as any), partial: 1 } as never;
    expect(delegationRenderKey(itemPartial)).not.toBe(delegationRenderKey(base));
    expect(delegationRenderKey(countPartial)).not.toBe(delegationRenderKey(base));
  });
});

describe('tool payloads are bounded before entering the transcript', () => {
  // The extension host OOM'd at ~4GB during a session where an agent was told to read a directory of binary
  // files. detail/diff were UNBOUNDED, and currentState() re-serializes the whole transcript into every
  // webview state push — so one huge result is copied again on every later update, and persisted. (The host
  // is shared with ~19 extensions, so this crash cannot be pinned on us — but an unbounded payload that gets
  // re-serialized on every push is our hazard to remove regardless.)
  it('truncates a huge detail and says so', () => {
    const huge = 'x'.repeat(200_000);
    const capped = capToolPayload({ phase: 'result', callId: 'call-read_file', name: 'read_file', outcome: { status: 'success', observedBy: 'host' }, summary: 'read', detail: huge });
    expect(capped.detail!.length).toBeLessThan(40_000);
    expect(capped.detail).toContain('truncated');
    expect(capped.detail).toContain('more characters not kept');
  });

  it('truncates a huge diff too', () => {
    const capped = capToolPayload({ phase: 'result', callId: 'call-write_file', name: 'write_file', outcome: { status: 'success', observedBy: 'host' }, summary: 'wrote', diff: 'y'.repeat(200_000) });
    expect(capped.diff!.length).toBeLessThan(40_000);
    expect(capped.diff).toContain('truncated');
  });

  it('leaves an ordinary payload untouched (same object, no copy)', () => {
    const event = { phase: 'result', callId: 'call-read_file', name: 'read_file', outcome: { status: 'success', observedBy: 'host' }, summary: 'read', detail: 'small output' } as never;
    expect(capToolPayload(event)).toBe(event);
  });
});

// v0.9.88 §5.11: exactly one visible chat container plays each chime; hidden ones never do.
describe('attention chime container', () => {
  const attentionPosts = (post: ReturnType<typeof vi.fn>) => post.mock.calls
    .map(([message]) => message as { command?: string; id?: string })
    .filter((message) => message.command === 'attention');

  it('plays in the container the user is working in, and only there', () => {
    const provider = providerWith();
    const sidebar = webviewViewForTest();
    const workbench = webviewPanelForTest();
    provider.resolveWebviewView(sidebar.view as never);
    provider.restoreWorkbench(workbench.panel as never);

    expect(provider.playAttention('a1')).toBe('workbench');
    sidebar.fireMessage({ command: 'accessibilityFocus', focused: true });
    expect(provider.playAttention('a2')).toBe('sidebar');
    expect(attentionPosts(workbench.panel.webview.postMessage)).toEqual([{ command: 'attention', id: 'a1' }]);
    expect(attentionPosts(sidebar.view.webview.postMessage)).toEqual([{ command: 'attention', id: 'a2' }]);
  });

  it('never plays in a hidden container, so with nothing visible it reports no player', () => {
    const provider = providerWith();
    const sidebar = webviewViewForTest();
    const workbench = webviewPanelForTest();
    provider.resolveWebviewView(sidebar.view as never);
    provider.restoreWorkbench(workbench.panel as never);
    sidebar.view.visible = false;
    workbench.panel.visible = false;

    expect(provider.playAttention('a1')).toBeUndefined();
    expect(attentionPosts(sidebar.view.webview.postMessage)).toEqual([]);
    expect(attentionPosts(workbench.panel.webview.postMessage)).toEqual([]);
  });

  it('forwards a validated playback report with the surface it came from, and drops a malformed one', () => {
    const results: unknown[] = [];
    const provider = providerWith({ ...depsFor(), onAttentionResult: (result) => results.push(result) });
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);

    sidebar.fireMessage({ command: 'attentionResult', id: 'a1', audioState: 'suspended', started: false });
    sidebar.fireMessage({ command: 'attentionResult', id: 'x'.repeat(65), audioState: 'running', started: true });
    sidebar.fireMessage({ command: 'attentionResult', id: 'a2', audioState: 'blaring', started: true });
    sidebar.fireMessage({ command: 'attentionResult', id: 'a3', audioState: 'running', started: 'yes' });
    expect(results).toEqual([{ id: 'a1', audioState: 'suspended', started: false, surface: 'sidebar' }]);
  });

  it('tells the webview whether the sound is on, off when the setting is not wired', () => {
    expect((providerWith() as any).currentState().attentionSound).toBe(false);
    expect((providerWith({ ...depsFor(), attentionSoundEnabled: () => true }) as any).currentState().attentionSound).toBe(true);
  });
});

describe('attention chime player (webview)', () => {
  class FakeAudioContext {
    static instances: FakeAudioContext[] = [];
    static startState = 'running';
    static resumeAllowed = true;
    state = FakeAudioContext.startState;
    currentTime = 0;
    destination = {};
    oscillators = 0;
    resumes = 0;
    constructor() { FakeAudioContext.instances.push(this); }
    resume(): Promise<void> {
      this.resumes++;
      if (!FakeAudioContext.resumeAllowed) return new Promise(() => {});
      this.state = 'running';
      return Promise.resolve();
    }
    createOscillator() {
      this.oscillators++;
      return { type: '', frequency: { value: 0 }, connect: () => {}, start: () => {}, stop: () => {} };
    }
    createGain() {
      return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} };
    }
  }

  function player(options: { audio?: boolean; attentionSound?: boolean } = {}) {
    FakeAudioContext.instances = [];
    const provider = providerWith();
    const sidebar = webviewViewForTest();
    provider.resolveWebviewView(sidebar.view as never);
    const html = sidebar.view.webview.html;
    const source = [
      'let attentionAudio;',
      'const playedAttentionIds = [];',
      `async ${emittedFunctionSource(html, 'playAttention')}`,
      emittedFunctionSource(html, 'primeAttentionAudio'),
      'return { playAttention, primeAttentionAudio };',
    ].join('\n');
    const posted: unknown[] = [];
    const window = options.audio === false ? {} : { AudioContext: FakeAudioContext };
    const api = new Function('window', 'vscode', 'state', 'setTimeout', source)(
      window,
      { postMessage: (message: unknown) => posted.push(message) },
      { attentionSound: options.attentionSound ?? true },
      setTimeout,
    ) as { playAttention: (id: string) => Promise<void>; primeAttentionAudio: () => void };
    return { ...api, posted, html };
  }

  afterEach(() => {
    FakeAudioContext.startState = 'running';
    FakeAudioContext.resumeAllowed = true;
    vi.useRealTimers();
  });

  it('plays a two-note chime once per id and reports that it started', async () => {
    const { playAttention, posted } = player();
    await playAttention('a1');
    await playAttention('a1');
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0].oscillators).toBe(2);
    expect(posted).toEqual([{ command: 'attentionResult', id: 'a1', audioState: 'running', started: true }]);
  });

  it('reports unavailable when the webview has no Web Audio', async () => {
    const { playAttention, posted } = player({ audio: false });
    await playAttention('a1');
    expect(posted).toEqual([{ command: 'attentionResult', id: 'a1', audioState: 'unavailable', started: false }]);
  });

  it('bounds a resume that never settles without a gesture, and reports suspended', async () => {
    vi.useFakeTimers();
    FakeAudioContext.startState = 'suspended';
    FakeAudioContext.resumeAllowed = false;
    const { playAttention, posted } = player();
    const playing = playAttention('a1');
    await vi.advanceTimersByTimeAsync(500);
    await playing;
    expect(posted).toEqual([{ command: 'attentionResult', id: 'a1', audioState: 'suspended', started: false }]);
    expect(FakeAudioContext.instances[0].oscillators).toBe(0);
  });

  it('starts its audio on the first key or pointer press when the sound is on, and not when it is off', () => {
    FakeAudioContext.startState = 'suspended';
    const on = player();
    on.primeAttentionAudio();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0]).toMatchObject({ state: 'running', resumes: 1 });
    expect(on.html).toContain("window.addEventListener('pointerdown', primeAttentionAudio, true);");
    expect(on.html).toContain("window.addEventListener('keydown', primeAttentionAudio, true);");

    const off = player({ attentionSound: false });
    off.primeAttentionAudio();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});

// v0.9.88 §5.5: a reply holding host-published exact content renders that content verbatim; its text is unchanged.
describe('verbatim content in the chat', () => {
  const content = 'first version\nrework ok\n# not a heading\n* not a bullet';
  const agentReplies = (provider: ChatViewProvider) => ((provider as any).transcriptItems(agent.id) as Array<any>)
    .filter((item) => item.kind === 'message' && item.role === 'agent');
  const publish = (provider: ChatViewProvider, text: string, start: number) => (provider as any).onReply({
    from: agent.id, fromName: agent.name, text, isError: false, verbatim: { start, length: content.length },
  });

  it('renders the published receipt as one exact block and keeps the reply text byte-exact', () => {
    const provider = providerWith();
    const text = `Here it is:\n\n${content}`;
    publish(provider, text, 13);
    const [message] = agentReplies(provider);
    expect(message.text).toBe(text);
    expect(message.blocks[0]).toMatchObject({ type: 'paragraph' });
    expect(message.blocks[1]).toEqual({ type: 'verbatim', text: content, caption: 'Exact content' });
  });

  it('renders it verbatim even when the same text streamed in first as Markdown', () => {
    const provider = providerWith();
    provider.appendDelta(agent.id, content);
    publish(provider, content, 0);
    expect(agentReplies(provider).at(-1).blocks).toEqual([{ type: 'verbatim', text: content, caption: 'Exact content' }]);
  });

  it('gives a promoted duplicate its span as well', () => {
    const provider = providerWith();
    provider.appendDelta(agent.id, content);
    (provider as any).flushLiveMessage(agent.id);
    expect(agentReplies(provider)[0].blocks.some((block: { type: string }) => block.type === 'verbatim')).toBe(false);
    publish(provider, content, 0);
    const replies = agentReplies(provider);
    expect(replies).toHaveLength(1);
    expect(replies[0].blocks).toEqual([{ type: 'verbatim', text: content, caption: 'Exact content' }]);
  });

  it('renders an ordinary reply as Markdown', () => {
    const provider = providerWith();
    (provider as any).onReply({ from: agent.id, fromName: agent.name, text: content, isError: false });
    expect(agentReplies(provider)[0].blocks.some((block: { type: string }) => block.type === 'verbatim')).toBe(false);
  });
});

describe('v0.9.91 tool cards paired by call id', () => {
  type Card = { kind: string; name?: string; phase?: string; callId?: string; ok?: boolean; failureKind?: string; outcome?: unknown };
  const cards = (provider: ChatViewProvider) =>
    ((provider as any).transcriptItems(agent.id) as Card[]).filter((item) => item.kind === 'tool');

  it('finishes each same-name card by its call id, whatever order the results return in', () => {
    const provider = providerWith();
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-1', name: 'read_file', input: { path: 'a.ts' }, epoch: 1 });
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-2', name: 'read_file', input: { path: 'b.ts' }, epoch: 1 });
    // The first result belongs to the first card, which is not the latest open card of that name.
    provider.appendToolActivity(agent.id, {
      phase: 'result', callId: 'call-1', name: 'read_file', epoch: 1,
      outcome: { status: 'success', observedBy: 'host' }, summary: 'read a.ts',
    });
    provider.appendToolActivity(agent.id, {
      phase: 'result', callId: 'call-2', name: 'read_file', epoch: 1,
      outcome: { status: 'failed', observedBy: 'host', failureKind: 'not_found' }, summary: 'missing b.ts',
    });

    // The webview sees a label projected from each card's own outcome, never the outcome itself.
    expect(cards(provider).map((card) => [card.callId, card.phase, card.ok, card.failureKind ?? null, 'outcome' in card])).toEqual([
      ['call-1', 'result', true, null, false],
      ['call-2', 'result', false, 'not_found', false],
    ]);
  });

  it('never finishes an earlier turn\'s pending card with a later turn\'s call id, and never pairs by tool name', () => {
    const provider = providerWith();
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-1', name: 'run_command', input: { command: 'npm test' }, epoch: 1 });
    // Call ids restart every turn: this call-1 belongs to turn 2.
    provider.appendToolActivity(agent.id, {
      phase: 'result', callId: 'call-1', name: 'run_command', epoch: 2,
      outcome: { status: 'refused', observedBy: 'host', reason: 'consent' }, summary: 'declined',
    });
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-2', name: 'write_file', input: { path: 'a.txt' }, epoch: 2 });
    provider.appendToolActivity(agent.id, {
      phase: 'result', callId: 'call-9', name: 'write_file', epoch: 2,
      outcome: { status: 'success', observedBy: 'host' }, summary: 'wrote',
    });

    expect(cards(provider).map((card) => [card.name, card.callId, card.phase, card.failureKind ?? null])).toEqual([
      ['run_command', 'call-1', 'use', null],
      ['run_command', 'call-1', 'result', 'blocked'],
      ['write_file', 'call-2', 'use', null],
      ['write_file', 'call-9', 'result', null],
    ]);
  });

  it('stores a new card with its call id and typed outcome only, and restores an old card through the decoder', () => {
    const deps = depsFor();
    const provider = providerWith(deps);
    provider.appendToolActivity(agent.id, { phase: 'use', callId: 'call-1', name: 'run_command', input: { command: 'rm -rf x' }, epoch: 3 });
    provider.appendToolActivity(agent.id, {
      phase: 'result', callId: 'call-1', name: 'run_command', epoch: 3,
      outcome: { status: 'refused', observedBy: 'host', reason: 'trust' }, summary: 'all good',
    });
    const stored = deps.state.get<any[]>(chatToolsKey(agent.id))!;
    expect(stored).toEqual([expect.objectContaining({
      callId: 'call-1', turnEpoch: 3, outcome: { status: 'refused', observedBy: 'host', reason: 'trust' },
    })]);
    expect(stored[0]).not.toHaveProperty('ok');
    expect(stored[0]).not.toHaveProperty('failureKind');

    // A card from before v0.9.91 keeps its old label; one that claims both keeps only the typed outcome.
    void deps.state.update(chatToolsKey(agent.id), [
      { kind: 'tool', id: 'legacy', ts: '2026-01-01T00:00:00.000Z', phase: 'result', name: 'read_file', title: 'Read', summary: 'x', category: 'read', ok: false, failureKind: 'not_found' },
      { kind: 'tool', id: 'both', ts: '2026-01-01T00:00:01.000Z', phase: 'result', name: 'run_command', title: 'Run', summary: 'x', category: 'run', ok: true, outcome: { status: 'failed', observedBy: 'provider-protocol', failureKind: 'error' } },
      // An invalid outcome beside an old label: the label never stands in for the outcome.
      { kind: 'tool', id: 'forged', ts: '2026-01-01T00:00:02.000Z', phase: 'result', name: 'run_command', title: 'Run', summary: 'x', category: 'run', ok: true, failureKind: 'not_found', outcome: { status: 'refused', observedBy: 'provider-protocol', reason: 'consent' } },
    ]);
    const restored = cards(new ChatViewProvider({} as never, deps));
    expect(restored.map((card) => [card.ok ?? null, card.failureKind ?? null])).toEqual([
      [false, 'not_found'],
      [false, 'error'],
      // A refusal the provider claims is not a valid fact: nothing is classified, and nothing is invented.
      [null, null],
    ]);
  });
});
