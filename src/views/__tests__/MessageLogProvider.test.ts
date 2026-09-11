import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { MessageBus } from '../../bus/MessageBus';
import { MessageLogProvider } from '../MessageLogProvider';
import { SessionPresentationModel } from '../sessionPresentation';
import { createMessagesExportPayload, parseMessagesImportPayload } from '../transcriptPort';

interface FakeView {
  visible: boolean;
  webview: {
    cspSource: string;
    html: string;
    options?: unknown;
    postMessage: ReturnType<typeof vi.fn>;
  };
  onDidChangeVisibility: ReturnType<typeof vi.fn>;
  onDidDispose: ReturnType<typeof vi.fn>;
  fireVisible: () => void;
  fireDispose: () => void;
}

function makeView(): FakeView {
  let visibilityHandler: (() => void) | undefined;
  let disposeHandler: (() => void) | undefined;
  return {
    visible: true,
    webview: {
      cspSource: 'test:',
      html: '',
      postMessage: vi.fn(),
    },
    onDidChangeVisibility: vi.fn((handler: () => void) => {
      visibilityHandler = handler;
      return { dispose: vi.fn() };
    }),
    onDidDispose: vi.fn((handler: () => void) => {
      disposeHandler = handler;
      return { dispose: vi.fn() };
    }),
    fireVisible: () => visibilityHandler?.(),
    fireDispose: () => disposeHandler?.(),
  };
}

function sendToolActivity(
  bus: MessageBus,
  activity: string,
  identity: string,
  options: { from?: string; to?: string; correlationId?: string } = {},
): void {
  bus.send(options.from ?? 'dev', options.to ?? 'pm', 'task.status', {
    instruction: activity,
    metadata: {
      activity,
      activityIdentity: identity,
      phase: 'tool-running',
      progress: { source: 'tool', observed: true },
    },
  }, 'low', options.correlationId ?? 'task-1');
}

function sendHeartbeat(bus: MessageBus, activity: string, identity: string, correlationId = 'task-1'): void {
  bus.send('dev', 'pm', 'task.status', {
    instruction: `Still working: ${activity}`,
    metadata: {
      activity,
      activityIdentity: identity,
      progress: { source: 'heartbeat', observed: false, observedToolActions: 2 },
    },
  }, 'low', correlationId);
}

describe('MessageLogProvider', () => {
  it('broadcasts one feed to every attached webview and drops disposed views', () => {
    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus, (id) => ({ pm: 'PM', dev: 'Developer' }[id] ?? id));
    const sidebar = makeView();
    const panel = makeView();

    provider.resolveWebviewView(sidebar as never);
    provider.resolveWebviewView(panel as never);

    bus.send('pm', 'dev', 'task.assign', { instruction: 'Fix the bug.' }, 'normal');

    expect(sidebar.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'newItem' }));
    expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'newItem' }));
    expect(provider.exportItems()).toHaveLength(1);

    sidebar.fireDispose();
    bus.send('dev', 'pm', 'task.complete', { instruction: 'Done.' }, 'normal');

    expect(sidebar.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(panel.webview.postMessage).toHaveBeenCalledTimes(2);

    bus.dispose();
  });

  // The bus replays persisted history into its queryable store WITHOUT re-dispatching to subscribers, so
  // the feed hears nothing on activation. Before hydrate(), every window reload showed "No activity yet."
  // on top of a full team history.
  it('hydrates the feed from restored bus history so a reloaded window is not blank', () => {
    const source = new MessageBus();
    source.send('pm', 'dev', 'task.assign', { instruction: 'Read src/calculator.js.' }, 'high');
    source.send('dev', 'pm', 'task.complete', { instruction: 'Read it; conclusions noted.' }, 'normal');
    const persisted = source.exportMessages();

    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus, (id) => ({ pm: 'PM', dev: 'Developer' }[id] ?? id));
    const view = makeView();
    provider.resolveWebviewView(view as never);

    bus.importMessages(persisted);
    expect(provider.exportItems()).toHaveLength(0); // importMessages alone does NOT reach the feed

    provider.hydrate(bus.query({ limit: 300 }));

    expect(provider.exportItems()).toHaveLength(2);
    expect(view.webview.html).toContain('Read src/calculator.js.');
    expect(view.webview.html).toContain('PM → Developer');
    expect(view.webview.html).not.toContain('No activity yet');

    source.dispose();
    bus.dispose();
  });

  it('exports explicit provenance when the 300-item presentation window omitted older activity (T11)', () => {
    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus);
    for (let index = 0; index < 301; index++) {
      bus.send('pm', 'dev', 'task.status', { instruction: `status ${index}` }, 'normal');
    }

    const snapshot = provider.exportSnapshot();
    expect(snapshot.items).toHaveLength(300);
    expect(snapshot.items[0].content).toContain('status 1');
    expect(snapshot.truncation).toEqual({ occurred: true, droppedItems: 1, retainedItems: 300, limit: 300 });
    bus.dispose();
  });

  it('carries pre-hydration omissions into the next export snapshot', () => {
    const source = new MessageBus();
    for (let index = 0; index < 301; index++) {
      source.send('pm', 'dev', 'task.status', { instruction: `status ${index}` }, 'normal');
    }
    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus);
    provider.hydrate(source.query({ limit: 300 }), source.getMessageCount());

    expect(provider.exportSnapshot().truncation).toEqual({ occurred: true, droppedItems: 1, retainedItems: 300, limit: 300 });
    source.dispose();
    bus.dispose();
  });

  it('folds repeated tool_use actions by safe identity without changing the raw MessageBus record (C4a/C4b)', () => {
    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus);
    sendToolActivity(bus, 'read_file · docs/a.docx', 'read_file\u0000path\u0000docs/a.docx');
    sendToolActivity(bus, 'read_file · docs/a.docx', 'read_file\u0000path\u0000docs/a.docx');

    expect(bus.query({ type: 'task.status' })).toHaveLength(2);
    expect(provider.exportItems()).toHaveLength(1);
    expect(provider.exportItems()[0].content).toContain('read_file · docs/a.docx ×2');

    sendToolActivity(bus, 'read_file · docs/b.docx', 'read_file\u0000path\u0000docs/b.docx');
    expect(provider.exportItems()).toHaveLength(2);
    expect(provider.exportItems().map((item) => item.content.split('\n')[0])).toEqual([
      'read_file · docs/a.docx ×2',
      'read_file · docs/b.docx',
    ]);
    bus.dispose();
  });

  it('uses a heartbeat to update the action line without appending or incrementing it (C4c)', () => {
    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus);
    const view = makeView();
    provider.resolveWebviewView(view as never);
    sendToolActivity(bus, 'read_file · docs/a.docx', 'read_file\u0000path\u0000docs/a.docx');
    sendHeartbeat(bus, 'read_file · docs/a.docx', 'read_file\u0000path\u0000docs/a.docx');

    expect(provider.exportItems()).toHaveLength(1);
    expect(provider.exportItems()[0].content).toContain('read_file · docs/a.docx');
    expect(provider.exportItems()[0].content).not.toContain('×2');
    expect(provider.exportItems()[0].content).toContain('"source":"heartbeat"');
    expect(view.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'replaceNewestItem' }));
    bus.dispose();
  });

  it('never merges identical text from a different agent or task correlation (C4f)', () => {
    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus);
    const activity = 'read_file · docs/a.docx';
    const identity = 'read_file\u0000path\u0000docs/a.docx';
    sendToolActivity(bus, activity, identity, { correlationId: 'task-a' });
    sendToolActivity(bus, activity, identity, { from: 'reviewer', correlationId: 'task-a' });
    sendToolActivity(bus, activity, identity, { correlationId: 'task-b' });

    expect(provider.exportItems()).toHaveLength(3);
    expect(provider.exportItems().every((item) => !item.content.includes('×2'))).toBe(true);
    bus.dispose();
  });

  it('produces the same fold live, after hydrate, and through export/import (C4h)', () => {
    const source = new MessageBus();
    const live = new MessageLogProvider(source);
    const activity = 'read_file · docs/a.docx';
    const identity = 'read_file\u0000path\u0000docs/a.docx';
    sendToolActivity(source, activity, identity);
    sendToolActivity(source, activity, identity);
    sendHeartbeat(source, activity, identity);
    sendToolActivity(source, 'read_file · docs/b.docx', 'read_file\u0000path\u0000docs/b.docx');

    const reloadedBus = new MessageBus();
    const hydrated = new MessageLogProvider(reloadedBus);
    hydrated.hydrate(source.query(), source.getMessageCount());
    expect(hydrated.exportItems()).toEqual(live.exportItems());

    const payload = createMessagesExportPayload(live.exportItems(), '2026-08-29T00:00:00.000Z');
    const parsed = parseMessagesImportPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    const importedBus = new MessageBus();
    const imported = new MessageLogProvider(importedBus);
    if (parsed.ok) {
      imported.importItems(parsed.messages, parsed.truncation);
    }
    expect(imported.exportItems()).toEqual(live.exportItems());

    source.dispose();
    reloadedBus.dispose();
    importedBus.dispose();
  });

  it('refreshes all attached views for shared actions like clear and compact', () => {
    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus);
    const sidebar = makeView();
    const panel = makeView();

    provider.resolveWebviewView(sidebar as never);
    provider.resolveWebviewView(panel as never);
    bus.send('a', 'b', 'ask.question', { instruction: 'Can you check this?' }, 'normal');

    provider.clear();

    expect(sidebar.webview.html).toContain('No activity yet');
    expect(panel.webview.html).toContain('No activity yet');

    provider.setCompact(true);

    expect(sidebar.webview.html).toContain('<body class="compact">');
    expect(panel.webview.html).toContain('<body class="compact">');

    bus.dispose();
  });

  it('keeps the locale display time unchanged while recording a sortable source timestamp', () => {
    const bus = new MessageBus();
    const presentation = new SessionPresentationModel();
    const provider = new MessageLogProvider(bus, (id) => id, presentation);
    const view = makeView();
    provider.resolveWebviewView(view as never);

    bus.send('pm', 'dev', 'task.assign', { instruction: 'Use the existing display.' }, 'normal');
    const [item] = provider.exportItems();
    provider.refresh();

    expect(item.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(view.webview.html).toContain(item.time);
    expect(view.webview.html).not.toContain(item.timestamp!);

    bus.dispose();
  });

  it('uses the transcript verified-green token while retaining the Verified text label', () => {
    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus);
    const view = makeView();
    provider.resolveWebviewView(view as never);
    provider.setDelegationProgress([{
      coordinatorName: 'PM', startedAt: new Date().toISOString(), total: 1, done: 1, blocked: 0, working: 0,
      items: [{ agentName: 'Reviewer', instruction: 'Review the patch', status: 'verified', activity: 'Checks passed' }],
    }]);

    expect(view.webview.html).toContain('.progress-state.verified { color: var(--vscode-charts-green, #3fb950); }');
    expect(view.webview.html).toContain('progress-state verified');
    expect(view.webview.html).toContain('Verified');
    bus.dispose();
  });

  it('renders partial separately from verified evidence and coordinator acceptance', () => {
    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus);
    const view = makeView();
    provider.resolveWebviewView(view as never);
    provider.setDelegationProgress([{
      id: 'summary', coordinatorId: 'pm', coordinatorName: 'PM', startedAt: new Date().toISOString(),
      total: 1, done: 0, partial: 1, blocked: 0, working: 0,
      items: [{
        id: 'h', coordinatorId: 'pm', coordinatorName: 'PM', agentId: 'dev', agentName: 'Developer',
        instruction: 'Build it', scopeMode: 'fixed-session-permissions', status: 'verified',
        completionState: 'partial', evidenceOutcome: 'verified', coordinatorDisposition: 'accepted',
        startedAt: new Date().toISOString(),
      }],
    }]);

    expect(view.webview.html).toContain('0 complete · 1 partial · 0 blocked');
    expect(view.webview.html).toContain('Partial · Verified · Coordinator accepted');
    bus.dispose();
  });

  it('renders an unknown delegation status as Unknown rather than silently claiming Done', () => {
    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus);
    const view = makeView();
    provider.resolveWebviewView(view as never);
    provider.setDelegationProgress([{
      id: 'summary', coordinatorId: 'pm', coordinatorName: 'PM', startedAt: new Date().toISOString(),
      total: 1, done: 0, partial: 0, blocked: 0, working: 0,
      items: [{
        id: 'h', coordinatorId: 'pm', coordinatorName: 'PM', agentId: 'dev', agentName: 'Developer',
        instruction: 'Build it', status: 'future-status' as never, startedAt: new Date().toISOString(),
      }],
    }]);

    expect(view.webview.html).toContain('<span class="progress-state future-status">Unknown</span>');
    expect(view.webview.html).not.toContain('<span class="progress-state future-status">Done</span>');
    bus.dispose();
  });

  it.each(['missing', 'expired', 'outside-task-scope'] as const)(
    'renders a %s context gap without an invented Unreadable diagnosis',
    (reason) => {
      const bus = new MessageBus();
      const provider = new MessageLogProvider(bus);
      const view = makeView();
      provider.resolveWebviewView(view as never);
      provider.setDelegationProgress([{
        coordinatorName: 'PM', startedAt: new Date().toISOString(), total: 1, done: 0, blocked: 1, working: 0,
        items: [{
          agentName: 'Reviewer', instruction: 'Review the source', status: 'blocked',
          taskState: { kind: 'context-gap', inputId: 'source', reason, purpose: 'Inspect the source.' },
        }],
      }]);

      expect(view.webview.html).toContain(`Context gap · ${reason}`);
      expect(view.webview.html).not.toContain('Unreadable');
      bus.dispose();
    },
  );

  it('renders an explicit scope and an amber mechanism-only evidence label in the webview HTML (T10/T12)', () => {
    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus);
    const view = makeView();
    provider.resolveWebviewView(view as never);
    provider.setDelegationProgress([{
      coordinatorName: 'PM', startedAt: new Date().toISOString(), total: 1, done: 1, blocked: 0, working: 0,
      items: [{
        agentName: 'Researcher', instruction: 'Inspect the catalogue', scope: 'read-only docs',
        status: 'tool-activity-recorded', activity: 'Searched the catalogue',
      }],
    }]);

    expect(view.webview.html).toContain('progress-state tool-activity-recorded');
    expect(view.webview.html).toContain('Tool activity recorded; delivery not checked');
    expect(view.webview.html).toContain('Temporary scope ended: ');
    expect(view.webview.html).toContain('read-only docs');
    bus.dispose();
  });

  it('renders a coordinator rejection as a visible amendment with its reason, not a silent rewrite', () => {
    const bus = new MessageBus();
    const provider = new MessageLogProvider(bus);
    const view = makeView();
    provider.resolveWebviewView(view as never);
    provider.setDelegationProgress([{
      coordinatorName: 'PM', startedAt: new Date().toISOString(), total: 1, done: 1, blocked: 0, working: 0,
      items: [{
        agentName: 'Developer', instruction: 'Build the evidence table', status: 'coordinator-rejected',
        evidenceOutcome: 'verified', amendedFrom: 'verified', dispositionReason: 'The acceptance table is missing.',
      }],
    }]);

    expect(view.webview.html).toContain('progress-state coordinator-rejected');
    expect(view.webview.html).toContain('Coordinator rejected — amended');
    expect(view.webview.html).toContain('Amended from verified: The acceptance table is missing.');
    bus.dispose();
  });
});
