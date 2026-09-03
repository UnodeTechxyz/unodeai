/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Agent Execution Engine: post-write diagnostics (v0.5.2)
 *
 *  The deterministic "write → feedback" hook. After an agent writes a file, the framework collects
 *  the editor's own diagnostics (VS Code language servers: TS, ESLint, …) for that file and feeds the
 *  relevant errors straight back into the agent's next turn — so it sees the red line it just created
 *  without having to remember to run a checker. This is the single highest-ROI, VS-Code-unique lever
 *  for closing the execution-quality gap with Cline (BACKLOG #3).
 *
 *  vscode-free by design: the collector is injected (the real implementation lives in extension.ts;
 *  tests inject a fake). The implementation is responsible for letting language servers settle before
 *  reading.
 *--------------------------------------------------------------------------------------------*/

import type { CompletionGateConfig } from './completionGate';
import type { WebAccessPolicyGate } from './WebAccessPolicy';
import type { ContentReceiptObservation } from '../content/ContentReceipt';
import type { ContentAssetStore } from '../content/ContentAssetStore';
import type { ExecutionHooksSource } from './ExecutionHooks';
import type { TaskInputResolver } from './TaskContract';

export interface FileDiagnostic {
  /** Path as the agent referenced it (workspace-relative is fine — echoed back verbatim). */
  path: string;
  /** 1-based line number. */
  line: number;
  severity: 'error' | 'warning';
  message: string;
  /** Diagnostic source, e.g. 'ts', 'eslint'. */
  source?: string;
}

/**
 * Collect diagnostics for the given paths (the files written this step). Injected; the impl settles
 * language servers before reading. Returning `[]` means "clean" (which the engine treats as verified).
 */
export type DiagnosticsCollector = (paths: string[]) => Promise<FileDiagnostic[]>;

/** Engine knobs threaded into the backend (each gated by a `unode.engine.*` kill-switch upstream). */
export interface EngineOptions {
  /** Post-write diagnostics injection. Omitted/undefined = disabled. */
  diagnostics?: DiagnosticsCollector;
  /** Verification obligation: nudge once if a turn wrote files without verifying. Default false. */
  verifyObligation?: boolean;
  /** Coordinator completion gate: run objective project checks before a PM can report done. */
  completionGate?: {
    command: string;
    run: () => Promise<{ ok: boolean; output?: string; blocked?: boolean }>;
    cfg: CompletionGateConfig;
  };
  /** Effective project verification command. A worker's direct run_command only counts as objective
   * verification when it exactly runs this host-resolved command. */
  verificationCommand?: string;
  /** Called when a tool path is rejected for being outside the workspace root (G-003c), so the host can
   *  offer to move the agent's working folder there. Receives the attempted absolute path. */
  onOutsideRoot?: (attemptedPath: string) => void;
  /** Worktree fan-out: a READ-ONLY overlay root (the `unode/integration` worktree) the agent can read
   *  the team's merged work from when a file isn't in its own isolated worktree. Writes always stay in
   *  the agent's own root. Undefined = no overlay (normal single-tree behavior). */
  sharedReadRoot?: string;
  /** Additional READ-ONLY roots (workspace folders / trusted configured roots). read_file/list_dir/search_files
   *  may read them; writes/edits/deletes stay in the primary working root. */
  additionalReadRoots?: string[];
  /** Writable roots for file writes and shell commands. Undefined preserves the primary working root. */
  writeRoots?: string[];
  /** VS Code Workspace Trust check (live). When it returns false, file writes/edits/deletes are refused —
   *  an untrusted workspace runs the agent read-only. Undefined = always trusted (tests/back-compat). */
  isTrusted?: () => boolean;
  /** Shared public-web policy and crew/session approval surface for OpenAI-compatible `fetch_url`. */
  webAccess?: WebAccessPolicyGate;
  /** Bounded rich-content receipt observer. No URL, query, path, bytes or extracted text crosses this port. */
  onContentReceipt?: (receipt: ContentReceiptObservation) => void;
  /** Extension-owned, expiring source store shared across in-process delegates for this session. */
  delegationContentAssets?: ContentAssetStore;
  /** Attempt-bound contract input authority shared with coordinator routing. */
  taskInputResolver?: TaskInputResolver;
  /** Human-applied, host-owned restrictive hooks. Repository and agent surfaces cannot populate this. */
  executionHooks?: ExecutionHooksSource;
}

const MAX_DIAG_LINES = 20;
const MAX_DIAG_CHARS = 6000; // ≈1500 tokens — a hard cap so a noisy file can't flood the context.

/**
 * Render diagnostics as a compact block to append to the triggering write's tool result. Returns an
 * empty string when there are no errors/warnings (the caller treats empty as "clean → verified").
 * Errors are prioritized; warnings only shown when there are no errors.
 */
export function formatPostWriteDiagnostics(diags: FileDiagnostic[]): string {
  const errors = diags.filter((d) => d.severity === 'error');
  const pool = errors.length > 0 ? errors : diags.filter((d) => d.severity === 'warning');
  if (pool.length === 0) {
    return '';
  }
  const shown = pool.slice(0, MAX_DIAG_LINES);
  let body = shown
    .map((d) => `- ${d.path}:${d.line} ${d.severity}${d.source ? ` (${d.source})` : ''}: ${d.message}`)
    .join('\n');
  if (body.length > MAX_DIAG_CHARS) {
    body = `${body.slice(0, MAX_DIAG_CHARS)}\n… (truncated)`;
  }
  const more = pool.length - shown.length;
  const tail = more > 0 ? `\n… and ${more} more` : '';
  const headline =
    errors.length > 0
      ? `${errors.length} error(s) — fix them before finishing this task`
      : `${pool.length} warning(s)`;
  return `\n\n[post-write diagnostics] the file you just wrote has ${headline}:\n${body}${tail}`;
}

/** True when a post-write diagnostics result contains at least one error (→ the write is "unverified"). */
export function hasErrors(diags: FileDiagnostic[]): boolean {
  return diags.some((d) => d.severity === 'error');
}
