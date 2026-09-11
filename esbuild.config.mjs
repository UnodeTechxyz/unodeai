import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
    'content/OfficeWorker': 'src/content/OfficeWorker.ts',
  },
  outdir: 'out',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: false,
  external: ['vscode'],
  metafile: true,
  logLevel: 'info',
  define: { __BUILD_SHA__: JSON.stringify(buildStamp()) },
});

const runtimePackages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.replaceAll('\\', '/').match(/node_modules\/(?:@[^/]+\/[^/]+|[^/]+)/);
  if (match) {
    runtimePackages.add(match[0].slice('node_modules/'.length));
  }
}
writeFileSync(
  'out/bundle-runtime-packages.json',
  `${JSON.stringify([...runtimePackages].sort(), null, 2)}\n`,
);

const gateTarget = join(process.cwd(), 'out', 'claudeToolGate.cjs');
mkdirSync(dirname(gateTarget), { recursive: true });
copyFileSync(join(process.cwd(), 'src', 'claudeToolGate.cjs'), gateTarget);
