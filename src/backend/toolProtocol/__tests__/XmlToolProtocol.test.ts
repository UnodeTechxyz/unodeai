import { describe, expect, it } from 'vitest';
import type { ToolSpec } from '../../WorkspaceTools';
import { XmlToolProtocol } from '../XmlToolProtocol';

const specs: ToolSpec[] = [
  tool('write_file', 'Write a UTF-8 text file.', {
    path: { type: 'string', description: 'File path.' },
    content: { type: 'string', description: 'File content.' },
    overwrite: { type: 'boolean', description: 'Whether to overwrite.' },
  }, ['path', 'content']),
  tool('run_command', 'Run a shell command.', {
    command: { type: 'string', description: 'Command to execute.' },
    timeout: { type: 'integer', description: 'Timeout in milliseconds.' },
    env: { type: 'object', description: 'Environment variables.' },
    args: { type: 'array', description: 'Command arguments.' },
  }, ['command']),
];

describe('XmlToolProtocol', () => {
  it('does not send native tools', () => {
    expect(new XmlToolProtocol(specs).sendsNativeTools).toBe(false);
  });

  it('parses one XML tool block with multiple arguments and schema coercion', () => {
    const protocol = new XmlToolProtocol(specs);

    const calls = protocol.parseCalls({
      content: [
        '<use_tool>',
        '<tool>run_command</tool>',
        '<command>npm test</command>',
        '<timeout>3000</timeout>',
        '<env>{"CI":"true"}</env>',
        '<args>["--runInBand"]</args>',
        '</use_tool>',
      ].join('\n'),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: expect.stringMatching(/^xml-\d+$/),
      name: 'run_command',
      args: {
        command: 'npm test',
        timeout: 3000,
        env: { CI: 'true' },
        args: ['--runInBand'],
      },
    });
  });

  it('parses a FLAT tool block (the tag IS the tool name) with args + coercion', () => {
    const protocol = new XmlToolProtocol(specs);
    const calls = protocol.parseCalls({
      content: [
        '<run_command>',
        '<command>npm test</command>',
        '<timeout>3000</timeout>',
        '<env>{"CI":"true"}</env>',
        '</run_command>',
      ].join('\n'),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'run_command',
      args: { command: 'npm test', timeout: 3000, env: { CI: 'true' } },
    });
  });

  it('flat: preserves multiline content; a non-tool top-level tag is not a call', () => {
    const protocol = new XmlToolProtocol(specs);
    const [call] = protocol.parseCalls({
      content: '<write_file>\n<path>src/foo.ts</path>\n<content>\nline1\nline2\n</content>\n</write_file>',
    });
    expect(call.args).toEqual({ path: 'src/foo.ts', content: 'line1\nline2' });
    // <thinking> is not a known tool name → no call (anchored on known names).
    expect(protocol.parseCalls({ content: '<thinking>just musing</thinking>' })).toEqual([]);
  });

  it('flat: takes the earliest tool block when two appear', () => {
    const protocol = new XmlToolProtocol(specs);
    const calls = protocol.parseCalls({
      content:
        '<run_command><command>first</command></run_command>\n' +
        '<write_file><path>x</path><content>y</content></write_file>',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'run_command', args: { command: 'first' } });
  });

  it('preserves multiline string content while trimming only outer newlines', () => {
    const protocol = new XmlToolProtocol(specs);

    const [call] = protocol.parseCalls({
      content: [
        '<use_tool>',
        '<tool>write_file</tool>',
        '<path>src/foo.ts</path>',
        '<content>',
        'export const x = 1;',
        'export const y = 2;',
        '</content>',
        '<overwrite>true</overwrite>',
        '</use_tool>',
      ].join('\n'),
    });

    expect(call.args).toEqual({
      path: 'src/foo.ts',
      content: 'export const x = 1;\nexport const y = 2;',
      overwrite: true,
    });
  });

  it('returns no calls for absent, missing-tool, or malformed XML without throwing', () => {
    const protocol = new XmlToolProtocol(specs);

    expect(protocol.parseCalls({ content: 'plain answer' })).toEqual([]);
    expect(protocol.parseCalls({ content: '<use_tool><path>x</path></use_tool>' })).toEqual([]);
    expect(protocol.parseCalls({ content: null })).toEqual([]);
  });

  it('tolerates a mis-closed or unclosed <use_tool> block (weak-model recovery)', () => {
    const protocol = new XmlToolProtocol(specs);

    // Mis-closed with </tool> (echoes the inner <tool> tag) — the real stall we saw in Solo mode.
    const misClosed = protocol.parseCalls({
      content: '<use_tool>\n<tool>read_file</tool>\n<path>src/foo.ts</path>\n</tool>',
    });
    expect(misClosed).toHaveLength(1);
    expect(misClosed[0]).toMatchObject({ name: 'read_file', args: { path: 'src/foo.ts' } });

    // Unclosed entirely (model emitted the block then stopped).
    const unclosed = protocol.parseCalls({
      content: '<use_tool><tool>read_file</tool><path>x</path>',
    });
    expect(unclosed).toHaveLength(1);
    expect(unclosed[0]).toMatchObject({ name: 'read_file', args: { path: 'x' } });
  });

  it('falls back to recovering leaked tool tokens when the model ignores <use_tool> (DeepSeek DSML)', () => {
    const protocol = new XmlToolProtocol(specs);
    const D = '<｜｜DSML｜｜';
    const Dc = '</｜｜DSML｜｜';
    const content =
      `${D}tool_calls> ${D}invoke name="write_file"> ` +
      `${D}parameter name="path" string="true">_v04test/calc.js${Dc}parameter> ${Dc}invoke> ${Dc}tool_calls>`;
    const calls = protocol.parseCalls({ content });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'write_file', args: { path: '_v04test/calc.js' } });
  });

  it('uses only the first use_tool block', () => {
    const protocol = new XmlToolProtocol(specs);

    const calls = protocol.parseCalls({
      content: [
        '<use_tool><tool>run_command</tool><command>first</command></use_tool>',
        '<use_tool><tool>run_command</tool><command>second</command></use_tool>',
      ].join('\n'),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ command: 'first' });
  });

  it('keeps invalid JSON or invalid typed values as strings', () => {
    const protocol = new XmlToolProtocol(specs);

    const [call] = protocol.parseCalls({
      content: [
        '<use_tool>',
        '<tool>run_command</tool>',
        '<command>npm test</command>',
        '<timeout>soon</timeout>',
        '<env>{bad json</env>',
        '</use_tool>',
      ].join('\n'),
    });

    expect(call.args).toEqual({
      command: 'npm test',
      timeout: 'soon',
      env: '{bad json',
    });
  });

  it('renders tool names, required parameters, the XML example, and the one-tool rule', () => {
    const guide = new XmlToolProtocol(specs).renderToolGuide(specs);

    expect(guide).toContain('write_file');
    expect(guide).toContain('run_command');
    expect(guide).toContain('path: string, required');
    expect(guide).toContain('content: string, required');
    expect(guide).toContain('<write_file>');   // flat: the example tag IS the tool name
    expect(guide).toContain('</write_file>');
    expect(guide).toContain('One message may call one tool only');
  });

  it('formats tool results as user text blocks', () => {
    const result = new XmlToolProtocol(specs).formatResult(
      { id: 'xml-1', name: 'write_file', args: { path: 'src/foo.ts' } },
      'Wrote src/foo.ts'
    );

    expect(result).toEqual({
      role: 'user',
      content: '[Tool result: write_file]\nWrote src/foo.ts',
    });
  });
});

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required },
    },
  };
}
