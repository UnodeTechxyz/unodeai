// Fixed theme-token edits, preserving unselected XML and actual output readback.
import { OFFICE_NS } from './OfficePackage';
import { officeXmlElements, type OfficeXmlElement } from './OfficeXmlElements';
import { encodeOfficeXml } from './OfficeTextPatch';
import { OfficeEditFailure } from './OfficeEditContracts';
export const THEME_COLOR_KEYS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'] as const;
export type ThemeColors = Partial<Record<typeof THEME_COLOR_KEYS[number], string>>;
export type ThemeFonts = Partial<Record<'major' | 'minor', Partial<Record<'latin' | 'ea' | 'cs', string>>>>;
export interface OfficeThemeTokensEdit { op: 'set_theme_tokens'; target_ref: string; colors?: ThemeColors; fonts?: ThemeFonts }
export function validateOfficeThemeTokensEdit(raw: Record<string, unknown>): OfficeThemeTokensEdit {
  const invalid = (): never => { throw new OfficeEditFailure('invalid-office-edits'); };
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const xml = (value: unknown): value is string => typeof value === 'string' && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value);
  if (Object.keys(raw).some(key => !['op', 'target_ref', 'colors', 'fonts'].includes(key)) || raw.op !== 'set_theme_tokens'
    || typeof raw.target_ref !== 'string' || !/^P[1-9]\d*$/.test(raw.target_ref)) return invalid();
  const colors: ThemeColors = {}; const fonts: ThemeFonts = {};
  if (raw.colors !== undefined) {
    if (!object(raw.colors) || !Object.keys(raw.colors).length) return invalid();
    for (const [key, value] of Object.entries(raw.colors)) {
      if (!(THEME_COLOR_KEYS as readonly string[]).includes(key) || typeof value !== 'string' || !/^[0-9a-f]{6}$/i.test(value)) return invalid();
      colors[key as keyof ThemeColors] = value.toUpperCase();
    }
  }
  if (raw.fonts !== undefined) {
    if (!object(raw.fonts) || !Object.keys(raw.fonts).length) return invalid();
    for (const [key, values] of Object.entries(raw.fonts)) {
      if (key !== 'major' && key !== 'minor' || !object(values) || !Object.keys(values).length) return invalid();
      const family: NonNullable<ThemeFonts['major']> = {};
      for (const [script, value] of Object.entries(values)) {
        if (script !== 'latin' && script !== 'ea' && script !== 'cs' || !xml(value)) return invalid();
        family[script] = value;
      }
      fonts[key] = family;
    }
  }
  if (!Object.keys(colors).length && !Object.keys(fonts).length) return invalid();
  return { op: 'set_theme_tokens', target_ref: raw.target_ref, ...(raw.colors === undefined ? {} : { colors }), ...(raw.fonts === undefined ? {} : { fonts }) };
}
const is = (element: OfficeXmlElement, local: string) => OFFICE_NS.a.includes(element.tag.uri) && element.tag.local === local;
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;').replaceAll('\t', '&#9;');
const fail = (): never => { throw new OfficeEditFailure('unsupported-edit-target'); };
function one(parent: OfficeXmlElement, local: string) { const found = parent.children.filter(element => is(element, local)); return found.length === 1 ? found[0] : fail(); }
/** Only selected theme tokens change. Keep supplementary font maps, scheme names and all unrelated XML lexical. */
export function setOfficeThemeTokens(bytes: Buffer, edit: OfficeThemeTokensEdit, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const root = parsed.elements[0];
  if (!root || !is(root, 'theme') && !is(root, 'themeOverride')) return fail();
  const base = is(root, 'theme') ? one(root, 'themeElements') : root;
  const patches: Array<{ start: number; end: number; text: string }> = [];
  for (const [key, color] of Object.entries(edit.colors ?? {})) {
    progress(); const slot = one(one(base, 'clrScheme'), key); const current = slot.children;
    if (current.length === 1 && is(current[0], 'srgbClr') && !current[0].children.length
      && Object.values(current[0].tag.attributes).find(attribute => !attribute.uri && attribute.local === 'val')?.value.toUpperCase() === color.toUpperCase()) continue;
    // Preserve slot attributes/namespaces; replace its actual color (including transforms) with explicit RGB.
    const opening = parsed.decoded.xml.slice(slot.start, slot.openEnd).replace(/\/>$/, '>');
    patches.push({ start: slot.start, end: slot.end, text: `${opening}<ot:srgbClr xmlns:ot="${slot.tag.uri}" val="${color.toUpperCase()}"/></${slot.tag.name}>` });
  }
  for (const [family, fonts] of Object.entries(edit.fonts ?? {})) for (const [script, typeface] of Object.entries(fonts)) {
    progress(); const font = one(one(one(base, 'fontScheme'), family === 'major' ? 'majorFont' : 'minorFont'), script);
    const attribute = Object.values(font.tag.attributes).find(value => !value.uri && value.local === 'typeface');
    if (attribute?.value === typeface) continue;
    let opening = parsed.decoded.xml.slice(font.start, font.openEnd);
    // Match XML attributes, including quoted >, without rebuilding optional pitch/charset/panose metadata.
    const pattern = /([^\s=<>/]+)\s*=\s*("[^"]*"|'[^']*')/g; let match: RegExpExecArray | null; let changed = false;
    while ((match = pattern.exec(opening))) if (match[1] === 'typeface') {
      const valueAt = match.index + match[0].indexOf(match[2]);
      opening = opening.slice(0, valueAt) + `"${escape(typeface)}"` + opening.slice(valueAt + match[2].length); changed = true; break;
    }
    if (!changed) opening = opening.replace(/\/?>(?=$)/, end => ` typeface="${escape(typeface)}"${end}`);
    patches.push({ start: font.start, end: font.openEnd, text: opening });
  }
  if (!patches.length) return bytes;
  const chunks: string[] = []; let at = 0;
  for (const patch of patches.sort((a, b) => a.start - b.start)) { if (patch.start < at) return fail(); chunks.push(parsed.decoded.xml.slice(at, patch.start), patch.text); at = patch.end; }
  chunks.push(parsed.decoded.xml.slice(at)); const output = encodeOfficeXml({ ...parsed.decoded, xml: chunks.join('') });
  // Verify actual output rather than echoing requested token values.
  const checked = officeXmlElements(output, progress); const checkedBase = is(checked.elements[0], 'theme') ? one(checked.elements[0], 'themeElements') : checked.elements[0];
  for (const [key, color] of Object.entries(edit.colors ?? {})) {
    const rgb = one(one(one(checkedBase, 'clrScheme'), key), 'srgbClr');
    if (Object.values(rgb.tag.attributes).find(value => !value.uri && value.local === 'val')?.value.toUpperCase() !== color.toUpperCase()) throw new OfficeEditFailure('office-output-check-failed');
  }
  for (const [family, fonts] of Object.entries(edit.fonts ?? {})) for (const [script, typeface] of Object.entries(fonts)) {
    const font = one(one(one(checkedBase, 'fontScheme'), family === 'major' ? 'majorFont' : 'minorFont'), script);
    if (Object.values(font.tag.attributes).find(value => !value.uri && value.local === 'typeface')?.value !== typeface) throw new OfficeEditFailure('office-output-check-failed');
  }
  return output;
}
