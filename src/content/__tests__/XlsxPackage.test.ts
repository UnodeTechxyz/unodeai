import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, expect, it } from 'vitest';
import { ReadOnlyOpc, opcPartName, opcRelationshipTarget } from '../OpcReadPackage';
import { readWorkbookXml, spreadsheetString, xmlAttribute } from '../WorkbookXml';
import { inspectXlsxInventory } from '../XlsxInventory';
import { parseXlsxSnapshot } from '../XlsxWorkbook';
import { temporaryFolder, removeTemporaryFolders } from '../../backend/__tests__/pathSafetyFixtures';
import { typedXlsxFixture, forcedZip64 } from './xlsxFixtures';
afterEach(removeTemporaryFolders);
async function open(bytes: Buffer) {
  const root = await temporaryFolder('unode-xlsx-package-'); const file = join(root, 'source'); await fs.writeFile(file, bytes);
  return await ReadOnlyOpc.open(file, 200, 64 * 1024 * 1024, () => {});
}
it('reads a genuine ZIP64 catalogue and resolves workbook relationships to nonstandard part paths', async () => {
  const pkg = await open(forcedZip64(await typedXlsxFixture()));
  try { const inventory = await inspectXlsxInventory(pkg); expect(inventory).toMatchObject({ format: 'xlsx', workbookPart: '/CUSTOM/BOOK.XML' });
    expect(inventory.sheets[0]).toMatchObject({ part: '/DATA/SHEET1.XML' }); }
  finally { pkg.close(); }
});
it('detects selected-part CRC damage without extracting archive paths', async () => {
  const zip = new JSZip(); zip.file('part.xml', '<root/>', { createFolders: false }); const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  const offset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28); bytes[offset + 1] ^= 1;
  const pkg = await open(bytes);
  try { await expect(pkg.xml('/part.xml', {})).rejects.toThrow('corrupt-office-part'); } finally { pkg.close(); }
});
it('rejects ambiguous selected parts and does not turn external relationships into reads', async () => {
  const zip = new JSZip(); zip.file('a.xml', '<root/>'); zip.file('A.xml', '<root/>'); const pkg = await open(await zip.generateAsync({ type: 'nodebuffer' }));
  try { await expect(pkg.xml('/a.xml', {})).rejects.toThrow('missing-or-ambiguous-office-part'); } finally { pkg.close(); }
  expect(opcPartName('/custom/%62ook.xml')).toBe('/CUSTOM/BOOK.XML');
  expect(opcRelationshipTarget('/custom/book.xml', '../data/sheet1.xml')).toBe('/DATA/SHEET1.XML');
  expect(() => opcRelationshipTarget('/custom/book.xml', 'https://invalid.example/private')).toThrow('external-package-target');
});
it.each(['utf-8', 'utf-16le', 'utf-16be'] as const)('preserves namespace attributes and split Unicode XML in %s', async encoding => {
  const xml = `<?xml version="1.0" encoding="${encoding === 'utf-8' ? 'UTF-8' : 'UTF-16'}"?><r xmlns="urn:root" xmlns:p="urn:attr" p:id="7">名😀</r>`;
  let bytes = Buffer.from(encoding === 'utf-8' ? xml : '\ufeff' + xml, encoding === 'utf-8' ? 'utf8' : 'utf16le');
  if (encoding === 'utf-16be') bytes = bytes.swap16();
  async function* chunks() { for (let at = 0; at < bytes.length; at++) yield bytes.subarray(at, at + 1); }
  let text = ''; let id: string | undefined; await readWorkbookXml(chunks(), { open(tag) { expect(tag.uri).toBe('urn:root'); id = xmlAttribute(tag, 'id', 'urn:attr'); }, text(value) { text += value; } });
  expect(text).toBe('名😀'); expect(id).toBe('7');
});
it('refuses DTD expansion and decodes spreadsheet escape code units exactly once', async () => {
  async function* chunks() { yield Buffer.from('<!DOCTYPE r [<!ENTITY x "expanded">]><r>&x;</r>'); }
  await expect(readWorkbookXml(chunks(), {})).rejects.toThrow('unsupported-xml-dtd');
  expect(spreadsheetString('_x005F_x0041_')).toMatchObject({ text: '_x0041_' });
  expect(spreadsheetString('_xD83D__xDE00_')).toMatchObject({ text: '😀', escapedCodeUnitsUnresolved: false });
  expect(spreadsheetString('_xD83D_')).toEqual({ text: '_xD83D_', escapedCodeUnitsUnresolved: true });
});
it('reports the precise boolean gap for one malformed sheet and keeps the others readable', async () => {
  const zip = await JSZip.loadAsync(await typedXlsxFixture());
  zip.file('data/sheet2.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1" hidden="perhaps"/></sheetData></worksheet>');
  const root = await temporaryFolder('unode-xlsx-sheet-gap-'); const source = join(root, 'source'); const directory = join(root, 'parsed');
  await fs.mkdir(directory); await fs.writeFile(source, await zip.generateAsync({ type: 'nodebuffer' }));
  const manifest = await parseXlsxSnapshot(source, directory, () => {});
  expect(manifest.sheets[0].metadata?.cellRecords).toBeGreaterThan(0); expect(manifest.sheets[1].gap).toBe('invalid-workbook-boolean');
  expect(manifest.sheets[2].gap).toBeUndefined();
});
