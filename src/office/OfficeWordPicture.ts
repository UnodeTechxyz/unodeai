import { OFFICE_NS, OFFICE_REL } from './OfficePackage';
import { officeXmlElements, type OfficeXmlElement } from './OfficeXmlElements';
import { encodeOfficeXml } from './OfficeTextPatch';
import { officeXmlOpening } from './OfficeXmlMutations';
import { fitOfficePicture, type PictureFit } from './OfficePictureFit';
import { OfficeEditFailure } from './OfficeEditContracts';
export const WORD_PICTURE_NS = ['http://schemas.openxmlformats.org/drawingml/2006/picture', 'http://purl.oclc.org/ooxml/drawingml/picture'];
export const WORD_DRAWING_NS = ['http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing'];
const is = (element: OfficeXmlElement | undefined, namespaces: string[], local: string) => !!element && namespaces.includes(element.tag.uri) && element.tag.local === local;
const fail = (): never => { throw new OfficeEditFailure('unsupported-word-picture'); };
export function wordPictureElements(bytes: Buffer, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress);
  const pictures = parsed.elements.filter(element => {
    if (!is(element, WORD_PICTURE_NS, 'pic')) return false;
    let body = false;
    for (let at: OfficeXmlElement | undefined = element; at; at = at.parent) {
      if (at.tag.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && at.tag.local === 'AlternateContent') return false;
      if (is(at, OFFICE_NS.w, 'body')) body = true;
    }
    return body;
  });
  return { ...parsed, pictures };
}
/** Preserve the Word layout viewport and fit the inner picture in its local coordinates. Native proof pending. */
export function patchWordPicture(bytes: Buffer, ref: string, relationship: string, width: number, height: number,
  spec: PictureFit & { alt_text?: string }, progress: () => void) {
  const parsed = wordPictureElements(bytes, progress); const xml = parsed.decoded.xml;
  const picture = parsed.pictures[Number(ref.replace(/^I/, '')) - 1]; if (!picture) return fail();
  const single = (items: OfficeXmlElement[]) => items.length === 1 ? items[0] : fail();
  const direct = (element: OfficeXmlElement, namespaces: string[], local: string) => element.children.filter(child => is(child, namespaces, local));
  const graphicData = picture.parent; const graphic = graphicData?.parent; const wrapper = graphic?.parent;
  if (!is(graphicData, OFFICE_NS.a, 'graphicData') || !is(graphic, OFFICE_NS.a, 'graphic') || !wrapper || !WORD_DRAWING_NS.includes(wrapper.tag.uri) || !['inline', 'anchor'].includes(wrapper.tag.local)
    || graphicData!.children.filter(child => is(child, WORD_PICTURE_NS, 'pic')).length !== 1) return fail();
  const outerExtent = single(direct(wrapper, WORD_DRAWING_NS, 'extent'));
  const fill = single(direct(picture, WORD_PICTURE_NS, 'blipFill')); const blip = single(direct(fill, OFFICE_NS.a, 'blip'));
  const properties = single(direct(picture, WORD_PICTURE_NS, 'spPr')); const transforms = direct(properties, OFFICE_NS.a, 'xfrm'); if (transforms.length > 1) return fail(); const transform = transforms[0];
  const offsets = transform ? direct(transform, OFFICE_NS.a, 'off') : []; const extents = transform ? direct(transform, OFFICE_NS.a, 'ext') : []; if (offsets.length > 1 || extents.length > 1) return fail(); const offset = offsets[0]; const extent = extents[0];
  const integer = (element: OfficeXmlElement, name: string) => { const value = element.tag.attributes[name]?.value; if (!value || !/^-?\d+$/.test(value)) return fail(); return BigInt(value); };
  if (!transform || !offset || !extent) {
    const off = `<a:off xmlns:a="${blip.tag.uri}" x="0" y="0"/>`; const ext = `<a:ext xmlns:a="${blip.tag.uri}" cx="${integer(outerExtent, 'cx')}" cy="${integer(outerExtent, 'cy')}"/>`;
    const element = transform ?? properties; const children = transform ? (!offset ? off : '') + (!extent ? ext : '') : `<a:xfrm xmlns:a="${blip.tag.uri}">${off}${ext}</a:xfrm>`;
    const insertionAt = transform && offset && !extent ? offset.end : element.openEnd;
    const replacement = element.tag.isSelfClosing ? xml.slice(element.start, element.openEnd).replace(/\/>$/, '>') + children + `</${element.tag.name}>`
      : xml.slice(element.start, insertionAt) + children + xml.slice(insertionAt, element.end);
    return patchWordPicture(encodeOfficeXml({ ...parsed.decoded, xml: xml.slice(0, element.start) + replacement + xml.slice(element.end) }), ref, relationship, width, height, spec, progress);
  }
  const frame = { x: integer(offset, 'x'), y: integer(offset, 'y'), w: integer(extent, 'cx'), h: integer(extent, 'cy') };
  if (frame.w <= 0n || frame.h <= 0n || integer(outerExtent, 'cx') <= 0n || integer(outerExtent, 'cy') <= 0n || direct(fill, OFFICE_NS.a, 'tile').length) return fail();
  const embed = Object.values(blip.tag.attributes).find(attribute => attribute.local === 'embed' && OFFICE_REL.includes(attribute.uri));
  if (!embed || Object.values(blip.tag.attributes).some(attribute => attribute.local === 'link' && OFFICE_REL.includes(attribute.uri))) return fail();
  const fit = fitOfficePicture(frame, width, height, spec); const patches: Array<{ start: number; end: number; text: string }> = [];
  const attributes = (element: OfficeXmlElement, values: Record<string, string>) => { let opening = xml.slice(element.start, element.openEnd); for (const [name, value] of Object.entries(values)) opening = officeXmlOpening(opening, name, value); patches.push({ start: element.start, end: element.openEnd, text: opening }); };
  attributes(blip, { [embed.name]: relationship }); attributes(offset, { x: String(fit.frame.x), y: String(fit.frame.y) }); attributes(extent, { cx: String(fit.frame.w), cy: String(fit.frame.h) });
  for (const extension of blip.children.filter(element => is(element, OFFICE_NS.a, 'extLst')).flatMap(element => element.children).filter(element => is(element, OFFICE_NS.a, 'ext') && element.children.some(child => child.tag.uri === 'http://schemas.microsoft.com/office/drawing/2016/SVG/main' && child.tag.local === 'svgBlip'))) patches.push({ start: extension.start, end: extension.end, text: '' });
  const crops = direct(fill, OFFICE_NS.a, 'srcRect'); if (crops.length > 1) return fail(); const crop = Object.fromEntries(Object.entries(fit.crop).map(([name, value]) => [name, String(value)]));
  if (crops.length) attributes(crops[0], crop); else patches.push({ start: blip.end, end: blip.end, text: `<a:srcRect xmlns:a="${blip.tag.uri}" l="${crop.l}" t="${crop.t}" r="${crop.r}" b="${crop.b}"/>` });
  const stretch = direct(fill, OFFICE_NS.a, 'stretch'); if (stretch.length > 1) return fail();
  const stretchXml = `<a:stretch xmlns:a="${blip.tag.uri}"><a:fillRect/></a:stretch>`;
  if (stretch.length) { const rectangles = direct(stretch[0], OFFICE_NS.a, 'fillRect'); if (rectangles.length > 1) return fail(); if (rectangles.length) attributes(rectangles[0], { l: '0', t: '0', r: '0', b: '0' }); else patches.push({ start: stretch[0].start, end: stretch[0].end, text: stretchXml }); }
  else patches.push({ start: xml.lastIndexOf('</', fill.end - 1), end: xml.lastIndexOf('</', fill.end - 1), text: stretchXml });
  if (spec.alt_text !== undefined) { attributes(single(direct(wrapper, WORD_DRAWING_NS, 'docPr')), { descr: spec.alt_text }); const nv = single(direct(picture, WORD_PICTURE_NS, 'nvPicPr')); attributes(single(direct(nv, WORD_PICTURE_NS, 'cNvPr')), { descr: spec.alt_text }); }
  let at = 0; const chunks: string[] = [];
  for (const patch of patches.sort((a, b) => a.start - b.start)) { if (patch.start < at || patch.start < 0) return fail(); chunks.push(xml.slice(at, patch.start), patch.text); at = patch.end; }
  chunks.push(xml.slice(at)); const output = encodeOfficeXml({ ...parsed.decoded, xml: chunks.join('') }); const checked = wordPictureElements(output, progress);
  if (checked.pictures.length !== parsed.pictures.length) throw new OfficeEditFailure('office-output-check-failed');
  const selected = checked.pictures[parsed.pictures.indexOf(picture)]; const currentFill = single(direct(selected, WORD_PICTURE_NS, 'blipFill')); const currentBlip = single(direct(currentFill, OFFICE_NS.a, 'blip'));
  const currentTransform = single(direct(single(direct(selected, WORD_PICTURE_NS, 'spPr')), OFFICE_NS.a, 'xfrm')); const currentOffset = single(direct(currentTransform, OFFICE_NS.a, 'off')); const currentExtent = single(direct(currentTransform, OFFICE_NS.a, 'ext')); const currentCrop = single(direct(currentFill, OFFICE_NS.a, 'srcRect'));
  if (Object.values(currentBlip.tag.attributes).find(attribute => attribute.local === 'embed' && OFFICE_REL.includes(attribute.uri))?.value !== relationship
    || integer(currentOffset, 'x') !== fit.frame.x || integer(currentOffset, 'y') !== fit.frame.y || integer(currentExtent, 'cx') !== fit.frame.w || integer(currentExtent, 'cy') !== fit.frame.h
    || Object.entries(crop).some(([name, value]) => currentCrop.tag.attributes[name]?.value !== value)) throw new OfficeEditFailure('office-output-check-failed');
  return output;
}
