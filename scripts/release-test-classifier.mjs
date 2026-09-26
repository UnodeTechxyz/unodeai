const WORKER_ERROR_PATTERNS = [
  /\[vitest-pool\]/i,
  /worker (?:forks )?emitted error/i,
  /worker exited unexpectedly/i,
  /some tests are still running when generating the json report/i,
  /vitest caught \d+ unhandled error/i,
  /unhandled errors/i,
];

function finiteCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// `vitest list --json` separates nested suites with ` > `, while the final JSON reporter's
// assertion.fullName joins those same segments with spaces. Convert discovery names into the
// reporter identity once so skip allowances, stale-entry checks and count reconciliation all use
// the exact identity that appears in release evidence.
export function reporterIdentityFromVitestList(name) {
  return typeof name === 'string' ? name.replaceAll(' > ', ' ') : '';
}

function assertionTitle(assertion) {
  return typeof assertion?.fullName === 'string'
    ? assertion.fullName
    : typeof assertion?.title === 'string'
      ? assertion.title
      : '';
}

/**
 * Classify one Vitest JSON run independently of Vitest's own `success` bit. A crashed worker can leave
 * that bit true while assertions in a reported file are still pending, so every count is re-derived.
 */
export function classifyReleaseTestRun({ exitCode, signal, stdout = '', stderr = '', report, discovered, baseline, platform }) {
  const errors = [];
  const output = `${stdout}\n${stderr}`;
  if (exitCode !== 0) errors.push(`Vitest exited ${String(exitCode)} instead of 0.`);
  if (signal) errors.push(`Vitest ended from signal ${signal}.`);
  for (const pattern of WORKER_ERROR_PATTERNS) {
    if (pattern.test(output)) {
      errors.push(`Vitest output contains a worker/pool or incomplete-report error (${pattern}).`);
      break;
    }
  }

  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    errors.push('Vitest final JSON summary is missing or malformed.');
    return { ok: false, errors, summary: undefined };
  }

  const reportedUnhandledErrors = Array.isArray(report.unhandledErrors) ? report.unhandledErrors.length : 0;
  if (reportedUnhandledErrors > 0) {
    errors.push(`Vitest JSON reports ${reportedUnhandledErrors} unhandled error(s).`);
  }
  if (report.wasInterrupted === true) errors.push('Vitest JSON reports an interrupted run.');

  const files = report.testResults.length;
  const assertions = report.testResults.flatMap((file) => Array.isArray(file.assertionResults) ? file.assertionResults : []);
  const failedTests = report.testResults.flatMap((file) =>
    (Array.isArray(file.assertionResults) ? file.assertionResults : [])
      .filter((assertion) => assertion?.status === 'failed')
      .map((assertion) => ({
        file: typeof file?.name === 'string' ? file.name : '(unknown file)',
        name: assertionTitle(assertion) || '(unnamed assertion)',
        messages: Array.isArray(assertion?.failureMessages)
          ? assertion.failureMessages.filter((message) => typeof message === 'string')
          : [],
      })),
  );
  const counts = { passed: 0, skipped: 0, pending: 0, failed: 0, todo: 0, unknown: 0 };
  const configuredAllowedSkips = baseline?.allowedSkippedTests?.[platform];
  const allowedSkips = new Set(Array.isArray(configuredAllowedSkips) ? configuredAllowedSkips : []);
  const finalIdentities = new Set();
  const skippedIdentities = new Set();
  for (const assertion of assertions) {
    const status = String(assertion?.status ?? 'unknown');
    const identity = assertionTitle(assertion);
    if (identity) finalIdentities.add(identity);
    if (Object.hasOwn(counts, status)) counts[status]++;
    else counts.unknown++;
    if (status === 'skipped') {
      if (identity) skippedIdentities.add(identity);
      if (!allowedSkips.has(identity)) {
        errors.push(`Unexpected skipped test: ${identity || '(unnamed)'}.`);
      }
    }
  }
  for (const allowedSkip of allowedSkips) {
    if (!finalIdentities.has(allowedSkip)) {
      errors.push(`Allowed skipped test matches no final discovered test: ${allowedSkip}.`);
    } else if (!skippedIdentities.has(allowedSkip)) {
      errors.push(`Allowed skipped test did not skip on ${platform}: ${allowedSkip}.`);
    }
  }

  if (counts.pending > 0) errors.push(`${counts.pending} assertion(s) remained pending.`);
  if (counts.failed > 0) errors.push(`${counts.failed} assertion(s) failed.`);
  if (counts.todo > 0) errors.push(`${counts.todo} todo assertion(s) are not admitted by the release gate.`);
  if (counts.unknown > 0) errors.push(`${counts.unknown} assertion(s) have an unknown status.`);
  if (report.testResults.some((file) => file?.status !== 'passed')) {
    errors.push('At least one discovered test file did not finish with status "passed".');
  }
  if (report.success !== true) errors.push('Vitest did not report success=true.');

  const totalTests = assertions.length;
  if (!discovered || !Number.isSafeInteger(discovered.files) || !Number.isSafeInteger(discovered.tests)
      || !Array.isArray(discovered.testIdentities)
      || !discovered.testIdentities.every((identity) => typeof identity === 'string')
      || discovered.testIdentities.length !== discovered.tests) {
    errors.push('Pre-run Vitest discovery summary is missing or malformed.');
  } else {
    if (files !== discovered.files) {
      errors.push(`Discovered-file mismatch: pre-run=${discovered.files}, final results=${files}.`);
    }
    const discoveredIdentities = new Set(discovered.testIdentities);
    const platformSkippedOutsideList = [...allowedSkips]
      .filter((identity) => skippedIdentities.has(identity) && !discoveredIdentities.has(identity))
      .length;
    const reconciledDiscoveredTests = discovered.tests + platformSkippedOutsideList;
    if (totalTests !== reconciledDiscoveredTests) {
      errors.push(`Discovered-test mismatch: pre-run=${discovered.tests}, platform-only skipped=${platformSkippedOutsideList}, reconciled=${reconciledDiscoveredTests}, final assertions=${totalTests}.`);
    }
  }
  const declared = {
    total: finiteCount(report.numTotalTests),
    passed: finiteCount(report.numPassedTests),
    failed: finiteCount(report.numFailedTests),
    pending: finiteCount(report.numPendingTests),
    todo: finiteCount(report.numTodoTests),
  };
  if (declared.total !== totalTests) errors.push(`Test-count mismatch: report=${String(declared.total)}, assertions=${totalTests}.`);
  if (declared.passed !== counts.passed) errors.push(`Passed-count mismatch: report=${String(declared.passed)}, assertions=${counts.passed}.`);
  if (declared.failed !== counts.failed) errors.push(`Failed-count mismatch: report=${String(declared.failed)}, assertions=${counts.failed}.`);
  if (declared.pending !== counts.pending + counts.skipped) {
    errors.push(`Pending/skip-count mismatch: report=${String(declared.pending)}, assertions=${counts.pending + counts.skipped}.`);
  }
  if (declared.todo !== counts.todo) errors.push(`Todo-count mismatch: report=${String(declared.todo)}, assertions=${counts.todo}.`);

  const suiteTotal = finiteCount(report.numTotalTestSuites);
  const suitePassed = finiteCount(report.numPassedTestSuites);
  const suiteFailed = finiteCount(report.numFailedTestSuites);
  const suitePending = finiteCount(report.numPendingTestSuites);
  if (suiteTotal === undefined || suitePassed === undefined || suiteFailed === undefined || suitePending === undefined
      || suitePassed + suiteFailed + suitePending !== suiteTotal) {
    errors.push('Suite-summary counts are missing or inconsistent.');
  }
  if ((suiteFailed ?? 0) > 0 || (suitePending ?? 0) > 0) {
    errors.push(`Suite summary is incomplete: failed=${String(suiteFailed)}, pending=${String(suitePending)}.`);
  }

  const minimumFiles = finiteCount(baseline?.minimumFiles);
  const minimumTests = finiteCount(baseline?.minimumTests);
  if (minimumFiles === undefined || minimumTests === undefined) {
    errors.push('Release test baseline is missing valid minimumFiles/minimumTests values.');
  } else {
    if (files < minimumFiles) errors.push(`Discovered file count ${files} is below baseline ${minimumFiles}.`);
    if (totalTests < minimumTests) errors.push(`Discovered test count ${totalTests} is below baseline ${minimumTests}.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      files,
      tests: totalTests,
      passed: counts.passed,
      skipped: counts.skipped,
      pending: counts.pending,
      failed: counts.failed,
      todo: counts.todo,
      unhandledError: reportedUnhandledErrors > 0 || WORKER_ERROR_PATTERNS.some((pattern) => pattern.test(output)),
      failedTests,
    },
  };
}
