import { documentPlainText, type CanonicalDocument } from '../content/document/DocumentContracts';
import type { PresentationDeck } from './PresentationContracts';

/** Original MIT implementation. References are guidance, not bundled upstream code or conformance claims. */
export const OFFICE_ADVICE_SOURCES = {
  'clreq-mixed-text': { url: 'https://www.w3.org/TR/2026/DNOTE-clreq-20261104/', status: 'W3C Group Note Draft', license: 'W3C document license; reference only' },
  'wcag-text-alternatives': { url: 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-content', status: 'Informative WCAG 2.2 guidance', license: 'W3C document license; reference only' },
  'local-editorial-v1': { url: '', status: 'Original heuristic; no grammar or layout conformance claim', license: 'MIT' },
} as const;
type Source = keyof typeof OFFICE_ADVICE_SOURCES;
export interface OfficeAdvice {
  rule: string; level: 'suggestion'; source: Source; occurrences: number; locations: string[]; message: string;
}
class Advice {
  private readonly rules = new Map<string, OfficeAdvice>();
  add(rule: string, source: Source, location: string, message: string): void {
    const item = this.rules.get(rule) ?? { rule, level: 'suggestion', source, occurrences: 0, locations: [], message };
    item.occurrences++;
    // Examples are bounded, not the task or checked text. The total count remains explicit.
    if (item.locations.length < 3) item.locations.push(location);
    this.rules.set(rule, item);
  }
  text(text: string, location: string): void {
    if (/[\p{Script=Han}][A-Za-z0-9]|[A-Za-z0-9][\p{Script=Han}]/u.test(text)) this.add('mixed-spacing', 'clreq-mixed-text', location,
      'Consider visual spacing between Chinese and Latin letters/numbers. Font spacing can supply it; a literal space is not universally required. Preserve identifiers and quotations.');
    if (/[\p{Script=Han}][,;!?]|[,;!?][\p{Script=Han}]/u.test(text)) this.add('chinese-punctuation', 'clreq-mixed-text', location,
      'Consider Chinese punctuation in Chinese prose; keep ASCII punctuation where code, identifiers, quotations or the chosen style require it.');
    if (/\b(?:is|are|was|were|be|been|being)\s+[a-z]+ed\b/i.test(text)) this.add('possible-passive', 'local-editorial-v1', location,
      'A be + -ed phrase may be passive or adjectival. Consider naming the actor only if it improves clarity; legal wording and quotations may intentionally retain it.');
    if (/\b(?:utili[sz]e|commence)\b/i.test(text)) this.add('plain-vocabulary', 'local-editorial-v1', location,
      'Consider use for utilize, or begin for commence, if the intended meaning and register remain the same. This is a style suggestion, not a vocabulary error.');
    if (/^[ \t]*(?:[-*•]|\d+[.)])[ \t]+\S/m.test(text)) this.add('list-structure', 'local-editorial-v1', location,
      'This text resembles a typed list. Consider semantic list structure where the target editor supports it; markers alone do not prove accessible list structure.');
  }
  result(): OfficeAdvice[] { return [...this.rules.values()]; }
}

export function documentAdvice(document: CanonicalDocument): OfficeAdvice[] {
  const advice = new Advice(); const title = documentPlainText(document.title ?? []);
  if (document.title && !title.trim()) advice.add('missing-title', 'local-editorial-v1', 'title', 'Consider a descriptive document title.');
  advice.text(title, 'title'); let heading = 0;
  for (const [index, block] of document.blocks.entries()) {
    const location = `block ${index + 1}`;
    if (block.type === 'heading') {
      if (block.level > heading + 1) advice.add('heading-sequence', 'local-editorial-v1', location, 'A heading level is skipped; consider a consistent hierarchy if this is not an intentional excerpt.');
      heading = block.level;
    }
    if (block.type === 'paragraph' || block.type === 'heading' || block.type === 'clause') advice.text(documentPlainText(block.content), location);
  }
  return advice.result();
}

export function presentationAdvice(deck: PresentationDeck): OfficeAdvice[] {
  const advice = new Advice();
  if (!deck.title.trim()) advice.add('missing-title', 'local-editorial-v1', 'deck title', 'Consider a descriptive presentation title.');
  advice.text(deck.title, 'deck title'); const width = deck.layout === 'wide' ? 13.333333 : 10; const height = 7.5;
  for (const [slide, page] of deck.slides.entries()) for (const [index, object] of page.objects.entries()) {
    const location = `slide ${slide + 1} object ${index + 1}`;
    if (object.type === 'text') advice.text(object.text, location);
    if (object.type === 'image' && !object.altText.trim()) advice.add('missing-alt-text', 'wcag-text-alternatives', location,
      'No alternative text was supplied. Consider describing meaningful images; decorative images may intentionally have no description.');
    if (object.x < 0 || object.y < 0 || object.x + object.w > width + 0.0001 || object.y + object.h > height + 0.0001) advice.add('outside-slide', 'local-editorial-v1', location,
      'The requested object box extends outside the slide. This may be intentional bleed; it is a clipping risk, not proof of rendered text overflow.');
    if (object.type === 'text' || object.type === 'table') advice.add('font-resolution-unverified', 'local-editorial-v1', location,
      'Native font availability/substitution and text fit are unverified. The generated font size alone does not establish actual layout.');
  }
  return advice.result();
}

export function officeAdviceText(items: OfficeAdvice[]): string {
  return items.length ? '\nRequest-level language/layout suggestions only (no automatic edits or save restriction; not a rendered check). '
    + 'Relay useful suggestions; do not rewrite unless asked. Checked only document title/heading/body paragraphs/clauses, or deck title/text/image alternatives/requested boxes. '
    + 'Table cells (including source-bound cells), other text, native font/glyph fit and actual line-start/end punctuation were not checked.\n'
    + items.map(item => `${item.rule} [suggestion; ${item.source}]: ${item.occurrences} location(s); examples: ${item.locations.join(', ')}. ${item.message}`).join('\n') : '';
}
