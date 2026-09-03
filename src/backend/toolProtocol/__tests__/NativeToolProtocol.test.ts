import { describe, expect, it } from 'vitest';
import { NativeToolProtocol } from '../NativeToolProtocol';
import { OpenAIStreamReconstructor } from '../../sseParser';

describe('NativeToolProtocol', () => {
  const p = new NativeToolProtocol();

  it('sends native tools and renders no prompt guide', () => {
    expect(p.sendsNativeTools).toBe(true);
    expect(p.renderToolGuide([])).toBe('');
  });

  it('parses structured tool_calls (with arg JSON) into ParsedToolCall[]', () => {
    const calls = p.parseCalls({
      content: null,
      tool_calls: [
        { id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
        { id: 'c2', function: { name: 'run_command', arguments: '{"command":"npm test"}' } },
      ],
    });
    expect(calls).toEqual([
      { id: 'c1', name: 'read_file', args: { path: 'a.ts' } },
      { id: 'c2', name: 'run_command', args: { command: 'npm test' } },
    ]);
  });

  // Absent arguments and BROKEN arguments must not look the same. Treating them alike is what made the
  // backend tell a model that had actually sent arguments that it had "omitted required parameters",
  // so it blind-retried the identical call.
  it('distinguishes absent arguments from unparsable ones', () => {
    const calls = p.parseCalls({
      content: null,
      tool_calls: [
        { id: 'c1', function: { name: 'write_file', arguments: '' } },
        { id: 'c2', function: { name: 'write_file', arguments: 'not json' } },
      ],
    });
    expect(calls[0]).toEqual({ id: 'c1', name: 'write_file', args: {} }); // absent → no parse error
    expect(calls[1].args).toEqual({});
    expect(calls[1].argsParseError).toBeTruthy(); // sent, but broken → say so, don't claim it was omitted
  });

  it('returns [] when there are no tool_calls', () => {
    expect(p.parseCalls({ content: 'just text' })).toEqual([]);
    expect(p.parseCalls({ content: null, tool_calls: [] })).toEqual([]);
  });

  it('recovers a tool call leaked into content when tool_calls is absent (DeepSeek)', () => {
    const D = '<｜｜DSML｜｜';
    const content = `${D}invoke name="read_file">${D}parameter name="path" string="true">a.ts${D}/parameter>${D}/invoke>`;
    const calls = p.parseCalls({ content });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'read_file', args: { path: 'a.ts' } });
    expect(calls[0].id).toMatch(/^recovered-/);
  });

  it('recovers a FLAT-XML call leaked into content when given specs (reasoning-model stall fix)', () => {
    const readSpec = { type: 'function' as const, function: { name: 'read_file', description: '', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' } }, required: ['path'] } } };
    const withSpecs = new NativeToolProtocol([readSpec]);
    const calls = withSpecs.parseCalls({ content: 'Let me look.</think>\n<read_file>\n<path>src/x.ts</path>\n<offset>10</offset>\n</read_file>' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'read_file', args: { path: 'src/x.ts', offset: 10 } });
    expect(calls[0].id).toMatch(/^recovered-/);
  });

  it('does NOT recover flat XML without specs (no tool names to match) — avoids false positives', () => {
    expect(p.parseCalls({ content: '<read_file><path>a.ts</path></read_file>' })).toEqual([]);
  });

  it('formats a result as a role:tool message keyed by call id', () => {
    expect(p.formatResult({ id: 'c1', name: 'read_file', args: {} }, 'file body')).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'file body',
    });
  });

  it('formats a RECOVERED call result as a user message (no orphaned role:tool)', () => {
    // A recovered call has no assistant tool_calls entry, so a native role:'tool' result would be an
    // orphan that strict OpenAI APIs reject. It must come back as a user message.
    const out = p.formatResult({ id: 'recovered-1', name: 'read_file', args: {}, recovered: true }, 'file body');
    expect(out.role).toBe('user');
    expect(out.tool_call_id).toBeUndefined();
    expect(out.content).toContain('[Tool result: read_file]');
    expect(out.content).toContain('file body');
  });
});

// Regression: a Claude/DeepSeek turn on the Unode gateway looped on `write_file` with `Input {}` and
// "missing required parameter(s): path, content". The model HAD sent the arguments — the gateway delivered
// them as a JSON object, `'' + {}` produced "[object Object]", JSON.parse threw, and the failure collapsed
// to `{}`. The corrective message the model then received was false, so it retried the identical call.
describe('native tool_calls: arguments shapes that real gateways send', () => {
  const call = (args: unknown) => ({
    role: 'assistant' as const,
    content: null,
    tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'write_file', arguments: args as any } }],
  });

  it('parses the spec-compliant JSON string', () => {
    const [parsed] = new NativeToolProtocol().parseCalls(call('{"path":"a.txt","content":"hi"}'));
    expect(parsed.args).toEqual({ path: 'a.txt', content: 'hi' });
    expect(parsed.argsParseError).toBeUndefined();
  });

  it('accepts an already-parsed OBJECT instead of losing the arguments', () => {
    const [parsed] = new NativeToolProtocol().parseCalls(call({ path: 'a.txt', content: 'hi' }));
    expect(parsed.args).toEqual({ path: 'a.txt', content: 'hi' }); // was {} before the fix
    expect(parsed.argsParseError).toBeUndefined();
  });

  it('reports a parse error for truncated JSON instead of pretending the model sent nothing', () => {
    const [parsed] = new NativeToolProtocol().parseCalls(call('{"path":"a.tx'));
    expect(parsed.args).toEqual({});
    expect(parsed.argsParseError).toBeTruthy(); // → "not valid JSON", not "missing required parameters"
  });

  it('treats genuinely absent arguments as absent (no parse error)', () => {
    const [parsed] = new NativeToolProtocol().parseCalls(call(''));
    expect(parsed.args).toEqual({});
    expect(parsed.argsParseError).toBeUndefined(); // "missing required parameter(s)" IS the right message here
  });
});

// Regression: a large `write_file` on the Unode gateway + DeepSeek looped between
// "invalid tool arguments (JSON)" and the repeat-failure circuit breaker. The arguments were not
// malformed — the model was cut off at its output-token limit part-way through the JSON string.
// The two causes need different advice: "send less" vs "re-send it correctly". `finish_reason` is the
// only signal that distinguishes them, and the streaming path never captured it.
describe('streaming captures finish_reason so truncation is distinguishable from bad JSON', () => {
  it('surfaces finish_reason=length when the model is cut off mid tool call', () => {
    const p = new OpenAIStreamReconstructor();
    p.accept({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"P.md","content":"# Big' } }] } }] });
    p.accept({ choices: [{ delta: {}, finish_reason: 'length' }] });

    const result = p.result();
    expect(result.choices[0].finish_reason).toBe('length');

    const [call] = new NativeToolProtocol().parseCalls(result.choices[0].message as any);
    expect(call.argsParseError).toBeTruthy(); // truncated JSON does not parse…
    // …and finish_reason tells the backend to say "send less", not "re-send it correctly".
  });

  it('reports finish_reason=tool_calls for genuinely malformed arguments', () => {
    const p = new OpenAIStreamReconstructor();
    p.accept({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: 'not json' } }] } }] });
    p.accept({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });

    const result = p.result();
    expect(result.choices[0].finish_reason).toBe('tool_calls'); // not a truncation
  });

  it('still concatenates streamed argument fragments into valid JSON', () => {
    const p = new OpenAIStreamReconstructor();
    p.accept({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a",' } }] } }] });
    p.accept({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"hi"}' } }] } }] });
    p.accept({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });

    const [call] = new NativeToolProtocol().parseCalls(p.result().choices[0].message as any);
    expect(call.args).toEqual({ path: 'a', content: 'hi' });
    expect(call.argsParseError).toBeUndefined();
  });
});
