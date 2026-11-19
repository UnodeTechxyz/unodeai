import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { WRITE_DOCUMENT_PARAMETERS, WRITE_DOCUMENT_DESCRIPTION, documentDraftCall, isDocumentDraftPart } from '../DocumentTool';
import { validateDocumentRequest } from '../DocumentValidation';
import { documentInput } from '../../../backend/__tests__/documentRouteFixtures';

describe('the shared structured document model schema', () => {
  it('accepts every supported block and language run, with exactly the runtime-required top-level fields', () => {
    const validate = new Ajv({ strict: false }).compile(WRITE_DOCUMENT_PARAMETERS);
    const input = documentInput('docx');
    input.document.blocks = [
      ...input.document.blocks, { type: 'clause', label: '1.', content: [{ text: '條款', language: 'zh-Hant' }] },
      { type: 'table', headers: ['A', [{ text: 'B' }]], rows: [['one', 'two']] },
      { type: 'page-break' }, { type: 'signature', parties: [{ label: 'SIGN', name: [{ text: 'NAME' }] }] },
    ] as any;
    expect(validate(input)).toBe(true); expect(() => validateDocumentRequest(input)).not.toThrow();
    expect(validate({ ...input, document: { ...input.document, rawXml: '<x/>' } })).toBe(false);
    expect(validate({ ...input, receipt: { sha256: 'forged' } })).toBe(false);
    expect(validate({ ...input, format: 'html' })).toBe(false);
    expect(validate({ ...input, document: { ...input.document, blocks: [{ type: 'paragraph', content: 'not inline runs' }] } })).toBe(false);
  });
  // v0.9.99: the schema advertises no length or count maximum; only Word's 63-column table limit remains.
  it('advertises no count maxima beyond Word\'s 63 columns, and offers draft parts in a short description', () => {
    const maxima = [...JSON.stringify(WRITE_DOCUMENT_PARAMETERS).matchAll(/"max(?:Items|Length)":(\d+)/g)].map(match => Number(match[1]));
    expect(maxima).toEqual([63, 63]);
    const validate = new Ajv({ strict: false }).compile(WRITE_DOCUMENT_PARAMETERS);
    const input = documentInput('docx');
    input.document.blocks = [
      ...Array.from({ length: 1001 }, () => ({ type: 'paragraph', content: Array.from({ length: 129 }, () => ({ text: 'a' })) })),
      { type: 'table', headers: Array(9).fill('h'), rows: Array.from({ length: 501 }, () => Array(9).fill('c')) },
      { type: 'signature', parties: Array.from({ length: 5 }, (_, i) => ({ label: `P${i}` })) },
    ] as any;
    expect(validate(input)).toBe(true);
    expect(validate({ ...input, draft: 'contract', final: true, document: { ...input.document, blocks: [] } })).toBe(true);
    expect(validate({ ...input, document: { ...input.document, blocks: [{ type: 'table', headers: Array(64).fill('h'), rows: [Array(64).fill('c')] }] } })).toBe(false);
    expect(WRITE_DOCUMENT_DESCRIPTION).toContain('final: true');
    expect(documentDraftCall({ draft: 'a' })).toEqual({ name: 'a', final: false });
    expect(documentDraftCall({ draft: 'a', final: true })).toEqual({ name: 'a', final: true });
    expect(documentDraftCall({})).toBeUndefined(); expect(documentDraftCall({ final: true })).toBeUndefined();
    for (const bad of [{ draft: '' }, { draft: 3 }, { draft: 'x'.repeat(201) }, { draft: 'a', final: 'yes' }]) expect(documentDraftCall(bad)).toBe('invalid');
    expect([{ draft: 'a' }, { draft: 'a', final: false }, { draft: 'a', final: true }, {}].map(isDocumentDraftPart)).toEqual([true, true, false, false]);
  });
});
