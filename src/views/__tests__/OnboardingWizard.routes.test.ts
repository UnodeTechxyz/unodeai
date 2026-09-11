import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { EffectiveConnectionRegistry } from '../../routes/ConnectionRegistry';

const state = vi.hoisted(() => ({
  message: undefined as ((message: unknown) => Promise<void>) | undefined,
  html: '',
  postMessages: [] as unknown[],
}));

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1 },
  window: {
    createWebviewPanel: vi.fn(() => {
      const webview = {
        cspSource: 'test:',
        html: '',
        postMessage: vi.fn((message: unknown) => { state.postMessages.push(message); }),
        onDidReceiveMessage: vi.fn((listener) => {
          state.message = listener;
          return { dispose: vi.fn() };
        }),
      };
      return {
        webview,
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
        reveal: vi.fn(),
        dispose: vi.fn(),
      };
    }),
  },
}));

import { OnboardingWizard } from '../OnboardingWizard';

function openWizard(overrides: Partial<Parameters<typeof OnboardingWizard.createOrShow>[1]> = {}) {
  const deps = {
    getCurrentConnectionId: () => 'unode',
    saveProvider: vi.fn(async () => {}),
    createQuickStartTeam: vi.fn(async () => 4),
    createSolo: vi.fn(async () => true),
    createCustomAgent: vi.fn(async () => {}),
    runDemoTask: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    openCommand: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    openConnectionSetup: vi.fn(async () => {}),
    addCustomGateway: vi.fn(async () => undefined),
    demoTasks: [],
    ...overrides,
  };
  OnboardingWizard.createOrShow({} as never, deps);
  const panel = (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
  state.html = panel.webview.html;
  return deps;
}

describe('OnboardingWizard connection routes', () => {
  beforeEach(() => {
    state.message = undefined;
    state.html = '';
    state.postMessages = [];
    (OnboardingWizard as { current?: unknown }).current = undefined;
    vi.clearAllMocks();
  });

  it('renders exactly three peer connection doors from the registry', () => {
    openWizard();

    expect(state.html).toContain('OpenAI-compatible connection');
    expect(state.html).toContain('Claude Headless');
    expect(state.html).toContain('Codex Headless');
    expect(state.html).toContain('npm install -g @anthropic-ai/claude-code');
    expect(state.html).toContain('npm install -g @openai/codex');
    expect((state.html.match(/"kind":"(?:openai-compatible|claude-headless|codex-headless)"/g) ?? [])).toHaveLength(3);
  });

  it('uses the shared display sort so Unode precedes Roam in the wizard', () => {
    openWizard();

    const groupStart = state.html.indexOf('"kind":"openai-compatible"');
    const unodeIndex = state.html.indexOf('"id":"unode"', groupStart);
    const roamIndex = state.html.indexOf('"id":"roam"', groupStart);
    expect(groupStart).toBeGreaterThanOrEqual(0);
    expect(unodeIndex).toBeGreaterThan(groupStart);
    expect(roamIndex).toBeGreaterThan(unodeIndex);
  });

  it('keeps Claude setup available but rejects Codex setup because it is Coming soon', async () => {
    const deps = openWizard();
    await state.message?.({ command: 'openConnectionSetup', connectionId: 'codex-cli' });

    expect(deps.openConnectionSetup).not.toHaveBeenCalled();

    await state.message?.({ command: 'openConnectionSetup', connectionId: 'claude-cli' });
    expect(deps.openConnectionSetup).toHaveBeenLastCalledWith('claude-cli');
  });

  it('rejects forged connection ids before setup or settings save', async () => {
    const deps = openWizard();
    await state.message?.({ command: 'openConnectionSetup', connectionId: 'not-a-connection' });
    await state.message?.({ command: 'saveProvider', connectionId: 'not-a-connection', apiKey: 'x' });

    expect(deps.openConnectionSetup).not.toHaveBeenCalled();
    expect(deps.saveProvider).not.toHaveBeenCalled();
  });

  it('creates a custom gateway only through the host, then refreshes and selects its opaque id', async () => {
    const customId = 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const resolver = new EffectiveConnectionRegistry({
      registryRevision: 1,
      profiles: [{
        schemaVersion: 1,
        connectionId: customId,
        revision: 1,
        state: 'active',
        displayName: 'Personal Gateway',
        endpointBase: 'https://gateway.example/v1',
        secretRef: 'custom-gateway:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        billingKind: 'custom-account',
      }],
    });
    const addCustomGateway = vi.fn(async () => customId);
    const deps = openWizard({ addCustomGateway, connectionResolver: () => resolver });

    await state.message?.({ command: 'addCustomGateway', apiKey: 'must-not-cross-the-webview-boundary' } as never);

    expect(addCustomGateway).toHaveBeenCalledOnce();
    expect(addCustomGateway).toHaveBeenCalledWith();
    const refresh = state.postMessages.find((message) =>
      typeof message === 'object' && message !== null && (message as { command?: string }).command === 'initialData',
    ) as { currentConnectionId?: string; connectionGroups?: unknown } | undefined;
    expect(refresh).toMatchObject({ currentConnectionId: customId });
    expect(JSON.stringify(state.postMessages)).not.toContain('must-not-cross-the-webview-boundary');
    expect(JSON.stringify(refresh?.connectionGroups)).not.toContain('custom-gateway:');
    expect(deps.saveProvider).not.toHaveBeenCalled();

    OnboardingWizard.refreshCurrent();
    const coalescedRefresh = state.postMessages.at(-1) as { currentConnectionId?: string } | undefined;
    expect(coalescedRefresh).toMatchObject({ command: 'initialData', currentConnectionId: customId });
  });

  it('leaves the existing selection in place when native custom-gateway creation is cancelled', async () => {
    const addCustomGateway = vi.fn(async () => undefined);
    openWizard({ addCustomGateway });

    await state.message?.({ command: 'addCustomGateway' });

    expect(addCustomGateway).toHaveBeenCalledOnce();
    expect(state.postMessages).toEqual([]);
    expect(state.html).toContain('connectionSelector.value = selectedConnectionId;');
  });

  it('hides the generic key field for custom profiles and keeps the sentinel keyless', () => {
    openWizard();

    expect(state.html).toContain('id="api-key-fields"');
    expect(state.html).toContain("apiKeyFields.style.display = isCompatible && !isCustomGateway ? '' : 'none';");
    expect(state.html).toContain("vscode.postMessage({ command: 'addCustomGateway' });");
    expect(state.html).toContain("selectedConnectionId.startsWith('custom:') ? undefined : apiKey.value");
  });

  it('makes New Task the only final action and keeps its Workbench route allowlisted', async () => {
    const deps = openWizard();

    expect(state.html).toContain('data-open-command="unode.openWorkbench"');
    // Named after what it opens, per the v0.9.54 vocabulary: this card reveals a surface, it starts nothing.
    expect(state.html).toContain('class="card-title">Open Workbench<');
    expect(state.html).not.toContain('data-open-command="unode.showDashboard"');
    expect(state.html).not.toContain('data-open-command="unode.openSettings"');

    await state.message?.({ command: 'openCommand', target: 'unode.openWorkbench' });
    expect(deps.openCommand).toHaveBeenCalledWith('unode.openWorkbench');

    await state.message?.({ command: 'openCommand', target: 'unode.showSecurity' });
    expect(deps.openCommand).toHaveBeenLastCalledWith('unode.showSecurity');

    await state.message?.({ command: 'openCommand', target: 'unode.showDashboard' });
    expect(deps.openCommand).toHaveBeenCalledTimes(2);
  });
});

describe('OnboardingWizard tells the truth about what it created', () => {
  beforeEach(() => {
    state.message = undefined;
    state.html = '';
    state.postMessages = [];
    (OnboardingWizard as { current?: unknown }).current = undefined;
    vi.clearAllMocks();
  });

  const statuses = () =>
    state.postMessages.filter((m): m is { command: string; text: string; isError: boolean } =>
      (m as { command?: string }).command === 'status');

  // The team door opens a native QuickPick over the wizard webview, and clicking back into a webview
  // dismisses a QuickPick. So "the command ran" and "a team exists" genuinely diverge — and the wizard
  // used to post "Quick Start team created." on BOTH paths. The Owner walked the whole setup believing
  // a team existed (2026-07-30). These pin status to the count the host actually reports.
  it('reports a dismissed team picker as a failure, not a success', async () => {
    openWizard({ createQuickStartTeam: vi.fn(async () => 0) });

    await state.message?.({ command: 'createTeam', mode: 'quick' });

    const [status] = statuses();
    expect(status.isError).toBe(true);
    expect(status.text).toContain('No team was created');
    expect(status.text).not.toContain('Team created'); // no success phrasing on the failure path
  });

  it('reports a created team with its actual size', async () => {
    openWizard({ createQuickStartTeam: vi.fn(async () => 4) });

    await state.message?.({ command: 'createTeam', mode: 'quick' });

    const [status] = statuses();
    expect(status.isError).toBe(false);
    expect(status.text).toBe('Team created — 4 agents on the roster.');
  });

  it('reports a cancelled Solo dialog instead of announcing a chat that will not open', async () => {
    openWizard({ createSolo: vi.fn(async () => false) });

    await state.message?.({ command: 'createTeam', mode: 'solo' });

    const [status] = statuses();
    expect(status.isError).toBe(true);
    expect(status.text).toContain('cancelled');
  });

  it('still announces Solo when one is actually ready', async () => {
    openWizard({ createSolo: vi.fn(async () => true) });

    await state.message?.({ command: 'createTeam', mode: 'solo' });

    const [status] = statuses();
    expect(status.isError).toBe(false);
    expect(status.text).toContain('Solo agent ready');
  });

  /**
   * The demo is optional and now looks it.
   *
   * It used to be a step of its own, which is how a wizard tells someone a thing is required — you cannot
   * reach the end without passing through it, so the page had to carry a "Do nothing" card to say otherwise.
   * A row on the final screen, under Finish, says the same thing by its position and needs no opt-out card.
   */
  it('offers the demo as an optional row on the last step rather than a step of its own', () => {
    openWizard();

    expect(state.html).toContain('id="demo-grid"');
    expect(state.html).toContain('Or try it first');
    // No step to skip, so nothing to decline.
    expect(state.html).not.toContain('Do nothing');
    expect(state.html).not.toContain('data-goto');
  });

  /**
   * Three steps: connect, choose how you work, start. It was six — a welcome screen listing the other five,
   * an optional demo on a screen of its own, and a safety screen the user had to pass through to reach the
   * end. None of those three asked for a decision, and a first-time user reads a six-dot progress bar as a
   * measure of how much is being asked of them.
   */
  it('asks for three steps, and only where a decision is actually needed', () => {
    openWizard();

    const steps = [...state.html.matchAll(/data-step="(\d+)"/g)].map((match) => match[1]);
    expect([...new Set(steps)]).toEqual(['0', '1', '2']);
    expect(state.html).toContain('const maxStep = 2;');

    // The safety promises are true whether or not anyone reads them, so they are a line you can open rather
    // than a screen you must pass. They must still be present and still reach the Security panel.
    expect(state.html).toContain('class="safety-note"');
    expect(state.html).toContain('Safe by default');
    expect(state.html).toContain('data-open-command="unode.showSecurity"');
  });

  it('makes a work-style card create the selected setup and does not leave a separate Start button', () => {
    openWizard();

    // The generic data-action handler still contains a createTeam branch for older controls. Assert the
    // actual team-card click path, otherwise a card that only selects (or always creates Quick Start)
    // can leave this test falsely green.
    const cardClick = state.html.match(/const team = target\.closest\('\[data-team-mode\]'\);[\s\S]*?return;/)?.[0] ?? '';
    expect(cardClick).toContain("vscode.postMessage({ command: 'createTeam', mode: teamMode })");
    expect(state.html).not.toMatch(/data-action="createTeam"[^>]*>Start</);
    expect(state.html).not.toContain('Press Start to');
  });
});
