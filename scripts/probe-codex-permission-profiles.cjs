/*
 * Live release evidence for Codex CLI 0.155.1 permission profiles.
 *
 * This invokes the compiled production CodexBackend, and therefore its production argv builder. It records
 * only booleans/counts: never prompts, assistant text, command output, paths, credentials, or config contents.
 *
 * PowerShell:
 *   $env:UNODE_CODEX_CLI = 'C:\absolute\path\to\codex.exe'
 *   $env:UNODE_RUN_CODEX_PERMISSION_PROBE = '1'
 *   npm run probe:codex-permission-profiles
 *
 * Exit 0 = all four effects observed. Exit 2 = unusable environment. Exit 3 = an effect assertion failed.
 */
'use strict';

const { existsSync, mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { isAbsolute, join } = require('node:path');
const { CodexBackend, CODEX_CLI_DEFAULT_MODEL } = require('../out/backend/CodexBackend.js');

const binary = process.env.UNODE_CODEX_CLI;
const live = process.env.UNODE_RUN_CODEX_PERMISSION_PROBE === '1';
const timeoutMs = Number.parseInt(process.env.UNODE_CODEX_PERMISSION_TIMEOUT_MS || '120000', 10);

function environmentFailure(message) {
  process.stderr.write(`UNVERIFIED: ${message}\n`);
  process.exitCode = 2;
}

function versionOf(executable) {
  return spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
}

function waitForTurn(backend, instruction) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turn timed out')), timeoutMs);
    const events = [];
    const dispose = backend.onEvent((event) => {
      events.push(event);
      if (event.kind !== 'turn_complete') return;
      clearTimeout(timer);
      dispose();
      resolve({ result: event.result, events });
    });
    backend.sendUserTurn(instruction, { mode: 'act' });
  });
}

async function runCase({ profile, workspace, writeCapable = true, instruction, approval }) {
  let userRequests = 0;
  const events = [];
  const backend = new CodexBackend({
    id: `probe-${profile}`, name: 'Permission probe', role: 'tester', skill: '',
    provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' },
    model: CODEX_CLI_DEFAULT_MODEL, systemPrompt: 'Follow the requested probe action exactly.',
    autoApprove: false, allowedTools: writeCapable ? ['read', 'write', 'execute'] : ['read'],
    backend: 'codex', workingDirectory: workspace, codexPermissionProfile: profile,
  }, undefined, {
    binaryPath: binary,
    // Production always passes the repository gate, which gives App Server a process-local trust override.
    // Without it Codex persisted each temporary workspace as trusted in the user's real ~/.codex/config.toml.
    onBeforeRepositoryConfig: async () => ({ mode: 'native', projectRoot: workspace, assertCurrent: () => undefined }),
    access: () => ({ trusted: true, restricted: false, readRoots: [workspace], writeRoots: [workspace] }),
    requestApproval: async (request) => {
      userRequests += 1;
      return approval ? approval(request) : { allow: false, note: 'Probe decline.' };
    },
    prepareFileCheckpoint: async () => ({ ok: true }),
    writeApprovalAsk: () => true,
    approvalTimeoutMs: timeoutMs,
  });
  const dispose = backend.onEvent((event) => events.push(event));
  try {
    await backend.start(process.env);
    const turn = await waitForTurn(backend, instruction);
    return { userRequests, events: [...events, ...turn.events], result: turn.result };
  } finally {
    dispose();
    await backend.stop();
  }
}

async function main() {
  if (!binary || !isAbsolute(binary) || !existsSync(binary)) {
    environmentFailure('UNODE_CODEX_CLI must name an existing absolute native executable.');
    return;
  }
  const version = versionOf(binary);
  const versionText = `${version.stdout || ''} ${version.stderr || ''}`.trim();
  if (version.status !== 0 || !/^codex-cli 0\.155\.1(?:\s|$)/.test(versionText)) {
    environmentFailure(`exact codex-cli 0.155.1 is required; observed ${JSON.stringify(versionText.slice(0, 80))}.`);
    return;
  }
  if (!live) {
    environmentFailure('set UNODE_RUN_CODEX_PERMISSION_PROBE=1 to opt into live model/network/effect tests.');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'unode-codex-permissions-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  const askMarker = join(outside, 'ask-declined.txt');
  const fullMarker = join(outside, 'full-write.txt');
  const readOnlyMarker = join(workspace, 'read-only-write.txt');
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  try {
    const ask = await runCase({
      profile: 'ask-for-approval', workspace,
      instruction: `Run exactly: Set-Content -LiteralPath ${quote(askMarker)} -Value declined`,
    });
    const approve = await runCase({
      profile: 'approve-for-me', workspace,
      instruction: 'Run exactly: curl.exe -I https://example.com',
    });
    const full = await runCase({
      profile: 'full-access', workspace,
      instruction: `Run exactly this chained PowerShell command: Set-Content -LiteralPath ${quote(fullMarker)} -Value full; curl.exe -I https://example.com`,
    });
    const readOnly = await runCase({
      profile: 'ask-for-approval', workspace, writeCapable: false,
      instruction: `Run exactly: Set-Content -LiteralPath ${quote(readOnlyMarker)} -Value blocked`,
    });

    const facts = {
      version: '0.155.1',
      ask: { userRequest: ask.userRequests > 0, declinedEffectAbsent: !existsSync(askMarker) },
      approveForMe: {
        userRequestAbsent: approve.userRequests === 0,
        reviewStarted: approve.events.some((event) => event.kind === 'approval_review' && event.phase === 'started'),
        reviewCompleted: approve.events.some((event) => event.kind === 'approval_review' && event.phase === 'completed'),
      },
      fullAccess: {
        outsideWriteLanded: existsSync(fullMarker),
        networkCommandSucceeded: full.events.some((event) => event.kind === 'tool_result'
          && event.name === 'command_execution' && event.ok === true),
        userRequestAbsent: full.userRequests === 0,
      },
      readOnly: { workspaceWriteAbsent: !existsSync(readOnlyMarker) },
    };
    process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
    const passed = facts.ask.userRequest && facts.ask.declinedEffectAbsent
      && facts.approveForMe.userRequestAbsent && facts.approveForMe.reviewStarted && facts.approveForMe.reviewCompleted
      && facts.fullAccess.outsideWriteLanded && facts.fullAccess.networkCommandSucceeded && facts.fullAccess.userRequestAbsent
      && facts.readOnly.workspaceWriteAbsent;
    if (!passed) process.exitCode = 3;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`UNVERIFIED: ${message}\n`);
    if (/\[windows\] sandbox|downgraded workspace-write/i.test(message)) {
      process.stderr.write('Configure [windows] sandbox = "unelevated" (or "elevated") in Codex, then rerun.\n');
    }
    process.exitCode = 2;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
