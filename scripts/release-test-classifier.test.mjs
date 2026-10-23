import { describe, expect, it } from 'vitest';
import { classifyReleaseTestRun, renderReleaseGateFailure, reporterIdentityFromVitestList } from './release-test-classifier.mjs';

function assertion(fullName, status = 'passed') {
  return { fullName, status, ...(status === 'failed' ? { failureMessages: [`${fullName} failed`] } : {}) };
}

function fixture({ files = 2, assertions = [assertion('a'), assertion('b'), assertion('c')], success = true } = {}) {
  const testResults = Array.from({ length: files }, (_, index) => ({
    name: `file-${index}.test.ts`,
    status: 'passed',
    assertionResults: index === 0 ? assertions : [],
  }));
  const passed = assertions.filter((entry) => entry.status === 'passed').length;
  const failed = assertions.filter((entry) => entry.status === 'failed').length;
  const pending = assertions.filter((entry) => entry.status === 'pending' || entry.status === 'skipped').length;
  const todo = assertions.filter((entry) => entry.status === 'todo').length;
  return {
    success,
    testResults,
    numTotalTests: assertions.length,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: pending,
    numTodoTests: todo,
    numTotalTestSuites: files,
    numPassedTestSuites: files,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
  };
}

const baseline = { minimumFiles: 2, minimumTests: 3, allowedSkippedTests: { win32: [] } };
function discoveryFor(report) {
  const assertions = report?.testResults?.flatMap((file) => file.assertionResults ?? []) ?? [];
  return {
    files: report?.testResults?.length ?? 2,
    tests: assertions.length || 3,
    testIdentities: assertions.length > 0 ? assertions.map((entry) => entry.fullName) : ['a', 'b', 'c'],
  };
}

const classify = (overrides = {}) => {
  const report = Object.hasOwn(overrides, 'report') ? overrides.report : fixture();
  const discovered = Object.hasOwn(overrides, 'discovered') ? overrides.discovered : discoveryFor(report);
  return classifyReleaseTestRun({
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    baseline,
    platform: 'win32',
    ...overrides,
    report,
    discovered,
  });
};

describe('release test classifier', () => {
  it('derives list identities in the same form emitted by the final JSON reporter', () => {
    expect(reporterIdentityFromVitestList('outer describe > nested describe > test case'))
      .toBe('outer describe nested describe test case');
  });

  it('accepts a complete internally consistent report and its one documented skip', () => {
    const assertions = [assertion('a'), assertion('b'), assertion('documented skip', 'skipped')];
    expect(classify({
      report: fixture({ assertions }),
      baseline: { ...baseline, allowedSkippedTests: { win32: ['documented skip'] } },
    })).toMatchObject({ ok: true, summary: { files: 2, tests: 3, skipped: 1 } });
  });

  it('rejects a missing final summary even if the process exited zero', () => {
    expect(classify({ report: undefined }).errors).toContain('Vitest final JSON summary is missing or malformed.');
  });

  it('rejects a planted worker error even when the reporter claims success', () => {
    const result = classify({ stderr: 'Error: [vitest-pool]: Worker exited unexpectedly', report: fixture({ success: true }) });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/worker\/pool/);
  });

  it('rejects an unhandled or interrupted result recorded only in JSON', () => {
    const report = { ...fixture({ success: true }), unhandledErrors: [{ message: 'worker died' }], wasInterrupted: true };
    const errors = classify({ report }).errors.join('\n');
    expect(errors).toMatch(/unhandled error/);
    expect(errors).toMatch(/interrupted run/);
  });

  it('rejects a planted count mismatch', () => {
    const report = fixture();
    report.numTotalTests++;
    expect(classify({ report }).errors.join('\n')).toMatch(/Test-count mismatch/);
  });

  it('retains the failed file, assertion name and message in evidence', () => {
    const report = fixture({ assertions: [assertion('a'), assertion('specific failure', 'failed'), assertion('c')] });
    expect(classify({ report }).summary.failedTests).toEqual([{
      file: 'file-0.test.ts',
      name: 'specific failure',
      messages: ['specific failure failed'],
    }]);
  });

  it('prints each failed test by file and full name, with its first failure line and the line it failed on', () => {
    const root = '/home/runner/work/unode';
    const failure = [
      "AssertionError: expected 2 to be 1 // Object.is equality",
      '    at Object.<anonymous> (file:///home/runner/work/unode/node_modules/@vitest/runner/dist/index.js:10:5)',
      '    at processTicksAndRejections (node:internal/process/task_queues:104:5)',
      '    at file:///home/runner/work/unode/src/backend/__tests__/WorkspaceToolsSecurity.test.ts:223:23',
    ].join('\n');
    const report = fixture({ assertions: [assertion('a'), { fullName: 'sandbox hardening refuses a cmdlet', status: 'failed', failureMessages: [failure] }, assertion('c')] });
    report.testResults[0].name = `${root}/src/backend/__tests__/WorkspaceToolsSecurity.test.ts`;
    report.testResults[0].status = 'failed';
    report.success = false;
    report.numFailedTestSuites = 1;
    report.numPassedTestSuites = report.numTotalTestSuites - 1;
    const text = renderReleaseGateFailure(classify({ report, exitCode: 1 }), { root });
    expect(text.split('\n')[0]).toBe('Release test gate FAILED:');
    expect(text).toContain('- 1 assertion(s) failed.');
    expect(text).toContain([
      'Failed tests (1):',
      '- src/backend/__tests__/WorkspaceToolsSecurity.test.ts › sandbox hardening refuses a cmdlet',
      '    AssertionError: expected 2 to be 1 // Object.is equality',
      '    at src/backend/__tests__/WorkspaceToolsSecurity.test.ts:223:23',
    ].join('\n'));
    // The file's failure is its test's: it is not listed again as a file that failed outside any test.
    expect(text).not.toContain('Files that failed outside any test');
  });

  it('shows Windows paths from the repository root too', () => {
    const text = renderReleaseGateFailure({
      errors: ['1 assertion(s) failed.'],
      summary: {
        failedTests: [{
          file: 'C:/AI_Program/unode/src/backend/__tests__/WorkspaceToolsBackground.test.ts',
          name: 'WorkspaceTools background commands kill_command stops a long-running command',
          messages: ["AssertionError: expected 'Background command \"bg_1\" was told to…' to contain 'killed'\n    at C:/AI_Program/unode/src/backend/__tests__/WorkspaceToolsBackground.test.ts:70:57"],
        }],
        fileErrors: [],
      },
    }, { root: 'C:\\AI_Program\\unode' });
    expect(text).toContain('- src/backend/__tests__/WorkspaceToolsBackground.test.ts › WorkspaceTools background commands kill_command stops a long-running command');
    expect(text).toContain('    at src/backend/__tests__/WorkspaceToolsBackground.test.ts:70:57');
  });

  it('prints a file that failed outside any test, and cuts a long list saying by how much', () => {
    const report = fixture({ files: 3 });
    report.testResults[1].status = 'failed';
    report.testResults[1].message = 'Failed to load url ./missing (resolved id: ./missing)\nmore detail';
    report.success = false;
    const classified = classify({ report, exitCode: 1 });
    expect(classified.summary.fileErrors).toEqual([{
      file: 'file-1.test.ts', status: 'failed', message: 'Failed to load url ./missing (resolved id: ./missing)\nmore detail',
    }]);
    const text = renderReleaseGateFailure(classified);
    expect(text).toContain('Files that failed outside any test (1):\n- file-1.test.ts (failed): Failed to load url ./missing (resolved id: ./missing)');
    expect(text).not.toContain('more detail');
    expect(text).not.toContain('Failed tests');

    const many = Array.from({ length: 30 }, (_, index) => ({ file: `src/f${index}.test.ts`, name: `case ${index}`, messages: [] }));
    const cut = renderReleaseGateFailure({ errors: ['30 assertion(s) failed.'], summary: { failedTests: many, fileErrors: [] } });
    expect(cut).toContain('Failed tests (30):');
    expect(cut).toContain('- src/f24.test.ts › case 24');
    expect(cut).not.toContain('case 25');
    expect(cut).toContain('- … and 5 more');
  });

  it('prints the gate errors alone when there is no report to read', () => {
    const classified = classify({ report: undefined, discovered: undefined, exitCode: 1 });
    expect(renderReleaseGateFailure(classified)).toBe([
      'Release test gate FAILED:',
      '- Vitest exited 1 instead of 0.',
      '- Vitest final JSON summary is missing or malformed.',
    ].join('\n'));
  });

  it('rejects a discovered file count below the ratchet', () => {
    expect(classify({ report: fixture({ files: 1 }) }).errors.join('\n')).toMatch(/file count 1 is below baseline 2/);
  });

  it('rejects a suite/file discovery mismatch above the baseline', () => {
    const report = fixture({ files: 2 });
    expect(classify({ report, discovered: { files: 3, tests: 3, testIdentities: ['a', 'b', 'c'] } }).errors.join('\n'))
      .toMatch(/Discovered-file mismatch/);
  });

  it('rejects a pre-run/final test discovery mismatch', () => {
    expect(classify({ discovered: { files: 2, tests: 4, testIdentities: ['a', 'b', 'c', 'extra'] } }).errors.join('\n'))
      .toMatch(/Discovered-test mismatch/);
  });

  it('reconciles the five final Linux/macOS skips that vitest list omits from pre-run discovery', () => {
    const platformSkips = ['conditional one', 'conditional two', 'conditional three', 'conditional four', 'conditional five'];
    const assertions = [assertion('a'), ...platformSkips.map((name) => assertion(name, 'skipped'))];
    const report = fixture({ assertions });
    for (const platform of ['linux', 'darwin']) {
      const result = classify({
        report,
        discovered: { files: 2, tests: 1, testIdentities: ['a'] },
        baseline: {
          minimumFiles: 2,
          minimumTests: 6,
          allowedSkippedTests: { [platform]: platformSkips },
        },
        platform,
      });
      expect(result).toMatchObject({ ok: true, summary: { tests: 6, passed: 1, skipped: 5 } });
    }
  });

  // v0.9.97 (first CI of the release): three test files run only on Windows; on Linux `vitest list` omits each of
  // them with its tests, and the final report still lists them.
  it('reconciles a Linux/macOS file whose every test is an allowed platform skip, and only such a file', () => {
    const platformSkips = ['windows only one', 'windows only two'];
    const skipped = platformSkips.map((name) => assertion(name, 'skipped'));
    const report = fixture({ files: 2, assertions: [assertion('a'), assertion('b'), assertion('c'), ...skipped] });
    report.testResults[0].assertionResults = report.testResults[0].assertionResults.slice(0, 3);
    report.testResults[1] = { name: 'windows-only.test.ts', status: 'passed', assertionResults: skipped };
    const run = (skips, discovered = { files: 1, tests: 3, testIdentities: ['a', 'b', 'c'] }) => classify({
      report, discovered, platform: 'linux',
      baseline: { minimumFiles: 2, minimumTests: 5, allowedSkippedTests: { linux: skips } },
    });
    expect(run(platformSkips)).toMatchObject({ ok: true, summary: { tests: 5, passed: 3, skipped: 2 } });
    // A file with one skip that is not allowed is not reconciled.
    expect(run(['windows only one']).errors.join('\n')).toMatch(/Discovered-file mismatch: pre-run=1, platform-only files=0, final results=2/);
    // A file that discovery did list is not counted twice: it is reconciled by the count, not again as platform-only.
    expect(run(platformSkips, { files: 2, tests: 5, testIdentities: ['a', 'b', 'c', 'windows only one', 'windows only two'] }))
      .toMatchObject({ ok: true });
    expect(run(platformSkips, { files: 1, tests: 5, testIdentities: ['a', 'b', 'c', 'windows only one', 'windows only two'] }).errors.join('\n'))
      .toMatch(/Discovered-file mismatch: pre-run=1, platform-only files=0, final results=2/);
  });

  it('rejects an allowed-skip baseline entry that matches no final discovered test', () => {
    const assertions = [assertion('a'), assertion('documented skip', 'skipped'), assertion('c')];
    const report = fixture({ assertions });
    const result = classify({
      report,
      baseline: {
        minimumFiles: 2,
        minimumTests: 3,
        allowedSkippedTests: { win32: ['documented skip', 'deleted test'] },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Allowed skipped test matches no final discovered test: deleted test.');
  });

  it('accepts an environment-dependent skip whether this machine skips it or runs it', () => {
    const withEntry = { ...baseline, environmentDependentSkips: { win32: ['needs a file symlink'] } };
    const skipped = [assertion('a'), assertion('b'), assertion('needs a file symlink', 'skipped')];
    const ran = [assertion('a'), assertion('b'), assertion('needs a file symlink')];
    expect(classify({ report: fixture({ assertions: skipped }), baseline: withEntry }).ok).toBe(true);
    expect(classify({ report: fixture({ assertions: ran }), baseline: withEntry }).ok).toBe(true);
    // Only the listed test may skip.
    const other = [assertion('a'), assertion('b'), assertion('another test', 'skipped')];
    expect(classify({ report: fixture({ assertions: other }), baseline: withEntry }).errors)
      .toContain('Unexpected skipped test: another test.');
  });

  it('rejects an environment-dependent skip entry that matches no final discovered test', () => {
    const result = classify({ baseline: { ...baseline, environmentDependentSkips: { win32: ['deleted test'] } } });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Environment-dependent skip matches no final discovered test: deleted test.');
  });

  it('rejects a discovered test count below the ratchet', () => {
    expect(classify({ report: fixture({ assertions: [assertion('a'), assertion('b')] }) }).errors.join('\n'))
      .toMatch(/test count 2 is below baseline 3/);
  });

  it('rejects pending and undocumented skipped assertions hidden behind success=true', () => {
    const assertions = [assertion('a'), assertion('hidden pending', 'pending'), assertion('hidden skip', 'skipped')];
    const errors = classify({ report: fixture({ assertions, success: true }) }).errors.join('\n');
    expect(errors).toMatch(/remained pending/);
    expect(errors).toMatch(/Unexpected skipped test/);
  });
});
