/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Todos  (C3: real-time Todo list)
 *  The agent decomposes multi-step work into a live checklist by calling the `update_todos` tool.
 *  Each call REPLACES the current list (it's a snapshot of the plan, not an append log). The chat
 *  view renders the latest snapshot as a pinned checklist so you can watch the plan progress.
 *
 *  Pure / dependency-free so both the tool layer (WorkspaceTools) and the view layer (ChatViewProvider)
 *  parse the same way, and it's unit-testable without vscode.
 *--------------------------------------------------------------------------------------------*/

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** Cap so a runaway model can't flood the checklist (and the UI stays skimmable). */
const MAX_TODOS = 50;
const VALID: ReadonlySet<string> = new Set<TodoStatus>(['pending', 'in_progress', 'completed']);

/** Coerce a value to an array: pass arrays through; JSON-parse a string (e.g. a leaked tool call's
 *  `todos` arrives as the raw JSON text, not a parsed array); anything else → []. Never throws. */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Defensively parse the `update_todos` tool input into a clean TodoItem[].
 * Accepts the raw array, a `{ todos: [...] }` wrapper, OR a JSON string of either (a tool call
 * recovered from leaked text delivers `todos` as a string, not a parsed array). Items without a
 * non-empty `content` are dropped; an unrecognized `status` falls back to 'pending'. Never throws.
 */
export function parseTodos(input: unknown): TodoItem[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? toArray(input)
      : input && typeof input === 'object'
        ? toArray((input as { todos?: unknown }).todos)
        : [];
  const out: TodoItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const content = typeof (item as { content?: unknown }).content === 'string'
      ? (item as { content: string }).content.trim()
      : '';
    if (!content) {
      continue;
    }
    const s = (item as { status?: unknown }).status;
    const status: TodoStatus = typeof s === 'string' && VALID.has(s) ? (s as TodoStatus) : 'pending';
    out.push({ content, status });
    if (out.length >= MAX_TODOS) {
      break;
    }
  }
  return out;
}

/** "2/5 done" — compact progress label for tool confirmations and the checklist header. */
export function todoSummary(todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === 'completed').length;
  return `${done}/${todos.length} done`;
}
