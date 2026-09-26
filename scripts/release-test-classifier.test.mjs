import { describe, expect, it } from 'vitest';
import { classifyReleaseTestRun, reporterIdentityFromVitestList } from './release-test-classifier.mjs';

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
