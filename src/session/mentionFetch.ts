/**
 * v0.9.99 (the Owner's decision): an @url mention is read before the message is sent, and has no deadline. While it
 * runs, a reminder appears now and then: the person can stop the read, which sends the message without that page, or
 * keep waiting until the next reminder. A quick page shows nothing.
 */

/** When the first reminder appears. A reminder point, not a deadline. */
export const MENTION_FETCH_FIRST_REMINDER_MS = 10_000;
/** How long after the person chose to keep waiting (or closed the reminder) the next one appears. */
export const MENTION_FETCH_REMINDER_INTERVAL_MS = 30_000;
export const MENTION_FETCH_STOP = 'Send without it';
export const MENTION_FETCH_KEEP_WAITING = 'Keep waiting';

export interface MentionFetchPorts {
  /** The fetch itself; the signal ends it. */
  fetch(url: string, signal: AbortSignal): Promise<string>;
  /** A non-modal reminder with buttons; resolves to the button chosen, or undefined when it was closed. */
  remind(text: string, buttons: readonly string[]): Thenable<string | undefined>;
  setTimer(run: () => void, ms: number): () => void;
  now(): number;
}

/**
 * The fetch's own text (an error text when it failed or was stopped); the caller decides what is attached. `stopped`
 * is the message's own cancellation (Stop of the whole message): it ends this read too.
 */
export async function fetchMentionWithReminders(url: string, ports: MentionFetchPorts, stopped?: AbortSignal): Promise<string> {
  const abort = new AbortController();
  const onStopped = () => abort.abort();
  if (stopped?.aborted) abort.abort();
  else stopped?.addEventListener('abort', onStopped, { once: true });
  const startedAt = ports.now();
  let settled = false;
  let cancelTimer: () => void = () => undefined;
  const schedule = (ms: number): void => {
    cancelTimer = ports.setTimer(() => {
      if (settled) return;
      const seconds = Math.round((ports.now() - startedAt) / 1000);
      void Promise.resolve(ports.remind(mentionReminderText(url, seconds), [MENTION_FETCH_STOP, MENTION_FETCH_KEEP_WAITING]))
        .then((choice) => {
          if (settled) return;
          if (choice === MENTION_FETCH_STOP) abort.abort();
          else schedule(MENTION_FETCH_REMINDER_INTERVAL_MS);
        }, () => { if (!settled) schedule(MENTION_FETCH_REMINDER_INTERVAL_MS); });
    }, ms);
  };
  schedule(MENTION_FETCH_FIRST_REMINDER_MS);
  try {
    return await ports.fetch(url, abort.signal);
  } catch {
    return '';
  } finally {
    settled = true;
    cancelTimer();
    stopped?.removeEventListener('abort', onStopped);
  }
}

export function mentionReminderText(url: string, seconds: number): string {
  let site = url;
  try { site = new URL(url).host || url; } catch { /* keep the text as typed */ }
  return `Still reading ${site} for your message (${seconds} s). Your message waits for it. `
    + `Choose ${MENTION_FETCH_STOP} to send it now without this page, or ${MENTION_FETCH_KEEP_WAITING} until the next reminder.`;
}
