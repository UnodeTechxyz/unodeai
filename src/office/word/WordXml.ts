// Small helpers over the fixed-worker element tree for WordprocessingML parts.
import { OFFICE_NS } from '../OfficePackage';
import type { OfficeXmlElement } from '../OfficeXmlElements';

export const isWordElement = (element: OfficeXmlElement | undefined, local?: string) => !!element && OFFICE_NS.w.includes(element.tag.uri) && (local === undefined || element.tag.local === local);
export const wordAttribute = (element: OfficeXmlElement, local: string) => {
  for (const attribute of Object.values(element.tag.attributes)) if (attribute.local === local && OFFICE_NS.w.includes(attribute.uri)) return attribute.value;
  return undefined;
};
export const attributeIn = (element: OfficeXmlElement, uri: string, local: string) => Object.values(element.tag.attributes).find(attribute => attribute.uri === uri && attribute.local === local)?.value;
export function* wordDescendants(element: OfficeXmlElement): Generator<OfficeXmlElement> { for (const child of element.children) { yield child; yield* wordDescendants(child); } }

const entities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
/** Decoded character content of a text-only element such as w:t or w:delText. */
export function wordElementText(xml: string, element: OfficeXmlElement): string {
  if (element.tag.isSelfClosing || element.children.length) return '';
  const raw = xml.slice(element.openEnd, xml.lastIndexOf('</', element.end - 1));
  return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, cdata: string | undefined, entity: string | undefined) => {
    if (cdata !== undefined) return cdata;
    if (entity!.startsWith('#x')) return String.fromCodePoint(parseInt(entity!.slice(2), 16));
    if (entity!.startsWith('#')) return String.fromCodePoint(parseInt(entity!.slice(1), 10));
    return entities[entity!] ?? whole;
  });
}
