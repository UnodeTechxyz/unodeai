import { describe, it, expect } from 'vitest';
import { TokenCounter, estimateTokens, estimateTokensUpper } from '../TokenCounter';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../../contextWindowDefaults';

describe('TokenCounter (P2 context gates)', () => {
  it('estimates tokens at ~4 chars/token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  // Codex, v0.9.29 review. 4 chars/token is an English-ASCII rule. CJK runs ~1–1.5 chars/token, so a flat /4
  // under-counts Chinese by three to four times — and BOTH consumers of this number are one-directional:
  // under-count the context and we blow the model's real window; under-count the cached prefix and we
  // under-report the bill. So it must err UPWARD. Every test above this one used ASCII, which sits exactly on
  // the 4:1 rule and therefore could never have caught it.
  // Two estimators, two biases, on purpose. The context guard wants an accurate number — over-counting THERE
  // forces premature compaction, which rewrites the prompt prefix and costs real money. The cost path wants a
  // cautious one, because under-reporting a bill is worse than over-reporting it. One function cannot serve
  // both, and pretending it could is how an under-count survived three reviews. (Codex, v0.9.29.)
  //
  // Neither is an upper BOUND and neither can be: without the model's own tokenizer the only true bound is
  // one token per character, which would over-report English fourfold and be useless. That is exactly why
  // every number derived from the cautious estimator is FLAGGED as an estimate rather than shown as a bill.
  it('estimates higher for the money path than for the context guard', () => {
    const code = 'const x = foo.bar({ a: 1, b: 2 });'; // dense ASCII tokenizes nearer 3 chars/token, not 4
    expect(estimateTokensUpper(code)).toBeGreaterThan(estimateTokens(code));
    expect(estimateTokensUpper('abcd')).toBe(2);        // vs 1 on the /4 rule
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('prices an image like an image on the money path — 256 tokens was fiction', () => {
    const tc = new TokenCounter();
    const withImage = [{ content: [{ type: 'image_url', image_url: { url: 'data:...' } }] }];
    // A high-detail image runs ~1,100 tokens on OpenAI and up to ~1,600 on Anthropic. Charging 256 for it
    // under-reports the bill every time an image is in the conversation.
    expect(tc.estimateMessagesUpper(withImage)).toBeGreaterThan(1000);
    expect(tc.estimateMessages(withImage)).toBe(256); // the context guard keeps the cheaper figure
  });

  it('does not under-count CJK — the error must lean up, never down', () => {
    const cjk = '这是一段中文'; // 6 characters; a real tokenizer gives ~4–6 tokens, a flat /4 gives 2
    expect(estimateTokens(cjk)).toBeGreaterThanOrEqual(cjk.length);
    expect(estimateTokens(cjk)).toBeGreaterThan(Math.ceil(cjk.length / 4));
    // Mixed text counts each part by its own rule, not by the whole string's length.
    expect(estimateTokens('code: 中文')).toBe(Math.ceil('code: '.length / 4) + 2);
  });

  it('sums message content, ignoring null content', () => {
    const tc = new TokenCounter();
    const tokens = tc.estimateMessages([{ content: 'abcd' }, { content: null }, { content: 'abcdabcd' }]);
    expect(tokens).toBe(1 + 0 + 2);
  });

  it('uses the shared default context window when none is configured', () => {
    expect(new TokenCounter().assess(0).window).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it('flags soft at 70% and hard at 80% of the window', () => {
    const tc = new TokenCounter(1000, 0.7, 0.8);
    expect(tc.assess(600)).toMatchObject({ soft: false, hard: false });
    expect(tc.assess(700)).toMatchObject({ soft: true, hard: false });
    expect(tc.assess(800)).toMatchObject({ soft: true, hard: true });
  });

  it('reports the occupancy ratio', () => {
    const tc = new TokenCounter(1000);
    expect(tc.assess(450).ratio).toBeCloseTo(0.45, 5);
  });

  it('plans soft-limit compaction by dropping the middle while keeping system, anchor, and recent turns', () => {
    const tc = new TokenCounter(1000, 0.7, 0.8);
    const big = 'x'.repeat(1200);
    const messages = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'anchor decision' },
      { role: 'assistant', content: `old answer ${big}` },
      { role: 'user', content: `old task ${big}` },
      { role: 'assistant', content: `old result ${big}` },
      { role: 'user', content: 'recent task' },
      { role: 'assistant', content: 'recent result' },
    ];

    const plan = tc.softLimit(messages);

    expect(plan.triggered).toBe(true);
    expect(plan.keep[0].role).toBe('system');
    expect(plan.keep[1].content).toBe('anchor decision');
    expect(JSON.stringify(plan.keep)).toContain('recent task');
    expect(JSON.stringify(plan.toDrop)).toContain('old answer');
  });

  it('returns an untriggered plan below the soft limit', () => {
    const tc = new TokenCounter(1000, 0.7, 0.8);
    const messages = [{ role: 'system', content: 'small' }, { role: 'user', content: 'short' }];

    expect(tc.softLimit(messages)).toMatchObject({ triggered: false, toDrop: [], keep: messages });
  });
});
