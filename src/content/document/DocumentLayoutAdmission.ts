import { documentTexts, type CanonicalDocument, type DocumentText } from './DocumentContracts';
import { DOCUMENT_UNICODE_FLAGS as F, DOCUMENT_UNICODE_RANGES, DOCUMENT_UNICODE_DIGEST } from './DocumentUnicodeData';

export const DOCUMENT_LAYOUT_POLICY = 'pdf-layout-v1/ucd-17.0.0' as const;
export { DOCUMENT_UNICODE_DIGEST };
type Reason = 'script' | 'format-control' | 'symbol' | 'mark-sequence';
export interface DocumentLayoutIssue {
  code: 'unsupported-text-layout' | 'document-language-required'; reason: Reason; script?: string;
  fieldIndex: number; runIndex: number; scalarIndex: number; codePoint: string;
}
export interface DocumentCluster {
  text: string; language: string; bold: boolean;
  source: Array<{ runIndex: number; start: number; end: number }>;
}
const scriptTags = ['Arab', 'Hebr', 'Mymr', 'Sinh', 'Syrc', 'Thaa', 'Grek', 'Cyrl', 'Deva', 'Thai', 'Khmr'];
const range = (cp: number, a: number, b: number) => cp >= a && cp <= b;
function flags(cp: number): number {
  let lo = 0; let hi = DOCUMENT_UNICODE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1; const [a, b, value] = DOCUMENT_UNICODE_RANGES[mid];
    if (cp < a) hi = mid - 1; else if (cp > b) lo = mid + 1; else return value;
  }
  return 0;
}
function regional(language: string): boolean { return /^(?:ja|ko)(?:-|$)|^zh-Han[st](?:-|$)/.test(language); }
function cjkPunctuation(cp: number): boolean {
  return range(cp, 0x3001, 0x3002) || range(cp, 0x3008, 0x3011) || range(cp, 0x3014, 0x301c)
    || cp === 0x30fb || range(cp, 0xff01, 0xff20) || range(cp, 0xff3b, 0xff40) || range(cp, 0xff5b, 0xff65);
}

/** Fixed explicit clusterer for the closed R6 repertoire. No ICU, runtime Unicode regex, font or filesystem I/O. */
export function admitDocumentText(text: DocumentText, fieldIndex = 0): { clusters: DocumentCluster[]; issues: DocumentLayoutIssue[] } {
  const clusters: DocumentCluster[] = [];
  const issues = new Map<string, DocumentLayoutIssue>();
  let cursor = 0;
  while (cursor < text.length) {
    const first = text[cursor];
    const scalars: Array<{ char: string; cp: number; bits: number; runIndex: number; scalarIndex: number }> = [];
    do {
      const runIndex = cursor; let scalarIndex = 0;
      for (const char of text[cursor].text) scalars.push({ char, cp: char.codePointAt(0)!, bits: flags(char.codePointAt(0)!), runIndex, scalarIndex: scalarIndex++ });
      cursor++;
    } while (cursor < text.length && text[cursor].language === first.language && text[cursor].bold === first.bold);
    const issue = (index: number, reason: Reason, code: DocumentLayoutIssue['code'] = 'unsupported-text-layout', script?: string) => {
      const scalar = scalars[index];
      const tag = script ?? (reason === 'script' ? scriptTags[(scalar.bits >>> 12) - 1] ?? 'Other' : undefined);
      const key = `${code}/${reason}/${tag ?? ''}`;
      if (!issues.has(key)) issues.set(key, { code, reason, ...(tag ? { script: tag } : {}), fieldIndex,
        runIndex: scalar.runIndex, scalarIndex: scalar.scalarIndex, codePoint: `U+${scalar.cp.toString(16).toUpperCase().padStart(4, '0')}` });
    };
    for (let index = 0; index < scalars.length;) {
      const start = index; const current = scalars[index]; const cp = current.cp; const bits = current.bits;
      const forbidden = (value: typeof current) => !!(value.bits & (F.format | F.ignorable)) || range(value.cp, 0xfe00, 0xfe0f) || range(value.cp, 0xe0100, 0xe01ef);
      if (forbidden(current)) { issue(index++, 'format-control'); continue; }
      let length = 1; let allowed = false;
      if (range(cp, 0x1100, 0x1112)) {
        if (scalars[index + 1] && range(scalars[index + 1].cp, 0x1161, 0x1175)) {
          length = scalars[index + 2] && range(scalars[index + 2].cp, 0x11a8, 0x11c2) ? 3 : 2; allowed = true;
        } else { issue(index++, 'mark-sequence'); continue; }
      } else if ((bits & F.letter) && ((bits & F.Latin) || range(cp, 0x0370, 0x052f))) {
        allowed = true;
        while (length <= 2 && scalars[index + length]) {
          const next = scalars[index + length];
          if (!range(next.cp, 0x0300, 0x036f) || !(next.bits & F.mark) || !(next.bits & (F.Inherited | F.latinScx)) || forbidden(next)) break;
          length++;
        }
      } else if ((bits & F.letter) && (bits & (F.Hiragana | F.Katakana))) {
        allowed = true;
        const next = scalars[index + 1];
        if (next && (next.cp === 0x3099 || next.cp === 0x309a) && /^ja(?:-|$)/.test(first.language) && !forbidden(next)) length = 2;
      } else if (((bits & F.letter) && (bits & F.Han)) || cp === 0x3007) {
        if (!regional(first.language)) { issue(index++, 'script', 'document-language-required', 'Hani'); continue; }
        allowed = true;
      } else if (range(cp, 0xac00, 0xd7a3) || range(cp, 0x3131, 0x318e)) allowed = true;
      else if (cp === 0x30fc) allowed = !!(bits & F.kanaScx) && /^ja(?:-|$)/.test(first.language);
      else if (cjkPunctuation(cp)) {
        if (!regional(first.language)) { issue(index++, 'symbol', 'document-language-required'); continue; }
        allowed = true;
      } else if (range(cp, 0x20, 0x7e) || cp === 0x0a || [0xa0, 0x202f, 0x3000].includes(cp)
        || !(bits & F.mark) && (range(cp, 0xa0, 0xff) || range(cp, 0x2000, 0x206f)
          || range(cp, 0x20a0, 0x22ff) || range(cp, 0x2700, 0x27bf))) allowed = true;
      if (!allowed) { issue(index++, bits & F.mark ? 'mark-sequence' : bits & F.letter ? 'script' : 'symbol'); continue; }
      const source: DocumentCluster['source'] = [];
      for (let offset = 0; offset < length; offset++) {
        const scalar = scalars[index + offset]; const previous = source.at(-1);
        if (previous?.runIndex === scalar.runIndex) previous.end = scalar.scalarIndex + 1;
        else source.push({ runIndex: scalar.runIndex, start: scalar.scalarIndex, end: scalar.scalarIndex + 1 });
      }
      index += length;
      clusters.push({ text: scalars.slice(start, index).map(scalar => scalar.char).join(''), language: first.language, bold: first.bold, source });
    }
  }
  return { clusters, issues: [...issues.values()] };
}

export function admitDocumentLayout(document: CanonicalDocument) {
  const fields = documentTexts(document).map((text, index) => admitDocumentText(text, index));
  return { ok: fields.every(field => field.issues.length === 0), fields, policy: DOCUMENT_LAYOUT_POLICY, unicodeDigest: DOCUMENT_UNICODE_DIGEST };
}

/** Bounded host-owned position label; never include source text or a worker's raw error. */
export function documentIssueLocation(document: CanonicalDocument, issue: DocumentLayoutIssue): string {
  const text = documentTexts(document)[issue.fieldIndex];
  for (const key of ['title', 'subtitle', 'header', 'footer'] as const) if (document[key] === text) return key;
  const index = document.blocks.findIndex(block => {
    if (block.type === 'heading' || block.type === 'paragraph') return block.content === text;
    if (block.type === 'clause') return block.content === text || block.label === text;
    if (block.type === 'table') return block.headers.includes(text) || block.rows.some(row => row.includes(text));
    return block.type === 'signature' && block.parties.some(party => party.label === text || party.name === text);
  });
  return index >= 0 ? `block ${index + 1}, run ${issue.runIndex + 1}, character ${issue.scalarIndex + 1}` : `text field ${issue.fieldIndex + 1}`;
}

/** The DOCX warning is computed from canonical input, never accepted from the model or a worker. */
export function documentLayoutWarnings(document: CanonicalDocument) {
  const issues = admitDocumentLayout(document).fields.flatMap(field => field.issues);
  return issues.length ? [{ code: 'reader-layout-unverified' as const,
    scripts: [...new Set(issues.flatMap(issue => issue.script ? [issue.script] : []))].sort().slice(0, 32),
    reasons: [...new Set(issues.map(issue => issue.reason))].sort() }] : [];
}
