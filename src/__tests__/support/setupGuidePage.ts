/*
 * v0.9.106 (setup guide): the setup guide page as the activate() flows see it. Each webview panel the extension opens is
 * recorded; the guide's page is booted from the HTML its panel holds, with the host's messages delivered both ways. A
 * click goes through the page's own delegated click listener, on the element the page rendered, so the message the
 * host receives is the one the page builds from what the host showed.
 */
import { expect } from 'vitest';
import type { ActivatedHost } from './activatedVscode';
import { flush, pumpWhile } from './activatedHarness';
import { bootWebviewScript, type WebviewBootResult } from '../../views/__tests__/support/webviewBoot';

export type RecordedPanel = {
  viewType: string; title: string; showOptions: unknown; reveals: unknown[][]; posted: unknown[];
  receive?: (message: unknown) => unknown; webview: any; disposeListener?: () => void;
};

/** Records every webview panel the extension opens; each one answers as a real panel would, without a window. */
export function recordPanels(host: ActivatedHost): RecordedPanel[] {
  const panels: RecordedPanel[] = [];
  host.overrides['vscode.window.createWebviewPanel'] = (viewType: string, title: string, showOptions: unknown) => {
    const panel: RecordedPanel = { viewType, title, showOptions, reveals: [], posted: [], webview: undefined };
    let deliver: ((message: unknown) => void) | undefined;
    panel.webview = {
      html: '', cspSource: 'test:', options: {}, asWebviewUri: (uri: unknown) => uri,
      postMessage: (message: unknown) => { panel.posted.push(message); deliver?.(message); return Promise.resolve(true); },
      onDidReceiveMessage: (listener: (message: unknown) => void) => { panel.receive = listener; return { dispose() {} }; },
      connect: (to: (message: unknown) => void) => { deliver = to; },
    };
    Object.assign(panel, {
      onDidDispose: (listener: () => void) => { panel.disposeListener = listener; return { dispose() {} }; },
      onDidChangeViewState: () => ({ dispose() {} }),
      reveal: (...args: unknown[]) => { panel.reveals.push(args); },
      dispose() { panel.disposeListener?.(); },
      visible: true, viewColumn: 1,
    });
    panels.push(panel);
    return panel;
  };
  return panels;
}

const descendants = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);
const textOf = (node: any): string => [node?.textContent, ...(Array.isArray(node?.children) ? node.children.map(textOf) : [])].filter(Boolean).join(' ');

export interface GuidePage {
  page: WebviewBootResult;
  pump: () => Promise<void>;
  /** The newest view the host posted. */
  view: () => any;
  views: () => any[];
  /** What the step on screen says, and the outcome line. */
  text: () => string;
  outcome: () => string;
  /** The rendered control of this action (and id), if the page shows it. */
  control: (action: string, id?: string) => any;
  /** Clicks a rendered control through the page's delegated listener and waits for the host's settled view. */
  click: (action: string, id?: string) => Promise<void>;
  /** Chooses an option of the connection select, as a person does. */
  choose: (connectionId: string) => Promise<void>;
  /** The options the connection select offers. */
  options: () => Array<{ value: string; text: string }>;
}

export function guidePage(panel: RecordedPanel): GuidePage {
  const page = bootWebviewScript(panel.webview.html);
  const deliver = (message: unknown) => { for (const listener of page.listeners.message ?? []) listener({ data: message }); };
  for (const message of panel.posted) deliver(message);
  panel.webview.connect(deliver);
  let sent = 0;
  const pump = async () => {
    while (sent < page.postedMessages.length) await panel.receive?.(page.postedMessages[sent++]);
    await flush();
  };
  const views = () => panel.posted.filter((message: any) => message?.command === 'view').map((message: any) => message.view);
  const roots = () => ['steps', 'content', 'back', 'next'].map((id) => page.elements.get(id)).filter(Boolean);
  const all = () => roots().flatMap((root) => [root, ...descendants(root)]);
  const control = (action: string, id?: string) => all().find((node) => node?.dataset?.command === action && (id === undefined || node.dataset.id === id));
  const settled = async (before: number) => {
    await pumpWhile(() => views().length <= before || views().at(-1).busy, pump,
      { detail: () => `views ${views().length}; busy ${String(views().at(-1)?.busy)}; outcome "${textOf(page.elements.get('outcome'))}"` });
  };
  const select = () => descendants(page.elements.get('content')).find((node) => node?.dataset?.change === 'select-connection');
  return {
    page, pump, views,
    view: () => views().at(-1),
    text: () => textOf(page.elements.get('content')),
    outcome: () => String((page.elements.get('outcome') as any)?.hidden ? '' : textOf(page.elements.get('outcome'))),
    control,
    click: async (action, id) => {
      await pump();
      const target = control(action, id);
      expect(target, `the page shows a ${action}${id ? ` ${id}` : ''} control`).toBeDefined();
      expect(target.disabled, `${action} is enabled`).toBe(false);
      target.closest = () => target;
      const before = views().length;
      for (const listener of page.listeners.click ?? []) listener({ target });
      await settled(before);
    },
    choose: async (connectionId) => {
      await pump();
      const target = select();
      expect(target, 'the page shows the connection select').toBeDefined();
      target.value = connectionId;
      const before = views().length;
      for (const listener of page.listeners.change ?? []) listener({ target });
      await settled(before);
    },
    options: () => (select()?.children ?? []).map((option: any) => ({ value: option.value, text: option.textContent })),
  };
}
