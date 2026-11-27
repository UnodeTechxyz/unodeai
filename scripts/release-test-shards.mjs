// Sharded release suite (v0.9.107, the Owner's decision of 2026-11-21: "直接改分片").
//
// CI runs the complete release suite as N shard jobs and one gate job. Each shard job records its raw Vitest
// discovery list and JSON report; it never decides that the suite passed. The gate job checks that the shards are
// exactly the complete suite (every shard present, one commit, one platform, and the files of the discovery lists and
// of the reports each disjoint and together equal to the complete file list), merges them into one discovery and one
// report, and hands those to the same classifier a single run uses. Every guarantee of that classifier therefore holds
// for the merged run unchanged.

import { isAbsolute, relative, resolve, sep } from 'node:path';
import { reporterIdentityFromVitestList } from './release-test-classifier.mjs';

export const SHARD_RECORD_SCHEMA = 1;

/** `i/n` with 1 <= i <= n <= 16; anything else is refused. */
export function parseShardPart(text) {
  const match = /^([1-9][0-9]?)\/([1-9][0-9]?)$/.exec(String(text ?? ''));
  if (!match) throw new Error(`A release shard is named i/n, for example 2/3; got ${JSON.stringify(text)}.`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total > 16 || index > total) throw new Error(`Release shard ${text} is out of range (at most 16 shards; i <= n).`);
  return { index, total };
}

/** The file name a shard's record is written to and read from. */
export function shardRecordName(index, total) {
  return `release-shard-${index}-of-${total}.json`;
}

/**
 * A test file's identity for comparing lists from different jobs and tools: its path from the repository root, in
 * forward slashes, and on Windows in lower case (Windows paths compare without case; Vitest spells the drive both
 * ways). Paths outside the root keep their full resolved form, so they can never match a file inside it.
 */
export function fileIdentity(file, root, platform = process.platform) {
  const full = resolve(String(file ?? ''));
  const fromRoot = relative(root, full);
  const inside = fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
  const shown = inside ? fromRoot : full;
  const forward = shown.split(sep).join('/').replaceAll('\\', '/');
  return platform === 'win32' ? forward.toLowerCase() : forward;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The report counts the merge sums. Each must be present in every shard report, as the single-run gate requires. */
export const REPORT_COUNT_KEYS = Object.freeze([
  'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests',
  'numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites',
]);

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Merge the shard records of one run.
 *
 * @param {{
 *   records: Array<any|undefined>,   // index i-1 holds shard i's parsed record, or undefined when it is missing
 *   total: number,
 *   allFiles: string[],              // the complete test file list of the gate's own checkout
 *   root: string,
 *   platform: string,                // the gate's platform; every shard must have run on it
 *   commit?: string,                 // the gate's commit, when known; every shard must name the same one
 * }} input
 * @returns {{ errors: string[], discovered?: any, report?: any, exitCode: number|null, signal: string|null,
 *   stdout: string, stderr: string, shardDurationsMs: number[] }}
 */
export function mergeShardRecords({ records, total, allFiles, root, platform, commit }) {
  const errors = [];
  const id = (file) => fileIdentity(file, root, platform);
  if (!Number.isSafeInteger(total) || total < 1 || records.length !== total) {
    errors.push(`Expected ${String(total)} shard records, got ${records.length}.`);
  }
  const present = [];
  records.forEach((record, slot) => {
    const index = slot + 1;
    if (!record || typeof record !== 'object') { errors.push(`Shard ${index} of ${total} wrote no record.`); return; }
    if (record.schema !== SHARD_RECORD_SCHEMA) errors.push(`Shard ${index} record has schema ${String(record.schema)}, expected ${SHARD_RECORD_SCHEMA}.`);
    if (record.index !== index || record.total !== total) {
      errors.push(`Shard record in slot ${index} names shard ${String(record.index)} of ${String(record.total)}.`);
    }
    if (record.platform !== platform) errors.push(`Shard ${index} ran on ${String(record.platform)}, the gate on ${platform}.`);
    if (commit && record.commit !== commit) errors.push(`Shard ${index} ran commit ${String(record.commit)}, the gate has ${commit}.`);
    if (!Array.isArray(record.discovery)) errors.push(`Shard ${index} has no discovery list${record.discoveryError ? `: ${String(record.discoveryError).replace(/\.$/, '')}` : ''}.`);
    if (!record.report || !Array.isArray(record.report.testResults)) {
      errors.push(`Shard ${index} has no Vitest JSON report.`);
    } else {
      // Audit F1 (60f1c175): a missing count must not be summed as zero; the single-run gate rejects it.
      for (const key of REPORT_COUNT_KEYS) {
        if (!isCount(record.report[key])) errors.push(`Shard ${index} report count ${key} is missing or invalid (${String(record.report[key])}).`);
      }
    }
    // Audit F1 (60f1c175): an unknown exit status is a failure, never a success.
    if (!isCount(record.exitCode)) errors.push(`Shard ${index} has no valid exit status (${String(record.exitCode)}).`);
    if (record.signal !== null && record.signal !== undefined && (typeof record.signal !== 'string' || record.signal === '')) {
      errors.push(`Shard ${index} has an invalid signal (${String(record.signal)}).`);
    }
    present.push(record);
  });

  // The shards must be exactly the complete suite, in the discovery lists and in the reports.
  const complete = new Set(allFiles.map(id));
  if (complete.size !== allFiles.length) errors.push('The complete test file list names a file twice.');
  for (const [label, filesOf] of [
    ['discovery', (record) => Array.isArray(record.discovery) ? [...new Set(record.discovery.map((entry) => entry?.file))] : []],
    ['report', (record) => Array.isArray(record.report?.testResults) ? record.report.testResults.map((file) => file?.name) : []],
  ]) {
    const owner = new Map();
    for (const record of present) {
      for (const file of filesOf(record)) {
        const key = id(file);
        if (owner.has(key)) errors.push(`The ${label} of shards ${owner.get(key)} and ${record.index} both hold ${key}.`);
        else owner.set(key, record.index);
      }
    }
    const missing = [...complete].filter((key) => !owner.has(key));
    const extra = [...owner.keys()].filter((key) => !complete.has(key));
    // A platform-only file is in a report but not in a discovery list; the classifier reconciles it. A report file
    // outside the complete list, or a complete-list file missing from the reports, is never reconciled.
    if (label === 'report' && missing.length > 0) errors.push(`The shard reports miss ${missing.length} test file(s), first ${missing[0]}.`);
    if (label === 'discovery' && extra.length > 0) errors.push(`The shard discovery lists hold ${extra.length} file(s) outside the complete list, first ${extra[0]}.`);
    if (label === 'report' && extra.length > 0) errors.push(`The shard reports hold ${extra.length} file(s) outside the complete list, first ${extra[0]}.`);
  }

  const usable = present.filter((record) => Array.isArray(record.discovery) && Array.isArray(record.report?.testResults));
  let discovered;
  let report;
  if (errors.length === 0 && usable.length === total) {
    const entries = usable.flatMap((record) => record.discovery);
    discovered = {
      files: new Set(entries.map((entry) => id(entry?.file))).size,
      tests: entries.length,
      testIdentities: entries.map((entry) => reporterIdentityFromVitestList(entry?.name)),
    };
    // Every count was validated above; a merge with an invalid one never reaches here.
    const sum = (key) => usable.reduce((acc, record) => acc + record.report[key], 0);
    report = {
      testResults: usable.flatMap((record) => record.report.testResults),
      numTotalTests: sum('numTotalTests'),
      numPassedTests: sum('numPassedTests'),
      numFailedTests: sum('numFailedTests'),
      numPendingTests: sum('numPendingTests'),
      numTodoTests: sum('numTodoTests'),
      numTotalTestSuites: sum('numTotalTestSuites'),
      numPassedTestSuites: sum('numPassedTestSuites'),
      numFailedTestSuites: sum('numFailedTestSuites'),
      numPendingTestSuites: sum('numPendingTestSuites'),
      success: usable.every((record) => record.report.success === true),
      wasInterrupted: usable.some((record) => record.report.wasInterrupted === true),
      unhandledErrors: usable.flatMap((record) => Array.isArray(record.report.unhandledErrors) ? record.report.unhandledErrors : []),
    };
  }
  // The first shard whose exit is not exactly 0 gives the merged exit, whatever that value is, so an unknown or later
  // failing exit always reaches the classifier as a failure (audit F1, 60f1c175).
  const failing = present.find((record) => record.exitCode !== 0);
  const exitCode = present.length !== total ? null : failing ? failing.exitCode ?? null : 0;
  const signal = present.map((record) => record.signal).find(Boolean) ?? null;
  return {
    errors,
    discovered,
    report,
    exitCode,
    signal,
    stdout: present.map((record) => String(record.stdout ?? '')).join('\n'),
    stderr: present.map((record) => String(record.stderr ?? '')).join('\n'),
    shardDurationsMs: present.map((record) => finite(record.durationMs)),
  };
}
