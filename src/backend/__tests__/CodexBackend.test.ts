import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { AgentConfig } from '../../types';
import { CODEX_BANNED_FLAGS, CODEX_CLI_DEFAULT_MODEL, CodexBackend, isSupportedCodexCliVersion } from '../CodexBackend';

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'codex-1', name: 'Codex Reviewer', role: 'reviewer', skill: '',
    provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: CODEX_CLI_DEFAULT_MODEL,
    systemPrompt: 'Review the project.', autoApprove: true, allowedTools: ['read', 'search', 'execute'], backend: 'codex',
    workingDirectory: process.cwd(), ...overrides,
  };
}

function fakeSpawn() {
  const calls: Array<{ command: string; args: string[]; stdin: string[] }> = [];
  const spawn = (command: string, args: string[]) => {
    const proc = new EventEmitter() as any;
    const stdin: string[] = [];
    calls.push({ command, args, stdin });
    proc.pid = 1234; proc.exitCode = null;
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined; proc.stderr.setEncoding = () => undefined;
    proc.stdin = { end: (text: string) => stdin.push(text) };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    return proc;
  };
  return { spawn, calls };
}

describe('CodexBackend Track A', () => {
  it('always uses an explicit binary and read-only args, even when autoApprove is set', async () => {
    const fake = fakeSpawn();
    const backend = new CodexBackend(config(), undefined, { binaryPath: 'C:/tools/codex.exe', spawn: fake.spawn as any });
    await backend.start({});
    backend.sendUserTurn('inspect this');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const args = fake.calls[0].args;
    expect(fake.calls[0].command).toBe('C:/tools/codex.exe');
    expect(args).toEqual(expect.arrayContaining(['exec', '--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-s', 'read-only', '-C']));
    expect(args).not.toContain('-m');
    for (const banned of CODEX_BANNED_FLAGS) { expect(args).not.toContain(banned); }
    expect(fake.calls[0].stdin[0]).toContain('inspect this');
  });

  it('passes an explicitly selected Codex model but never forces the CLI-default sentinel', () => {
    const defaultBackend = new CodexBackend(config(), undefined, { binaryPath: 'C:/tools/codex.exe' });
    expect(defaultBackend.buildArgs()).not.toContain('-m');

    const selectedBackend = new CodexBackend(config({ model: 'account-supported-model' }), undefined, { binaryPath: 'C:/tools/codex.exe' });
    expect(selectedBackend.buildArgs()).toEqual(expect.arrayContaining(['-m', 'account-supported-model']));
  });

  it('does not spawn when egress consent declines', async () => {
    const fake = fakeSpawn();
    const backend = new CodexBackend(config(), undefined, {
      binaryPath: 'C:/tools/codex.exe', spawn: fake.spawn as any,
      onBeforeEgress: async () => { throw new Error('egress denied'); },
    });
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));
    await backend.start({});
    backend.sendUserTurn('inspect this');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.calls).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', message: 'egress denied' }));
  });

  it('does not spawn when the final route boundary rejects, while an identical positive path spawns once', async () => {
    const denied = fakeSpawn();
    const rejected = new CodexBackend(config(), undefined, {
      binaryPath: 'C:/tools/codex.exe', spawn: denied.spawn as any,
      assertResolvedRoute: () => { throw new Error('Resolved route boundary mismatch: endpoint base.'); },
    });
    await rejected.start({});
    rejected.sendUserTurn('inspect this');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(denied.calls).toHaveLength(0);

    const allowed = fakeSpawn();
    const positive = new CodexBackend(config(), undefined, {
      binaryPath: 'C:/tools/codex.exe', spawn: allowed.spawn as any,
      assertResolvedRoute: () => undefined,
    });
    await positive.start({});
    positive.sendUserTurn('inspect this');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(allowed.calls).toHaveLength(1);
  });

  it('refuses an injected sandbox-bypass argv before spawn', async () => {
    const bannedArgs = CODEX_BANNED_FLAGS.flatMap((flag) => [flag, `${flag}=true`]);
    for (const banned of bannedArgs) {
      const fake = fakeSpawn();
      const backend = new CodexBackend(config(), undefined, { binaryPath: 'C:/tools/codex.exe', spawn: fake.spawn as any });
      const events: any[] = [];
      backend.onEvent((event) => events.push(event));
      // Simulates a future call path producing final argv outside buildArgs' current safe configuration.
      (backend as any).buildArgs = () => ['exec', '-s', banned];
      await backend.start({});
      backend.sendUserTurn('inspect this');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.calls, `${banned} must be rejected before node spawn`).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'error', message: `Codex refused unsafe spawn argument: ${banned}`,
      }));
    }
  });

  it('keeps a thread id in the snapshot and resumes it on the next turn', async () => {
    const fake = fakeSpawn();
    const backend = new CodexBackend(config(), undefined, { binaryPath: 'C:/tools/codex.exe', spawn: fake.spawn as any });
    await backend.start({});
    (backend as any).handleEvent({ type: 'thread.started', thread_id: 'thread-123' });
    expect(backend.snapshot()).toEqual({ version: 1, messages: [{ codexThreadId: 'thread-123' }] });
    expect(backend.buildArgs().slice(0, 4)).toEqual(['exec', 'resume', 'thread-123', '--json']);
    const restored = new CodexBackend(config(), undefined, { binaryPath: 'C:/tools/codex.exe' });
    restored.restore(backend.snapshot()!);
    expect(restored.buildArgs().slice(0, 4)).toEqual(['exec', 'resume', 'thread-123', '--json']);
  });

  it('maps interleaved logs, command events, usage, and incomplete JSON without crashing', () => {
    const backend = new CodexBackend(config(), undefined, { binaryPath: 'C:/tools/codex.exe' });
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));
    (backend as any).consume('ERROR trace line\n{"type":"thread.started","thread_id":"t"}\n{"type":"item.started","item":{"type":"command_execution","command":"rg TODO"}}\n');
    (backend as any).consume('{"type":"item.completed","item":{"type":"command_execution","command":"rg TODO","exit_code":0,"aggregated_output":"ok"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"reasoning_output_tokens":7}}\n{truncated');
    const tail = (backend as any).parser.flush();
    tail.garbage.forEach((line: string) => (backend as any).emit({ kind: 'log', stream: 'stdout', line }));
    expect(events).toContainEqual({ kind: 'log', stream: 'stdout', line: 'ERROR trace line' });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_use' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', ok: true }));
    expect(events).toContainEqual({ kind: 'assistant', text: 'done' });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'turn_complete', result: expect.objectContaining({ usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 17, costBasis: 'api-equivalent' } }) }));
    expect(events).toContainEqual({ kind: 'log', stream: 'stdout', line: '{truncated' });
  });

  it('estimates a completed turn with no usage rather than booking zero', () => {
    const backend = new CodexBackend(config(), undefined, { binaryPath: 'C:/tools/codex.exe' });
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));
    (backend as any).handleEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'a non-empty answer' } });
    (backend as any).handleEvent({ type: 'turn.completed' });
    expect(events.find((event) => event.kind === 'turn_complete').result.usage).toMatchObject({ estimated: true, costBasis: 'api-equivalent' });
    expect(events.find((event) => event.kind === 'turn_complete').result.usage.inputTokens).toBeGreaterThan(0);
  });

  it('accepts only stable supported protocol versions', () => {
    expect(isSupportedCodexCliVersion('codex-cli 0.137.0')).toBe(true);
    expect(isSupportedCodexCliVersion('codex-cli 0.144.0')).toBe(true);
    expect(isSupportedCodexCliVersion('codex-cli 0.144.0-alpha.4')).toBe(false);
    expect(isSupportedCodexCliVersion('codex-cli 0.136.9')).toBe(false);
  });
});
