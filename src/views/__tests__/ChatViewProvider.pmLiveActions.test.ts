import { describe, expect, it, vi } from 'vitest';

const vscode = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
  executeCommand: vi.fn(async () => undefined),
}));
vi.mock('vscode', () => ({
  window: { showQuickPick: vscode.showQuickPick },
  commands: { executeCommand: vscode.executeCommand },
}));

import { ChatViewProvider } from '../ChatViewProvider';
import type { PmLiveStrip } from '../../session/PmLiveStrip';

/*
 * v0.9.102 (the Owner, 2026-11-13: every leftover item can be resolved; design §8): the host's side of the PM strip's
 * buttons. Review Delivered Work runs the existing command; Show all lists every open reminder of the selected PM, and
 * the one chosen goes into the message box. Nothing is sent and no turn starts.
 */
function provider() {
  const sent: unknown[] = [];
  const chat = new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
    send: (...args: unknown[]) => { sent.push(args); }, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
    state: { get: () => undefined, update: async () => {} },
    getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
  } as never);
  chat.selectAgent('pm');
  return { chat, sent };
}

const STRIP: PmLiveStrip = { lines: [
  { kind: 'reminder', text: 'Reminder: one.', prompt: 'Please look at one.' },
  { kind: 'reminder', text: 'Reminder: two.', prompt: 'Please look at two.' },
  { kind: 'more', text: '1 more task needs a decision.', prompt: 'Please look at these 3 tasks and settle each one:', items: [
    { label: 'Dev\'s task "One"', detail: 'finished 2026-11-10 08:28: its saved result text is not available in this window', prompt: 'Please look at one.' },
    { label: 'Dev\'s task "Two"', detail: 'interrupted 2026-11-11 09:00: it was interrupted when its window closed or reloaded', prompt: 'Please look at two.' },
    { label: 'Dev\'s task "Three"', detail: 'UnodeAi cannot tell which decision applies to it', prompt: 'Please look at three.' },
  ] },
] };

describe('the PM strip buttons the host answers', () => {
  it('Review Delivered Work runs the existing command', () => {
    const { chat } = provider();
    (chat as any).onMessage({ command: 'pmLiveReview' });
    expect(vscode.executeCommand).toHaveBeenCalledWith('unode.reviewRun');
  });

  it('Show all lists each reminder with its own Ask the PM; the chosen message goes into the box, and nothing is sent', async () => {
    const { chat, sent } = provider();
    chat.setPmLive(new Map([['pm', STRIP]]));
    vscode.showQuickPick.mockImplementationOnce(async (items: Array<{ prompt: string }>) => items[2]);
    (chat as any).onMessage({ command: 'pmLiveShowAll' });
    await vi.waitFor(() => expect((chat as any).currentState().composerInsertion).toBeDefined());
    const [items] = vscode.showQuickPick.mock.calls.at(-1)!;
    expect((items as Array<{ label: string; description: string }>).map((item) => [item.label, item.description])).toEqual([
      ['Dev\'s task "One"', 'Ask the PM'], ['Dev\'s task "Two"', 'Ask the PM'], ['Dev\'s task "Three"', 'Ask the PM'],
    ]);
    expect((chat as any).currentState().composerInsertion).toMatchObject({ agentId: 'pm', text: 'Please look at three.' });
    expect(sent).toEqual([]);
  });

  // v0.9.103 (slice 3 §3): an update is listed for reading only. Choosing it puts nothing in the message box.
  it('Show all lists an update without Ask the PM, and choosing it inserts nothing; a reminder beside it still does', async () => {
    const { chat, sent } = provider();
    const mixed: PmLiveStrip = { lines: [
      STRIP.lines[0], STRIP.lines[1],
      { kind: 'more', text: '1 more reminder and 1 update.', prompt: 'Please look at these 3 tasks and settle each one:', items: [
        ...(STRIP.lines[2] as Extract<PmLiveStrip['lines'][number], { kind: 'more' }>).items,
        { label: 'Dev\'s task "Four"', detail: 'Dev and the PM have exchanged 3 questions on this task' },
      ] },
    ] };
    chat.setPmLive(new Map([['pm', mixed]]));
    vscode.showQuickPick.mockImplementationOnce(async (items: Array<{ prompt?: string }>) => items[3]);
    (chat as any).onMessage({ command: 'pmLiveShowAll' });
    await vi.waitFor(() => expect(vscode.showQuickPick).toHaveBeenCalled());
    await Promise.resolve();
    const [items, options] = vscode.showQuickPick.mock.calls.at(-1)!;
    expect((items as Array<{ label: string; description: string }>).map((item) => item.description))
      .toEqual(['Ask the PM', 'Ask the PM', 'Ask the PM', 'Update']);
    expect((options as { title: string }).title).toBe('Open reminders and updates');
    expect((chat as any).currentState().composerInsertion).toBeUndefined();
    vscode.showQuickPick.mockImplementationOnce(async (items: Array<{ prompt?: string }>) => items[0]);
    (chat as any).onMessage({ command: 'pmLiveShowAll' });
    await vi.waitFor(() => expect((chat as any).currentState().composerInsertion).toBeDefined());
    expect((chat as any).currentState().composerInsertion).toMatchObject({ text: 'Please look at one.' });
    expect(sent).toEqual([]);
  });

  it('Show all with nothing chosen changes nothing; with no overflow line it shows nothing', async () => {
    const { chat } = provider();
    chat.setPmLive(new Map([['pm', STRIP]]));
    vscode.showQuickPick.mockImplementationOnce(async () => undefined);
    (chat as any).onMessage({ command: 'pmLiveShowAll' });
    await vi.waitFor(() => expect(vscode.showQuickPick).toHaveBeenCalled());
    await Promise.resolve();
    expect((chat as any).currentState().composerInsertion).toBeUndefined();
    vscode.showQuickPick.mockClear();
    chat.setPmLive(new Map([['pm', { lines: STRIP.lines.slice(0, 2) }]]));
    (chat as any).onMessage({ command: 'pmLiveShowAll' });
    await Promise.resolve();
    expect(vscode.showQuickPick).not.toHaveBeenCalled();
  });
});
