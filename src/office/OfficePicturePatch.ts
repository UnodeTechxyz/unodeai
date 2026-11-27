import { SaxesParser, type SaxesTagNS } from 'saxes';
import { OFFICE_NS, OFFICE_REL } from './OfficePackage';
import { decodeOfficeXml, encodeOfficeXml } from './OfficeTextPatch';
import { officeXmlOpening, officeXmlAttribute } from './OfficeXmlMutations';
import { OfficeEditFailure } from './OfficeEditContracts';
import { fitOfficePicture, type PictureFit } from './OfficePictureFit';
import type { InheritedPictureGeometry } from './OfficePictureGeometry';
const ns = (tag: SaxesTagNS | undefined, kind: 'a' | 'p', local: string) => !!tag && OFFICE_NS[kind].includes(tag.uri) && tag.local === local;
const fail = (): never => { throw new OfficeEditFailure('unsupported-edit-target'); };
interface Element { tag: SaxesTagNS; start: number; openEnd: number; end: number; parent?: Element }

/** Fixed picture-only patch. Shape order follows inventory, including groups and excluded MC branches. */
export function patchOfficePicture(bytes: Buffer, target: string, relationship: string, width: number, height: number,
  spec: PictureFit & { alt_text?: string }, progress: () => void, inherited?: InheritedPictureGeometry): Buffer {
  const value = decodeOfficeXml(bytes); const parser = new SaxesParser({ xmlns: true }); const stack: Element[] = [];
  const elements: Element[] = []; let selected: Element | undefined; let count = 0; let skip = 0; let start = 0;
  parser.on('doctype', () => { throw new OfficeEditFailure('unsupported-xml-dtd'); });
  parser.on('xmldecl', declaration => {
    const encoding = declaration.encoding?.toLowerCase();
    if (encoding && encoding !== value.encoding && !(encoding === 'utf-16' && value.encoding.startsWith('utf-16'))) throw new OfficeEditFailure('unsupported-xml-encoding');
  });
  parser.on('opentagstart', () => { start = value.xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => {
    const element: Element = { tag, start, openEnd: parser.position, end: parser.position, parent: stack.at(-1) }; stack.push(element);
    if (skip) { skip++; return; }
    if (tag.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && tag.local === 'AlternateContent') { skip = 1; return; }
    if (OFFICE_NS.p.includes(tag.uri) && ['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp'].includes(tag.local)) {
      if (`O${++count}` === target.split('-').at(-1)) { if (tag.local !== 'pic') return fail(); selected = element; }
    }
    if (selected && (element === selected || stack.includes(selected))) elements.push(element);
  });
  parser.on('closetag', () => { const element = stack.pop()!; element.end = parser.position; if (skip) skip--; });
  for (let at = 0; at < value.xml.length; at += 65536) { progress(); parser.write(value.xml.slice(at, at + 65536)); } parser.close();
  if (!selected) return fail();
  const single = (items: Element[]) => items.length === 1 ? items[0] : fail();
  const direct = (element: Element, kind: 'p' | 'a', local: string) => elements.filter(item => item.parent === element && ns(item.tag, kind, local));
  const fill = single(direct(selected, 'p', 'blipFill')); const blip = single(direct(fill, 'a', 'blip'));
  const properties = single(direct(selected, 'p', 'spPr')); const transforms = direct(properties, 'a', 'xfrm'); if (transforms.length > 1) return fail();
  const transform = transforms[0]; const offsets = transform ? direct(transform, 'a', 'off') : []; const extents = transform ? direct(transform, 'a', 'ext') : [];
  if (offsets.length > 1 || extents.length > 1) return fail(); const off = offsets[0]; const ext = extents[0];
  const integer = (element: Element | undefined, attr: string, field: 'x' | 'y' | 'w' | 'h') => {
    const raw = element?.tag.attributes[attr]?.value;
    if (raw === undefined) { const fallback = inherited?.frame[field]; if (fallback !== undefined) return fallback; throw new OfficeEditFailure('picture-geometry-unavailable'); }
    if (!/^-?\d+$/.test(raw)) return fail(); return BigInt(raw);
  };
  const frame = { x: integer(off, 'x', 'x'), y: integer(off, 'y', 'y'), w: integer(ext, 'cx', 'w'), h: integer(ext, 'cy', 'h') };
  const child = (element: Element, xml: string) => {
    if (element.tag.isSelfClosing) return value.xml.slice(0, element.start) + value.xml.slice(element.start, element.openEnd - 2) + '>' + xml + `</${element.tag.name}>` + value.xml.slice(element.end);
    return value.xml.slice(0, element.openEnd) + xml + value.xml.slice(element.openEnd);
  };
  if (!transform || !off || !ext) {
    const offset = `<a:off xmlns:a="${blip.tag.uri}" x="${frame.x}" y="${frame.y}"/>`;
    const extent = `<a:ext xmlns:a="${blip.tag.uri}" cx="${frame.w}" cy="${frame.h}"/>`;
    let normalized: string;
    if (!transform) {
      const attrs = Object.entries(inherited?.transform ?? {}).map(([name, data]) => ` ${name}="${officeXmlAttribute(data)}"`).join('');
      normalized = child(properties, `<a:xfrm xmlns:a="${blip.tag.uri}"${attrs}>${offset}${extent}</a:xfrm>`);
    } else if (!off) normalized = child(transform, offset + (!ext ? extent : ''));
    else normalized = value.xml.slice(0, off.end) + extent + value.xml.slice(off.end);
    return patchOfficePicture(encodeOfficeXml({ ...value, xml: normalized }), target, relationship, width, height, spec, progress);
  }
  if (frame.w <= 0n || frame.h <= 0n || direct(fill, 'a', 'tile').length) return fail();
  const fit = fitOfficePicture(frame, width, height, spec);
  const embed = Object.values(blip.tag.attributes).find(attribute => attribute.local === 'embed' && OFFICE_REL.includes(attribute.uri));
  // Linked pictures are not fetched. The selected source must be an independent embedded picture.
  if (!embed || Object.values(blip.tag.attributes).some(attribute => attribute.local === 'link' && OFFICE_REL.includes(attribute.uri))) return fail();
  const patches: Array<{ start: number; end: number; text: string }> = [];
  // Office's SVG extension overrides the ordinary blip fallback. Remove only that selected picture's known extension;
  // keep the original SVG part and relationship intact for other objects and source preservation.
  const svgExtensions = new Set(elements.filter(element => element.tag.uri === 'http://schemas.microsoft.com/office/drawing/2016/SVG/main'
    && element.tag.local === 'svgBlip' && ns(element.parent?.tag, 'a', 'ext') && ns(element.parent?.parent?.tag, 'a', 'extLst')
    && element.parent?.parent?.parent === blip).map(element => element.parent!));
  for (const extension of svgExtensions) patches.push({ start: extension.start, end: extension.end, text: '' });
  const attributes = (element: Element, attrs: Record<string, string>) => {
    let opening = value.xml.slice(element.start, element.openEnd);
    for (const [name, data] of Object.entries(attrs)) opening = officeXmlOpening(opening, name, data);
    patches.push({ start: element.start, end: element.openEnd, text: opening });
  };
  attributes(blip, { [embed.name]: relationship }); attributes(off, { x: String(fit.frame.x), y: String(fit.frame.y) });
  attributes(ext, { cx: String(fit.frame.w), cy: String(fit.frame.h) });
  const crops = direct(fill, 'a', 'srcRect'); if (crops.length > 1) return fail();
  const crop = Object.fromEntries(Object.entries(fit.crop).map(([key, number]) => [key, String(number)]));
  if (crops.length) attributes(crops[0], crop);
  else {
    const text = `<a:srcRect xmlns:a="${blip.tag.uri}" l="${crop.l}" t="${crop.t}" r="${crop.r}" b="${crop.b}"/>`;
    patches.push({ start: blip.end, end: blip.end, text });
  }
  const stretch = direct(fill, 'a', 'stretch'); if (stretch.length > 1) return fail();
  if (stretch.length) {
    const rectangle = direct(stretch[0], 'a', 'fillRect'); if (rectangle.length > 1) return fail();
    if (rectangle.length) attributes(rectangle[0], { l: '0', t: '0', r: '0', b: '0' });
    else {
      const element = stretch[0]; const xml = `<a:fillRect xmlns:a="${blip.tag.uri}"/>`;
      const text = element.tag.isSelfClosing ? value.xml.slice(element.start, element.openEnd - 2) + '>' + xml + `</${element.tag.name}>`
        : value.xml.slice(element.start, element.openEnd) + xml + value.xml.slice(element.openEnd, element.end);
      patches.push({ start: element.start, end: element.end, text });
    }
  } else {
    const text = `<a:stretch xmlns:a="${blip.tag.uri}"><a:fillRect/></a:stretch>`;
    const close = value.xml.lastIndexOf('</', fill.end - 1); if (fill.tag.isSelfClosing || close < fill.openEnd) return fail();
    patches.push({ start: close, end: close, text });
  }
  if (spec.alt_text !== undefined) {
    const nv = single(direct(selected, 'p', 'nvPicPr')); attributes(single(direct(nv, 'p', 'cNvPr')), { descr: spec.alt_text });
  }
  let at = 0; const chunks: string[] = [];
  for (const patch of patches.sort((a, b) => a.start - b.start)) {
    if (patch.start < at) return fail(); chunks.push(value.xml.slice(at, patch.start), patch.text); at = patch.end;
  }
  chunks.push(value.xml.slice(at)); const xml = chunks.join(''); const checked = new SaxesParser({ xmlns: true });
  try { for (let at = 0; at < xml.length; at += 65536) { progress(); checked.write(xml.slice(at, at + 65536)); } checked.close(); }
  catch { throw new OfficeEditFailure('office-output-check-failed'); }
  return encodeOfficeXml({ ...value, xml });
}
