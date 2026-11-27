import { SaxesParser } from 'saxes';
import { officeXmlElements } from './OfficeXmlElements';
import { encodeOfficeXml } from './OfficeTextPatch';

const chartNamespaces = new Set(['http://schemas.openxmlformats.org/drawingml/2006/chart', 'http://purl.oclc.org/ooxml/drawingml/chart']);
// Cached chart data never needs external workbooks, URLs, UNC paths, defined names or function evaluation.
const localRange = /^(?:(?:'(?:[^'\\/:?*\[\]\r\n]|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!)?\$?[A-Z]{1,3}\$?[1-9][0-9]*(?::\$?[A-Z]{1,3}\$?[1-9][0-9]*)?$/iu;

/** Preserve the required formula node/schema while making nonlocal/active references inert; draw the existing cache. */
export function passiveChartFormulas(bytes: Buffer, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const patches: Array<{ start: number; end: number; text: string }> = [];
  for (const element of parsed.elements) {
    if (!chartNamespaces.has(element.tag.uri) || element.tag.local !== 'f') continue;
    let nested = false; for (let parent = element.parent; parent; parent = parent.parent) if (chartNamespaces.has(parent.tag.uri) && parent.tag.local === 'f') nested = true;
    if (nested) continue;
    let formula = '';
    if (!element.children.length && !element.tag.isSelfClosing) {
      const reader = new SaxesParser({ xmlns: false, fragment: true }); reader.on('text', text => { formula += text; }); reader.on('cdata', text => { formula += text; });
      reader.write(parsed.decoded.xml.slice(element.openEnd, parsed.decoded.xml.lastIndexOf('</', element.end - 1))).close();
    }
    if (localRange.test(formula.trim()) && !/_x[0-9a-f]{4}_/i.test(formula)) continue;
    const suffix = /(\$?[A-Z]{1,3}\$?[1-9][0-9]*(?::\$?[A-Z]{1,3}\$?[1-9][0-9]*)?)$/i.exec(formula.trim())?.[1] ?? '$A$1';
    const opening = parsed.decoded.xml.slice(element.start, element.openEnd).replace(/\/\s*>$/, '>');
    patches.push({ start: element.start, end: element.end, text: opening + 'Sheet1!' + suffix + `</${element.tag.name}>` });
  }
  if (!patches.length) return { bytes, neutralized: 0 };
  const chunks: string[] = []; let at = 0;
  for (const patch of patches) { if (patch.start < at) throw Error('render-copy-chart-overlap'); chunks.push(parsed.decoded.xml.slice(at, patch.start), patch.text); at = patch.end; }
  chunks.push(parsed.decoded.xml.slice(at)); const result = encodeOfficeXml({ ...parsed.decoded, xml: chunks.join('') }); officeXmlElements(result, progress);
  return { bytes: result, neutralized: patches.length };
}
