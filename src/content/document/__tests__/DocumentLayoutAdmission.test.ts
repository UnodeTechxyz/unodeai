import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateDocumentRequest } from '../DocumentValidation';
import { admitDocumentLayout, admitDocumentText, documentLayoutWarnings } from '../DocumentLayoutAdmission';
import { generateDocumentUnicode } from '../../../../scripts/generate-document-unicode.mjs';

const text = (value: string, language = 'en') => [{ text: value, language, bold: false }];
describe('fixed UCD 17.0.0 document layout admission', () => {
  it('regenerates the exact product table from all pinned inputs and ships the complete Unicode notice', () => {
    expect(generateDocumentUnicode()).toBe(readFileSync(resolve('src/content/document/DocumentUnicodeData.ts'), 'utf8'));
    const license = readFileSync(resolve('src/content/document/testdata/ucd17/LICENSE.txt'), 'utf8').trim();
    expect(readFileSync(resolve('THIRD_PARTY_NOTICES.md'), 'utf8').replace(/\r\n/g, '\n')).toContain(license.replace(/\r\n/g, '\n'));
  });
  it.each([
    ['English 123 - A&B', 'en'], ['简体合同〇。', 'zh-Hans'], ['繁體契約〇。', 'zh-Hant'],
    ['日本語の契約カタカナー。', 'ja'], ['한국어 계약 각', 'ko'], ['français œ ç é e\u0301', 'fr'], ['español ñ ü ¿¡', 'es'],
  ])('admits %s with language %s', (value, language) => {
    const admission = admitDocumentText(text(value, language));
    expect(admission.issues).toEqual([]);
    expect(admission.clusters.map(cluster => cluster.text).join('')).toBe(value);
  });
  it.each(['العقد', 'עברית', 'မြန်မာ', 'සිංහල', 'ܫܠܡܐ', 'ދިވެހި', 'देव', 'ภาษาไทย', 'ខ្មែរ', '😀'])('does not widen the closed repertoire for %s', value => {
    expect(admitDocumentText(text(value)).issues.length).toBeGreaterThan(0);
  });
  it.each(['a\u202E', 'a\u2066', 'a\u200E', 'a\u200D', 'a\u00AD', 'a\uFEFF', 'a\uFE0F', 'a\u034F', 'ᅡ', 'ᆨ', 'ᄀ가', 'ᄓᅡ', '\u0301', 'e\u0300\u0301\u0302'])('rejects controls and incomplete/unsupported clusters %j', value => {
    expect(admitDocumentText(text(value)).issues.length).toBeGreaterThan(0);
  });
  it('requires explicit Han/punctuation region and does not guess Chinese from a glyph', () => {
    for (const value of ['合同', '。']) for (const language of ['en', 'und', 'zh']) {
      expect(admitDocumentText(text(value, language)).issues[0].code).toBe('document-language-required');
    }
    expect(admitDocumentText(text('ー', 'en')).issues.length).toBeGreaterThan(0);
  });
  it('does not split canonical combining clusters, including equal-style run boundaries', () => {
    const actual = admitDocumentText([{ text: 'e', language: 'fr', bold: false }, { text: '\u0301', language: 'fr', bold: false }]);
    expect(actual.issues).toEqual([]); expect(actual.clusters).toMatchObject([{ text: 'e\u0301', source: [{ runIndex: 0, start: 0, end: 1 }, { runIndex: 1, start: 0, end: 1 }] }]);
    expect(admitDocumentText([{ text: 'e', language: 'fr', bold: false }, { text: '\u0301', language: 'fr', bold: true }]).issues.length).toBeGreaterThan(0);
    expect(admitDocumentText(text('か\u3099', 'ja')).clusters.map(cluster => cluster.text)).toEqual(['か\u3099']);
    expect(admitDocumentText(text('각', 'ko')).clusters.map(cluster => cluster.text)).toEqual(['각']);
  });
  it('checks every text field and produces only bounded host-owned DOCX warnings, without losing Unicode', () => {
    const canonical = validateDocumentRequest({ schema_version: 1, path: 'report.docx', format: 'docx', template: 'report-v1',
      document: { title: 'Title', header: 'العقد', footer: '\u202E', blocks: [
        { type: 'table', headers: ['Column'], rows: [['Ελληνικά']] },
        { type: 'signature', parties: [{ label: '签署', name: 'Name' }] },
      ] } });
    expect(admitDocumentLayout(canonical.document).ok).toBe(false);
    expect(documentLayoutWarnings(canonical.document)).toEqual([{ code: 'reader-layout-unverified', scripts: ['Arab', 'Hani'], reasons: ['format-control', 'script'] }]);
    expect(canonical.document.header![0].text).toBe('العقد');
    expect(JSON.stringify(documentLayoutWarnings(canonical.document))).not.toContain('العقد');
  });
});
