// A separate Node process (bundled by the test) that uses the real instance store, like a second VS Code window:
// - `hold <store> <storeId>`: opens the instance, acquires its admission gate, prints `held`, releases it when a line
//   arrives on stdin, prints `released`;
// - `crash <store> <step>`: creates an instance and kills itself at `after-folder`, `after-identity`,
//   `after-manifest` or `before-guard`;
// - `promote <store> <storeId> <index> <go file>`: stages the same files every worker stages, waits for the go file,
//   promotes them with the same artifact, and prints the result.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { cliStoreVersionKey } from '../../../backend/cliCompatibilityPolicy';
import type { PromotedVersion } from '../contracts';
import { createInstanceStore, nodeInstanceFs, type InstanceFs } from '../instanceStore';
import { cliStoreRoots } from '../storeLayout';

const [mode, storeRoot, arg, extra, go] = process.argv.slice(2);
const roots = cliStoreRoots(storeRoot);
const unavailable = async () => 'unavailable' as const;

function die(): never {
  process.kill(process.pid, 'SIGKILL');
  for (;;) { /* the kill takes the process */ }
}

if (mode === 'hold') {
  const store = createInstanceStore(roots, { processCreations: unavailable });
  const opened = store.open(arg);
  if (!opened.ok) { process.stdout.write(`refused ${opened.reason}\n`); process.exit(1); }
  const gate = store.acquireAdmission(opened.ref);
  if (!gate.ok) { process.stdout.write(`refused ${gate.reason}\n`); process.exit(1); }
  process.stdout.write('held\n');
  process.stdin.once('data', () => {
    gate.handle.release();
    process.stdout.write('released\n');
    setTimeout(() => process.exit(0), 50);
  });
} else if (mode === 'crash') {
  const step = arg;
  const fs: InstanceFs = {
    ...nodeInstanceFs,
    mkdir: (folder) => {
      nodeInstanceFs.mkdir(folder);
      if (step === 'after-folder' && path.dirname(folder) === roots.instances) die();
    },
    writeExclusive: (file, bytes) => {
      if (step === 'before-guard' && path.basename(file) === 'guard.bin') die();
      nodeInstanceFs.writeExclusive(file, bytes);
      if (step === 'after-identity' && path.basename(file) === 'identity.bin') die();
    },
    link: (existing, created) => {
      nodeInstanceFs.link(existing, created);
      if (step === 'after-manifest') die();
    },
  };
  const store = createInstanceStore(roots, { processCreations: unavailable, fs });
  void store.create().then((result) => { process.stdout.write(JSON.stringify(result)); });
} else if (mode === 'promote') {
  const store = createInstanceStore(roots, { processCreations: unavailable });
  const opened = store.open(arg);
  if (!opened.ok) { process.stdout.write(JSON.stringify({ refused: opened.reason })); process.exit(1); }
  const index = Number(extra);
  const staging = store.createStaging(opened.ref, (index + 1).toString(16).padStart(32, '0'));
  mkdirSync(path.join(staging.payload, 'codex-path'));
  writeFileSync(path.join(staging.payload, 'codex.exe'), 'the same program');
  writeFileSync(path.join(staging.payload, 'codex-path', 'rg.exe'), 'the same helper');
  const artifactSha256 = 'ab'.repeat(32);
  const facts: PromotedVersion = {
    key: cliStoreVersionKey({ version: '0.163.0', os: 'win32', arch: 'x64', managed: { artifact: { sha256: artifactSha256 } } }),
    provider: 'codex-cli', version: '0.163.0', os: 'win32', arch: 'x64', policyVersion: '0.9.97-0',
    policyEntryId: 'codex-cli-0.163.0-win32-x64', artifactSha256, taskToken: (index + 1).toString(16).padStart(32, '0'),
    promotedAt: '2026-10-20T08:00:00.000Z',
    verification: { files: 2, bytes: 31, signed: { openai: 1, microsoftCrt: 0 }, unsigned: ['codex-path/rg.exe'], revocation: 'confirmed-online' },
  };
  while (!existsSync(go)) { /* spin until every worker is ready */ }
  void store.promote(opened.ref, staging, facts).then((result) => {
    process.stdout.write(JSON.stringify(result.ok ? { ok: true, alreadyPromoted: result.alreadyPromoted, taskToken: facts.taskToken } : result));
  });
}
