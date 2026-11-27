import { describe, expect, it } from 'vitest';
import {
  fetchMentionWithReminders, MENTION_FETCH_FIRST_REMINDER_MS, MENTION_FETCH_KEEP_WAITING, MENTION_FETCH_REMINDER_INTERVAL_MS,
  MENTION_FETCH_STOP, mentionReminderText,
} from '../mentionFetch';

/**
 * v0.9.99 (the Owner's decision): an @url mention has no deadline. A reminder now and then lets the person send the
 * message without the page, or keep waiting until the next reminder.
 */
describe('reading an @url mention before the message is sent', () => {
  function harness() {
    let clock = 0;
    let finish!: (text: string) => void;
    let signal!: AbortSignal;
    const reminders: Array<{ text: string; answer: (choice: string | undefined) => void }> = [];
    let timer: { run: () => void; ms: number } | undefined;
    const result = fetchMentionWithReminders('https://example.com/spec', {
      fetch: (_url, s) => {
        signal = s;
        return new Promise<string>((resolve) => {
          finish = resolve;
          s.addEventListener('abort', () => resolve('Error: The fetch was stopped before it finished. Nothing from it was added.'));
        });
      },
      remind: (text) => new Promise((resolve) => { reminders.push({ text, answer: resolve }); }),
      setTimer: (run, ms) => { timer = { run, ms }; return () => { if (timer?.run === run) timer = undefined; }; },
      now: () => clock,
    });
    const fire = () => { const due = timer; timer = undefined; clock += due?.ms ?? 0; due?.run(); };
    const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
    return { result, reminders, finish: (t: string) => finish(t), signal: () => signal, fire, settle, pendingMs: () => timer?.ms };
  }

  it('a quick page shows no reminder and is attached', async () => {
    const h = harness();
    expect(h.pendingMs()).toBe(MENTION_FETCH_FIRST_REMINDER_MS);
    h.finish('Spec text.');
    await expect(h.result).resolves.toBe('Spec text.');
    expect(h.pendingMs()).toBeUndefined();
    expect(h.reminders).toEqual([]);
  });

  it('a slow page reminds after 10 s with both choices; Keep waiting brings the next reminder 30 s later', async () => {
    const h = harness();
    h.fire();
    expect(h.reminders.map((row) => row.text)).toEqual([mentionReminderText('https://example.com/spec', 10)]);
    expect(h.reminders[0].text).toBe('Still reading example.com for your message (10 s). Your message waits for it. '
      + 'Choose Send without it to send it now without this page, or Keep waiting until the next reminder.');
    h.reminders[0].answer(MENTION_FETCH_KEEP_WAITING);
    await h.settle();
    expect(h.pendingMs()).toBe(MENTION_FETCH_REMINDER_INTERVAL_MS);
    h.fire();
    expect(h.reminders.at(-1)?.text).toContain('(40 s)');
    expect(h.signal().aborted).toBe(false);
    h.finish('Slow spec text.');
    await expect(h.result).resolves.toBe('Slow spec text.');
  });

  it('Send without it ends the read, and the message goes without the page', async () => {
    const h = harness();
    h.fire();
    h.reminders[0].answer(MENTION_FETCH_STOP);
    await h.settle();
    expect(h.signal().aborted).toBe(true);
    await expect(h.result).resolves.toBe('Error: The fetch was stopped before it finished. Nothing from it was added.');
    expect(h.pendingMs()).toBeUndefined();
  });

  it('a closed reminder keeps waiting, and the next reminder comes', async () => {
    const h = harness();
    h.fire();
    h.reminders[0].answer(undefined);
    await h.settle();
    expect(h.signal().aborted).toBe(false);
    expect(h.pendingMs()).toBe(MENTION_FETCH_REMINDER_INTERVAL_MS);
  });

  it('an answer to a reminder after the page arrived changes nothing', async () => {
    const h = harness();
    h.fire();
    h.finish('Spec text.');
    await expect(h.result).resolves.toBe('Spec text.');
    h.reminders[0].answer(MENTION_FETCH_STOP);
    await h.settle();
    expect(h.signal().aborted).toBe(false);
    expect(h.pendingMs()).toBeUndefined();
  });

  it('a reminder that cannot be shown keeps waiting, and the next reminder is scheduled', async () => {
    let timer: { run: () => void; ms: number } | undefined;
    let signal!: AbortSignal;
    let finish!: (text: string) => void;
    const result = fetchMentionWithReminders('https://example.com/spec', {
      fetch: (_url, s) => { signal = s; return new Promise<string>((resolve) => { finish = resolve; }); },
      remind: () => Promise.reject(new Error('notifications unavailable')),
      setTimer: (run, ms) => { timer = { run, ms }; return () => { timer = undefined; }; },
      now: () => 0,
    });
    const first = timer!;
    timer = undefined;
    first.run();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(signal.aborted).toBe(false);
    expect(timer?.ms).toBe(MENTION_FETCH_REMINDER_INTERVAL_MS);
    finish('Spec text.');
    await expect(result).resolves.toBe('Spec text.');
  });

  it('names the text as typed when it is not a URL', () => {
    expect(mentionReminderText('not a url', 12)).toContain('Still reading not a url for your message (12 s).');
  });
});
