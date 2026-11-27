/*
 * v0.9.104 D2.2 (ROADMAP: "define embedded-delimiter escaping and bound many-tool matching"): the shared XML block and
 * argument reader of the XML tool protocol and of the native protocol's flat-XML recovery.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolSpec } from '../../WorkspaceTools';
import { XmlToolProtocol } from '../XmlToolProtocol';
import { parseFlatXmlToolCall } from '../flatXmlToolCall';
import { argumentTags, firstFlatToolBlock, maskCdata } from '../xmlBlocks';

const tool = (name: string, properties: Record<string, unknown> = { path: { type: 'string' }, content: { type: 'string' } }): ToolSpec => ({
  type: 'function', function: { name, description: name, parameters: { type: 'object', properties, required: [] } },
});
const writeFile = tool('write_file');
const html = '<div class="a">\n  <p>x &amp; y</p>\n</content>\n</write_file>\n</div>';

afterEach(() => vi.restoreAllMocks());

describe('CDATA: the one escape for an argument that contains markup', () => {
  it('takes a CDATA value exactly as written, even when it holds the closing tags of its argument and its tool', () => {
    const content = `<write_file>\n<path>page.html</path>\n<content><![CDATA[${html}]]></content>\n</write_file>`;
    expect(new XmlToolProtocol([writeFile]).parseCalls({ content })).toEqual([
      { id: 'xml-1', name: 'write_file', args: { path: 'page.html', content: html } }]);
    expect(parseFlatXmlToolCall(content, [writeFile])).toEqual({ name: 'write_file', args: { path: 'page.html', content: html } });
  });

  it('keeps a CDATA value\'s own outer line breaks and spaces; a value without CDATA is read as before', () => {
    const verbatim = '\n  indented first line\n';
    const content = `<write_file><path>a.txt</path><content><![CDATA[${verbatim}]]></content></write_file>`;
    expect(new XmlToolProtocol([writeFile]).parseCalls({ content })[0].args.content).toBe(verbatim);
    expect(parseFlatXmlToolCall(content, [writeFile])!.args.content).toBe(verbatim);
    const plain = '<write_file><path>a.txt</path><content>\nplain\n</content></write_file>';
    expect(new XmlToolProtocol([writeFile]).parseCalls({ content: plain })[0].args.content).toBe('plain');
  });

  it('never decodes entities, with or without CDATA: code that contains them arrives unchanged', () => {
    const content = '<write_file><path>a.ts</path><content>if (a &amp;&amp; b) x = "&lt;";</content></write_file>';
    expect(new XmlToolProtocol([writeFile]).parseCalls({ content })[0].args.content).toBe('if (a &amp;&amp; b) x = "&lt;";');
  });

  it('restores CDATA inside a value that also has plain text, and keeps a CDATA section outside any block as text', () => {
    const content = 'Writing it: <![CDATA[<write_file>not a call</write_file>]]>\n'
      + '<write_file><path>a.md</path><content>before <![CDATA[<b>bold</b>]]> after</content></write_file>';
    expect(new XmlToolProtocol([writeFile]).parseCalls({ content })[0].args).toEqual({ path: 'a.md', content: 'before <b>bold</b> after' });
  });

  it('reads the legacy <use_tool> wrapper with CDATA too', () => {
    const content = `<use_tool>\n<tool>write_file</tool>\n<path>p.html</path>\n<content><![CDATA[${html}]]></content>\n</use_tool>`;
    expect(new XmlToolProtocol([writeFile]).parseCalls({ content })[0].args).toEqual({ path: 'p.html', content: html });
  });

  it('without CDATA, a literal closing tag still ends the value, as before: the guide tells the model to use CDATA', () => {
    const content = '<write_file><path>a.html</path><content>x </content> y</content></write_file>';
    expect(new XmlToolProtocol([writeFile]).parseCalls({ content })[0].args.content).toBe('x ');
    expect(new XmlToolProtocol([writeFile]).renderToolGuide()).toContain('<![CDATA[ ... ]]>, which is taken exactly as written');
  });
});

describe('many-tool matching is one pass, with no pattern built per tool', () => {
  it('finds the earliest complete block of a known tool among 200, in a 1 MiB reply, building no pattern at all', () => {
    const many = Array.from({ length: 200 }, (_, i) => tool(`tool_${i}`));
    const big = 'x'.repeat(1024 * 1024);
    const content = `<tool_7>unclosed\n<tool_150><path>a</path><content>${big}</content></tool_150> then <tool_3><path>b</path></tool_3>`;
    const built = vi.spyOn(globalThis, 'RegExp');
    const withMany = new XmlToolProtocol(many).parseCalls({ content });
    const countMany = built.mock.calls.length;
    built.mockClear();
    new XmlToolProtocol([tool('tool_150'), tool('tool_3')]).parseCalls({ content });
    const countTwo = built.mock.calls.length;
    expect(withMany).toHaveLength(1);
    expect(withMany[0].name).toBe('tool_150');
    expect(String(withMany[0].args.content).length).toBe(big.length);
    expect(countMany).toBe(0);
    expect(countTwo).toBe(0);
  });

  it('matches tool names regardless of case and needs the closing tag, as the per-tool patterns did', () => {
    const masked = maskCdata('<READ_FILE><path>a</path></Read_File>');
    expect(firstFlatToolBlock(masked, ['read_file'])).toEqual({ name: 'read_file', start: 11, end: 25 });
    expect(firstFlatToolBlock('<read_file><path>a</path>', ['read_file'])).toBeUndefined();
    // A tool whose name has capitals is found whatever case the model writes it in, and keeps its own name.
    expect(firstFlatToolBlock('<READFILE><path>b</path></readfile>', ['readFile'])).toEqual({ name: 'readFile', start: 10, end: 24 });
    expect(firstFlatToolBlock('<other>x</other>', ['read_file'])).toBeUndefined();
    expect(argumentTags('<path>a</path><content>b</content>', '<path>a</path><content>b</content>')).toEqual([
      { name: 'path', text: 'a', verbatim: false }, { name: 'content', text: 'b', verbatim: false }]);
  });
});

// Codex's audit of 6b6ff997: F1, a private-use marker in the reply was read as an internal one; F2, a lower-cased copy's
// offsets were used on the reply, though lower-casing can change length.
describe('the text of the reply is never rewritten, and offsets come from the reply itself', () => {
  it('F1: marker-shaped private-use characters in a value are kept exactly, with or without CDATA elsewhere', () => {
    const wanted = 'A\uE0000\uE001B';
    for (const content of [
      `<write_file><path>s.txt</path><content>${wanted}</content></write_file>`,
      `<![CDATA[OTHER]]><write_file><path>s.txt</path><content>${wanted}</content></write_file>`,
      `<write_file><path>s.txt</path><content><![CDATA[${wanted}]]></content></write_file>`,
    ]) {
      expect(new XmlToolProtocol([writeFile]).parseCalls({ content })[0].args.content, content).toBe(wanted);
      expect(parseFlatXmlToolCall(content, [writeFile])!.args.content, content).toBe(wanted);
    }
  });

  it('F2: text whose lower case is longer (U+0130) before a block does not move its end: a tag after it is not its argument', () => {
    const content = '\u0130'.repeat(60) + '<write_file><content>INSIDE</content></write_file><path>outside.txt</path>';
    expect(new XmlToolProtocol([writeFile]).parseCalls({ content })[0].args).toEqual({ content: 'INSIDE' });
    expect(parseFlatXmlToolCall(content, [writeFile])!.args).toEqual({ content: 'INSIDE' });
  });
});

// Codex's audit of 5c296230, F3: adjacent CDATA sections, the way to write a literal ]]>, are not one verbatim value.
describe('adjacent CDATA sections each give their content', () => {
  it('writes a literal ]]> split across two sections, in both readers, and keeps one section verbatim', () => {
    const content = '<write_file><path>split.txt</path><content><![CDATA[before ]]]]><![CDATA[> after]]></content></write_file>';
    expect(new XmlToolProtocol([writeFile]).parseCalls({ content })[0].args.content).toBe('before ]]> after');
    expect(parseFlatXmlToolCall(content, [writeFile])!.args.content).toBe('before ]]> after');
    const one = '<write_file><path>a.txt</path><content><![CDATA[ x ]]></content></write_file>';
    expect(new XmlToolProtocol([writeFile]).parseCalls({ content: one })[0].args.content).toBe(' x ');
  });
});
