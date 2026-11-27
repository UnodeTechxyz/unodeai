// Fixed worker workbook writer; no application invocation or formula evaluation.
import { writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { ReadOnlyOpc, opcPartName, opcRelationshipsPart } from '../content/OpcReadPackage';
import { inspectXlsxInventory, SHEET_NS } from '../content/XlsxInventory';
import { xmlAttribute, spreadsheetString, spreadsheetStringXml } from '../content/WorkbookXml';
import { columnName } from '../content/WorkbookPage';
import { decodeOfficeXml, encodeOfficeXml } from './OfficeTextPatch';
import { mutateOfficeXml, officeXmlAttribute } from './OfficeXmlMutations';
import { OfficeEditFailure } from './OfficeEditContracts';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fail = (): never => { throw new OfficeEditFailure('unsupported-package-preservation'); };
export type ChartSheetCell = string | number | null;
export interface ChartSheetResult { bytes: Buffer; sheet: string; preservedParts: number; preservationDigest: string; signaturesPresent: boolean }

/** Internal blank workbook used when the chart has only literal caches or an external data link; never fetch that link. */
export async function emptyOfficeChartWorkbook(): Promise<Buffer> {
  const zip = new JSZip(); const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  zip.file('[Content_Types].xml', `<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="${PKG}"><Relationship Id="main" Type="${REL[0]}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<workbook xmlns="${ns}"><sheets/></workbook>`); zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${PKG}"/>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function checkCells(pkg: ReadOnlyOpc, part: string, rows: readonly (readonly ChartSheetCell[])[]): Promise<void> {
  const seen = new Set<string>(); let cell: { ref: string; type?: string; raw: string } | undefined; let value = false;
  await pkg.xml(part, { open(tag) {
    if (!SHEET_NS.has(tag.uri)) return;
    if (tag.local === 'c') { const ref = xmlAttribute(tag, 'r'); if (!ref || seen.has(ref)) return fail(); seen.add(ref); cell = { ref, type: xmlAttribute(tag, 't'), raw: '' }; }
    if (tag.local === 't' || tag.local === 'v') value = true;
  }, text(text) { if (cell && value) cell.raw += text; }, close(tag) {
    if (!SHEET_NS.has(tag.uri)) return;
    if (tag.local === 't' || tag.local === 'v') value = false;
    if (tag.local === 'c') {
      if (!cell) return fail(); const match = /^([A-Z]+)([1-9]\d*)$/.exec(cell.ref); if (!match) return fail();
      let column = 0; for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
      const row = Number(match[2]); if (row > rows.length || column > rows[0].length) return fail();
      const expected = rows[row - 1][column - 1];
      if (expected === null ? cell.type !== undefined || cell.raw !== '' : typeof expected === 'number' ? cell.type !== undefined || cell.raw !== String(expected)
        : cell.type !== 'inlineStr' || spreadsheetString(cell.raw).text !== expected) return fail();
      cell = undefined;
    }
  } });
  if (seen.size !== rows.length * rows[0].length) return fail();
}

function appendSheet(bytes: Buffer, namespace: string, child: string, progress: () => void): Buffer {
  const decoded = decodeOfficeXml(bytes); const parser = new SaxesParser({ xmlns: true }); let start = 0; let depth = 0;
  let opening: { start: number; end: number; name: string; selfClosing: boolean } | undefined; let end = -1; let count = 0;
  parser.on('doctype', fail); parser.on('opentagstart', () => { start = decoded.xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => { depth++; if (depth === 2 && tag.uri === namespace && tag.local === 'sheets') {
    count++; opening = { start, end: parser.position, name: tag.name, selfClosing: tag.isSelfClosing };
  } });
  parser.on('closetag', tag => { if (depth === 2 && tag.uri === namespace && tag.local === 'sheets') end = tag.isSelfClosing ? parser.position : decoded.xml.lastIndexOf('</', parser.position - 1); depth--; });
  for (let at = 0; at < decoded.xml.length; at += 65536) { progress(); parser.write(decoded.xml.slice(at, at + 65536)); } parser.close();
  if (count !== 1 || !opening || end < 0) return fail();
  const xml = opening.selfClosing ? decoded.xml.slice(0, opening.end - 2) + '>' + child + `</${opening.name}>` + decoded.xml.slice(opening.end)
    : decoded.xml.slice(0, end) + child + decoded.xml.slice(end);
  return encodeOfficeXml({ ...decoded, xml });
}

/** Clone an actual embedded workbook; retain every original worksheet, add a chart-owned data sheet. */
export async function addOfficeChartSheet(source: Uint8Array, directory: string, rows: readonly (readonly ChartSheetCell[])[],
  ratio: number, floor: number, progress: () => void): Promise<ChartSheetResult> {
  const columns = rows[0]?.length ?? 0;
  if (!rows.length || rows.length > 1048576 || !columns || columns > 16384 || rows.some(row => row.length !== columns
    || row.some(value => value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))))) return fail();
  const sourceFile = join(directory, `chart-source-${randomUUID()}.xlsx`); await writeFile(sourceFile, source, { flag: 'wx' });
  const pkg = await ReadOnlyOpc.open(sourceFile, ratio, floor, progress);
  try {
    const inventory = await inspectXlsxInventory(pkg); if (inventory.macroContentPresent) throw new OfficeEditFailure('macro-edit-unavailable');
    const defaults = new Map<string, string>(); const overrides = new Map<string, string>(); let typeDepth = 0;
    await pkg.xml('/[CONTENT_TYPES].XML', { open(tag) { typeDepth++; if (typeDepth !== 2 || tag.uri !== CT) return;
      const mime = xmlAttribute(tag, 'ContentType'); if (!mime) return;
      if (tag.local === 'Override') { const name = xmlAttribute(tag, 'PartName'); if (name) overrides.set(opcPartName(name), mime); }
      if (tag.local === 'Default') { const extension = xmlAttribute(tag, 'Extension'); if (extension) defaults.set(extension.toLowerCase(), mime); }
    }, close() { typeDepth--; } });
    const contentType = (part: string) => overrides.get(part) ?? defaults.get(posix.extname(part).slice(1).toLowerCase()) ?? '';
    if (/macroenabled/i.test(contentType(inventory.workbookPart)) || pkg.names().some(name => /vbaproject/i.test(contentType(name)))) throw new OfficeEditFailure('macro-edit-unavailable');
    const before = new Map<string, { member: string; sha256: string }>(); const data = new Map<string, Buffer>();
    for (const name of pkg.names()) {
      const chunks: Buffer[] = []; const digest = createHash('sha256'); for await (const chunk of pkg.bytes(name)) { digest.update(chunk); chunks.push(Buffer.from(chunk)); }
      before.set(name, { member: pkg.memberName(name), sha256: digest.digest('hex') }); data.set(name, Buffer.concat(chunks)); progress();
    }
    const main = inventory.workbookPart; const mainBytes = data.get(main) ?? fail(); let namespace = ''; const ids = new Set<string>();
    const sheetIds = new Set<string>(); let depth = 0;
    await pkg.xml(main, { open(tag) { depth++; if (depth === 1) namespace = tag.uri;
      if (depth === 3 && SHEET_NS.has(tag.uri) && tag.local === 'sheet') { const id = xmlAttribute(tag, 'sheetId'); if (id && /^\d+$/.test(id)) sheetIds.add(String(BigInt(id))); }
    }, close() { depth--; } });
    const relationships = opcRelationshipsPart(main); let relationNamespace = REL[SHEET_NS.has(namespace) && namespace.includes('purl.oclc.org') ? 1 : 0];
    await pkg.xml(relationships, { open(tag) { if (tag.uri === PKG && tag.local === 'Relationship') {
      const id = xmlAttribute(tag, 'Id'); if (id) ids.add(id); const type = xmlAttribute(tag, 'Type');
      const prefix = REL.find(prefix => type === prefix + '/worksheet'); if (prefix) relationNamespace = prefix;
    } } });
    const names = new Set(inventory.sheets.map(sheet => sheet.name.toUpperCase())); let sheet: string;
    do { sheet = 'UnodeChart_' + randomUUID().replaceAll('-', '').slice(0, 16); } while (names.has(sheet.toUpperCase()));
    let id = 1n; while (sheetIds.has(String(id))) id++; if (id > 4294967295n) return fail();
    let rid: string; do { rid = 'rId_' + randomUUID().replaceAll('-', ''); } while (ids.has(rid));
    let member: string; let name: string;
    do { member = posix.join(posix.dirname(pkg.memberName(main)), 'unode-chart-' + randomUUID() + '.xml'); name = opcPartName('/' + member); } while (before.has(name));
    const rowXml: string[] = [];
    for (const [index, values] of rows.entries()) {
      rowXml.push(`<row r="${index + 1}">` + values.map((value, column) => {
        const ref = columnName(column + 1) + (index + 1);
        return value === null ? `<c r="${ref}"/>` : typeof value === 'number' ? `<c r="${ref}"><v>${value}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${spreadsheetStringXml(value)}</t></is></c>`;
      }).join('') + '</row>'); progress();
    }
    const worksheet = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${namespace}"><dimension ref="A1:${columnName(columns)}${rows.length}"/><sheetData>${rowXml.join('')}</sheetData></worksheet>`);
    const validSheet = new SaxesParser({ xmlns: true }); validSheet.write(worksheet.toString('utf8')).close();
    data.set(main, appendSheet(mainBytes, namespace, `<sheet xmlns="${namespace}" xmlns:r="${relationNamespace}" name="${sheet}" sheetId="${id}" r:id="${rid}"/>`, progress));
    const target = posix.relative(posix.dirname('/' + pkg.memberName(main)), '/' + member);
    data.set(relationships, mutateOfficeXml(data.get(relationships) ?? fail(), () => undefined, progress, { namespace: PKG, local: 'Relationships',
      xml: `<Relationship xmlns="${PKG}" Id="${rid}" Type="${relationNamespace}/worksheet" Target="${officeXmlAttribute(target)}"/>` }));
    data.set('/[CONTENT_TYPES].XML', mutateOfficeXml(data.get('/[CONTENT_TYPES].XML') ?? fail(), () => undefined, progress, { namespace: CT, local: 'Types',
      xml: `<Override xmlns="${CT}" PartName="${officeXmlAttribute('/' + member)}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` }));
    if (contentType(main).toLowerCase() === 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml') {
      const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'; let found = false;
      const converted = mutateOfficeXml(data.get('/[CONTENT_TYPES].XML')!, (tag, parents) => {
        const name = xmlAttribute(tag, 'PartName'); if (parents.length !== 1 || tag.uri !== CT || tag.local !== 'Override' || !name || opcPartName(name) !== main) return;
        found = true; return { name: 'ContentType', value: mime };
      }, progress);
      data.set('/[CONTENT_TYPES].XML', found ? converted : mutateOfficeXml(converted, () => undefined, progress, { namespace: CT, local: 'Types',
        xml: `<Override xmlns="${CT}" PartName="${officeXmlAttribute('/' + pkg.memberName(main))}" ContentType="${mime}"/>` }));
    }
    const zip = await JSZip.loadAsync(source, { createFolders: false });
    for (const [member, entry] of Object.entries(zip.files)) if (!entry.dir && (before.get(opcPartName('/' + member))?.member !== member
      || ((entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? member) !== member)) return fail();
    for (const part of [main, relationships, '/[CONTENT_TYPES].XML']) zip.file(before.get(part)?.member ?? fail(), data.get(part)!); zip.file(member, worksheet);
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }, () => progress());
    const output = join(directory, `chart-output-${randomUUID()}.xlsx`); await writeFile(output, bytes, { flag: 'wx' });
    const checked = await ReadOnlyOpc.open(output, ratio, floor, progress);
    try {
      const actual = await inspectXlsxInventory(checked); if (actual.sheets.length !== inventory.sheets.length + 1
        || actual.sheets.at(-1)?.name !== sheet || actual.sheets.at(-1)?.part !== name || checked.names().length !== before.size + 1) return fail();
      await checkCells(checked, name, rows);
      let preservedParts = 0; const preservation = createHash('sha256');
      for (const [part, original] of before) {
        const digest = createHash('sha256'); for await (const chunk of checked.bytes(part)) digest.update(chunk); const actual = digest.digest('hex');
        if (checked.memberName(part) !== original.member || actual !== hash(data.get(part)!)) return fail();
        if (![main, relationships, '/[CONTENT_TYPES].XML'].includes(part)) { preservedParts++; preservation.update(JSON.stringify([original.member, actual])); }
      }
      const newHash = createHash('sha256'); for await (const chunk of checked.bytes(name)) newHash.update(chunk); if (newHash.digest('hex') !== hash(worksheet)) return fail();
      return { bytes, sheet, preservedParts, preservationDigest: preservation.digest('hex'), signaturesPresent: checked.names().some(name => /_XMLSIGNATURES/.test(name)) };
    } finally { checked.close(); }
  } finally { pkg.close(); }
}
