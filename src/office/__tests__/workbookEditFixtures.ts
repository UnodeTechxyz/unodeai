import JSZip from 'jszip';

export const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';

export interface WorkbookFixtureOptions {
  sheet1?: string; sheet2?: string; tables?: Record<string, string>; pivot?: string; date1904?: boolean; calcMode?: string; styles?: string | null;
  macro?: boolean; signed?: boolean; template?: boolean; extraParts?: Record<string, string>;
}
/** A small real package: two worksheets, styles, a calculation chain at a non-default path and optional tables/pivots. */
export async function workbookFixture(options: WorkbookFixtureOptions = {}): Promise<Buffer> {
  const tables = options.tables ?? {}; const tableNames = Object.keys(tables);
  const sheet1 = options.sheet1 ?? `<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><dimension ref="A1:D4"/><sheetData>`
    + '<row r="1"><c r="A1"><f>B1+1</f><v>2</v></c><c r="B1"><v>1</v></c><c r="C1" t="s"><v>0</v></c></row>'
    + '<row r="2"><c r="A2" s="1"><v>5</v></c><c r="B2"><f t="shared" si="0" ref="B2:B3">A2*2</f><v>10</v></c><c r="D2"><f t="array" ref="D2:D3">A2:A3*3</f><v>15</v></c></row>'
    + '<row r="3"><c r="A3"><v>6</v></c><c r="B3"><f t="shared" si="0"/><v>12</v></c><c r="D3"><v>18</v></c></row>'
    + '<row r="4"><c r="A4" t="inlineStr"><is><t>keep</t></is></c></row>'
    + `</sheetData><mergeCells count="1"><mergeCell ref="F1:G2"/></mergeCells>${tableNames.length ? `<tableParts count="${tableNames.length}">${tableNames.map((_, index) => `<tablePart r:id="t${index + 1}"/>`).join('')}</tableParts>` : ''}</worksheet>`;
  const sheet2 = options.sheet2 ?? `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><sheetProtection sheet="1" objects="1"/></worksheet>`;
  const sheet1Rels = [...tableNames.map((name, index) => `<Relationship Id="t${index + 1}" Type="${REL}/table" Target="../tables/${name}.xml"/>`),
    ...(options.pivot ? [`<Relationship Id="p1" Type="${REL}/pivotTable" Target="../pivots/pivot1.xml"/>`] : [])];
  const mainType = options.macro ? 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' : options.template ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  const files: Record<string, string> = {
    '[Content_Types].xml': `<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="${mainType}"/>`
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + (options.styles === null ? '' : '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>')
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
      + '<Override PartName="/xl/calc/chain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>'
      + tableNames.map(name => `<Override PartName="/xl/tables/${name}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`).join('')
      + (options.pivot ? '<Override PartName="/xl/pivots/pivot1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/>' : '')
      + (options.macro ? '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>' : '')
      + (options.signed ? '<Override PartName="/_xmlsignatures/origin.sigs" ContentType="application/vnd.openxmlformats-package.digital-signature-origin"/>' : '')
      + '</Types>',
    '_rels/.rels': `<Relationships xmlns="${PACKAGE}"><Relationship Id="main" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>`
      + (options.signed ? `<Relationship Id="sig" Type="${PACKAGE}/digital-signature/origin" Target="_xmlsignatures/origin.sigs"/>` : '') + '</Relationships>',
    'xl/workbook.xml': `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr date1904="${options.date1904 ? 1 : 0}"/><sheets><sheet name="Data" sheetId="1" r:id="s1"/><sheet name="Locked" sheetId="2" r:id="s2"/></sheets>`
      + `<calcPr calcId="191029"${options.calcMode ? ` calcMode="${options.calcMode}"` : ''}/><extLst><ext uri="{x}"/></extLst></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PACKAGE}"><Relationship Id="s1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="s2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>`
      + (options.styles === null ? '' : `<Relationship Id="st" Type="${REL}/styles" Target="styles.xml"/>`)
      + `<Relationship Id="ss" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="cc" Type="${REL}/calcChain" Target="calc/chain.xml"/>`
      + (options.macro ? `<Relationship Id="vba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>` : '') + '</Relationships>',
    'xl/sharedStrings.xml': `<sst xmlns="${MAIN}" count="1" uniqueCount="1"><si><t>shared</t></si></sst>`,
    'xl/calc/chain.xml': `<calcChain xmlns="${MAIN}"><c r="A1" i="1"/><c r="B2" i="1"/></calcChain>`,
    'xl/worksheets/sheet1.xml': sheet1, 'xl/worksheets/sheet2.xml': sheet2,
    ...(sheet1Rels.length ? { 'xl/worksheets/_rels/sheet1.xml.rels': `<Relationships xmlns="${PACKAGE}">${sheet1Rels.join('')}</Relationships>` } : {}),
    ...Object.fromEntries(tableNames.map(name => [`xl/tables/${name}.xml`, tables[name]])),
    ...(options.pivot ? { 'xl/pivots/pivot1.xml': options.pivot } : {}),
    ...(options.macro ? { 'xl/vbaProject.bin': 'not really a project' } : {}),
    ...(options.signed ? { '_xmlsignatures/origin.sigs': '' } : {}),
    ...(options.extraParts ?? {}),
  };
  if (options.styles !== null) files['xl/styles.xml'] = options.styles ?? `<styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts><fonts count="1"><font/></fonts><cellXfs count="2"><xf numFmtId="0" fontId="0"/><xf numFmtId="164" fontId="0" applyNumberFormat="1"><alignment horizontal="center"/></xf></cellXfs></styleSheet>`;
  const zip = new JSZip(); for (const [name, text] of Object.entries(files)) zip.file(name, text, { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
export const tableXml = (ref: string, options: { header?: number; totals?: number; formula?: string } = {}) =>
  `<table xmlns="${MAIN}" id="1" name="Sales" displayName="Sales" ref="${ref}"${options.header !== undefined ? ` headerRowCount="${options.header}"` : ''}${options.totals ? ` totalsRowCount="${options.totals}"` : ''}>`
  + `<autoFilter ref="${ref}"/><tableColumns count="3"><tableColumn id="1" name="Qty"/><tableColumn id="2" name="Price"/><tableColumn id="3" name="Total">${options.formula ? `<calculatedColumnFormula>${options.formula}</calculatedColumnFormula>` : ''}</tableColumn></tableColumns></table>`;
