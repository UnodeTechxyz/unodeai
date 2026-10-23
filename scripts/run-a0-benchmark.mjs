#!/usr/bin/env node
/**
 * Produce an A0 benchmark report without changing extension behaviour.
 *
 * Usage:
 *   npm run benchmark:a0 -- --out docs/perf-baseline-v0957/a0-local.json --runs 2
 *
 * The output is an explicit caller-owned path. All intermediate files live in a unique temp directory
 * and are removed after their JSON has been read. No budget is calculated here: budgets require two
 * maintained CI samples, and this harness must not turn a convenient local number into a gate by accident.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// `spawnSync('npm.cmd')` returns EINVAL on some Windows Node installations. Calling npm's JS entrypoint
// through this same Node executable avoids PowerShell execution policy and cmd-wrapper differences.
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmCommand = process.platform === 'win32' && existsSync(npmCli)
  ? { executable: process.execPath, prefix: [npmCli] }
  : { executable: 'npm', prefix: [] };

function fail(message) {
  console.error(`A0 benchmark FAILED: ${message}`);
  process.exit(1);
}

function usage() {
  console.log('Usage: npm run benchmark:a0 -- --out <report.json> [--runs <positive integer>]');
}

function parseArgs(argv) {
  let output;
  let runs = 1;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      output = argv[++index];
    } else if (arg === '--runs') {
      const raw = argv[++index];
      runs = Number(raw);
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  if (!output) { fail('missing required --out <report.json>'); }
  if (!Number.isInteger(runs) || runs < 1) { fail('--runs must be a positive integer'); }
  return { output: isAbsolute(output) ? output : resolve(ROOT, output), runs };
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function run(label, args, env = {}) {
  const started = performance.now();
  const child = spawnSync(npmCommand.executable, [...npmCommand.prefix, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  const elapsedMs = performance.now() - started;
  if (child.error) {
    fail(`${label} could not start: ${child.error.message}`);
  }
  if (child.status !== 0) {
    fail(`${label} exited ${child.status ?? 'without a status'}`);
  }
  return rounded(elapsedMs);
}

function readJson(path, label) {
  if (!existsSync(path)) { fail(`${label} did not write ${path}`); }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} wrote invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function summary(values) {
  return {
    rawMs: values.map(rounded),
    medianMs: rounded(percentile(values, 0.5)),
    p95Ms: rounded(percentile(values, 0.95)),
  };
}

function atPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function metricSummaries(samples) {
  const fields = [
    ['metadata.modelCatalog.firstListMs', 'unit.metadata.modelCatalog.firstListMs'],
    ['metadata.modelCatalog.cachedListMs', 'unit.metadata.modelCatalog.cachedListMs'],
    ['metadata.modelCatalog.duplicateInflightMs', 'unit.metadata.modelCatalog.duplicateInflightMs'],
    ['metadata.priceList.firstRequestMs', 'unit.metadata.priceList.firstRequestMs'],
    ['metadata.balance.firstRequestMs', 'unit.metadata.balance.firstRequestMs'],
    ['persistence.fixtureJsonSerializationMs', 'unit.persistence.fixtureJsonSerializationMs'],
    ['chatWebviewProxy.hostStateBuildMs', 'unit.chatWebviewProxy.hostStateBuildMs'],
    ['chatWebviewProxy.webviewAttachHostWorkMs', 'unit.chatWebviewProxy.webviewAttachHostWorkMs'],
    ['activation.activationCallMs', 'extensionHost.activation.activationCallMs'],
    ['activation.activationToCommandRegistrationMs', 'extensionHost.activation.activationToCommandRegistrationMs'],
    ['activation.commandInventoryMs', 'extensionHost.activation.commandInventoryMs'],
    ['establishedWorkspace.fixtureSetupMs', 'extensionHost.establishedWorkspace.fixtureSetupMs'],
    ['establishedWorkspace.interactivePanelCommandCompletionMs', 'extensionHost.establishedWorkspace.interactivePanelCommandCompletionMs'],
  ];
  return Object.fromEntries(fields.flatMap(([name, path]) => {
    const values = samples.map((sample) => atPath(sample, path));
    return values.every((value) => typeof value === 'number') ? [[name, summary(values)]] : [];
  }));
}

function runSample(index) {
  const temp = mkdtempSync(join(tmpdir(), 'unode-a0-'));
  const unitReportPath = join(temp, 'unit.json');
  const e2eReportPath = join(temp, 'extension-host.json');
  try {
    const unitFixtureWallMs = run(`unit fixture sample ${index}`, [
      'exec', '--', 'vitest', 'run', 'src/__tests__/a0Benchmark.test.ts',
    ], { UNODE_A0_UNIT_REPORT: unitReportPath });
    const coreTestsWallMs = run(`core tests sample ${index}`, [
      'exec', '--', 'vitest', 'run',
      'src/models/__tests__/ModelCatalog.test.ts',
      'src/models/__tests__/LivePriceService.test.ts',
      'src/models/__tests__/BalanceService.test.ts',
    ]);
    const extensionHostWallMs = run(`extension-host fixture sample ${index}`, [
      'exec', '--', 'vscode-test',
    ], {
      UNODE_A0_E2E_REPORT: e2eReportPath,
      UNODE_E2E_FILES: 'out-e2e/suite/a0-benchmark.etest.js',
    });
    return {
      sample: index,
      unitFixtureWallMs,
      coreTestsWallMs,
      extensionHostWallMs,
      unit: readJson(unitReportPath, `unit fixture sample ${index}`),
      extensionHost: readJson(e2eReportPath, `extension-host fixture sample ${index}`),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const { output, runs } = parseArgs(process.argv.slice(2));
console.log(`A0 benchmark: building once, then collecting ${runs} sample(s).`);
run('build', ['run', 'build']);
run('compile:e2e', ['run', 'compile:e2e']);

const samples = Array.from({ length: runs }, (_, index) => runSample(index + 1));
const report = {
  schemaVersion: 1,
  status: 'provisional-local-baseline-not-a-budget',
  generatedAt: new Date().toISOString(),
  command: 'npm run benchmark:a0 -- --out <report.json> --runs <n>',
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    ci: Boolean(process.env.CI),
  },
  fixture: {
    cleanProfile: 'A fresh vscode-test extension-host process is launched for each sample.',
    establishedWorkspace: 'Each extension-host sample creates and removes the default team before opening Chat.',
    externalNetwork: 'No real provider request is made; metadata measurements use deterministic in-memory responses.',
  },
  limitations: [
    'The test host can observe activation-call and command-completion timing, but cannot establish a host-start clock after onStartupFinished activation.',
    'A command opening Chat is a host-side completion proxy, not proof that the webview finished DOM layout or paint.',
    'DOM node count, browser render time, browser memory, and physical VS Code workspace-storage flush timing are recorded unavailable rather than inferred.',
    'Budgets remain unset until two reproducible maintained-CI runs are retained; use the slower run plus a documented margin at that point.',
  ],
  sampleCount: samples.length,
  samples,
  wallClockSummary: {
    unitFixture: summary(samples.map((sample) => sample.unitFixtureWallMs)),
    coreTestsWithoutVSCode: summary(samples.map((sample) => sample.coreTestsWallMs)),
    extensionHostFixture: summary(samples.map((sample) => sample.extensionHostWallMs)),
  },
  measurementSummary: metricSummaries(samples),
  budgets: { status: 'unset', reason: 'A0 records a baseline; maintained-CI evidence sets future budgets.' },
};

writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`A0 benchmark report written: ${output}`);
