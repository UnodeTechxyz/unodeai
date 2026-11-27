import PptxGenJS from 'pptxgenjs';
import type { PresentationDeck, PresentationImageInput, PresentationImageReceipt, PresentationRender } from './PresentationContracts';
import { decodePng, ImageDecodeFailure } from './PngDecode';
import { decodeJpeg } from './JpegDecode';
import { getHeapStatistics } from 'node:v8';
import type { WorkbookBindingInput } from '../content/WorkbookBinding';
import { bindPresentationData } from './PresentationDataBinding';
import { checkPresentationData } from './PresentationDataCheck';
import { preservePresentationChartZeros } from './PresentationChartZero';
import { bindPresentationCharts } from './PresentationChartBinding';
import { checkPresentationCharts } from './PresentationChartCheck';
import { preservePresentationChartStrings } from './PresentationChartStrings';
import { preservePresentationChartDisplay } from './PresentationChartDisplay';

/** Fixed generator, not an evaluator. The worker receives only canonical finite data. */
export async function buildPresentation(deck: PresentationDeck, images: readonly PresentationImageInput[] = [], bindings: readonly WorkbookBindingInput[] = []): Promise<PresentationRender> {
  const charts = bindPresentationCharts(deck, bindings);
  const bound = bindPresentationData(charts.deck, bindings); deck = bound.deck;
  const available = new Map(images.map(image => [image.assetRef, image]));
  const decoded = new Map<string, { data: string; receipt: PresentationImageReceipt }>();
  for (const page of deck.slides) for (const object of page.objects) {
    if (object.type !== 'image' || decoded.has(object.asset_ref)) continue;
    const image = available.get(object.asset_ref);
    if (!image) throw new ImageDecodeFailure('invalid-image');
    const memoryBudget = Math.floor(getHeapStatistics().heap_size_limit / 8);
    const jpeg = image.bytes[0] === 255 && image.bytes[1] === 216;
    const jpegPixels = jpeg ? decodeJpeg(image.bytes, memoryBudget) : undefined;
    const pixels = jpegPixels ?? decodePng(image.bytes, memoryBudget);
    if (pixels.sha256 !== image.sha256) throw new ImageDecodeFailure('invalid-image');
    const embedded = jpegPixels?.png ?? image.bytes;
    decoded.set(image.assetRef, { data: `image/png;base64,${embedded.toString('base64')}`,
      receipt: { assetRef: image.assetRef, sha256: pixels.sha256, width: pixels.width, height: pixels.height, placements: 0,
        ...(jpegPixels ? { embeddedSha256: jpegPixels.embeddedSha256, sourceMimeType: 'image/jpeg' as const,
          orientation: jpegPixels.orientation, colorProfile: jpegPixels.colorProfile } : {}) } });
  }
  const pptx = new PptxGenJS();
  pptx.layout = deck.layout === 'wide' ? 'LAYOUT_WIDE' : 'LAYOUT_4x3';
  pptx.title = deck.title;
  pptx.author = 'UnodeAi';
  pptx.subject = 'Editable presentation';
  for (const page of deck.slides) {
    const slide = pptx.addSlide();
    for (const item of page.objects) {
      const position = { x: item.x, y: item.y, w: item.w, h: item.h };
      switch (item.type) {
        case 'text': slide.addText(item.text, { ...position, fontSize: item.fontSize, bold: item.bold, color: item.color }); break;
        case 'table': slide.addTable(item.rows.map(row => row.map(text => ({ text }))), { ...position, fontSize: item.fontSize, autoPage: false }); break;
        case 'chart': slide.addChart(pptx.ChartType[item.chartType], item.series.map(series => ({ ...series, labels: [...series.labels], values: [...series.values] })),
          { ...position, ...(item.data_from ? { displayBlanksAs: 'gap' } : {}) }); break;
        case 'shape': slide.addShape(pptx.ShapeType[item.shape], { ...position, fill: { color: item.fill }, line: { color: item.line } }); break;
        case 'image': {
          const image = decoded.get(item.asset_ref)!; const { width, height } = image.receipt;
          const scale = Math.min(item.w / width, item.h / height); const w = width * scale; const h = height * scale;
          slide.addImage({ data: image.data, x: item.x + (item.w - w) / 2, y: item.y + (item.h - h) / 2, w, h, altText: item.altText });
          image.receipt.placements++; break;
        }
      }
    }
    if (page.notes) slide.addNotes(page.notes);
  }
  const bytes = await pptx.write({ outputType: 'nodebuffer', compression: true });
  const output = await preservePresentationChartDisplay(await preservePresentationChartStrings(await preservePresentationChartZeros(Buffer.from(bytes as Buffer), deck), deck), charts.expectations);
  const dataBindings = await checkPresentationData(output, bound.expectations);
  const chartBindings = await checkPresentationCharts(output, charts.expectations);
  return { bytes: output, slides: deck.slides.length, images: [...decoded.values()].map(image => image.receipt), ...(dataBindings.length ? { dataBindings } : {}), ...(chartBindings.length ? { chartBindings } : {}) };
}
