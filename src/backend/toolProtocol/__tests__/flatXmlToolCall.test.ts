import { describe, it, expect } from 'vitest';
import { parseFlatXmlToolCall } from '../flatXmlToolCall';
import type { ToolSpec } from '../../WorkspaceTools';

const spec = (name: string, properties: Record<string, unknown>): ToolSpec => ({
  type: 'function',
  function: { name, description: '', parameters: { type: 'object', properties, required: [] } },
});

const specs: ToolSpec[] = [
  spec('read_file', { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }),
  spec('write_file', { path: { type: 'string' }, content: { type: 'string' } }),
];

describe('parseFlatXmlToolCall', () => {
  it('recovers a flat-XML call leaked after a </think> block (the Kimi stall)', () => {
    const content =
      'I need to find makeWorktreeCoordinator. Let me read around line 1100.\n</think>\n' +
      '<read_file>\n<path>src/extension.ts</path>\n<offset>1100</offset>\n<limit>150</limit>\n</read_file>';
    const call = parseFlatXmlToolCall(content, specs);
    expect(call).toBeTruthy();
    expect(call!.name).toBe('read_file');
    // offset/limit must be NUMBERS (schema-typed), not strings — else read_file ignores them.
    expect(call!.args).toEqual({ path: 'src/extension.ts', offset: 1100, limit: 150 });
  });

  it('keeps a string param a string even when its value is all digits (write_file content)', () => {
    const call = parseFlatXmlToolCall('<write_file><path>a.txt</path><content>123</content></write_file>', specs);
    expect(call!.name).toBe('write_file');
    expect(call!.args.content).toBe('123'); // string, not the number 123
  });

  it('ignores child tags that are not declared params', () => {
    const call = parseFlatXmlToolCall('<read_file><path>a.ts</path><bogus>x</bogus></read_file>', specs);
    expect(call!.args).toEqual({ path: 'a.ts' });
  });

  it('returns undefined when no known-tool block is present (stray tags in prose)', () => {
    expect(parseFlatXmlToolCall('here is some <div>html</div> and <unknown_tool>x</unknown_tool>', specs)).toBeUndefined();
  });

  it('returns undefined for empty content or empty specs', () => {
    expect(parseFlatXmlToolCall('', specs)).toBeUndefined();
    expect(parseFlatXmlToolCall('<read_file><path>a</path></read_file>', [])).toBeUndefined();
  });

  it('picks the earliest tool block when several are present', () => {
    const call = parseFlatXmlToolCall('<write_file><path>a</path><content>x</content></write_file> then <read_file><path>b</path></read_file>', specs);
    expect(call!.name).toBe('write_file');
  });
});
