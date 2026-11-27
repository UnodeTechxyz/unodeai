import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validatePresentationRequest } from '../../office/PresentationContracts';
import { WorkspaceTools } from '../WorkspaceTools';
import { isGovernedWorkspaceTool } from '../requestBoundary';
import { RunLedger } from '../../observability/RunLedger';
import { recordCheckpointFileChange } from '../../observability/CheckpointFileChange';
import { saveHost, sha } from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { assertEditablePresentation, presentationInput, presentationRouteRenderer } from './presentationRouteFixtures';
import JSZip from 'jszip';
import { posix } from 'node:path';

afterEach(removeTemporaryFolders);
describe('O3 fixed presentation worker through the production host tool', () => {
  it('saves editable text unchanged and reports suggestions without Commands or new approvals', async () => {
    const h = await saveHost({ capabilities: ['write'] }); const tools = h.tools(); tools.setPresentationRenderer(await presentationRouteRenderer()); tools.beginTurn();
    try {
      const text = '中文ABC,示例 was approved';
      const result = await tools.run('write_presentation', { schema_version: 1, path: 'advice.pptx', deck: { title: 'Advice', slides: [{ objects: [
        { type: 'text', text, x: 12.5, y: 1, w: 2, h: 1 },
      ] }] } });
      expect(result.status, result.output).toBe('success'); expect(result.output).toContain('mixed-spacing [suggestion; clreq-mixed-text]');
      expect(result.output).toContain('outside-slide [suggestion; local-editorial-v1]'); expect(result.output).toContain('not a rendered check');
      const bytes = await fs.readFile(path.join(h.root, 'advice.pptx')); const zip = await JSZip.loadAsync(bytes);
      expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain(text);
      expect(result.presentationWrite?.receipt?.sha256).toBe(sha(bytes)); expect(h.state.approvals).toEqual([]);
    } finally { tools.retire(); }
  });
  it('preserves empty categories and literal X-Axis series in editable data with Write only', async () => {
    const h = await saveHost({ capabilities: ['write'] }); const tools = h.tools(); tools.setPresentationRenderer(await presentationRouteRenderer()); tools.beginTurn();
    try {
      const result = await tools.run('write_presentation', { schema_version: 1, path: 'out/labels.pptx', deck: { slides: [{ objects: [
        { type: 'chart', chartType: 'bar', x: 1, y: 1, w: 8, h: 4, series: [
          { name: 'X-Axis label', labels: ['', 'After', ''], values: [1, 2, 3] },
        ] },
      ] }] } }); expect(result.status, result.output).toBe('success');
      const bytes = await fs.readFile(path.join(h.root, 'out/labels.pptx')); const zip = await JSZip.loadAsync(bytes);
      const member = Object.keys(zip.files).find(name => name.startsWith('ppt/embeddings/') && name.endsWith('.xlsx'))!;
      const workbook = await JSZip.loadAsync(await zip.file(member)!.async('nodebuffer')); const xml = await workbook.file('xl/sharedStrings.xml')!.async('string');
      const texts = [...xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(match => match[1]);
      expect(texts).toEqual(['', 'X-Axis label', '', 'After', '']);
      expect(result.presentationWrite?.receipt?.sha256).toBe(sha(bytes)); expect(h.state.approvals).toEqual([]);
    } finally { tools.retire(); }
  });
  it('preserves zero in both chart caches and actual editable embedded workbooks with Write only', async () => {
    const h = await saveHost({ capabilities: ['write'] }); const tools = h.tools(); tools.setPresentationRenderer(await presentationRouteRenderer()); tools.beginTurn();
    const chart = (chartType: string, values: number[][]) => ({ type: 'chart', chartType, x: 0.5, y: 1, w: 7, h: 4,
      series: values.map((values, index) => ({ name: `Series${index}`, labels: ['positive', 'zero', 'negative'], values })) });
    const input = { schema_version: 1, path: 'out/zero.pptx', deck: { slides: [
      { objects: [{ type: 'text', text: 'First', x: 0, y: 0, w: 3, h: 1 }, chart('bar', [[12, 0, -3], [0, 4, 0]])] },
      { objects: [chart('line', [[0, 0.3, 0]]), chart('pie', [[0, 4, 8]])] },
    ] } };
    expect(tools.specs().some(spec => spec.function.name === 'read_file')).toBe(false);
    const saved = await tools.run('write_presentation', input); expect(saved.status, saved.output).toBe('success');
    const bytes = await fs.readFile(path.join(h.root, input.path)); const zip = await JSZip.loadAsync(bytes);
    const parts = Object.keys(zip.files).filter(name => /^ppt\/charts\/chart\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/chart(\d+)/)![1]) - Number(b.match(/chart(\d+)/)![1]));
    const expected = [[['12', '0', '-3'], ['0', '4', '0']], [['0', '0.3', '0']], [['0', '4', '8']]];
    expect(parts).toHaveLength(expected.length);
    for (const [index, part] of parts.entries()) {
      const xml = await zip.file(part)!.async('string'); const caches = [...xml.matchAll(/<c:numCache>([\s\S]*?)<\/c:numCache>/g)].map(match => [...match[1].matchAll(/<c:pt idx="\d+"><c:v>(.*?)<\/c:v><\/c:pt>/g)].map(match => match[1]));
      expect(caches).toEqual(expected[index]);
      const rels = await zip.file(posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels'))!.async('string');
      const target = rels.match(/Target="([^"]+\.xlsx)"/)![1]; const workbook = await JSZip.loadAsync(await zip.file(posix.normalize(posix.join(posix.dirname(part), target)))!.async('nodebuffer'));
      const sheet = await workbook.file('xl/worksheets/sheet1.xml')!.async('string');
      for (const [series, values] of expected[index].entries()) for (const [point, value] of values.entries()) {
        const ref = `${String.fromCharCode(66 + series)}${point + 2}`;
        expect(sheet, `${part} ${ref}`).toContain(`<c r="${ref}"><v>${value}</v></c>`);
      }
    }
    expect(saved.presentationWrite?.receipt).toMatchObject({ bytes: bytes.length, sha256: sha(bytes) }); expect(h.state.approvals).toEqual([]); tools.retire();
  });
  it('saves editable PPTX with Commands Off, actual hash, author and checkpoint evidence', async () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'ppt', requestedAgent: 'dev', agentId: 'dev', instruction: 'Make slides.' });
    const h = await saveHost({ turnId: () => 't1', onCheckpoint: entry => recordCheckpointFileChange(ledger, entry, 'ppt'),
      onEffect: effect => { ledger.fileCommits.record('ws', effect, 'model-a'); } });
    const tools = h.tools(); tools.setPresentationRenderer(await presentationRouteRenderer()); tools.beginTurn();
    expect(tools.specs().some(spec => spec.function.name === 'run_command')).toBe(false);
    const result = await tools.run('write_presentation', presentationInput());
    expect(result.status).toBe('success');
    const bytes = await fs.readFile(path.join(h.root, 'out/result.pptx')); await assertEditablePresentation(bytes);
    expect(result.presentationWrite).toMatchObject({ code: 'written', receipt: { slides: 1, sha256: sha(bytes), bytes: bytes.length } });
    expect(result.output).toContain('Visual review not performed');
    expect(result.output).not.toContain('季度报告');
    expect(ledger.snapshot()[0].delegations[0].diffDigest?.files[0].afterContentHash).toBe(sha(bytes));
    expect(h.state.approvals).toEqual([]);
    expect(ledger.fileCommits.snapshot()[0]).toMatchObject({ reportedModelId: 'model-a', sha256: sha(bytes) });
  });

  it('keeps write Off, Workspace Trust and Plan boundaries', async () => {
    const h = await saveHost({ trusted: () => false }); const renderer = await presentationRouteRenderer();
    const tools = h.tools(); tools.setPresentationRenderer(renderer); tools.beginTurn();
    expect((await tools.run('write_presentation', presentationInput())).status).toBe('refused');
    const off = new WorkspaceTools(h.root, new Set(['read'])); off.setPresentationRenderer(renderer); off.beginTurn();
    expect(off.specs().some(spec => spec.function.name === 'write_presentation')).toBe(false);
    expect((await off.run('write_presentation', presentationInput())).status).toBe('refused');
    expect(isGovernedWorkspaceTool('write_presentation', presentationInput())).toBe(true);
    expect(await fs.readdir(h.root)).toEqual([]);
  });

  it('Stop during an existing Ask approval commits no late result; next turn still works', async () => {
    const controller = new AbortController();
    const h = await saveHost({ ask: true, approve: async () => { controller.abort(); return 'once'; } });
    const tools = h.tools(); tools.setPresentationRenderer(await presentationRouteRenderer()); tools.beginTurn();
    expect((await tools.run('write_presentation', presentationInput(), { signal: controller.signal })).status).not.toBe('success');
    expect(await fs.readdir(h.root).catch(() => [])).not.toContain('result.pptx');
    await expect(fs.stat(path.join(h.root, 'out/result.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
    tools.beginTurn();
    expect((await tools.run('write_presentation', presentationInput())).status).toBe('success');
  });

  it('captures deck data before worker queue waits and rejects executable/remote/raw inputs', async () => {
    const renderer = await presentationRouteRenderer(); const request = presentationInput();
    const result = renderer.render(validatePresentationRequest(request), new AbortController().signal, () => true);
    request.deck.slides[0].objects[0].text = 'MUTATED';
    await assertEditablePresentation((await result).bytes);
    for (const extra of [{ script: 'throw 1' }, { url: 'https://example.com' }, { rawXml: '<p/>' }]) {
      expect(() => validatePresentationRequest({ ...presentationInput(), deck: { ...presentationInput().deck, ...extra } })).toThrow();
    }
    const aborted = new AbortController(); aborted.abort();
    await expect(renderer.render(validatePresentationRequest(presentationInput()), aborted.signal, () => true)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('writes two native chart series and ellipse; identifies the exact object on invalid table/chart input', async () => {
    const h = await saveHost(); const tools = h.tools(); tools.setPresentationRenderer(await presentationRouteRenderer()); tools.beginTurn();
    const input = presentationInput() as any;
    input.deck.slides[0].objects[2].series.push({ name: 'Costs', labels: ['Q1', 'Q2'], values: [56, 78] });
    input.deck.slides[0].objects.push({ type: 'shape', x: 8, y: 6, w: 1, h: 1, shape: 'ellipse' });
    expect((await tools.run('write_presentation', input)).status).toBe('success');
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, input.path)));
    const chart = await zip.file('ppt/charts/chart1.xml')!.async('string');
    expect(chart).toContain('<c:v>56</c:v>'); expect(chart).toContain('<c:v>78</c:v>');
    expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('prst="ellipse"');
    input.deck.slides[0].objects[2].chartType = 'pie';
    expect((await tools.run('write_presentation', input)).output).toContain('deck.slides[0].objects[2]. A native pie chart uses one series');
    input.deck.slides[0].objects[2].chartType = 'bar'; input.deck.slides[0].objects[2].series[1].labels = ['Other', 'Labels'];
    expect((await tools.run('write_presentation', input)).output).toContain('same labels in the same order');
    const ragged = presentationInput() as any; ragged.deck.slides[0].objects[1].rows.push(['extra']);
    expect((await tools.run('write_presentation', ragged)).output).toContain('deck.slides[0].objects[1]. Table rows must have the same number of cells');
  });
});
