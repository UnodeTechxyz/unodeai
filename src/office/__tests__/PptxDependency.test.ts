import { describe, expect, it } from 'vitest';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import * as path from 'node:path';

describe('pinned PPT dependency qualification', () => {
  it('writes editable text, table, native chart/workbook and inline PNG with the patched dependency tree', async () => {
    const deck = new PptxGenJS();
    deck.layout = 'LAYOUT_WIDE';
    const slide = deck.addSlide();
    slide.addText('Quarterly revenue', { x: 0.5, y: 0.2, w: 10, h: 0.6 });
    slide.addTable([['Quarter', 'Revenue'], ['Q1', '12'], ['Q2', '34']], { x: 0.5, y: 1, w: 4, h: 2 });
    slide.addChart(deck.ChartType.bar, [{ name: 'Revenue', labels: ['Q1', 'Q2'], values: [12, 34] }], { x: 5, y: 1, w: 6, h: 4 });
    slide.addImage({ x: 0.5, y: 4, w: 1, h: 1,
      data: 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' });
    const bytes = await deck.write({ outputType: 'nodebuffer', compression: true });
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('Quarterly revenue');
    expect(xml).toContain('<a:tbl>');
    expect(xml).toContain('<c:chart');
    expect(xml).toContain('<p:pic>');
    const chart = await zip.file('ppt/charts/chart1.xml')!.async('string');
    expect(chart).toContain('<c:v>12</c:v>');
    expect(chart).toContain('<c:v>34</c:v>');
    const workbookPath = Object.keys(zip.files).find(name => name.startsWith('ppt/embeddings/') && name.endsWith('.xlsx'));
    expect(workbookPath).toBeDefined();
    const workbook = await JSZip.loadAsync(await zip.file(workbookPath!)!.async('nodebuffer'));
    const sheet = await workbook.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toContain('<v>12</v>'); expect(sheet).toContain('<v>34</v>');
    expect(Object.keys(zip.files).filter(name => name.startsWith('ppt/media/') && !zip.files[name].dir)).toHaveLength(1);
  });

  it('pinned runtime entry does not call the overridden image-size API', () => {
    const entry = require.resolve('pptxgenjs');
    for (const runtimeEntry of [entry, path.join(path.dirname(entry), 'pptxgen.es.js')]) {
    const source = ts.createSourceFile(runtimeEntry, readFileSync(runtimeEntry, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    const imports: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) imports.push(arg.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(imports).toContain('jszip');
    expect(imports).toContain('node:https');
    expect(imports).not.toContain('image-size');
    expect(imports).not.toContain('https');
    }
  });
});
