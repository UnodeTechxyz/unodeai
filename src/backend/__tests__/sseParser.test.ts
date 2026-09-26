import { describe, expect, it } from 'vitest';
import { OpenAIStreamReconstructor, parseSseEvents } from '../sseParser';

async function collect(chunks: Iterable<string | Uint8Array>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of parseSseEvents(chunks)) {
    out.push(event);
  }
  return out;
}

describe('parseSseEvents', () => {
  it('handles chunks split mid-line', async () => {
    const events = await collect([
      'data: {"choices":[{"delta":{"content":"hel',
      'lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    expect(events).toEqual([{ choices: [{ delta: { content: 'hello' } }] }]);
  });

  it('handles multiple events per chunk and stops at DONE', async () => {
    const events = await collect([
      'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\ndata: {"c":3}\n\n',
    ]);

    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('joins multi-line data events', async () => {
    const events = await collect([
      'data: {"text":"hello\\n"\n',
      'data: ,"more":true}\n\n',
    ]);

    expect(events).toEqual([{ text: 'hello\n', more: true }]);
  });

  it('decodes Uint8Array chunks', async () => {
    const encoder = new TextEncoder();
    const events = await collect([
      encoder.encode('data: {"ok":true}\n\n'),
      encoder.encode('data: [DONE]\n\n'),
    ]);

    expect(events).toEqual([{ ok: true }]);
  });
});

describe('OpenAIStreamReconstructor', () => {
  it('reconstructs content-only streams and usage', () => {
    const r = new OpenAIStreamReconstructor();

    expect(r.accept({ choices: [{ delta: { content: 'Hel' } }] })).toEqual({ delta: 'Hel' });
    expect(r.accept({ choices: [{ delta: { content: 'lo' } }] })).toEqual({ delta: 'lo' });
    r.accept({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });

    expect(r.result()).toEqual({
      choices: [{ message: { role: 'assistant', content: 'Hello' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
  });

  it('merges interleaved tool_call deltas by index', () => {
    const r = new OpenAIStreamReconstructor();

    r.accept({
      choices: [{
        delta: {
          tool_calls: [
            { index: 1, id: 'call_b', type: 'function', function: { name: 'write_file', arguments: '{"path":"' } },
            { index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"' } },
          ],
        },
      }],
    });
    r.accept({
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: 'a.txt"}' } },
            { index: 1, function: { arguments: 'b.txt","content":"x"}' } },
          ],
        },
      }],
    });

    expect(r.result().choices[0].message).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'call_b', type: 'function', function: { name: 'write_file', arguments: '{"path":"b.txt","content":"x"}' } },
      ],
    });
  });

  it('reassembles ONE tool call when the gateway omits index on continuation deltas (id on first only)', () => {
    // Regression: a gateway that streams a single tool call WITHOUT `index` on the argument chunks used
    // to split into N bogus calls (the named call left with empty args) — breaking large-argument tools
    // like assign_task while small ones (run_checks) survived. The full arguments must reassemble into one.
    const r = new OpenAIStreamReconstructor();
    r.accept({ choices: [{ delta: { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'assign_task', arguments: '' } }] } }] });
    r.accept({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"agent":"dev",' } }] } }] });
    r.accept({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"instruction":"do it"}' } }] } }] });

    expect(r.result().choices[0].message).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'assign_task', arguments: '{"agent":"dev","instruction":"do it"}' } },
      ],
    });
  });

  it('reassembles one tool call when the gateway omits index but REPEATS the id on every delta', () => {
    const r = new OpenAIStreamReconstructor();
    r.accept({ choices: [{ delta: { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'assign_task', arguments: '{"a":' } }] } }] });
    r.accept({ choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { arguments: '1}' } }] } }] });

    expect(r.result().choices[0].message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'assign_task', arguments: '{"a":1}' } },
    ]);
  });

  it('still separates two parallel index-less tool calls by their distinct ids', () => {
    const r = new OpenAIStreamReconstructor();
    r.accept({ choices: [{ delta: { tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"p":"a"}' } }] } }] });
    r.accept({ choices: [{ delta: { tool_calls: [{ id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"p":"b"}' } }] } }] });

    expect(r.result().choices[0].message.tool_calls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"p":"a"}' } },
      { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"p":"b"}' } },
    ]);
  });

  it('surfaces reasoning_content as a reasoningDelta (live Analysis) and accumulates it for replay', () => {
    const r = new OpenAIStreamReconstructor();

    // reasoning_content deltas are surfaced live (reasoningDelta) — NOT as visible content deltas.
    expect(r.accept({ choices: [{ delta: { reasoning_content: 'Let me ' } }] })).toEqual({ reasoningDelta: 'Let me ' });
    expect(r.accept({ choices: [{ delta: { reasoning_content: 'think.' } }] })).toEqual({ reasoningDelta: 'think.' });
    expect(r.accept({ choices: [{ delta: { content: 'Answer' } }] })).toEqual({ delta: 'Answer' });

    // The reconstructed assistant message still carries reasoning_content so the tool loop can echo it
    // back (some gateways 400 in thinking mode if the prior turn's reasoning_content is dropped).
    expect(r.result().choices[0].message).toEqual({
      role: 'assistant',
      content: 'Answer',
      reasoning_content: 'Let me think.',
    });
  });

  it('returns both content and reasoning when a chunk carries both', () => {
    const r = new OpenAIStreamReconstructor();
    expect(
      r.accept({ choices: [{ delta: { reasoning_content: 'hmm', content: 'Hi' } }] })
    ).toEqual({ delta: 'Hi', reasoningDelta: 'hmm' });
  });
});
