#!/usr/bin/env node
/* Re-runnable v0.9.73 terminal-ownership mutation gate. Mutates a temporary copy only. */
import { cpSync, existsSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SESSION = 'src/session/SessionManager.ts';
const TEAM = 'src/backend/TeamTools.ts';
const WORKFLOW = 'src/workflow/WorkflowEngine.ts';
const PROGRESS = 'src/views/orchestrationProgress.ts';
const CHAT = 'src/views/ChatViewProvider.ts';
const MESSAGE_LOG = 'src/views/MessageLogProvider.ts';
const TEAM_VIEW = 'src/views/TeamViewProvider.ts';
const DASHBOARD = 'src/views/DashboardProvider.ts';
const LEDGER = 'src/observability/RunLedger.ts';
const PORTABLE = 'src/observability/PortableRunEvidence.ts';
const PACK = 'src/observability/RunEvidencePack.ts';
const EXTENSION = 'src/extension.ts';

const SUITES = [
  'src/session/__tests__/routing.test.ts',
  'src/backend/__tests__/TeamTools.test.ts',
  'src/workflow/__tests__/WorkflowEngine.test.ts',
  'src/views/__tests__/orchestrationProgress.test.ts',
  'src/views/__tests__/ChatViewProvider.test.ts',
  'src/views/__tests__/ChatViewProvider.eventParity.test.ts',
  'src/views/__tests__/MessageLogProvider.test.ts',
  'src/views/__tests__/DashboardProvider.test.ts',
  'src/views/__tests__/TeamViewProvider.rosterRow.test.ts',
  'src/observability/__tests__/RunLedger.test.ts',
  'src/observability/__tests__/PortableRunEvidence.test.ts',
  'src/observability/__tests__/PortableRunEvidence.integration.test.ts',
  'src/views/__tests__/runCloseoutPresentation.test.ts',
];

const MUTATIONS = [
  {
    name: 'unfinished directed turn is flattened back into task.complete', file: SESSION,
    from: "            ? 'task.partial'\n          : 'task.complete';",
    to: "            ? 'task.complete'\n          : 'task.complete';",
  },
  {
    name: 'task-attempt terminal observation is disconnected', file: SESSION,
    from: '          this.deps.onTaskAttemptTerminal?.(origin.payload.taskAttempt.attemptId);',
    to: '          // terminal observer disconnected',
  },
  {
    name: 'partial report is replaced by unfinished activity', file: SESSION,
    from: "              instruction: evt.result.text,\n              metadata: {\n                ...terminalMetadata,\n                completionState: 'partial',",
    to: "              instruction: unfinishedActivity!,\n              metadata: {\n                ...terminalMetadata,\n                completionState: 'partial',",
  },
  {
    name: 'TeamTools no longer subscribes to partial terminal results', file: TEAM,
    from: "    offPartial = this.bus.onType('task.partial', (m) => {",
    to: "    offPartial = this.bus.onType('task.status', (m) => {",
  },
  {
    name: 'TeamTools maps a partial terminal result to complete', file: TEAM,
    from: "      settleCompletion(m.payload.instruction, m.payload.metadata, 'partial');",
    to: "      settleCompletion(m.payload.instruction, m.payload.metadata, 'complete');",
  },
  {
    name: 'WorkflowEngine ignores task.partial', file: WORKFLOW,
    from: "    const partial = this.messageBus.onType('task.partial', (message) => this.acceptPartial(runId, message));",
    to: "    const partial = this.messageBus.onType('task.status', () => undefined);",
  },
  {
    name: 'orchestration progress ignores task.partial terminals', file: PROGRESS,
    from: "    if (message.type === 'task.complete' || message.type === 'task.partial' || message.type === 'system.error') {",
    to: "    if (message.type === 'task.complete' || message.type === 'system.error') {",
  },
  {
    name: 'orchestration progress counts partial as complete', file: PROGRESS,
    from: "    } else if (item.completionState === 'partial') {\n      summary.partial += 1;",
    to: "    } else if (item.completionState === 'partial') {\n      summary.done += 1;",
  },
  {
    name: 'delegation render key ignores a partial-only counter change', file: CHAT,
    from: '  return `delegation:${summary.id}:${summary.done}:${summary.partial}:${summary.blocked}:${summary.working}:${summary.closeoutCompletionState ?? \'\'}:${itemState}`;',
    to: '  return `delegation:${summary.id}:${summary.done}:${summary.blocked}:${summary.working}:${summary.closeoutCompletionState ?? \'\'}:${itemState}`;',
  },
  {
    name: 'Chat unknown delegation status falls through to Done', file: CHAT,
    from: "        : status === 'done' ? 'Done'\n        : 'Unknown';",
    to: "        : 'Done';",
  },
  {
    name: 'Message log unknown delegation status falls through to Done', file: MESSAGE_LOG,
    from: "    : status === 'done' ? 'Done'\n    : 'Unknown';",
    to: "    : 'Done';",
  },
  {
    name: 'RunLedger does not close on task.partial', file: LEDGER,
    from: "      && (message.type === 'task.complete' || message.type === 'task.partial')) {",
    to: "      && message.type === 'task.complete') {",
  },
  {
    name: 'RunLedger flattens a partial closeout into complete', file: LEDGER,
    from: "          run.closeoutCompletionState = message.type === 'task.partial' ? 'partial' : 'complete';",
    to: "          run.closeoutCompletionState = 'complete';",
  },
  {
    name: 'RunLedger list drops closeoutCompletionState', file: LEDGER,
    // v0.9.74 derives RunSummary from the policy manifest rather than destructuring in list().
    from: '  closeoutCompletionState: { portable: true, portableOrder: 6, summary: true },',
    to: '  closeoutCompletionState: { portable: true, portableOrder: 6 },',
  },
  {
    name: 'v7 normalization drops a partial closeout', file: LEDGER,
    from: '        : isRunCloseoutCompletionState(value.closeoutCompletionState)',
    to: '        : false',
  },
  {
    name: 'v6 required-input outcome is not migrated', file: LEDGER,
    from: "    outcome: legacy.outcome === 'required-inputs-unread' ? 'required-input-read-not-observed' : legacy.outcome,",
    to: '    outcome: legacy.outcome as DelegationOutcome,',
  },
  {
    name: 'timeout snapshot is overwritten by terminal snapshot', file: TEAM,
    from: '          ? { receiptSnapshots: { ...settled.evidence?.receiptSnapshots, ...evidence.receiptSnapshots } }',
    to: '          ? { receiptSnapshots: evidence.receiptSnapshots }',
  },
  {
    name: 'late ready result stays pending', file: TEAM,
    from: "      resultState: 'ready',",
    to: "      resultState: 'pending',",
  },
  {
    name: 'timeout reports its open late window as expired', file: TEAM,
    from: "        waitState: 'timed-out-window-open',",
    to: "        waitState: 'timed-out-window-expired',",
  },
  {
    name: 'post-timeout cancellation is flattened into pre-timeout cancellation', file: TEAM,
    from: "        waitState: timedOut ? 'timed-out-cancelled' : 'cancelled-before-timeout',",
    to: "        waitState: 'cancelled-before-timeout',",
  },
  {
    name: 'ready status points at the hidden blocking alias', file: TEAM,
    from: '        lines.push(`next action: call collect_ready_tasks with handle "${row.handle}"`);',
    to: '        lines.push(`next action: call await_tasks with handle "${row.handle}"`);',
  },
  {
    name: 'delegation metrics calls every settlement complete', file: TEAM,
    from: "    const completeDeliveries = settled.filter((entry) => entry.evidence?.completionState === 'complete').length;",
    to: '    const completeDeliveries = settled.length;',
  },
  {
    name: 'accepted partial delivery counter is disconnected', file: TEAM,
    from: "    const acceptedPartial = settled.filter((entry) =>\n      entry.evidence?.completionState === 'partial' && isAcceptanceDisposition(latest(entry)?.disposition)\n    ).length;",
    to: '    const acceptedPartial = 0;',
  },
  {
    name: 'Chat finalization ignores task.partial', file: EXTENSION,
    from: "        if (msg.type === 'task.complete' || msg.type === 'task.partial' || msg.type === 'system.error' || msg.type === 'ask.answer') {",
    to: "        if (msg.type === 'task.complete' || msg.type === 'system.error' || msg.type === 'ask.answer') {",
  },
  {
    name: 'human acceptance evidence disconnects the closeout projection', file: EXTENSION,
    from: '    runAcceptanceEvidence(run),',
    to: "    'Run is closed.',",
  },
  {
    name: 'acceptance picker disconnects the closeout projection', file: EXTENSION,
    from: '      description: acceptanceRunPickerDescription(candidate),',
    to: "      description: candidate.status,",
  },
  {
    name: 'Markdown export picker disconnects the closeout projection', file: EXTENSION,
    from: '      label: markdownRunExportPickerLabel(run, resolveAgentName(run.coordinatorId)),',
    to: "      label: `$(check) ${resolveAgentName(run.coordinatorId)} - closed`,",
  },
  {
    name: 'portable export picker disconnects the closeout projection', file: EXTENSION,
    from: '      label: portableRunExportPickerLabel(run, resolveAgentName(run.coordinatorId)),',
    to: "      label: `$(check) ${resolveAgentName(run.coordinatorId)} - closed`,",
  },
  {
    name: 'Markdown export confirmation disconnects the closeout projection', file: EXTENSION,
    from: '      void vscode.window.showInformationMessage(runEvidenceExportConfirmation(run));',
    to: "      void vscode.window.showInformationMessage('Exported complete run evidence pack.');",
  },
  {
    name: 'Team view hides partial completion', file: TEAM_VIEW,
    from: "    if (delegated?.completionState === 'partial' && isRecent(delegated.updatedAt, 120000)) {",
    to: "    if (false && delegated?.completionState === 'partial' && isRecent(delegated.updatedAt, 120000)) {",
  },
  {
    name: 'Dashboard hides partial completion', file: DASHBOARD,
    from: "  if (progress?.completionState === 'partial') {",
    to: "  if (false && progress?.completionState === 'partial') {",
  },
  {
    name: 'portable root closeout field is absent from the fail-closed schema', file: LEDGER,
    // The portable root schema is now derived from this field's portability policy.
    from: '  closeoutCompletionState: { portable: true, portableOrder: 6, summary: true },',
    to: "  closeoutCompletionState: { portable: false, reason: 'mutation probe', summary: true },",
  },
  {
    name: 'portable delegation completion field is absent from the fail-closed schema', file: PORTABLE,
    from: "    'handle', 'agent', 'role', 'dispatchedAt', 'state', 'completionState', 'cancelledAt', 'routeId', 'executionDomain',",
    to: "    'handle', 'agent', 'role', 'dispatchedAt', 'state', 'cancelledAt', 'routeId', 'executionDomain',",
  },
  {
    name: 'portable input receipt restores the old public read key', file: PORTABLE,
    from: "  inputReceipt: Object.freeze(['input', 'supplied', 'reachable', 'readReceipt']),",
    to: "  inputReceipt: Object.freeze(['input', 'supplied', 'reachable', 'read']),",
  },
  {
    name: 'portable schema version remains /2', file: PORTABLE,
    from: "export const PORTABLE_RUN_EVIDENCE_VERSION = 'portable-run-evidence/3' as const;",
    to: "export const PORTABLE_RUN_EVIDENCE_VERSION = 'portable-run-evidence/2' as const;",
  },
  {
    name: 'Markdown evidence renders partial closeout as CLOSED', file: PACK,
    from: "    `- Status: **${run.status === 'closed' && run.closeoutCompletionState === 'partial' ? 'PARTIAL' : run.status.toUpperCase()}**${run.endedAt ? ` (closed ${escapeText(run.endedAt)})` : ''}`,",
    to: "    `- Status: **${run.status.toUpperCase()}**${run.endedAt ? ` (closed ${escapeText(run.endedAt)})` : ''}`,",
  },
  {
    name: 'TeamTools invents Unreadable for a non-unreadable context gap', file: TEAM,
    from: "' Supply, re-scope, or escalate this declared input.'));",
    to: "' Unreadable. Supply, re-scope, or escalate this declared input.'));",
  },
  {
    name: 'Markdown evidence invents Unreadable for a non-unreadable context gap', file: PACK,
    from: "${gap.reason === 'unreadable' ? ' The host observed a read failure.' : ''}`);",
    to: "${gap.reason === 'unreadable' ? ' The host observed a read failure.' : ' Unreadable.'}`);",
  },
  {
    name: 'Chat invents Unreadable for every context gap', file: CHAT,
    from: "item.taskState?.kind === 'context-gap' ? 'Context gap · ' + item.taskState.reason",
    to: "item.taskState?.kind === 'context-gap' ? 'Unreadable context gap · ' + item.taskState.reason",
  },
  {
    name: 'Message log invents Unreadable for every context gap', file: MESSAGE_LOG,
    from: '    return `Context gap · ${item.taskState.reason}`;',
    to: '    return `Unreadable context gap · ${item.taskState.reason}`;',
  },
];

const ROOT = resolve('.');
const SANDBOX_ROOT = process.env.RUNNER_TEMP?.trim() || tmpdir();
const SANDBOX = join(SANDBOX_ROOT, `unodeai-v0973-mutation-${process.pid}`);
const EXCLUDED = new Set(['node_modules', '.git', 'dist', 'out', 'coverage', '.vscode-test', '.ovsx-pat']);
const excluded = (path) => EXCLUDED.has(basename(path)) || path.endsWith('.vsix');

function resolveNodeModules(start) {
  let directory = start;
  for (;;) {
    const candidate = join(directory, 'node_modules');
    if (existsSync(join(candidate, 'vitest'))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`could not find node_modules above ${start}`);
    directory = parent;
  }
}

console.log(`sandbox: ${SANDBOX}`);
cpSync(ROOT, SANDBOX, { recursive: true, filter: (path) => !excluded(path) });
symlinkSync(resolveNodeModules(ROOT), join(SANDBOX, 'node_modules'), 'junction');

const files = [...new Set(MUTATIONS.map((mutation) => mutation.file))];
const read = (file) => readFileSync(join(SANDBOX, file), 'utf8');
const originals = new Map(files.map((file) => [file, read(file)]));
const restore = () => originals.forEach((text, file) => writeFileSync(join(SANDBOX, file), text, 'utf8'));
const eolOf = (text) => text.includes('\r\n') ? '\r\n' : '\n';
const toEol = (snippet, text) => snippet.split('\n').join(eolOf(text));
let lastFailure;

function suitesPass() {
  try {
    const preserve = '--preserve-symlinks --preserve-symlinks-main';
    const NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preserve}`.trim();
    execSync(`npx vitest run ${SUITES.join(' ')}`, {
      cwd: SANDBOX, stdio: 'pipe', env: { ...process.env, NODE_OPTIONS },
    });
    lastFailure = undefined;
    return true;
  } catch (error) {
    lastFailure = error;
    return false;
  }
}

function cleanup() {
  try { rmdirSync(join(SANDBOX, 'node_modules')); } catch { /* already gone */ }
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* temp only */ }
}

try {
  if (!suitesPass()) {
    console.error('baseline failed in v0.9.73 mutation sandbox');
    console.error(String(lastFailure?.stdout ?? '').slice(-5000));
    process.exit(1);
  }
  console.log('✓ v0.9.73 baseline green\n');
  const survivors = [];
  for (const mutation of MUTATIONS) {
    const text = read(mutation.file);
    const from = toEol(mutation.from, text);
    const to = toEol(mutation.to, text);
    if (!text.includes(from)) {
      console.error(`✖ ANCHOR MISSING  ${mutation.name}`);
      survivors.push(mutation.name);
      continue;
    }
    writeFileSync(join(SANDBOX, mutation.file), text.replace(from, to), 'utf8');
    const survived = suitesPass();
    restore();
    console.log(`${survived ? '✖ SURVIVED' : '✓ killed  '}  ${mutation.name}`);
    if (survived) survivors.push(mutation.name);
  }
  if (survivors.length) {
    console.error(`\n✖ ${survivors.length} v0.9.73 mutant(s) survived:`);
    survivors.forEach((name) => console.error(`  - ${name}`));
    process.exit(1);
  }
  console.log(`\n✓ every v0.9.73 mutant killed (${MUTATIONS.length}/${MUTATIONS.length})`);
} finally {
  cleanup();
}
