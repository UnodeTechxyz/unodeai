import { describe, expect, it, vi } from 'vitest';

const executeCommand = vi.fn();
vi.mock('vscode', () => ({ commands: { executeCommand: (...args: unknown[]) => executeCommand(...args) } }));

import { Checkpoint } from '../../backend/Checkpoints';
import { ChatAgent, ChatViewDeps, ChatViewProvider } from '../ChatViewProvider';

const agent: ChatAgent = { id: 'agent-1', name: 'Dev', role: 'Developer', backend: 'openai' };
const other: ChatAgent = { id: 'agent-2', name: 'QA', role: 'Reviewer', backend: 'openai' };

function checkpoint(over: Partial<Checkpoint>): Checkpoint {
  return { id: 1, agentId: 'agent-1', agentName: 'Dev', path: 'src/app.ts', before: 'a', after: 'b', ts: 1000, ...over };
}

function depsFor(checkpoints: Checkpoint[]): ChatViewDeps {
  const store = new Map<string, unknown>();
  return {
    listAgents: () => [agent, other],
    send: vi.fn(),
    interject: vi.fn(),
    interrupt: vi.fn(),
    onReply: () => vi.fn(),
    state: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
    getCheckpoints: () => checkpoints,
  } as ChatViewDeps;
}

function providerWith(checkpoints: Checkpoint[] = []): ChatViewProvider {
  const provider = new ChatViewProvider({} as never, depsFor(checkpoints));
  provider.selectAgent(agent.id);
  return provider;
}

function stateOf(provider: ChatViewProvider): {
  inspectorOpen: boolean;
  changedFileGroups: Array<{ agentId: string; agentName: string; files: Array<{ path: string; checkpointId: number }> }>;
} {
  return (provider as unknown as { currentState: () => never }).currentState();
}

function send(provider: ChatViewProvider, msg: unknown): void {
  (provider as unknown as { onMessage: (m: unknown) => void }).onMessage(msg);
}

describe('Workbench inspector rail', () => {
  it('starts closed — the Workbench has to be useful without it', () => {
    expect(stateOf(providerWith()).inspectorOpen).toBe(false);
  });

  it('shows a coordinator the crew’s edits grouped by owner, from the shared checkpoint record', () => {
    const provider = providerWith([
      checkpoint({ id: 1, path: 'src/old.ts', ts: 1000 }),
      checkpoint({ id: 2, path: 'src/new.ts', ts: 5000 }),
      checkpoint({ id: 3, path: 'src/theirs.ts', ts: 9000, agentId: 'agent-2', agentName: 'QA' }),
    ]);
    expect(stateOf(provider).changedFileGroups).toEqual([
      { agentId: 'agent-1', agentName: 'Dev', files: [
        { path: 'src/new.ts', checkpointId: 2, ts: 5000 },
        { path: 'src/old.ts', checkpointId: 1, ts: 1000 },
      ] },
      { agentId: 'agent-2', agentName: 'QA', files: [
        { path: 'src/theirs.ts', checkpointId: 3, ts: 9000 },
      ] },
    ]);

    provider.selectAgent(other.id);
    expect(stateOf(provider).changedFileGroups.map((group) => group.agentId)).toEqual(['agent-1', 'agent-2']);
  });

  it('reports no files rather than every file when the host provides no checkpoints', () => {
    const provider = new ChatViewProvider({} as never, { ...depsFor([]), getCheckpoints: undefined } as ChatViewDeps);
    provider.selectAgent(agent.id);
    expect(stateOf(provider).changedFileGroups).toEqual([]);
  });

  it('keeps an unprovable native change reviewable while making its disabled restore honest', () => {
    const provider = providerWith([checkpoint({
      before: null,
      after: 'replacement',
      restoreDisabledReason: 'overwrote-existing',
    })]);
    const state = stateOf(provider) as unknown as {
      changedFileGroups: Array<{ files: Array<{ path: string; restoreDisabledReason?: string }> }>;
    };
    expect(state.changedFileGroups[0].files).toEqual([{
      path: 'src/app.ts', checkpointId: 1, ts: 1000,
      restoreDisabledReason: 'The write replaced an existing file, whose prior contents were not available.',
    }]);

    const html = (provider as unknown as { getHtml: (w: unknown, c: string) => string })
      .getHtml({ cspSource: 'test:' }, 'workbench');
    expect(html).toContain("restore.disabled = !!restoreDisabledReason");
    expect(html).toContain("unavailable.textContent = 'Restore unavailable: ' + restoreDisabledReason");
  });

  it('distinguishes a genuinely empty team from a selected agent with teammates’ edits', () => {
    const claude = { ...agent, backend: 'claude' };
    const provider = new ChatViewProvider({} as never, depsFor([]));
    (provider as unknown as { deps: ChatViewDeps }).deps.listAgents = () => [claude];
    provider.selectAgent(claude.id);

    const html = (provider as unknown as { getHtml: (w: unknown, c: string) => string })
      .getHtml({ cspSource: 'test:' }, 'workbench');
    expect(html).toContain('Nobody on this team has changed any files yet.');
    expect(html).toContain("hasn't changed any files yet. Showing edits from teammates.");
  });

  it('routes a rail action through the host by checkpoint id, never by path', () => {
    const provider = providerWith([checkpoint({ id: 7 })]);
    executeCommand.mockClear();

    send(provider, { command: 'openCheckpointDiff', checkpointId: 7 });
    expect(executeCommand).toHaveBeenCalledWith('unode.showCheckpointDiff', 7);

    send(provider, { command: 'restoreCheckpoint', checkpointId: 7 });
    expect(executeCommand).toHaveBeenCalledWith('unode.restoreCheckpointById', 7);
  });

  it('uses the same checkpoint action path for every grouped entry', () => {
    const html = (providerWith() as unknown as { getHtml: (w: unknown, c: string) => string })
      .getHtml({ cspSource: 'test:' }, 'workbench');
    expect(html).toContain('group.files.map((file) => renderInspectorFile(file))');
    expect(html).toContain("vscode.postMessage({ command: 'restoreCheckpoint', checkpointId: file.checkpointId });");
  });

  it('drops a rail action whose id is not a real checkpoint id', () => {
    const provider = providerWith([checkpoint({ id: 7 })]);
    for (const checkpointId of [undefined, null, -1, 1.5, NaN, 'src/../../etc/passwd', '7; rm -rf /', {}]) {
      executeCommand.mockClear();
      send(provider, { command: 'restoreCheckpoint', checkpointId });
      expect(executeCommand, String(checkpointId)).not.toHaveBeenCalled();
    }
  });

  it('routes every chat action rendered in the session menu, and only those', () => {
    // The Workbench tab has no view title bar, so these menu items live in the webview and NAME a command.
    // That makes the host allowlist the boundary: a rendered button is a request, not an authorisation.
    const provider = providerWith();
    const html = (provider as unknown as { getHtml: (w: unknown, c: string) => string })
      .getHtml({ cspSource: 'test:' }, 'workbench');
    const rendered = [...new Set([...html.matchAll(/data-chat-command="([^"]+)"/g)].map((m) => m[1]))];
    expect(rendered.length).toBeGreaterThan(3);

    for (const target of rendered) {
      executeCommand.mockClear();
      send(provider, { command: 'chatCommand', target });
      expect(executeCommand, `${target} is rendered but the host ignores it`).toHaveBeenCalledWith(target);
    }

    for (const forged of ['unode.openSettings', 'workbench.action.reloadWindow', 'unode.clearChat ', '', 42, null, {}]) {
      executeCommand.mockClear();
      send(provider, { command: 'chatCommand', target: forged });
      expect(executeCommand, String(forged)).not.toHaveBeenCalled();
    }
  });

  it('says each thing about the session once, and nothing that says nothing', () => {
    const html = (providerWith() as unknown as { getHtml: (w: unknown, c: string) => string })
      .getHtml({ cspSource: 'test:' }, 'workbench');

    // Lifecycle state belongs to the Team row.
    expect(html).not.toContain('id="sessionStatus"');
    expect(html).not.toContain("getElementById('sessionStatus')");
    // "Ready for your next task" was a placeholder standing in for an absent fact.
    expect(html).not.toContain('id="sessionTask"');
    expect(html).not.toContain('Ready for your next task');
    // Context is in the facts line and beside the composer. The old strip between the header and plan
    // was a third reading of the same number and no longer exists in either shared rendering container.
    expect(html).not.toContain('id="contextText"');
    expect(html).not.toContain('id="contextPercent"');
    expect(html).not.toContain('id="contextFill"');
    expect(html).toContain('id="ctxMeter"');
    expect(html).toContain('id="ctxCompact"');
    expect(html).toContain('id="sessionFacts"');
  });

  /**
   * The answer has to be findable without reading the turn that produced it.
   *
   * Marked rather than hidden: the alternative is to fold the process behind a "working for Nm Ns"
   * disclosure, which buys the same clarity by taking the evidence off screen — and the evidence staying on
   * screen is the product. A live frame is not a conclusion and neither is an error; both would be a box
   * around something that is not an answer.
   */
  it('marks a finished agent reply as the conclusion, and nothing else as one', () => {
    const html = (providerWith() as unknown as { getHtml: (w: unknown, c: string) => string })
      .getHtml({ cspSource: 'test:' }, 'workbench');

    expect(html).toContain("const isConclusion = message.role === 'agent' && !message.live && !message.isError && !!message.text;");
    expect(html).toContain("(isConclusion ? ' conclusion' : '')");
    expect(html).toContain('.msg.agent.conclusion {');
  });

  /**
   * Green is the colour of "the framework observed this and it passed". A conclusion is a claim an agent
   * made, so painting one green would put a verified mark on prose nothing verified — the one thing this
   * product exists not to do. Pinned as a test because the next person asked for a green box will otherwise
   * simply add one.
   */
  it('does not colour a claim with the colour reserved for an observed verdict', () => {
    const html = (providerWith() as unknown as { getHtml: (w: unknown, c: string) => string })
      .getHtml({ cspSource: 'test:' }, 'workbench');
    const block = html.slice(html.indexOf('.msg.agent.conclusion {'), html.indexOf('.msg.error {'));

    expect(block).not.toMatch(/green|--vscode-charts-green|testing-iconPassed|gitDecoration-addedResource/i);
    expect(block).toContain('--unode-conclusion-accent');
  });

  /**
   * The delegating tail renders one clock per teammate, on one line.
   *
   * The shared ticker already updates every [data-elapsed-start] node in the transcript once a second, so
   * several clocks needed no new timing machinery — only a branch that emits several nodes instead of one.
   */
  it('renders a clock per teammate while a coordinator is delegating', () => {
    const html = (providerWith() as unknown as { getHtml: (w: unknown, c: string) => string })
      .getHtml({ cspSource: 'test:' }, 'workbench');

    // The tail must appear for a coordinator that is NOT in runningAgentIds — that is the whole point.
    expect(html).toContain("const out = (state.delegatingOut || {})[agentId] || [];");
    expect(html).toContain("return out.length > 0 ? { delegations: out } : undefined;");
    expect(html).toContain("'delegating to ' + delegation.agentName + ', '");
    // Several on one line, separated, each with its own elapsed node.
    expect(html).toContain("separator.textContent = '; '");
    expect(html).toContain('node.append(who, elapsedNode(delegation.startedAt))');
  });

  it('collapses Workbench actions into one keyboard-operable menu', () => {
    const html = (providerWith() as unknown as { getHtml: (w: unknown, c: string) => string })
      .getHtml({ cspSource: 'test:' }, 'workbench');
    const menuMarkup = html.slice(html.indexOf('<span class="session-actions-row">'), html.indexOf('</div>', html.indexOf('<span class="session-actions-row">')));

    expect(menuMarkup).toContain('aria-haspopup="menu"');
    expect(menuMarkup).toContain('aria-expanded="false"');
    expect(menuMarkup).toContain('role="menu"');
    expect(menuMarkup.match(/role="menuitem"/g)).toHaveLength(6);
    expect(menuMarkup).toContain('>…</button>');
    // The row itself carries no glyph: the trigger is a plain ellipsis, because a character that fails to
    // render there leaves a button nobody can identify. Inside the menu the label carries the meaning, so a
    // leading glyph is decoration that survives a bad render — and it is marked `aria-hidden` accordingly.
    const trigger = menuMarkup.slice(0, menuMarkup.indexOf('id="sessionMenu"'));
    expect(trigger).not.toMatch(/[🗄🧹💾📂🕘]/u);
    expect(trigger).toContain('>…</button>');
    expect(menuMarkup.match(/class="menu-glyph" aria-hidden="true"/g)).toHaveLength(6);
    // Context compaction remains beside its meter, not mixed into transcript/session actions.
    expect(menuMarkup).not.toContain('id="ctxCompact"');

    expect(html).toContain("event.key === 'ArrowDown' || event.key === 'ArrowUp'");
    expect(html).toContain("event.key === 'Enter' || event.key === ' '");
    expect(html).toContain("event.key === 'Escape'");
    expect(html).toContain('setSessionMenuOpen(false, true)');
    expect(html).toContain('!sessionMenu.contains(event.target)');
  });

  it('stops floating the composer when the viewport is too short to float in', () => {
    // At 200% zoom the CSS viewport halves while the column's hard minimums do not, so the column
    // overflows and the fixed dock ends up on top of the conversation. Reserving more space cannot fix
    // that — there is none — so the dock returns to the flex column, where it cannot cover anything.
    const html = (providerWith() as unknown as { getHtml: (w: unknown, c: string) => string })
      .getHtml({ cspSource: 'test:' }, 'workbench');

    const shortViewport = html.slice(html.indexOf('@media (max-height: 560px)'));
    expect(shortViewport).toContain('position: static');
    // ...and the rail stops reserving room for a dock that is no longer over it.
    expect(shortViewport.slice(0, 800)).toContain('.inspector { bottom: 0; }');
  });

  it('lets the Workbench transcript use the full height beneath the transparent floating composer', () => {
    const html = (providerWith() as unknown as { getHtml: (w: unknown, c: string) => string })
      .getHtml({ cspSource: 'test:' }, 'workbench');
    const composerRegion = html.slice(html.indexOf('.composer-dock, .composer-shell'), html.indexOf('.inspector { display: none; }'));

    expect(composerRegion).not.toContain('padding-bottom: var(--composer-dock-h');
    expect(composerRegion).toContain('#approvals:not([hidden]) .appr-card');
    expect(composerRegion).toContain('scroll-margin-bottom: calc(var(--composer-dock-h, 0px) + 16px);');
  });

  it('opens and closes on the host’s say-so', () => {
    const provider = providerWith();
    provider.setInspectorOpen(true);
    expect(provider.isInspectorOpen()).toBe(true);
    expect(stateOf(provider).inspectorOpen).toBe(true);
    provider.setInspectorOpen(false);
    expect(stateOf(provider).inspectorOpen).toBe(false);
  });
});
