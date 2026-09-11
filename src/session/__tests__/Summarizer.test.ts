import { describe, expect, it } from 'vitest';
import { LlmSummarizer, SummarizerIO } from '../Summarizer';

describe('LlmSummarizer', () => {
  it('summarizes dropped turns with the economy model', async () => {
    const calls: Array<{ messages: Array<{ role: string; content: string }>; model: string }> = [];
    const io: SummarizerIO = {
      chatCompletion: async (messages, model) => {
        calls.push({ messages, model });
        return 'Architecture decision: keep strict TypeScript.';
      },
    };

    const summary = await new LlmSummarizer().summarize(
      io,
      [{ role: 'user', content: 'We agreed to strict TypeScript.' }],
      undefined,
      'cheap-model'
    );

    expect(summary).toBe('Architecture decision: keep strict TypeScript.');
    expect(calls[0].model).toBe('cheap-model');
    expect(calls[0].messages[0].role).toBe('system');
    expect(calls[0].messages[1].content).toContain('We agreed to strict TypeScript.');
  });

  it('appends new summaries to an existing rolling summary', async () => {
    const io: SummarizerIO = {
      chatCompletion: async (messages) => {
        expect(messages[1].content).toContain('Previous summary:\nOld decision.');
        return 'New error: build failed in src/app.ts.';
      },
    };

    await expect(
      new LlmSummarizer().summarize(
        io,
        [{ role: 'assistant', content: 'Build failed in src/app.ts.' }],
        'Old decision.',
        'cheap-model'
      )
    ).resolves.toBe('Old decision.\n---\nNew error: build failed in src/app.ts.');
  });

  it('does not call the model when there are no new turns to summarize', async () => {
    let called = false;
    const io: SummarizerIO = {
      chatCompletion: async () => {
        called = true;
        return 'unused';
      },
    };

    const summary = await new LlmSummarizer().summarize(io, [], 'Existing.', 'cheap-model');

    expect(summary).toBe('Existing.');
    expect(called).toBe(false);
  });
});
