import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { WorkspaceTools } from '../WorkspaceTools';
import { FileWritePolicy } from '../fileWritePolicy';
import { FileWriterLeases } from '../../history/FileWriterLeases';
import { CommandPolicy } from '../CommandPolicy';
import { ManagedDocumentHost } from '../../office/ManagedDocumentHost';
import { OfficeReader } from '../../office/OfficeReader';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { assertManagedOfficeRunnerBundleGraph } from '../../../scripts/managed-office-runner-bundle.mjs';
import { officeRouteDocument } from './officeInventoryRouteFixtures';
import { docxEmbeddedNanoidPatch } from '../../../scripts/docx-embedded-nanoid-patch.mjs';
import { PNG_BASE64 } from '../../__tests__/fixtures/tinyPng';
import { WorkbookReader } from '../../content/WorkbookReader';
import nativeOs from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

let runner: string; let inventory: string; let workbookWorker: string;
const owned: WorkspaceTools[] = [];
beforeAll(async () => {
  const root = await temporaryFolder('unode-managed-office-workers-');
  runner = join(root, 'DocumentRunner.cjs'); inventory = join(root, 'OfficeInventoryWorker.cjs');
  workbookWorker = join(root, 'WorkbookWorker.cjs');
  const result = await build({ entryPoints: ['src/office/DocumentRunner.ts'], outfile: runner, bundle: true,
    platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent', metafile: true, plugins: [docxEmbeddedNanoidPatch] });
  assertManagedOfficeRunnerBundleGraph(result.metafile);
  await build({ entryPoints: ['src/office/OfficeInventoryWorker.ts'], outfile: inventory, bundle: true,
    platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' });
  await build({ entryPoints: ['src/content/WorkbookWorker.ts'], outfile: workbookWorker, bundle: true,
    platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' });
});
afterEach(() => { for (const tools of owned.splice(0)) tools.retire(); });
afterAll(removeTemporaryFolders);
async function host(mode: 'all' | 'ask' | 'none' = 'all', approve?: ConstructorParameters<typeof WorkspaceTools>[6]) {
  const root = await temporaryFolder('unode-managed-office-route-');
  const tools = new WorkspaceTools(root, new Set(['read', 'write', 'execute']), 'agent', undefined, new CommandPolicy(mode, []), 120000, approve);
  tools.useManagedDocumentHost(new ManagedDocumentHost(runner), inventory);
  tools.setOfficeReader(new OfficeReader(inventory)); tools.beginTurn(); owned.push(tools);
  tools.setWorkbookReader(new WorkbookReader(workbookWorker), true);
  return { root, tools };
}
async function prepare(tools: WorkspaceTools, source: string, part = Math.floor(source.length / 2)) {
  const first = await tools.run('build_office', { operation: 'prepare', draft: 'program', source: source.slice(0, part) });
  expect(first.status, first.output).toBe('success'); expect(JSON.parse(first.output).state).toBe('draft');
  const ready = await tools.run('build_office', { operation: 'prepare', draft: 'program', source: source.slice(part), final: true });
  expect(ready.status, ready.output).toBe('success'); return JSON.parse(ready.output);
}
const generate = `module.exports = async ctx => {
  const fs = require('node:fs'); const { Document, Packer, Paragraph, Table, TableRow, TableCell } = require('docx');
  const document = new Document({ sections: [{ children: [new Paragraph('Managed Word result 🙂'),
    new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('Real cell')] })] })] })] }] });
  fs.writeFileSync(ctx.outputs.word, await Packer.toBuffer(document));
  const PptxGenJS = require('pptxgenjs'); const deck = new PptxGenJS();
  deck.addSlide().addText('Managed slide result', { x: 1, y: 1, w: 6, h: 1 });
  await deck.writeFile({ fileName: ctx.outputs.deck });
};`;

it('v0.9.110 R1: a build whose later output another window holds saves no output at all, and saves both once it is free', async () => {
  const { root, tools } = await host();
  const storage = await temporaryFolder('unode-managed-office-leases-');
  const me = { pid: 1, startToken: '1', bootToken: 'boot', platform: 'linux' as const };
  const identity = { platform: 'linux' as const, self: async () => 'unknown' as const, identityOf: async () => 'unknown' as const,
    liveness: async (records: readonly unknown[]) => records.map(() => 'alive' as const) };
  const clock = { t: 0 };
  const leases = new FileWriterLeases(join(storage, 'leases'), { hostInstanceId: 'me', selfIdentity: async () => me, identity,
    now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
  tools.setFileWrites(new FileWritePolicy({ workspaceId: () => 'w', fileLeases: leases })
    .forAgent({ agentId: 'agent', requestId: () => 'r1', decide: async () => 'once', notice: () => {} }));
  const other = new FileWriterLeases(join(storage, 'leases'), { hostInstanceId: 'other', selfIdentity: async () => ({ ...me, pid: 2 }), identity });
  const held = await other.acquire(join(await fs.realpath(root), 'result.pptx'), { waitMs: 0 });
  expect(held.status).toBe('held');
  const program = await prepare(tools, generate, generate.indexOf('🙂') + 1);
  const outputs = [{ name: 'word', path: 'result.docx', format: 'docx' }, { name: 'deck', path: 'result.pptx', format: 'pptx' }];
  const blocked = await tools.run('build_office', { operation: 'run', program_ref: program.program_ref, outputs });
  expect(blocked.status).toBe('failed');
  expect(blocked.output).toContain('another UnodeAi window is writing this file');
  expect(await fs.readdir(root)).toEqual([]);
  if (held.status === 'held') await held.release();
  const saved = await tools.run('build_office', { operation: 'run', program_ref: program.program_ref, outputs });
  expect(saved.status, saved.output).toBe('success');
  expect((await fs.readdir(root)).sort()).toEqual(['result.docx', 'result.pptx']);
}, 30000);

it('actual build_office draft, fixed runner, libraries, package checks and commits deliver two editable files and exact receipts', async () => {
  const { root, tools } = await host();
  expect(tools.specs().some(tool => tool.function.name === 'build_office')).toBe(true);
  const program = await prepare(tools, generate, generate.indexOf('🙂') + 1);
  expect(program.sha256).toBe(createHash('sha256').update(generate).digest('hex'));
  expect(await fs.readdir(root)).toEqual([]);
  const result = await tools.run('build_office', { operation: 'run', program_ref: program.program_ref, outputs: [
    { name: 'word', path: 'result.docx', format: 'docx' }, { name: 'deck', path: 'result.pptx', format: 'pptx' },
  ] });
  expect(result.status, result.output).toBe('success');
  const receipt = JSON.parse(result.output);
  expect(receipt.outputs).toHaveLength(2);
  expect(receipt.checks).toMatchObject({ package: 'passed', schema: 'not-run', native_rendering: 'not-run' });
  for (const item of receipt.outputs) {
    const bytes = await fs.readFile(join(root, item.name === 'word' ? 'result.docx' : 'result.pptx'));
    expect(item.receipt).toMatchObject({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file(item.name === 'word' ? 'word/document.xml' : 'ppt/slides/slide1.xml')!.async('string'))
      .toContain(item.name === 'word' ? 'Managed Word result' : 'Managed slide result');
  }
}, 30000);
it('Commands Off still permits source preparation and refuses execution without running any program', async () => {
  const { root, tools } = await host('none'); const program = await prepare(tools, generate);
  const result = await tools.run('build_office', { operation: 'run', program_ref: program.program_ref,
    outputs: [{ name: 'word', path: 'result.docx', format: 'docx' }] });
  expect(result.status).toBe('refused'); expect(result.output).toContain('disabled'); expect(await fs.readdir(root)).toEqual([]);
});
it('alternate temp and Windows runner spellings use canonical paths through the actual gate, fork, capture and cleanup', async () => {
  const { root, tools } = await host('ask', async () => ({ allow: true }));
  const physicalTemp = join(root, 'physical-temp'); const aliasTemp = join(root, 'temp-alias');
  await fs.mkdir(physicalTemp); await fs.symlink(physicalTemp, aliasTemp, process.platform === 'win32' ? 'junction' : 'dir');
  const alternateRunner = process.platform === 'win32' ? runner.replace(/^[A-Z]:/, value => value.toLowerCase()) : runner;
  tools.useManagedDocumentHost(new ManagedDocumentHost(alternateRunner), inventory);
  const spy = vi.spyOn(nativeOs, 'tmpdir').mockReturnValue(aliasTemp); syncBuiltinESMExports();
  try {
    const program = await prepare(tools, generate);
    const prepared = await (tools as any).managedPrograms.read(program.program_ref, (tools as any).workbookContext());
    expect(prepared.file).toBe(await fs.realpath(prepared.file)); expect(prepared.file).not.toContain('temp-alias');
    const before = (await fs.readdir(physicalTemp)).sort();
    const result = await tools.run('build_office', { operation: 'run', program_ref: program.program_ref, outputs: [
      { name: 'word', path: 'alias.docx', format: 'docx' }, { name: 'deck', path: 'alias.pptx', format: 'pptx' },
    ] });
    expect(result.status, result.output).toBe('success'); expect(JSON.parse(result.output).staging_cleanup).toBe('removed');
    expect(JSON.parse(result.output).outputs.every((output: any) => output.status === 'success')).toBe(true);
    expect((await fs.readdir(physicalTemp)).sort()).toEqual(before);
    const zip = await JSZip.loadAsync(await fs.readFile(join(root, 'alias.docx')));
    expect(await zip.file('word/document.xml')!.async('string')).toContain('Managed Word result');
  } finally { spy.mockRestore(); syncBuiltinESMExports(); }
}, 30000);
it('a staging cleanup error preserves the actual changed-program outcome and reports retained staging', async () => {
  const roots: string[] = [];
  const { tools } = await host('ask', async () => { await fs.appendFile(file, ' changed'); return { allow: true }; });
  tools.useManagedDocumentHost(new ManagedDocumentHost(runner, undefined, undefined, async directory => { roots.push(directory); throw Error('synthetic cleanup EBUSY'); }), inventory);
  const program = await prepare(tools, generate);
  const file = (await (tools as any).managedPrograms.read(program.program_ref, (tools as any).workbookContext())).file;
  try {
    const result = await tools.run('build_office', { operation: 'run', format: 'docx', program_ref: program.program_ref,
      outputs: [{ name: 'word', path: 'result.docx' }] });
    expect(result.status).toBe('failed'); expect(JSON.parse(result.output)).toMatchObject({ error: 'managed-program-changed', staging_cleanup: 'not-removed' });
    expect(roots).toHaveLength(1);
  } finally {
    for (const directory of roots) {
      if (await fs.realpath(directory) !== directory || !directory.split(/[\\/]/).at(-1)!.startsWith('unode-office-build-')) throw Error('Unsafe fixture cleanup');
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});
it('Ask uses the existing command approval exactly once and shows the exact prepared program', async () => {
  const approval = vi.fn(async () => ({ allow: true })); const { tools } = await host('ask', approval);
  const program = await prepare(tools, generate);
  const result = await tools.run('build_office', { operation: 'run', program_ref: program.program_ref, outputs: [
    { name: 'word', path: 'result.docx', format: 'docx' }, { name: 'deck', path: 'result.pptx', format: 'pptx' },
  ] });
  expect(result.status, result.output).toBe('success'); expect(approval).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(approval.mock.calls)).toContain('Managed Office program SHA-256: ' + program.sha256);
  expect(JSON.stringify(approval.mock.calls)).toContain('Managed Word result');
}, 30000);
it('a program changed during approval cannot execute different bytes or create a receipt', async () => {
  const { root, tools } = await host('ask', async () => { await fs.appendFile(file!, '\nthrow Error("changed");'); return { allow: true }; });
  const program = await prepare(tools, generate);
  const file = (await (tools as any).managedPrograms.read(program.program_ref, (tools as any).workbookContext())).file;
  const result = await tools.run('build_office', { operation: 'run', program_ref: program.program_ref,
    outputs: [{ name: 'word', path: 'result.docx', format: 'docx' }] });
  expect(result.status).toBe('failed'); expect(result.output).toContain('managed-program-changed'); expect(await fs.readdir(root)).toEqual([]);
});
it('invalid staged Office bytes fail the actual package check before any host destination is written', async () => {
  const { root, tools } = await host();
  const program = await prepare(tools, `module.exports = ctx => require('node:fs').writeFileSync(ctx.outputs.word, 'not an Office package');`);
  const result = await tools.run('build_office', { operation: 'run', program_ref: program.program_ref,
    outputs: [{ name: 'word', path: 'result.docx', format: 'docx' }] });
  expect(result.status).toBe('failed'); expect(await fs.readdir(root)).toEqual([]); expect(JSON.parse(result.output).outputs).toEqual([]);
});
it('an input changed during command approval does not run against an obsolete snapshot', async () => {
  const { root, tools } = await host('ask', async () => { await fs.appendFile(source, 'source changed'); return { allow: true }; });
  const source = join(root, 'source.docx'); await fs.writeFile(source, await officeRouteDocument());
  const inspected = await tools.run('inspect_office', { path: 'source.docx' });
  expect(inspected.status, inspected.output).toBe('success');
  const program = await prepare(tools, `module.exports = ctx => { const fs = require('node:fs'); fs.writeFileSync('ran.txt', 'must not run against a changed source'); fs.copyFileSync(Object.values(ctx.inputs)[0], ctx.outputs.word); };`);
  const result = await tools.run('build_office', { operation: 'run', program_ref: program.program_ref, input_snapshot_refs: [JSON.parse(inspected.output).snapshot_ref],
    outputs: [{ name: 'word', path: 'result.docx', format: 'docx' }] });
  expect(result.status).toBe('failed'); expect(result.output).toContain('managed-input-changed');
  expect(await fs.readdir(root)).toEqual(['source.docx']);
});
it('actual asset bytes are decoded, staged and usable by the generator without widening another agent’s assets', async () => {
  const { root, tools } = await host(); const assets = (tools as any).contentAssets;
  const asset = await assets.storeImage(Buffer.from(PNG_BASE64, 'base64'), 'tool-result', 'image/png', 'agent');
  const other = await assets.storeImage(Buffer.from(PNG_BASE64, 'base64'), 'tool-result', 'image/png', 'another-agent');
  const program = await prepare(tools, `module.exports = async ctx => { const Pptx = require('pptxgenjs'); const deck = new Pptx(); deck.addSlide().addImage({ path: Object.values(ctx.assets)[0], x: 1, y: 1, w: 2, h: 2 }); await deck.writeFile({ fileName: ctx.outputs.deck }); };`);
  const request = { operation: 'run', program_ref: program.program_ref, asset_refs: [other.assetId],
    outputs: [{ name: 'deck', path: 'image.pptx', format: 'pptx' }] };
  const denied = await tools.run('build_office', request); expect(denied.status).toBe('failed'); expect(denied.output).toContain('managed-asset-unavailable');
  const saved = await tools.run('build_office', { ...request, asset_refs: [asset.assetId] });
  expect(saved.status, saved.output).toBe('success');
  const zip = await JSZip.loadAsync(await fs.readFile(join(root, 'image.pptx')));
  const media = Object.values(zip.files).filter(file => !file.dir && file.name.startsWith('ppt/media/'));
  expect(media).toHaveLength(1); expect(await media[0].async('nodebuffer')).toEqual(Buffer.from(PNG_BASE64, 'base64'));
  expect(JSON.parse(saved.output).assets).toEqual([{ asset_ref: asset.assetId, sha256: createHash('sha256').update(Buffer.from(PNG_BASE64, 'base64')).digest('hex') }]);
}, 30000);
it('request limits leave preparation unheld, hold the actual build, and Continue delivers the artifact', async () => {
  const { root, tools } = await host();
  const asked: string[] = []; let answer: (value: 'proceed' | 'stopped') => void = () => {};
  let reached: () => void = () => {}; const held = new Promise<void>(resolve => { reached = resolve; });
  tools.setRequestBoundary(async (_kind, detail) => { asked.push(detail?.tool ?? ''); return new Promise(resolve => { answer = resolve; reached(); }); });
  const program = await prepare(tools, generate); expect(asked).toEqual([]);
  const pending = tools.run('build_office', { operation: 'run', program_ref: program.program_ref, outputs: [
    { name: 'word', path: 'result.docx', format: 'docx' }, { name: 'deck', path: 'result.pptx', format: 'pptx' },
  ] });
  await held; expect(asked).toEqual(['build_office']); expect(await fs.readdir(root)).toEqual([]);
  answer('proceed'); const result = await pending; expect(result.status, result.output).toBe('success');
  expect(await fs.readdir(root)).toEqual(['result.docx', 'result.pptx']); expect(asked).toHaveLength(1);
}, 30000);
it('Stop at the request boundary refuses the real build without starting its program', async () => {
  const { root, tools } = await host(); const program = await prepare(tools, generate);
  tools.setRequestBoundary(async () => 'stopped');
  const result = await tools.run('build_office', { operation: 'run', program_ref: program.program_ref,
    outputs: [{ name: 'word', path: 'result.docx', format: 'docx' }] });
  expect(result).toMatchObject({ status: 'refused', reason: 'safety-limit' }); expect(await fs.readdir(root)).toEqual([]);
});
it('an inspected immutable input is copied to staging and the actual output receipt preserves its source hash', async () => {
  const { root, tools } = await host(); const bytes = await officeRouteDocument(); await fs.writeFile(join(root, 'source.docx'), bytes);
  const inspected = await tools.run('inspect_office', { path: 'source.docx' }); expect(inspected.status, inspected.output).toBe('success');
  const ref = JSON.parse(inspected.output).snapshot_ref;
  const program = await prepare(tools, `module.exports = ctx => require('node:fs').copyFileSync(Object.values(ctx.inputs)[0], ctx.outputs.word);`);
  const result = await tools.run('build_office', { operation: 'run', format: 'docx', program_ref: program.program_ref, input_snapshot_refs: [ref],
    outputs: [{ name: 'word', path: 'copy.docx' }] });
  expect(result.status, result.output).toBe('success'); expect(await fs.readFile(join(root, 'copy.docx'))).toEqual(bytes);
  expect(JSON.parse(result.output).inputs).toEqual([{ snapshot_ref: ref, sha256: createHash('sha256').update(bytes).digest('hex') }]);
}, 30000);
it('an actual read_workbook CSV snapshot is handed as immutable bytes to the managed Word generator', async () => {
  const { root, tools } = await host(); const csv = Buffer.from('item,quantity\nActual,37\n');
  await fs.writeFile(join(root, 'input.csv'), csv);
  const read = await tools.run('read_workbook', { path: 'input.csv', operation: 'inspect' });
  expect(read.status, read.output).toBe('success'); const ref = JSON.parse(read.output).snapshot_ref;
  const program = await prepare(tools, `module.exports = async ctx => { const fs = require('node:fs'); const { Document, Packer, Paragraph } = require('docx'); const text = fs.readFileSync(Object.values(ctx.inputs)[0], 'utf8'); fs.writeFileSync(ctx.outputs.word, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(text)] }] }))); };`);
  const result = await tools.run('build_office', { operation: 'run', format: 'docx', program_ref: program.program_ref, input_snapshot_refs: [ref],
    outputs: [{ name: 'word', path: 'data.docx' }] });
  expect(result.status, result.output).toBe('success');
  const zip = await JSZip.loadAsync(await fs.readFile(join(root, 'data.docx')));
  expect(await zip.file('word/document.xml')!.async('string')).toContain('Actual,37');
  expect(JSON.parse(result.output).inputs).toEqual([{ snapshot_ref: ref, sha256: createHash('sha256').update(csv).digest('hex') }]);
}, 30000);
it.skipIf(process.platform !== 'win32')('Windows output aliases cannot silently overwrite another declared result', async () => {
  const { root, tools } = await host(); const program = await prepare(tools, `module.exports = () => require('node:fs').writeFileSync('ran.txt', 'ran');`);
  const result = await tools.run('build_office', { operation: 'run', format: 'docx', program_ref: program.program_ref, outputs: [
    { name: 'first', path: 'Result.docx' }, { name: 'second', path: 'result.docx' },
  ] });
  expect(result.status).toBe('failed'); expect(result.output).toContain('managed-duplicate-output'); expect(await fs.readdir(root)).toEqual([]);
});
it('Stop terminates the owned running generator and prevents a late staged output from committing', async () => {
  const { root, tools } = await host();
  const program = await prepare(tools, `module.exports = async ctx => { const fs = require('node:fs'); fs.writeFileSync('started.txt', 'started'); await new Promise(resolve => setTimeout(resolve, 600000)); fs.writeFileSync(ctx.outputs.word, 'late'); };`);
  const stop = new AbortController(); const result = tools.run('build_office', { operation: 'run', program_ref: program.program_ref,
    outputs: [{ name: 'word', path: 'result.docx', format: 'docx' }] }, { signal: stop.signal });
  await vi.waitFor(async () => expect(await fs.readFile(join(root, 'started.txt'), 'utf8')).toBe('started'), { timeout: 180000 });
  stop.abort(); const ended = await result;
  expect(ended.status).toBe('failed'); expect(ended.output).toContain('"error":"managed-build-stopped"');
  expect(await fs.readdir(root)).toEqual(['started.txt']);
}, 60000);
