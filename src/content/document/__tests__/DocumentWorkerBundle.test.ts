import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// Build only this fixed worker, never the extension/candidate/VSIX. Run the resulting real message handler.
const graph = async () => import('../../../../scripts/document-worker-bundle.mjs');
const nativeGuard = resolve('scripts/document-worker-no-native.cjs');
function runWorker(code: string, message?: unknown) {
  return new Promise<{ code: number; reply: any; error?: string }>((resolve) => {
    const worker = new Worker(code, { eval: true, execArgv: ['--require', nativeGuard],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
    let reply: unknown; let error: string | undefined;
    const timer = setTimeout(() => { void worker.terminate(); }, 5000);
    worker.on('message', value => { reply = value; });
    worker.on('error', value => { error = value.message; });
    worker.on('exit', code => { clearTimeout(timer); resolve({ code, reply, error }); });
    if (message) worker.postMessage(message);
  });
}

describe('the real DOCX worker bundle entry and native-load boundary', () => {
  it('uses the exact direct dependency and actual esbuild entry; runs the generated worker with a native-load sentinel', async () => {
    const { DOCUMENT_WORKER_ENTRY, assertDocumentWorkerBundleGraph } = await graph();
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    expect(pkg.dependencies.yazl).toBe('3.3.1'); expect(lock.packages['node_modules/yazl'].version).toBe('3.3.1');
    expect(lock.packages[''].dependencies.yazl).toBe('3.3.1');
    expect(lock.packages['node_modules/yazl'].integrity).toBe('sha512-BbETDVWG+VcMUle37k5Fqp//7SDOK2/1+T7X8TD96M3D9G8jK5VLUdQVdVjGi8im7FGkazX7kk5hkU8X4L5Bng==');
    // The public source drop must keep the build/test helpers, not the private prototype harness.
    const publicSource = ts.createSourceFile('build-public-drop.mjs', readFileSync('scripts/build-public-drop.mjs', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let allowlist: ts.Expression | undefined;
    const findAllowlist = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(publicSource) === 'INCLUDE_SCRIPTS') allowlist = node.initializer;
      ts.forEachChild(node, findAllowlist);
    }; findAllowlist(publicSource);
    expect(allowlist && ts.isArrayLiteralExpression(allowlist)).toBe(true);
    const copied = new Function(`return (${allowlist!.getText(publicSource)});`)();
    expect(copied).toEqual(expect.arrayContaining(['document-worker-bundle.mjs', 'document-worker-no-native.cjs', 'generate-document-unicode.mjs']));
    const source = ts.createSourceFile('esbuild.config.mjs', readFileSync('esbuild.config.mjs', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let entry: ts.Expression | undefined; let guard: ts.CallExpression | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === "'content/document/DocumentRenderWorker'") entry = node.initializer;
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'assertDocumentWorkerBundleGraph') guard = node;
      ts.forEachChild(node, visit);
    }; visit(source);
    expect(entry).toBeDefined(); expect(guard).toBeDefined();
    const actualEntry = new Function('DOCUMENT_WORKER_ENTRY', `return (${entry!.getText(source)});`)(DOCUMENT_WORKER_ENTRY);
    const result = await build({ entryPoints: [actualEntry], bundle: true, platform: 'node', format: 'cjs', target: 'node18', write: false, metafile: true });
    const actualGuard = new Function('assertDocumentWorkerBundleGraph', 'result', guard!.getText(source));
    expect(result.outputFiles[0].contents.byteLength).toBeLessThan(8 * 1024 * 1024);
    actualGuard(assertDocumentWorkerBundleGraph, result);
    expect(Object.keys(result.metafile.inputs).some(path => path.replaceAll('\\', '/').endsWith('yazl/index.js'))).toBe(true);
    const rendered = await runWorker(result.outputFiles[0].text, { jobId: 'docx-proof', format: 'docx', template: 'report-v1',
      document: { title: 'Proof', blocks: [{ type: 'paragraph', content: [{ text: 'A < B & C > D' }] }] } });
    expect(rendered).toMatchObject({ code: 0, reply: { ok: true, jobId: 'docx-proof', stats: { format: 'docx' } } });
    expect(Buffer.from(rendered.reply.bytes).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
  });

  it('refuses native inputs, external packages, absent entry and real addon loading (even when caught)', async () => {
    const { DOCUMENT_WORKER_ENTRY, assertDocumentWorkerBundleGraph } = await graph();
    const output = { entryPoint: DOCUMENT_WORKER_ENTRY, inputs: { 'native.node': {} }, imports: [] };
    expect(() => assertDocumentWorkerBundleGraph({ outputs: { worker: output } })).toThrow();
    expect(() => assertDocumentWorkerBundleGraph({ outputs: {} })).toThrow();
    expect(() => assertDocumentWorkerBundleGraph({ outputs: { worker: { ...output, inputs: {}, imports: [{ external: true, path: 'native-package' }] } } })).toThrow();
    const loaded = await runWorker("try { process.dlopen({}, 'not-a-real-addon.node'); } catch {} require('node:worker_threads').parentPort.close();");
    expect(loaded.code).toBe(1);
  });
});
