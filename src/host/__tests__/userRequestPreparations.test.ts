import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { prepareAndSubmit, STOPPED_BEFORE_SENDING, stopPreparing, UserRequestPreparations } from '../userRequestPreparations';
import { fetchMentionWithReminders } from '../../session/mentionFetch';

/**
 * v0.9.99 (audit I2): Stop of a message whose @url is still being read ends the read and the message. Through the real
 * preparation tracker and the real reminder fetch: a page that arrives after Stop submits nothing.
 */
describe('Stop while a sent message is still being prepared', () => {
  function pendingPage() {
    let resolve!: (text: string) => void;
    let signal!: AbortSignal;
    const fetch = (_url: string, s: AbortSignal) => {
      signal = s;
      return new Promise<string>((done) => { resolve = done; });
    };
    return { fetch, resolve: (text: string) => resolve(text), signal: () => signal };
  }
  const ports = (fetch: (url: string, signal: AbortSignal) => Promise<string>) => ({
    fetch, remind: () => new Promise<string | undefined>(() => undefined), setTimer: () => () => undefined, now: () => 0,
  });

  it('a message prepared without Stop is submitted with the page', async () => {
    const preparations = new UserRequestPreparations();
    const page = pendingPage();
    const submit = vi.fn();
    const outcome = prepareAndSubmit(preparations, 'dev', {
      prepare: (stopped) => fetchMentionWithReminders('https://example.com', ports(page.fetch), stopped),
      submit,
    });
    expect(preparations.pending('dev')).toBe(1);
    page.resolve('Page text.');
    await expect(outcome).resolves.toBe('submitted');
    expect(submit).toHaveBeenCalledWith('Page text.');
    expect(preparations.pending('dev')).toBe(0);
  });

  it('Stop aborts the page read, and the late page submits nothing', async () => {
    const preparations = new UserRequestPreparations();
    const page = pendingPage();
    const submit = vi.fn();
    const outcome = prepareAndSubmit(preparations, 'dev', {
      prepare: (stopped) => fetchMentionWithReminders('https://example.com', ports(page.fetch), stopped),
      submit,
    });
    expect(preparations.cancel('dev')).toBe(1);
    expect(page.signal().aborted).toBe(true);
    // The network finishes anyway, after Stop.
    page.resolve('Late page text.');
    await expect(outcome).resolves.toBe('cancelled');
    expect(submit).not.toHaveBeenCalled();
    expect(preparations.pending('dev')).toBe(0);
  });

  it('a preparation step that ignores the signal and finishes after Stop still submits nothing', async () => {
    const preparations = new UserRequestPreparations();
    let finish!: (value: string) => void;
    const submit = vi.fn();
    const outcome = prepareAndSubmit(preparations, 'dev', {
      prepare: () => new Promise<string>((done) => { finish = done; }),
      submit,
    });
    preparations.cancel('dev');
    finish('ready');
    await expect(outcome).resolves.toBe('cancelled');
    expect(submit).not.toHaveBeenCalled();
  });

  it('Stop of one agent leaves another agent\'s message to be sent', async () => {
    const preparations = new UserRequestPreparations();
    const pageA = pendingPage();
    const pageB = pendingPage();
    const submitted: string[] = [];
    const a = prepareAndSubmit(preparations, 'dev', {
      prepare: (stopped) => fetchMentionWithReminders('https://a.example', ports(pageA.fetch), stopped),
      submit: (text) => submitted.push(`dev:${text}`),
    });
    const b = prepareAndSubmit(preparations, 'other', {
      prepare: (stopped) => fetchMentionWithReminders('https://b.example', ports(pageB.fetch), stopped),
      submit: (text) => submitted.push(`other:${text}`),
    });
    preparations.cancel('dev');
    expect(pageB.signal().aborted).toBe(false);
    pageA.resolve('A');
    pageB.resolve('B');
    await expect(a).resolves.toBe('cancelled');
    await expect(b).resolves.toBe('submitted');
    expect(submitted).toEqual(['other:B']);
  });

  it('a cancel with nothing under way reports none', () => {
    expect(new UserRequestPreparations().cancel('dev')).toBe(0);
  });

  it('a Stop ends the named agents\' preparations, tells each of them once, and leaves the others', () => {
    const preparations = new UserRequestPreparations();
    const dev = [preparations.begin('dev'), preparations.begin('dev')];
    const other = preparations.begin('other');
    const idle = preparations.begin('idle');
    expect(preparations.agents().sort()).toEqual(['dev', 'idle', 'other']);
    const told: Array<[string, string]> = [];
    stopPreparing(preparations, ['dev', 'idle', 'nobody'], (agentId, text) => { told.push([agentId, text]); });
    expect(told).toEqual([['dev', STOPPED_BEFORE_SENDING], ['idle', STOPPED_BEFORE_SENDING]]);
    expect(dev.every((preparation) => preparation.cancelled())).toBe(true);
    expect(idle.cancelled()).toBe(true);
    expect(other.cancelled()).toBe(false);
    expect(preparations.agents()).toEqual(['other']);
  });

  // The host wiring: Stop, removal and a cleared conversation cancel; Stop tells the person; the send goes through it.
  // The Stop surfaces themselves run through the real extension source in userStopSurfaces.test.ts.
  it('the extension cancels preparations on Stop, removal and clear, and sends through prepareAndSubmit', () => {
    const source = readFileSync(path.join(__dirname, '..', '..', 'extension.ts'), 'utf8');
    expect(source).toMatch(/const stopPreparingMessages = \(agentIds: readonly string\[\] \| 'all'\): void => \{\s*chatViewProvider\?\.stopWaitingSends\(agentIds\);\s*stopPreparing\(userRequestPreparations, agentIds === 'all' \? userRequestPreparations\.agents\(\) : agentIds,\s*\(agentId, text\) => chatViewProvider\?\.postNotice\(agentId, text\)\);\s*\};/);
    expect(source).toContain('beginPreparation: (agentId) => userRequestPreparations.begin(agentId),');
    expect(source).toMatch(/retirePreparing: \(agentId\) => userRequestPreparations\.cancel\(agentId\) > 0 && sessionManager\.get\(agentId\)\?\.status !== 'running',/);
    expect(source).toMatch(/sessionManager\.on\('session\.removed', \(e\) => \{[\s\S]{0,200}?userRequestPreparations\.cancel\(e\.sessionId\);/);
    expect(source).toContain('await prepareAndSubmit(userRequestPreparations, agentId, {');
    expect(source).toContain('fetchText: (url) => fetchMentionUrl(url, stopped),');
    expect(STOPPED_BEFORE_SENDING).toBe('You stopped this message before it was sent. The agent did not receive it; send it again when you want it.');
  });
});
