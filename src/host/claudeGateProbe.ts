/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the Claude CLI compatibility check, CP1 (v0.9.97)
 *  Runs only after the user's OK for this exact program, and sends no message, so no model request. It reads the
 *  version, then starts Claude with the production argument shape and a settings file that holds the production
 *  PreToolUse gate and one SessionStart hook. Claude silently ignores a settings file it cannot load, which would drop
 *  the gate; the SessionStart hook reaching UnodeAi within the check's time proves that this program loaded the file
 *  and runs its hooks. It does not prove how the gate decides tool calls: the release canaries prove that.
 *
 *  The hook reaches the host the way every Claude gate does: the shipped gate script, started by a private wrapper,
 *  posts to a loopback endpoint that only this check's random token opens. The endpoint denies every tool.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveToolGateScript } from '../backend/ClaudeHeadlessBackend';
import { parseClaudeCliVersion, prepareNeutralFolder } from '../backend/cliRuntime';
import { WEB_ACCESS_HUMAN_WINDOW_MS } from '../backend/WebAccessPolicy';
import { createLocalMcpServer, type LocalMcpServer } from '../mcp/LocalMcpServer';
import { bounded, GateProbeRun, runToExit, type GateProbeDeps, type GateProbeResult } from './cliGateProbeRun';
import { newStoreToken } from './managedCli/storeLayout';

export { GATE_PROBE_LIMITS, type GateProbeResult } from './cliGateProbeRun';

/** The production argument shape, before `--settings`. */
export const CLAUDE_GATE_PROBE_ARGS = Object.freeze([
  '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
] as const);

/** Claude's seconds-valued timeout of the PreToolUse hook, as a Claude agent's settings carry it. */
const PRE_TOOL_USE_TIMEOUT_SECONDS = Math.ceil(WEB_ACCESS_HUMAN_WINDOW_MS / 1000) + 10;
/** The gate's loopback liveness window, as a Claude agent's wrapper sets it. */
const GATE_LIVENESS_MS = 3_000;
/** How long Claude may let the SessionStart hook run; the check's own bound is shorter still. */
const SESSION_START_TIMEOUT_SECONDS = 10;

export interface ClaudeGateProbeRequest {
  /** The confirmed program: a native `.exe`, or npm's `.cmd` launcher through `cmd.exe`. */
  launch: { executable: string; shell: boolean };
  /** UnodeAi's own folder for checks, outside every workspace; prepared again here. */
  probeCwd: string;
  workspaceRoots: readonly string[];
  /** The environment a Claude agent starts with, every layer merged. */
  agentEnv: NodeJS.ProcessEnv;
}

export interface ClaudeGateProbeDeps extends GateProbeDeps {
  /** The shipped `claudeToolGate.cjs`; found beside the bundle by default. */
  toolGateScriptPath?: string;
  createServer?: () => LocalMcpServer;
  /** The program that runs the gate script: the extension host's own Node. */
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
}

/** The agent environment without Claude's own and Anthropic's variables, so no credential reaches the check. */
export function claudeProbeEnv(agentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(agentEnv)) {
    const name = key.toUpperCase();
    if (name.startsWith('CLAUDE') || name.startsWith('ANTHROPIC_') || name === 'MCP_CONNECTION_NONBLOCKING') continue;
    env[key] = value;
  }
  return env;
}

/** The PreToolUse hook a Claude agent's settings carry, for a wrapper at `wrapper`. */
export function claudeToolGateHook(wrapper: string): { matcher: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> } {
  return { matcher: '*', hooks: [{ type: 'command', command: `"${wrapper}"`, timeout: PRE_TOOL_USE_TIMEOUT_SECONDS }] };
}

/** The private wrapper that sets the gate's endpoint and token for the hook's process only, as an agent's does. */
export function claudeToolGateWrapperSource(node: string, script: string, endpoint: string, token: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `set "UNODE_CLAUDE_TOOL_GATE_URL=${endpoint}"`,
      `set "UNODE_CLAUDE_TOOL_GATE_TOKEN=${token}"`,
      `set "UNODE_CLAUDE_TOOL_GATE_TIMEOUT_MS=${WEB_ACCESS_HUMAN_WINDOW_MS}"`,
      `set "UNODE_CLAUDE_TOOL_GATE_LIVENESS_MS=${GATE_LIVENESS_MS}"`,
      `"${node}" "${script}"`,
      'if errorlevel 1 exit /b 2',
      'exit /b 0',
      '',
    ].join('\r\n')
    : [
      '#!/bin/sh',
      'export ELECTRON_RUN_AS_NODE=1',
      `export UNODE_CLAUDE_TOOL_GATE_URL='${endpoint}'`,
      `export UNODE_CLAUDE_TOOL_GATE_TOKEN='${token}'`,
      `export UNODE_CLAUDE_TOOL_GATE_TIMEOUT_MS='${WEB_ACCESS_HUMAN_WINDOW_MS}'`,
      `export UNODE_CLAUDE_TOOL_GATE_LIVENESS_MS='${GATE_LIVENESS_MS}'`,
      `"${node}" "${script}"`,
      'status=$?',
      '[ "$status" -eq 0 ] && exit 0',
      'exit 2',
      '',
    ].join('\n');
}

/**
 * CP1 for one confirmed Claude program. A pass means `--version` parsed and the SessionStart hook of the check's
 * settings reached UnodeAi within the check's time; the process tree is then stopped while it still runs.
 */
export async function runClaudeGateProbe(request: ClaudeGateProbeRequest, deps: ClaudeGateProbeDeps = {}): Promise<GateProbeResult & { version?: string }> {
  const run = new GateProbeRun(deps);
  const platform = deps.platform ?? process.platform;
  const node = deps.nodeExecutable ?? process.execPath;
  let cwd: string;
  let script: string;
  try {
    cwd = prepareNeutralFolder(request.probeCwd, request.workspaceRoots);
    script = deps.toolGateScriptPath ?? resolveToolGateScript(__dirname);
    if (!fs.statSync(script).isFile()) throw new Error('the gate script is not a file');
    fs.accessSync(script, fs.constants.R_OK);
  } catch (error) {
    return run.result(`the check cannot be prepared (${bounded(error instanceof Error ? error.message : String(error), 300)})`, undefined, undefined);
  }
  // The hook command is read by Claude's command runner: a quote or a line break would make it ambiguous.
  if ([script, node, cwd].some((value) => /["\r\n]/.test(value))) {
    return run.result('the check cannot be prepared: a path it needs is not safe in a hook command', undefined, undefined);
  }
  const env = claudeProbeEnv(request.agentEnv);

  let versionOutput: string | undefined;
  let version: string | undefined;
  try {
    const result = await runToExit(run, 'version', request.launch.executable, ['--version'], { env, cwd, shell: request.launch.shell });
    versionOutput = result.output;
    version = result.code === 0 ? parseClaudeCliVersion(result.output) : undefined;
    if (!version) return run.result(`the program did not print a Claude CLI version (exit ${result.code ?? 'none'}; ${bounded(result.output, 200) || 'no output'})`, undefined, versionOutput);
  } catch (error) {
    return run.failed(error, versionOutput);
  }

  const server = deps.createServer?.() ?? createLocalMcpServer();
  let sessionStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { sessionStarted = resolve; });
  server.addJsonEndpoint({
    path: '/gate',
    handler: async (body) => {
      if (body.hook_event_name === 'SessionStart') sessionStarted();
      return { allow: false, reason: 'UnodeAi is checking this Claude CLI; no tool runs during the check.' };
    },
  });
  const folder = path.join(cwd, '.unode', 'claude-probe', newStoreToken());
  const relativeSettings = `.unode/claude-probe/${path.basename(folder)}/claude-gate-probe.json`;
  const settingsFile = path.join(folder, 'claude-gate-probe.json');
  const wrapper = path.join(folder, `claude-gate-probe.${platform === 'win32' ? 'cmd' : 'sh'}`);
  try {
    await server.start();
    fs.mkdirSync(folder, { recursive: true });
    const endpoint = `http://127.0.0.1:${server.port}/gate`;
    fs.writeFileSync(wrapper, claudeToolGateWrapperSource(node, script, endpoint, server.token, platform), { encoding: 'utf8', mode: 0o700, flag: 'wx' });
    fs.chmodSync(wrapper, 0o700);
    const settings = {
      hooks: {
        PreToolUse: [claudeToolGateHook(wrapper)],
        SessionStart: [{ hooks: [{ type: 'command', command: `"${wrapper}"`, timeout: SESSION_START_TIMEOUT_SECONDS }] }],
      },
    };
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    await server.stop().catch(() => undefined);
    removeProbeFiles(folder, [wrapper, settingsFile]);
    return run.result(`the check's settings could not be written (${bounded(error instanceof Error ? error.message : String(error), 300)})`, undefined, versionOutput);
  }

  try {
    if (run.remainingMs() <= 0) return run.result(run.timeoutText(), undefined, versionOutput);
    const args = [...CLAUDE_GATE_PROBE_ARGS, '--settings', relativeSettings];
    let proc: ChildProcess;
    try {
      const shell = request.launch.shell;
      if (shell && /["\r\n%]/.test(request.launch.executable)) return run.result('the program path is not safe to start through cmd.exe', undefined, versionOutput);
      proc = run.spawn(shell ? `"${request.launch.executable}"` : request.launch.executable, args, {
        cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell, windowsHide: true,
      });
    } catch (error) {
      return run.result(`Claude could not be started (${bounded(String(error), 300)})`, undefined, versionOutput);
    }
    run.spawned(proc, 'session');
    const failure = await new Promise<string | undefined>((resolve) => {
      let settled = false;
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(`its SessionStart hook did not reach UnodeAi within ${Math.round(run.limits.timeoutMs / 1000)} seconds, so UnodeAi cannot tell that it loads its safety settings`), run.remainingMs());
      const take = (chunk: Buffer) => { if (!run.takeOutput(chunk.length)) finish(run.outputText()); };
      proc.stdout?.on('data', take);
      proc.stderr?.on('data', take);
      proc.stdin?.on('error', () => { /* the exit handler reports it */ });
      proc.once('error', (error) => finish(`Claude could not be started (${bounded(error.message, 300)})`));
      proc.once('exit', (code) => finish(`Claude exited with code ${code ?? 'unknown'} before its SessionStart hook reached UnodeAi`));
      void started.then(() => finish(undefined));
    });
    // The stop is sent while Claude runs, before its input ends: no message is ever written to it.
    const unconfirmed = await run.stop(proc);
    const outcome = run.result(failure, unconfirmed, versionOutput);
    return outcome.result === 'pass' ? { ...outcome, version } : outcome;
  } finally {
    await server.stop().catch(() => undefined);
    removeProbeFiles(folder, [wrapper, settingsFile]);
  }
}

function removeProbeFiles(folder: string, files: readonly string[]): void {
  for (const file of files) {
    try { fs.unlinkSync(file); } catch { /* not written, or already gone */ }
  }
  for (const each of [folder, path.dirname(folder), path.dirname(path.dirname(folder))]) {
    try { fs.rmdirSync(each); } catch { /* another file remains, or it is already gone */ }
  }
}
