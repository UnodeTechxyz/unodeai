import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join, posix } from 'node:path';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { SaxesParser } from 'saxes';
import { saveHost, sha } from './attachmentSaveFixtures';
import { officeRouteReader, officeRouteEditor } from './officeInventoryRouteFixtures';
import { workbookRouteReader } from './workbookRouteFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { decodeOfficeXml } from '../../office/OfficeTextPatch';
import { COMPUTE_CSV, workbookSumPlan } from './workbookComputeFixtures';
import { displayXlsxFixture } from '../../content/__tests__/xlsxFixtures';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); await removeTemporaryFolders(); });
async function host() {
  const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const workbook = await workbookRouteReader(); const tools = h.tools('dev');
  tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.setWorkbookReader(workbook); tools.beginTurn();
  cleanup.push(async () => { tools.retire(); await reader.dispose(); await workbook.dispose(); await h.assets.dispose(); }); return { ...h, reader, editor, workbook, tools };
}
async function source(kind: 'bar' | 'line' | 'pie' | 'scatter' = 'bar', shared = false, seriesCount = 1) {
  const deck = new PptxGenJS(); const slide = deck.addSlide(); const series = Array.from({ length: seriesCount }, (_, index) => ({ name: index ? 'Second old' : 'Old', labels: ['1', '2'], values: [12 + index, 7 + index] }));
  for (const x of [1, 6]) slide.addChart(deck.ChartType[kind], series, { x, y: 1, w: 4, h: 3 }); slide.addText('Keep text', { x: 1, y: 5, w: 4, h: 1 }); slide.addNotes('Keep notes');
  const zip = await JSZip.loadAsync(await deck.write({ outputType: 'nodebuffer' }) as Buffer); const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const ids = [...xml.matchAll(/<c:chart\b[^>]*\br:id="([^"]+)"/g)].map(match => match[1]); expect(ids).toHaveLength(2);
  zip.file('ppt/slides/slide1.xml', xml.replace(`r:id="${ids[1]}"`, `r:id="${ids[0]}"`)); zip.file('custom/keep.bin', Buffer.from([1, 0, 255, 7]));
  if (shared) { const main = await zip.file('ppt/presentation.xml')!.async('string'); const entry = /<p:sldId\b[^>]*\/>/.exec(main)![0];
    zip.file('ppt/presentation.xml', main.replace('</p:sldIdLst>', entry.replace(/ id="[^"]+"/, ' id="257"') + '</p:sldIdLst>')); }
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function inspect(h: Awaited<ReturnType<typeof host>>, path = 'source.pptx') {
  const records: any[] = []; let cursor: string | undefined; let snapshot = '';
  do { const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success');
    const page = JSON.parse(result.output); records.push(...page.prepared_fragments); snapshot = page.snapshot_ref; cursor = page.next_cursor; } while (cursor);
  return { records, snapshot };
}
function tags(xml: string) {
  const result: Array<{ local: string; uri: string; attrs: Record<string, string> }> = []; const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', tag => result.push({ local: tag.local, uri: tag.uri, attrs: Object.fromEntries(Object.values(tag.attributes).filter(attr => attr.uri !== 'http://www.w3.org/2000/xmlns/').map(attr => [attr.name, attr.value])) }));
  parser.write(xml).close(); return result;
}
async function xml(zip: JSZip, member: string) { return decodeOfficeXml(await zip.file(member)!.async('nodebuffer')).xml; }
async function rel(zip: JSZip, owner: string, id: string) {
  const entry = tags(await xml(zip, posix.join(posix.dirname(owner), '_rels', posix.basename(owner) + '.rels'))).find(tag => tag.local === 'Relationship' && tag.attrs.Id === id)!;
  expect(entry.attrs.TargetMode).not.toBe('External'); return posix.normalize(entry.attrs.Target.startsWith('/') ? entry.attrs.Target.slice(1) : posix.join(posix.dirname(owner), entry.attrs.Target));
}
async function actualChart(zip: JSZip, slide = 1, ordinal = 0) {
  const slides = tags(await xml(zip, 'ppt/presentation.xml')).filter(tag => tag.local === 'sldId'); const slidePart = await rel(zip, 'ppt/presentation.xml', slides[slide - 1].attrs['r:id']);
  const ids = tags(await xml(zip, slidePart)).filter(tag => tag.local === 'chart' && tag.uri.endsWith('/chart'));
  const chartPart = await rel(zip, slidePart, ids[ordinal].attrs['r:id']); const chart = await xml(zip, chartPart); const embedding = tags(chart).find(tag => tag.local === 'externalData')!;
  const workbookPart = await rel(zip, chartPart, embedding.attrs['r:id']);
  const values: Array<{ names: string[]; labels: string[]; xs: string[]; ys: string[] }> = []; const parser = new SaxesParser({ xmlns: true }); let role: string | undefined; let inValue = false; let value = '';
  parser.on('opentag', tag => { if (!tag.uri.endsWith('/chart')) return;
    if (tag.local === 'ser') values.push({ names: [], labels: [], xs: [], ys: [] });
    if (values.length && ['tx', 'cat', 'xVal', 'yVal', 'val'].includes(tag.local)) role = tag.local;
    if (role && tag.local === 'v') { inValue = true; value = ''; }
  });
  parser.on('text', text => { if (inValue) value += text; });
  parser.on('closetag', tag => { if (!tag.uri.endsWith('/chart')) return;
    if (tag.local === 'v' && inValue) { values.at(-1)![role === 'tx' ? 'names' : role === 'cat' ? 'labels' : role === 'xVal' ? 'xs' : 'ys'].push(value.replace(/_x([0-9a-f]{4})_/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))); inValue = false; }
    if (['tx', 'cat', 'xVal', 'yVal', 'val', 'ser'].includes(tag.local)) role = undefined;
  }); parser.write(chart).close();
  return { slidePart, chartPart, chart, workbookPart, workbook: await zip.file(workbookPart)!.async('nodebuffer'), values };
}
async function dataCells(h: Awaited<ReturnType<typeof host>>, bytes: Buffer) {
  await fs.writeFile(join(h.root, 'actual-data.xlsx'), bytes); const inspected = await h.tools.run('read_workbook', { path: 'actual-data.xlsx', operation: 'inspect' }); expect(inspected.status, inspected.output).toBe('success');
  const sheets = JSON.parse(inspected.output).prepared_fragments.filter((item: any) => item.kind === 'sheet');
  const result = await h.tools.run('read_workbook', { operation: 'range', path: 'actual-data.xlsx', sheet_id: sheets.at(-1).record.sheet_id, range: 'A1:I5' }); expect(result.status, result.output).toBe('success');
  return JSON.parse(result.output).prepared_fragments.filter((item: any) => item.kind === 'cell').map((item: any) => item.record);
}
const edit = (series: any[], extra = {}) => ({ op: 'update_chart_data', target_ref: 'S1-O1', series, ...extra });
async function apply(h: Awaited<ReturnType<typeof host>>, bytes: Buffer, edits: any[]) {
  await fs.writeFile(join(h.root, 'source.pptx'), bytes); const page = await inspect(h);
  const result = await h.tools.run('edit_office', { schema_version: 1, path: 'edited.pptx', snapshot_ref: page.snapshot, edits }); expect(result.status, result.output).toBe('success');
  expect((await fs.readFile(join(h.root, 'source.pptx'))).equals(bytes)).toBe(true); return { result, before: await JSZip.loadAsync(bytes), zip: await JSZip.loadAsync(await fs.readFile(join(h.root, 'edited.pptx'))) };
}
it('duplicates the current chart and workbook after a chart edit and preserves its data after later source edits', async () => {
  const h = await host(); const first = [{ name: 'Current', labels: ['New'], values: [0.3] }]; const later = [{ name: 'Later', labels: ['Last'], values: [99] }];
  const out = await apply(h, await source('bar', true), [edit(first), { op: 'duplicate_slide', target_ref: 'S1' }, edit(later)]);
  const original = await actualChart(out.zip, 1); const duplicate = await actualChart(out.zip, 2);
  expect(original.values[0]).toMatchObject({ names: ['Later'], labels: ['Last'], ys: ['99'] });
  expect(duplicate.values[0]).toMatchObject({ names: ['Current'], labels: ['New'], ys: ['0.3'] });
  expect(original.chartPart).not.toBe(duplicate.chartPart); expect(original.workbookPart).not.toBe(duplicate.workbookPart);
  expect((await actualChart(out.zip, 3)).values[0].names).toEqual(['Old']);
  const cells = await dataCells(h, duplicate.workbook); expect(cells.find((cell: any) => cell.cell === 'B2').value).toMatchObject({ kind: 'number', raw: '0.3' });
});
it.each(['bar', 'line', 'pie', 'scatter'] as const)('updates an actual %s chart and its editable workbook with real zero and blank values', async kind => {
  const h = await host(); const series = [{ name: 'New $& 名称', values: [0, null, -12.5], ...(kind === 'scatter' ? { x_values: [1, 2, 3] } : { labels: ['Q1', '', '_x0041_ <Q3>\n下一季'] }) }];
  const out = await apply(h, await source(kind), [edit(series)]); const actual = await actualChart(out.zip); const second = await actualChart(out.zip, 1, 1); const oldSecond = await actualChart(out.before, 1, 1);
  expect(actual.values[0].names).toEqual(['New $& 名称']); expect(actual.values[0].ys).toEqual(['0', '', '-12.5']); expect(second.chart).toBe(oldSecond.chart); expect(second.workbook.equals(oldSecond.workbook)).toBe(true);
  const cells = await dataCells(h, actual.workbook); expect(cells.find((cell: any) => cell.cell === 'B2').value).toMatchObject({ kind: 'number', raw: '0' }); expect(cells.find((cell: any) => cell.cell === 'B3').value.kind).toBe('blank');
  if (kind === 'scatter') expect(actual.values[0].xs).toEqual(['1', '2', '3']); else { expect(actual.values[0].labels).toEqual(series[0].labels); expect(cells.find((cell: any) => cell.cell === 'A4').value.text).toBe(series[0].labels![2]); expect(actual.chart).toContain('_x005F_x0041_'); }
  for (const [name, entry] of Object.entries(out.before.files)) if (!entry.dir && !['[Content_Types].xml', 'ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels'].includes(name))
    expect(sha(await out.zip.file(name)!.async('nodebuffer')), name).toBe(sha(await entry.async('nodebuffer')));
  expect(out.result.output).toContain('Matched text spans: 0;'); expect(out.result.output).toContain('blanks 1'); expect(h.state.approvals).toEqual([]);
});
it('isolates the selected shared logical slide and chart before applying sequential data and text edits', async () => {
  const h = await host(); const out = await apply(h, await source('bar', true), [edit([{ name: 'First', labels: ['A'], values: [1] }], { target_ref: 'S2-O1' }),
    { op: 'replace_text', target_ref: 'S2-O3', find: 'Keep text', replace: 'Updated slide' }, edit([{ name: 'Last', labels: ['A', 'B'], values: [0, 8] }], { target_ref: 'S2-O1' })]);
  expect((await actualChart(out.zip, 1)).values[0].names).toEqual(['Old']); expect((await actualChart(out.zip, 2)).values[0].names).toEqual(['Last']);
  expect((await actualChart(out.zip, 2, 1)).chart).toBe((await actualChart(out.before, 1, 1)).chart);
  const readback = await inspect(h, 'edited.pptx'); expect(readback.records.find(item => item.id === 'S1-O3').record.text).toBe('Keep text'); expect(readback.records.find(item => item.id === 'S2-O3').record.text).toBe('Updated slide');
});
it('uses actual current transformation values and retains source precision instead of supplied model values', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'data.csv'), COMPUTE_CSV); const read = await h.tools.run('read_workbook', { path: 'data.csv' }); expect(read.status, read.output).toBe('success');
  const computed = await h.tools.run('transform_workbook', workbookSumPlan(JSON.parse(read.output).snapshot_ref)); expect(computed.status, computed.output).toBe('success'); const transformation = JSON.parse(computed.output).transformation_ref;
  const out = await apply(h, await source(), [edit([{ name: 'Wrong model number', labels: ['A', 'B'], values: [999, 999] }], { data_from: { transformation_ref: transformation, label_field: 'team', value_fields: ['total'] } })]);
  const actual = await actualChart(out.zip); expect(actual.values[0].labels).toEqual(['A', 'B']); expect(actual.values[0].ys).toEqual(['0.3', '9007199254740994']);
  const cells = await dataCells(h, actual.workbook); expect(cells.find((cell: any) => cell.cell === 'C2').value.text).toContain('"value":"0.3"'); expect(out.result.output).toContain('precision losses 1'); expect(out.result.output).toContain('supplied differences 1');
});
it('keeps exact source evidence separate from styled and rounded displays in existing chart edits', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'display.xlsx'), await displayXlsxFixture());
  const read = await h.tools.run('read_workbook', { path: 'display.xlsx' }); expect(read.status, read.output).toBe('success');
  const snapshot_ref = JSON.parse(read.output).snapshot_ref;
  const values = await h.tools.run('transform_workbook', { sources: [{ name: 'input', snapshot_ref, range: 'A1:G3' }], steps: [
    { id: 'values', input: 'input', operation: 'select', columns: ['date', 'percent', 'money', 'blank', 'amount', 'large', 'cjkDate'].map((as, index) => ({ column: String.fromCharCode(65 + index), as })) },
  ] }); expect(values.status, values.output).toBe('success');
  const average = await h.tools.run('transform_workbook', { sources: [{ name: 'input', snapshot_ref, range: 'E1:E3' }], steps: [
    { id: 'mean', input: 'input', operation: 'aggregate', fields: [{ operation: 'average', field: 'E', as: 'average' }] },
  ] }); expect(average.status, average.output).toBe('success');
  const out = await apply(h, await source(), [edit([], { data_from: { transformation_ref: JSON.parse(values.output).transformation_ref,
    label_field: 'cjkDate', value_fields: ['percent', 'money', 'blank'] } })]);
  const cells = await dataCells(h, (await actualChart(out.zip)).workbook);
  const evidence = (cell: string) => JSON.parse(cells.find((item: any) => item.cell === cell).value.text);
  expect(evidence('C2')).toMatchObject({ value: '0.15', display_text: '15%', axis: '45231 (Excel 1900 date serial)', axis_display_text: '2023-11-01' });
  expect(evidence('F2')).toMatchObject({ value: '1234.5', display_text: '$1,234.50' });
  expect(evidence('I2')).toMatchObject({ value: '[Missing: blank-cell]', display_text: '', value_state: 'unresolved' });
  const mean = await apply(h, await source(), [edit([], { data_from: { transformation_ref: JSON.parse(average.output).transformation_ref, label_field: 'average', value_fields: ['average'] } })]);
  const meanCells = await dataCells(h, (await actualChart(mean.zip)).workbook);
  expect(JSON.parse(meanCells.find((item: any) => item.cell === 'C2').value.text)).toMatchObject({ value: '5/3', display_text: '1.666666666667' });
});
it.each([0, 1, 3])('writes %s series while retaining source series IDs, style and original workbook worksheets', async count => {
  const h = await host(); const zip = await JSZip.loadAsync(await source('bar', false, 2)); const chartName = (await actualChart(zip)).chartPart;
  const chart = (await xml(zip, chartName)).replace('<c:idx val="0"/>', '<c:idx val="77"></c:idx>').replace('<c:order val="0"/>', '<c:order val="0"></c:order>'); zip.file(chartName, chart);
  const series = Array.from({ length: count }, (_, index) => ({ name: 'New ' + index, labels: ['A', 'B'], values: [0, index + 2] }));
  const out = await apply(h, await zip.generateAsync({ type: 'nodebuffer' }), [edit(series)]); const actual = await actualChart(out.zip);
  expect(actual.values.map(series => series.names[0])).toEqual(series.map(series => series.name));
  const ids = tags(actual.chart).filter(tag => tag.local === 'idx').map(tag => tag.attrs.val); expect(new Set(ids).size).toBe(count); if (count) expect(ids[0]).toBe('77');
  const old = await JSZip.loadAsync((await actualChart(out.before)).workbook); const next = await JSZip.loadAsync(actual.workbook);
  for (const [name, entry] of Object.entries(old.files)) if (!entry.dir && !['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels'].includes(name))
    expect(sha(await next.file(name)!.async('nodebuffer')), name).toBe(sha(await entry.async('nodebuffer')));
  expect(actual.chart.includes('C0504D')).toBe(count > 0); if (!count) expect((await dataCells(h, actual.workbook)).find((cell: any) => cell.cell === 'A1').value.text).toBe('Category');
});
it.each(['literal', 'external'])('creates a linked workbook for an existing %s-data chart without fetching external links', async kind => {
  const h = await host(); const zip = await JSZip.loadAsync(await source());
  const chartName = (await actualChart(zip)).chartPart; const relationships = posix.join(posix.dirname(chartName), '_rels', posix.basename(chartName) + '.rels');
  if (kind === 'literal') {
    const literal = (await xml(zip, chartName)).replace(/<c:externalData\b[\s\S]*?<\/c:externalData>/, '')
      .replace(/<c:tx\b[^>]*>[\s\S]*?<\/c:tx>/, '<c:tx><c:v>Old literal</c:v></c:tx>')
      .replace(/<c:cat\b[^>]*>[\s\S]*?<\/c:cat>/, '<c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:strLit></c:cat>')
      .replace(/<c:val\b[^>]*>[\s\S]*?<\/c:val>/, '<c:val><c:numLit><c:formatCode>#,##0.00</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>12</c:v></c:pt><c:pt idx="1"><c:v>7</c:v></c:pt></c:numLit></c:val>');
    expect(literal).toContain('<c:numLit>'); zip.file(chartName, literal);
  }
  else zip.file(relationships, (await xml(zip, relationships)).replace(/<Relationship\b[^>]*Type="[^"]+\/package"[^>]*\/>/,
    opening => opening.replace(/Target="[^"]+"/, 'Target="https://example.invalid/never-fetch.xlsx"').replace('/>', ' TargetMode="External"/>')));
  const out = await apply(h, await zip.generateAsync({ type: 'nodebuffer' }), [edit([{ name: 'Local', labels: ['A'], values: [0] }])]); const actual = await actualChart(out.zip);
  const cells = await dataCells(h, actual.workbook); expect(cells.find((cell: any) => cell.cell === 'B2').value.raw).toBe('0'); expect(actual.values[0].names).toEqual(['Local']);
  if (kind === 'literal') expect(actual.chart).toContain('<c:formatCode>#,##0.00</c:formatCode>');
});
it('round-trips ST_Xstring control characters and literal escapes in both chart and editable worksheet', async () => {
  const h = await host(); const label = '\u0001\r_x0041_'; const out = await apply(h, await source(), [edit([{ name: '_x005F_', labels: [label], values: [0] }])]);
  const actual = await actualChart(out.zip); expect(actual.values[0].names).toEqual(['_x005F_']); expect(actual.values[0].labels).toEqual([label]);
  expect(actual.chart).toContain('_x0001__x000D__x005F_x0041_');
  expect((await dataCells(h, actual.workbook)).find((cell: any) => cell.cell === 'A2').value.text).toBe(label);
});
it('keeps overlapping escape-looking label text literal in the cache and workbook', async () => {
  const h = await host(); const label = '_x0041_x0042_'; const out = await apply(h, await source(), [edit([{ name: label, labels: [label], values: [0] }])]);
  const actual = await actualChart(out.zip); expect(actual.values[0].names).toEqual([label]); expect(actual.values[0].labels).toEqual([label]);
  expect(actual.chart).toContain('_x005F_x0041_x005F_x0042_'); expect((await dataCells(h, actual.workbook)).find((cell: any) => cell.cell === 'A2').value.text).toBe(label);
});
it.each(['\r', '\u0000', '\u000c', '\u001f'])('keeps escape-looking text literal at an encoded-control boundary %j', async control => {
  const h = await host(); const label = '_x0041' + control; const out = await apply(h, await source(), [edit([{ name: label, labels: [label], values: [1] }])]);
  const actual = await actualChart(out.zip); expect(actual.values[0].names).toEqual([label]); expect(actual.values[0].labels).toEqual([label]);
  expect((await dataCells(h, actual.workbook)).find((cell: any) => cell.cell === 'A2').value.text).toBe(label);
});
it('distinguishes a stale Office snapshot from a fresh chart transformation across actual turns', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.pptx'), await source()); const old = await inspect(h); h.tools.beginTurn();
  await fs.writeFile(join(h.root, 'data.csv'), COMPUTE_CSV); const read = await h.tools.run('read_workbook', { path: 'data.csv' }); expect(read.status, read.output).toBe('success');
  const computed = await h.tools.run('transform_workbook', workbookSumPlan(JSON.parse(read.output).snapshot_ref)); expect(computed.status, computed.output).toBe('success');
  await fs.writeFile(join(h.root, 'existing.pptx'), 'USER FILE');
  const result = await h.tools.run('edit_office', { schema_version: 1, path: 'existing.pptx', snapshot_ref: old.snapshot,
    edits: [edit([], { data_from: { transformation_ref: JSON.parse(computed.output).transformation_ref, label_field: 'team', value_fields: ['total'] } })] });
  expect(result.officeEdit?.code).toBe('snapshot-unavailable'); expect(result.output).toContain('Call inspect_office'); expect(result.output).not.toContain('transform_workbook again');
  expect(await fs.readFile(join(h.root, 'existing.pptx'), 'utf8')).toBe('USER FILE'); expect(h.text.list()).toEqual([]);
  const fresh = await inspect(h); const retry = await h.tools.run('edit_office', { schema_version: 1, path: 'copy.pptx', snapshot_ref: fresh.snapshot,
    edits: [edit([], { data_from: { transformation_ref: JSON.parse(computed.output).transformation_ref, label_field: 'team', value_fields: ['total'] } })] });
  expect(retry.status, retry.output).toBe('success'); expect((await actualChart(await JSZip.loadAsync(await fs.readFile(join(h.root, 'copy.pptx'))))).values[0].ys).toEqual(['0.3', '9007199254740994']);
});
it('names update_chart_data in the actionable malformed-chart-schema hint', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.pptx'), await source()); const page = await inspect(h);
  const result = await h.tools.run('edit_office', { schema_version: 1, path: 'out.pptx', snapshot_ref: page.snapshot, edits: [edit([{ name: 'Bad', labels: ['A'], values: [1, 2] }])] });
  expect(result.officeEdit?.code).toBe('invalid-office-edits'); expect(result.output).toContain('update_chart_data'); await expect(fs.stat(join(h.root, 'out.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['bad-fact', 'revoked-write', 'revoked-read', 'invalid-field', 'unknown-ref'])('preserves an existing destination for %s chart data', async issue => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.pptx'), await source()); const page = await inspect(h); await fs.writeFile(join(h.root, 'existing.pptx'), 'USER FILE');
  let data_from: any;
  if (issue === 'invalid-field' || issue === 'unknown-ref' || issue === 'revoked-read') {
    await fs.writeFile(join(h.root, 'data.csv'), COMPUTE_CSV); const read = await h.tools.run('read_workbook', { path: 'data.csv' });
    const computed = await h.tools.run('transform_workbook', workbookSumPlan(JSON.parse(read.output).snapshot_ref)); expect(computed.status, computed.output).toBe('success');
    data_from = { transformation_ref: issue === 'unknown-ref' ? 'guessed' : JSON.parse(computed.output).transformation_ref, label_field: 'team', value_fields: issue === 'invalid-field' ? ['missing'] : ['total'] };
  }
  if (['bad-fact', 'revoked-write', 'revoked-read'].includes(issue)) {
    const real = h.editor.edit.bind(h.editor); vi.spyOn(h.editor, 'edit').mockImplementation(async (...args) => {
      const result = await real(...args); if (issue === 'bad-fact') result.charts![0].points++; else h.tools.setAllowedTools(new Set([issue === 'revoked-read' ? 'write' : 'read'])); return result;
    });
  }
  const result = await h.tools.run('edit_office', { schema_version: 1, path: 'existing.pptx', snapshot_ref: page.snapshot,
    edits: [edit([{ name: 'A', labels: ['A'], values: [1] }], data_from ? { data_from } : {})] });
  expect(result.status).not.toBe('success'); expect(await fs.readFile(join(h.root, 'existing.pptx'), 'utf8')).toBe('USER FILE'); expect(h.text.list()).toEqual([]);
  if (issue === 'unknown-ref') { expect(result.officeEdit?.code).toBe('chart-source-unavailable'); expect(result.output).toContain('transform_workbook again'); }
});
it.each([false, true])('preserves UTF-16 template and chart encoding with strict namespaces=%s', async strict => {
  const h = await host(); const zip = await JSZip.loadAsync(await source('bar', true)); const originalChart = (await actualChart(zip)).chartPart;
  for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir && /\.(?:xml|rels)$/.test(name)) {
    let content = await entry.async('string'); if (strict) content = content
      .replaceAll('http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main')
      .replaceAll('http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main')
      .replaceAll('http://schemas.openxmlformats.org/drawingml/2006/chart', 'http://purl.oclc.org/ooxml/drawingml/chart')
      .replaceAll('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships');
    if (name === '[Content_Types].xml') content = content.replace('presentationml.presentation.main+xml', 'presentationml.template.main+xml');
    if ([originalChart, 'ppt/presentation.xml', '[Content_Types].xml', 'ppt/_rels/presentation.xml.rels'].includes(name)) {
      zip.file(name, Buffer.concat([Buffer.from([255, 254]), Buffer.from(content.replace(/encoding="UTF-8"/i, 'encoding="UTF-16"'), 'utf16le')]));
    } else zip.file(name, content);
  }
  const out = await apply(h, await zip.generateAsync({ type: 'nodebuffer' }), [edit([{ name: 'Encoded', labels: ['A'], values: [0] }], { target_ref: 'S2-O1' })]);
  const actual = await actualChart(out.zip, 2); expect(actual.values[0].ys).toEqual(['0']);
  expect([...(await out.zip.file(actual.chartPart)!.async('nodebuffer')).subarray(0, 2)]).toEqual([255, 254]);
  expect(actual.chart).toContain(strict ? 'http://purl.oclc.org/ooxml/drawingml/chart' : 'http://schemas.openxmlformats.org/drawingml/2006/chart');
  expect(await xml(out.zip, '[Content_Types].xml')).not.toContain('presentationml.template.main+xml'); expect(out.result.output).toContain('Template copied');
});
it('converts a declared embedded workbook template copy and ignores unused macro content declarations', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await source()); const original = await actualChart(zip); const workbook = await JSZip.loadAsync(original.workbook);
  workbook.file('[Content_Types].xml', (await xml(workbook, '[Content_Types].xml')).replace('spreadsheetml.sheet.main+xml', 'spreadsheetml.template.main+xml')
    .replace('</Types>', '<Default Extension="unusedmacro" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>'));
  zip.file(original.workbookPart, await workbook.generateAsync({ type: 'nodebuffer' })); const out = await apply(h, await zip.generateAsync({ type: 'nodebuffer' }), [edit([{ name: 'Template', labels: ['A'], values: [0] }])]);
  const next = await JSZip.loadAsync((await actualChart(out.zip)).workbook); expect(await xml(next, '[Content_Types].xml')).toContain('spreadsheetml.sheet.main+xml');
  expect(await xml(next, '[Content_Types].xml')).not.toContain('spreadsheetml.template.main+xml');
});
