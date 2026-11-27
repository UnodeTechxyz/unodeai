import JSZip from 'jszip';
/** Real ZIP64 end records, even for this small fixture; exercises the package reader rather than a mock. */
export function forcedZip64(input: Buffer): Buffer {
  const end = input.length - 22;
  if (input.readUInt32LE(end) !== 0x06054b50) throw new Error('fixture-needs-comment-free-zip');
  const record = Buffer.alloc(56); record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(input.readUInt16LE(end + 8)), 24); record.writeBigUInt64LE(BigInt(input.readUInt16LE(end + 10)), 32);
  record.writeBigUInt64LE(BigInt(input.readUInt32LE(end + 12)), 40); record.writeBigUInt64LE(BigInt(input.readUInt32LE(end + 16)), 48);
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(end), 8); locator.writeUInt32LE(1, 16);
  const footer = Buffer.from(input.subarray(end)); footer.writeUInt16LE(0xffff, 8); footer.writeUInt16LE(0xffff, 10);
  footer.writeUInt32LE(0xffffffff, 12); footer.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([input.subarray(0, end), record, locator, footer]);
}
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
export async function displayXlsxFixture(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await typedXlsxFixture());
  zip.file('custom/styles.xml', `<styleSheet xmlns="${MAIN}"><numFmts count="3"><numFmt numFmtId="201" formatCode="yyyy-mm-dd"/><numFmt numFmtId="202" formatCode="0%"/><numFmt numFmtId="203" formatCode="&quot;$&quot;#,##0.00"/></numFmts><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="201"/><xf numFmtId="202"/><xf numFmtId="203"/><xf numFmtId="31"/></cellXfs></styleSheet>`);
  zip.file('data/sheet1.xml', `<worksheet xmlns="${MAIN}"><sheetData>
    <row r="1"><c r="A1" s="1"><v>45231</v></c><c r="B1" s="2"><v>0.15</v></c><c r="C1" s="3"><v>1234.5</v></c><c r="D1"/><c r="E1"><v>1</v></c><c r="F1" s="3"><v>9007199254740993</v></c><c r="G1" s="4"><v>45231</v></c></row>
    <row r="2"><c r="A2" s="1"><v>45232</v></c><c r="B2" s="2"><v>0.2</v></c><c r="C2" s="3"><v>-1000.2</v></c><c r="D2" t="inlineStr"><is><t xml:space="preserve">  padded  </t></is></c><c r="E2"><v>2</v></c><c r="G2" s="4"><v>45232</v></c></row>
    <row r="3"><c r="A3" s="1"><v>45233</v></c><c r="B3" s="2"><v>0</v></c><c r="C3" s="3"><v>0</v></c><c r="E3"><v>2</v></c><c r="G3" s="4"><v>45233</v></c></row>
    </sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
export async function styleXlsxFixture(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await typedXlsxFixture());
  const formats = ['yyyy-mm-dd;@', 'm/d/yy;@', '[$-409]d-mmm-yy;@', 'yyyy"年"m"月"d"日";@', '[>0]yyyy-mm-dd;0', '@', '"literal"@'];
  zip.file('custom/styles.xml', `<styleSheet xmlns="${MAIN}"><numFmts count="${formats.length}">${formats.map((code, index) => `<numFmt numFmtId="${200 + index}" formatCode="${code.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('>', '&gt;')}"/>`).join('')}</numFmts><cellXfs count="${formats.length + 2}"><xf numFmtId="0"/><xf numFmtId="14"/>${formats.map((_, index) => `<xf numFmtId="${200 + index}" applyNumberFormat="1"/>`).join('')}</cellXfs></styleSheet>`);
  zip.file('data/sheet1.xml', `<worksheet xmlns="${MAIN}"><cols><col min="2" max="2" style="1"/></cols><sheetData><row r="1"><c r="A1"><v>3</v></c><c r="B1"><v>3</v></c></row><row r="2" s="1" customFormat="1"><c r="A2"><v>4</v></c><c r="B2" s="0"><v>4</v></c><c r="C2" s="1"><v>4</v></c></row><row r="3"><c r="A3" s="1"><v>60</v></c></row><row r="4">${formats.map((_, index) => `<c r="${String.fromCharCode(65 + index)}4" s="${index + 2}"><v>60</v></c>`).join('')}</row></sheetData><mergeCells><mergeCell ref="A3:B3"/><mergeCell ref="C2:D2"/></mergeCells></worksheet>`);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
export async function typedXlsxFixture(date1904 = false): Promise<Buffer> {
  const zip = new JSZip(); const files: Record<string, string> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/custom/book.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/custom/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/custom/strings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${[1, 2, 3].map(index => `<Override PartName="/data/sheet${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': `<Relationships xmlns="${PACKAGE}"><Relationship Id="main" Type="${REL}/officeDocument" Target="custom/book.xml"/></Relationships>`,
    'custom/book.xml': `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr date1904="${date1904 ? 1 : 0}"/><sheets><sheet name="数据 &amp; Data" sheetId="7" r:id="s1"/><sheet name="Hidden" sheetId="8" state="hidden" r:id="s2"/><sheet name="Very hidden" sheetId="9" state="veryHidden" r:id="s3"/></sheets><calcPr calcMode="manual" fullCalcOnLoad="1"/></workbook>`,
    'custom/_rels/book.xml.rels': `<Relationships xmlns="${PACKAGE}">${[1, 2, 3].map(index => `<Relationship Id="s${index}" Type="${REL}/worksheet" Target="../data/sheet${index}.xml"/>`).join('')}<Relationship Id="styles" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="strings" Type="${REL}/sharedStrings" Target="strings.xml"/><Relationship Id="external" Type="${REL}/externalLink" Target="https://invalid.example/do-not-refresh" TargetMode="External"/></Relationships>`,
    'custom/styles.xml': `<styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00%"/></numFmts><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    'custom/strings.xml': `<sst xmlns="${MAIN}" count="3" uniqueCount="2"><si><t>Shared 名称</t></si><si><r><t>Rich </t></r><r><t>text</t></r><rPh sb="0" eb="1"><t>phonetic</t></rPh></si></sst>`,
    'data/sheet1.xml': `<worksheet xmlns="${MAIN}"><dimension ref="A1:P3"/><cols><col min="3" max="3" hidden="1"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="str"><v/></c><c r="D1"/><c r="E1"><v>0</v></c><c r="F1" t="b"><v>0</v></c><c r="G1" t="e"><v>#DIV/0!</v></c><c r="H1" s="1"><v>60</v></c><c r="I1" s="2"><v>0.15</v></c><c r="J1"><f>SUM(E1:E2)</f><v>5</v></c><c r="K1"><f>1+1</f></c><c r="L1"><f t="shared" si="0" ref="L1:L2">E1*2</f><v>0</v></c><c r="M1"><f t="array" ref="M1:M2">ROW(M1:M2)</f><v>1</v></c><c r="N1"><v>12</v></c></row><row r="2" hidden="1"><c r="E2"><v>5</v></c><c r="L2"><f t="shared" si="0"/><v>10</v></c><c r="M2"><v>2</v></c><c r="N2"><v>99</v></c><c r="P2" t="inlineStr"><is><t>line_x000D_2</t></is></c></row><row r="3"><c r="A3" t="s"><v>0</v></c><c r="P3" t="d"><v>2026-11-19T09:00:00</v></c></row></sheetData><autoFilter ref="A1:P3"><filterColumn colId="0"><filters><filter val="Shared 名称"/></filters></filterColumn></autoFilter><mergeCells count="1"><mergeCell ref="N1:O2"/></mergeCells></worksheet>`,
    'data/sheet2.xml': `<worksheet xmlns="${MAIN}"><sheetData/></worksheet>`,
    'data/sheet3.xml': `<worksheet xmlns="${MAIN}"><sheetData/></worksheet>`,
  };
  for (const [name, text] of Object.entries(files)) zip.file(name, text, { createFolders: false });
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
