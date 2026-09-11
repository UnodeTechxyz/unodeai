/*---------------------------------------------------------------------------------------------
 *  UnodeAi - MessageLogProvider
 *  Live "team activity" feed: shows inter-agent messages WITH their content (task instructions,
 *  results, questions) — not just routes — so you can watch the crew actually collaborate.
 *  Each agent's own internal monologue (assistant text + tool calls) goes to its per-agent
 *  Output channel instead; this panel is the cross-agent conversation.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MessageBus } from '../bus/MessageBus';
import { Message } from '../types';
import { MessageLogItem, TranscriptTruncation } from './transcriptPort';
import { DelegationProgressSummary, coordinatorDispositionLabel, coordinatorDispositionTask } from './orchestrationProgress';
import { csp, esc, escAttr, nonce } from './webviewSecurity';
import { SessionPresentationModel } from './sessionPresentation';

/** Resolves a session id to a human-friendly name (falls back to the id). */
export type NameResolver = (id: string) => string;

type FeedItem = MessageLogItem;

interface ActivityFold {
  key: string;
  activity: string;
  count: number;
}

interface ActivityDescriptor {
  kind: 'tool' | 'heartbeat';
  key: string;
  activity: string;
}

export const MESSAGE_LOG_RETAINED_LIMIT = 300;

export interface MessageLogExportSnapshot {
  items: FeedItem[];
  truncation: TranscriptTruncation;
}

export class MessageLogProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'unode.activityPanel';
  private _views = new Set<vscode.WebviewView>();
  private delegations: DelegationProgressSummary[] = [];
  private compact = false;
  /** Number of older activity entries omitted from this bounded presentation window. */
  private droppedItems = 0;
  /** Tail state for the display projection only; the MessageBus remains the source record. */
  private lastActivityFold?: ActivityFold;

  constructor(
    private messageBus: MessageBus,
    private resolveName: NameResolver = (id) => id,
    private readonly presentation: SessionPresentationModel = new SessionPresentationModel(),
  ) {
    this.messageBus.on('message.sent', (msg: unknown) => {
      this.appendProjectedMessage(msg as Message);
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._views.add(webviewView);
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._getHtml(webviewView.webview);
    // Messages that arrive while the Activity panel is hidden remain in the shared presentation model;
    // re-render it when visible again so the projection misses no entries.
    const visibility = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        webviewView.webview.html = this._getHtml(webviewView.webview);
      }
    });
    const disposed = webviewView.onDidDispose(() => {
      this._views.delete(webviewView);
      visibility.dispose();
      disposed.dispose();
    });
  }

  refresh(): void {
    for (const view of this._views) {
      view.webview.html = this._getHtml(view.webview);
    }
  }

  /** Empty the activity feed (one-click clear from the view's title bar). */
  clear(): void {
    this.presentation.clearAgentMessages();
    this.droppedItems = 0;
    this.lastActivityFold = undefined;
    this.refresh();
  }

  /**
   * Seed the feed from the bus's restored history (call once on activation, after
   * `MessageBus.importMessages`). Without this the panel only ever shows messages sent since the window
   * was opened: reloading VS Code left the crew's whole conversation in the bus but the feed reading
   * "No activity yet." — history that exists, invisible.
   */
  hydrate(messages: Message[], sourceMessageCount = messages.length): void {
    const projected = this.projectMessages(messages);
    const retained = projected.items.slice(-MESSAGE_LOG_RETAINED_LIMIT);
    this.presentation.replaceAgentMessages(retained);
    this.lastActivityFold = retained.length > 0 ? projected.tail : undefined;
    this.droppedItems = Math.max(0, sourceMessageCount - messages.length)
      + Math.max(0, projected.items.length - retained.length);
    this.refresh();
  }

  exportItems(): FeedItem[] {
    return this.presentation.agentMessages();
  }

  exportSnapshot(): MessageLogExportSnapshot {
    const items = this.exportItems();
    return {
      items,
      truncation: {
        occurred: this.droppedItems > 0,
        droppedItems: this.droppedItems,
        retainedItems: items.length,
        limit: MESSAGE_LOG_RETAINED_LIMIT,
      },
    };
  }

  hasItems(): boolean {
    return this.presentation.agentMessages().length > 0;
  }

  importItems(items: FeedItem[], sourceTruncation?: TranscriptTruncation): void {
    const retained = items.slice(-MESSAGE_LOG_RETAINED_LIMIT);
    this.presentation.replaceAgentMessages(retained);
    this.droppedItems = Math.max(0, sourceTruncation?.droppedItems ?? 0) + Math.max(0, items.length - retained.length);
    this.lastActivityFold = undefined;
    this.refresh();
  }

  setCompact(compact = !this.compact): boolean {
    this.compact = compact;
    this.refresh();
    return this.compact;
  }

  setDelegationProgress(summaries: DelegationProgressSummary[]): void {
    this.delegations = summaries;
    this.refresh();
  }

  private postToViews(message: unknown): void {
    for (const view of this._views) {
      void view.webview.postMessage(message);
    }
  }

  private appendProjectedMessage(message: Message): void {
    const descriptor = activityDescriptor(message);
    const item = this.toItem(message);

    if (descriptor?.kind === 'heartbeat') {
      if (!this.lastActivityFold || this.lastActivityFold.key !== descriptor.key) {
        // A heartbeat is not a new action. If the bounded/restored projection lacks its action line,
        // dropping it is more truthful than manufacturing a standalone activity.
        return;
      }
      const updated = activityItem(item, descriptor.activity, this.lastActivityFold.count);
      if (this.presentation.replaceLastAgentMessage(updated)) {
        this.postToViews({ command: 'replaceNewestItem', item: updated });
      }
      return;
    }

    if (descriptor?.kind === 'tool') {
      if (this.lastActivityFold?.key === descriptor.key) {
        const nextFold = { ...this.lastActivityFold, count: this.lastActivityFold.count + 1 };
        const updated = activityItem(item, descriptor.activity, nextFold.count);
        if (this.presentation.replaceLastAgentMessage(updated)) {
          this.lastActivityFold = nextFold;
          this.postToViews({ command: 'replaceNewestItem', item: updated });
          return;
        }
      }
      this.lastActivityFold = { key: descriptor.key, activity: descriptor.activity, count: 1 };
      const first = activityItem(item, descriptor.activity, 1);
      this.presentation.appendAgentMessage(first);
      this.droppedItems += this.presentation.trimAgentMessages(MESSAGE_LOG_RETAINED_LIMIT);
      this.postToViews({ command: 'newItem', item: first });
      return;
    }

    this.lastActivityFold = undefined;
    this.presentation.appendAgentMessage(item);
    this.droppedItems += this.presentation.trimAgentMessages(MESSAGE_LOG_RETAINED_LIMIT);
    this.postToViews({ command: 'newItem', item });
  }

  private projectMessages(messages: readonly Message[]): { items: FeedItem[]; tail?: ActivityFold } {
    const items: FeedItem[] = [];
    let tail: ActivityFold | undefined;
    for (const message of messages) {
      const descriptor = activityDescriptor(message);
      const item = this.toItem(message);

      if (descriptor?.kind === 'heartbeat') {
        if (tail?.key === descriptor.key && items.length > 0) {
          items[items.length - 1] = activityItem(item, descriptor.activity, tail.count);
        }
        continue;
      }

      if (descriptor?.kind === 'tool') {
        if (tail?.key === descriptor.key && items.length > 0) {
          tail = { ...tail, count: tail.count + 1 };
          items[items.length - 1] = activityItem(item, descriptor.activity, tail.count);
        } else {
          tail = { key: descriptor.key, activity: descriptor.activity, count: 1 };
          items.push(activityItem(item, descriptor.activity, 1));
        }
        continue;
      }

      tail = undefined;
      items.push(item);
    }
    return { items, tail };
  }

  private toItem(m: Message): FeedItem {
    const p = m.payload ?? {};
    let content = p.instruction ?? '';
    if (p.files?.length) {
      content += `\n📎 ${p.files.length} file(s): ${p.files.join(', ')}`;
    }
    if (p.metadata && Object.keys(p.metadata).length > 0) {
      // The full, safe activity identity exists only to make the projection exact. The visible/exported
      // feed already carries the bounded activity label, so do not defeat truncation by printing it again.
      const { activityIdentity: _activityIdentity, ...displayMetadata } = p.metadata;
      if (Object.keys(displayMetadata).length > 0) {
        content += `\n${JSON.stringify(displayMetadata)}`;
      }
    }
    return {
      timestamp: new Date(m.timestamp).toISOString(),
      time: new Date(m.timestamp).toLocaleTimeString(),
      from: this.resolveName(m.from),
      to: m.to === '*' ? 'everyone' : this.resolveName(m.to),
      type: m.type,
      priority: m.priority,
      content: content.slice(0, 2000),
    };
  }

  private _getHtml(webview: vscode.Webview): string {
    const scriptNonce = nonce();
    const items = this.presentation.agentMessages();
    const body = items.length === 0
      ? `<div class="empty">No activity yet. Send a task to an agent (or the PM) to see the crew talk.</div>`
      : items.slice(-120).reverse().map((it) => this._renderItem(it)).join('');
    const orchestration = this._renderDelegations();

    return /* html */`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(webview, scriptNonce)}">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 6px; }
  .empty { text-align: center; padding: 24px; color: var(--vscode-descriptionForeground); }
  .orchestration { margin-bottom: 8px; display: grid; gap: 6px; }
  .orchestration-title { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; }
  .progress-card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editor-background); overflow: hidden; }
  .progress-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .progress-route { min-width: 0; font-weight: 600; color: var(--vscode-textLink-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .progress-count { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .progress-rows { display: grid; gap: 4px; padding: 6px 8px; }
  .progress-row { display: grid; grid-template-columns: minmax(90px, .7fr) auto minmax(0, 1.6fr); gap: 6px; align-items: center; min-width: 0; }
  .progress-agent, .progress-task { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .progress-scope { grid-column: 2 / -1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 10px; }
  .progress-state { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 6px; font-size: 10px; color: var(--vscode-descriptionForeground); }
  .progress-state.working { color: var(--vscode-charts-yellow, #d29922); }
  .progress-state.done { color: var(--vscode-charts-green, #3fb950); }
  .progress-state.verified { color: var(--vscode-charts-green, #3fb950); }
  .progress-state.tool-activity-recorded { color: var(--vscode-charts-yellow, #d29922); }
  .progress-state.coordinator-accepted { color: var(--vscode-charts-green, #3fb950); }
  .progress-state.coordinator-rejected, .progress-state.human-intervention-required { color: var(--vscode-errorForeground, #f85149); }
  .progress-state.blocked { color: var(--vscode-errorForeground, #f85149); }
  .progress-state.completion-partial { color: var(--vscode-charts-yellow, #d29922); }
  .item { border-left: 3px solid var(--vscode-panel-border); padding: 4px 8px; margin-bottom: 6px; background: var(--vscode-editor-background); border-radius: 0 4px 4px 0; cursor: pointer; }
  .item.high { border-left-color: #dc3545; }
  .head { display: flex; gap: 8px; align-items: center; font-size: 11px; }
  .time { color: var(--vscode-descriptionForeground); }
  .route { color: var(--vscode-textLink-foreground); font-weight: 600; }
  .type { margin-left: auto; font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .type.t-complete { background: #28a74533; color: #28a745; }
  .type.t-error { background: #dc354533; color: #dc3545; }
  .content { margin-top: 3px; white-space: pre-wrap; color: var(--vscode-foreground); opacity: .85; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
  .item.expanded .content { -webkit-line-clamp: unset; }
  .content:empty { display: none; }
  body.compact .item { padding: 3px 7px; margin-bottom: 3px; }
  body.compact .orchestration { display: none; }
  body.compact .content { display: none; }
  body.compact .head { gap: 6px; }
</style></head><body class="${this.compact ? 'compact' : ''}">
  ${orchestration}
  <div id="feed">${body}</div>
  <script nonce="${scriptNonce}">
    const typeClass = (t) => t.includes('complete') ? 't-complete' : (t.includes('error') ? 't-error' : '');
    function render(it) {
      const item = document.createElement('div');
      item.className = 'item ' + (it.priority === 'high' ? 'high' : '');
      const head = document.createElement('div'); head.className = 'head';
      const time = document.createElement('span'); time.className = 'time'; time.textContent = it.time;
      const route = document.createElement('span'); route.className = 'route'; route.textContent = it.from + ' → ' + it.to;
      const type = document.createElement('span'); type.className = 'type ' + typeClass(it.type); type.textContent = it.type;
      head.append(time, route, type);
      const content = document.createElement('div'); content.className = 'content'; content.textContent = it.content;
      item.append(head, content);
      return item;
    }
    window.addEventListener('message', (e) => {
      if (e.data.command === 'newItem') {
        const feed = document.getElementById('feed');
        const empty = feed.querySelector('.empty'); if (empty) empty.remove();
        feed.insertBefore(render(e.data.item), feed.firstChild);
        while (feed.children.length > 120) feed.lastChild.remove();
      } else if (e.data.command === 'replaceNewestItem') {
        const feed = document.getElementById('feed');
        const newest = feed.firstElementChild;
        if (newest) newest.replaceWith(render(e.data.item));
      }
    });
    document.addEventListener('click', (e) => {
      const item = e.target.closest('.item');
      if (item) item.classList.toggle('expanded');
    });
  </script>
</body></html>`;
  }

  private _renderItem(it: FeedItem): string {
    const tClass = it.type.includes('complete') ? 't-complete' : it.type.includes('error') ? 't-error' : '';
    return /* html */`
      <div class="item ${it.priority === 'high' ? 'high' : ''}">
        <div class="head">
          <span class="time">${esc(it.time)}</span>
          <span class="route">${esc(it.from)} → ${esc(it.to)}</span>
          <span class="type ${tClass}">${esc(it.type)}</span>
        </div>
        <div class="content">${esc(it.content)}</div>
      </div>`;
  }

  private _renderDelegations(): string {
    const visible = this.delegations.filter((summary) => summary.items.length > 0).slice(-4).reverse();
    if (visible.length === 0) {
      return '';
    }
    return /* html */`
      <section class="orchestration" aria-label="Orchestration progress">
        <div class="orchestration-title">Orchestration</div>
        ${visible.map((summary) => this._renderDelegation(summary)).join('')}
      </section>`;
  }

  private _renderDelegation(summary: DelegationProgressSummary): string {
    const rows = summary.items.map((item) => /* html */`
      <div class="progress-row">
        <span class="progress-agent">${esc(item.agentName)}</span>
        <span class="progress-state ${esc(item.status)}${item.completionState === 'partial' ? ' completion-partial' : ''}">${esc(progressStateLabel(item))}</span>
        <span class="progress-task" title="${escAttr(progressTask(item))}">${esc(progressTask(item))}</span>
        ${item.scope ? `<span class="progress-scope">${esc(item.status === 'working' ? 'Temporary scope: ' : 'Temporary scope ended: ')}${esc(item.scope)}</span>` : ''}
      </div>`).join('');
    return /* html */`
      <div class="progress-card">
        <div class="progress-head">
          <span class="progress-route">${esc(summary.coordinatorName)} delegated to ${summary.total} agent${summary.total === 1 ? '' : 's'}</span>
          <span class="progress-count">${summary.done} complete · ${summary.partial} partial · ${summary.blocked} blocked${(summary.cancelled ?? 0) > 0 ? ` · ${summary.cancelled} cancelled` : ''}${summary.closeoutCompletionState === 'partial' ? ' · run partial' : ''}</span>
        </div>
        <div class="progress-rows">${rows}</div>
      </div>`;
  }
}

function activityDescriptor(message: Message): ActivityDescriptor | undefined {
  if (message.type !== 'task.status') {
    return undefined;
  }
  const metadata = asRecord(message.payload.metadata);
  const progress = asRecord(metadata.progress);
  const activity = typeof metadata.activity === 'string'
    ? metadata.activity
    : typeof message.payload.instruction === 'string' ? message.payload.instruction : '';
  const explicitIdentity = typeof metadata.activityIdentity === 'string' ? metadata.activityIdentity : undefined;
  if (!activity) {
    return undefined;
  }
  if (progress.source === 'tool' && progress.observed === true) {
    const key = JSON.stringify([message.from, message.to, message.correlationId ?? '', explicitIdentity ?? `message:${message.id}`]);
    return { kind: 'tool', key, activity };
  }
  if (progress.source === 'heartbeat') {
    const key = JSON.stringify([message.from, message.to, message.correlationId ?? '', explicitIdentity ?? `heartbeat:${message.id}`]);
    return { kind: 'heartbeat', key, activity };
  }
  return undefined;
}

function activityItem(item: FeedItem, activity: string, count: number): FeedItem {
  const metadataStart = item.content.indexOf('\n');
  const metadata = metadataStart >= 0 ? item.content.slice(metadataStart) : '';
  return {
    ...item,
    content: `${activity}${count > 1 ? ` ×${count}` : ''}${metadata}`.slice(0, 2000),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function statusLabel(status: string): string {
  return status === 'working' ? 'Working'
    : status === 'cancelled' ? 'Cancelled'
    : status === 'blocked' ? 'Blocked'
    : status === 'verified' ? 'Verified'
    : status === 'tool-activity-recorded' ? 'Tool activity recorded; delivery not checked'
    : status === 'replied-not-verified' ? 'Replied, not verified'
    : status === 'no-evidence' ? 'No evidence'
    : status === 'required-input-read-not-observed' ? 'Required input read receipt not observed'
    : status === 'timed-out' ? 'Timed out waiting for teammate'
    : status === 'coordinator-accepted' ? 'Coordinator accepted'
    : status === 'coordinator-rejected' ? 'Coordinator rejected — amended'
    : status === 'human-intervention-required' ? 'Human intervention required'
    : status === 'done' ? 'Done'
    : 'Unknown';
}

function progressStateLabel(item: DelegationProgressSummary['items'][number]): string {
  if (item.taskState?.kind === 'context-gap') {
    return `Context gap · ${item.taskState.reason}`;
  }
  if (item.completionState === 'partial') {
    return [
      'Partial',
      item.evidenceOutcome ? statusLabel(item.evidenceOutcome) : undefined,
      item.coordinatorDisposition ? coordinatorDispositionLabel(item.coordinatorDisposition) : undefined,
    ].filter((value): value is string => !!value).join(' · ');
  }
  return item.coordinatorDisposition ? coordinatorDispositionLabel(item.coordinatorDisposition) : statusLabel(item.status);
}

function progressTask(item: DelegationProgressSummary['items'][number]): string {
  if (item.taskState?.kind === 'context-gap') {
    return `Required input ${item.taskState.inputId} (${item.taskState.reason}): ${item.taskState.purpose}.`;
  }
  const dispositionTask = coordinatorDispositionTask(item);
  if (dispositionTask) {
    return dispositionTask;
  }
  if (item.status === 'coordinator-rejected') {
    return `Amended from ${item.amendedFrom ?? 'earlier verdict'}: ${item.dispositionReason ?? 'coordinator rejected the result'}`;
  }
  if (item.status === 'human-intervention-required') {
    return `Human intervention required: ${item.dispositionReason ?? 'coordinator requested a human decision'}`;
  }
  return item.activity || item.instruction || '(no instruction)';
}
