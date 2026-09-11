import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OpenAICompatBackend, FetchFn } from '../OpenAICompatBackend';
import { AgentConfig } from '../../types';
import { BackendEvent } from '../AgentBackend';
import { EngineOptions, FileDiagnostic } from '../Diagnostics';
import { CommandPolicy } from '../CommandPolicy';
import { CheckpointRecorder, CommandExecutor } from '../WorkspaceTools';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'a1',
    name: 'Worker',
    role: 'senior-dev',
    skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat',
    systemPrompt: 'Be terse.',
    autoApprove: true,
    allowedTools: ['write'],
    ...overrides,
  };
}

/** Fake fetch returning scripted JSON bodies in order, recording each request body. */
function scriptedFetch(bodies: unknown[]): { fetchFn: FetchFn; requests: any[] } {
  const requests: any[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetchFn, requests };
}

function writeCall(p: string, content: string) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: p, content }) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

function finalText(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }] };
}

/** Construct a backend wiring only the engine options (everything else defaulted). */
function makeEngineBackend(
  config: AgentConfig,
  fetchFn: FetchFn,
  engine: EngineOptions,
  cmd?: { policy: CommandPolicy; executor: CommandExecutor },
  checkpointRecorder?: CheckpointRecorder,
): OpenAICompatBackend {
  return new OpenAICompatBackend(
    config,
    fetchFn,
    undefined, // team
    undefined, // coordinator
    cmd?.policy, // commandPolicy
    undefined, // net
    undefined, // mcp
    undefined, // streamFetchFn
    undefined, // requestApproval
    undefined, // bus
    undefined, // commandNormalizer
    cmd?.executor, // commandExecutor
    checkpointRecorder,
    undefined, // writeApprovalAsk
    undefined, // requestWriteApproval
    undefined, // memoryWriter
    engine,
  );
}

async function runOneTurn(backend: OpenAICompatBackend, instruction: string): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  const done = new Promise<void>((resolve) => {
    backend.onEvent((e) => {
      events.push(e);
      if (e.kind === 'turn_complete') { resolve(); }
    });
  });
  await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
  backend.sendUserTurn(instruction);
  await done;
  return events;
}

const oneError: FileDiagnostic[] = [
  { path: 'a.ts', line: 1, severity: 'error', message: "Cannot find name 'x'.", source: 'ts' },
];

describe('Execution Engine — post-write diagnostics injection', () => {
  it('returns the changed-file set from successful CheckpointRecorder writes as framework evidence', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-engine-evidence-'));
    const { fetchFn } = scriptedFetch([writeCall('src/a.ts', 'export const a = 1;\n'), finalText('Done.')]);
    const recorded: string[] = [];
    const backend = makeEngineBackend(
      makeConfig({ workingDirectory: dir }),
      fetchFn,
      { verifyObligation: false },
      undefined,
      (entry) => recorded.push(entry.path),
    );

    const events = await runOneTurn(backend, 'edit src/a.ts');
    const complete = events.find((e) => e.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;
    expect(recorded).toEqual(['src/a.ts']);
    expect(complete.result.delegationEvidence).toMatchObject({
      hadToolActions: true,
      changedFiles: ['src/a.ts'],
    });
  });

  it('feeds the file\'s errors back into the next turn after a write', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-engine-diag-'));
    const { fetchFn, requests } = scriptedFetch([writeCall('a.ts', 'const y = x;\n'), finalText('done')]);
    const collected: string[][] = [];
    const backend = makeEngineBackend(makeConfig({ workingDirectory: dir }), fetchFn, {
      diagnostics: async (paths) => { collected.push(paths); return oneError; },
      verifyObligation: false, // isolate the injection behavior from the obligation nudge
    });

    await runOneTurn(backend, 'edit a.ts');

    // The collector was asked about exactly the file that was written.
    expect(collected).toEqual([['a.ts']]);
    // The 2nd request (after the write) carries the diagnostics in a tool message.
    const secondReqMessages: any[] = requests[1].messages;
    const toolMsg = secondReqMessages.find((m) => m.role === 'tool');
    expect(toolMsg.content).toContain('[post-write diagnostics]');
    expect(toolMsg.content).toContain("Cannot find name 'x'.");
  });

  it('injects nothing when diagnostics are clean', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-engine-clean-'));
    const { fetchFn, requests } = scriptedFetch([writeCall('a.ts', 'ok\n'), finalText('done')]);
    const backend = makeEngineBackend(makeConfig({ workingDirectory: dir }), fetchFn, {
      diagnostics: async () => [],
      verifyObligation: true,
    });

    const events = await runOneTurn(backend, 'edit a.ts');

    const toolMsg = (requests[1].messages as any[]).find((m) => m.role === 'tool');
    expect(toolMsg.content).not.toContain('[post-write diagnostics]');
    // clean write counts as verified → no obligation nudge, no warning marker
    const complete = events.find((e) => e.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;
    expect(complete.result.text).not.toContain('Changes not verified');
  });
});

describe('Execution Engine — verification obligation', () => {
  it('does not continue a turn to verify when it wrote files but left errors, then marks it unverified', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-engine-verify-'));
    const { fetchFn, requests } = scriptedFetch([
      writeCall('a.ts', 'const y = x;\n'),
      finalText('all done'),     // model tries to finish without verifying
      finalText('still done'),   // ignores the nudge
    ]);
    const backend = makeEngineBackend(makeConfig({ workingDirectory: dir }), fetchFn, {
      diagnostics: async () => oneError,
      verifyObligation: true,
    });

    const events = await runOneTurn(backend, 'edit a.ts');

    // No verification continuation is injected.
    expect(requests).toHaveLength(2);
    // Still unverified: the terminal text carries an honest marker without hard-blocking.
    const complete = events.find((e) => e.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;
    expect(complete.result.isError).toBe(false);
    expect(complete.result.text).toContain('⚠ Changes not verified');
  });

  it('treats a successful check command as satisfying the obligation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-engine-checked-'));
    // No diagnostics collector → a write is unverified until a check runs. The model writes, then the
    // engine would normally nudge; here the model runs a command itself, satisfying the obligation.
    const { fetchFn } = scriptedFetch([
      writeCall('a.ts', 'x\n'),
      {
        choices: [{
          message: {
            role: 'assistant', content: '',
            tool_calls: [{ id: 'c2', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo ok' }) } }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      finalText('verified and done'),
    ]);
    const backend = makeEngineBackend(
      makeConfig({ workingDirectory: dir, allowedTools: ['write', 'execute'] }),
      fetchFn,
      { verifyObligation: true, verificationCommand: 'echo ok' }, // no diagnostics collector
      { policy: new CommandPolicy('all', []), executor: async () => ({ code: 0, output: 'ok' }) },
    );

    const events = await runOneTurn(backend, 'edit then test');
    const complete = events.find((e) => e.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;
    expect(complete.result.text).not.toContain('Changes not verified');
    expect(complete.result.delegationEvidence?.verification).toMatchObject({ ran: true, passed: true, command: 'echo ok' });
  });

  it('records a failed verification command from this turn rather than retaining an earlier passing result', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-engine-evidence-attribution-'));
    const commandCall = (id: string, command: string) => ({
      choices: [{
        message: {
          role: 'assistant', content: '',
          tool_calls: [{ id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const { fetchFn } = scriptedFetch([
      commandCall('pass', 'npm test'),
      commandCall('fail', 'npm run test'),
      finalText('checks attempted'),
    ]);
    let invocation = 0;
    const backend = makeEngineBackend(
      makeConfig({ workingDirectory: dir, allowedTools: ['execute'] }),
      fetchFn,
      { verifyObligation: false },
      {
        policy: new CommandPolicy('all', []),
        executor: async () => ({ code: invocation++ === 0 ? 0 : 1, output: invocation === 1 ? 'passed' : 'failed' }),
      },
    );

    const events = await runOneTurn(backend, 'run the checks twice');
    const complete = events.find((e) => e.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;
    expect(complete.result.delegationEvidence?.verification).toEqual({ ran: true, passed: false, command: 'npm run test' });
  });

  it('counts a check run via an ALIASED tool name (Bash → run_command) as satisfying the obligation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-engine-alias-'));
    // A Claude model runs its check with the native `Bash` name; it aliases to run_command. The
    // verification bookkeeping must use the EFFECTIVE name, or a genuinely-verified edit still warns.
    const { fetchFn } = scriptedFetch([
      writeCall('a.ts', 'x\n'),
      {
        choices: [{
          message: {
            role: 'assistant', content: '',
            tool_calls: [{ id: 'c2', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo ok' }) } }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      finalText('verified and done'),
    ]);
    const backend = makeEngineBackend(
      makeConfig({ workingDirectory: dir, allowedTools: ['write', 'execute'] }),
      fetchFn,
      { verifyObligation: true },
      { policy: new CommandPolicy('all', []), executor: async () => ({ code: 0, output: 'ok' }) },
    );

    const events = await runOneTurn(backend, 'edit then test with Bash');
    const complete = events.find((e) => e.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;
    expect(complete.result.text).not.toContain('Changes not verified');
  });

  it('does nothing when the obligation is disabled (kill-switch)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-engine-off-'));
    const { fetchFn, requests } = scriptedFetch([writeCall('a.ts', 'x\n'), finalText('done')]);
    const backend = makeEngineBackend(makeConfig({ workingDirectory: dir }), fetchFn, {
      diagnostics: async () => oneError, // errors present, but obligation is off
      verifyObligation: false,
    });

    const events = await runOneTurn(backend, 'edit a.ts');
    // No verify nudge injected, no warning marker.
    expect(requests.length).toBe(2);
    const complete = events.find((e) => e.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;
    expect(complete.result.text).not.toContain('Changes not verified');
  });
});
