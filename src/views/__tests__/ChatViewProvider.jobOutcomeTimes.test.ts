import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  ViewColumn: { One: 1, Active: 1 },
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn(),
  },
}));

import { ChatViewProvider } from '../ChatViewProvider';
import { formatLocalInstant } from '../localInstant';
import { bootWebviewScript, type WebviewElement } from './support/webviewBoot';

/*
 * What the card RENDERS for an instant. The host's view states every instant in UTC; Chat is on the person's
 * machine and shows local time with the zone. This drives the real webview script and reads the text of the row.
 */

const CLOSED_AT = '2026-10-04T08:12:33.000Z';

function renderedRows(): Array<{ label: string; text: string; title: unknown }> {
  const store = new Map<string, unknown>();
  const provider = new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm' }],
    send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(),
    onReply: () => vi.fn(),
    state: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
  } as never);
  const html = (provider as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string;
  const boot = bootWebviewScript(html);
  const handlers = boot.listeners.message ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  for (const handler of handlers) {
    handler({
      data: {
        command: 'state',
        state: {
          agents: [{ id: 'pm', name: 'PM', role: 'pm' }],
          selectedAgentId: 'pm',
          runningAgentIds: [], mode: 'act',
          messages: [{
            kind: 'jobOutcome', id: 'outcome:run-1', ts: CLOSED_AT, renderKey: 'outcome:run-1:k',
            view: {
              schemaVersion: 1, id: 'outcome:run-1', runId: 'run-1', available: true,
              headline: [{ text: 'Partial', tone: 'caution' }],
              sections: [{
                title: 'Timing',
                rows: [
                  { label: 'Elapsed', value: '25s' },
                  { label: 'Closed', value: CLOSED_AT, instant: CLOSED_AT },
                  { label: 'First dispatch', value: 'none accepted', tone: 'caution' },
                ],
              }],
              actions: [],
            },
          }],
        },
      },
    });
  }
  const transcript = boot.elements.get('transcript');
  if (!transcript) throw new Error('the chat did not render a transcript');
  const rows: Array<{ label: string; text: string; title: unknown }> = [];
  const walk = (node: WebviewElement): void => {
    const children = (Array.isArray(node.children) ? node.children : []) as WebviewElement[];
    if (node.className === 'job-outcome-rows') {
      for (let index = 0; index + 1 < children.length; index += 2) {
        rows.push({
          label: String(children[index].textContent ?? ''),
          text: String(children[index + 1].textContent ?? ''),
          title: children[index + 1].title,
        });
      }
      return;
    }
    children.forEach(walk);
  };
  walk(transcript);
  return rows;
}

describe('Job outcome card: instants', () => {
  it('shows an instant in local time with its zone, and keeps the UTC text on hover', () => {
    const rows = renderedRows();
    expect(rows.map((row) => row.label)).toEqual(['Elapsed', 'Closed', 'First dispatch']);
    const closed = rows[1];
    expect(closed.text).toBe(formatLocalInstant(CLOSED_AT));
    expect(closed.text).not.toBe('');
    // The stored UTC text is not what the row shows; it is what the hover says, marked as UTC.
    expect(closed.text).not.toContain('T08:12:33');
    expect(closed.title).toBe(`${CLOSED_AT} (UTC)`);
  });

  it('leaves a row that is not an instant exactly as the host wrote it', () => {
    const rows = renderedRows();
    expect(rows[0].text).toBe('25s');
    expect(rows[2].text).toBe('none accepted');
    expect(typeof rows[0].title).not.toBe('string');
    expect(typeof rows[2].title).not.toBe('string');
  });
});
