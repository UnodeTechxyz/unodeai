/*---------------------------------------------------------------------------------------------
 *  UnodeAi - TerminalManager  (#13 Cline-class command execution, Phase 2)
 *  Owns one VS Code integrated terminal per agent and hands out a CommandExecutor bound to it.
 *  Running through a real terminal (Shell Integration API = a PTY) lets agents run TTY-needing tools
 *  (e.g. vitest) that raw `child_process.spawn` can't, and the user SEES the command run.
 *
 *  Centralized (vs the Phase-1 closure) so the extension can reveal an agent's terminal on demand and
 *  dispose it on agent removal / deactivate. Falls back to the injected spawn executor where shell
 *  integration is unavailable (older VS Code / a shell without integration, e.g. plain cmd.exe).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CommandExecResult, CommandExecutor, defaultSpawnExecutor } from '../backend/WorkspaceTools';

/** How long to wait for a freshly-created terminal's shell integration to activate before falling back. */
const SHELL_INTEGRATION_TIMEOUT_MS = 5000;
/** Soft cap while streaming (the tool layer caps again at 16 KB); just bounds memory. */
const MAX_STREAM_OUTPUT = 200_000;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

export class TerminalManager {
  private terminals = new Map<string, vscode.Terminal>();
  private unsupported = false; // once we learn shell integration is unavailable, just spawn
  // Shell integration sometimes reports a command finished but streams no output back (notably
  // PowerShell on Windows). Once we see that, route subsequent commands through the reliable spawn
  // executor so the agent isn't left flying blind (G-004).
  private captureUnreliable = false;

  constructor(private fallback: CommandExecutor = defaultSpawnExecutor) {}

  /** A CommandExecutor that runs `agentId`'s commands in its own visible terminal (PTY). */
  executorFor(agentId: string, name: string): CommandExecutor {
    return (command, opts) => this.run(agentId, name, command, opts);
  }

  /**
   * Reveal an agent's terminal. If it hasn't run a command yet (e.g. a PM that only delegates),
   * create a dedicated empty terminal on demand so every agent has its own visible thread.
   */
  reveal(agentId: string, name?: string, cwd?: string): void {
    let term = this.terminals.get(agentId);
    if (term && term.exitStatus !== undefined) { this.terminals.delete(agentId); term = undefined; } // died → recreate
    if (!term && name && !this.unsupported) {
      term = vscode.window.createTerminal({ name, cwd, isTransient: true });
      this.terminals.set(agentId, term);
    }
    term?.show();
  }

  /** Dispose an agent's terminal (call when the agent is removed). */
  dispose(agentId: string): void {
    this.terminals.get(agentId)?.dispose();
    this.terminals.delete(agentId);
  }

  /** Dispose every managed terminal (extension deactivate). */
  disposeAll(): void {
    for (const t of this.terminals.values()) { t.dispose(); }
    this.terminals.clear();
  }

  private async ensureShellIntegration(agentId: string, name: string, cwd: string): Promise<vscode.TerminalShellIntegration | undefined> {
    if (this.unsupported) { return undefined; }
    let term = this.terminals.get(agentId);
    if (term && term.exitStatus !== undefined) { this.terminals.delete(agentId); term = undefined; } // died → recreate
    if (!term) {
      term = vscode.window.createTerminal({ name, cwd, isTransient: true });
      this.terminals.set(agentId, term);
    }
    if (term.shellIntegration) { return term.shellIntegration; }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { sub.dispose(); resolve(this.terminals.get(agentId)?.shellIntegration); }, SHELL_INTEGRATION_TIMEOUT_MS);
      const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === this.terminals.get(agentId)) { clearTimeout(timer); sub.dispose(); resolve(e.shellIntegration); }
      });
    });
  }

  private async run(agentId: string, name: string, command: string, opts: { cwd: string; timeoutMs: number }): Promise<CommandExecResult> {
    const { cwd, timeoutMs } = opts;
    // If we've already learned that terminal capture is unreliable here, use the spawn executor so the
    // agent reliably gets stdout/stderr (it still won't see a terminal, but it won't be blind).
    if (this.captureUnreliable) {
      return this.fallback(command, { cwd, timeoutMs });
    }
    let si: vscode.TerminalShellIntegration | undefined;
    try {
      si = await this.ensureShellIntegration(agentId, name, cwd);
    } catch {
      si = undefined;
    }
    if (!si) {
      this.unsupported = true;
      return this.fallback(command, { cwd, timeoutMs });
    }

    // Reveal so the user sees the command run (preserveFocus: don't steal the editor's focus).
    try { this.terminals.get(agentId)?.show(true); } catch { /* ignore */ }

    let exec: vscode.TerminalShellExecution;
    try {
      exec = si.executeCommand(command);
    } catch {
      return this.fallback(command, { cwd, timeoutMs });
    }

    let out = '';
    const endPromise = new Promise<number | undefined>((resolve) => {
      const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === exec) { sub.dispose(); resolve(e.exitCode); }
      });
    });
    const readPromise = (async () => {
      try {
        for await (const chunk of exec.read()) {
          out += chunk;
          if (out.length > MAX_STREAM_OUTPUT) { out = out.slice(0, MAX_STREAM_OUTPUT); }
        }
      } catch { /* stream ended/errored — exit code still resolves */ }
    })();

    let timedOut = false;
    let timerHandle: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<void>((resolve) => { timerHandle = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); });
    await Promise.race([Promise.all([endPromise, readPromise]), timer]);
    if (timerHandle) { clearTimeout(timerHandle); }

    if (timedOut) {
      try { this.terminals.get(agentId)?.sendText(''); } catch { /* best-effort interrupt (Ctrl-C) */ }
      return { code: null, output: stripAnsi(out), timedOut: true };
    }
    const code = await endPromise;
    const cleaned = stripAnsi(out);
    if (cleaned.trim().length === 0) {
      // The command finished but no output came back through shell integration. Don't re-run it (it may
      // have side effects); instead return an explicit note (so the agent knows it ran + its exit code,
      // not a blank) and route future commands through the reliable spawn executor (G-004).
      this.captureUnreliable = true;
      return {
        code: code ?? null,
        output: `[exit ${code ?? 0}] (the integrated terminal returned no captured output; if you need this command's output, run it again — it will now use a direct runner)`,
      };
    }
    return { code: code ?? null, output: cleaned };
  }
}
