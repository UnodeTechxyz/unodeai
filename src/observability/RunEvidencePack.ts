import { describeRunVerdictWithholding, latestRunVerdictResolution, RunRecord } from './RunLedger';
import { sanitizeContentReceipt } from '../content/ContentReceipt';
import {
  deriveWorkerTaskProgressDistribution,
  LONG_TASK_THRESHOLDS_MS,
  MIN_COHORT_SIZE_FOR_SEPARATION,
  WorkerProgressCohortDistribution,
} from '../session/WorkerTaskProgress';

export interface RunMechanicalAccounting {
  dispatched: number;
  settled: number;
  cancelled: number;
  refusedBeforeDispatch: number;
  dispositions: Array<{
    handle: string;
    task: string;
    disposition: string;
    recordedAt: string;
  }>;
}

/** Counts only durable ledger receipts. It never reconstructs a result from chat text or model prose. */
export function deriveRunMechanicalAccounting(run: RunRecord): RunMechanicalAccounting {
  return {
    dispatched: run.delegations.length,
    settled: run.delegations.filter((delegation) => delegation.state === 'settled').length,
    cancelled: run.delegations.filter((delegation) => delegation.state === 'cancelled').length,
    refusedBeforeDispatch: run.refusedDispatches.length,
    dispositions: run.delegations.flatMap((delegation) => delegation.dispositions.map((entry) => ({
      handle: delegation.handle,
      task: delegation.instruction,
      disposition: entry.disposition,
      recordedAt: entry.recordedAt,
    }))),
  };
}

/** A self-contained Markdown artifact: it has no extension-only schema or viewer dependency. */
export function renderRunEvidencePack(run: RunRecord, exportedAt = new Date().toISOString()): string {
  const accounting = deriveRunMechanicalAccounting(run);
  const verdictResolution = latestRunVerdictResolution(run);
  const humanVerdict = verdictResolution.status === 'accepted' ? verdictResolution.verdict : undefined;
  const lines = [
    '# UnodeAi run evidence pack',
    '',
    'This is plain Markdown. It can be read without UnodeAi or any other extension.',
    '',
    '## Run boundary',
    '',
    `- Run ID: \`${escapeCode(run.id)}\``,
    `- Coordinator: \`${escapeCode(run.coordinatorId)}\``,
    `- Started: ${escapeText(run.startedAt)}`,
    `- Status: **${run.status === 'closed' && run.closeoutCompletionState === 'partial' ? 'PARTIAL' : run.status.toUpperCase()}**${run.endedAt ? ` (closed ${escapeText(run.endedAt)})` : ''}`,
    `- Exported: ${escapeText(exportedAt)}`,
    '',
    run.status === 'open'
      ? 'This run is still open because no final coordinator closeout was observed on this run\'s own correlation thread after all dispatched work settled. It remains separate across extension-host restarts and must not be read as complete.'
      : run.closeoutCompletionState === 'partial'
        ? 'This run closed when its coordinator ended a correlated turn with unfinished activity and no live delegation left. Closure records ownership finalization, not completion or acceptance.'
        : 'This run closed when its coordinator completed a correlated closeout with no live delegation left.',
    '',
    '## Human acceptance',
    '',
    humanVerdict
      ? `- Verdict: **${escapeText(humanVerdict.verdict)}** by \`${escapeCode(humanVerdict.approverId)}\` at ${escapeText(humanVerdict.recordedAt)}.`
      : '- Verdict: **UNJUDGED**. Closing a run, framework verification, and a coordinator disposition never become a human verdict.',
    humanVerdict
      ? `- Evidence was reviewed at: ${escapeText(humanVerdict.evidenceReviewedAt)}.`
      : '',
    verdictResolution.status === 'withheld'
      ? `- Stored verdict: **WITHHELD**. ${escapeText(describeRunVerdictWithholding(verdictResolution.reason))}`
      : '',
    humanVerdict && humanVerdict.unresolvedItems.length > 0
      ? `- Unresolved items (${humanVerdict.unresolvedItems.length}): ${humanVerdict.unresolvedItems.map(escapeText).join('; ')}`
      : '',
    '',
    '## What was asked',
    '',
    run.objective ? escapeText(run.objective) : '_No user request was retained before the first observed dispatch._',
    '',
    '## Mechanical accounting',
    '',
    `- Dispatched: **${accounting.dispatched}**`,
    `- Settled: **${accounting.settled}**`,
    `- Cancelled: **${accounting.cancelled}**`,
    `- Refused before dispatch: **${accounting.refusedBeforeDispatch}**`,
    `- Recorded dispositions: **${accounting.dispositions.length}**`,
    '',
    'Every figure above is derived from this run\'s durable dispatch, settlement, refusal, and disposition receipts; none requires a human to reconstruct it from chat history.',
    '',
    '### Dispositions by task',
    '',
  ];
  if (accounting.dispositions.length === 0) {
    lines.push('_No coordinator disposition was recorded._', '');
  } else {
    for (const disposition of accounting.dispositions) {
      lines.push(`- ${escapeText(disposition.recordedAt)} | handle \`${escapeCode(disposition.handle)}\` | ${escapeText(disposition.task)} | **${escapeText(disposition.disposition)}**`);
    }
    lines.push('');
  }

  lines.push(
    '## Delegations',
    '',
  );
  if (run.delegations.length === 0) {
    lines.push('_No delegation was recorded._', '');
  }
  for (const delegation of run.delegations) {
    const evidence = delegation.evidence;
    lines.push(`### ${escapeText(delegation.requestedAgent)} -> ${escapeText(delegation.agentId)}`);
    lines.push('', `- Handle: \`${escapeCode(delegation.handle)}\``, `- Dispatched: ${escapeText(delegation.dispatchedAt)}`);
    lines.push(`- Task: ${escapeText(delegation.instruction)}`);
    if (delegation.contract) {
      const contract = delegation.contract;
      lines.push(`- Contract: \`${escapeCode(contract.contractId)}\` (v${contract.version}); attempt ${delegation.attemptId ? `\`${escapeCode(delegation.attemptId)}\`` : '_not retained_'}.`);
      lines.push(`- Contract objective: ${escapeText(contract.objective)}`);
      lines.push(`- Expected deliverable: ${escapeText(contract.expectedDeliverable || 'not declared')}`);
      lines.push(`- Execution strategy: **${escapeText(contract.executionStrategy)}**; required capabilities: ${contract.requiredCapabilities.capabilities.map(escapeText).join(', ') || 'explicitly empty'}.`);
      lines.push(`- Read files: ${contract.effects.readFiles.length ? contract.effects.readFiles.map((file) => `\`${escapeCode(file)}\``).join(', ') : 'none declared'}; expected file effect: ${escapeText(contract.effects.expectedFileEffect)}.`);
      if (contract.effects.writeScope) {
        lines.push(`- Contract write scope: ${contract.effects.writeScope.folderAccess.map((grant) => `${escapeText(grant.permission)} \`${escapeCode(grant.path)}\``).join(', ')}.`);
      }
      lines.push('- Contract inputs:');
      if (contract.inputs.length === 0) lines.push('  - none declared');
      for (const input of contract.inputs) {
        const source = input.kind === 'contentAsset' ? input.assetId : input.kind === 'workspacePath' ? input.path : input.artifactId;
        lines.push(`  - \`${escapeCode(input.inputId)}\` (${escapeText(input.kind)}, ${input.required ? 'required' : 'optional'}, ${escapeText(input.freshness)}): ${escapeText(input.purpose)}; source \`${escapeCode(source)}\`; provenance ${escapeText(input.provenance.kind)}${input.provenance.sourceRefs.length ? ` from ${input.provenance.sourceRefs.map((ref) => `\`${escapeCode(ref)}\``).join(', ')}` : ''}.`);
      }
      lines.push('- Coordinator-declared constraints:');
      if (contract.constraints.length === 0) lines.push('  - none declared');
      for (const constraint of contract.constraints) {
        lines.push(`  - ${escapeText(constraint.text)}${constraint.basisRefs.length ? ` (basis: ${constraint.basisRefs.map((ref) => `\`${escapeCode(ref)}\``).join(', ')})` : ''}`);
      }
    } else {
      lines.push('- Contract: _legacy dispatch; no host-compiled v0.9.61 contract retained_.');
    }
    if (delegation.verificationPlan) {
      lines.push(`- Verification plan (declared before task): ${delegation.verificationPlan.sensors.length ? delegation.verificationPlan.sensors.map(escapeText).join(', ') : 'no applicable sensor'}.`);
    } else {
      lines.push('- Verification plan: _not declared; legacy workspace verification policy applied_.');
    }
    if (delegation.route) {
      lines.push(`- Route ID: \`${escapeCode(delegation.route.routeId)}\`.`);
      lines.push(`- Execution domain: \`${escapeCode(delegation.route.executionDomain)}\`.`);
      lines.push(`- Privacy domain: \`${escapeCode(delegation.route.privacyDomain.id)}\` (${escapeText(delegation.route.privacyDomain.status)}).`);
    } else {
      lines.push('- Route / execution domain / privacy domain: _not recorded for this delegation_.');
    }
    if (delegation.temporaryScope) {
      lines.push(
        delegation.temporaryScope.appliedAt
          ? `- Temporary folder scope applied ${escapeText(delegation.temporaryScope.appliedAt)}: ${delegation.temporaryScope.readGrants} read, ${delegation.temporaryScope.readwriteGrants} read/write grant(s).`
          : `- Temporary folder scope requested, but no task-start receipt confirmed it was applied: ${delegation.temporaryScope.readGrants} read, ${delegation.temporaryScope.readwriteGrants} read/write grant(s).`,
      );
    } else if (delegation.scopeMode === 'fixed-session-permissions') {
      lines.push('- No task scope was requested: this task used the agent\'s fixed session permissions, not task-level isolation.');
    }
    if (delegation.routing) {
      const routing = delegation.routing;
      lines.push(`- Routing receipt: ${escapeText(routing.taskClassification)}; required capabilities ${routing.requiredCapabilities.length ? routing.requiredCapabilities.map(escapeText).join(', ') : 'none declared'}; filters ${routing.compatibilityFilters.map(escapeText).join(', ') || 'none'}; selection ${escapeText(routing.selectionReason)}.`);
    }
    lines.push(`- Settlement: ${delegation.state}`);
    if (delegation.state === 'cancelled') {
      lines.push(`- Cancellation: ${escapeText(delegation.cancelledAt ?? 'time not retained')}${delegation.cancellationReason ? ` - ${escapeText(delegation.cancellationReason)}` : ''}.`);
    }
    if (evidence) {
      lines.push(`- Completion state (host observed): **${escapeText(evidence.completionState)}**`);
      lines.push(`- Framework evidence verdict: **${escapeText(evidence.outcome)}**`);
      lines.push(`- Observed tool actions: ${evidence.hadToolActions ? 'yes' : 'no'}`);
      lines.push(`- Observed changed files: ${evidence.changedFiles.length === 0 ? 'none' : evidence.changedFiles.map((file) => `\`${escapeCode(file)}\``).join(', ')}`);
      lines.push(`- Observed verification: ${evidence.verification.ran ? evidence.verification.passed ? 'ran and passed' : 'ran and did not pass' : 'not observed'}.`);
      if (evidence.verificationPlanStatus) {
        lines.push(`- Declared verification-plan result: **${escapeText(evidence.verificationPlanStatus)}**.`);
      }
      if (evidence.unrecordedWrites) {
        lines.push('- Evidence caveats: writes were observed outside the recorded file list.');
      }
      if (typeof evidence.requiredInputCount === 'number' && typeof evidence.requiredInputReadNotObservedCount === 'number') {
        lines.push(`- Required input receipts: declared **${evidence.requiredInputCount}**; read receipt not observed **${evidence.requiredInputReadNotObservedCount}**.`);
      }
      for (const gap of evidence.contextGaps ?? []) {
        lines.push(`- Task state **context-gap**: input \`${escapeCode(gap.inputId)}\`; reason **${escapeText(gap.reason)}**; purpose ${escapeText(gap.purpose)}; reported ${escapeText(gap.reportedAt)}.${gap.reason === 'unreadable' ? ' The host observed a read failure.' : ''}`);
      }
      for (const artifact of evidence.taskArtifacts ?? []) {
        lines.push(`- Task artifact **artifact-ready**: \`${escapeCode(artifact.artifactId)}\`; producer attempt \`${escapeCode(artifact.producerAttemptId)}\`; delegable by ${artifact.delegableByAgentIds.map((id) => `\`${escapeCode(id)}\``).join(', ') || 'nobody'}; provenance entries ${artifact.provenance.length}.`);
      }
      for (const grant of evidence.inputGrants ?? []) {
        lines.push(`- Input receipt \`${escapeCode(grant.inputId)}\`: supplied **yes**; reachable **${grant.reachableAt ? 'yes' : 'no'}**; read receipt **${grant.readAt ? 'observed' : 'not-observed'}**. The host never claims understood.`);
      }
    } else {
      lines.push('- Framework evidence verdict: _not yet settled_.');
    }
    if (delegation.diffDigest) {
      lines.push(`- Diff digest (${delegation.diffDigest.algorithm}): \`${escapeCode(delegation.diffDigest.value)}\` over ${delegation.diffDigest.files.length} changed path(s).`);
      for (const file of delegation.diffDigest.files) {
        lines.push(`  - \`${escapeCode(file.path)}\`: before ${file.beforeContentHash ? `\`${escapeCode(file.beforeContentHash)}\`` : '_absent_'}; after ${file.afterContentHash ? `\`${escapeCode(file.afterContentHash)}\`` : '_absent_'}.`);
      }
    } else if (delegation.diffDigestUnavailable) {
      lines.push(`- Diff digest: _unavailable (${escapeText(delegation.diffDigestUnavailable)})_.`);
    } else {
      lines.push('- Diff digest: _not recorded for this delegation_.');
    }
    if (delegation.progress) {
      const progress = delegation.progress;
      lines.push('- Phase A worker progress observation:');
      lines.push(`  - Duration: ${formatDuration(progress.durationMs)}; model requests: ${progress.modelRequests}; tool calls: ${progress.toolCalls}; input tokens: ${progress.inputTokens === undefined ? 'not reported' : `${progress.inputTokens.toLocaleString()}${progress.inputTokensEstimated ? ' (estimated)' : ''}`}.`);
      lines.push(`  - Material progress: ${progress.materialProgressCount} event(s); longest no-material-progress gap: **${formatDuration(progress.longestNoMaterialProgressMs)}**.`);
      lines.push(`  - Outcome cohort: **${progress.outcome}**; terminal state: ${progress.terminalState}; final reply observed: ${progress.hasFinalReply ? 'yes' : 'no'}.`);
      lines.push(`  - Argument fingerprints retained: ${progress.fingerprintSequence.length}${progress.droppedFingerprintCount > 0 ? ` (${progress.droppedFingerprintCount} additional fingerprint(s) omitted by the retained window)` : ''}. Raw tool arguments and output are not retained.`);
    } else {
      lines.push('- Phase A worker progress observation: _not available (this task predates Phase A or has not settled)._');
    }
    lines.push('- Coordinator dispositions:');
    if (delegation.dispositions.length === 0) {
      lines.push('  - none recorded');
    } else {
      for (const disposition of delegation.dispositions) {
        lines.push(`  - ${escapeText(disposition.recordedAt)}: **${escapeText(disposition.disposition)}**${disposition.reason ? ` - ${escapeText(disposition.reason)}` : ''}${disposition.replacementHandle ? ` (replacement dispatch \`${escapeCode(disposition.replacementHandle)}\`)` : ''}`);
      }
    }
    lines.push('');
  }

  lines.push('## Refused before dispatch', '');
  if (run.refusedDispatches.length === 0) {
    lines.push('_None recorded._', '');
  } else {
    for (const refusal of run.refusedDispatches) {
      lines.push(`- ${escapeText(refusal.recordedAt)}: ${refusal.taskState ? `task state **${escapeText(refusal.taskState)}**; ` : ''}${escapeText(refusal.requestedAgent)} - ${escapeText(refusal.reason)}`);
    }
    lines.push('');
  }

  lines.push('## Permissions and grants exercised', '');
  if (run.permissions.length === 0) {
    lines.push('_No approval was observed during this run. Temporary folder scope, if any, is listed on its delegation above._', '');
  } else {
    for (const permission of run.permissions) {
      lines.push(`- ${escapeText(permission.recordedAt)}: ${escapeText(permission.kind)}${permission.label ? ` (${escapeText(permission.label)})` : ''} for \`${escapeCode(permission.agentId)}\` was ${permission.decision}${permission.approverId ? ` by \`${escapeCode(permission.approverId)}\`` : ' (no contemporaneous human approver recorded)'}.`);
    }
    lines.push('');
  }

  lines.push('## Context sources admitted', '');
  if (run.contextReceipts.length === 0) {
    lines.push('_No context manifest was observed after this run began._', '');
  } else {
    for (const receipt of run.contextReceipts) {
      lines.push(`### \`${escapeCode(receipt.agentId)}\` at ${escapeText(receipt.recordedAt)}`, '');
      if (receipt.entries.length === 0) {
        lines.push('_The manifest contained no entries._');
      }
      for (const entry of receipt.entries) {
        const sensitivity = entry.sensitivitySignals?.length ? `; sensitivity signals: ${entry.sensitivitySignals.map(escapeText).join(', ')}` : '';
        lines.push(`- ${escapeText(entry.kind)}: ${escapeText(entry.label)} (${entry.bytes} bytes; ${escapeText(entry.staleness)}${sensitivity}).`);
      }
      lines.push('');
    }
  }

  lines.push('## Bounded content consultation receipts', '');
  const contentReceipts = run.contentReceipts.flatMap((receipt) => {
    const safe = sanitizeContentReceipt(receipt);
    return safe ? [safe] : [];
  });
  if (contentReceipts.length === 0) {
    lines.push('_No bounded rich-content receipt was recorded for this run._', '');
  } else {
    for (const receipt of contentReceipts) {
      if (receipt.contentClass === 'conversation') {
        lines.push(
          `- own conversation | ${receipt.action} | entries ${receipt.entries.start}-${receipt.entries.end} of ${receipt.entries.total}`
          + `${receipt.entries.returned === undefined ? ' searched.' : ` (${receipt.entries.returned} returned).`}`,
        );
        continue;
      }
      if (receipt.contentClass === 'image') {
        lines.push(
          `- \`${escapeCode(receipt.assetId)}\` | image | ${receipt.action} | ${receipt.processingClass}; `
          + `media consent: ${receipt.consentOutcome}.`,
        );
        continue;
      }
      const extraction = !receipt.extractionAttempted
        ? 'not requested'
        : receipt.extractionSucceeded ? 'succeeded' : 'failed';
      const coverage = receipt.pages
        ? `; pages ${receipt.pages.start}-${receipt.pages.end} of ${receipt.pages.total}${receipt.pages.extracted === undefined ? ' searched' : ` (${receipt.pages.extracted} extracted)`}`
        : '';
      lines.push(
        `- \`${escapeCode(receipt.assetId)}\` | ${receipt.contentClass} | ${receipt.action} | extraction ${extraction}${coverage}; `
        + `truncated: ${receipt.truncated ? 'yes' : 'no'}; OCR required: ${receipt.ocrRequired ? 'yes' : 'no'}.`,
      );
    }
    lines.push('');
  }

  lines.push('## Activity excerpt', '');
  if (run.droppedActivityItems > 0) {
    lines.push(`**Incomplete:** ${run.droppedActivityItems} earlier activity item(s) from this run were omitted by the 300-item per-run retained window. The structured delegation receipts above remain, but this excerpt does not show every activity message.`, '');
  } else {
    lines.push('**Complete for this run:** no activity item recorded for this run was evicted from the per-run retained window.', '');
  }
  if (run.activity.length === 0) {
    lines.push('_No activity item was retained._', '');
  } else {
    for (const item of run.activity) {
      lines.push(`- ${escapeText(item.timestamp)} | \`${escapeCode(item.from)}\` -> \`${escapeCode(item.to)}\` | ${escapeText(item.type)}${item.content ? `: ${escapeText(item.content)}` : ''}`);
    }
    lines.push('');
  }

  lines.push('## Evidence limits', '');
  lines.push('- Coordinator acceptance is an agent coordinator decision, not human or customer acceptance.');
  lines.push('- A `no-evidence`, `timed-out`, or `replied-not-verified` verdict may still have been accepted; the full disposition history above shows that explicitly.');
  lines.push('- No model judged whether this work was correct. Framework verdicts record observed tool activity, changed files, and checks only.');
  // Two different strengths, deliberately not merged into one sentence. The first list never enters the
  // pack at all; credentials in retained free text are handled by a pattern match, which is best effort.
  // This pack is meant to be handed to someone else, so the weaker guarantee says so on its own face.
  lines.push('- Approved raw commands, command arguments, verification command strings, and context contents never enter this pack.');
  lines.push('- Retained free text — the objective and each task instruction — is mechanically redacted for known credential forms. That is a pattern match, not a guarantee: a secret in an unrecognised form can survive it. Review this pack before sharing it.');
  lines.push('- A backend that emits no host-observed tool, approval, scope, or context event has no corresponding receipt here; absence is not a claim that no external effect occurred.');
  lines.push('- Messages, context receipts, and permission events without a host-observed run correlation are deliberately omitted. This can omit legitimate coordinator narration, but it prevents a reused agent from being attributed to the wrong run.');
  lines.push('- This pack proves that Job B\'s requested figures are mechanically derivable for one run. It is not the real-round Job B finding: only a later team round can establish which figures people still had to obtain by hand.');
  return `${lines.join('\n')}\n`;
}

/**
 * Cross-run Phase A report. It uses host-observed evidence cohorts, not a model judgement of whether
 * prose was useful, and renders quantiles plus buckets rather than an average.
 */
export function renderWorkerTaskProgressReport(runs: readonly RunRecord[], exportedAt = new Date().toISOString()): string {
  const records = runs.flatMap((run) => run.delegations.flatMap((delegation) => delegation.progress ? [delegation.progress] : []));
  const lines = [
    '# UnodeAi Phase A — worker no-material-progress distribution',
    '',
    `- Exported: ${escapeText(exportedAt)}`,
    `- Completed correlated worker-task observations retained: **${records.length}**`,
    '- Scope: a task starts at host dispatch and settles at its terminal backend event. Model-request and tool-call counts are host observed.',
    '- Cohorts: `framework-evidenced-output` means a non-error completion with observed tool activity, changed files, or verification. `no-framework-evidence` does **not** claim that prose was useless; it means the framework has no such evidence.',
    '- Privacy: fingerprints retain a tool name plus a one-way digest of normalized arguments. Raw arguments and tool output are absent.',
    '- The report has no arithmetic mean. It uses nearest-rank quantiles and gap buckets because mixed fast/stalled tasks make a mean misleading.',
    `- Separation needs at least **n=${MIN_COHORT_SIZE_FOR_SEPARATION}** in each cohort. Smaller non-overlapping samples are reported as insufficient data, not a candidate budget.`,
    '',
    '## Long-task distributions',
    '',
  ];
  if (records.length === 0) {
    lines.push('_No Phase A observations have settled yet. Do not select a no-progress limit from this empty report._', '');
    return `${lines.join('\n')}\n`;
  }
  for (const threshold of LONG_TASK_THRESHOLDS_MS) {
    const distribution = deriveWorkerTaskProgressDistribution(records, threshold);
    lines.push(`### Tasks ≥ ${formatDuration(threshold)} (n=${distribution.includedTasks})`, '');
    lines.push(`- Separation assessment: **${distribution.separation}**. ${separationExplanation(distribution.separation)}`, '');
    lines.push('| Cohort | n | min | p50 | p75 | p90 | p95 | max |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    lines.push(renderQuantileRow('framework-evidenced-output', distribution.frameworkEvidencedOutput));
    lines.push(renderQuantileRow('no-framework-evidence', distribution.noFrameworkEvidence));
    lines.push('', '| Longest no-material-progress gap | Framework-evidenced | No framework evidence |', '| --- | ---: | ---: |');
    for (const index of distribution.frameworkEvidencedOutput.buckets.keys()) {
      const label = distribution.frameworkEvidencedOutput.buckets[index].label;
      lines.push(`| ${label} | ${distribution.frameworkEvidencedOutput.buckets[index].count} | ${distribution.noFrameworkEvidence.buckets[index].count} |`);
    }
    lines.push('');
  }
  lines.push('## Decision rule', '');
  lines.push('- Only `evidenced-below-no-evidence` supports proposing a `noProgressMs` threshold, and the candidate must lie between the observed evidence-cohort maximum and no-evidence-cohort minimum for the chosen duration band.');
  lines.push('- `insufficient-data` and `overlap-or-reversed` are stop signals for Phase C budgeting: report them, do not tune a limit by intuition.');
  return `${lines.join('\n')}\n`;
}

function renderQuantileRow(label: string, cohort: WorkerProgressCohortDistribution): string {
  const stats = cohort.noMaterialProgressMs;
  return `| ${label} | ${cohort.count} | ${formatMetric(stats.min)} | ${formatMetric(stats.p50)} | ${formatMetric(stats.p75)} | ${formatMetric(stats.p90)} | ${formatMetric(stats.p95)} | ${formatMetric(stats.max)} |`;
}

function formatMetric(value: number | undefined): string {
  return value === undefined ? '—' : formatDuration(value);
}

function formatDuration(ms: number): string {
  if (ms < 1_000) { return `${ms}ms`; }
  if (ms < 60_000) { return `${Math.round(ms / 1_000)}s`; }
  return `${(ms / 60_000).toFixed(ms % 60_000 === 0 ? 0 : 1)}m`;
}

function separationExplanation(assessment: ReturnType<typeof deriveWorkerTaskProgressDistribution>['separation']): string {
  switch (assessment) {
    case 'evidenced-below-no-evidence':
      return 'The observed ranges do not overlap in the expected direction; this band can supply a candidate interval, not an enforced budget.';
    case 'overlap-or-reversed':
      return 'Observed ranges overlap or point in the wrong direction; no defensible no-progress threshold exists for this band.';
    default:
      return `At least one cohort has fewer than ${MIN_COHORT_SIZE_FOR_SEPARATION} observations; more observed tasks are required before judging separation.`;
  }
}

function escapeText(value: string): string {
  return value.replace(/[\\`*_{}\[\]<>]/g, '\\$&').replace(/\r?\n/g, ' ');
}

function escapeCode(value: string): string {
  return value.replace(/`/g, '\\`');
}
