/*---------------------------------------------------------------------------------------------
 *  UnodeAi - explicitly approved executable Skill actions
 *
 *  Skills never contribute executable bytes. A validated extension-bundled manifest selects a handler
 *  compiled into the fixed VSIX runner, and the host obtains a digest-bound run-once approval before it
 *  launches that runner with structured JSON on stdin.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolSpec } from '../backend/WorkspaceTools';
import { hostToolFailed, hostToolRefused, hostToolSucceeded, type HostToolOutcome } from '../backend/toolSummary';
import { killProcessTree } from '../backend/processTree';
import { SkillRegistry } from './SkillRegistry';

export const RUN_SKILL_ACTION_TOOL = 'run_skill_action';
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ExecutableSkillApprovalRequest {
  agentName: string;
  skillName: string;
  actionId: string;
  actionDescription: string;
  handler: string;
  digest: string;
  declaredEffects: readonly string[];
  warning: string;
  timeoutMs: number;
}

export interface ExecutableSkillHostOptions {
  registry: SkillRegistry;
  grantedNames: readonly string[] | undefined;
  agentName: string;
  workspaceRoot: string;
  /** Absolute path to the fixed, extension-owned runner shipped inside the VSIX. */
  runnerPath: string;
  isTrusted: () => boolean;
  requestApproval?: (request: ExecutableSkillApprovalRequest) => Promise<{ allow: boolean; note?: string }>;
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
  /** Test seam. Production requests one best-effort tree kill while the original child is still owned. */
  terminate?: (process: ChildProcessWithoutNullStreams) => void;
}

export class ExecutableSkillHost {
  constructor(private readonly options: ExecutableSkillHostOptions) {}

  toolSpec(): ToolSpec | undefined {
    const actions = this.options.registry.grantedDocuments(this.options.grantedNames)
      .flatMap((document) => document.actions.map((action) => ({ skill: document.name, action })));
    if (actions.length === 0) return undefined;
    return {
      type: 'function',
      returnsExternalContent: true,
      function: {
        name: RUN_SKILL_ACTION_TOOL,
        description: 'Run one extension-bundled Skill action through the fixed UnodeAi runner. Requires Workspace Trust and a new exact-digest user approval for every invocation.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: [...new Set(actions.map((item) => item.skill))], description: 'Authorized Skill name.' },
            action: { type: 'string', description: 'Declared action id shown in the loaded Skill.' },
            input: { type: 'object', description: 'Structured JSON input sent to the compiled action handler.' },
          },
          required: ['name', 'action', 'input'],
          additionalProperties: false,
        },
      },
    };
  }

  async run(args: Record<string, unknown>): Promise<HostToolOutcome> {
    const skillName = typeof args.name === 'string' ? args.name : '';
    const actionId = typeof args.action === 'string' ? args.action : '';
    const input = args.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return hostToolFailed('Error: executable Skill input must be a JSON object.');
    }
    const encodedInput = JSON.stringify(input);
    if (Buffer.byteLength(encodedInput, 'utf8') > MAX_INPUT_BYTES) {
      return hostToolRefused('Error: executable Skill input exceeds the 64 KiB host limit.', 'scope');
    }
    if (!this.options.isTrusted()) {
      return hostToolRefused('Error: executable Skills require a trusted workspace.', 'trust');
    }

    let resolved;
    try {
      resolved = this.options.registry.authorizedAction(skillName, actionId, this.options.grantedNames);
    } catch (error) {
      return hostToolRefused(`Error: executable Skill validation failed: ${message(error)}`, 'scope');
    }
    if (!resolved) {
      return hostToolRefused(`Error: executable Skill action "${skillName}/${actionId}" is not authorized for this agent.`, 'capability');
    }
    if (!this.options.requestApproval) {
      return hostToolRefused('Error: no interactive approval surface is available for executable Skills.', 'consent');
    }

    const timeoutMs = Math.max(1_000, Math.min(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));
    const warning = 'This extension-bundled handler is local code, not a sandboxed instruction. If allowed, it runs once with your user authority and may perform its listed effects. UnodeAi declarations are disclosure, not OS enforcement.';
    const decision = await this.options.requestApproval({
      agentName: this.options.agentName,
      skillName,
      actionId,
      actionDescription: resolved.action.description,
      handler: resolved.action.handler,
      digest: resolved.document.digest,
      declaredEffects: resolved.action.declaredEffects,
      warning,
      timeoutMs,
    });
    if (!decision.allow) {
      return hostToolRefused(`Error: executable Skill action was not approved.${decision.note ? ` ${decision.note}` : ''}`, 'consent');
    }
    if (!this.options.isTrusted()) {
      return hostToolRefused('Error: workspace trust was revoked before the executable Skill could run.', 'trust');
    }

    try {
      let current;
      try {
        current = this.options.registry.authorizedAction(skillName, actionId, this.options.grantedNames);
      } catch {
        return hostToolRefused('Error: executable Skill content changed after approval; request a new run.', 'consent');
      }
      if (!current || current.document.digest !== resolved.document.digest || current.action.handler !== resolved.action.handler) {
        return hostToolRefused('Error: executable Skill content changed after approval; request a new run.', 'consent');
      }
      const runnerPath = fixedRunnerPath(this.options.runnerPath);
      return await this.executeHandler(
        runnerPath,
        current.action.handler,
        encodedInput,
        current.document.digest,
        skillName,
        actionId,
        timeoutMs,
      );
    } catch (error) {
      return hostToolFailed(`Executable Skill failed before launch: ${message(error)}`);
    }
  }

  private async executeHandler(
    runnerPath: string,
    handler: string,
    input: string,
    digest: string,
    skillName: string,
    actionId: string,
    timeoutMs: number,
  ): Promise<HostToolOutcome> {
    const spawn = this.options.spawn ?? nodeSpawn;
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(process.execPath, [runnerPath, handler], {
        cwd: this.options.workspaceRoot,
        env: minimalEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return hostToolFailed(`Executable Skill could not start: ${message(error)}`);
    }

    const result = await collectProcess(proc, input, timeoutMs, this.options.terminate);
    const receipt = [
      '[UnodeAi executable Skill receipt]',
      `skill=${skillName}`,
      `action=${actionId}`,
      `handler=${handler}`,
      `digest=sha256:${digest}`,
      `exitCode=${result.exitCode === null ? 'none' : result.exitCode}`,
      `timedOut=${result.timedOut}`,
      `stdoutTruncated=${result.stdoutTruncated}`,
      `stderrTruncated=${result.stderrTruncated}`,
    ].join(' ');
    const output = [receipt, result.stdout && `stdout:\n${result.stdout}`, result.stderr && `stderr:\n${result.stderr}`]
      .filter(Boolean).join('\n\n');
    return result.exitCode === 0 && !result.timedOut
      ? hostToolSucceeded(output, { exitCode: 0, contentSource: 'mixed-external' })
      : hostToolFailed(output, { exitCode: result.exitCode ?? undefined, contentSource: 'mixed-external' });
  }
}

function collectProcess(
  proc: ChildProcessWithoutNullStreams,
  input: string,
  timeoutMs: number,
  terminate?: (process: ChildProcessWithoutNullStreams) => void,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let parentExited = false;
    let observedExitCode: number | null = null;
    let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (current: string, chunk: Buffer): string => {
      const bytes = Buffer.concat([Buffer.from(current, 'utf8'), chunk]).subarray(0, MAX_OUTPUT_BYTES);
      return bytes.toString('utf8');
    };
    const onStdout = (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, 'utf8') + chunk.length > MAX_OUTPUT_BYTES) stdoutTruncated = true;
      stdout = append(stdout, chunk);
    };
    const onStderr = (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, 'utf8') + chunk.length > MAX_OUTPUT_BYTES) stderrTruncated = true;
      stderr = append(stderr, chunk);
    };
    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);
    const finish = (exitCode: number | null, launchError?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      proc.stdout.off('data', onStdout);
      proc.stderr.off('data', onStderr);
      resolve({
        exitCode,
        stdout,
        stderr: launchError ? `${stderr}\n${launchError.message}`.trim() : stderr,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // One kill request, issued while this exact ChildProcess is still owned. Never retry by a bare PID:
      // it may have been reused. Resolve immediately even if a detached descendant keeps a pipe open.
      if (!parentExited) {
        try { terminate ? terminate(proc) : killProcessTree(proc); } catch { try { proc.kill(); } catch { /* best effort */ } }
      }
      finish(observedExitCode);
    }, timeoutMs);
    proc.once('error', (error) => finish(null, error));
    proc.once('exit', (code) => {
      parentExited = true;
      observedExitCode = code;
      // Detached descendants may inherit stdout/stderr and prevent Node's `close` event forever.
      // Give already-buffered output one short drain window, then resolve from the observed parent exit.
      exitDrainTimer = setTimeout(() => finish(observedExitCode), 75);
    });
    proc.once('close', (code) => finish(code));
    proc.stdin.end(input);
  });
}

function fixedRunnerPath(candidate: string): string {
  if (!path.isAbsolute(candidate) || path.basename(candidate).toLowerCase() !== 'skillactionrunner.js') {
    throw new Error('the fixed executable-Skill runner path is invalid');
  }
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('the fixed executable-Skill runner is not a regular file');
  const real = fs.realpathSync(candidate);
  if (pathKey(real) !== pathKey(candidate)) throw new Error('the fixed executable-Skill runner identity changed');
  return real;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const keep = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATH', 'PATHEXT', 'LANG', 'LC_ALL'];
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', UNODE_EXECUTABLE_SKILL: '1' };
  for (const key of keep) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
