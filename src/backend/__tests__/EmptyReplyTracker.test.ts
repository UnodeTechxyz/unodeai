import { describe, expect, it } from 'vitest';
import { EmptyReplyTracker } from '../EmptyReplyTracker';

const end = { inputTokens: 1_000, inputBasis: 'reported' as const, finishSignal: 'stop' };

describe('EmptyReplyTracker (v0.9.90 §7)', () => {
  it('allows one unchanged retry of a blank attempt, and names a second blank an empty reply', () => {
    const tracker = new EmptyReplyTracker('openrouter');
    tracker.beginAttempt();
    tracker.noteText('  \n');
    expect(tracker.endAttempt(end)).toBe(true);
    expect(tracker.takeRetry()).toBe(true);
    tracker.beginAttempt();
    expect(tracker.endAttempt({ ...end, responseId: 'gen-2', upstreamProvider: undefined })).toBe(true);
    expect(tracker.takeRetry()).toBe(false);
    expect(tracker.outcome()).toEqual({
      kind: 'empty-reply',
      attempts: [
        { attempt: 1, gateway: 'openrouter', inputTokens: 1_000, inputBasis: 'reported', finishSignal: 'stop' },
        { attempt: 2, gateway: 'openrouter', inputTokens: 1_000, inputBasis: 'reported', finishSignal: 'stop', responseId: 'gen-2' },
      ],
    });
  });

  it('is a reply when the retry delivers text', () => {
    const tracker = new EmptyReplyTracker('claude-cli');
    tracker.beginAttempt();
    tracker.endAttempt(end);
    tracker.takeRetry();
    tracker.beginAttempt();
    tracker.noteText('done');
    expect(tracker.endAttempt(end)).toBe(false);
    expect(tracker.outcome()).toEqual({ kind: 'reply' });
  });

  it('never retries an attempt with a tool call or an approval, and calls a turn without final text tool-only', () => {
    const tracker = new EmptyReplyTracker('codex-app-server');
    tracker.beginAttempt();
    tracker.noteActivity();
    expect(tracker.endAttempt(end)).toBe(false);
    expect(tracker.takeRetry()).toBe(false);
    expect(tracker.outcome()).toEqual({ kind: 'tool-only' });
  });

  it('keeps a later blank response retryable in a tool loop, and still calls the turn tool-only', () => {
    const tracker = new EmptyReplyTracker('openrouter');
    tracker.beginAttempt();
    tracker.noteText('Reading the file.');
    tracker.noteActivity();
    tracker.endAttempt(end);
    tracker.beginAttempt();
    expect(tracker.endAttempt(end)).toBe(true);
    expect(tracker.takeRetry()).toBe(true);
    tracker.beginAttempt();
    tracker.endAttempt(end);
    expect(tracker.outcome()).toEqual({ kind: 'tool-only' });
  });

  it('never grants a second retry in one turn', () => {
    const tracker = new EmptyReplyTracker('openrouter');
    tracker.beginAttempt();
    tracker.endAttempt(end);
    expect(tracker.takeRetry()).toBe(true);
    tracker.beginAttempt();
    tracker.noteText('partial');
    tracker.noteActivity();
    tracker.endAttempt(end);
    tracker.beginAttempt();
    tracker.endAttempt(end);
    expect(tracker.takeRetry()).toBe(false);
  });
});
