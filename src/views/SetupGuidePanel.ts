/*
 * v0.9.106 (setup guide, design §2–§4.1): the editor-area page of the setup guide. One page at a time: opening it again
 * shows the one that is open. It is opened only by a person (the command, Team Actions, Settings → Providers, or the
 * link under the first-task screen) and never at activation. The page renders the host's read-only view with
 * textContent only and posts back one fixed action name and an opaque id; setupGuideProtocol.ts parses that, and the
 * session resolves and re-checks it against what holds now.
 */
import * as vscode from 'vscode';
import { parseSetupGuideMessage, type SetupGuideOutbound } from './setupGuideProtocol';
import { SetupGuideSession, type SetupGuideHost } from './setupGuideSession';
import { renderWebviewDocument } from './webviewDocument';

export class SetupGuidePanel {
  static readonly viewType = 'unode.setupGuide';
  static readonly title = 'UnodeAi Setup Guide';
  private static current: SetupGuidePanel | undefined;

  /** Opens the guide, or shows the one that is open. */
  static createOrShow(host: SetupGuideHost): void {
    const open = SetupGuidePanel.current;
    if (open) {
      open.panel.reveal();
      void open.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(SetupGuidePanel.viewType, SetupGuidePanel.title, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    SetupGuidePanel.current = new SetupGuidePanel(panel, host);
  }

  /**
   * A passive refresh (registry, key, configuration, trust or roster change): the open page shows what holds now. It
   * reads only what is known without starting a program or making a request. Changes in one turn redraw it once.
   */
  static refreshCurrent(): void {
    const open = SetupGuidePanel.current;
    if (!open || open.refreshQueued) return;
    open.refreshQueued = true;
    queueMicrotask(() => {
      open.refreshQueued = false;
      if (SetupGuidePanel.current === open) void open.render();
    });
  }

  /** Test seam and diagnostics: the open guide's session. */
  static openSession(): SetupGuideSession | undefined {
    return SetupGuidePanel.current?.session;
  }

  private readonly session: SetupGuideSession;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshQueued = false;
  private generation = 0;
  private disposed = false;

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly host: SetupGuideHost) {
    this.session = new SetupGuideSession(host, () => { void this.render(); });
    panel.webview.html = setupGuideHtml(panel.webview);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((message) => { void this.onMessage(message); }, null, this.disposables);
  }

  private async onMessage(raw: unknown): Promise<void> {
    const parsed = parseSetupGuideMessage(raw);
    if (!parsed.ok) {
      this.host.log(`[setup guide] refused a page message: ${parsed.reason}.`);
      return;
    }
    if (parsed.message.command === 'ready') {
      await this.render();
      return;
    }
    await this.session.action(parsed.message.action, 'id' in parsed.message ? parsed.message.id : undefined);
  }

  private async render(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    try {
      const view = await this.session.view();
      if (this.disposed || generation !== this.generation) return;
      const message: SetupGuideOutbound = { command: 'view', view };
      await this.panel.webview.postMessage(message);
    } catch (error) {
      this.host.log(`[setup guide] the page could not be updated: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private dispose(): void {
    this.disposed = true;
    if (SetupGuidePanel.current === this) SetupGuidePanel.current = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

const STYLES = /* css */`
  body { margin: 0; padding: 16px 20px; line-height: 1.45; }
  h1 { font-size: 1.3em; margin: 0 0 4px; }
  h2 { font-size: 1.1em; margin: 0 0 10px; }
  h3 { font-size: 1em; margin: 14px 0 6px; }
  p { margin: 0 0 8px; }
  .lead, .note { color: var(--vscode-descriptionForeground); }
  .warning { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
  .layout { display: flex; gap: 20px; align-items: flex-start; margin-top: 14px; flex-wrap: wrap; }
  nav { flex: 0 0 220px; }
  nav ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  nav button { width: 100%; text-align: left; display: flex; gap: 8px; align-items: baseline; }
  nav button[aria-current="step"] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .mark { display: inline-block; width: 1.2em; text-align: center; font-weight: 600; }
  .mark.ready { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
  .mark.attention { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
  main { flex: 1 1 360px; min-width: 0; }
  .row, .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 10px; margin: 0 0 8px; }
  .card.attention { border-color: var(--vscode-editorWarning-foreground, var(--vscode-panel-border)); }
  .row-title { font-weight: 600; }
  .row-detail { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-top: 6px; }
  ol.numbered { margin: 6px 0; padding-left: 20px; }
  button { font: inherit; border: none; border-radius: 3px; padding: 4px 10px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 2px 0; text-decoration: underline; }
  button.link:hover { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
  button:disabled { opacity: .6; cursor: default; }
  button:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  select { font: inherit; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); padding: 3px 6px; max-width: 100%; }
  label { display: block; margin: 0 0 4px; }
  #outcome { margin: 0 0 10px; }
  .nav-buttons { display: flex; justify-content: space-between; margin-top: 16px; }
`;

const BODY = /* html */`
  <header>
    <h1>UnodeAi Setup Guide</h1>
    <p class="lead">Each step shows what is set now and opens the place where it is changed. Nothing here sends a task or loosens a permission.</p>
  </header>
  <div class="layout">
    <nav aria-label="Setup steps"><ol id="steps"></ol></nav>
    <main>
      <h2 id="stepTitle"></h2>
      <p id="outcome" role="status" aria-live="polite" hidden></p>
      <div id="content"><p class="note">Loading…</p></div>
      <div class="nav-buttons">
        <button type="button" id="back" data-command="back">Back</button>
        <button type="button" id="next" data-command="next" class="primary">Next</button>
      </div>
    </main>
  </div>
`;

/*
 * One inline script. It renders the host's view with textContent only and delegates every click through
 * `data-command`: a click posts the action name and the element's opaque id, nothing else.
 */
const SCRIPT = /* js */`
  const vscode = acquireVsCodeApi();
  const stepsList = document.getElementById('steps');
  const stepTitle = document.getElementById('stepTitle');
  const outcome = document.getElementById('outcome');
  const content = document.getElementById('content');
  const back = document.getElementById('back');
  const next = document.getElementById('next');
  back.dataset.command = 'back';
  next.dataset.command = 'next';
  const MARK_TEXT = { ready: '\\u2713', attention: '!', optional: '\\u2013' };
  const MARK_NAME = { ready: 'ready', attention: 'needs attention', optional: 'optional or not checked' };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function button(spec, busy) {
    const element = node('button', spec.primary ? 'primary' : spec.link ? 'link' : '', spec.label);
    element.type = 'button';
    element.dataset.command = spec.action;
    if (spec.id !== undefined) element.dataset.id = spec.id;
    if (spec.title) element.title = spec.title;
    element.disabled = !!spec.disabled || !!busy;
    return element;
  }

  function actions(buttons, busy) {
    const row = node('div', 'actions');
    for (const spec of buttons || []) row.appendChild(button(spec, busy));
    return row;
  }

  function numbered(items) {
    const list = node('ol', 'numbered');
    for (const item of items) list.appendChild(node('li', '', item));
    return list;
  }

  function block(spec, busy) {
    if (spec.kind === 'heading') return node('h3', '', spec.text);
    if (spec.kind === 'text') return node('p', spec.tone === 'warning' ? 'warning' : spec.tone === 'note' ? 'note' : '', spec.text);
    if (spec.kind === 'buttons') return actions(spec.buttons, busy);
    if (spec.kind === 'select') {
      const wrap = node('div', '');
      const label = node('label', '', spec.label);
      const select = node('select', '');
      select.id = 'connectionChoice';
      label.htmlFor = 'connectionChoice';
      select.dataset.change = spec.action;
      for (const option of spec.options) {
        const item = node('option', '', option.label);
        item.value = option.id;
        if (option.id === spec.selected) item.selected = true;
        select.appendChild(item);
      }
      select.value = spec.selected;
      select.disabled = !!busy;
      wrap.append(label, select);
      return wrap;
    }
    const box = node('div', spec.kind === 'card' ? 'card' + (spec.tone ? ' ' + spec.tone : '') : 'row');
    box.appendChild(node('div', 'row-title', spec.title));
    if (spec.kind === 'card') box.appendChild(node('div', 'row-detail', spec.detail));
    for (const line of spec.detail && spec.kind === 'row' ? spec.detail : []) box.appendChild(node('div', 'row-detail', line));
    if (Array.isArray(spec.steps) && spec.steps.length) box.appendChild(numbered(spec.steps));
    if (spec.buttons && spec.buttons.length) box.appendChild(actions(spec.buttons, busy));
    return box;
  }

  function render(view) {
    const items = [];
    for (const step of view.steps) {
      const item = node('li', '');
      const control = node('button', '');
      control.type = 'button';
      control.dataset.command = 'step';
      control.dataset.id = step.id;
      if (step.current) control.setAttribute('aria-current', 'step');
      const mark = node('span', 'mark ' + step.mark, MARK_TEXT[step.mark]);
      mark.setAttribute('aria-label', MARK_NAME[step.mark]);
      control.append(mark, node('span', '', step.label));
      item.appendChild(control);
      items.push(item);
    }
    stepsList.replaceChildren(...items);
    stepTitle.textContent = view.title;
    if (view.note) {
      outcome.textContent = view.note.text;
      outcome.className = view.note.tone === 'warning' ? 'warning' : 'note';
      outcome.hidden = false;
    } else if (view.busy) {
      outcome.textContent = 'Working…';
      outcome.className = 'note';
      outcome.hidden = false;
    } else {
      outcome.textContent = '';
      outcome.hidden = true;
    }
    content.replaceChildren(...view.blocks.map((spec) => block(spec, view.busy)));
    back.disabled = !view.back;
    next.disabled = !view.next;
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.command === 'view' && message.view) render(message.view);
  });

  document.addEventListener('click', (event) => {
    const target = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-command]') : null;
    if (!target || target.disabled) return;
    const message = { command: 'action', action: target.dataset.command };
    if (target.dataset.id !== undefined) message.id = target.dataset.id;
    vscode.postMessage(message);
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || !target.dataset || target.dataset.change !== 'select-connection') return;
    vscode.postMessage({ command: 'action', action: 'select-connection', id: String(target.value) });
  });

  vscode.postMessage({ command: 'ready' });
`;

export function setupGuideHtml(webview: vscode.Webview): string {
  return renderWebviewDocument(webview, { title: SetupGuidePanel.title, styles: STYLES, body: BODY, script: SCRIPT });
}
