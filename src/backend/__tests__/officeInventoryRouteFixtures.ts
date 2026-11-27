import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { OfficeReader } from '../../office/OfficeReader';
import { OfficeEditor } from '../../office/OfficeEditor';
import { OfficeAttachmentQualifier } from '../../content/OfficeAttachmentQualifier';
import { temporaryFolder } from './pathSafetyFixtures';
export async function officeRouteReader() {
  const root = await temporaryFolder('unode-office-route-worker-'); const worker = join(root, 'OfficeInventoryWorker.cjs');
  const result = await build({ entryPoints: ['src/office/OfficeInventoryWorker.ts'], outfile: worker, bundle: true,
    platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent', metafile: true });
  const { assertOfficeInventoryWorkerBundleGraph } = await import('../../../scripts/office-inventory-worker-bundle.mjs');
  assertOfficeInventoryWorkerBundleGraph(result.metafile); return new OfficeReader(worker);
}
export async function officeRouteEditor(options: { corruptPictureXml?: boolean } = {}) {
  const root = await temporaryFolder('unode-office-edit-worker-'); const worker = join(root, 'OfficeEditWorker.cjs');
  const result = await build({ entryPoints: ['src/office/OfficeEditWorker.ts'], outfile: worker, bundle: true,
    platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent', metafile: true,
    plugins: options.corruptPictureXml ? [{ name: 'fault-injected-picture-xml', setup(builder) {
      builder.onLoad({ filter: /OfficePicturePatch\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8'))
        .replace("const xml = chunks.join('');", "const xml = chunks.join('') + '<';"), loader: 'ts', resolveDir: dirname(args.path) }));
    } }] : [] });
  const { assertOfficeEditWorkerBundleGraph } = await import('../../../scripts/office-edit-worker-bundle.mjs');
  assertOfficeEditWorkerBundleGraph(result.metafile); return new OfficeEditor(worker);
}
export async function officeRouteAttachmentQualifier(options: { corruptSha?: boolean } = {}) {
  const root = await temporaryFolder('unode-office-type-worker-'); const worker = join(root, 'OfficeAttachmentTypeWorker.cjs');
  const result = await build({ entryPoints: ['src/content/OfficeAttachmentTypeWorker.ts'], outfile: worker, bundle: true,
    platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent', metafile: true,
    plugins: options.corruptSha ? [{ name: 'fault-injected-worker-receipt', setup(builder) {
      builder.onLoad({ filter: /OfficeAttachmentTypeWorker\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8'))
        .replace("sha256: digest.digest('hex')", "sha256: '0'.repeat(64)"), loader: 'ts', resolveDir: dirname(args.path) }));
    } }] : [] });
  const { assertOfficeAttachmentTypeWorkerBundleGraph } = await import('../../../scripts/office-attachment-type-worker-bundle.mjs');
  assertOfficeAttachmentTypeWorkerBundleGraph(result.metafile); return new OfficeAttachmentQualifier(worker);
}
export async function officeRouteDocument() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Actual Office 名称</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
export function officeRouteParagraph(page: any) {
  return page.prepared_fragments.find((item: any) => item.kind === 'paragraph')?.record;
}
