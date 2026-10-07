export interface ToolActivitySummary {
  title: string;
  summary: string;
  category: 'read' | 'list' | 'edit' | 'run' | 'mcp' | 'tool';
}

/** Why a tool failed, when it ran or was attempted. A refusal is not a failure and never has one of these. */
export type CanonicalToolFailureKind = 'not_found' | 'error' | 'integration_error' | 'cancelled' | 'outcome_unknown';

/** The display vocabulary of a tool card: a refusal is shown as `blocked`. Never a fact on its own. */
export type ToolFailureKind = 'blocked' | CanonicalToolFailureKind;

export type HostToolRefusalReason =
  | 'capability'
  | 'scope'
  | 'task-scope'
  | 'workspace-escape'
  | 'asset-unavailable'
  | 'trust'
  | 'consent'
  | 'shell-compatibility'
  | 'execution-hook'
  | 'safety-limit';

/** Every refusal reason and failure kind, so a stored value is checked against the whole vocabulary and no more. */
export const HOST_TOOL_REFUSAL_REASONS = Object.keys({
  capability: true,
  scope: true,
  'task-scope': true,
  'workspace-escape': true,
  'asset-unavailable': true,
  trust: true,
  consent: true,
  'shell-compatibility': true,
  'execution-hook': true,
  'safety-limit': true,
} satisfies Record<HostToolRefusalReason, true>) as readonly HostToolRefusalReason[];
export const CANONICAL_TOOL_FAILURE_KINDS = Object.keys({
  not_found: true,
  error: true,
  integration_error: true,
  cancelled: true,
  outcome_unknown: true,
} satisfies Record<CanonicalToolFailureKind, true>) as readonly CanonicalToolFailureKind[];

/**
 * The decision a tool result carries, shared by a host-authored result and a backend tool-result event. Each status
 * admits only its own field, so success with a failure kind, or a refusal without a reason, cannot be written.
 */
type ToolDecision =
  | { status: 'success'; reason?: never; failureKind?: never }
  | { status: 'refused'; reason: HostToolRefusalReason; failureKind?: never }
  | { status: 'failed'; failureKind: CanonicalToolFailureKind; reason?: never };

/** Who observed a tool result: the host at its own tool boundary, or only the provider's protocol. */
export type ToolResultObserver = 'host' | 'provider-protocol';

/**
 * v0.9.91: the provider-neutral fact of one tool result. Only the host refuses; a provider protocol that reports
 * a bare success/failure Boolean is recorded as that, never refined from its wording.
 */
export type ToolResultFact =
  | (Extract<ToolDecision, { status: 'success' }> & { observedBy: ToolResultObserver })
  | (Extract<ToolDecision, { status: 'refused' }> & { observedBy: 'host' })
  | (Extract<ToolDecision, { status: 'failed' }> & { observedBy: ToolResultObserver });

declare const hostToolRefusalDetailBrand: unique symbol;

/**
 * Extra model-facing refusal prose is deliberately opt-in. Callers must create it with
 * `hostToolRefusalDetail`; the static gate permits only a substitution-free literal there.
 */
export type HostToolRefusalDetail = string & { readonly [hostToolRefusalDetailBrand]: true };

export function hostToolRefusalDetail(detail: string): HostToolRefusalDetail {
  return detail as HostToolRefusalDetail;
}

/**
 * A host-authored tool result carries the decision the host made at the point of execution.
 * Tool summaries consume this fact; they never recover it from the wording of `output`.
 */
export type HostToolOutcome =
  | (Extract<ToolDecision, { status: 'success' }> & HostToolPayload & {
    exitCode?: number;
    /**
     * v0.9.89 F7-21: host-only token for a background command's observed progress. It changes only when the
     * host sees new output, a state change, an exit code or an error. Never advertised or read from model args.
     */
    progressToken?: string;
  })
  | (Extract<ToolDecision, { status: 'refused' }> & HostToolPayload & {
    /** Optional, reviewed host-authored prose appended after the bounded generic refusal. */
    detail?: HostToolRefusalDetail;
  })
  | (Extract<ToolDecision, { status: 'failed' }> & HostToolPayload & { exitCode?: number; progressToken?: string });

interface HostToolPayload {
  source: 'host';
  contentSource: 'host' | 'mixed-external';
  output: string;
}

/** Text produced outside the host is deliberately marked and judged only by its transport result. */
export interface ExternalToolOutcome {
  source: 'external';
  transportStatus: 'success' | 'failed';
  output: string;
}

export type ToolOutcome = HostToolOutcome | ExternalToolOutcome;

export function hostToolSucceeded(
  output: string,
  options: { exitCode?: number; contentSource?: 'host' | 'mixed-external' } = {},
): HostToolOutcome {
  const base = { source: 'host' as const, contentSource: options.contentSource ?? 'host', status: 'success' as const, output };
  return options.exitCode === undefined ? base : { ...base, exitCode: options.exitCode };
}

export function hostToolRefused(
  output: string,
  reason: HostToolRefusalReason,
  detail?: HostToolRefusalDetail,
  options: { contentSource?: 'host' | 'mixed-external' } = {},
): HostToolOutcome {
  const contentSource = options.contentSource ?? 'host';
  return detail === undefined
    ? { source: 'host', contentSource, status: 'refused', output, reason }
    : { source: 'host', contentSource, status: 'refused', output, reason, detail };
}

export function hostToolFailed(
  output: string,
  options: {
    failureKind?: CanonicalToolFailureKind;
    exitCode?: number;
    contentSource?: 'host' | 'mixed-external';
  } = {},
): HostToolOutcome {
  const base = {
    source: 'host' as const,
    contentSource: options.contentSource ?? 'host',
    status: 'failed' as const,
    output,
    failureKind: options.failureKind ?? 'error',
  };
  return options.exitCode === undefined ? base : { ...base, exitCode: options.exitCode };
}

export function externalToolOutcome(output: string, transportStatus: 'success' | 'failed' = 'success'): ExternalToolOutcome {
  return { source: 'external', transportStatus, output };
}

/**
 * The fact a host-side result carries. A host outcome keeps its own decision. An external embedder's outcome has
 * no refusal taxonomy, so only its transport status is recorded; its text is never read.
 */
export function toolOutcomeFact(outcome: ToolOutcome): ToolResultFact {
  if (outcome.source === 'external') {
    return outcome.transportStatus === 'success'
      ? { status: 'success', observedBy: 'host' }
      : { status: 'failed', observedBy: 'host', failureKind: 'error' };
  }
  switch (outcome.status) {
    case 'success': return { status: 'success', observedBy: 'host' };
    case 'refused': return { status: 'refused', observedBy: 'host', reason: outcome.reason };
    case 'failed': return { status: 'failed', observedBy: 'host', failureKind: outcome.failureKind };
    default: return unhandledToolStatus(outcome);
  }
}

/** A native tool the provider ran and reported only as succeeded. */
export function providerToolSucceeded(): ToolResultFact {
  return { status: 'success', observedBy: 'provider-protocol' };
}

/** A native tool the provider ran and reported as failed. Without a typed provider cause the kind is `error`. */
export function providerToolFailed(failureKind: CanonicalToolFailureKind = 'error'): ToolResultFact {
  return { status: 'failed', observedBy: 'provider-protocol', failureKind };
}

/** Presentation only: whether a tool card reads as succeeded. */
export function toolFactSucceeded(fact: ToolResultFact): boolean {
  switch (fact.status) {
    case 'success': return true;
    case 'refused':
    case 'failed': return false;
    default: return unhandledToolStatus(fact);
  }
}

/** Presentation only: the card's failure label, where a refusal keeps its old `blocked` look. */
export function toolFactDisplayKind(fact: ToolResultFact): ToolFailureKind | undefined {
  switch (fact.status) {
    case 'success': return undefined;
    case 'refused': return 'blocked';
    case 'failed': return fact.failureKind;
    default: return unhandledToolStatus(fact);
  }
}

/**
 * A stored or transported fact, rebuilt field by field; undefined unless it is exactly one valid fact. A field that
 * belongs to another status (a failure kind on a success, a reason on a failure) makes the whole fact invalid: it is
 * never dropped to leave a fact the record did not state.
 */
export function parseToolResultFact(raw: unknown): ToolResultFact | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as { status?: unknown; observedBy?: unknown; reason?: unknown; failureKind?: unknown };
  const observedBy = value.observedBy === 'host' || value.observedBy === 'provider-protocol' ? value.observedBy : undefined;
  if (!observedBy) return undefined;
  if (value.status === 'success') {
    return value.reason === undefined && value.failureKind === undefined ? { status: 'success', observedBy } : undefined;
  }
  if (value.status === 'refused') {
    return observedBy === 'host' && value.failureKind === undefined
      && (HOST_TOOL_REFUSAL_REASONS as readonly unknown[]).includes(value.reason)
      ? { status: 'refused', observedBy, reason: value.reason as HostToolRefusalReason }
      : undefined;
  }
  if (value.status === 'failed') {
    return value.reason === undefined && (CANONICAL_TOOL_FAILURE_KINDS as readonly unknown[]).includes(value.failureKind)
      ? { status: 'failed', observedBy, failureKind: value.failureKind as CanonicalToolFailureKind }
      : undefined;
  }
  return undefined;
}

function unhandledToolStatus(value: never): never {
  throw new Error(`Unhandled tool result status: ${JSON.stringify(value)}`);
}

export interface ToolResultSummary extends ToolActivitySummary {
  /** Presentation projections of `fact`. */
  ok: boolean;
  detail?: string;
  failureKind?: ToolFailureKind;
  fact: ToolResultFact;
}

const DETAIL_LIMIT = 4000;

export function summarizeToolUse(name: string, input: unknown): ToolActivitySummary {
  const args = asRecord(input);
  const category = toolCategory(name);
  // Delegation reads more clearly as "waiting on a teammate" than as a generic tool call. The card
  // stays in the "Running" state while the teammate works, so it doubles as a live "waiting" badge —
  // the user can open that teammate's own chat to watch the detailed work.
  if (name === 'assign_task') {
    const who = String(args.agent ?? 'a teammate');
    return { category, title: `Waiting on ${who}`, summary: `Delegated to ${who} — open their chat to watch their work.` };
  }
  if (name === 'assign_task_async') {
    const who = String(args.agent ?? 'a teammate');
    return { category, title: `Dispatched to ${who}`, summary: `${who} is working in parallel — open their chat to watch.` };
  }
  if (name === 'await_tasks') {
    return { category, title: 'Awaiting teammates', summary: 'Waiting for dispatched tasks to finish…' };
  }
  const target = toolTarget(name, args);
  return {
    category,
    title: `${verbForCategory(category)}${target ? ` ${target}` : ` ${name}`}`,
    summary: target ? `${name} ${target}` : name,
  };
}

export function summarizeToolResult(name: string, input: unknown, result: ToolOutcome): ToolResultSummary {
  const base = summarizeToolUse(name, input);
  const output = result.output;
  const fact = toolOutcomeFact(result);
  const ok = toolFactSucceeded(fact);
  return {
    ...base,
    ok,
    summary: resultSummary(name, input, output, ok),
    detail: capDetail(output),
    failureKind: toolFactDisplayKind(fact),
    fact,
  };
}

export function capDetail(output: string, limit = DETAIL_LIMIT): string {
  const text = String(output);
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n[detail truncated ${text.length - limit} chars]`;
}

export function toolCategory(name: string): ToolActivitySummary['category'] {
  if (name === 'read_file') {
    return 'read';
  }
  if (name === 'list_dir' || name === 'list_agents') {
    return 'list';
  }
  if (name === 'write_file' || name === 'apply_edit' || name === 'apply_patch' || name === 'delete_file' || name === 'delete_dir') {
    return 'edit';
  }
  if (name === 'run_command' || name === 'run_checks') {
    return 'run';
  }
  if (name.includes('__')) {
    return 'mcp';
  }
  return 'tool';
}

function resultSummary(name: string, input: unknown, output: string, ok: boolean): string {
  if (!ok) {
    return capOneLine(output.trim(), 140);
  }
  const args = asRecord(input);
  if (name === 'read_file') {
    const filePath = String(args.path ?? '');
    const kind = /\.(?:md|markdown)$/i.test(filePath) ? 'Markdown content receipt' : 'File content receipt';
    const truncated = output.length > DETAIL_LIMIT
      ? `; preview truncated by ${output.length - DETAIL_LIMIT} chars`
      : '; full preview';
    return `${kind} — ${filePath} (${formatBytes(output)}${truncated})`;
  }
  if (name === 'list_dir') {
    const count = output.trim() && output.trim() !== '(empty)' ? output.trim().split(/\r?\n/).length : 0;
    return `list_dir ${String(args.path ?? '.')} (${count} entries)`;
  }
  if (name === 'write_file') {
    return capOneLine(output.trim(), 140);
  }
  if (name === 'apply_edit' || name === 'apply_patch') {
    return `apply_edit ${String(args.path ?? '')}`;
  }
  if (name === 'delete_file' || name === 'delete_dir') {
    return capOneLine(output.trim(), 140);
  }
  if (name === 'run_command') {
    return `run_command ${String(args.command ?? '')}`;
  }
  if (name === 'run_checks') {
    return output.startsWith('[checks passed]') ? 'run_checks passed' : 'run_checks completed';
  }
  if (name === 'assign_task' || name === 'assign_task_async') {
    return `${String(args.agent ?? 'teammate')} finished`;
  }
  if (name === 'await_tasks') {
    return 'Delegated tasks finished';
  }
  return capOneLine(`${name} completed`, 140);
}

function toolTarget(name: string, args: Record<string, unknown>): string {
  if (name === 'read_file' || name === 'list_dir' || name === 'write_file' || name === 'apply_edit' || name === 'apply_patch' || name === 'delete_file' || name === 'delete_dir') {
    return String(args.path ?? '');
  }
  if (name === 'run_command') {
    return String(args.command ?? '');
  }
  if (name === 'assign_task') {
    return String(args.agent ?? '');
  }
  return '';
}

function verbForCategory(category: ToolActivitySummary['category']): string {
  switch (category) {
    case 'read': return 'Read';
    case 'list': return 'List';
    case 'edit': return 'Edit';
    case 'run': return 'Run';
    case 'mcp': return 'MCP';
    case 'tool': return 'Tool';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function formatBytes(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function capOneLine(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit)}...`;
}
