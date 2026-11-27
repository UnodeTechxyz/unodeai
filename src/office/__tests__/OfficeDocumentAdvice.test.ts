import { expect, it } from 'vitest';
import { documentAdvice, officeAdviceText, presentationAdvice } from '../OfficeDocumentAdvice';
import { validatePresentationRequest } from '../PresentationContracts';
import { validateDocumentRequest } from '../../content/document/DocumentValidation';

it('explains request-level suggestions without rewriting Chinese, quoted wording or list-like text', () => {
  const request = validateDocumentRequest({ schema_version: 1, path: 'a.docx', format: 'docx', template: 'report-v1',
    document: { title: '中文ABC,示例', language: 'zh-CN', blocks: [
      { type: 'heading', level: 3, content: [{ text: 'Terms' }] }, { type: 'paragraph', content: [{ text: 'It was approved. Utilize the agreed term.\n1. Keep this quoted wording.' }] },
    ] } });
  const original = structuredClone(request); const items = documentAdvice(request.document);
  expect(items.map(item => item.rule)).toEqual(['mixed-spacing', 'chinese-punctuation', 'heading-sequence', 'possible-passive', 'plain-vocabulary', 'list-structure']);
  expect(items.every(item => item.level === 'suggestion')).toBe(true); expect(request).toEqual(original);
  expect(officeAdviceText(items)).toContain('not a rendered check'); expect(officeAdviceText(items)).toContain('literal space is not universally required');
});
it('counts all occurrences but limits examples without declaring glyph overflow or decorative alt errors', () => {
  const request = validatePresentationRequest({ schema_version: 1, path: 'a.pptx', deck: { title: 'Title', slides: [{ objects: [
    ...Array.from({ length: 8 }, () => ({ type: 'text', text: '混排ABC', x: 0, y: 0, w: 2, h: 1 })),
    { type: 'image', asset_ref: 'content-1', altText: '', x: 12.5, y: 1, w: 2, h: 1 },
  ] }] } });
  const original = structuredClone(request); const items = presentationAdvice(request.deck);
  expect(items.find(item => item.rule === 'mixed-spacing')).toMatchObject({ occurrences: 8, locations: ['slide 1 object 1', 'slide 1 object 2', 'slide 1 object 3'] });
  expect(items.find(item => item.rule === 'outside-slide')?.message).toContain('intentional bleed');
  expect(items.find(item => item.rule === 'missing-alt-text')?.message).toContain('decorative');
  expect(items.some(item => /line-start|confirmed-overflow/.test(item.rule))).toBe(false); expect(request).toEqual(original);
});
it('does not confuse numbers or clean text with a Chinese prose defect', () => {
  const request = validateDocumentRequest({ schema_version: 1, path: 'a.docx', format: 'docx', template: 'report-v1',
    document: { title: 'A title', language: 'en', blocks: [{ type: 'paragraph', content: [{ text: 'The sum is 1,000.25. 中文 ABC；中文。' }] }] } });
  expect(documentAdvice(request.document)).toEqual([]); expect(officeAdviceText([])).toBe('');
});
