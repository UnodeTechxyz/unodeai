import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { ChatAgent, ChatViewDeps, ChatViewProvider } from '../ChatViewProvider';
import { bootWebviewScript, type WebviewElement } from './support/webviewBoot';

// v0.9.100 (the Owner, 2026-10-30): Autonomy is one menu in the chat input with three positions. Each item's
// explanation is shown only inside the open menu; the header, the agent picker and the composer show none.
const menu: NonNullable<ChatAgent['autonomyMenu']> = {
  selected: 'workspace',
  items: [
    { mode: 'workspace', label: 'Approve for me', description: 'Asks before file edits. Host file tools use workspace, granted and task scope.' },
    { mode: 'review', label: 'Ask for approval', description: 'Host file tools use workspace, granted and task scope; mediated writes use review.' },
    { mode: 'full-access', label: 'Full access', description: 'Host file tools can reach files your OS account permits.' },
  ],
};
const selected: ChatAgent = { id: 'selected', name: 'Selected', role: 'developer', backend: 'claude', autonomyMenu: menu };
const active: ChatViewProvider[] = [];
afterEach(() => active.splice(0).forEach(provider => provider.dispose()));

function fixture(agent: ChatAgent = selected, setAutonomy = vi.fn(async (_id: string, _choice: string) => {}), container?: 'workbench') {
  const store = new Map<string, unknown>();
  const agents = [
    ...Array.from({ length: 3 }, (_, index) => ({ ...selected, id: `irrelevant-${index}`, name: `Other ${index}` })), agent,
  ];
  const deps: ChatViewDeps = {
    listAgents: () => agents, send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(), onReply: () => () => {},
    getApprovals: () => ({ command: 'none', write: 'ask' }), setApproval: vi.fn(), setAutonomy, onModeChange: vi.fn(),
    state: { get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { store.set(key, value); } } as never,
  } as ChatViewDeps;
  const provider = new ChatViewProvider({} as never, deps);
  active.push(provider);
  provider.selectAgent(agent.id);
  let receive: ((msg: unknown) => void) | undefined;
  const view = { visible: true, show: vi.fn(),
    onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }),
    webview: { cspSource: 'test:', html: '', options: {}, postMessage: vi.fn(),
      onDidReceiveMessage: (listener: (msg: unknown) => void) => { receive = listener; return { dispose() {} }; } } };
  provider.resolveWebviewView(view as never);
  const html = container ? (provider as any).getHtml({ cspSource: 'test:' }, container) as string : view.webview.html;
  const boot = bootWebviewScript(html, { focusModel: {} });
  return { deps, provider, view, html, boot, receive: (msg: unknown) => receive!(msg) };
}

const items = (boot: ReturnType<typeof bootWebviewScript>) => boot.elements.get('autonomyMenu')!.children as unknown as WebviewElement[];
const key = (k: string) => ({ key: k, preventDefault: vi.fn() });

describe('the chat input Autonomy menu (v0.9.100)', () => {
  // Field: from Ask for approval, Approve for me could not be chosen with the mouse. The press moved focus, the
  // focused item closed its explanation, and the bottom-anchored menu moved the item out from under the pointer.
  it('a press on an item leaves focus where it is, so nothing moves before the click lands', () => {
    const { boot } = fixture();
    for (const item of items(boot)) {
      const press = { preventDefault: vi.fn() };
      boot.dispatchElementEvent(item, 'mousedown', press);
      expect(press.preventDefault).toHaveBeenCalledTimes(1);
    }
  });

  for (const container of [undefined, 'workbench'] as const) {
    it(`shows only the selected position, with three described items, on the ${container ?? 'sidebar'} surface`, () => {
      const { boot, html } = fixture(selected, undefined, container);
      const button = boot.elements.get('autonomyButton')!;
      expect(button.textContent).toBe('Approve for me');
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-label')).toBe('Autonomy: Approve for me');
      expect(boot.elements.get('autonomyMenu')!.hidden).toBe(true);
      const rendered = items(boot);
      expect(rendered.map(item => (item.children as unknown as WebviewElement[])[0].textContent))
        .toEqual(['Approve for me', 'Ask for approval', 'Full access']);
      expect(rendered.map(item => item.getAttribute('role'))).toEqual(['menuitemradio', 'menuitemradio', 'menuitemradio']);
      expect(rendered.map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
      rendered.forEach((item, index) => {
        const description = (item.children as unknown as WebviewElement[])[1];
        expect(description.textContent).toBe(menu.items[index].description);
        expect(item.getAttribute('aria-describedby')).toBe(description.id);
      });
      // Nowhere else: no header line, no "Effective", no Custom label, no picker suffix.
      expect(html).not.toMatch(/sessionAutonomy|autonomySummary|autonomyDetail|Use User default|Effective: /);
      expect(boot.elements.get('agent')!.children.length).toBeGreaterThan(0);
      for (const option of boot.elements.get('agent')!.children as unknown as WebviewElement[]) {
        expect(option.textContent).not.toContain(' · ');
      }
    });
  }

  it('opens on click, chooses with a click, closes and sends only that choice for the selected agent', async () => {
    const { deps, boot, receive } = fixture();
    const button = boot.elements.get('autonomyButton')!;
    boot.dispatchElementEvent(button, 'click');
    expect(boot.elements.get('autonomyMenu')!.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(boot.activeElement()).toBe(items(boot)[0]);
    boot.dispatchElementEvent(items(boot)[2], 'click');
    expect(boot.elements.get('autonomyMenu')!.hidden).toBe(true);
    expect(boot.activeElement()).toBe(button);
    const sent = boot.postedMessages.filter((msg: any) => msg.command === 'setAutonomy');
    expect(sent).toEqual([{ command: 'setAutonomy', agentId: 'selected', choice: 'full-access' }]);
    receive(sent[0]);
    await Promise.resolve();
    expect(deps.setAutonomy).toHaveBeenCalledWith('selected', 'full-access');
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.interrupt).not.toHaveBeenCalled();
    expect(deps.setApproval).not.toHaveBeenCalled();
  });

  it('works from the keyboard: arrows move, Enter chooses, Escape closes and returns focus', () => {
    const { boot } = fixture();
    const button = boot.elements.get('autonomyButton')!;
    const menuElement = boot.elements.get('autonomyMenu')!;
    boot.dispatchElementEvent(button, 'keydown', key('ArrowDown'));
    expect(menuElement.hidden).toBe(false);
    expect(boot.activeElement()).toBe(items(boot)[0]);
    boot.dispatchElementEvent(menuElement, 'keydown', key('ArrowDown'));
    expect(boot.activeElement()).toBe(items(boot)[1]);
    boot.dispatchElementEvent(menuElement, 'keydown', key('ArrowUp'));
    boot.dispatchElementEvent(menuElement, 'keydown', key('ArrowUp'));
    expect(boot.activeElement()).toBe(items(boot)[2]);
    boot.dispatchElementEvent(menuElement, 'keydown', key('Escape'));
    expect(menuElement.hidden).toBe(true);
    expect(boot.activeElement()).toBe(button);
    expect(boot.postedMessages.some((msg: any) => msg.command === 'setAutonomy')).toBe(false);
    boot.dispatchElementEvent(button, 'keydown', key('ArrowDown'));
    boot.dispatchElementEvent(menuElement, 'keydown', key('ArrowDown'));
    boot.dispatchElementEvent(menuElement, 'keydown', key('Enter'));
    expect(boot.postedMessages.filter((msg: any) => msg.command === 'setAutonomy'))
      .toEqual([{ command: 'setAutonomy', agentId: 'selected', choice: 'review' }]);
    expect(menuElement.hidden).toBe(true);
  });

  it('is disabled with no menu for the selection, and refuses stale or malformed choices on the host', () => {
    const { boot } = fixture({ ...selected, autonomyMenu: undefined });
    expect(boot.elements.get('autonomyButton')!.disabled).toBe(true);
    boot.dispatchElementEvent(boot.elements.get('autonomyButton')!, 'click');
    expect(boot.elements.get('autonomyMenu')!.hidden).toBe(true);
    const { deps, receive } = fixture();
    receive({ command: 'setAutonomy', agentId: 'irrelevant-2', choice: 'full-access' });
    receive({ command: 'setAutonomy', agentId: 'unknown', choice: 'full-access' });
    receive({ command: 'setAutonomy', agentId: 'selected', choice: 'administrator' });
    receive({ command: 'setAutonomy', agentId: 'selected', choice: 'full-access', trusted: true });
    expect(deps.setAutonomy).not.toHaveBeenCalled();
  });

  it('shows the host-resolved native Codex position, never a lower one', () => {
    const codexMenu = { ...menu, selected: 'full-access' as const, items: menu.items.map(item => item.mode === 'full-access'
      ? { ...item, description: "Codex's own saved setting: Full access. No sandbox and no approval prompts. " + item.description } : item) };
    const { boot } = fixture({ ...selected, backend: 'codex', codexPermissionProfile: 'full-access', autonomyMenu: codexMenu });
    expect(boot.elements.get('autonomyButton')!.textContent).toBe('Full access');
    expect(items(boot).map(item => item.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
    expect((items(boot)[2].children as unknown as WebviewElement[])[1].textContent).toContain('No sandbox and no approval prompts.');
    expect(boot.elements.get('codexPermissionControl')!.hidden).toBe(true);
  });

  it('shares the actual Plan mode with the host and adds no Autonomy text for it', () => {
    const { provider, receive, deps, view } = fixture();
    expect(provider.getAgentMode('selected')).toBe('act');
    receive({ command: 'setMode', agentId: 'selected', mode: 'plan' });
    expect(provider.getAgentMode('selected')).toBe('plan');
    expect(deps.onModeChange).toHaveBeenCalledWith('selected', 'plan');
    const latest = view.webview.postMessage.mock.calls.at(-1)?.[0];
    expect(latest).toMatchObject({ command: 'state', state: { mode: 'plan' } });
    const html = (provider as any).getHtml({ cspSource: 'test:' }, 'workbench') as string;
    expect(html).not.toContain('Plan — read only');
    expect(deps.send).not.toHaveBeenCalled();
  });
});
