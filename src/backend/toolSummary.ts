export interface ToolActivitySummary {
  title: string;
  summary: string;
  category: 'read' | 'list' | 'edit' | 'run' | 'mcp' | 'tool';
}

export type ToolFailureKind = 'blocked' | 'not_found' | 'error';

export type HostToolRefusalReason =
  | 'capability'
  | 'scope'
  | 'task-scope'
  | 'workspace-escape'
  | 'asset-unavailable'
  | 'trust'
  | 'consent';

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
  | { source: 'host'; contentSource: 'host' | 'mixed-external'; status: 'success'; output: string; exitCode?: number }
  | {
    source: 'host'; contentSource: 'host' | 'mixed-external'; status: 'refused'; output: string; reason: HostToolRefusalReason;
    /** Optional, reviewed host-authored prose appended after the bounded generic refusal. */
    detail?: HostToolRefusalDetail;
  }
  | { source: 'host'; contentSource: 'host' | 'mixed-external'; status: 'failed'; output: string; failureKind: Exclude<ToolFailureKind, 'blocked'>; exitCode?: number };

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
): HostToolOutcome {
  return detail === undefined
    ? { source: 'host', contentSource: 'host', status: 'refused', output, reason }
    : { source: 'host', contentSource: 'host', status: 'refused', output, reason, detail };
}

export function hostToolFailed(
  output: string,
  options: {
    failureKind?: Exclude<ToolFailureKind, 'blocked'>;
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

export interface ToolResultSummary extends ToolActivitySummary {
  ok: boolean;
  detail?: string;
  failureKind?: ToolFailureKind;
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
  const ok = result.source === 'host'
    ? result.status === 'success'
    : result.transportStatus === 'success';
  const failureKind = result.source === 'host'
    ? result.status === 'refused'
      ? 'blocked'
      : result.status === 'failed'
        ? result.failureKind
        : undefined
    : result.transportStatus === 'failed'
      ? 'error'
      : undefined;
  return {
    ...base,
    ok,
    summary: resultSummary(name, input, output, ok),
    detail: capDetail(output),
    failureKind,
  };
}

export function classifyToolFailure(output: string): ToolFailureKind {
  const text = String(output ?? '').trim();
  if (/\b(not found|does not exist|nothing to delete|No existing parent directory)\b/i.test(text)) {
    return 'not_found';
  }
  if (
    /^(BLOCKED_OUTSIDE_WORKDIR|Command blocked:|Verification command blocked|Write blocked:|Delete blocked:|\[Plan mode\])/.test(text) ||
    /outside (your|every) (working|writable|allowed)|workspace is not trusted|not approved by the user|user denied|\bnot permitted\b|disabled because this agent has no writable folders/i.test(text)
  ) {
    return 'blocked';
  }
  return 'error';
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
