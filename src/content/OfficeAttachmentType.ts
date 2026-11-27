// Fixed worker-only package type identification; original bytes are never rewritten.
import { posix } from 'node:path';
import { ReadOnlyOpc, opcPartName, opcRelationshipTarget } from './OpcReadPackage';
import { xmlAttribute } from './WorkbookXml';

const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', 'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument'];
export const attachmentProfiles = [
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', 'wordprocessingml', 'document'],
  ['dotx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml', 'wordprocessingml', 'document'],
  ['docm', 'application/vnd.ms-word.document.macroenabled.main+xml', 'wordprocessingml', 'document'],
  ['dotm', 'application/vnd.ms-word.template.macroenabledtemplate.main+xml', 'wordprocessingml', 'document'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', 'presentationml', 'presentation'],
  ['potx', 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml', 'presentationml', 'presentation'],
  ['ppsx', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml', 'presentationml', 'presentation'],
  ['pptm', 'application/vnd.ms-powerpoint.presentation.macroenabled.main+xml', 'presentationml', 'presentation'],
  ['potm', 'application/vnd.ms-powerpoint.template.macroenabled.main+xml', 'presentationml', 'presentation'],
  ['ppsm', 'application/vnd.ms-powerpoint.slideshow.macroenabled.main+xml', 'presentationml', 'presentation'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'spreadsheetml', 'workbook'],
  ['xltx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml', 'spreadsheetml', 'workbook'],
  ['xlsm', 'application/vnd.ms-excel.sheet.macroenabled.main+xml', 'spreadsheetml', 'workbook'],
  ['xltm', 'application/vnd.ms-excel.template.macroenabled.main+xml', 'spreadsheetml', 'workbook'],
] as const;
export type OpenXmlAttachmentType = typeof attachmentProfiles[number][0];
const fail = (): never => { throw new Error('unsupported-office-attachment'); };

/** Package type only: original bytes stay unchanged; no complete schema/native/macro-safety claim. */
export async function qualifyOpenXmlAttachment(source: string, ratio: number, floor: number, progress: () => void): Promise<OpenXmlAttachmentType> {
  const zip = await ReadOnlyOpc.open(source, ratio, floor, progress);
  try {
    const overrides = new Map<string, string>(); const defaults = new Map<string, string>(); let depth = 0;
    await zip.xml('/[Content_Types].xml', { open(tag) {
      depth++; if (depth === 1 && (tag.uri !== CT || tag.local !== 'Types')) return fail();
      if (depth !== 2 || tag.uri !== CT) return;
      if (tag.local === 'Override') {
        const part = xmlAttribute(tag, 'PartName'); const mime = xmlAttribute(tag, 'ContentType'); if (!part || !mime) return fail();
        const key = opcPartName(part); if (overrides.has(key)) return fail(); overrides.set(key, mime.toLowerCase());
      } else if (tag.local === 'Default') {
        const extension = xmlAttribute(tag, 'Extension')?.toLowerCase(); const mime = xmlAttribute(tag, 'ContentType');
        if (!extension || !mime || defaults.has(extension)) return fail(); defaults.set(extension, mime.toLowerCase());
      }
    }, close() { depth--; } });
    const roots: string[] = []; const ids = new Set<string>(); depth = 0;
    await zip.xml('/_rels/.rels', { open(tag) {
      depth++; if (depth === 1 && (tag.uri !== PKG || tag.local !== 'Relationships')) return fail();
      if (depth !== 2 || tag.uri !== PKG || tag.local !== 'Relationship') return;
      const id = xmlAttribute(tag, 'Id'); if (!id || ids.has(id)) return fail(); ids.add(id);
      if (!REL.includes(xmlAttribute(tag, 'Type') ?? '')) return;
      const target = xmlAttribute(tag, 'Target'); if (!target || xmlAttribute(tag, 'TargetMode')?.toLowerCase() === 'external') return fail();
      roots.push(opcRelationshipTarget('/', target));
    }, close() { depth--; } });
    if (roots.length !== 1) return fail(); const main = roots[0];
    const mime = overrides.get(main) ?? defaults.get(posix.extname(main).slice(1).toLowerCase());
    const profile = attachmentProfiles.find(profile => profile[1] === mime); if (!profile) return fail();
    let root = false;
    await zip.xml(main, { open(tag) {
      if (root) return; root = true;
      if (tag.local !== profile[3] || ![`http://schemas.openxmlformats.org/${profile[2]}/2006/main`, `http://purl.oclc.org/ooxml/${profile[2]}/main`].includes(tag.uri)) return fail();
    } });
    if (!root) return fail(); return profile[0];
  } finally { zip.close(); }
}
