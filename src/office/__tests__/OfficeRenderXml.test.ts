import { expect, it } from 'vitest';
import { filterOfficeRenderXml } from '../OfficeRenderXml';
import { OFFICE_NS } from '../OfficePackage';
const W = OFFICE_NS.w[0]; const A = OFFICE_NS.a[0]; const P = OFFICE_NS.p[0]; const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const filter = (text: string) => filterOfficeRenderXml(Buffer.from(text), new Set(), () => {});
it('keeps only layout counters in simple and complete complex fields while removing DDE instructions', () => {
  const result = filter(`<w:document xmlns:w="${W}"><w:body><w:p><w:fldSimple w:instr="PAGE \\* MERGEFORMAT"><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>2</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:fldSimple w:instr="DDEAUTO remote"><w:r><w:t>Cached only</w:t></w:r></w:fldSimple></w:p></w:body></w:document>`);
  const text = result.bytes.toString(); expect(text).toContain('w:instr="PAGE'); expect(text).toContain('NUMPAGES'); expect(text.match(/w:fldCharType=/g)).toHaveLength(3);
  expect(text).toContain('Cached only'); expect(text).not.toContain('DDEAUTO');
});
it('resolves a supported passive shape choice and preserves namespace scope declared on the removed wrapper', () => {
  const text = filter(`<w:document xmlns:w="${W}" xmlns:mc="${MC}"><w:body><mc:AlternateContent><mc:Choice Requires="wps" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Shape text</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></mc:Choice><mc:Fallback><w:p><w:r><w:t>Other representation</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent></w:body></w:document>`);
  expect(text.bytes.toString()).toContain('Shape text'); expect(text.bytes.toString()).toContain('xmlns:wps='); expect(text.bytes.toString()).not.toContain('Other representation');
  expect(text.bytes.toString()).not.toContain('mc:Choice'); expect(text.compatibilityResolutions).toBe(1); expect(text.compatibilityFallbacks).toBe(0);
});
it('uses fallback for unsupported choice and still filters active content inside it', () => {
  const result = filter(`<w:document xmlns:w="${W}" xmlns:mc="${MC}"><w:body><mc:AlternateContent><mc:Choice Requires="evil" xmlns:evil="urn:unsupported"><evil:payload>Not supported</evil:payload></mc:Choice><mc:Fallback><w:p><w:r><w:t>Fallback text</w:t></w:r><w:object>ACTIVE</w:object></w:p></mc:Fallback></mc:AlternateContent></w:body></w:document>`);
  expect(result.bytes.toString()).toContain('Fallback text'); expect(result.bytes.toString()).not.toMatch(/ACTIVE|Not supported/); expect(result.compatibilityFallbacks).toBe(1);
});
it('retains schema-required chart references but removes external workbook refresh, and removes emptied graphic frames', () => {
  const chart = filter('<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:numRef><c:f>Sheet1!A1:A2</c:f><c:numCache><c:ptCount val="2"/></c:numCache></c:numRef></c:chart><c:externalData xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="workbook"/></c:chartSpace>');
  expect(chart.bytes.toString()).toContain('<c:f>'); expect(chart.bytes.toString()).toContain('numCache'); expect(chart.bytes.toString()).not.toContain('externalData');
  const drawing = filter(`<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData><p:oleObj/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`);
  expect(drawing.bytes.toString()).not.toContain('graphicFrame');
});
const runText = (text: string) => `<w:r><w:instrText>${text}</w:instrText></w:r>`;
const fieldMark = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
const fieldDocument = (code: string, end = fieldMark('end')) => `<w:document xmlns:w="${W}" xmlns:x="urn:unsupported" xmlns:mc="${MC}"><w:body><w:p>${fieldMark('begin')}${code}${fieldMark('separate')}<w:r><w:t>Cached visible result</w:t></w:r>${end}</w:p></w:body></w:document>`;
it('F1 rejects literal run content in the final field-code region while retaining its visible text as inert text', () => {
  const result = filter(fieldDocument('<w:r><w:t>INCLUDEPICTURE &quot;\\\\inert.invalid\\fixture.png&quot; \\d</w:t></w:r>' + runText('PAGE')));
  expect(result.bytes.toString()).not.toMatch(/w:(?:fldChar|instrText)/); expect(result.bytes.toString()).toContain('Cached visible result');
});
it('F1 rechecks only surviving instruction pieces after an unsupported wrapper is removed', () => {
  const safe = 'NUMPAGES \\* MERGEFORMAT \\* ROMAN \\* ALPHABETIC \\* MERGEFORMAT'; const target = 'USERNAME'; let at = 0;
  const pieces = [...safe].map(character => {
    const keep = character === target[at]; if (keep) at++;
    return keep ? runText(character) : '<x:junk>' + runText(character) + '</x:junk>';
  }).join(''); expect(at).toBe(target.length);
  const result = filter(fieldDocument(pieces));
  expect(result.bytes.toString()).not.toMatch(/w:(?:fldChar|instrText)/); expect(result.bytes.toString()).toContain('Cached visible result');
});
it('F1 strips surviving begin/instructions when the end marker belonged to a non-chosen compatibility branch', () => {
  const end = `<mc:AlternateContent><mc:Choice Requires="x">${fieldMark('end')}</mc:Choice><mc:Fallback><w:r/></mc:Fallback></mc:AlternateContent>`;
  const result = filter(fieldDocument(runText('PAGE'), end));
  expect(result.bytes.toString()).not.toMatch(/w:(?:fldChar|instrText)/); expect(result.bytes.toString()).toContain('Cached visible result');
});
it('retains passive local chart formulas but neutralizes external paths, URLs and evaluated formulas without changing caches', () => {
  for (const formula of [String.raw`'\\inert.invalid\fixture.xlsx'!A1`, 'https://inert.invalid/data', 'WEBSERVICE(&quot;https://inert.invalid&quot;)']) {
    const result = filter(`<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:numRef><c:f>${formula}</c:f><c:numCache><c:pt idx="0"><c:v>24</c:v></c:pt></c:numCache></c:numRef></c:chartSpace>`);
    expect(result.neutralizedChartFormulas).toBe(1); expect(result.bytes.toString()).toMatch(/<c:f>Sheet1!(?:A1|\$A\$1)<\/c:f>/); expect(result.bytes.toString()).toContain('<c:v>24</c:v>'); expect(result.bytes.toString()).not.toContain('inert.invalid');
  }
  const local = filter('<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:numRef><c:f>\'Local sheet\'!$B$2:$B$3</c:f></c:numRef></c:chartSpace>');
  expect(local.neutralizedChartFormulas).toBe(0); expect(local.bytes.toString()).toContain("'Local sheet'!$B$2:$B$3");
});
