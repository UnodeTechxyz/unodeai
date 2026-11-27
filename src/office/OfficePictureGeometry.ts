import type { SaxesTagNS } from 'saxes';
import { OfficePackage, OFFICE_NS } from './OfficePackage';
import { xmlAttribute } from '../content/WorkbookXml';
import type { PictureFrame } from './OfficePictureFit';
export interface InheritedPictureGeometry { frame: Partial<PictureFrame>; transform: Record<string, string>; namespace: string }
interface Placeholder extends InheritedPictureGeometry { idx: string; type: string; grouped: boolean; hasTransform: boolean }
const ns = (tag: SaxesTagNS | undefined, kind: 'p' | 'a', local: string) => !!tag && OFFICE_NS[kind].includes(tag.uri) && tag.local === local;
const index = (raw = '0') => /^\d+$/.test(raw) ? String(BigInt(raw)) : undefined;
async function placeholders(pkg: OfficePackage, part: string): Promise<Placeholder[]> {
  const parents: SaxesTagNS[] = []; const shapes: Array<{ depth: number; value: Placeholder; placeholder: boolean }> = []; const result: Placeholder[] = [];
  let skip = 0;
  await pkg.zip.xml(part, { open(tag) {
    if (skip) { skip++; return; }
    if (tag.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && tag.local === 'AlternateContent') { skip = 1; return; }
    if (OFFICE_NS.p.includes(tag.uri) && ['sp', 'pic', 'graphicFrame', 'cxnSp'].includes(tag.local)) shapes.push({ depth: parents.length,
      value: { idx: '0', type: 'obj', grouped: parents.some(parent => ns(parent, 'p', 'grpSp')), hasTransform: false, frame: {}, transform: {}, namespace: OFFICE_NS.a[0] }, placeholder: false });
    const shape = shapes.at(-1);
    if (shape) {
      if (ns(tag, 'p', 'ph') && parents.length === shape.depth + 3 && ns(parents.at(-1), 'p', 'nvPr')) {
        shape.placeholder = true; shape.value.idx = index(xmlAttribute(tag, 'idx')) ?? 'invalid'; shape.value.type = xmlAttribute(tag, 'type') ?? 'obj';
      }
      const ownTransform = parents.length === shape.depth + 2 && ns(parents.at(-1), 'p', 'spPr') && ns(tag, 'a', 'xfrm');
      if (ownTransform) {
        shape.value.hasTransform = true;
        shape.value.namespace = tag.uri;
        for (const name of ['rot', 'flipH', 'flipV']) { const value = xmlAttribute(tag, name); if (value !== undefined) shape.value.transform[name] = value; }
      }
      if (parents.length === shape.depth + 3 && ns(parents.at(-1), 'a', 'xfrm') && ns(parents.at(-2), 'p', 'spPr') && OFFICE_NS.a.includes(tag.uri)) {
        for (const [local, attrs] of [['off', [['x', 'x'], ['y', 'y']]], ['ext', [['cx', 'w'], ['cy', 'h']]]] as const) {
          if (tag.local !== local) continue;
          for (const [attr, field] of attrs) { const raw = xmlAttribute(tag, attr); if (raw !== undefined && /^-?\d+$/.test(raw)) shape.value.frame[field] = BigInt(raw); }
        }
      }
    }
    parents.push(tag);
  }, close() {
    if (skip) { skip--; return; } parents.pop(); const shape = shapes.at(-1);
    if (shape && shape.depth === parents.length) { if (shape.placeholder) result.push(shape.value); shapes.pop(); }
  } }); return result;
}
const masterType = (type: string) => type === 'ctrTitle' ? 'title'
  : ['obj', 'subTitle', 'pic', 'chart', 'clipArt', 'dgm', 'media', 'tbl'].includes(type) ? 'body' : type;

/** Slide->layout by idx (MS-OE376 2.1.1161); layout->master by placeholder type/fallback type.
 * Sources: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/8b5c01b6-a623-4952-a8ab-e6a5177e47ec
 * https://python-pptx.readthedocs.io/en/develop/dev/analysis/placeholders/layout-placeholders.html
 * This resolves explicit inherited frame data only, not native rendering or full style inheritance.
 */
export async function inheritedPictureGeometry(pkg: OfficePackage, slide: string, placeholder: unknown): Promise<InheritedPictureGeometry | undefined> {
  if (!placeholder || typeof placeholder !== 'object' || Array.isArray(placeholder)) return;
  const raw = (placeholder as Record<string, unknown>).idx; if (raw !== undefined && typeof raw !== 'string') return;
  const idx = index(raw as string | undefined); if (idx === undefined || idx === '4294967295') return;
  const links = (await pkg.relations(slide)).filter(link => link.kind === 'slideLayout' && !link.external && link.target && pkg.part(link.target));
  if (links.length !== 1) return;
  const layoutPart = links[0].target!; const layouts = (await placeholders(pkg, layoutPart)).filter(item => item.idx === idx && !item.grouped);
  if (layouts.length !== 1) return; const layout = layouts[0];
  if (['x', 'y', 'w', 'h'].every(key => layout.frame[key as keyof PictureFrame] !== undefined)) return layout;
  const masters = (await pkg.relations(layoutPart)).filter(link => link.kind === 'slideMaster' && !link.external && link.target && pkg.part(link.target));
  if (masters.length !== 1) return layout;
  const candidates = (await placeholders(pkg, masters[0].target!)).filter(item => item.type === masterType(layout.type) && !item.grouped);
  if (candidates.length !== 1) return layout;
  const master = candidates[0]; return { frame: { ...master.frame, ...layout.frame }, transform: layout.hasTransform ? layout.transform : master.transform, namespace: layout.namespace };
}
