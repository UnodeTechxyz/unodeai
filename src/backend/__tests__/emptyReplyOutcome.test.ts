import { describe, expect, it } from 'vitest';
import { describeEmptyReply, emptyReplyNotice, emptyReplyReason, parseResponseOutcome } from '../emptyReplyOutcome';

const attempt = (fields: Record<string, unknown> = {}) => ({
  attempt: 1, gateway: 'openrouter', inputBasis: 'reported', inputTokens: 246_668, outputTokens: 16, finishSignal: 'stop', ...fields,
});

describe('empty-reply outcome wording (v0.9.90 §7.3)', () => {
  it('states the attempts, the last input size and its basis, and the upstream provider, as facts', () => {
    const attempts = parseResponseOutcome({ kind: 'empty-reply', attempts: [attempt(), attempt({ attempt: 2 })] });
    expect(attempts?.kind).toBe('empty-reply');
    const list = attempts!.kind === 'empty-reply' ? attempts!.attempts : [];
    expect(emptyReplyNotice(list)).toBe('UnodeAi: The model returned an empty reply after 2 attempts. The last attempt used '
      + 'about 246,668 input tokens (provider-reported); no text or tool call was received. Upstream provider: unavailable.');
    expect(emptyReplyReason(list)).toBe('the model returned an empty reply at about 246,668 input tokens');
    expect(describeEmptyReply([attempt({ inputBasis: 'reconstructed', upstreamProvider: 'DeepInfra' }) as any]))
      .toBe('The model returned an empty reply after 1 attempt. The last attempt used about 246,668 input tokens (estimated); '
        + 'no text or tool call was received. Upstream provider: DeepInfra.');
  });

  it('shows a restored provider name as plain text, whatever was stored', () => {
    const restored = parseResponseOutcome({ kind: 'empty-reply', attempts: [attempt({ upstreamProvider: '[Deep\u202EInfra](https://evil.example)' })] });
    const list = restored!.kind === 'empty-reply' ? restored!.attempts : [];
    expect(list[0].upstreamProvider).toBe('DeepInfrahttps//evil.example');
    expect(describeEmptyReply(list)).toMatch(/Upstream provider: DeepInfrahttps\/\/evil\.example\.$/);
    expect(describeEmptyReply(list).split('Upstream provider: ')[1]).not.toMatch(/[[\]()\u202E]/);
  });

  it('never states a size the route did not report', () => {
    const unreported = [attempt({ inputBasis: 'unavailable', inputTokens: undefined }) as any];
    expect(describeEmptyReply(unreported)).toContain('The last attempt\'s input size was not reported;');
    expect(emptyReplyReason(unreported)).toBe('the model returned an empty reply');
  });

  it('parses restored metadata defensively: legacy and malformed values are absent, bad attempts are dropped', () => {
    expect(parseResponseOutcome(undefined)).toBeUndefined();
    expect(parseResponseOutcome({ kind: 'reply' })).toEqual({ kind: 'reply' });
    expect(parseResponseOutcome({ kind: 'empty-reply', attempts: [] })).toBeUndefined();
    expect(parseResponseOutcome({ kind: 'something-new' })).toBeUndefined();
    const parsed = parseResponseOutcome({
      kind: 'empty-reply',
      attempts: [attempt({ inputTokens: -1, responseId: 'x'.repeat(500) }), { attempt: 2, gateway: '', inputBasis: 'reported' }],
    });
    expect(parsed).toEqual({ kind: 'empty-reply', attempts: [{ ...attempt(), inputTokens: undefined, responseId: 'x'.repeat(200) }].map(({ inputTokens, ...rest }) => rest) });
  });
});
