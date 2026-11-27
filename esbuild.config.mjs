import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DOCUMENT_WORKER_ENTRY, assertDocumentWorkerBundleGraph } from './scripts/document-worker-bundle.mjs';
import { PRESENTATION_WORKER_ENTRY, assertPresentationWorkerBundleGraph } from './scripts/presentation-worker-bundle.mjs';
import { WORKBOOK_WORKER_ENTRY, assertWorkbookWorkerBundleGraph } from './scripts/workbook-worker-bundle.mjs';
import { OFFICE_INVENTORY_WORKER_ENTRY, assertOfficeInventoryWorkerBundleGraph } from './scripts/office-inventory-worker-bundle.mjs';
import { OFFICE_EDIT_WORKER_ENTRY, assertOfficeEditWorkerBundleGraph } from './scripts/office-edit-worker-bundle.mjs';
import { OFFICE_ATTACHMENT_TYPE_WORKER_ENTRY, assertOfficeAttachmentTypeWorkerBundleGraph } from './scripts/office-attachment-type-worker-bundle.mjs';
import { OFFICE_RENDER_PURE_WORKER_ENTRY, assertOfficeRenderPureWorkerBundleGraph } from './scripts/office-render-pure-worker-bundle.mjs';
import { runtimePackageDirectories } from './scripts/runtime-package-directories.mjs';
import { MANAGED_OFFICE_RUNNER_ENTRY, assertManagedOfficeRunnerBundleGraph } from './scripts/managed-office-runner-bundle.mjs';
import { docxEmbeddedNanoidPatch } from './scripts/docx-embedded-nanoid-patch.mjs';

/**
 * Stamp only runtime bundle inputs, not all of HEAD. During a fast fix/package/install/retest loop, "is the user actually
 * running the build I just made?" becomes a real and expensive question — we burned a whole round of
 * debugging on a probe that appeared to be broken when it may simply not have been installed. The version
 * A full-HEAD stamp makes an artifact-hash receipt self-referential; this input fingerprint avoids that.
 */
function buildStamp() {
  try {
    const inputs = ['src', 'esbuild.config.mjs', 'package.json', 'package-lock.json'];
    const revisions = inputs.map((input) => execFileSync(
      'git',
      ['rev-parse', `HEAD:${input}`],
      { encoding: 'utf8' },
    ).trim());
    const fingerprint = createHash('sha256').update(revisions.join('\0')).digest('hex').slice(0, 12);
    const dirty = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=normal', '--', ...inputs],
      { encoding: 'utf8' },
    ).trim().length > 0;
    return dirty ? `inputs-${fingerprint}-dirty` : `inputs-${fingerprint}`;
  } catch {
    return 'unknown'; // building outside a git checkout (e.g. the public source drop) is not an error
  }
}

const result = await esbuild.build({
  entryPoints: {
    extension: 'src/extension.ts',
    'content/PdfWorker': 'src/content/PdfWorker.ts',
    'content/PdfEditWorker': 'src/office/pdf/PdfEditWorker.ts',
    'content/OfficeWorker': 'src/content/OfficeWorker.ts',
    'content/WorkbookWorker': WORKBOOK_WORKER_ENTRY,
    'content/OfficeInventoryWorker': OFFICE_INVENTORY_WORKER_ENTRY,
    'content/OfficeEditWorker': OFFICE_EDIT_WORKER_ENTRY,
    'content/OfficeAttachmentTypeWorker': OFFICE_ATTACHMENT_TYPE_WORKER_ENTRY,
    'content/OfficeRenderPureWorker': OFFICE_RENDER_PURE_WORKER_ENTRY,
    'content/document/DocumentRenderWorker': DOCUMENT_WORKER_ENTRY,
    'office/PresentationWorker': PRESENTATION_WORKER_ENTRY,
    'office/DocumentRunner': MANAGED_OFFICE_RUNNER_ENTRY,
    'skills/SkillActionRunner': 'src/skills/SkillActionRunner.ts',
    'backend/cliClosureWorker': 'src/backend/cliClosureWorker.ts',
  },
  outdir: 'out',
  bundle: true,
  plugins: [docxEmbeddedNanoidPatch],
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: false,
  external: ['vscode'],
  // jsonc-parser's `main` is a UMD build whose factory receives `require` as a parameter, so a bundler cannot
  // see its internal modules and the bundle fails at runtime. Its ESM build bundles cleanly.
  alias: { 'jsonc-parser': './node_modules/jsonc-parser/lib/esm/main.js' },
  metafile: true,
  logLevel: 'info',
  define: { __BUILD_SHA__: JSON.stringify(buildStamp()) },
});

const runtimePackages = runtimePackageDirectories(Object.keys(result.metafile.inputs));
assertDocumentWorkerBundleGraph(result.metafile);
assertPresentationWorkerBundleGraph(result.metafile);
assertManagedOfficeRunnerBundleGraph(result.metafile);
assertWorkbookWorkerBundleGraph(result.metafile);
assertOfficeInventoryWorkerBundleGraph(result.metafile);
assertOfficeEditWorkerBundleGraph(result.metafile);
assertOfficeAttachmentTypeWorkerBundleGraph(result.metafile);
assertOfficeRenderPureWorkerBundleGraph(result.metafile);
writeFileSync(
  'out/bundle-runtime-packages.json',
  `${JSON.stringify(runtimePackages, null, 2)}\n`,
);

const gateTarget = join(process.cwd(), 'out', 'claudeToolGate.cjs');
mkdirSync(dirname(gateTarget), { recursive: true });
copyFileSync(join(process.cwd(), 'src', 'claudeToolGate.cjs'), gateTarget);
