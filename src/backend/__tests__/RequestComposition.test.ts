import { describe, expect, it } from 'vitest';
import { TokenCounter, estimateTokens } from '../TokenCounter';
import { WorkspaceTools } from '../WorkspaceTools';
import { TeamTools, type TeamView } from '../TeamTools';
import { MessageBus } from '../../bus/MessageBus';
import { HOST_WORKSPACE_TOOL_NAMES, HOST_TEAM_TOOL_NAMES } from '../HostToolNames';
import {
  COMPOSITION_CATEGORIES, COMPOSITION_ESTIMATOR, compositionToolLabel, formatCompositionUsage, formatRequestComposition,
  projectHostSubmitComposition, projectProviderComposition,
} from '../RequestComposition';
import type { CompositionCoordinates, CompositionSpan, MessageCompositionSource, RequestComposition } from '../RequestComposition';

const coordinates: CompositionCoordinates = { session: '12345678-1234-1234-1234-123456789abc', turn: 2, attempt: 3, route: 'openai-compatible' };
const nativeCall = (id: string, name: string, args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });
const measured = (body: object, sources?: ReadonlyMap<number, MessageCompositionSource>) => {
  const result = projectProviderComposition(body, Buffer.byteLength(JSON.stringify(body)), sources);
  expect(result).toBeDefined();
  return result!;
};
const lineObject = (line: string) => JSON.parse(line.slice('[request-composition] '.length));
const categorySum = (value: Record<string, unknown>) => COMPOSITION_CATEGORIES.reduce((n, key) => n + Number(value[key]), 0);

describe('request-composition numeric core (not egress wiring)', () => {
  it('uses the real closed routing vocabulary and every offered tool name, never provider-supplied labels', () => {
    const workspace = new WorkspaceTools(process.cwd(), new Set(['read', 'write', 'execute', 'message']));
    const team = new TeamTools('pm', { list: () => [] } as unknown as TeamView, new MessageBus());
    const offered = [...workspace.specs(), ...team.specs()];
    workspace.setEditToolDialect('apply-patch'); offered.push(...workspace.specs());
    expect(offered.length).toBeGreaterThan(20);
    for (const spec of offered) expect(compositionToolLabel(spec.function.name)).toBe(spec.function.name);
    for (const name of [...HOST_WORKSPACE_TOOL_NAMES, ...HOST_TEAM_TOOL_NAMES]) expect(compositionToolLabel(name)).toBe(name);
    for (const name of ['execute_command', 'edit_file', 'list_files', 'delegate_task', 'accept_task', 'reject_task', 'private-name']) {
      expect(compositionToolLabel(name)).toBe('unknown-tool');
    }
    expect(compositionToolLabel('mcp__private-name')).toBe('external-tool');
    const result = measured({ messages: [{ role: 'assistant', tool_calls: [nativeCall('cmd', 'run_command')] },
      { role: 'tool', tool_call_id: 'cmd', content: 'x'.repeat(40_000) }] });
    expect(result.largest_tool_result).toEqual({ tool: 'run_command', estimated_tokens: 10_000 });
  });
  it('allows partial installed facts without inventing the CLI tools the host did not install', () => {
    expect(projectHostSubmitComposition({ wirePacket: '{}', texts: [], imageCount: 0, installed: { system: 9 } }))
      .toMatchObject({ installed_system_estimate: 9, installed_tools_estimate: 'not-observable', host_observed_total: 0 });
  });

  it('formats later usage using only validated numbers and the same host coordinates, never arbitrary properties', () => {
    const input = { inputTokens: 100, outputTokens: 3, cachedInputTokens: 20, private: 'SECRET', toJSON: () => 'SECRET' };
    const line = formatCompositionUsage(coordinates, input, 'request');
    expect(JSON.parse(line.slice('[request-usage] '.length))).toEqual({ session: coordinates.session, turn: 2, attempt: 3,
      route: 'openai-compatible', usage_scope: 'request', reported_input_tokens: 100, output_tokens: 3, cached_input_tokens: 20 });
    expect(line).not.toContain('SECRET');
    const turn = formatCompositionUsage({ ...coordinates, route: 'codex' }, input, 'turn');
    expect(turn).toContain('"attempt":"not-observable"');
    for (const bad of [{ ...input, inputTokens: -1 }, { ...input, outputTokens: Infinity }, { ...input, cachedInputTokens: 101 }]) {
      expect(formatCompositionUsage(coordinates, bad, 'request')).toBe('[request-usage] {"status":"measurement-unavailable"}');
    }
    expect(formatCompositionUsage(coordinates, input, 'turn')).toContain('measurement-unavailable');
    expect(formatCompositionUsage({ ...coordinates, route: 'claude' }, input, 'request')).toContain('measurement-unavailable');
    expect(formatCompositionUsage({ ...coordinates, session: 'SECRET' }, input, 'request')).toContain('measurement-unavailable');
    expect(formatCompositionUsage(coordinates, input, 'SECRET' as 'request')).not.toContain('SECRET');
  });

  it('measures final multilingual payload, reasoning, call arguments, schemas, images and trusted source ranges with the existing estimator', () => {
    const input = '用户问题';
    const attached = '\n附件內容';
    const messages = [
      { role: 'system', content: 'System contract' },
      { role: 'assistant', content: null, reasoning_content: '思考过程', tool_calls: [nativeCall('private-call-id', 'read_file', '{"path":"private.txt"}')] },
      { role: 'tool', tool_call_id: 'private-call-id', content: '中'.repeat(1000) },
      { role: 'user', content: [{ type: 'text', text: input + attached }, { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRET' } }] },
      { role: 'system', content: 'Volatile team state' },
    ];
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read the file', parameters: {} } }];
    const sources = new Map<number, MessageCompositionSource>([
      [1, { history: true }], [2, { history: true }],
      [3, { history: false, parts: new Map([[0, [
        { start: 0, end: input.length, category: 'turn_input' },
        { start: input.length, end: input.length + attached.length, category: 'attachments' },
      ]]]) }],
      [4, { text: [{ start: 0, end: messages[4].content!.length, category: 'host_context' }] }],
    ]);
    const result = measured({ messages, tools, stream: true, max_tokens: 1000, model: 'private-model' }, sources);
    expect(result.total).toBe(new TokenCounter().estimateMessages(messages) + estimateTokens(JSON.stringify(tools)));
    expect(categorySum(result)).toBe(result.total);
    expect(result).toMatchObject({ file_reads: 1000, history_tool_results: 1000, history_message_count: 2,
      unknown_tool_result_tokens: 0, largest_tool_result: { tool: 'read_file', estimated_tokens: 1000 }, attribution: 'complete',
      reported_input_tokens: 'not-yet-reported' });
    expect(result.tools).toBe(estimateTokens(JSON.stringify(tools)));
    expect(result.history_text).toBe(estimateTokens('思考过程') + estimateTokens(JSON.stringify(messages[1].tool_calls)));
    expect(result.attachments).toBeGreaterThan(256);
    expect(result.host_context).toBe(estimateTokens('Volatile team state'));
    expect(result.turn_input).toBeGreaterThan(0);
    expect(result.body_utf8_bytes).toBe(Buffer.byteLength(JSON.stringify({ messages, tools, stream: true, max_tokens: 1000, model: 'private-model' })));
  });

  it('allocates mixed-source string rounding exactly, including deterministic ties and non-ASCII UTF-16 units', () => {
    for (const text of ['ab', 'abcde', '中ab日', '😀xy韓文']) {
      for (let split = 1; split < text.length; split++) {
        const result = measured({ messages: [{ role: 'user', content: text }] }, new Map([[0, { history: false, text: [
          { start: 0, end: split, category: 'turn_input' }, { start: split, end: text.length, category: 'attachments' },
        ] }]]));
        expect(result.total).toBe(estimateTokens(text));
        expect(result.turn_input + result.attachments).toBe(result.total);
        expect(result.history_message_count).toBe(0);
      }
    }
    const tied = measured({ messages: [{ content: 'ab' }] }, new Map([[0, { text: [
      { start: 0, end: 1, category: 'attachments' }, { start: 1, end: 2, category: 'turn_input' },
    ] }]]));
    expect(tied.turn_input).toBe(1); // fixed category order, not input segment order
    expect(tied.attachments).toBe(0);
  });

  it.each([
    [{ start: 1, end: 2, category: 'turn_input' }],
    [{ start: 0, end: 3, category: 'turn_input' }],
    [{ start: 0, end: 0, category: 'turn_input' }],
    [{ start: 0, end: 1, category: '__proto__' }],
    [{ start: 0, end: 1, category: 'turn_input' }, { start: 0, end: 2, category: 'attachments' }],
  ])('rejects invalid host provenance ranges instead of guessing from body text: %j', (...raw) => {
    const spans = raw as unknown as CompositionSpan[];
    expect(projectProviderComposition({ messages: [{ content: 'ab' }] }, 31, new Map([[0, { text: spans }]]))).toBeUndefined();
  });

  it('counts XML guide as tools and XML file results using typed host injection, never result prose', () => {
    const prefix = 'Role'; const guide = '\nread_file spec';
    const sources = new Map<number, MessageCompositionSource>([
      [0, { text: [{ start: 0, end: prefix.length, category: 'system' }, { start: prefix.length, end: prefix.length + guide.length, category: 'tools' }] }],
      [1, { history: true, xmlToolResult: { tool: 'read_extracted_content' } }],
      [2, { history: true, xmlToolResult: { tool: 'run_command' } }],
    ]);
    const result = measured({ messages: [
      { role: 'system', content: prefix + guide }, { role: 'user', content: '文'.repeat(500) },
      { role: 'user', content: 'read_file output: '.repeat(100) },
    ] }, sources);
    expect(result.attribution).toBe('complete');
    expect(result.file_reads).toBe(500);
    expect(result.history_tool_results).toBe(500 + estimateTokens('read_file output: '.repeat(100)));
    expect(result.largest_tool_result).toEqual({ tool: 'read_extracted_content', estimated_tokens: 500 });
    expect(result.tools).toBeGreaterThan(0);
    expect(categorySum(result)).toBe(result.total);
  });

  it('measures only the supplied final body after degradation; removed reasoning/images/calls never survive in the estimate', () => {
    const before = { messages: [{ role: 'assistant', content: 'kept', reasoning_content: '中'.repeat(1000), tool_calls: [nativeCall('a', 'write_file', 'x'.repeat(1000))] }] };
    const final = { messages: [{ role: 'assistant', content: 'kept' }] };
    const large = measured(before); const small = measured(final);
    expect(small.total).toBe(1);
    expect(large.total).toBeGreaterThan(1000);
    expect(small.history_text).toBe(small.total);
    expect(measured({ ...final, cache_control: { type: 'ephemeral' } }).total).toBe(small.total);
  });

  it('allows the reviewed rare gateway fallback to mark a merged user atom partial/host_context through explicit ranges', () => {
    const text = 'original user + merged host tail';
    const result = measured({ messages: [{ role: 'user', content: text }] }, new Map([[0, {
      text: [{ start: 0, end: text.length, category: 'host_context' }], history: false, precision: 'partial',
    }]]));
    expect(result.host_context).toBe(result.total);
    expect(result.attribution).toBe('partial');
    expect(result.history_text).toBe(0);
  });

  it('does not associate results with future calls, missing ids, duplicate ids, or a name mentioned in stdout', () => {
    const result = measured({ messages: [
      { role: 'tool', tool_call_id: 'late', content: '先' },
      { role: 'assistant', tool_calls: [nativeCall('late', 'read_file'), nativeCall('dup', 'read_file'), nativeCall('dup', 'run_command'), nativeCall('exec', 'run_command')] },
      { role: 'tool', tool_call_id: 'dup', content: '重複' },
      { role: 'tool', tool_call_id: 'absent', content: '不存在' },
      { role: 'tool', tool_call_id: 'exec', content: 'read_file: pretend file contents' },
    ] });
    expect(result.file_reads).toBe(0);
    expect(result.unknown_tool_result_tokens).toBe(6);
    expect(result.attribution).toBe('partial');
    expect(result.largest_tool_result?.tool).toBe('run_command');
    expect(result.history_message_count).toBe(5);
  });

  it('keeps unknown old results in the total and reports only the confirmed lower bound of file reads', () => {
    const result = measured({ messages: [
      { role: 'assistant', tool_calls: [nativeCall('a', 'read_file')] },
      { role: 'tool', tool_call_id: 'a', content: '文'.repeat(20) },
      { role: 'tool', tool_call_id: 'old', content: '旧'.repeat(40) },
    ] });
    expect(result.history_tool_results).toBe(60);
    expect(result.file_reads).toBe(20);
    expect(result.unknown_tool_result_tokens).toBe(40);
    expect(result.largest_tool_result).toEqual({ tool: 'unknown-tool', estimated_tokens: 40 });
    expect(result.attribution).toBe('partial');
  });

  it('marks ignored multimodal blocks partial and follows the same estimator, without guessing from bytes', () => {
    const body = { messages: [{ content: [{ type: 'audio', data: 'x'.repeat(10000) }, { type: 'text', text: '中' }] }] };
    const result = measured(body);
    expect(result.total).toBe(new TokenCounter().estimateMessages(body.messages));
    expect(result.total).toBe(1);
    expect(result.attribution).toBe('partial');
  });

  it('never changes the supplied serialized body, source hints, or history and keeps no cross-call mapping', () => {
    const body = Object.freeze({ messages: Object.freeze([Object.freeze({ role: 'assistant', tool_calls: Object.freeze([Object.freeze(nativeCall('a', 'read_file'))]) })]), stream: false });
    const wire = JSON.stringify(body);
    const source = Object.freeze({ history: true });
    const sources = new Map([[0, source]]);
    projectProviderComposition(body, Buffer.byteLength(wire), sources);
    expect(JSON.stringify(body)).toBe(wire);
    expect(sources.get(0)).toBe(source);
    expect(sources.size).toBe(1);
    const next = measured({ messages: [{ role: 'tool', tool_call_id: 'a', content: 'unknown' }] });
    expect(next.file_reads).toBe(0);
    expect(next.unknown_tool_result_tokens).toBe(estimateTokens('unknown'));
  });

  it('CLI counts only visible host atoms, excludes installed schemas from the sent sum, and never invents internal history or request usage', () => {
    const projected = projectHostSubmitComposition({ wirePacket: 'private packet', texts: [{ text: '用户' }], imageCount: 2, installed: { system: 1000, tools: 2000 } });
    expect(projected).toBeDefined();
    const line = lineObject(formatRequestComposition({ ...coordinates, route: 'codex' }, projected));
    expect(line).toMatchObject({ boundary: 'host-turn-submit', internal_requests: 'not-observable', history_text: 'not-observable',
      file_reads: 'not-observable', reported_input_tokens: 'not-observable', host_observed_total: 514,
      installed_system_estimate: 1000, installed_tools_estimate: 2000 });
    expect(categorySum(line.host_observed)).toBe(514);
    expect(line).not.toHaveProperty('total');
    expect(projectHostSubmitComposition({ wirePacket: '', texts: [], imageCount: 0 })?.installed_tools_estimate).toBe('not-observable');
  });

  it('CLI host role text and inline attachment ranges use the same allocation as HTTP, not base64 length', () => {
    const projected = projectHostSubmitComposition({ wirePacket: 'data:image/png;base64,' + 'x'.repeat(10000), imageCount: 1,
      texts: [{ text: 'role问题附件', spans: [
        { start: 0, end: 4, category: 'system' }, { start: 4, end: 6, category: 'turn_input' }, { start: 6, end: 8, category: 'attachments' },
      ] }] });
    expect(projected?.host_observed).toMatchObject({ system: 1, turn_input: 2, attachments: 258 });
    expect(projected?.host_observed_total).toBe(261);
    expect(projected?.body_utf8_bytes).toBeGreaterThan(10000);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects impossible CLI image counts or overflow: %s', imageCount => {
    expect(projectHostSubmitComposition({ wirePacket: '', texts: [], imageCount })).toBeUndefined();
  });

  it('privacy: all canaries and malicious names/extra fields stay out of the fixed line', () => {
    const secret = 'SECRET_https://user:KEY@private.test/C:/private/合同.docx_base64AAA';
    const body = { messages: [
      { role: 'system', content: secret },
      { role: 'assistant', tool_calls: [nativeCall(secret, `mcp__${secret}`, secret)], reasoning_content: secret },
      { role: 'tool', tool_call_id: secret, content: secret.repeat(1000) },
      { role: 'user', content: [{ text: secret }, { image_url: { url: secret } }] },
    ], tools: [{ name: secret, description: secret, schema: { secret } }], model: secret };
    const projection = measured(body);
    const line = formatRequestComposition({ ...coordinates, name: secret } as CompositionCoordinates, {
      ...projection, leak: secret, largest_tool_result: { ...projection.largest_tool_result!, leak: secret },
    } as RequestComposition);
    expect(line).not.toContain(secret);
    for (const privatePart of ['private.test', '合同.docx', 'base64AAA', 'KEY', 'leak']) expect(line).not.toContain(privatePart);
    expect(lineObject(line).largest_tool_result.tool).toBe('external-tool');
    expect(lineObject(line).estimator).toBe(COMPOSITION_ESTIMATOR);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(4096);
    expect(compositionToolLabel('__proto__')).toBe('unknown-tool');
    expect(compositionToolLabel('constructor')).toBe('unknown-tool');
    expect(compositionToolLabel('read_file\nSECRET')).toBe('unknown-tool');
  });

  it('large history yields one fixed-size line without returning any per-message arrays or source text', () => {
    const messages = Array.from({ length: 5000 }, () => ({ role: 'assistant', content: 'a'.repeat(100) }));
    const projection = measured({ messages });
    const line = formatRequestComposition(coordinates, projection);
    expect(line.split('\n')).toHaveLength(1);
    expect(line.length).toBeLessThan(1500);
    expect(lineObject(line).history_message_count).toBe(5000);
    expect(lineObject(line)).not.toHaveProperty('messages');
  });

  it.each([null, {}, { messages: {} }, { messages: [null] }])('invalid final input returns no measurement, never raw diagnostics: %j', body => {
    expect(projectProviderComposition(body, 0)).toBeUndefined();
    expect(formatRequestComposition(coordinates, projectProviderComposition(body, 0))).toBe('[request-composition] {"status":"measurement-unavailable"}');
  });

  it('formatter refuses unsafe identity, routes, numbers, category sums and labels, even from unchecked callers', () => {
    const projection = measured({ messages: [{ content: 'abcd' }] });
    const bad = [
      { ...projection, total: 99 }, { ...projection, file_reads: 1 }, { ...projection, history_message_count: -1 },
      { ...projection, largest_tool_result: { tool: 'SECRET', estimated_tokens: 0 } },
      { ...projection, history_text: Number.MAX_SAFE_INTEGER + 1 }, { ...projection, attribution: 'SECRET' },
    ];
    for (const raw of bad) expect(formatRequestComposition(coordinates, raw as RequestComposition)).toContain('measurement-unavailable');
    for (const raw of [
      { ...coordinates, session: 'SECRET' }, { ...coordinates, turn: 0 }, { ...coordinates, attempt: Infinity }, { ...coordinates, route: 'SECRET' },
      { ...coordinates, session: { toString: () => coordinates.session, toJSON: () => 'SECRET' } },
    ]) expect(formatRequestComposition(raw as CompositionCoordinates, projection)).toContain('measurement-unavailable');
    expect(formatRequestComposition({ ...coordinates, route: 'claude' }, projection)).toContain('measurement-unavailable');
    const host = projectHostSubmitComposition({ wirePacket: '', texts: [], imageCount: 0 });
    expect(formatRequestComposition(coordinates, host)).toContain('measurement-unavailable');
  });

  it('formatter never serializes a caller error or invokes its toJSON and rebuilds reported usage from fixed semantics', () => {
    const projection = measured({ messages: [] });
    const raw = { ...projection, reported_input_tokens: 170000, toJSON: () => { throw new Error('SECRET'); } };
    expect(lineObject(formatRequestComposition(coordinates, raw as unknown as RequestComposition)).reported_input_tokens).toBe('not-yet-reported');
    const hostile = Object.defineProperty({}, 'boundary', { get: () => { throw new Error('SECRET'); } });
    expect(formatRequestComposition(coordinates, hostile as RequestComposition)).toBe('[request-composition] {"status":"measurement-unavailable"}');
  });
});

describe('history text by source and the read projection numbers (v0.9.99)', () => {
  const readNumbers = { projection_revision: 2, watermark_index: 5, history_tool_results_referenced: 900, referenced_result_count: 3, new_eligible_savings_tokens: 41_000 };
  const body = {
    messages: [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'u'.repeat(400) },
      { role: 'assistant', content: 'a'.repeat(200), reasoning_content: 'r'.repeat(40), tool_calls: [nativeCall('c1', 'read_file', '{"path":"x"}')] },
      { role: 'tool', tool_call_id: 'c1', content: 'file text' },
      { role: 'user', content: 'd'.repeat(800) },
      { role: 'user', content: 'n'.repeat(80) },
      { role: 'user', content: 'now' },
    ],
  };
  const sources = new Map<number, MessageCompositionSource>([
    [0, { history: false }],
    [1, { history: true, precision: 'partial', historySource: 'user' }],
    [2, { history: true }],
    [3, { history: true }],
    [4, { history: true, precision: 'partial', historySource: 'delegation-result' }],
    [5, { history: true, precision: 'partial' }],
    [6, { history: false, text: [{ start: 0, end: 3, category: 'turn_input' }] }],
  ]);

  it('partitions history text by the host-recorded author and sums to history text exactly', () => {
    const result = projectProviderComposition(body, 1_000, sources, readNumbers)!;
    expect(result.history_text_by_source).toEqual({
      user: estimateTokens('u'.repeat(400)),
      assistant: estimateTokens('a'.repeat(200)) + estimateTokens('r'.repeat(40)) + estimateTokens(JSON.stringify(body.messages[2].tool_calls)),
      'delegation-result': estimateTokens('d'.repeat(800)),
      // A host notice in user role, with no recorded author, is never guessed to be the person.
      other: estimateTokens('n'.repeat(80)),
    });
    const parts = Object.values(result.history_text_by_source).reduce((a, b) => a + b, 0);
    expect(parts).toBe(result.history_text);
    expect(result.read_projection).toEqual(readNumbers);
  });

  it('writes the partition and the five numbers into the record, and not-observable without them', () => {
    const line = lineObject(formatRequestComposition(coordinates, projectProviderComposition(body, 1_000, sources, readNumbers)));
    expect(line).toMatchObject({ ...readNumbers, history_text_by_source: { 'delegation-result': estimateTokens('d'.repeat(800)) } });
    const without = lineObject(formatRequestComposition(coordinates, projectProviderComposition(body, 1_000, sources)));
    expect(without).toMatchObject({ projection_revision: 'not-observable', referenced_result_count: 'not-observable' });
    const cli = lineObject(formatRequestComposition({ ...coordinates, route: 'codex' },
      projectHostSubmitComposition({ wirePacket: 'x', texts: [{ text: 'x' }], imageCount: 0 })));
    expect(cli).toMatchObject({ history_text_by_source: 'not-observable', new_eligible_savings_tokens: 'not-observable' });
  });

  it('refuses a partition that does not sum, or read numbers that are not whole', () => {
    const result = projectProviderComposition(body, 1_000, sources, readNumbers)!;
    const skewed = { ...result, history_text_by_source: { ...result.history_text_by_source, other: result.history_text_by_source.other + 1 } };
    expect(formatRequestComposition(coordinates, skewed)).toBe('[request-composition] {"status":"measurement-unavailable"}');
    expect(formatRequestComposition(coordinates, { ...result, read_projection: { ...readNumbers, watermark_index: -1 } }))
      .toBe('[request-composition] {"status":"measurement-unavailable"}');
    expect(projectProviderComposition(body, 1_000, sources, { ...readNumbers, referenced_result_count: 1.5 })).toBeUndefined();
  });
});
