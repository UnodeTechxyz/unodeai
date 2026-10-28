import { createHash } from 'node:crypto';
import { DocumentFailure, type CanonicalDocumentRequest, type DocumentBlock,
  type DocumentRenderStats, type DocumentText } from './DocumentContracts';
import { documentFontHint } from './DocumentLanguage';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function runs(text: DocumentText, bold = false, size?: number): string {
  return text.map(run => {
    const lang = esc(run.language); const family = esc(documentFontHint(run.language));
    const properties = `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="${family}"/>`
      + `<w:lang w:val="${lang}" w:eastAsia="${lang}"/>${run.bold || bold ? '<w:b/>' : ''}`
      + `${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''}</w:rPr>`;
    return `<w:r>${properties}${run.text.split('\n').map(value => `<w:t xml:space="preserve">${esc(value)}</w:t>`).join('<w:br/>')}</w:r>`;
  }).join('');
}
function paragraph(content: string, properties = ''): string {
  return `<w:p><w:pPr>${properties}</w:pPr>${content}</w:p>`;
}

/** Finite OOXML vocabulary. Relationships and all layout expressions are host-owned constants. */
export function docxPackageMembers(request: Pick<CanonicalDocumentRequest, 'template' | 'document'>): Map<string, string> {
  const { document: doc } = request;
  const width = doc.page === 'a4' ? 11906 : 12240;
  const height = doc.page === 'a4' ? 16838 : 15840;
  const bodyWidth = width - 2880;
  const headingBefore = request.template === 'contract-v1' ? 360 : 240;
  const renderBlock = (block: DocumentBlock): string => {
    switch (block.type) {
      case 'paragraph': return paragraph(runs(block.content));
      case 'heading': return paragraph(runs(block.content, true), `<w:pStyle w:val="Heading${block.level}"/>`);
      case 'clause': return paragraph(`${runs(block.label)}<w:r><w:tab/></w:r>${runs(block.content)}`,
        '<w:ind w:left="720" w:hanging="720"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>');
      case 'page-break': return paragraph('<w:r><w:br w:type="page"/></w:r>');
      case 'table': {
        const columns = block.headers.length;
        const widths = Array.from({ length: columns }, (_, i) => Math.floor(bodyWidth / columns) + (i === columns - 1 ? bodyWidth % columns : 0));
        const row = (cells: DocumentText[], heading = false) => `<w:tr>${heading ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.map((cell, i) =>
          `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/></w:tcPr>${paragraph(runs(cell, heading))}</w:tc>`).join('')}</w:tr>`;
        const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="000000"/>`).join('');
        const padding = ['top', 'left', 'bottom', 'right'].map(side => `<w:${side} w:w="80" w:type="dxa"/>`).join('');
        return `<w:tbl><w:tblPr><w:tblW w:w="${bodyWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar>${padding}</w:tblCellMar></w:tblPr>`
          + `<w:tblGrid>${widths.map(value => `<w:gridCol w:w="${value}"/>`).join('')}</w:tblGrid>${row(block.headers, true)}${block.rows.map(cells => row(cells)).join('')}</w:tbl>`;
      }
      case 'signature': {
        let xml = '';
        for (let i = 0; i < block.parties.length; i += 2) {
          const parties = block.parties.slice(i, i + 2);
          const half = Math.floor(bodyWidth / parties.length);
          xml += `<w:tbl><w:tblPr><w:tblW w:w="${bodyWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>`
            + parties.map(() => `<w:gridCol w:w="${half}"/>`).join('') + '</w:tblGrid><w:tr>'
            + parties.map(party => `<w:tc><w:tcPr><w:tcW w:w="${half}" w:type="dxa"/></w:tcPr>`
              + paragraph(runs(party.label, true), '<w:keepNext/><w:keepLines/>')
              + paragraph(party.name ? runs(party.name) : '<w:r><w:t>____________________</w:t></w:r>', '<w:keepLines/>') + '</w:tc>').join('')
            + '</w:tr></w:tbl>';
        }
        return xml;
      }
    }
  };
  const content = paragraph(runs(doc.title, false, 40), `<w:spacing w:after="240"/><w:jc w:val="${request.template === 'contract-v1' ? 'center' : 'left'}"/><w:keepNext/>`)
    + (doc.subtitle ? paragraph(runs(doc.subtitle), '<w:keepNext/>') : '') + doc.blocks.map(renderBlock).join('');
  const sect = `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/>`
    + `<w:pgSz w:w="${width}" w:h="${height}"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="480" w:footer="480" w:gutter="0"/></w:sectPr>`;
  const style = (level: number, size: number) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/>`
    + `<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="${level - 1}"/><w:spacing w:before="${headingBefore}" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const rels = (entries: Array<[string, string, string]>) => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>`;
  const overrides = [
    ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
    ['word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
    ['word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'],
    ['word/header1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'],
    ['word/footer1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml'],
    ['docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
  ];
  return new Map([
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([name, type]) => `<Override PartName="/${name}" ContentType="${type}"/>`).join('')}</Types>`],
    ['_rels/.rels', rels([['rIdDocument', `${R}/officeDocument`, 'word/document.xml'], ['rIdCore', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'], ['rIdApp', `${R}/extended-properties`, 'docProps/app.xml']])],
    ['docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:created xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`],
    ['docProps/app.xml', `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>UnodeAi</Application></Properties>`],
    ['word/document.xml', `${XML}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${content}${sect}</w:body></w:document>`],
    ['word/styles.xml', `${XML}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="300" w:lineRule="atLeast" w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${style(1, 32)}${style(2, 26)}${style(3, 23)}</w:styles>`],
    ['word/settings.xml', `${XML}<w:settings xmlns:w="${W}"/>`],
    ['word/_rels/document.xml.rels', rels([['rIdStyles', `${R}/styles`, 'styles.xml'], ['rIdSettings', `${R}/settings`, 'settings.xml'], ['rIdHeader', `${R}/header`, 'header1.xml'], ['rIdFooter', `${R}/footer`, 'footer1.xml']])],
    ['word/header1.xml', `${XML}<w:hdr xmlns:w="${W}">${paragraph(doc.header ? runs(doc.header, false, 18) : '')}</w:hdr>`],
    ['word/footer1.xml', `${XML}<w:ftr xmlns:w="${W}">${paragraph((doc.footer ? runs(doc.footer, false, 18) : '')
      + '<w:r><w:t xml:space="preserve"> </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t>/</w:t></w:r><w:fldSimple w:instr="NUMPAGES"><w:r><w:t>1</w:t></w:r></w:fldSimple>')}</w:ftr>`],
  ]);
}

export interface DocumentZip {
  addBuffer(bytes: Buffer, name: string, options: { compress: false; mtime: Date; mode: number; forceDosTimestamp: true }): void;
  end(options: { forceZip64Format: false; comment: string }): void;
  outputStream: NodeJS.ReadableStream & { destroy(error?: Error): void };
  on(event: 'error', listener: (error: Error) => void): void;
}

/** Dependency is injected by the isolated worker, never imported by the extension host. No output-size ceiling (v0.9.99). */
export async function renderDocx(request: Pick<CanonicalDocumentRequest, 'template' | 'document'>,
  makeZip: () => DocumentZip): Promise<{ bytes: Buffer; stats: DocumentRenderStats }> {
  const members = [...docxPackageMembers(request)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const buffers = members.map(([name, xml]) => [name, Buffer.from(xml, 'utf8')] as const);
  const zip = makeZip();
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.on('error', () => { zip.outputStream.destroy(); reject(new DocumentFailure('worker-exit')); });
    zip.outputStream.on('error', () => reject(new DocumentFailure('worker-exit')));
    zip.outputStream.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, bytes] of buffers) zip.addBuffer(bytes, name, { compress: false, mtime: new Date(2000, 0, 1, 0, 0, 0), mode: 0o100644, forceDosTimestamp: true });
    zip.end({ forceZip64Format: false, comment: '' });
  });
  const blocks = request.document.blocks;
  return { bytes, stats: { format: 'docx', template: request.template, blocks: blocks.length,
    headings: blocks.filter(block => block.type === 'heading').length,
    clauses: blocks.filter(block => block.type === 'clause').length, tables: blocks.filter(block => block.type === 'table').length,
    rendererRevision: 2, fontManifestDigest: createHash('sha256').update('docx-font-hints-v1').digest('hex') } };
}
