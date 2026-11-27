import { expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }));
import * as vscode from 'vscode';
import { TeamViewProvider } from '../TeamViewProvider';
import { TEAM_ROSTER_ORDER_KEY } from '../TeamRosterOrder';
import { MessageBus } from '../../bus/MessageBus';
import { resolveCoordinatorId } from '../../session/CoordinatorIdentity';
import { bootWebviewScript } from './support/webviewBoot';
import { evaluateWiring, extensionWiring } from './support/extensionWiring';
import { RootScopedWorkspaceState } from '../../state/RootScopedWorkspaceState';

function host(saved: unknown = ['pm2', 'dev', 'pm'], orderStorage?: ConstructorParameters<typeof TeamViewProvider>[12]) {
  let live = [member('pm', 'pm'), member('dev', 'developer'), member('pm2', 'pm')];
  const writes: Array<[string, unknown]> = []; let value = saved;
  const storage = { get: () => value, update: vi.fn(async (key: string, ids: unknown) => { writes.push([key, ids]); value = ids; }) };
  const manager = { getAll: () => live, start: vi.fn(), restart: vi.fn(), remove: vi.fn() };
  const provider = new TeamViewProvider({} as never, manager as never, new MessageBus(), '', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, arguments.length > 1 ? orderStorage : storage as never);
  const handlers: Array<(message: any) => void> = []; const view = { webview: { html: '', cspSource: 'test:', options: {}, onDidReceiveMessage: (handler: (message: any) => void) => handlers.push(handler) } };
  provider.rosterSettled(); provider.resolveWebviewView(view as never, {} as never, {} as never);
  const htmlIds = () => [...view.webview.html.matchAll(/class="(?:session-item|compact-card)[^"]*"[^>]*data-agent-id="([^"]+)"/g)].map(match => match[1]);
  const idle = () => (provider as any).rosterOrder.idle() as Promise<void>;
  return { provider, manager, storage, view, writes, htmlIds, idle, live: () => live, setLive: (next: typeof live) => { live = next; provider.refresh(); },
    post: async (message: unknown) => { handlers.forEach(handler => handler(message)); await idle(); }, revision: () => (provider as any).rosterOrder.revision as number };
}
function member(id: string, role: string) { return { id, status: id === 'dev' ? 'stopped' : 'running', restartCount: 0, config: { id, name: id, role, model: 'model', systemPrompt: '', provider: { providerId: 'provider' } } }; }

it('uses the actual extension storage argument to persist and restore order only in its activation root', async () => {
  const values = new Map<string, unknown>();
  const raw = { get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback,
    update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()] };
  const storageFor = (root: string | undefined) => evaluateWiring<ConstructorParameters<typeof TeamViewProvider>[12]>(extensionWiring('TeamViewProvider', 12), {
    context: { workspaceState: raw }, firstWorkspaceRoot: () => root, rootWorkspaceState: new RootScopedWorkspaceState(raw as never, root),
  });
  const first = host(undefined, storageFor('C:/team-root-a')); await first.idle();
  await first.post({ command: 'reorderAgents', agentIds: ['dev', 'pm2', 'pm'], revision: first.revision() });
  const restored = host(undefined, storageFor('C:/team-root-a')); await restored.idle(); expect(restored.htmlIds()).toEqual(['dev', 'pm2', 'pm']);
  const other = host(undefined, storageFor('C:/team-root-b')); await other.idle(); expect(other.htmlIds()).toEqual(['pm', 'dev', 'pm2']);
  expect(values.has(TEAM_ROSTER_ORDER_KEY)).toBe(false);
  expect(storageFor(undefined)).toBeUndefined();
  const temporary = host(undefined, storageFor(undefined)); await temporary.idle();
  await temporary.post({ command: 'reorderAgents', agentIds: ['dev', 'pm2', 'pm'], revision: temporary.revision() });
  expect(temporary.htmlIds()).toEqual(['dev', 'pm2', 'pm']);
});

it('renders the same saved order in normal and compact mode without changing roster/coordinator or runtime actions', async () => {
  const h = host(); await h.idle(); const before = JSON.stringify(h.live()); const coordinator = resolveCoordinatorId(h.live().map(member => member.config) as never);
  expect(h.htmlIds()).toEqual(['pm2', 'dev', 'pm']);
  await h.post({ command: 'reorderAgents', agentIds: ['dev', 'pm', 'pm2'], revision: h.revision() }); expect(h.htmlIds()).toEqual(['dev', 'pm', 'pm2']);
  h.provider.setCompact(true); expect(h.htmlIds()).toEqual(['dev', 'pm', 'pm2']); expect(JSON.stringify(h.live())).toBe(before); expect(resolveCoordinatorId(h.live().map(member => member.config) as never)).toBe(coordinator);
  expect(h.writes.every(([key]) => key === TEAM_ROSTER_ORDER_KEY)).toBe(true); expect(h.manager.start).not.toHaveBeenCalled(); expect(h.manager.restart).not.toHaveBeenCalled(); expect(h.manager.remove).not.toHaveBeenCalled();
});
it('rejects stale/duplicate/unknown/extra-field host messages and redraws authoritative current order', async () => {
  const h = host(); await h.idle(); const revision = h.revision(); h.setLive([...h.live(), member('new', 'developer')]); await h.idle(); const expected = ['pm2', 'dev', 'pm', 'new'];
  for (const message of [
    { command: 'reorderAgents', agentIds: ['dev', 'pm2', 'pm'], revision },
    { command: 'reorderAgents', agentIds: ['dev', 'dev', 'pm', 'new'], revision: h.revision() },
    { command: 'reorderAgents', agentIds: ['dev', 'pm2', 'pm', 'unknown'], revision: h.revision() },
    { command: 'reorderAgents', agentIds: ['dev', 'pm2', 'pm', 'new'], revision: h.revision(), semantic: true },
  ]) { await h.post(message); expect(h.htmlIds()).toEqual(expected); }
  h.setLive(h.live().filter(member => member.id !== 'dev')); await h.idle(); expect(h.htmlIds()).toEqual(['pm2', 'pm', 'new']);
});
it('restores the previous rendered order after a storage failure and preserves existing row/navigation semantics', async () => {
  const h = host(); await h.idle(); h.storage.update.mockRejectedValue(Error('disk'));
  await h.post({ command: 'reorderAgents', agentIds: ['dev', 'pm', 'pm2'], revision: h.revision() }); expect(h.htmlIds()).toEqual(['pm2', 'dev', 'pm']);
  expect(h.view.webview.html).toContain('class="session-open" role="button" tabindex="0"'); expect(h.view.webview.html).toContain('aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"'); expect(h.view.webview.html).toContain('aria-live="polite"');
  expect(h.view.webview.html).not.toContain('Move agent'); expect(h.view.webview.html).not.toContain('data-move-agent'); expect(h.view.webview.html).not.toContain('.move-agent');
  vi.mocked(vscode.commands.executeCommand).mockClear(); await h.post({ command: 'editAgent', agentId: 'dev' }); expect(vscode.commands.executeCommand).toHaveBeenCalledWith('unode.openAgentBuilder', 'dev');
});
it('keeps Enter and Space navigation working from the focusable draggable name area in the actual inline script', () => {
  const h = host(); const boot = bootWebviewScript(h.view.webview.html); const body: any = { dataset: { command: 'openAgentWorkbench', agentId: 'dev' } };
  body.closest = (selector: string) => ['.session-open[role="button"]', '[data-command]'].includes(selector) ? body : null;
  body.click = () => { for (const handler of boot.listeners.click) handler({ target: body, detail: 0 }); };
  for (const key of ['Enter', ' ']) {
    boot.postedMessages.splice(0); const preventDefault = vi.fn();
    for (const handler of boot.listeners.keydown) handler({ key, target: body, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(boot.postedMessages).toEqual([{ command: 'openAgentWorkbench', agentId: 'dev', checkpointId: undefined }]);
  }
});
