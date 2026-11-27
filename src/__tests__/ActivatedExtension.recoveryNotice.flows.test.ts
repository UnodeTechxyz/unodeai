import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * v0.9.110 R2 (audit of f904fae7, F5 and F6): what a member is told after files were restored, through the extension's
 * real entry. `activate()` runs with only the VS Code API and the model's HTTP endpoint stood in. A request produces a
 * file; the registered Revert, Undo revert and Restore File Checkpoint commands restore it; the next request of the
 * person, from the native Chat participant or the sidebar, is what the model receives.
 *
 * Shown here: on the HTTP route the note is its own host entry (a system message) before the person's unchanged
 * message, from every entrance; it is received once, only when the provider took the request; a Stop before the request
 * is sent leaves it pending; a restored conversation view is told again; a cleared one is not told what came before it.
 */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());
vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));

import { SessionManager } from '../session/SessionManager';
import { HistoryService } from '../history/HistoryService';
import { HistoryStore } from '../history/HistoryStore';
import {
  scripts, requests, latestUser, lastToolResult, workspace, replies, installActivatedExtension, pumpWhile, untilCurrent, textOf,
  type ModelRequest,
} from './support/activatedHarness';

let liveHistory: HistoryService;
const storeMethod = HistoryService.prototype.store;
vi.spyOn(HistoryService.prototype, 'store').mockImplementation(function (this: HistoryService) { liveHistory = this; return storeMethod.call(this); });
let sessions: any;
const getSession = SessionManager.prototype.get;
vi.spyOn(SessionManager.prototype, 'get').mockImplementation(function (this: SessionManager, ...args: Parameters<typeof getSession>) {
  sessions = this; return getSession.apply(this, args);
});
let participant: any;
beforeAll(() => {
  host.overrides['vscode.chat.createChatParticipant'] = (_id: string, handler: any) => { participant = handler; return { dispose() {} }; };
});
let screen: any;
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let chatProvider: any;
installActivatedExtension(host, (ready) => { screen = ready.screen; chatProvider = ready.chatProvider; });

const NOTE = '[UnodeAi host note — not from the person]';
const noteEntries = (request: ModelRequest) => request.messages.filter((message) => message.role === 'system' && textOf(message.content).includes(NOTE));
const lastRequestEndingWith = (text: string) => [...requests].reverse().find((request) => latestUser(request) === text);
const pending = () => liveHistory.pendingRecoveryNotices('pm');
const waitPending = (count: number) => untilCurrent(pending, (notices) => notices.length === count, () => screen.pump(), 20_000);

async function nativeChat(prompt: string): Promise<ModelRequest> {
  const done = participant({ prompt }, {}, { markdown() {}, progress() {}, button() {}, reference() {}, anchor() {} },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  await pumpWhile(() => !lastRequestEndingWith(prompt), () => screen.pump());
  await done;
  return lastRequestEndingWith(prompt)!;
}

async function sidebar(text: string): Promise<ModelRequest> {
  await screen.send(text);
  await pumpWhile(() => !lastRequestEndingWith(text), () => screen.pump());
  await pumpWhile(() => !replies('pm').some((reply) => reply.includes(`done ${text}`.slice(0, 40))), () => screen.pump());
  return lastRequestEndingWith(text)!;
}

async function idle(): Promise<void> {
  await pumpWhile(() => sessions.requestRunning(sessions.currentRequestId('pm')), () => screen.pump());
}

describe('R2 recovery notices reach the next request of the person, from every entrance (F5, F6)', () => {
  it('HTTP: after a Revert the native Chat request carries the note as its own host entry, received once', async () => {
    scripts.set('pm-model', (request) => {
      const asked = latestUser(request);
      if (asked === 'produce recovery fixture' && !lastToolResult(request)) {
        return { calls: [{ name: 'write_file', args: { path: 'r2-fixture.txt', content: 'created by real request' } }] };
      }
      if (asked === 'produce single file' && !lastToolResult(request)) {
        return { calls: [{ name: 'write_file', args: { path: 'single.txt', content: 'single file' } }] };
      }
      return { text: `done ${asked}`.slice(0, 40) };
    });
    await screen.select('pm');
    await sidebar('produce recovery fixture');
    expect(fs.readFileSync(path.join(workspace, 'r2-fixture.txt'), 'utf8')).toBe('created by real request');
    await liveHistory.flush();
    await idle();
    const store = (await liveHistory.store())!;
    const task = (await store.tasksOf('pm')).find((entry) => entry.goal === 'produce recovery fixture')!;
    host.overrides['vscode.workspace.textDocuments'] = [];
    host.overrides['vscode.workspace.notebookDocuments'] = [];
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Revert';
    await host.commands.get('unode.revertToRequest')!({ agentId: 'pm', historyId: task.historyId });
    expect(fs.existsSync(path.join(workspace, 'r2-fixture.txt'))).toBe(false);
    await liveHistory.flush();
    const waiting = await waitPending(1);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ action: 'revert', selected: { historyId: task.historyId, goal: 'produce recovery fixture' } });
    expect(waiting[0].branchId).toEqual(expect.any(String));

    // The native Chat participant: the person's message arrives as typed; the note is a separate host entry before it.
    const native = await nativeChat('native next user request');
    expect(latestUser(native)).toBe('native next user request');
    const entries = noteEntries(native);
    expect(entries).toHaveLength(1);
    const text = textOf(entries[0].content);
    expect(text).toContain('Revert to before request "produce recovery fixture"');
    expect(text).toContain(`(notice ${waiting[0].noticeId})`);
    expect(text).toContain('r2-fixture.txt: removed');
    const userAt = native.messages.map((message) => message.role).lastIndexOf('user');
    expect(native.messages.indexOf(entries[0])).toBeLessThan(userAt);
    // Received: the provider took that request. Not told again, and the conversation holds the entry once.
    expect(await waitPending(0)).toEqual([]);
    await idle();
    const after = await sidebar('sidebar after notice');
    expect(latestUser(after)).toBe('sidebar after notice');
    expect(noteEntries(after)).toHaveLength(1);
  });

  it('a Stop before the request is sent leaves the note pending; the next request carries it (P7)', async () => {
    await idle();
    host.overrides['vscode.window.showQuickPick'] = async (items: any[]) => items[0];
    await host.commands.get('unode.undoRevert')!();
    expect(fs.existsSync(path.join(workspace, 'r2-fixture.txt'))).toBe(true);
    await liveHistory.flush();
    const undo = await waitPending(1);
    expect(undo[0]).toMatchObject({ action: 'undo', selected: { goal: 'produce recovery fixture' } });
    const deps = sessions.deps;
    const previous = deps.getWorkspaceContext;
    let entered = false;
    let release!: () => void;
    const gate = new Promise<undefined>((resolve) => { release = () => resolve(undefined); });
    deps.getWorkspaceContext = () => { entered = true; return gate; };
    const before = requests.length;
    try {
      await screen.send('will stop before provider send');
      await pumpWhile(() => !entered, () => screen.pump());
      await screen.stop();
      release();
      await screen.pump();
      await idle();
    } finally { release(); deps.getWorkspaceContext = previous; }
    expect(requests.slice(before).some((request) => latestUser(request) === 'will stop before provider send')).toBe(false);
    await liveHistory.flush();
    expect((await pending()).map((notice) => notice.noticeId)).toEqual([undo[0].noticeId]);
    const next = await sidebar('next request after stopped preparation');
    expect(latestUser(next)).toBe('next request after stopped preparation');
    expect(noteEntries(next).some((entry) => textOf(entry.content).includes(`(notice ${undo[0].noticeId})`))).toBe(true);
    expect(await waitPending(0)).toEqual([]);
  });

  it('the single-file Restore goes through the same port', async () => {
    await idle();
    await sidebar('produce single file');
    expect(fs.existsSync(path.join(workspace, 'single.txt'))).toBe(true);
    await idle();
    host.overrides['vscode.window.createQuickPick'] = () => {
      const listeners: Record<string, Array<(value?: unknown) => void>> = { accept: [], hide: [] };
      const picker: any = {
        items: [], selectedItems: [], placeholder: '', matchOnDescription: false,
        onDidAccept: (fn: () => void) => { listeners.accept.push(fn); return { dispose() {} }; },
        onDidHide: (fn: () => void) => { listeners.hide.push(fn); return { dispose() {} }; },
        onDidTriggerItemButton: () => ({ dispose() {} }),
        show: () => {
          picker.selectedItems = [picker.items.find((item: any) => String(item.label).includes('single.txt'))];
          for (const fn of listeners.accept) fn();
        },
        hide: () => { for (const fn of listeners.hide) fn(); },
        dispose: () => {},
      };
      return picker;
    };
    host.overrides['vscode.window.showWarningMessage'] = async (_text: string, ...rest: unknown[]) => {
      const labels = rest.filter((item) => typeof item === 'string') as string[];
      return labels[labels.length - 1];
    };
    await host.commands.get('unode.restoreCheckpoint')!();
    expect(fs.existsSync(path.join(workspace, 'single.txt'))).toBe(false);
    await liveHistory.flush();
    const restore = await waitPending(1);
    expect(restore[0]).toMatchObject({ action: 'restore' });
    const native = await nativeChat('native request after single restore');
    expect(latestUser(native)).toBe('native request after single restore');
    expect(noteEntries(native).some((entry) => textOf(entry.content).includes('Restore of one file to an earlier restore point')
      && textOf(entry.content).includes('single.txt'))).toBe(true);
    expect(await waitPending(0)).toEqual([]);
  });

  it('HTTP: a request stopped while the provider holds it leaves the note pending; the retry adds no second entry', async () => {
    await idle();
    let releaseStall!: () => void;
    const stall = new Promise<void>((resolve) => { releaseStall = resolve; });
    const previous = scripts.get('pm-model')!;
    scripts.set('pm-model', async (request) => {
      if (latestUser(request) === 'stalled request') { await stall; return { text: 'too late' }; }
      return previous(request);
    });
    liveHistory.restoreNotice({ physicalTarget: path.join(workspace, 'stalled.txt'), displayPath: 'stalled.txt', removed: false,
      current: { kind: 'file', sha256: 'd'.repeat(64), size: 1 } });
    await liveHistory.flush();
    const [notice] = await waitPending(1);
    try {
      await screen.send('stalled request');
      await pumpWhile(() => !lastRequestEndingWith('stalled request'), () => screen.pump());
      expect(noteEntries(lastRequestEndingWith('stalled request')!).filter((entry) => textOf(entry.content).includes(`(notice ${notice.noticeId})`))).toHaveLength(1);
      await screen.stop();
      await idle();
    } finally { releaseStall(); }
    await liveHistory.flush();
    const still = await pending();
    expect(still.map((entry) => entry.noticeId)).toEqual([notice.noticeId]);
    expect(still[0].attached).toBe(true);
    const next = await sidebar('after the stalled request');
    const marked = noteEntries(next).filter((entry) => textOf(entry.content).includes(`(notice ${notice.noticeId})`));
    expect(marked).toHaveLength(1);
    expect(await waitPending(0)).toEqual([]);
  });

  it('HTTP: a request the provider failed leaves the note pending; the retry adds no second entry', async () => {
    await idle();
    const previous = scripts.get('pm-model')!;
    scripts.set('pm-model', async (request) => {
      if (latestUser(request) === 'failing request') throw Object.assign(new Error('provider refused the request'), { status: 400 });
      return previous(request);
    });
    liveHistory.restoreNotice({ physicalTarget: path.join(workspace, 'failed.txt'), displayPath: 'failed.txt', removed: false,
      current: { kind: 'file', sha256: 'e'.repeat(64), size: 1 } });
    await liveHistory.flush();
    const [notice] = await waitPending(1);
    await screen.send('failing request');
    await pumpWhile(() => !lastRequestEndingWith('failing request'), () => screen.pump());
    await idle();
    await liveHistory.flush();
    // The provider never took it: still pending, already in the conversation once.
    expect((await pending()).map((entry) => entry.noticeId)).toEqual([notice.noticeId]);
    const next = await sidebar('after the failed request');
    const marked = noteEntries(next).filter((entry) => textOf(entry.content).includes(`(notice ${notice.noticeId})`));
    expect(marked).toHaveLength(1);
    expect(await waitPending(0)).toEqual([]);
  });

  it('a conversation view restored from an archive is told again; a cleared one is not told what came before it (P6)', async () => {
    await idle();
    expect(await pending()).toEqual([]);
    liveHistory.viewReplaced('pm', 'archive-restore', [{ role: 'user', text: 'older conversation', ts: new Date().toISOString(), messageId: 'older-1' } as any]);
    await liveHistory.flush();
    expect((await pending()).length).toBeGreaterThanOrEqual(3);
    liveHistory.viewReplaced('pm', 'clear', []);
    await liveHistory.flush();
    expect(await pending()).toEqual([]);
  });
});

describe('R2 re-audit: a restore whose bookkeeping failed is completed through the registered commands (F2)', () => {
  it('a notice that could not be recorded reaches the next request once storage works again, without opening a command', async () => {
    await idle();
    scripts.set('pm-model', (request) => {
      if (latestUser(request) === 'create lost notice' && !lastToolResult(request)) {
        return { calls: [{ name: 'write_file', args: { path: 'lost-notice.txt', content: 'result' } }] };
      }
      return { text: `done ${latestUser(request)}`.slice(0, 40) };
    });
    await screen.select('pm');
    await sidebar('create lost notice');
    await liveHistory.flush();
    await idle();
    const store = (await liveHistory.store())!;
    const task = (await store.tasksOf('pm')).find((entry) => entry.goal === 'create lost notice')!;
    host.overrides['vscode.workspace.textDocuments'] = [];
    host.overrides['vscode.workspace.notebookDocuments'] = [];
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Revert';
    const append = HistoryStore.prototype.append;
    const failing = vi.spyOn(HistoryStore.prototype, 'append').mockImplementation(function (this: HistoryStore, body, options) {
      if (body.kind === 'recovery-notice') return Promise.resolve({ status: 'failed', reason: 'disk full' } as never);
      return append.call(this, body, options);
    });
    try {
      await host.commands.get('unode.revertToRequest')!({ agentId: 'pm', historyId: task.historyId });
    } finally {
      failing.mockRestore();
    }
    expect(fs.existsSync(path.join(workspace, 'lost-notice.txt'))).toBe(false);
    const operation = store.recoveryOperations().find((entry) => entry.fromHistoryId === task.historyId)!;
    expect(operation.closed?.applied).toBe(1);
    expect(store.hasRecoveryNotice(operation.operationId)).toBe(false);
    // The person's next request: the note is repaired before it is read, and carried once.
    const marker = `(notice notice-${operation.operationId})`;
    const next = await nativeChat('next request after a lost notice');
    expect(noteEntries(next).filter((entry) => textOf(entry.content).includes(marker))).toHaveLength(1);
    expect(textOf(noteEntries(next).find((entry) => textOf(entry.content).includes(marker))!.content)).toContain('lost-notice.txt: removed');
    await idle();
    const later = await sidebar('later request after the repair');
    expect(noteEntries(later).filter((entry) => textOf(entry.content).includes(marker))).toHaveLength(1);
  });

  it('Undo revert offers and undoes a revert whose result could not be recorded, from the file it kept', async () => {
    await idle();
    scripts.set('pm-model', (request) => {
      if (latestUser(request) === 'create unfinished revert' && !lastToolResult(request)) {
        return { calls: [{ name: 'write_file', args: { path: 'unfinished.txt', content: 'result' } }] };
      }
      return { text: `done ${latestUser(request)}`.slice(0, 40) };
    });
    await sidebar('create unfinished revert');
    await idle();
    await liveHistory.flush();
    const store = (await liveHistory.store())!;
    const task = (await store.tasksOf('pm')).find((entry) => entry.goal === 'create unfinished revert')!;
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Revert';
    const append = HistoryStore.prototype.append;
    const failing = vi.spyOn(HistoryStore.prototype, 'append').mockImplementation(function (this: HistoryStore, body, options) {
      if (body.kind === 'recovery-target' && body.phase === 'applied') return Promise.resolve({ status: 'failed', reason: 'disk full' } as never);
      return append.call(this, body, options);
    });
    try {
      await host.commands.get('unode.revertToRequest')!({ agentId: 'pm', historyId: task.historyId });
    } finally {
      failing.mockRestore();
    }
    const operation = store.recoveryOperations().find((entry) => entry.fromHistoryId === task.historyId)!;
    expect(operation.closed).toBeUndefined();
    expect(fs.existsSync(path.join(workspace, 'unfinished.txt'))).toBe(false);
    let offered: Array<{ description: string }> = [];
    host.overrides['vscode.window.showQuickPick'] = async (items: Array<{ description: string }>) => {
      offered = items;
      return items.find((item) => item.description === operation.operationId.slice(0, 8));
    };
    await host.commands.get('unode.undoRevert')!();
    expect(offered.map((item) => item.description)).toContain(operation.operationId.slice(0, 8));
    expect(store.recoveryOperation(operation.operationId)!.closed?.applied).toBe(1);
    expect(fs.readFileSync(path.join(workspace, 'unfinished.txt'), 'utf8')).toBe('result');
  });
});

describe('v0.9.110: Revert from the chat, and results after a restore', () => {
  const nodes = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...nodes(child)]);
  const onPage = () => nodes(screen.page().elements.get('transcript'));
  const buttons = (label: string) => onPage().filter((node) => node.type === 'button' && node.textContent === label);
  const restoredLabels = () => onPage().filter((node) => node.className === 'job-outcome-restored');

  it('a request offers Revert to here and its result Revert to before this request; after it, the result is not verified', async () => {
    await idle();
    scripts.set('pm-model', (request) => {
      if (latestUser(request) === 'create from chat' && !lastToolResult(request)) {
        return { calls: [{ name: 'write_file', args: { path: 'from-chat.txt', content: 'made from chat' } }] };
      }
      return { text: `done ${latestUser(request)}`.slice(0, 40) };
    });
    await screen.select('pm');
    await sidebar('create from chat');
    await liveHistory.flush();
    await idle();
    expect(fs.readFileSync(path.join(workspace, 'from-chat.txt'), 'utf8')).toBe('made from chat');
    // Only this request is on the branch requests now continue on: its message and its result offer the revert.
    await pumpWhile(() => buttons('Revert to here…').length === 0 || buttons('Revert to before this request…').length === 0, () => screen.pump());
    expect(buttons('Revert to here…')).toHaveLength(1);
    expect(buttons('Revert to before this request…')).toHaveLength(1);
    // Results reported before the restores earlier in this window say so already; this request's does not.
    const before = restoredLabels().length;
    // The page names only the member and the task; the host previews and asks first, like the Revert command.
    let asked = '';
    host.overrides['vscode.window.showWarningMessage'] = async (prompt: string) => { asked = prompt; return 'Keep files as they are'; };
    screen.page().dispatchElementEvent(buttons('Revert to here…')[0], 'click');
    await pumpWhile(() => asked === '', () => screen.pump());
    expect(asked).toBe('Revert 1 file to before this request?');
    expect(fs.existsSync(path.join(workspace, 'from-chat.txt'))).toBe(true);
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Revert';
    screen.page().dispatchElementEvent(buttons('Revert to before this request…')[0], 'click');
    await pumpWhile(() => fs.existsSync(path.join(workspace, 'from-chat.txt')), () => screen.pump());
    // Requests now continue on the revert's branch: the reverted request offers nothing more; its result says it is
    // not verified after the restore.
    await pumpWhile(() => restoredLabels().length === before || buttons('Revert to here…').length > 0, () => screen.pump());
    expect(buttons('Revert to before this request…')).toHaveLength(0);
    expect(restoredLabels()).toHaveLength(before + 1);
    expect(restoredLabels().every((node) => node.textContent === 'Not verified after restore')).toBe(true);
  });

  it('a result under Earlier results says Not verified after restore once files are put back later', async () => {
    await idle();
    scripts.set('pm-model', (request) => {
      if (latestUser(request) === 'create a result to move' && !lastToolResult(request)) {
        return { calls: [{ name: 'write_file', args: { path: 'moved-result.txt', content: 'moved bytes' } }] };
      }
      if (latestUser(request) === 'create after the import' && !lastToolResult(request)) {
        return { calls: [{ name: 'write_file', args: { path: 'after-import.txt', content: 'after import' } }] };
      }
      return { text: `done ${latestUser(request)}`.slice(0, 40) };
    });
    await screen.select('pm');
    await sidebar('create a result to move');
    await liveHistory.flush();
    await idle();
    const store = (await liveHistory.store())!;
    const taskOf = async (goal: string) => {
      let task: { historyId: string; rootRequestId?: string } | undefined;
      for (let i = 0; i < 100 && !(task && store.recoveryManifest(task.rootRequestId ?? '')?.files.length); i++) {
        task = (await store.tasksOf('pm')).find((entry) => entry.goal === goal);
        await screen.pump();
      }
      return task!;
    };
    const moved = await taskOf('create a result to move');
    // Another conversation replaces this one: the host's result stays, under Earlier results, and files were not
    // put back after it yet.
    const importFile = path.join(workspace, '.storage', 'import-other.json');
    fs.mkdirSync(path.dirname(importFile), { recursive: true });
    fs.writeFileSync(importFile, JSON.stringify({ version: 1, kind: 'chat', messages: [{ role: 'user', text: 'imported other conversation', ts: new Date().toISOString() }] }));
    host.overrides['vscode.window.showOpenDialog'] = async () => [{ fsPath: importFile }];
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Replace';
    await host.commands.get('unode.importChat')!();
    await liveHistory.flush();
    await screen.pump();
    const earlierCard = () => chatProvider.transcriptItems('pm').find((item: any) => item.kind === 'earlierResults')
      ?.cards.find((card: any) => card.requestId === moved.rootRequestId);
    expect(earlierCard()).toBeDefined();
    expect(earlierCard().notVerifiedAfterRestore).toBeUndefined();
    // The person opens Earlier results: results from before this window's earlier restores say so already.
    const group = () => onPage().find((node) => node.className === 'earlier-results');
    const badgesInGroup = () => nodes(group()).filter((node) => node.className === 'job-outcome-restored');
    const open = group() && (nodes(group()).find((node) => String(node.tagName ?? '').toLowerCase() === 'details') ?? group().children[0]);
    open.open = true;
    screen.page().dispatchElementEvent(open, 'toggle');
    const before = badgesInGroup().length;
    // A later request's file is put back: the earlier result now describes files as they were.
    await sidebar('create after the import');
    await liveHistory.flush();
    await idle();
    const after = await taskOf('create after the import');
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Revert';
    await host.commands.get('unode.revertToRequest')!({ agentId: 'pm', historyId: after.historyId });
    expect(fs.existsSync(path.join(workspace, 'after-import.txt'))).toBe(false);
    await screen.pump();
    expect(earlierCard().notVerifiedAfterRestore).toBe(true);
    // The open group was drawn again with this result's mark.
    await pumpWhile(() => badgesInGroup().length === before, () => screen.pump());
    expect(badgesInGroup()).toHaveLength(before + 1);
    expect(badgesInGroup().every((node) => node.textContent === 'Not verified after restore')).toBe(true);
  });
});
