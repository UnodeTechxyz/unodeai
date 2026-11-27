import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryConflictError, HistoryStore, HISTORY_PAGE_SIZE, type HistoryStoreOptions } from '../HistoryStore';
import type { HistoryEventBody } from '../HistoryRecords';
import type { ChatHistoryMessage } from '../../views/chatHistory';
import type { ProcessIdentityAdapter, ProcessIdentityRecord, ProcessLiveness } from '../../host/processIdentity/ProcessIdentityHost';

const WORKSPACE = 'a'.repeat(64);
let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-history-'));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function open(overrides: Partial<HistoryStoreOptions> = {}): Promise<HistoryStore> {
  return HistoryStore.open({ directory: dir, workspaceId: WORKSPACE, writerId: overrides.writerId ?? randomUUID(), ...overrides });
}

function message(role: 'user' | 'agent', text: string, extra: Partial<ChatHistoryMessage> = {}): ChatHistoryMessage {
  return { role, text, ts: new Date(Date.UTC(2026, 10, 25, 10, 0, 0)).toISOString(), messageId: randomUUID(), ...extra };
}

function append(agentId: string, m: ChatHistoryMessage, startsTask?: string): HistoryEventBody {
  return { kind: 'transcript-append', agentId, viewGeneration: 'gen-1', messageId: m.messageId!, message: m,
    ...(startsTask ? { startsTask: { historyId: startsTask } } : {}) };
}

function eventFiles(): string[] {
  return fs.readdirSync(path.join(dir, 'events')).filter((name) => /^\d{12}\.json$/.test(name)).sort();
}

describe('HistoryStore', () => {
  it('keeps every message past the 50-message chat window and reads it back after a reopen', async () => {
    const store = await open();
    for (let task = 0; task < 40; task++) {
      const historyId = `task-${task}`;
      expect((await store.append(append('dev', message('user', `goal ${task}`), historyId))).status).toBe('durable');
      expect((await store.append(append('dev', message('agent', `answer ${task}`, { turnFinal: true })))).status).toBe('durable');
    }
    await store.dispose();
    const reopened = await open();
    expect(reopened.messagesOf('dev')).toHaveLength(80);
    const first = await reopened.query();
    expect(first.tasks).toHaveLength(HISTORY_PAGE_SIZE > 40 ? 40 : HISTORY_PAGE_SIZE);
    expect(first.tasks[0]).toMatchObject({ historyId: 'task-39', goal: 'goal 39', conclusion: 'answer 39', legacy: false, terminal: 'unfinished' });
    const found = await reopened.query({ text: 'GOAL 3' });
    expect(found.tasks.map((task) => task.goal)).toEqual(['goal 39', 'goal 38', 'goal 37', 'goal 36', 'goal 35', 'goal 34', 'goal 33', 'goal 32', 'goal 31', 'goal 30', 'goal 3']);
  });

  it('records an event delivered twice once, under its first revision', async () => {
    const store = await open();
    const m = message('user', 'once');
    const first = await store.append(append('dev', m, 't1'), { eventId: 'event-1' });
    const second = await store.append(append('dev', m, 't1'), { eventId: 'event-1' });
    expect(first).toMatchObject({ status: 'durable', revision: 1 });
    expect(second).toEqual({ status: 'duplicate', revision: 1, eventId: 'event-1' });
    expect(eventFiles()).toEqual(['000000000001.json']);
  });

  it('gives two windows writing at once distinct revisions, and each reads the other', async () => {
    const left = await open();
    const right = await open();
    const writes = [];
    for (let i = 0; i < 20; i++) {
      writes.push(left.append(append('a', message('user', `left ${i}`), `l${i}`)));
      writes.push(right.append(append('b', message('user', `right ${i}`), `r${i}`)));
    }
    const results = await Promise.all(writes);
    expect(results.every((result) => result.status === 'durable')).toBe(true);
    const revisions = results.map((result) => (result as { revision: number }).revision);
    expect(new Set(revisions).size).toBe(40);
    expect(eventFiles()).toHaveLength(40);
    await left.refresh();
    await right.refresh();
    expect(left.messagesOf('b').map((entry) => entry.message.text)).toEqual(Array.from({ length: 20 }, (_, i) => `right ${i}`));
    expect(right.messagesOf('a')).toHaveLength(20);
  });

  it('publishes by exclusive create where the file system has no hard links', async () => {
    const store = await open({ hardLinks: false });
    expect((await store.append(append('dev', message('user', 'no links'), 't'))).status).toBe('durable');
    const other = await open();
    expect(other.messagesOf('dev')[0].message.text).toBe('no links');
  });

  it('shows an unreadable event as a gap, keeps its revision number taken, and reads the events after it', async () => {
    const store = await open();
    await store.append(append('dev', message('user', 'before'), 't1'));
    const broken = path.join(dir, 'events', '000000000002.json');
    await fsp.writeFile(broken, '{"schemaVersion":1,"eventId":', 'utf8');
    // Young, it may still be being written: nothing reads past it, and nothing is set aside.
    const early = await open();
    expect(early.gaps).toEqual([]);
    // Unchanged past the grace, it is set aside as a gap.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(broken, old, old);
    const late = await open();
    const result = await late.append(append('dev', message('user', 'after'), 't2'));
    expect(result).toMatchObject({ status: 'durable', revision: 3 });
    expect(late.gaps).toEqual([2]);
    expect(fs.existsSync(path.join(dir, 'events', '000000000002.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'quarantine', '000000000002.json'))).toBe(true);
    expect((await late.query()).gaps).toEqual([2]);
    expect(late.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['before', 'after']);
  });

  it('turns read-only on an event from a newer schema instead of misreading it', async () => {
    const store = await open();
    await store.append(append('dev', message('user', 'v1'), 't1'));
    await fsp.writeFile(path.join(dir, 'events', '000000000002.json'), JSON.stringify({ schemaVersion: 2, eventId: 'x' }), 'utf8');
    const reader = await open();
    expect(reader.readOnly).toMatch(/newer UnodeAi/);
    expect(await reader.append(append('dev', message('user', 'v1 again'), 't2'))).toMatchObject({ status: 'read-only' });
    expect(reader.messagesOf('dev')).toHaveLength(1);
    expect(eventFiles()).toHaveLength(2);
  });

  it('refuses an event its own parser would not keep, before anything is written', async () => {
    const store = await open();
    const bad = { kind: 'transcript-append', agentId: 'dev', viewGeneration: 'g', messageId: 'bad id with spaces', message: message('user', 'x') } as HistoryEventBody;
    expect(await store.append(bad)).toMatchObject({ status: 'failed' });
    expect(eventFiles()).toEqual([]);
  });

  it('folds events into a snapshot, removes the folded files, and a reader that was behind starts again from it', async () => {
    const writer = await open({ compactAfter: 10 });
    const behind = await open();
    for (let i = 0; i < 12; i++) await writer.append(append('dev', message('user', `m${i}`), `t${i}`));
    // Let the background compaction finish.
    await writer.append(append('dev', message('user', 'm12'), 't12'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.readdirSync(path.join(dir, 'snapshots')).length).toBeGreaterThan(0);
    expect(eventFiles().length).toBeLessThan(13);
    await behind.refresh();
    expect(behind.messagesOf('dev').map((entry) => entry.message.text)).toEqual(Array.from({ length: 13 }, (_, i) => `m${i}`));
    const next = await behind.append(append('dev', message('user', 'after snapshot'), 't13'));
    expect(next).toMatchObject({ status: 'durable', revision: 14 });
    const fresh = await open();
    expect(fresh.messagesOf('dev')).toHaveLength(14);
  });

  it('applies a favourite only against the task revision it was read at', async () => {
    const left = await open();
    const right = await open();
    await left.append(append('dev', message('user', 'goal'), 'task'));
    const seen = (await left.task('task'))!;
    await right.refresh();
    await left.setFavourite('task', seen.revision, true);
    expect((await left.task('task'))!.favourite).toBe(true);
    // The other window read the task before the change: its change is refused, not merged.
    await expect(right.setFavourite('task', seen.revision, false)).rejects.toBeInstanceOf(HistoryConflictError);
    expect((await right.task('task'))!.favourite).toBe(true);
    await expect(left.setFavourite('missing', 1, true)).rejects.toBeInstanceOf(HistoryConflictError);
  });

  it('applies only the first of two favourite changes made against the same reading, whichever window reads the log', async () => {
    const left = await open();
    const right = await open();
    await left.append(append('dev', message('user', 'goal'), 'task'));
    const seen = (await left.task('task'))!;
    // Both windows passed their own check before either change was published: the log decides.
    await left.append({ kind: 'favourite', historyId: 'task', value: true, expectedRevision: seen.revision });
    await right.append({ kind: 'favourite', historyId: 'task', value: false, expectedRevision: seen.revision });
    await left.refresh();
    await right.refresh();
    expect((await left.task('task'))!.favourite).toBe(true);
    expect((await right.task('task'))!.favourite).toBe(true);
    expect((await (await open()).task('task'))!.favourite).toBe(true);
  });

  it('links an admitted request and its closeout outcome to the task its message began', async () => {
    const store = await open({ isRequestRunning: (id) => id === 'req-running' });
    await store.append(append('dev', message('user', 'run'), 'running-task'));
    await store.append({ kind: 'request-admitted', historyId: 'running-task', rootRequestId: 'req-running', agentId: 'dev' });
    await store.append(append('dev', message('user', 'done'), 'done-task'));
    await store.append({ kind: 'request-admitted', historyId: 'done-task', rootRequestId: 'req-done', agentId: 'dev' });
    await store.append({ kind: 'outcome-reference', historyId: 'done-task', outcomeRef: 'request-closeout:req-done:turn',
      terminal: 'completed', verification: 'verified', endedAt: '2026-11-25T10:05:00.000Z' });
    const page = await store.query();
    expect(page.tasks.map((task) => [task.historyId, task.terminal, task.verification, task.rootRequestId])).toEqual([
      ['done-task', 'completed', 'verified', 'req-done'],
      ['running-task', 'running', 'unknown', 'req-running'],
    ]);
    expect(store.historyIdOfRequest('req-done')).toBe('done-task');
    expect((await store.query({ verification: 'verified' })).tasks.map((task) => task.historyId)).toEqual(['done-task']);
  });

  it('keeps the replies of a request still being answered with it when another version\'s messages arrive in between', async () => {
    const store = await open();
    await store.append(append('dev', message('user', 'live request'), 'live'));
    const other = message('user', 'typed in 0.9.109');
    await store.append({ kind: 'legacy-import', agentId: 'dev', projectionKey: 'roam.chat.dev', observedDigest: 'e'.repeat(64),
      reason: 'divergence', viewGeneration: 'gen-1', messages: [{ messageId: other.messageId!, message: other }] });
    await store.append(append('dev', message('agent', 'live answer', { turnFinal: true })));
    const live = (await store.task('live'))!;
    expect(live.conclusion).toBe('live answer');
    expect(live.messageIds).toHaveLength(2);
    expect((await store.task(`legacy-${other.messageId}`))!.messageIds).toEqual([other.messageId]);
  });

  it('keeps an imported message without a request record as an unrecorded task', async () => {
    const store = await open();
    const user = message('user', 'from 0.9.109');
    await store.append({ kind: 'legacy-import', agentId: 'dev', projectionKey: 'roam.chat.dev', observedDigest: 'b'.repeat(64),
      reason: 'migration', viewGeneration: 'g0', messages: [{ messageId: user.messageId!, message: user }] });
    const [task] = (await store.query()).tasks;
    expect(task).toMatchObject({ legacy: true, terminal: 'unfinished', verification: 'unknown', goal: 'from 0.9.109' });
    expect(task.rootRequestId).toBeUndefined();
  });
});

describe('HistoryStore stale staging', () => {
  function adapter(answers: Record<number, ProcessLiveness>): ProcessIdentityAdapter & { asked: ProcessIdentityRecord[][] } {
    const asked: ProcessIdentityRecord[][] = [];
    return {
      platform: 'linux',
      asked,
      self: async () => ({ pid: 1, startToken: '1', bootToken: 'boot', platform: 'linux' }),
      liveness: async (records) => { asked.push([...records]); return records.map((record) => answers[record.pid] ?? 'unknown'); },
    };
  }

  async function leaveStaging(writerId: string, pid: number | undefined): Promise<void> {
    await fsp.mkdir(path.join(dir, 'staging', writerId), { recursive: true });
    await fsp.writeFile(path.join(dir, 'staging', writerId, 'event.0.json'), '{}', 'utf8');
    await fsp.mkdir(path.join(dir, 'writers'), { recursive: true });
    if (pid !== undefined) {
      await fsp.writeFile(path.join(dir, 'writers', `${writerId}.json`), JSON.stringify({
        writerId, identity: { pid, startToken: String(pid), bootToken: 'boot', platform: 'linux' } }), 'utf8');
    }
  }

  it('reads no process identity in a window that never writes, and publishes it once after the first write', async () => {
    const identity = adapter({});
    let selfCalls = 0;
    const counting = { ...identity, self: async () => { selfCalls++; return identity.self(); } };
    const idle = await open({ identity: counting, writerId: 'idle', identityDelayMs: 0 });
    await idle.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(selfCalls).toBe(0);
    const writer = await open({ identity: counting, writerId: 'writer', identityDelayMs: 0 });
    await writer.append(append('dev', message('user', 'first'), 't1'));
    await writer.append(append('dev', message('user', 'second'), 't2'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(selfCalls).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'writers', 'writer.json'), 'utf8'))).toMatchObject({ writerId: 'writer', identity: { pid: 1 } });
    await writer.dispose();
    expect(fs.existsSync(path.join(dir, 'writers', 'writer.json'))).toBe(false);
  });

  it('removes a crashed writer\'s staging only when its process is proven gone', async () => {
    await leaveStaging('gone-writer', 10);
    await leaveStaging('alive-writer', 11);
    await leaveStaging('unknown-writer', 12);
    await leaveStaging('unrecorded-writer', undefined);
    const identity = adapter({ 10: 'gone', 11: 'alive', 12: 'unknown' });
    const store = await open({ identity, writerId: 'me' });
    const removed = await store.removeStaleStaging();
    expect(removed).toEqual(['gone-writer']);
    const left = fs.readdirSync(path.join(dir, 'staging')).sort();
    expect(left).toEqual(['alive-writer', 'me', 'unknown-writer', 'unrecorded-writer']);
    expect(fs.existsSync(path.join(dir, 'writers', 'gone-writer.json'))).toBe(false);
  });
});
