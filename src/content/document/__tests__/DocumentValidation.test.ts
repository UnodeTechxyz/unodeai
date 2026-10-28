import { describe, expect, it } from 'vitest';
import { validateDocumentRequest } from '../DocumentValidation';
import { canonicalDocumentLanguage, documentFontHint } from '../DocumentLanguage';
import { documentPlainText } from '../DocumentContracts';

export const documentFixture = () => ({ schema_version: 1, path: 'out/contract-v2.0.docx', format: 'docx', template: 'contract-v1',
  document: { title: 'Agreement & <Report>', language: 'en', page: 'a4', header: 'Private', footer: 'Review copy',
    blocks: [
      { type: 'heading', level: 1, content: [{ text: 'Terms' }] },
      { type: 'paragraph', content: [
        { text: 'English 123 / français œ ç é e\u0301 / español ñ ü ¿ ¡', language: 'fr' },
        { text: '简体合同 123', language: 'zh-Hans', bold: true },
        { text: '繁體契約 123', language: 'zh-Hant' },
        { text: '日本語の契約 123', language: 'ja' },
        { text: '한국어 계약 123', language: 'ko' },
      ] },
      { type: 'clause', label: '1.01', content: [{ text: '  A < B & C > D\r\nSecond line  ' }] },
      { type: 'table', headers: ['Item', 'Amount'], rows: [['Compute', '1,000.00']] },
      { type: 'page-break' },
      { type: 'signature', parties: [{ label: 'Provider', name: 'Company A' }, { label: 'Customer' }] },
    ] } });

describe('document canonicalizer', () => {
  it.each(['\u1100\u1161\u11c3', '\u1100\u1161\ud7cb', '\u1100\u1161\u11a8\u11c3'])('leaves an old-Hangul trailing sequence unchanged: %s', title => {
    const request = documentFixture(); request.document.title = title;
    expect(documentPlainText(validateDocumentRequest(request).document.title)).toBe(title);
  });
  it('composes modern decomposed Hangul only, preserving old Hangul and CJK compatibility ideographs', () => {
    const request = documentFixture();
    request.document.title = '\u1112\u1161\u11ab\u1100\u1173\u11af \u1100\u1161 \uf900 e\u0301 \ua960\u1161';
    expect(documentPlainText(validateDocumentRequest(request).document.title)).toBe('한글 가 \uf900 e\u0301 \ua960\u1161');
  });
  it('preserves numbering, spaces, Unicode and run order; canonicalizes only CRLF and language labels', () => {
    const canonical = validateDocumentRequest(documentFixture());
    expect(documentPlainText(canonical.document.title)).toBe('Agreement & <Report>');
    expect(canonical.document.blocks[2]).toMatchObject({ type: 'clause', label: [{ text: '1.01' }],
      content: [{ text: '  A < B & C > D\nSecond line  ' }] });
    expect(canonical.document.blocks[1]).toMatchObject({ content: [
      { language: 'fr' }, { language: 'zh-Hans', bold: true }, { language: 'zh-Hant' }, { language: 'ja' }, { language: 'ko' },
    ] });
  });
  it.each(['\r', '\0', '\t', '\u0001', '\ud800', '\udfff', '\ufffe'])('refuses illegal XML/scalar input %j', bad => {
    const request = documentFixture(); request.document.title = `Title ${bad}`;
    expect(() => validateDocumentRequest(request)).toThrow('invalid-input');
  });
  it('does not refuse legal Unicode merely because PDF layout remains unqualified', () => {
    const request = documentFixture(); request.document.title = 'العقد Ελληνικά Кириллица \u202E';
    expect(documentPlainText(validateDocumentRequest(request).document.title)).toBe(request.document.title);
  });
  it.each(['../out.docx', '/out.docx', 'C:/out.docx', 'dir\\out.docx', 'https://host/out.docx'])('refuses non-relative paths %s', path => {
    expect(() => validateDocumentRequest({ ...documentFixture(), path })).toThrow('invalid-input');
  });
  it('rejects mismatched format and unknown fields at every structural level', () => {
    expect(() => validateDocumentRequest({ ...documentFixture(), format: 'pdf' })).toThrow('extension-mismatch');
    for (const mutate of [
      (r: any) => { r.font = '/private.ttf'; }, (r: any) => { r.document.templatePath = '/template'; },
      (r: any) => { r.document.blocks[0].style = 'raw'; }, (r: any) => { r.document.blocks[1].content[0].font = 'raw'; },
      (r: any) => { r.document.blocks[5].parties[0].signature = 'signed'; },
    ]) { const request = documentFixture(); mutate(request); expect(() => validateDocumentRequest(request)).toThrow('invalid-input'); }
  });
  it('rejects empty/edge/repeated page breaks and ragged tables', () => {
    const request = documentFixture(); request.document.blocks.unshift({ type: 'page-break' } as any);
    expect(() => validateDocumentRequest(request)).toThrow('invalid-input');
    const ragged = documentFixture(); (ragged.document.blocks[3] as any).rows = [['one']];
    expect(() => validateDocumentRequest(ragged)).toThrow('invalid-input');
  });
  // v0.9.99: the former field/run/structure/text/JSON budgets refused a document; each is now accepted whole.
  it('accepts every field, run, structure, text and JSON size past its former budget, without truncation', () => {
    const title = documentFixture(); title.document.title = 'a'.repeat(161);
    expect(documentPlainText(validateDocumentRequest(title).document.title)).toHaveLength(161);
    const run = documentFixture(); (run.document.blocks[1] as any).content = [{ text: 'a'.repeat(8193) + 'TAIL' }];
    expect(documentPlainText((validateDocumentRequest(run).document.blocks[1] as any).content).endsWith('TAIL')).toBe(true);
    const runs = documentFixture(); (runs.document.blocks[1] as any).content = Array.from({ length: 4097 }, (_, i) => ({ text: `r${i} ` }));
    expect((validateDocumentRequest(runs).document.blocks[1] as any).content).toHaveLength(4097);
    const bytes = documentFixture(); (bytes.document.blocks[1] as any).content = [{ text: 'a'.repeat(1_048_576) + 'TAIL' }];
    expect(JSON.stringify(bytes).length).toBeGreaterThan(1_048_576);
    expect(documentPlainText((validateDocumentRequest(bytes).document.blocks[1] as any).content)).toHaveLength(1_048_580);
    const cells = documentFixture(); cells.document.blocks = [{ type: 'table', headers: Array(8).fill('h'), rows: Array.from({ length: 501 }, (_, i) => Array(8).fill(`c${i}`)) }] as any;
    const table = validateDocumentRequest(cells).document.blocks[0] as any;
    expect(table.rows).toHaveLength(501); expect(documentPlainText(table.rows[500][7])).toBe('c500');
    const blocks = documentFixture(); blocks.document.blocks = Array.from({ length: 1001 }, (_, i) => ({ type: 'paragraph', content: [{ text: `p${i}` }] })) as any;
    expect(validateDocumentRequest(blocks).document.blocks).toHaveLength(1001);
    const parties = documentFixture(); (parties.document.blocks[5] as any).parties = Array.from({ length: 5 }, (_, i) => ({ label: `Party ${i}` }));
    expect((validateDocumentRequest(parties).document.blocks[5] as any).parties).toHaveLength(5);
  });
  it('accepts Word\'s 63 table columns and reports a 64th as a layout Word cannot hold, not as a capacity limit', () => {
    const table = (columns: number) => { const request = documentFixture();
      request.document.blocks = [{ type: 'table', headers: Array(columns).fill('h'), rows: [Array(columns).fill('c')] }] as any; return request; };
    expect((validateDocumentRequest(table(63)).document.blocks[0] as any).headers).toHaveLength(63);
    expect(() => validateDocumentRequest(table(64))).toThrow('layout-unrepresentable');
  });
  it('accepts 4,097 and more distinct Han characters in a DOCX: there is no distinct-character limit', () => {
    const request = (count: number) => ({ schema_version: 1, path: 'glyphs.docx', format: 'docx', template: 'report-v1',
      document: { title: '一', blocks: [{ type: 'paragraph', content: [
        { text: Array.from({ length: count }, (_, index) => String.fromCodePoint(0x4e00 + index)).join('') },
      ] }] } });
    for (const count of [4097, 20_000]) {
      const input = request(count); const original = structuredClone(input);
      const canonical = validateDocumentRequest(input);
      expect(canonical.document.blocks[0]).toMatchObject({ content: [{ text: input.document.blocks[0].content[0].text }] });
      expect(new Set(documentPlainText((canonical.document.blocks[0] as any).content)).size).toBe(count);
      expect(input).toEqual(original);
    }
  });
  // Inverted from the capability audit's reproductions: the same inputs that were refused now validate whole.
  it.each(['docx', 'pdf'])('accepts a complete 126,490-character contract before %s rendering (formerly text-limit)', format => {
    const request = { schema_version: 1, path: `contract.${format}`, format, template: 'contract-v1',
      document: { title: 'Contract', language: 'en', blocks: Array.from({ length: 25 }, (_, i) => ({
        type: 'paragraph', content: [{ text: `${'x'.repeat(i === 24 ? 6486 : 4996)}E${String(i).padStart(2, '0')}.` }],
      })) } };
    expect(request.document.blocks.reduce((n, block) => n + block.content[0].text.length, 0)).toBe(126490);
    const canonical = validateDocumentRequest(request);
    expect(canonical.document.blocks.map(block => documentPlainText((block as any).content).slice(-4))).toEqual(
      Array.from({ length: 25 }, (_, i) => `E${String(i).padStart(2, '0')}.`));
  });
  it('accepts 4,097 distinct valid Han characters in a short DOCX (formerly glyph-limit)', () => {
    const text = Array.from({ length: 4097 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
    const canonical = validateDocumentRequest({ schema_version: 1, path: 'han.docx', format: 'docx', template: 'report-v1',
      document: { title: 'Report', blocks: [{ type: 'paragraph', content: [{ text }] }] } });
    expect(documentPlainText((canonical.document.blocks[0] as any).content)).toBe(text);
  });
  it('accepts more than the former 262,144 UTF-8 bytes and 120,000 scalars, keeping the tail', () => {
    const body = '中'.repeat(130_000) + 'TAIL';
    const input = { schema_version: 1, path: 'bytes.docx', format: 'docx', template: 'report-v1',
      document: { title: 'a', blocks: [{ type: 'paragraph', content: [{ text: body }] }] } };
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(262_144);
    const canonical = validateDocumentRequest(input);
    expect(documentPlainText((canonical.document.blocks[0] as any).content)).toBe(body);
  });
  it('validates a draft part without blocks or with an edge page break, but never the whole document that way', () => {
    const part = { ...documentFixture(), document: { ...documentFixture().document, blocks: [] as any[] } };
    expect(validateDocumentRequest(part, { part: true }).document.blocks).toEqual([]);
    expect(() => validateDocumentRequest(part)).toThrow('invalid-input');
    const edge = { ...documentFixture(), document: { ...documentFixture().document, blocks: [{ type: 'page-break' }] } };
    expect(validateDocumentRequest(edge, { part: true }).document.blocks).toEqual([{ type: 'page-break' }]);
    expect(() => validateDocumentRequest(edge)).toThrow('invalid-input');
    // Correctness checks still apply to every part.
    const bad = { ...documentFixture(), document: { ...documentFixture().document, blocks: [{ type: 'paragraph', content: [{ text: 'a\u0001' }] }] } };
    expect(() => validateDocumentRequest(bad, { part: true })).toThrow('invalid-input');
  });
});

describe('fixed document language labels', () => {
  it.each([['EN-lAtN-us', 'en-Latn-US'], ['zh-cn', 'zh-Hans'], ['zh-SG', 'zh-Hans'],
    ['zh-tw', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-mo', 'zh-Hant'], ['zh-Hant-CN', 'zh-Hant-CN'],
    ['ja-jp', 'ja-JP'], ['ko-kr', 'ko-KR'], ['und', 'und'], ['es-419', 'es-419']])('%s → %s', (value, expected) => {
    expect(canonicalDocumentLanguage(value)).toBe(expected);
  });
  it.each([' en', 'en ', 'en_US', 'en-US-x-private', 'x-private', '', 'en-Latn-US-extra'])('refuses %j rather than consulting ICU', value => {
    expect(() => canonicalDocumentLanguage(value)).toThrow('invalid-input');
  });
  it('chooses static DOCX hints without reading or embedding a font', () => {
    expect(['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko'].map(documentFontHint)).toEqual(['Arial', 'Microsoft YaHei', 'Microsoft JhengHei', 'Yu Gothic', 'Malgun Gothic']);
  });
});
