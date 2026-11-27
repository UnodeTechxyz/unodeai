// Internal namespace-aware Word bookmark/control span selection for preserving text edits.
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { OFFICE_NS } from './OfficePackage';
import { xmlAttribute } from '../content/WorkbookXml';
import { OfficeEditFailure } from './OfficeEditContracts';
interface Frame { tag: SaxesTagNS; start: number; body: boolean; skip: boolean }
export function officeWordRegionSpan(xml: string, ref: string, progress: () => void) {
  const requested = /^([BC])([1-9]\d*)$/.exec(ref); if (!requested) throw new OfficeEditFailure('unsupported-word-region');
  const kind = requested[1]; const wanted = Number(requested[2]); const parser = new SaxesParser({ xmlns: true }); const stack: Frame[] = []; let start = 0; let bookmarks = 0; let controls = 0;
  const active = new Map<string, number>(); const w = (tag: SaxesTagNS | undefined, local: string) => !!tag && OFFICE_NS.w.includes(tag.uri) && tag.local === local;
  const attr = (tag: SaxesTagNS, key: string) => OFFICE_NS.w.map(uri => xmlAttribute(tag, key, uri)).find(value => value !== undefined);
  let control: Frame | undefined; let content: Frame | undefined; let contentCount = 0; let bookmark: Frame | undefined; let bookmarkId: string | undefined;
  let from: number | undefined; let to: number | undefined; let initialParagraph = false;
  parser.on('doctype', () => { throw new OfficeEditFailure('unsupported-xml-dtd'); });
  parser.on('opentagstart', () => { start = xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => {
    const parent = stack.at(-1); const frame: Frame = { tag, start, body: parent?.body || w(tag, 'body'), skip: !!parent?.skip || tag.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && tag.local === 'AlternateContent' };
    if (frame.body && !frame.skip) {
      if (w(tag, 'sdt') && ++controls === wanted && kind === 'C') { control = frame; initialParagraph = stack.some(frame => w(frame.tag, 'p')); }
      if (control && parent === control && w(tag, 'sdtContent')) { content = frame; contentCount++; from = parser.position; }
      if (w(tag, 'bookmarkStart')) {
        const ordinal = ++bookmarks; const id = attr(tag, 'id');
        if (id !== undefined && !active.has(id)) {
          active.set(id, ordinal);
          if (kind === 'B' && ordinal === wanted) {
            // Column bookmarks have a different logical selection than their XML span; do not edit guessed columns.
            if (attr(tag, 'colFirst') !== undefined || attr(tag, 'colLast') !== undefined) throw new OfficeEditFailure('unsupported-word-region');
            bookmark = frame; bookmarkId = id; initialParagraph = stack.some(frame => w(frame.tag, 'p'));
          }
        }
      }
      if (w(tag, 'bookmarkEnd')) { const id = attr(tag, 'id'); if (id !== undefined) { if (kind === 'B' && active.get(id) === wanted && id === bookmarkId) to = frame.start; active.delete(id); } }
    }
    stack.push(frame);
  });
  parser.on('closetag', () => {
    const frame = stack.pop()!; if (frame === bookmark) from = parser.position;
    if (frame === content) to = frame.tag.isSelfClosing ? parser.position : xml.lastIndexOf('</', parser.position - 1);
  });
  for (let offset = 0; offset < xml.length; offset += 65536) { progress(); parser.write(xml.slice(offset, offset + 65536)); } parser.close();
  if (from === undefined || to === undefined || to < from || kind === 'C' && contentCount !== 1) throw new OfficeEditFailure('unsupported-word-region');
  return { start: from, end: to, initialParagraph };
}
