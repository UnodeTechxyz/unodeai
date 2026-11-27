import { describe, expect, it } from 'vitest';
import { docxPackageMembers } from '../DocxRenderer';
import { validateDocumentRequest } from '../DocumentValidation';

const canonical = () => validateDocumentRequest({ schema_version: 1, path: 'proof.docx', format: 'docx', template: 'contract-v1', document: {
  title: 'A < B & "C"', language: 'zh-tw', blocks: [
    { type: 'heading', level: 2, content: [{ text: '條款', bold: true }] },
    { type: 'clause', label: '1.01', content: [{ text: '  A < B & C > D\nNext  ' }] },
    { type: 'table', headers: ['甲', '乙'], rows: [['契約', '100.00']] },
    { type: 'signature', parties: [{ label: '簽署', name: '甲方' }] },
  ] } });

describe('finite DOCX OOXML package', () => {
  it('writes decomposed modern Hangul as syllables without changing compatibility Han text', () => {
    const request = validateDocumentRequest({ schema_version: 1, path: 'ko.docx', format: 'docx', template: 'report-v1',
      document: { title: '\u1112\u1161\u11ab\u1100\u1173\u11af \uf900', language: 'ko',
        blocks: [{ type: 'paragraph', content: [{ text: '\u1100\u1161' }] }] } });
    const xml = docxPackageMembers(request).get('word/document.xml')!;
    expect(xml).toContain('한글 \uf900'); expect(xml).toContain('가'); expect(xml).not.toContain('\u1112');
  });
  it('has only ten fixed internal package members, no macros, media, external relationships or local paths', () => {
    const members = docxPackageMembers(canonical());
    expect(members.size).toBe(10);
    expect([...members.keys()].sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml',
      'word/_rels/document.xml.rels', 'word/document.xml', 'word/footer1.xml', 'word/header1.xml', 'word/settings.xml', 'word/styles.xml']);
    const all = [...members.values()].join('\n');
    expect(all).not.toMatch(/TargetMode="External"|vbaProject|file:\/\/|C:\\|w:altChunk/);
    expect(all).not.toContain('proof.docx');
  });
  it('escapes user text, preserves whitespace, emits explicit numbering and inherited canonical language hints', () => {
    const xml = docxPackageMembers(canonical()).get('word/document.xml')!;
    expect(xml).toContain('A &lt; B &amp; &quot;C&quot;');
    expect(xml).toContain('xml:space="preserve">  A &lt; B &amp; C &gt; D');
    expect(xml).toContain('<w:br/>'); expect(xml).toContain('1.01');
    expect(xml).toContain('w:val="zh-Hant" w:eastAsia="zh-Hant"');
    expect(xml).toContain('Microsoft JhengHei');
    expect(xml).toContain('w:left="720" w:hanging="720"');
  });
  it('uses real outline headings, minimum line spacing, table headers/grid and reader-owned page fields', () => {
    const members = docxPackageMembers(canonical());
    expect(members.get('word/styles.xml')).toContain('<w:outlineLvl w:val="1"/>');
    expect(members.get('word/styles.xml')).toContain('w:lineRule="atLeast"');
    expect(members.get('word/document.xml')).toContain('<w:tblHeader/>');
    expect(members.get('word/document.xml')).toContain('<w:tblGrid>');
    expect(members.get('word/footer1.xml')).toContain('w:instr="NUMPAGES"');
    expect(members.get('word/footer1.xml')).toContain('w:instr="PAGE"');
    expect(members.get('word/settings.xml')).not.toContain('updateFields');
    expect(members.get('docProps/core.xml')).toContain('2000-01-01T00:00:00Z');
  });
});
