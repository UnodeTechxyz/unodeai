import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

const root = process.cwd();
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
// A release smoke keeps the canonical clean name. An explicit argument is only
// for a developer to prove the exact candidate they just packaged; it does not
// make a `-dirty` artifact silently eligible for a release job.
const requestedVsix = process.argv[2]?.trim();
const vsix = requestedVsix
  ? resolve(root, requestedVsix)
  : join(tmpdir(), 'unodeai-vsix', `unodeai-${pkgVersion}-bundled.vsix`);
const smokeDir = join(tmpdir(), 'unodeai-smoke');
const launchPath = join(smokeDir, 'launch-smoke.cjs');
const nodeBin = process.execPath;
const testElectronModule = resolve(root, 'node_modules/@vscode/test-electron/out/index.js').replace(/\\/g, '\\\\');
const runnerSource = resolve(root, 'node_modules/@vscode/test-cli/out/runner.cjs');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function collectIconPaths(pkg) {
  const paths = new Set();

  for (const command of pkg.contributes?.commands ?? []) {
    const icon = command.icon;
    if (typeof icon === 'string' && !icon.startsWith('$(')) {
      paths.add(icon);
    } else if (icon && typeof icon === 'object') {
      if (icon.light) {
        paths.add(icon.light);
      }
      if (icon.dark) {
        paths.add(icon.dark);
      }
    }
  }

  for (const viewGroup of Object.values(pkg.contributes?.views ?? {})) {
    for (const view of viewGroup ?? []) {
      if (typeof view.icon === 'string' && !view.icon.startsWith('$(')) {
        paths.add(view.icon);
      }
    }
  }

  return paths;
}

function assertPackagedIconsExist(extensionPath) {
  const pkg = JSON.parse(readFileSync(join(extensionPath, 'package.json'), 'utf8'));
  const missing = [];
  for (const iconPath of collectIconPaths(pkg)) {
    if (!existsSync(join(extensionPath, iconPath))) {
      missing.push(iconPath);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Bundled VSIX is missing contributed icon files: ${missing.join(', ')}`);
  }
}

/**
 * The Marketplace reads marketplace/{agents,mcp,skills}.json at runtime via extensionUri. If the
 * bundle script forgets to stage them, the panel ships empty — and the icon check wouldn't catch it.
 * Assert all three are present and parse, and that Agents + MCP are non-empty.
 */
function assertMarketplaceCatalogPresent(extensionPath) {
  for (const name of ['agents', 'mcp', 'skills']) {
    const file = join(extensionPath, 'marketplace', `${name}.json`);
    if (!existsSync(file)) {
      throw new Error(`Bundled VSIX is missing marketplace/${name}.json — the Marketplace would be empty.`);
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Bundled marketplace/${name}.json is not valid JSON: ${String(err)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Bundled marketplace/${name}.json must be a JSON array.`);
    }
    if ((name === 'agents' || name === 'mcp') && parsed.length === 0) {
      throw new Error(`Bundled marketplace/${name}.json is empty — expected curated entries.`);
    }
  }
}

function assertSkillsPresent(extensionPath) {
  const skillsRoot = join(extensionPath, 'skills');
  const categories = existsSync(skillsRoot) ? readdirSync(skillsRoot, { withFileTypes: true }) : [];
  const skillFiles = categories.flatMap((category) => {
    if (!category.isDirectory()) return [];
    const categoryPath = join(skillsRoot, category.name);
    return readdirSync(categoryPath, { withFileTypes: true }).flatMap((skill) =>
      skill.isDirectory() && existsSync(join(categoryPath, skill.name, 'SKILL.md'))
        ? [join(category.name, skill.name, 'SKILL.md')]
        : []
    );
  });
  if (skillFiles.length === 0) {
    throw new Error('Bundled VSIX is missing skills/**/SKILL.md.');
  }
}

/**
 * Does this build declare a PDF worker at all?
 *
 * The feature is conditional, and the assertion below must be too — but conditional on the BUILD CONFIG,
 * never on the artifact. Asking the VSIX "is there a worker in you?" and skipping when there is not would
 * pass for exactly the regression this exists to catch.
 *
 * So: esbuild declares the entry point or it does not. Declared and missing from the VSIX is a hard failure.
 * Not declared means this build has no PDF extraction and there is nothing to exercise.
 *
 * This reads the same config `package-bundle.mjs` derives its copy list from. Two readers of one file is
 * the shape that produced v0.9.56's double-discount defect, so keep them honest: this one answers only
 * "is a PdfWorker entry point declared", and packaging remains the only thing that decides what ships.
 */
function declaresPdfWorker() {
  const config = readFileSync(resolve(root, 'esbuild.config.mjs'), 'utf8');
  const entryPoints = config.match(/entryPoints:\s*(\{[\s\S]*?\}|\[[^\]]*\])/)?.[1] ?? '';
  return /PdfWorker/.test(entryPoints);
}

/**
 * A minimal, valid, single-page PDF containing one word of extractable text.
 *
 * Generated rather than checked in: the VSIX boundary check forbids a sample PDF shipping, and a fixture
 * file is one more thing an allowlist can silently drop -- which is the exact defect this function exists
 * to catch. Offsets are computed, because PDF.js is tolerant of a lot but not of a wrong xref table.
 */
function minimalPdfWithText(word) {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R'
      + '/Resources<</Font<</F1 5 0 R>>>>>>',
    null, // content stream, built below
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  const stream = `BT /F1 24 Tf 20 100 Td (${word}) Tj ET`;
  objects[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * Prove the PACKAGED PDF worker extracts text, rather than proving a file exists.
 *
 * v0.9.57 added `out/content/PdfWorker.js` as a second esbuild entry point and the packaging script's
 * hand-written copy list was not updated, so the shipped VSIX had no worker at all. `check:vsix` stayed
 * green throughout: it verifies that nothing forbidden ships, which is a different question from whether
 * everything required does.
 *
 * A presence check would have caught that one instance. This runs the worker the way the extension runs it
 * -- spawned from the unpacked VSIX, handed bytes, asked for a page -- so it also fails if the bundle is
 * present but broken: PDF.js tree-shaken away, a dependency left external, a Node version incompatibility.
 * The rule-17 row for the bundled VSIX asks for the shipped path to be exercised, not inventoried.
 */
async function assertPackagedPdfWorkerExtractsText(extensionPath) {
  if (!declaresPdfWorker()) {
    console.log('smoke: esbuild declares no PDF worker entry point — this build has no PDF extraction to exercise.');
    return;
  }

  const workerPath = join(extensionPath, 'out', 'content', 'PdfWorker.js');
  if (!existsSync(workerPath)) {
    throw new Error(
      'esbuild declares a PDF worker entry point but the bundled VSIX has no out/content/PdfWorker.js. '
      + 'PDF extraction spawns it as a worker thread, so every PDF the product accepts would fail at runtime '
      + 'while the source checkout looked fine.'
    );
  }

  const pdfPath = join(smokeDir, 'smoke-fixture.pdf');
  writeFileSync(pdfPath, minimalPdfWithText('UNODEPDFSMOKE'));

  const worker = new Worker(workerPath);
  try {
    const reply = await new Promise((resolveReply, rejectReply) => {
      const timer = setTimeout(
        () => rejectReply(new Error('packaged PDF worker did not answer within 60s')),
        60_000,
      );
      worker.once('message', (message) => { clearTimeout(timer); resolveReply(message); });
      worker.once('error', (err) => { clearTimeout(timer); rejectReply(err); });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        rejectReply(new Error(`packaged PDF worker exited (code ${code}) before answering`));
      });
      worker.postMessage({ path: pdfPath, range: { start: 1, end: 1 } });
    });

    if (!reply?.ok) {
      throw new Error(`packaged PDF worker failed to extract: ${reply?.error ?? 'no error reported'}`);
    }
    const page = reply.value?.pages?.[0];
    if (reply.value?.totalPages !== 1 || !page) {
      throw new Error(`packaged PDF worker returned an unexpected shape: ${JSON.stringify(reply.value)}`);
    }
    // Assert a prefix, not the whole word: a minimal hand-built PDF can lose a byte or two off the end of
    // its content stream depending on how tolerant the parser is, and this test is about whether extraction
    // happened at all -- not about byte-exact fidelity of a fixture this file generated.
    if (!String(page.text ?? '').includes('UNODEPDF')) {
      throw new Error(
        'packaged PDF worker extracted no text from a text PDF '
        + `(text=${JSON.stringify(page.text)}, ocrRequired=${page.ocrRequired}).`
      );
    }
    console.log('smoke: packaged PDF worker extracted text from a generated PDF.');
  } finally {
    await worker.terminate();
  }
}

try {
  if (!existsSync(vsix)) {
    throw new Error(`Bundled VSIX not found at ${vsix}. Run package:bundle first.`);
  }
  rmSync(smokeDir, { recursive: true, force: true });
  mkdirSync(smokeDir, { recursive: true });
  // A .vsix is a ZIP. Windows/macOS `tar` is bsdtar (auto-detects zip), but GNU `tar` on Linux can't
  // read a zip ("does not look like a tar archive"), so use `unzip` off Windows. (ubuntu/macOS have it.)
  if (process.platform === 'win32') {
    // Call the Windows bundled bsdtar by absolute path: a Git Bash / MSYS shell puts GNU tar first on
    // PATH, and GNU tar reads `C:\...` as a remote `host:path` ("Cannot connect to C: resolve failed").
    const sysTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    run(existsSync(sysTar) ? sysTar : 'tar', ['-xf', vsix, '-C', smokeDir]);
  } else {
    run('unzip', ['-q', '-o', vsix, '-d', smokeDir]);
  }

  const extensionPath = resolve(smokeDir, 'extension');
  assertPackagedIconsExist(extensionPath);
  assertMarketplaceCatalogPresent(extensionPath);
  assertSkillsPresent(extensionPath);
  await assertPackagedPdfWorkerExtractsText(extensionPath);
  const testsFileCopy = join(smokeDir, 'extension.etest.js');
  copyFileSync(resolve(root, 'out-e2e/suite/extension.etest.js'), testsFileCopy);
  // Load the @vscode/test-cli runner from its REAL node_modules location (not a tmpdir copy): the runner
  // `require('mocha')`, and from the OS tmpdir that wouldn't resolve to the repo's node_modules → "Cannot
  // find module 'mocha'" (regression when smokeDir moved to tmpdir). NODE_PATH below covers the test file.
  const runnerPath = runnerSource;
  const testOptions = {
    mochaOpts: {
      ui: 'bdd',
      timeout: 60000,
      grep: 'normal turn entrypoint',
      invert: true,
    },
    colorDefault: true,
    preload: [],
    files: [resolve(testsFileCopy)],
  };
  writeFileSync(launchPath, `const { runTests } = require('${testElectronModule}');
const { downloadAndUnzipVSCode } = require('${testElectronModule}');
const { spawn } = require('node:child_process');
const path = require('node:path');

process.env.VSCODE_TEST_OPTIONS = ${JSON.stringify(JSON.stringify(testOptions))};

async function main() {
  const executable = await downloadAndUnzipVSCode({ version: 'stable' });
  const args = [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    '--extensionTestsPath=' + ${JSON.stringify(runnerPath)},
    '--extensionDevelopmentPath=' + ${JSON.stringify(extensionPath)},
    '--extensions-dir=' + path.join(${JSON.stringify(smokeDir)}, 'extensions'),
    '--user-data-dir=' + path.join(${JSON.stringify(smokeDir)}, 'user-data'),
  ];
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  childEnv.VSCODE_TEST_OPTIONS = process.env.VSCODE_TEST_OPTIONS;
  // The runner + copied test file run from the OS tmpdir, which has no node_modules — make the repo's
  // node_modules resolvable so require('mocha') (and any test dep) is found.
  childEnv.NODE_PATH = ${JSON.stringify(resolve(root, 'node_modules'))};
  const child = spawn(executable, args, {
    env: childEnv,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', (code, signal) => {
    if (typeof code === 'number') {
      process.exit(code);
    }
    console.error('VS Code exited with signal', signal);
    process.exit(1);
  });
  child.on('error', (err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
`);

  run(nodeBin, [launchPath]);
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}
