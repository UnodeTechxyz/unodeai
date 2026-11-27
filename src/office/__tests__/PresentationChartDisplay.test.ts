import { expect, it } from 'vitest';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { preservePresentationChartDisplay, presentationChartDisplayDifferences } from '../PresentationChartDisplay';
import type { PresentationChartExpectation } from '../PresentationChartBinding';
import { chartValues, relationship } from '../PresentationChartZero';
import { officeXmlElements } from '../OfficeXmlElements';
it('adds numeric display styles to the generated native chart and embedded workbook', async () => {
  const ppt = new PptxGenJS(); ppt.addSlide().addChart(ppt.ChartType.bar, [{ name: 'percent', labels: ['Day'], values: [0.15] }], { x: 1, y: 1, w: 6, h: 3 });
  const expectation: PresentationChartExpectation = {
    fact: { slide: 1, object: 1, chart: 1, transformation_ref: 'transformation', selection: { transformation_ref: 'transformation', label_field: 'date', value_fields: ['percent'] },
      sources: [], points: 1, precision_loss: 1, blank_points: 0, unknown_labels: 0, partial: false, supplied: { present: false, differences: 0 } },
    values: { labels: ['Day'], series: [{ name: 'percent', labels: ['Day'], values: [0.15] }], unknownLabels: 0, partial: false, exactNote: '',
      points: [{ row: 1, field: 'percent', exact_text: '0.15', kind: 'number', value: 0.15, binary_exact: false, unresolved: false, display_text: '15%', format_code: '0%' }] },
  };
  const bytes = await preservePresentationChartDisplay(Buffer.from(await ppt.write({ outputType: 'nodebuffer' }) as Buffer), [expectation]);
  const zip = await JSZip.loadAsync(bytes); expect(await zip.file('ppt/charts/chart1.xml')!.async('string')).toContain('formatCode="0%"');
});

async function generated(formats: string[], values = [1234.5, -1000.2, 0]) {
  const labels = values.map((_, index) => `Day ${index + 1}`); const ppt = new PptxGenJS();
  ppt.addSlide().addChart(ppt.ChartType.bar, [{ name: 'value', labels, values }], { x: 1, y: 1, w: 6, h: 3 });
  const expectation: PresentationChartExpectation = {
    fact: { slide: 1, object: 1, chart: 1, transformation_ref: 'ref', selection: { transformation_ref: 'ref', label_field: 'date', value_fields: ['value'] },
      sources: [], points: values.length, precision_loss: 0, blank_points: 0, unknown_labels: 0, partial: false, supplied: { present: false, differences: 0 } },
    values: { labels, series: [{ name: 'value', labels, values }], unknownLabels: 0, partial: false, exactNote: '',
      points: values.map((value, index) => ({ row: index + 1, field: 'value', exact_text: String(value), kind: 'number' as const,
        value, binary_exact: true, unresolved: false, display_text: String(value), format_code: formats[index] })) },
  };
  const original = Buffer.from(await ppt.write({ outputType: 'nodebuffer' }) as Buffer);
  const bytes = await preservePresentationChartDisplay(original, [expectation]); const zip = await JSZip.loadAsync(bytes);
  const chartPart = zip.file(/^ppt\/charts\/chart\d+\.xml$/)[0].name;
  const chart = await zip.file(chartPart)!.async('string');
  const workbookPart = await relationship(zip, chartPart, chartValues(chart).embedded, 'package');
  return { original, expectation, chart, chartPart, workbook: await JSZip.loadAsync(await zip.file(workbookPart)!.async('nodebuffer')) };
}
it.each([
  { format: '"$"#,##0.00', values: [1234.5, -1000.2, 0] },
  { format: '0%', values: [0.15, 0.2, 0] },
])('retains $format in the numeric cache before native first-open refresh', async ({ format, values }) => {
  const result = await generated(values.map(() => format), values);
  const parsed = officeXmlElements(Buffer.from(result.chart), () => {});
  const cache = parsed.elements.find(node => node.tag.local === 'formatCode' && node.parent?.tag.local === 'numCache')!;
  const contents = result.chart.slice(cache.openEnd, result.chart.lastIndexOf('</', cache.end - 1));
  expect(contents).toBe(format.replaceAll('"', '&quot;'));
  const originalZip = await JSZip.loadAsync(result.original);
  expect(chartValues(result.chart).series).toEqual(chartValues(await originalZip.file(result.chartPart)!.async('string')).series);
  expect(await presentationChartDisplayDifferences(result.chart, result.workbook, result.expectation)).toBe(0);
  // A valid, native-openable stale cache is a real regression even when per-point labels/workbook styles are correct.
  const stale = result.chart.slice(0, cache.openEnd) + 'General' + result.chart.slice(result.chart.lastIndexOf('</', cache.end - 1));
  expect(await presentationChartDisplayDifferences(stale, result.workbook, result.expectation)).toBe(1);
});
it('retains per-point mixed formats without applying one point format to the entire cache', async () => {
  const result = await generated(['0%', '"$"#,##0.00', 'General']);
  expect(result.chart).toContain('<c:formatCode>General</c:formatCode>');
  expect(result.chart).toContain('formatCode="0%"');
  expect(result.chart).toContain('formatCode="&quot;$&quot;#,##0.00"');
  expect(await presentationChartDisplayDifferences(result.chart, result.workbook, result.expectation)).toBe(0);
});
