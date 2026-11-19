import { describe, expect, it } from 'vitest';
import { recoverLeakedToolCalls, stripToolCallMarkup } from '../leakedToolCalls';

// Build the leak markup from pieces so the test source itself contains no literal close tags that a
// tool-call parser might choke on. `D`/`Dc` are the DeepSeek DSML open/close token wrappers actually
// observed in leaks: opens are `<｜｜DSML｜｜tag …>`, closes are `</｜｜DSML｜｜tag>`.
const D = '<｜｜DSML｜｜';
const Dc = '</｜｜DSML｜｜';
const invokeOpen = (name: string) => `${D}invoke name="${name}">`;
const invokeClose = `${Dc}invoke>`;
const param = (name: string, value: string) => `${D}parameter name="${name}" string="true">${value}${Dc}parameter>`;

describe('recoverLeakedToolCalls', () => {
  it('returns [] for ordinary text with no leaked call', () => {
    expect(recoverLeakedToolCalls('just a normal answer')).toEqual([]);
    expect(recoverLeakedToolCalls('')).toEqual([]);
  });

  // GLM-5.2 / Qwen / Hermes format: `<tool_call>{json}</tool_call>` — the bug that stalled the GLM dev.
  it('recovers a GLM/Qwen <tool_call>{json} call with a nested arguments object', () => {
    const content = 'Sure, running it now.\n<tool_call>\n{"name": "run_command", "arguments": {"command": "npm test"}}\n</tool_call>';
    expect(recoverLeakedToolCalls(content)).toEqual([{ name: 'run_command', args: { command: 'npm test' } }]);
  });

  it('recovers a <tool_call> call whose arguments are a JSON string', () => {
    const content = '<tool_call>{"name": "read_file", "arguments": "{\\"path\\": \\"a.ts\\"}"}</tool_call>';
    expect(recoverLeakedToolCalls(content)).toEqual([{ name: 'read_file', args: { path: 'a.ts' } }]);
  });

  it('recovers multiple <tool_call> blocks and ignores a truncated/invalid one', () => {
    const content =
      '<tool_call>{"name":"list_dir","arguments":{"path":"."}}</tool_call>' +
      '<tool_call>{"name":"read_file","arguments":{"path":"b.ts"}}</tool_call>' +
      '<tool_call>{"name":"broken", "arg'; // truncated, no close tag / bad JSON
    expect(recoverLeakedToolCalls(content)).toEqual([
      { name: 'list_dir', args: { path: '.' } },
      { name: 'read_file', args: { path: 'b.ts' } },
    ]);
  });

  it('strips a leaked <tool_call> block from the visible transcript', () => {
    const content = 'On it.\n<tool_call>{"name":"run_command","arguments":{"command":"ls"}}</tool_call>';
    expect(stripToolCallMarkup(content)).toBe('On it.');
  });

  it('recovers a DeepSeek read_file call leaked into content', () => {
    const content = `${D}tool_calls> ${invokeOpen('read_file')} ${param('path', 'src/backend/CommandApprovalPrompter.ts')} ${invokeClose} ${Dc}tool_calls>`;
    expect(recoverLeakedToolCalls(content)).toEqual([
      { name: 'read_file', args: { path: 'src/backend/CommandApprovalPrompter.ts' } },
    ]);
  });

  it('recovers a multi-parameter write_file with multiline content (outer newlines trimmed)', () => {
    const content = invokeOpen('write_file') + param('path', '_x/report.md') + param('content', '\n# Title\nline two\n') + invokeClose;
    expect(recoverLeakedToolCalls(content)).toEqual([
      { name: 'write_file', args: { path: '_x/report.md', content: '# Title\nline two' } },
    ]);
  });

  it('recovers a real DeepSeek multi-call leak (update_todos + read_file with limit)', () => {
    const content =
      `${D}tool_calls> ${invokeOpen('update_todos')} ` +
      `${D}parameter name="todos" string="false">[{"content":"a","status":"in_progress"}]${Dc}parameter> ${invokeClose} ` +
      `${invokeOpen('read_file')} ${param('path', 'src/backend/CommandApprovalPrompter.ts')} ` +
      `${D}parameter name="limit" string="false">30${Dc}parameter> ${invokeClose} ${Dc}tool_calls>`;
    const calls = recoverLeakedToolCalls(content);
    expect(calls.map((c) => c.name)).toEqual(['update_todos', 'read_file']);
    expect(calls[1].args).toEqual({ path: 'src/backend/CommandApprovalPrompter.ts', limit: '30' });
    expect(calls[0].args.todos).toContain('in_progress');
  });

  it('recovers multiple leaked calls in one message', () => {
    const content =
      invokeOpen('read_file') + param('path', 'a.ts') + invokeClose +
      invokeOpen('read_file') + param('path', 'b.ts') + invokeClose;
    expect(recoverLeakedToolCalls(content)).toEqual([
      { name: 'read_file', args: { path: 'a.ts' } },
      { name: 'read_file', args: { path: 'b.ts' } },
    ]);
  });
});

describe('recoverLeakedToolCalls — Kimi/Moonshot token format', () => {
  it('recovers a leaked Kimi assign_task call with proper (JSON-typed) args', () => {
    const content =
      'OK, 我重新派发。' +
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.assign_task:7<|tool_call_argument_begin|>' +
      '{"agent": "senior-dev", "instruction": "create stringutils.js"}' +
      '<|tool_call_end|><|tool_calls_section_end|>';
    expect(recoverLeakedToolCalls(content)).toEqual([
      { name: 'assign_task', args: { agent: 'senior-dev', instruction: 'create stringutils.js' } },
    ]);
  });

  it('recovers a Kimi update_todos with a real array (not a string) — fixes empty-Plan', () => {
    const content =
      '<|tool_call_begin|>functions.update_todos:1<|tool_call_argument_begin|>' +
      '{"todos":[{"content":"step 1","status":"in_progress"}]}<|tool_call_end|>';
    const calls = recoverLeakedToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('update_todos');
    expect(calls[0].args.todos).toEqual([{ content: 'step 1', status: 'in_progress' }]);
  });
});

describe('stripToolCallMarkup', () => {
  it('removes a leaked DSML tool_calls block, keeping surrounding prose', () => {
    const content = `Let me read that file.\n${D}tool_calls> ${invokeOpen('read_file')} ${param('path', 'a.ts')} ${invokeClose} ${Dc}tool_calls>`;
    expect(stripToolCallMarkup(content)).toBe('Let me read that file.');
  });

  it('removes an XML <use_tool> block', () => {
    const content = 'Working on it.\n<use_tool>\n<tool>write_file</tool>\n<path>a.ts</path>\n</use_tool>';
    expect(stripToolCallMarkup(content)).toBe('Working on it.');
  });

  it('removes a leaked Kimi tool-call token block', () => {
    const content =
      '明白了，我重新派发。' +
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.assign_task:7<|tool_call_argument_begin|>{"agent":"x"}<|tool_call_end|><|tool_calls_section_end|>';
    expect(stripToolCallMarkup(content)).toBe('明白了，我重新派发。');
  });

  it('leaves ordinary prose untouched', () => {
    expect(stripToolCallMarkup('just a normal answer')).toBe('just a normal answer');
  });
});
