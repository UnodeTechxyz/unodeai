import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import fspDefault from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';

/**
 * v0.9.110 H1 (H0's D5): the extension's real entry. `activate()` runs with only the VS Code API and the model's HTTP
 * endpoint stood in (see ActivatedExtension.flows.test.ts). A closeout record the host revises after its turn ended
 * (here: the PM's teammate writes the file the PM's request asked for, after the PM's turn ended) reaches the task
 * history as a further outcome reference of the same record, through the extension's own forwarding.
 * Not a native VS Code host: no window, no real webview, no network.
 */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());

vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));

import { HistoryStore } from '../history/HistoryStore';
import { HistoryService } from '../history/HistoryService';
import { historyWorkspace } from '../history/HistoryWorkspaceIdentity';
import { RawCheckpointStore } from '../backend/RawCheckpointStore';
import { rawCheckpointLocation } from '../backend/PreChangeCheckpoints';
import { RootScopedWorkspaceState } from '../state/RootScopedWorkspaceState';
import { flush, scripts, latestUser, lastToolResult, chatScreen, workspace, context, replies, installActivatedExtension, pumpWhile } from './support/activatedHarness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
// The window's own task history, to run its housekeeping now.
let liveHistory: HistoryService;
const storeMethod = HistoryService.prototype.store;
vi.spyOn(HistoryService.prototype, 'store').mockImplementation(function (this: HistoryService) { liveHistory = this; return storeMethod.call(this); });

let screen: ReturnType<typeof chatScreen>;
let chat: any;
installActivatedExtension(host, (ready) => { screen = ready.screen; chat = ready.chatProvider; });

interface Envelope { eventId: string; body: { kind: string; historyId?: string; outcomeRef?: string; rootRequestId?: string; startsTask?: { historyId: string }; message?: { text?: string } } }

/** The Workbench of this window (attached once; the window lives across the tests): what it was sent. */
let workbenchPosted: any[] | undefined;
function workbench(): any[] {
  if (!workbenchPosted) {
    const posted: any[] = [];
    const panel = { visible: true, viewColumn: 1, reveal() {}, dispose() {},
      webview: { cspSource: 'test:', html: '', options: {}, postMessage: async (message: any) => { posted.push(message); return true; }, onDidReceiveMessage: () => ({ dispose() {} }) },
      onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }) };
    chat.restoreWorkbench(panel);
    workbenchPosted = posted;
  }
  workbenchPosted.length = 0;
  return workbenchPosted;
}

/** Every event the window's task history holds on disk: its event files and its newest snapshot. */
function historyEvents(): Envelope[] {
  const root = path.join(workspace, '.global', 'history', 'v1');
  if (!fs.existsSync(root)) return [];
  const found = new Map<string, Envelope>();
  for (const id of fs.readdirSync(root)) {
    const events = path.join(root, id, 'events');
    for (const name of fs.existsSync(events) ? fs.readdirSync(events) : []) {
      try { const envelope = JSON.parse(fs.readFileSync(path.join(events, name), 'utf8')) as Envelope; found.set(envelope.eventId, envelope); } catch { /* being written */ }
    }
    const snapshots = path.join(root, id, 'snapshots');
    for (const name of fs.existsSync(snapshots) ? fs.readdirSync(snapshots) : []) {
      try {
        for (const item of (JSON.parse(fs.readFileSync(path.join(snapshots, name), 'utf8')) as { events: Array<{ envelope: Envelope }> }).events) {
          found.set(item.envelope.eventId, item.envelope);
        }
      } catch { /* being written */ }
    }
  }
  return [...found.values()];
}

describe('v0.9.110 H1 (H0 D5) through activate(): a revised closeout record reaches the task history', () => {
  it('the PM\'s turn ends, then its teammate writes the file for the PM\'s request: the revised record is a second outcome reference of the same task', async () => {
    const contract = {
      version: 2, objective: 'Write d5.txt.', expected_deliverable: 'd5.txt',
      effects: { read_files: [], expected_file_effect: 'create' }, inputs: [],
      outputs: [{ output_id: 'report', path: path.join(workspace, 'd5.txt'), kind: 'file', required: true }],
      constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['write'] },
      execution_strategy: 'delegate-required' };
    let release!: () => void;
    const devMayAnswer = new Promise<void>((resolve) => { release = resolve; });
    let handle = '';
    scripts.set('pm-model', (request) => {
      const tool = lastToolResult(request);
      const woken = latestUser(request).includes('Async delegation result');
      if (woken && !tool) return { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
      if (woken) return { text: 'd5.txt is written.' };
      if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing d5.txt.' }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write d5.txt.', contract } }] };
    });
    scripts.set('dev-model', async (request) => {
      if (lastToolResult(request)) return { text: 'Saved d5.txt.' };
      await devMayAnswer;
      return { calls: [{ name: 'write_file', args: { path: 'd5.txt', content: 'D5.' } }] };
    });
    await screen.select('pm');
    await screen.send('Please write d5.txt.');
    await pumpWhile(() => !replies('pm').includes('Dev is writing d5.txt.'), screen.pump);

    const taskOf = () => historyEvents().find((event) => event.body.kind === 'transcript-append' && event.body.message?.text === 'Please write d5.txt.')?.body.startsTask?.historyId;
    const outcomes = () => historyEvents().filter((event) => event.body.kind === 'outcome-reference' && event.body.historyId === taskOf());
    // The PM's first turn ended: its record is the task's first outcome reference.
    await pumpWhile(() => outcomes().length === 0, async () => { await screen.pump(); await flush(); });
    const first = outcomes();
    expect(first).toHaveLength(1);
    const firstRef = first[0].body.outcomeRef!;

    // The teammate writes the file for the PM's request: the host revises the PM's stored record, and the history
    // refers to that revision too (another event of the same record), before the PM's own next turn.
    release();
    await pumpWhile(() => !outcomes().some((event) => event.body.outcomeRef === firstRef && event.eventId !== first[0].eventId),
      async () => { await screen.pump(); await flush(); });
    const sameRecord = outcomes().filter((event) => event.body.outcomeRef === firstRef);
    expect(sameRecord.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sameRecord.map((event) => event.eventId)).size).toBe(sameRecord.length);
    await pumpWhile(() => !replies('pm').includes('d5.txt is written.'), screen.pump);

    // What the task history keeps, read by another opening of it: the task refers to the record, as revised.
    const directory = path.join(workspace, '.global', 'history', 'v1', fs.readdirSync(path.join(workspace, '.global', 'history', 'v1'))[0]);
    const reader = await HistoryStore.open({ directory, workspaceId: path.basename(directory), writerId: 'reader' });
    const task = (await reader.task(taskOf()!))!;
    expect(task.outcomeRefs).toContain(firstRef);
    expect(task.terminal).not.toBe('running');
    await reader.dispose();
  });
});

describe('v0.9.110 H1 through activate(): deleting restore points from the Workbench\'s Task history', () => {
  it('a restore point whose bytes cannot be removed is reported and stays owed; Delete all then removes it, and an older version\'s restore point no task names', async () => {
    const identity = historyWorkspace([workspace], '');
    const rawDir = path.join(context.globalStorageUri.fsPath, 'checkpoints', 'raw-v2', identity.workspaceId);
    // An older version's restore point of this workspace (raw-v1), taken into raw-v2 under its id: no task names it.
    const legacy = rawCheckpointLocation(context.globalStorageUri.fsPath, workspace);
    const old = (await RawCheckpointStore.open(legacy)).store;
    const migrated = await old.capture({ agentId: 'dev', path: 'legacy.txt', target: path.join(workspace, 'legacy.txt'), bytes: Buffer.from('legacy preimage') });
    if (migrated.status !== 'captured') throw new Error(migrated.status);
    migrated.pin.release();
    await old.idle();
    const raw = (await RawCheckpointStore.open({ directory: rawDir, workspaceId: identity.workspaceId })).store;
    expect(await raw.importLegacyEntries(legacy, [migrated.entry.id])).toEqual([migrated.entry.id]);
    // A task of this version with its own restore point.
    const tracked = await raw.capture({ agentId: 'dev', path: 'tracked.txt', target: path.join(workspace, 'tracked.txt'), bytes: Buffer.from('tracked preimage') });
    if (tracked.status !== 'captured') throw new Error(tracked.status);
    tracked.pin.release();
    await raw.idle();
    const store = await HistoryStore.open({ directory: path.join(context.globalStorageUri.fsPath, 'history', 'v1', identity.workspaceId),
      workspaceId: identity.workspaceId, writerId: randomUUID() });
    const messageId = randomUUID();
    await store.append({ kind: 'transcript-append', agentId: 'dev', viewGeneration: 'g', messageId,
      message: { role: 'user', text: 'tracked task', ts: new Date().toISOString(), messageId }, startsTask: { historyId: 'tracked-task' } });
    await store.append({ kind: 'request-admitted', agentId: 'dev', historyId: 'tracked-task', rootRequestId: 'tracked-request' });
    await store.append({ kind: 'outcome-reference', historyId: 'tracked-task', outcomeRef: 'tracked-closeout', terminal: 'completed',
      verification: 'not-verified', endedAt: new Date().toISOString() });
    await store.append({ kind: 'recovery-capture', agentId: 'dev', rootRequestId: 'tracked-request', targetId: tracked.entry.id, displayPath: 'tracked.txt',
      physicalTarget: path.join(workspace, 'tracked.txt'), before: { kind: 'file', sha256: 'a'.repeat(64), size: 16, payloadRef: tracked.entry.id }, coverage: 'exact' });

    // The Workbench's Task history, through the chat's protocol; the person confirms each deletion.
    const posted = workbench();
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Delete';
    const send = (message: unknown) => chat.onMessage({ command: 'taskHistory', message }, 'workbench');
    const answer = async (command: string) => {
      await pumpWhile(() => !posted.some((m) => m.command === 'taskHistory' && m.message.command === command), flush);
      return posted.filter((m) => m.command === 'taskHistory' && m.message.command === command).at(-1).message;
    };
    send({ command: 'ready' });
    const task = (await answer('page')).rows.find((row: any) => row.historyId === 'tracked-task');
    expect(task).toBeDefined();

    // Its bytes cannot be removed this time: not claimed deleted, named, and owed.
    const trackedBytes = path.join(rawDir, 'payloads', `${tracked.entry.id}.bin`);
    const realUnlink = fspDefault.unlink;
    const blocked = vi.spyOn(fspDefault, 'unlink').mockImplementation(async (file) => {
      if (String(file) === trackedBytes) throw Object.assign(new Error('injected EPERM'), { code: 'EPERM' });
      return realUnlink(file);
    });
    syncBuiltinESMExports();
    posted.length = 0;
    try {
      send({ command: 'delete', historyId: task.historyId, revision: task.revision, scope: 'both' });
      const single = (await answer('report')).lines.join(' ');
      expect(single).toMatch(/Deleted: 1 task\(s\), 1 message\(s\), 0 restore point\(s\)\./);
      expect(single).toMatch(/could not be removed from disk \(tracked\.txt\)/);
    } finally {
      blocked.mockRestore();
      syncBuiltinESMExports();
    }
    expect(fs.readFileSync(trackedBytes, 'utf8')).toBe('tracked preimage');

    // Delete all: the owed one goes now, and the older version's one from raw-v2; its raw-v1 copy cannot go this time.
    const legacyBytes = path.join(legacy.directory, 'payloads', `${migrated.entry.id}.bin`);
    const blockedLegacy = vi.spyOn(fspDefault, 'unlink').mockImplementation(async (file) => {
      if (String(file) === legacyBytes) throw Object.assign(new Error('injected EPERM'), { code: 'EPERM' });
      return realUnlink(file);
    });
    syncBuiltinESMExports();
    posted.length = 0;
    try {
      send({ command: 'deleteAll' });
      const first = (await answer('report')).lines.join(' ');
      expect(first).toMatch(/could not be removed from disk \(legacy\.txt\)/);
    } finally {
      blockedLegacy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(fs.readFileSync(legacyBytes, 'utf8')).toBe('legacy preimage');
    expect(fs.existsSync(trackedBytes)).toBe(false);
    // Deleting again finishes it.
    posted.length = 0;
    send({ command: 'deleteAll' });
    const bulk = (await answer('report')).lines.join(' ');
    expect(bulk).not.toMatch(/Not everything/);
    expect(fs.existsSync(trackedBytes)).toBe(false);
    expect(fs.existsSync(path.join(rawDir, 'payloads', `${migrated.entry.id}.bin`))).toBe(false);
    expect(fs.existsSync(path.join(legacy.directory, 'payloads', `${migrated.entry.id}.bin`))).toBe(false);
    expect((await RawCheckpointStore.readEntries({ directory: rawDir, workspaceId: identity.workspaceId })).map((entry) => entry.id))
      .not.toContain(migrated.entry.id);
    await store.dispose();
  });

  it('Delete all with an older restore-point store that cannot be read: reported partial with the retry, its bytes left; deleting again removes them', async () => {
    const legacy = rawCheckpointLocation(context.globalStorageUri.fsPath, workspace);
    const old = (await RawCheckpointStore.open(legacy)).store;
    const saved = await old.capture({ agentId: 'dev', path: 'legacy-only.txt', target: path.join(workspace, 'legacy-only.txt'), bytes: Buffer.from('legacy only preimage') });
    if (saved.status !== 'captured') throw new Error(saved.status);
    saved.pin.release();
    await old.idle();
    const payload = path.join(legacy.directory, 'payloads', `${saved.entry.id}.bin`);
    const posted = workbench();
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Delete';
    const report = async () => {
      await pumpWhile(() => !posted.some((m) => m.command === 'taskHistory' && m.message.command === 'report'), flush);
      return posted.filter((m) => m.command === 'taskHistory' && m.message.command === 'report').at(-1).message.lines.join(' ') as string;
    };
    const realRead = fspDefault.readFile;
    const blocked = vi.spyOn(fspDefault, 'readFile').mockImplementation(async (file: any, ...rest: any[]) => {
      if (String(file) === path.join(legacy.directory, 'index.json')) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
      return (realRead as any)(file, ...rest);
    });
    syncBuiltinESMExports();
    let first: string;
    try {
      chat.onMessage({ command: 'taskHistory', message: { command: 'deleteAll' } }, 'workbench');
      first = await report();
    } finally {
      blocked.mockRestore();
      syncBuiltinESMExports();
    }
    expect(first).toMatch(/Not everything could be removed; deleting again tries once more: .*the older restore points of this workspace could not be read, so any there stay on disk \(.*EACCES/);
    expect(fs.readFileSync(payload, 'utf8')).toBe('legacy only preimage');
    posted.length = 0;
    chat.onMessage({ command: 'taskHistory', message: { command: 'deleteAll' } }, 'workbench');
    const retry = await report();
    expect(retry).not.toMatch(/Not everything/);
    expect(retry).toMatch(/1 restore point\(s\)/);
    expect(fs.existsSync(payload)).toBe(false);
  });
});

describe('v0.9.110: deleting restore points that a finished revert holds for Undo revert', () => {
  it('Delete all retires a finished revert: its kept bytes and its notice go, Undo no longer offers it, and no file changes', async () => {
    const file = path.join(workspace, 'undo-held.txt');
    fs.writeFileSync(file, 'original private bytes');
    // Read the file, then write it once, then reply: by step, not by what a tool result happens to quote.
    let step = 0;
    scripts.set('pm-model', (request) => {
      if (latestUser(request) !== 'change the held file') return { text: `done ${latestUser(request)}`.slice(0, 40) };
      if (!lastToolResult(request)) { step = 1; return { calls: [{ name: 'read_file', args: { path: 'undo-held.txt' } }] }; }
      if (step === 1) { step = 2; return { calls: [{ name: 'write_file', args: { path: 'undo-held.txt', content: 'result private bytes' } }] }; }
      return { text: 'done change the held file' };
    });
    await screen.select('pm');
    await screen.send('change the held file');
    await pumpWhile(() => fs.readFileSync(file, 'utf8') !== 'result private bytes' || !replies('pm').some((reply) => reply.includes('done change the held file')), flush,
      { detail: () => `file: ${fs.readFileSync(file, 'utf8')}; step: ${step}; replies: ${JSON.stringify(replies('pm').slice(-3))}; transcript: ${screen.transcript().slice(-600)}` });
    const store = (await liveHistory.store())!;
    let task: { historyId: string; rootRequestId?: string } | undefined;
    for (let i = 0; i < 100 && !(task && store.recoveryManifest(task.rootRequestId ?? '')?.files.length); i++) {
      task = (await store.tasksOf('pm')).find((entry) => entry.goal === 'change the held file');
      await flush();
    }
    host.overrides['vscode.workspace.textDocuments'] = [];
    host.overrides['vscode.workspace.notebookDocuments'] = [];
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Revert';
    await host.commands.get('unode.revertToRequest')!({ agentId: 'pm', historyId: task!.historyId });
    expect(fs.readFileSync(file, 'utf8')).toBe('original private bytes');
    const revert = store.recoveryOperations().find((operation) => operation.fromHistoryId === task!.historyId)!;
    expect(revert.closed?.applied).toBe(1);
    expect(liveHistory.openedStore!.pendingRecoveryNotices('pm').some((notice) => notice.operationId === revert.operationId)).toBe(true);
    // The revert holds the bytes Undo revert needs: the request's before and what it replaced.
    const identity = historyWorkspace([workspace], '');
    const rawDir = path.join(context.globalStorageUri.fsPath, 'checkpoints', 'raw-v2', identity.workspaceId);
    const index = () => JSON.parse(fs.readFileSync(path.join(rawDir, 'index.json'), 'utf8')) as { entries: Array<{ id: string; pins?: string[] }> };
    const held = () => index().entries.filter((entry) => (entry.pins ?? []).includes(`history:${revert.operationId}`)).map((entry) => entry.id);
    const kept = held();
    expect(kept.length).toBe(2);
    const posted = workbench();
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Delete';
    const warned = vi.spyOn(console, 'warn');
    chat.onMessage({ command: 'taskHistory', message: { command: 'deleteAll' } }, 'workbench');
    await pumpWhile(() => !posted.some((m) => m.command === 'taskHistory' && m.message.command === 'report'), flush);
    await screen.pump();
    // The chat drops the deleted messages on purpose: the page does not report them as lost.
    expect(warned.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('display-integrity'))).toEqual([]);
    warned.mockRestore();
    const report = posted.filter((m) => m.command === 'taskHistory' && m.message.command === 'report').at(-1).message.lines.join(' ') as string;
    expect(report, report).not.toMatch(/still in use/);
    expect(report, report).not.toMatch(/Not everything/);
    // Its kept bytes are gone, and nothing holds them.
    expect(held()).toEqual([]);
    for (const id of kept) expect(fs.existsSync(path.join(rawDir, 'payloads', `${id}.bin`)), id).toBe(false);
    // Its notice is no longer told, nor on disk with the deleted request's goal.
    expect(liveHistory.openedStore!.pendingRecoveryNotices('pm').some((notice) => notice.operationId === revert.operationId)).toBe(false);
    expect(historyEvents().some((envelope) => envelope.body.kind === 'recovery-notice' && JSON.stringify(envelope.body).includes('change the held file'))).toBe(false);
    // Undo revert no longer offers it, and refuses it if named; the file is as the revert left it.
    let offered: Array<{ description: string }> = [];
    host.overrides['vscode.window.showQuickPick'] = async (items: Array<{ description: string }>) => { offered = items; return items.find((item) => item.description === revert.operationId.slice(0, 8)); };
    await host.commands.get('unode.undoRevert')!();
    expect(offered.map((item) => item.description)).not.toContain(revert.operationId.slice(0, 8));
    expect(fs.readFileSync(file, 'utf8')).toBe('original private bytes');
    // A window that opens the history again agrees, and repairs no notice.
    const reopened = await HistoryStore.open({ directory: path.join(workspace, '.global', 'history', 'v1', identity.workspaceId), workspaceId: identity.workspaceId, writerId: randomUUID() });
    // No record of the revert is left: its files' paths and hashes went with its conversation and restore points.
    expect(reopened.recoveryOperation(revert.operationId)).toBeUndefined();
    expect(historyEvents().some((envelope) => (envelope.body as { operationId?: string }).operationId === revert.operationId)).toBe(false);
    expect(reopened.pendingRecoveryNotices('pm').some((notice) => notice.operationId === revert.operationId)).toBe(false);
    await reopened.dispose();
    await host.commands.get('unode.undoRevert')!();
    expect(historyEvents().some((envelope) => envelope.body.kind === 'recovery-notice' && JSON.stringify(envelope.body).includes('change the held file'))).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('original private bytes');
  });

  it('Delete all also deletes the Edit history with its text copies, and the archived chats, and says so', async () => {
    const created = path.join(workspace, 'delete-all-created.txt');
    let wrote = false;
    scripts.set('pm-model', (request) => {
      if (latestUser(request) !== 'create the private note') return { text: `done ${latestUser(request)}`.slice(0, 40) };
      if (!lastToolResult(request)) { wrote = true; return { calls: [{ name: 'write_file', args: { path: 'delete-all-created.txt', content: 'private note text' } }] }; }
      return { text: 'done create the private note' };
    });
    await screen.select('pm');
    await screen.send('create the private note');
    await pumpWhile(() => !wrote || !fs.existsSync(created) || !replies('pm').some((reply) => reply.includes('done create the private note')), flush);
    // The Edit history now holds the created file's text, without an exact restore point (it had no before).
    const state = new RootScopedWorkspaceState(context.workspaceState as never, workspace);
    const records = () => ((state.get<{ items: Array<{ path: string; after: string; raw?: unknown }> }>('roam.checkpoints')?.items) ?? [])
      .filter((item) => item.path.replace(/\\/g, '/').endsWith('delete-all-created.txt'));
    await pumpWhile(() => records().length === 0, flush);
    expect(records()[0].after).toBe('private note text');
    // An archived chat of this workspace.
    expect(chat.archiveSelectedAgent()).toBeGreaterThan(0);
    expect(chat.listArchivedChats().length).toBeGreaterThan(0);

    const posted = workbench();
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Delete';
    chat.onMessage({ command: 'taskHistory', message: { command: 'deleteAll' } }, 'workbench');
    await pumpWhile(() => !posted.some((m) => m.command === 'taskHistory' && m.message.command === 'report'), flush);
    const report = posted.filter((m) => m.command === 'taskHistory' && m.message.command === 'report').at(-1).message.lines.join(' ') as string;
    expect(report, report).toMatch(/Also deleted: [1-9]\d* Edit history record\(s\) with their text copies, and [1-9]\d* archived chat\(s\)\./);
    expect(report, report).not.toMatch(/Not everything/);
    // Gone from what this computer keeps, and the workspace file itself is untouched.
    expect(records()).toEqual([]);
    expect(JSON.stringify(state.get('roam.checkpoints') ?? {})).not.toContain('private note text');
    expect(chat.listArchivedChats()).toEqual([]);
    expect(fs.readFileSync(created, 'utf8')).toBe('private note text');
  });

  it('Delete all reports the Edit history deleted only once it is stored; a failed write is partial and deleting again stores it', async () => {
    const created = path.join(workspace, 'delete-all-slow.txt');
    let wrote = false;
    scripts.set('pm-model', (request) => {
      if (latestUser(request) !== 'create the slow note') return { text: `done ${latestUser(request)}`.slice(0, 40) };
      if (!lastToolResult(request)) { wrote = true; return { calls: [{ name: 'write_file', args: { path: 'delete-all-slow.txt', content: 'slow note text' } }] }; }
      return { text: 'done create the slow note' };
    });
    await screen.select('pm');
    await screen.send('create the slow note');
    await pumpWhile(() => !wrote || !fs.existsSync(created) || !replies('pm').some((reply) => reply.includes('done create the slow note')), flush);
    const state = new RootScopedWorkspaceState(context.workspaceState as never, workspace);
    const stored = () => JSON.stringify(state.get('roam.checkpoints') ?? {});
    await pumpWhile(() => !stored().includes('slow note text'), flush);

    // The Edit history's write is held, then fails.
    const memento = context.workspaceState as unknown as { update(key: string, value: unknown): Promise<void> };
    const update = memento.update.bind(memento);
    let release: ((error?: Error) => void) | undefined;
    memento.update = (key: string, value: unknown) => (key.endsWith('roam.checkpoints')
      ? new Promise<void>((resolve, reject) => { release = (error) => (error ? reject(error) : resolve()); })
      : update(key, value));
    try {
      const posted = workbench();
      host.overrides['vscode.window.showWarningMessage'] = async () => 'Delete';
      const reports = () => posted.filter((m) => m.command === 'taskHistory' && m.message.command === 'report');
      chat.onMessage({ command: 'taskHistory', message: { command: 'deleteAll' } }, 'workbench');
      await pumpWhile(() => !release, flush);
      for (let round = 0; round < 20; round++) await flush();
      expect(reports()).toEqual([]);
      release!(new Error('storage is full'));
      await pumpWhile(() => reports().length === 0, flush);
      const failed = reports().at(-1).message.lines.join(' ') as string;
      expect(failed, failed).toMatch(/Not everything could be removed; deleting again tries once more: .*the Edit history and archived chats could not be deleted \(storage is full\)/);
      expect(failed, failed).not.toMatch(/Also deleted/);
    } finally {
      memento.update = update;
    }
    // Deleting again stores it, although the record is already gone from memory.
    expect(stored()).toContain('slow note text');
    const again = workbench();
    chat.onMessage({ command: 'taskHistory', message: { command: 'deleteAll' } }, 'workbench');
    await pumpWhile(() => !again.some((m) => m.command === 'taskHistory' && m.message.command === 'report'), flush);
    const report = again.filter((m) => m.command === 'taskHistory' && m.message.command === 'report').at(-1).message.lines.join(' ') as string;
    expect(report, report).not.toMatch(/Not everything/);
    expect(stored()).not.toContain('slow note text');
  });

  it('housekeeping lets go of what a revert kept once neither Undo nor Redo can use it', async () => {
    scripts.set('pm-model', (request) => {
      if (latestUser(request) === 'write the swept file' && !lastToolResult(request)) {
        return { calls: [{ name: 'write_file', args: { path: 'swept.txt', content: 'swept' } }] };
      }
      if (latestUser(request) === 'newer work after undo' && !lastToolResult(request)) {
        return { calls: [{ name: 'write_file', args: { path: 'newer.txt', content: 'newer' } }] };
      }
      return { text: `done ${latestUser(request)}`.slice(0, 40) };
    });
    await screen.select('pm');
    await screen.send('write the swept file');
    await pumpWhile(() => !fs.existsSync(path.join(workspace, 'swept.txt')) || !replies('pm').some((reply) => reply.includes('done write the swept file')), flush);
    const store = (await liveHistory.store())!;
    let task: { historyId: string } | undefined;
    let swept: { historyId: string; rootRequestId?: string } | undefined;
    for (let i = 0; i < 100 && !(swept && store.recoveryManifest(swept.rootRequestId ?? '')?.files.length); i++) {
      swept = (await store.tasksOf('pm')).find((entry) => entry.goal === 'write the swept file');
      await flush();
    }
    task = swept;
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Revert';
    await host.commands.get('unode.revertToRequest')!({ agentId: 'pm', historyId: task!.historyId });
    const revert = store.recoveryOperations().find((operation) => operation.fromHistoryId === task!.historyId)!;
    expect(fs.existsSync(path.join(workspace, 'swept.txt'))).toBe(false);
    const identity = historyWorkspace([workspace], '');
    const rawDir = path.join(context.globalStorageUri.fsPath, 'checkpoints', 'raw-v2', identity.workspaceId);
    const holdsOf = (operationId: string) => (JSON.parse(fs.readFileSync(path.join(rawDir, 'index.json'), 'utf8')) as { entries: Array<{ pins?: string[] }> })
      .entries.filter((entry) => (entry.pins ?? []).includes(`history:${operationId}`)).length;
    expect(holdsOf(revert.operationId)).toBeGreaterThan(0);
    // Undo can still use them: housekeeping keeps them.
    await liveHistory.housekeep(true);
    expect(holdsOf(revert.operationId)).toBeGreaterThan(0);
    host.overrides['vscode.window.showQuickPick'] = async (items: Array<{ description: string }>) => items.find((item) => item.description === revert.operationId.slice(0, 8));
    await host.commands.get('unode.undoRevert')!();
    expect(fs.readFileSync(path.join(workspace, 'swept.txt'), 'utf8')).toBe('swept');
    // Redo can still use them.
    await liveHistory.housekeep(true);
    expect(holdsOf(revert.operationId)).toBeGreaterThan(0);
    // A newer request starts from the undone file: Redo is history and nothing stands reverted.
    await screen.send('newer work after undo');
    await pumpWhile(() => !fs.existsSync(path.join(workspace, 'newer.txt')) || !replies('pm').some((reply) => reply.includes('done newer work after undo')), flush);
    await liveHistory.housekeep(true);
    expect(holdsOf(revert.operationId)).toBe(0);
    expect(fs.readFileSync(path.join(workspace, 'swept.txt'), 'utf8')).toBe('swept');
  });

  it('Delete all also retires a revert of a request whose conversation was removed before', async () => {
    let step = 0;
    scripts.set('pm-model', (request) => {
      if (latestUser(request) !== 'create the hidden file') return { text: `done ${latestUser(request)}`.slice(0, 40) };
      if (!lastToolResult(request)) { step = 1; return { calls: [{ name: 'write_file', args: { path: 'hidden-delete.txt', content: 'created bytes' } }] }; }
      return { text: 'done create the hidden file' };
    });
    const file = path.join(workspace, 'hidden-delete.txt');
    await screen.select('pm');
    await screen.send('create the hidden file');
    await pumpWhile(() => !fs.existsSync(file) || !replies('pm').some((reply) => reply.includes('done create the hidden file')), flush,
      { detail: () => `step: ${step}; replies: ${JSON.stringify(replies('pm').slice(-3))}` });
    const store = (await liveHistory.store())!;
    let task: { historyId: string; rootRequestId?: string } | undefined;
    for (let i = 0; i < 100 && !(task && store.recoveryManifest(task.rootRequestId ?? '')?.files.length); i++) {
      task = (await store.tasksOf('pm')).find((entry) => entry.goal === 'create the hidden file');
      await flush();
    }
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Revert';
    await host.commands.get('unode.revertToRequest')!({ agentId: 'pm', historyId: task!.historyId });
    expect(fs.existsSync(file)).toBe(false);
    const revert = store.recoveryOperations().find((operation) => operation.fromHistoryId === task!.historyId)!;
    host.overrides['vscode.window.showQuickPick'] = async (items: Array<{ description: string }>) => items.find((item) => item.description === revert.operationId.slice(0, 8));
    await host.commands.get('unode.undoRevert')!();
    expect(fs.readFileSync(file, 'utf8')).toBe('created bytes');
    // The conversation is removed first; the task is no longer listed.
    expect((await liveHistory.deleteTasks([task!.historyId], 'view')).status).toBe('deleted');
    // Then Delete all: it retires the revert too.
    const posted = workbench();
    host.overrides['vscode.window.showWarningMessage'] = async () => 'Delete';
    chat.onMessage({ command: 'taskHistory', message: { command: 'deleteAll' } }, 'workbench');
    await pumpWhile(() => !posted.some((m) => m.command === 'taskHistory' && m.message.command === 'report'), flush);
    expect(store.recoveryRetired(revert.operationId)).toBe(true);
    let offered: Array<{ description: string }> = [];
    host.overrides['vscode.window.showQuickPick'] = async (items: Array<{ description: string }>) => { offered = items; return items.find((item) => item.description === revert.operationId.slice(0, 8)); };
    await host.commands.get('unode.redoRevert')!();
    await host.commands.get('unode.undoRevert')!();
    expect(offered.map((item) => item.description)).not.toContain(revert.operationId.slice(0, 8));
    expect(fs.readFileSync(file, 'utf8')).toBe('created bytes');
    // A window that opens the history again agrees.
    const identity = historyWorkspace([workspace], '');
    const reopened = await HistoryStore.open({ directory: path.join(workspace, '.global', 'history', 'v1', identity.workspaceId), workspaceId: identity.workspaceId, writerId: randomUUID() });
    // No record of the revert is left: its files' paths and hashes went with its conversation and restore points.
    expect(reopened.recoveryOperation(revert.operationId)).toBeUndefined();
    expect(historyEvents().some((envelope) => (envelope.body as { operationId?: string }).operationId === revert.operationId)).toBe(false);
    await reopened.dispose();
  });
});
