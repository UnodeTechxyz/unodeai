import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATTENTION_RECENT_KEYS,
  AttentionSignal,
  attentionAppearance,
  blockingPrompt,
  installAttentionSignal,
  localReadAttentionKey,
  untimedPrompt,
  type PromptWait,
} from '../attentionSignal';

const untimed = untimedPrompt('a test prompt');

function harness(overrides: { enabled?: () => boolean; play?: (id: string) => string | undefined } = {}) {
  const played: string[] = [];
  const logs: string[] = [];
  let enabled = true;
  const signal = new AttentionSignal({
    enabled: overrides.enabled ?? (() => enabled),
    play: overrides.play ?? ((id) => { played.push(id); return 'workbench'; }),
    log: (message) => logs.push(message),
    resultTimeoutMs: 1_000,
  });
  return { signal, played, logs, setEnabled: (value: boolean) => { enabled = value; } };
}

afterEach(() => {
  installAttentionSignal(undefined);
  vi.useRealTimers();
});

describe('AttentionSignal (v0.9.88 §5.11)', () => {
  it('sounds once per prompt appearance; a re-render or retry of the same key adds nothing', () => {
    const { signal, played } = harness();
    signal.required('approval:appr-1');
    signal.required('approval:appr-1');
    signal.required('approval:appr-2');
    expect(played).toHaveLength(2);
  });

  it('sends the webview only a fresh opaque id, never the key or its path', () => {
    const { signal, played } = harness();
    const longRoot = `C:\\${'very-long-folder\\'.repeat(40)}secret-project`;
    signal.required(localReadAttentionKey(longRoot, 3));
    expect(played).toHaveLength(1);
    expect(played[0].length).toBeLessThanOrEqual(64);
    expect(played[0]).not.toContain('secret-project');
    expect(played[0]).not.toContain('local-read');
  });

  it('is silent in every case while the setting is off, and sounds again once it is back on', () => {
    const { signal, played, setEnabled } = harness();
    setEnabled(false);
    signal.required('approval:appr-1');
    signal.required('model-egress:x');
    expect(played).toEqual([]);
    setEnabled(true);
    signal.required('approval:appr-1');
    expect(played).toHaveLength(1);
  });

  it('never throws into the prompt, even when the player or the setting throws', () => {
    const throwingPlay = harness({ play: () => { throw new Error('webview disposed'); } });
    expect(() => throwingPlay.signal.required('approval:appr-1')).not.toThrow();
    expect(throwingPlay.logs).toHaveLength(1);
    const throwingSetting = harness({ enabled: () => { throw new Error('configuration unavailable'); } });
    expect(() => throwingSetting.signal.required('approval:appr-1')).not.toThrow();
  });

  it('logs a miss once per session when no visible chat view can play', () => {
    const { signal, logs } = harness({ play: () => undefined });
    signal.required('approval:appr-1');
    signal.required('approval:appr-2');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('no visible UnodeAi chat view could play it');
    expect(logs[0]).toContain('typed or clicked');
  });

  it('logs a failed playback report once, ignores a report for an id it did not issue, and a started one is silent', () => {
    const { signal, played, logs } = harness();
    signal.noteResult({ id: 'forged', audioState: 'suspended', started: false, surface: 'workbench' });
    expect(logs).toEqual([]);
    signal.required('approval:appr-1');
    signal.noteResult({ id: played[0], audioState: 'running', started: true, surface: 'workbench' });
    expect(logs).toEqual([]);
    signal.required('approval:appr-2');
    signal.noteResult({ id: played[1], audioState: 'suspended', started: false, surface: 'sidebar' });
    signal.required('approval:appr-3');
    signal.noteResult({ id: played[2], audioState: 'suspended', started: false, surface: 'sidebar' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('the sidebar chat view reported suspended');
  });

  it('logs a missing report after the deadline, and a report that arrives later is ignored', () => {
    vi.useFakeTimers();
    const { signal, played, logs } = harness();
    signal.required('approval:appr-1');
    vi.advanceTimersByTime(1_000);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('did not report playing it');
    signal.noteResult({ id: played[0], audioState: 'suspended', started: false, surface: 'workbench' });
    expect(logs).toHaveLength(1);
  });

  it('keeps a bounded memory of recent keys', () => {
    const { signal, played } = harness();
    signal.required('first');
    for (let index = 0; index < ATTENTION_RECENT_KEYS; index += 1) signal.required(`key-${index}`);
    signal.required('first');
    expect(played).toHaveLength(ATTENTION_RECENT_KEYS + 2);
  });
});

describe('blockingPrompt', () => {
  it('sounds as the prompt appears, before it is answered, and returns the answer unchanged', async () => {
    const { signal, played } = harness();
    installAttentionSignal(signal);
    const order: string[] = [];
    const answer = await blockingPrompt('model-egress:1', () => {
      order.push(`shown after ${played.length} sound(s)`);
      return Promise.resolve('Allow');
    }, untimed);
    expect(answer).toBe('Allow');
    expect(order).toEqual(['shown after 1 sound(s)']);
  });

  it('sounds nothing for a dialog the user opened (no key)', async () => {
    const { signal, played } = harness();
    installAttentionSignal(signal);
    await blockingPrompt(undefined, () => Promise.resolve(undefined), untimed);
    expect(played).toEqual([]);
  });

  it('shows the prompt when no signal is installed', async () => {
    await expect(blockingPrompt('model-egress:1', () => Promise.resolve('Deny'), untimed)).resolves.toBe('Deny');
  });

  it('shows the prompt inside the wait its caller gave it, after sounding, and for no longer', async () => {
    const { signal, played } = harness();
    installAttentionSignal(signal);
    const order: string[] = [];
    const waiting: PromptWait = async (wait) => {
      order.push(`wait opened after ${played.length} sound(s)`);
      try {
        return await wait();
      } finally {
        order.push('wait closed');
      }
    };
    const answer = await blockingPrompt('coordinator-brief:1', () => {
      order.push('shown');
      return Promise.resolve('Send brief');
    }, waiting);
    expect(answer).toBe('Send brief');
    expect(order).toEqual(['wait opened after 1 sound(s)', 'shown', 'wait closed']);

    // A prompt that cannot be shown still closes its wait.
    order.length = 0;
    await expect(blockingPrompt(undefined, () => Promise.reject(new Error('no window')), waiting)).rejects.toThrow('no window');
    expect(order).toEqual(['wait opened after 1 sound(s)', 'wait closed']);
  });

  it('gives every appearance of a prompt without its own coalescing a distinct key', () => {
    expect(attentionAppearance('model-egress')).not.toBe(attentionAppearance('model-egress'));
  });

  it('keys local read scope by root and user-request epoch', () => {
    expect(localReadAttentionKey('C:\\work', 1)).toBe(localReadAttentionKey('C:\\work', 1));
    expect(localReadAttentionKey('C:\\work', 1)).not.toBe(localReadAttentionKey('C:\\work', 2));
  });
});

