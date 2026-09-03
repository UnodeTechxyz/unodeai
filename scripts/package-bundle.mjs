import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertVsixBoundary, listVsixFiles } from './check-vsix-boundary.mjs';

const root = process.cwd();
const staging = join(root, '.bundle-package');
const bundleOutDir = join(tmpdir(), 'unodeai-vsix');
const nodeModules = join(root, 'node_modules');
// @vscode/vsce uses SOURCE_DATE_EPOCH to pin each ZIP entry mtime and to sort entries before
// writing the VSIX. ZIP stores a *local* DOS timestamp, so force the packaging subprocess to UTC
// too; otherwise the same epoch would encode different bytes on different time zones. Keep the
// value deliberately fixed: a release artifact must not inherit the packaging machine's clock.
const SOURCE_DATE_EPOCH = '315532800'; // 1980-01-01T00:00:00Z (the ZIP epoch)
const vsce = process.platform === 'win32'
  ? join(root, 'node_modules', '.bin', 'vsce.cmd')
  : join(root, 'node_modules', '.bin', 'vsce');
const BUILD_STAMP_INPUTS = ['src', 'esbuild.config.mjs', 'package.json', 'package-lock.json'];

/** Mirrors esbuild.config.mjs's dirty-input test so a local package advertises its provenance in
 * both the embedded build stamp and its filename. A dirty package is useful for testing; it is not
 * a release candidate. */
function dirtyBuildInputs() {
  try {
    const output = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=normal', '--', ...BUILD_STAMP_INPUTS],
      { cwd: root, encoding: 'utf8' },
    ).trim();
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
  } catch {
    // esbuild's stamp is `unknown` outside a checkout. Do not invent a dirty state there.
    return [];
  }
}

function run(command, args, cwd = root, env = process.env) {
  // Windows .cmd shims must run through cmd.exe. Invoke it explicitly with shell:false so Node
  // escapes argv itself — passing an args array with shell:true triggers DEP0190 (unescaped concat).
  const needsCmd = process.platform === 'win32' && command.endsWith('.cmd');
  const result = needsCmd
    ? spawnSync('cmd.exe', ['/c', command, ...args], { cwd, env, stdio: 'inherit' })
    : spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

/**
 * Every file esbuild emits as an entry point, derived from the build config rather than listed here.
 *
 * This used to be a hand-written list containing `out/extension.js`. v0.9.57 added a second entry point —
 * `out/content/PdfWorker.js`, which carries PDF.js and is spawned as a worker thread — and the list was not
 * updated, so the shipped VSIX contained an extension that would throw the moment it tried to read a PDF.
 * The source checkout was fine, which is why nothing caught it.
 *
 * That is the third time in three releases that a hand-maintained copy/allowlist silently omitted a file the
 * shipped context needed: v0.9.46 (public drop, script), v0.9.56 (public drop, `test-e2e/`), v0.9.57 (VSIX,
 * PDF worker). Adding the missing name a third time fixes today and guarantees a fourth. The list is derived
 * now, so a future entry point ships because it is an entry point, not because somebody remembered.
 *
 * `out/` is NOT cleaned between builds and also holds `tsc` output, so "copy everything in out/" would ship
 * the whole compiled tree. The entry-point names are the correct source of truth.
 *
 * **Both esbuild spellings are handled, and that is not hypothetical tolerance.** The first version of this
 * understood only the object form (`entryPoints: { extension: … }, outdir: 'out'`). It passed locally,
 * because the working tree had that form uncommitted, and then failed every packaging job on CI, where
 * `HEAD` still had `entryPoints: ['src/extension.ts'], outfile: 'out/extension.js'`. I had verified against
 * my working tree instead of against what I was committing. Supporting both is also simply correct: either
 * spelling is a legitimate esbuild config and a packaging script should not care which one is in force.
 *
 * **Fails closed, loudly.** An unparseable config, an empty result, a set that does not contain
 * `out/extension.js`, or an entry point whose output is missing after the build all throw. A derivation that
 * silently returns an empty list would be the same defect wearing a different hat.
 */
function bundleEntryOutputs() {
  const config = readFileSync(join(root, 'esbuild.config.mjs'), 'utf8');
  const outdir = config.match(/outdir:\s*'([^']+)'/)?.[1];
  const outfile = config.match(/outfile:\s*'([^']+)'/)?.[1];

  // Object form: keys are output basenames relative to outdir.
  const objectBlock = config.match(/entryPoints:\s*\{([\s\S]*?)\}/);
  if (objectBlock) {
    const names = [...objectBlock[1].matchAll(/(?:^|,)\s*'?([\w./-]+)'?\s*:/g)].map((m) => m[1]);
    if (names.length === 0) {
      throw new Error('package-bundle parsed an empty entryPoints object in esbuild.config.mjs; refusing to package.');
    }
    if (!outdir) {
      throw new Error('package-bundle found an entryPoints object but no outdir in esbuild.config.mjs; refusing to package.');
    }
    return verifyOutputs(names.map((name) => `${outdir}/${name}.js`));
  }

  // Array form: a single outfile, or one output per source basename under outdir.
  const arrayBlock = config.match(/entryPoints:\s*\[([^\]]*)\]/);
  if (arrayBlock) {
    const sources = [...arrayBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    if (sources.length === 0) {
      throw new Error('package-bundle parsed an empty entryPoints array in esbuild.config.mjs; refusing to package.');
    }
    if (outfile) {
      if (sources.length > 1) {
        throw new Error(
          `package-bundle found ${sources.length} entry points but a single outfile in esbuild.config.mjs. `
          + 'That config cannot be right, so it refuses to package rather than guess which file ships.'
        );
      }
      return verifyOutputs([outfile]);
    }
    if (!outdir) {
      throw new Error('package-bundle found an entryPoints array but neither outfile nor outdir; refusing to package.');
    }
    return verifyOutputs(sources.map((src) => `${outdir}/${src.split('/').pop().replace(/\.[^.]+$/, '')}.js`));
  }

  throw new Error(
    'package-bundle could not find entryPoints in esbuild.config.mjs. It derives the files to ship from that '
    + 'list, so it refuses to package rather than guess.'
  );
}

/** Every derived output must exist and the set must include the extension host's own entry. */
function verifyOutputs(outputs) {
  if (!outputs.includes('out/extension.js')) {
    throw new Error(
      `package-bundle derived ${outputs.join(', ')} and none of them is out/extension.js, which the `
      + 'extension host loads. Either the entry point was renamed and this needs handling, or the parse went wrong.'
    );
  }
  const missing = outputs.filter((file) => !existsSync(join(root, file)));
  if (missing.length > 0) {
    throw new Error(
      `esbuild declares entry points whose output is missing after the build: ${missing.join(', ')}. `
      + 'Packaging would produce a VSIX that throws at runtime.'
    );
  }
  return outputs;
}

function copyFile(relativePath) {
  const from = join(root, relativePath);
  const to = join(staging, relativePath);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

function copyDir(from, to) {
  if (existsSync(from)) {
    cpSync(from, to, { recursive: true });
  }
}

if (!existsSync(vsce)) {
  throw new Error('vsce is not installed. Run npm install first.');
}

try {
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(bundleOutDir, { recursive: true });
  mkdirSync(staging, { recursive: true });

  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:bundle']);

  const dirtyInputs = dirtyBuildInputs();
  if (dirtyInputs.length > 0) {
    console.warn('WARNING: packaging from dirty build inputs; this VSIX is not a release candidate.');
    for (const input of dirtyInputs) {
      console.warn(`  ${input}`);
    }
  }

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  pkg.scripts = {};
  pkg.dependencies = {};
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  cpSync(join(root, '.vscodeignore.bundle'), join(staging, '.vscodeignore'));

  for (const file of [
    'README.md',
    'USAGE.md',
    'LICENSE',
    'SECURITY.md',
    'THIRD_PARTY_NOTICES.md',
    'out/claudeToolGate.cjs',
    ...bundleEntryOutputs(),
  ]) {
    copyFile(file);
  }
  // Ship only the recent (UnodeAi-era) changelog — everything from the SHIPPED_CHANGELOG_CUTOFF marker
  // down (older, pre-UnodeAi history) stays in the repo but is trimmed from the public VSIX to keep it
  // lean and free of legacy partner-gateway mentions. Full history remains in git / on GitHub.
  {
    const full = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const cut = full.indexOf('<!-- SHIPPED_CHANGELOG_CUTOFF');
    const shipped = cut === -1
      ? full
      : `${full.slice(0, cut).trimEnd()}\n\n_Earlier release history is in the project repository._\n`;
    writeFileSync(join(staging, 'CHANGELOG.md'), shipped);
  }
  // Copy the whole images/ dir (icons referenced by package.json) so a newly-added asset can't be
  // silently dropped from the bundle — which is exactly what hid the Solo toolbar icons.
  copyDir(join(root, 'images'), join(staging, 'images'));
  // ...but never ship internal brand-source assets (e.g. images/_brand/**) — they're not referenced by
  // the manifest and must not leak into the published VSIX. .vscodeignore excludes them for a raw
  // `vsce package`, but this bundle stages files explicitly, so drop the dir from staging directly.
  rmSync(join(staging, 'images', '_brand'), { recursive: true, force: true });
  // Copy the marketplace catalog (read at runtime via extensionUri/marketplace/*.json). Without
  // this the bundled VSIX ships an empty Marketplace — and the smoke test wouldn't catch it.
  copyDir(join(root, 'marketplace'), join(staging, 'marketplace'));
  // Agent Skills are instruction-only resources loaded at runtime from extensionUri/skills. Keep
  // them out of the JavaScript bundle so their filesystem boundary remains explicit and auditable.
  copyDir(join(root, 'skills'), join(staging, 'skills'));

  const runtimePackages = JSON.parse(readFileSync(join(root, 'out', 'bundle-runtime-packages.json'), 'utf8'));
  for (const name of runtimePackages) {
    const packageDir = join(nodeModules, ...String(name).split('/'));
    const licenseFile = readdirSync(packageDir).find((file) => /^licen[sc]e(?:\.|$)/i.test(file));
    if (!licenseFile) {
      throw new Error(`Bundled runtime dependency ${name} has no package license file.`);
    }
    const safeName = String(name).replace(/^@/, '').replaceAll('/', '__');
    const target = join(staging, 'third_party_licenses', `${safeName}.txt`);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(packageDir, licenseFile), target);
  }

  assertVsixBoundary(listVsixFiles(staging), {
    label: 'Bundled VSIX staging',
    bundled: true,
  });

  const bundleName = `unodeai-${pkg.version}-bundled${dirtyInputs.length > 0 ? '-dirty' : ''}.vsix`;
  const bundleOutPath = join(bundleOutDir, bundleName);
  console.log(`Packaging reproducibly with SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}.`);
  run(vsce, ['package', '--out', bundleOutPath], staging, {
    ...process.env,
    TZ: 'UTC',
    SOURCE_DATE_EPOCH,
  });
  cpSync(bundleOutPath, join(root, bundleName));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
