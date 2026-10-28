import { describe, expect, it } from 'vitest';
import { DOCUMENT_FAILURE_CODES, type DocumentFailureCode } from '../DocumentContracts';
import { pdfFallback, PDF_FALLBACK_GUIDANCE } from '../PdfFallback';
import { DOCUMENT_AUTHORING_GUIDANCE, WRITE_DOCUMENT_DESCRIPTION } from '../DocumentTool';

describe('PDF-specific fallback policy', () => {
  it('pins the exact allow-list across all document failures; new codes do not opt in by default', () => {
    const expected = [
      'font-resource-invalid', 'font-unavailable', 'font-embedding-restricted', 'font-discovery-limit',
      'font-budget', 'font-resource-changed', 'unsupported-glyph', 'unsupported-text-layout',
      'layout-unrepresentable', 'worker-exit',
    ];
    // v0.9.99: length is never a fallback reason; out-of-memory and draft results are not PDF-specific either.
    for (const code of ['out-of-memory', 'draft-not-found', 'draft-storage-failed', 'cancelled'] as const) {
      expect(DOCUMENT_FAILURE_CODES).toContain(code); expect(pdfFallback(code, 'out.pdf')).toBeUndefined();
    }
    for (const retired of ['text-limit', 'glyph-limit', 'schema-limit', 'structure-limit', 'layout-limit', 'output-limit',
      'busy', 'queue-timeout', 'render-timeout']) expect(DOCUMENT_FAILURE_CODES).not.toContain(retired);
    const actual = DOCUMENT_FAILURE_CODES.filter(code => pdfFallback(code, 'out.pdf') !== undefined);
    expect([...actual].sort()).toEqual([...expected].sort());
    // A future font code must also be reviewed, not admitted by startsWith('font-').
    for (const code of ['future-pdf-failure', 'font-future-failure']) {
      expect(pdfFallback(code as DocumentFailureCode, 'out.pdf')).toBeUndefined();
    }
  });

  it('only suggests replacing a decorative character for character/layout-admission failures', () => {
    for (const code of DOCUMENT_FAILURE_CODES) {
      const result = pdfFallback(code, 'out.pdf');
      if (!result) continue;
      expect(result.instruction.includes('if the character is decorative, replace it and try PDF again'))
        .toBe(['unsupported-glyph', 'unsupported-text-layout'].includes(code));
    }
  });

  it('keeps format-neutral retry/repair instructions and makes the shared Word guidance conditional on the result', () => {
    expect(PDF_FALLBACK_GUIDANCE).toContain('If a failed PDF result asks for Word');
    expect(WRITE_DOCUMENT_DESCRIPTION).toContain(PDF_FALLBACK_GUIDANCE);
    expect(DOCUMENT_AUTHORING_GUIDANCE).toContain(PDF_FALLBACK_GUIDANCE);
    expect(WRITE_DOCUMENT_DESCRIPTION).not.toContain('busy'); expect(WRITE_DOCUMENT_DESCRIPTION).not.toContain('queue-timeout');
    expect(WRITE_DOCUMENT_DESCRIPTION).toContain('There is no length limit. For a long document, send it in parts');
    expect(WRITE_DOCUMENT_DESCRIPTION).toContain('Otherwise correct the stated input/font/target issue');
    expect(WRITE_DOCUMENT_DESCRIPTION).toContain('effect-uncertain requires inspecting the destination');
    expect(WRITE_DOCUMENT_DESCRIPTION).not.toContain('For DOCX busy');
  });
});
