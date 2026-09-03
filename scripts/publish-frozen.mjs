#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Publish an EXACT, already-frozen VSIX — and never rebuild it.
 *
 *  This is the only publish implementation. `npm run publish`, `publish:bundle`, and `publish:ovsx`
 *  all reach this verifier with an explicit registry; none are allowed to package or rebuild an artifact.
 *  Without this guard, the acceptance matrix could run against one hash while a different hash reaches
 *  the registry — which is exactly what happened before it existed: a publish step rebuilt the bundle,
 *  so the uploaded bytes were never the verified bytes. `scripts/check-frozen-publish-guard.mjs` is the
 *  regression test for that.
 *
 *  This script is the no-rebuild path: you name the exact file AND the SHA-256 you accepted, it
 *  re-hashes the bytes on disk, and it refuses to upload unless they match. Fail-closed everywhere —
 *  a missing file, a missing/ill-formed expected hash, or a mismatch exits non-zero BEFORE any
 *  network call. It builds nothing, so the file you verified is the file that ships.
 *
 *  Run:
 *    npm run publish:frozen -- --file <path.vsix> --sha256 <64-hex> [--registry ovsx|vsce] [--dry-run]
 *
 *  Token (ovsx): OVSX_PAT env var, or a gitignored `.ovsx-pat` at the repo root — same resolution as
 *  the existing publish:ovsx script. `vsce` uses its own `vsce login` / VSCE_PAT.
 *
 *  `--dry-run` is deliberately credential-free. It is the local preflight for a VSIX retrieved from the
 *  canonical CI builder: it verifies the recorded SHA-256 without resolving a token, a registry CLI, or
 *  any network path. The subsequent non-dry run hashes the same bytes again immediately before upload.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve('.');

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

/** Minimal flag parser: --key value, plus boolean --dry-run. */
function parseArgs(argv) {
  const out = { registry: 'ovsx', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') { out.dryRun = true; continue; }
    const value = argv[i + 1];
    if (arg === '--file') { out.file = value; i++; continue; }
    if (arg === '--sha256') { out.sha256 = value; i++; continue; }
    if (arg === '--registry') { out.registry = value; i++; continue; }
    if (arg === '-p' || arg === '--pat') { out.pat = value; i++; continue; }
    fail(`unknown argument ${arg}. Usage: --file <path.vsix> --sha256 <64-hex> [--registry ovsx|vsce] [--dry-run]`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// ── Fail closed on every precondition, BEFORE any network call ───────────────────────────────────
if (!args.file) { fail('--file <path.vsix> is required. This script never builds; name the frozen artifact.'); }
if (!args.sha256) {
  fail('--sha256 <64-hex> is required. Publishing without re-verifying the frozen hash is exactly the '
    + 'failure this script exists to prevent.');
}
const expected = String(args.sha256).trim().toLowerCase();
if (!/^[a-f0-9]{64}$/.test(expected)) { fail(`--sha256 must be 64 hex characters; got "${args.sha256}".`); }
if (!['ovsx', 'vsce'].includes(args.registry)) { fail(`--registry must be ovsx or vsce; got "${args.registry}".`); }

const file = resolve(args.file);
if (!existsSync(file)) { fail(`no such file: ${file}`); }
if (!file.toLowerCase().endsWith('.vsix')) { fail(`not a .vsix: ${file}`); }

const bytes = readFileSync(file);
const actual = createHash('sha256').update(bytes).digest('hex');

console.log(`file     : ${file}`);
console.log(`size     : ${statSync(file).size} bytes`);
console.log(`expected : ${expected}`);
console.log(`actual   : ${actual}`);

if (actual !== expected) {
  fail('SHA-256 MISMATCH — refusing to publish.\n'
    + '    The bytes on disk are not the artifact you accepted. Someone rebuilt it, or you named the wrong\n'
    + '    file. Re-run the acceptance matrix against whatever you intend to ship, then publish THAT hash.');
}
console.log('✓ hash matches the accepted artifact — nothing was rebuilt.\n');

// ── Token resolution (ovsx only) ────────────────────────────────────────────────────────────────
// A downloaded CI artifact is untrusted until its recorded SHA-256 has matched. Keep this preflight
// credential-free: CI builds but never publishes, and a human may verify the download before deciding
// whether an owner-authorized upload is appropriate.
if (args.dryRun) {
  console.log('dry run: verified only; no credential, registry CLI, network call, or upload was used.');
  process.exit(0);
}

const TOKEN_PLACEHOLDER = 'PASTE_YOUR_OPEN_VSX_TOKEN_HERE';
function readOvsxToken() {
  if (args.pat && args.pat.trim()) { return args.pat.trim(); }
  if (process.env.OVSX_PAT && process.env.OVSX_PAT.trim()) { return process.env.OVSX_PAT.trim(); }
  const patFile = join(root, '.ovsx-pat');
  if (existsSync(patFile)) {
    const fromFile = readFileSync(patFile, 'utf8').trim();
    if (fromFile && fromFile !== TOKEN_PLACEHOLDER) { return fromFile; }
  }
  return '';
}

const isWindows = process.platform === 'win32';
const bin = (name) => join(root, 'node_modules', '.bin', isWindows ? `${name}.cmd` : name);

let command;
let commandArgs;
if (args.registry === 'ovsx') {
  const token = readOvsxToken();
  if (!token) {
    fail('no Open VSX token. Set OVSX_PAT, put the token in .ovsx-pat at the repo root, or pass --pat <token>.');
  }
  command = bin('ovsx');
  commandArgs = ['publish', file, '-p', token];
} else {
  command = bin('vsce');
  commandArgs = ['publish', '--packagePath', file];
}
if (!existsSync(command)) { fail(`${args.registry} CLI not found at ${command}. Run npm ci first.`); }

// Never print the token.
const shown = commandArgs.map((a) => (a === commandArgs[commandArgs.indexOf('-p') + 1] && commandArgs.includes('-p') ? '***' : a));
console.log(`would run: ${args.registry} ${shown.join(' ')}`);

const result = isWindows
  ? spawnSync('cmd.exe', ['/c', command, ...commandArgs], { cwd: root, stdio: 'inherit' })
  : spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' });

if (result.status !== 0) { fail(`${args.registry} publish failed with exit code ${result.status}.`); }
console.log(`\n✓ published the exact frozen artifact (SHA-256 ${actual}).`);
