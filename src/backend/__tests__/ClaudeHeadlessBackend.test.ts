import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import { existsSync } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeHeadlessBackend, resolveToolGateScript } from '../ClaudeHeadlessBackend';
import { AgentConfig } from '../../types';
import { LocalJsonEndpoint, LocalMcpServer, LocalMcpTool } from '../../mcp/LocalMcpServer';
import { TeamMcpBridge } from '../../mcp/TeamMcpBridge';
import { CommandPolicy } from '../CommandPolicy';
import { FILES_BRIDGE_SERVER_ID } from '../../mcp/ClaudeMcpConfig';
import { SkillRegistry } from '../../skills/SkillRegistry';
import { MessageBus } from '../../bus/MessageBus';
import { HostExecutionHooks } from '../ExecutionHooks';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { compileTaskContract, TaskInputResolver } from '../TaskContract';

describe('Claude execution hook points', () => {
  it('fires PreTool, PostWrite, on-failure, and EndTurn through the same live host source', async () => {
    const fired: string[] = [];
    const declaration = (id: string, point: 'PreTool' | 'PostWrite' | 'EndTurn' | 'on-failure') => ({
      id, point, appliedBy: 'human' as const, timeoutMs: 100, maxOutputBytes: 100, onFailure: 'block' as const,
    });
    const hooks = new HostExecutionHooks([
      declaration('pre', 'PreTool'), declaration('post', 'PostWrite'),
      declaration('failure', 'on-failure'), declaration('end', 'EndTurn'),
    ], new Map([
      ['pre', (context) => { fired.push(context.point); return {}; }],
      ['post', (context) => { fired.push(context.point); return {}; }],
      ['failure', (context) => { fired.push(context.point); return {}; }],
      ['end', (context) => { fired.push(context.point); return {}; }],
    ]));
    const backend = new ClaudeHeadlessBackend(makeConfig(), undefined, undefined, { executionHooks: () => hooks });

    await (backend as any).decidePreToolUse('Read', { file_path: 'hook.txt' });
    await (backend as any).handleEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: 'hook.txt', content: 'ok' } }] },
    });
    await (backend as any).handleEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'write', content: 'written' }] },
    });
    await (backend as any).handleEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'failure', name: 'Bash', input: { command: 'false' } }] },
    });
    await (backend as any).handleEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'failure', content: 'failed', is_error: true }] },
    });
    await (backend as any).handleEvent({ type: 'result', subtype: 'success', result: 'finished' });

    expect(fired).toEqual(['PreTool', 'PostWrite', 'on-failure', 'EndTurn']);
  });
});

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'claude-1',
    name: 'Claude Dev',
    role: 'developer',
    skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-5',
    systemPrompt: 'Follow the role.\n\n<project_context>\nold rules\n</project_context>',
    autoApprove: true,
    allowedTools: [],
    backend: 'claude',
    ...overrides,
  };
}

const READ_ONLY_SCOPE_DISALLOWED_TOOLS = [
  'Write',
  'Edit',
  'NotebookEdit',
  'EnterWorktree',
  'ExitWorktree',
  'Artifact',
  'CronCreate',
  'CronDelete',
  'RemoteTrigger',
  'PushNotification',
  'ScheduleWakeup',
  'SendMessage',
  'Monitor',
  'TaskCreate',
  'Agent',
  'Workflow',
  'ToolSearch',
  'Bash',
  'PowerShell',
];

describe('ClaudeHeadlessBackend project context (F4)', () => {
  it('uses the latest project context in the first role prompt', () => {
    const backend = new ClaudeHeadlessBackend(makeConfig());
    const text = (backend as any).composeTurnText('do work', { projectContext: 'new rules' });

    expect(text).toContain('# Your Role: Claude Dev');
    expect(text).toContain('<project_context>\nnew rules\n</project_context>');
    expect(text).not.toContain('old rules');
    expect(text).toContain('do work');
  });

  it('injects latest project context on later turns', () => {
    const backend = new ClaudeHeadlessBackend(makeConfig({ systemPrompt: 'Follow the role.' }));
    (backend as any).composeTurnText('first', { projectContext: 'v1' });

    const second = (backend as any).composeTurnText('second', { projectContext: 'v2' });

    expect(second).toContain('<project_context>\nv2\n</project_context>');
    expect(second).not.toContain('# Your Role');
    expect(second).toContain('second');
  });

  it('adds a Plan mode note while leaving Claude permissions as spawn-time best-effort', () => {
    const backend = new ClaudeHeadlessBackend(makeConfig());
    const text = (backend as any).composeTurnText('sketch options', { mode: 'plan' });

    expect(text).toContain('[PLAN MODE] Discuss, analyze, and plan only.');
    expect(text).toContain('sketch options');
  });

  it('does not inject OpenAI-compatible narration guidance into Claude turns', () => {
    const backend = new ClaudeHeadlessBackend(makeConfig());
    const text = (backend as any).composeTurnText('inspect package.json');

    expect(text).not.toContain('Before each tool call, state in ONE short sentence');
    expect(text).not.toContain('Do not narrate trivial repetition');
  });
});

describe('ClaudeHeadlessBackend native checkpoints', () => {
  it('records only proven native edits, and never reads a file as a before-state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-checkpoints-'));
    const recorded: Array<Record<string, unknown>> = [];
    const readAfterFile = vi.fn((file: string) => syncFs.readFileSync(file, 'utf8'));
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ workingDirectory: dir }),
      undefined,
      undefined,
      { recordCheckpoint: (entry) => recorded.push(entry), readAfterFile }
    );

    try {
      await fs.writeFile(path.join(dir, 'edit.txt'), 'before', 'utf8');
      (backend as any).handleEvent({
        type: 'assistant',
        message: { content: [{
          type: 'tool_use', id: 'edit-1', name: 'Edit',
          input: { file_path: 'edit.txt', old_string: 'before', new_string: 'after' },
        }] },
      });
      // This is the race the checkpoint path must never reintroduce. At tool_use it stores only the
      // event intent; a content read here could already observe Claude's after-state and label it before.
      expect(readAfterFile).not.toHaveBeenCalled();

      await fs.writeFile(path.join(dir, 'edit.txt'), 'after', 'utf8');
      (backend as any).handleEvent({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'done' }] },
      });

      (backend as any).handleEvent({
        type: 'assistant',
        message: { content: [{
          type: 'tool_use', id: 'overwrite-1', name: 'Write',
          input: { file_path: 'edit.txt', content: 'replacement' },
        }] },
      });
      await fs.writeFile(path.join(dir, 'edit.txt'), 'replacement', 'utf8');
      (backend as any).handleEvent({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'overwrite-1', content: 'done' }] },
      });

      (backend as any).handleEvent({
        type: 'assistant',
        message: { content: [{
          type: 'tool_use', id: 'create-1', name: 'Write',
          input: { file_path: 'new.txt', content: 'new file' },
        }] },
      });
      await fs.writeFile(path.join(dir, 'new.txt'), 'new file', 'utf8');
      (backend as any).handleEvent({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'create-1', content: 'done' }] },
      });

      expect(recorded).toEqual([
        { agentId: 'claude-1', path: 'edit.txt', before: 'before', after: 'after' },
        {
          agentId: 'claude-1', path: 'edit.txt', before: null, after: 'replacement',
          restoreDisabledReason: 'overwrote-existing',
        },
        { agentId: 'claude-1', path: 'new.txt', before: null, after: 'new file' },
      ]);
      expect(readAfterFile).toHaveBeenCalledTimes(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('records an unprovable Edit for review but never makes it restorable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-checkpoint-refusal-'));
    const recorded: Array<Record<string, unknown>> = [];
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ workingDirectory: dir }),
      undefined,
      undefined,
      { recordCheckpoint: (entry) => recorded.push(entry) }
    );

    try {
      (backend as any).handleEvent({
        type: 'assistant',
        message: { content: [{
          type: 'tool_use', id: 'replace-all', name: 'Edit',
          input: { file_path: 'ambiguous.txt', old_string: 'old', new_string: 'new', replace_all: true },
        }] },
      });
      await fs.writeFile(path.join(dir, 'ambiguous.txt'), 'new new', 'utf8');
      (backend as any).handleEvent({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'replace-all', content: 'done' }] },
      });

      expect(recorded).toEqual([{
        agentId: 'claude-1', path: 'ambiguous.txt', before: null, after: 'new new',
        restoreDisabledReason: 'replace-all-ambiguous',
      }]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ClaudeHeadlessBackend Windows launcher hardening', () => {
  it('rejects shell metacharacters in a configured model before spawning Claude', async () => {
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ model: 'claude-haiku & calc.exe' }),
      undefined,
      undefined,
      { spawn: spawn.fn as any }
    );

    await expect(backend.start({} as NodeJS.ProcessEnv)).rejects.toThrow('unsafe model argument');
    expect(spawn.calls).toHaveLength(0);
  });
});

describe('ClaudeHeadlessBackend idle watchdog', () => {
  it('requests cancellation when a sent CLI turn stays host-silent for the configured window', async () => {
    vi.useFakeTimers();
    try {
      const spawn = fakeSpawn();
      const backend = new ClaudeHeadlessBackend(
        makeConfig(),
        undefined,
        undefined,
        { spawn: spawn.fn as any, idleWatchdogMs: 100 }
      );
      const events: any[] = [];
      backend.onEvent((event) => events.push(event));

      const starting = backend.start({} as NodeJS.ProcessEnv);
      await vi.advanceTimersByTimeAsync(0);
      await starting;
      backend.sendUserTurn('remain silent');

      await vi.advanceTimersByTimeAsync(99);
      expect(events.some((event) => event.kind === 'watchdog_idle')).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(events.filter((event) => event.kind === 'watchdog_idle')).toEqual([
        expect.objectContaining({ kind: 'watchdog_idle', idleMs: 100 }),
      ]);
      // Mutation: removing beginTurnWatchdog() or the expiry emit lets the silent turn run forever.
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts the idle window only when parsed material output is observed', async () => {
    vi.useFakeTimers();
    try {
      const spawn = fakeSpawn();
      const backend = new ClaudeHeadlessBackend(
        makeConfig(),
        undefined,
        undefined,
        { spawn: spawn.fn as any, idleWatchdogMs: 100 }
      );
      const events: any[] = [];
      backend.onEvent((event) => events.push(event));

      const starting = backend.start({} as NodeJS.ProcessEnv);
      await vi.advanceTimersByTimeAsync(0);
      await starting;
      backend.sendUserTurn('emit once');
      await vi.advanceTimersByTimeAsync(90);
      (backend as any).proc.stdout.emit('data', '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"x"}}}\n');
      await vi.advanceTimersByTimeAsync(99);
      expect(events.some((event) => event.kind === 'watchdog_idle')).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(events.some((event) => event.kind === 'watchdog_idle')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('catches a chatty but wedged CLI: status bytes never renew the material-output deadline', async () => {
    vi.useFakeTimers();
    try {
      const spawn = fakeSpawn();
      const backend = new ClaudeHeadlessBackend(
        makeConfig(),
        undefined,
        undefined,
        { spawn: spawn.fn as any, streamReadBudget: { firstChunkMs: 40, idleMs: 100 } }
      );
      const events: any[] = [];
      backend.onEvent((event) => events.push(event));

      const starting = backend.start({} as NodeJS.ProcessEnv);
      await vi.advanceTimersByTimeAsync(0);
      await starting;
      backend.sendUserTurn('start, then wedge while narrating status');
      await vi.advanceTimersByTimeAsync(20);
      (backend as any).proc.stdout.emit('data', '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"started"}}}\n');
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(20);
        (backend as any).proc.stderr.emit('data', 'still working, no material result yet\n');
      }
      expect(events.some((event) => event.kind === 'watchdog_idle')).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(events.filter((event) => event.kind === 'watchdog_idle')).toEqual([
        expect.objectContaining({ kind: 'watchdog_idle', idleMs: 100 }),
      ]);
      // Mutation: restoring stdout/stderr's old any-byte keepalive makes this test time out instead of firing.
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ClaudeHeadlessBackend team bridge MCP wiring', () => {
  it('starts a LocalMcpServer for PM agents and passes --mcp-config', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-claude-'));
    const local = fakeLocalServer();
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'pm', workingDirectory: dir }),
      { mcpServers: { github: { command: 'npx' } } },
      undefined,
      {
        localMcpServerFactory: () => local,
        teamMcpBridge: fakeBridge(),
        spawn: spawn.fn as any,
      }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    expect(local.starts).toBe(1);
    expect(spawn.calls[0].args).toContain('--mcp-config');
    expect(spawn.calls[0].args).toContain('.unode/mcp.json');
    expect(spawn.calls[0].args).toEqual(expect.arrayContaining([
      '--allowedTools',
      'mcp__unode_team_bridge__dispatch_task',
      'mcp__unode_team_bridge__collect_ready_tasks',
      'mcp__unode_team_bridge__inspect_task_status',
      'mcp__unode_team_bridge__close_assignment',
      'mcp__unode_team_bridge__run_checks',
    ]));
    expect(spawn.calls[0].args).not.toContain('mcp__github__anything');

    const written = JSON.parse(await fs.readFile(path.join(dir, '.unode', 'mcp.json'), 'utf8'));
    expect(written.mcpServers.github).toEqual({ command: 'npx' });
    expect(written.mcpServers.unode_team_bridge).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:48123/mcp',
      headers: { Authorization: 'Bearer test-token' },
    });

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not start LocalMcpServer for non-PM agents', async () => {
    const local = fakeLocalServer();
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer' }),
      undefined,
      undefined,
      {
        localMcpServerFactory: () => local,
        teamMcpBridge: fakeBridge(),
        spawn: spawn.fn as any,
      }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    expect(local.starts).toBe(0);
    expect(spawn.calls[0].args).not.toContain('--mcp-config');
    expect(spawn.calls[0].args).not.toContain('mcp__unode_team_bridge__assign_task');
  });

  it('stops LocalMcpServer when a PM backend stops', async () => {
    const local = fakeLocalServer();
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'pm' }),
      undefined,
      undefined,
      {
        localMcpServerFactory: () => local,
        teamMcpBridge: fakeBridge(),
        spawn: spawn.fn as any,
      }
    );
    await backend.start({} as NodeJS.ProcessEnv);

    await backend.stop(50);

    expect(local.stops).toBe(1);
  });
});

describe('ClaudeHeadlessBackend image attachments (stream-json content blocks)', () => {
  // Capture what the backend writes to the claude process stdin so we can inspect the turn shape.
  function capturingSpawn(writes: string[]) {
    return (_cmd: string, _args: string[]) => {
      const proc = new EventEmitter() as any;
      proc.pid = 4321;
      proc.exitCode = null;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdout.setEncoding = () => undefined;
      proc.stderr.setEncoding = () => undefined;
      proc.stdin = { write: (s: string) => { writes.push(s); return true; }, end: () => undefined };
      proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
      setTimeout(() => proc.emit('spawn'), 0);
      return proc;
    };
  }

  it('rides images as Anthropic image content blocks; text turns stay plain strings', async () => {
    const writes: string[] = [];
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer' }),
      undefined,
      undefined,
      { spawn: capturingSpawn(writes) as any }
    );
    await backend.start({} as NodeJS.ProcessEnv);

    backend.sendUserTurn('what color is this?', {
      userAttachments: [{ name: 'x.png', mime: 'image/png', kind: 'image', dataBase64: 'QUJD', size: 3 }],
    } as any);

    const turn = JSON.parse(writes.find((w) => w.includes('"type":"user"'))!);
    expect(Array.isArray(turn.message.content)).toBe(true);
    expect(turn.message.content[0]).toMatchObject({ type: 'text' });
    expect(turn.message.content.find((p: any) => p.type === 'image')).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    });
  });

  it('keeps string content when there are no image attachments', async () => {
    const writes: string[] = [];
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer' }),
      undefined,
      undefined,
      { spawn: capturingSpawn(writes) as any }
    );
    await backend.start({} as NodeJS.ProcessEnv);

    backend.sendUserTurn('plain text turn', {} as any);

    const turn = JSON.parse(writes.find((w) => w.includes('"type":"user"'))!);
    expect(typeof turn.message.content).toBe('string');
  });
});

describe('ClaudeHeadlessBackend Agent Skills', () => {
  it('builds an extension-managed, per-agent plugin directory and passes it on argv', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-skills-workspace-'));
    const spawn = fakeSpawn();
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    const backend = new ClaudeHeadlessBackend(
      makeConfig({
        workingDirectory: workspace,
        allowedTools: ['read', 'write', 'execute'],
        playbooks: ['api-contract-review'],
      }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, skillRegistry: registry }
    );

    try {
      await backend.start({} as NodeJS.ProcessEnv);
      const args = spawn.calls[0].args;
      const at = args.indexOf('--plugin-dir');
      expect(at).toBeGreaterThan(-1);
      const pluginDir = args[at + 1];
      expect(pluginDir).toBeTruthy();
      expect(existsSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'))).toBe(true);
      expect(existsSync(path.join(pluginDir, 'skills', 'api-contract-review', 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(workspace, '.claude'))).toBe(false);

      await backend.stop(50);
      expect(existsSync(pluginDir)).toBe(false);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  // B0 Gate 2. Verified live against claude 2.1.206: even with read-only write/shell/worktree/subagent
  // denies, claude STILL loaded a `--plugin-dir` skill's body. Gating the plugin on Bash therefore stripped
  // skills from exactly the privacy-scoped agents that need them, for no security gain.
  it('keeps Bash disabled but STILL mounts the skill plugin for a read-only agent', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-skills-restricted-'));
    const spawn = fakeSpawn();
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    const backend = new ClaudeHeadlessBackend(
      makeConfig({
        workingDirectory: workspace,
        allowedTools: ['read'],
        playbooks: ['api-contract-review'],
      }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, skillRegistry: registry, writeRoots: [], restrictShell: true }
    );

    try {
      await backend.start({} as NodeJS.ProcessEnv);
      const args = spawn.calls[0].args;
      expect(args).toContain('--disallowedTools');
      expect(args).toContain('Bash');
      expect(args).toContain('PowerShell');
      expect(args).toContain('Agent');
      expect(args).toContain('Workflow');
      expect(args).toContain('ToolSearch');
      expect(args).toContain('--plugin-dir');

      const prompt = (backend as any).composeTurnText('review the contract');
      expect(prompt).toContain('## Authorized Agent Skills');
      expect(prompt).toContain('api-contract-review');
      expect(prompt).toContain('extension-managed Claude plugin');
      expect(prompt).toContain('/unode-agent-claude-1:api-contract-review');
      expect(prompt).not.toContain('load_skill');
    } finally {
      await backend.stop(50);
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('mounts the skill plugin for a folder-scoped READ+WRITE agent (shell restricted, writes allowed)', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-skills-rw-'));
    const spawn = fakeSpawn();
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ workingDirectory: workspace, allowedTools: ['read', 'write', 'execute'], playbooks: ['api-contract-review'] }),
      undefined,
      undefined,
      // Explicit folderAccess ⇒ restrictShell, but a non-empty writeRoots ⇒ NOT read-only.
      { spawn: spawn.fn as any, skillRegistry: registry, writeRoots: [workspace], restrictShell: true }
    );

    try {
      await backend.start({} as NodeJS.ProcessEnv);
      const args = spawn.calls[0].args;
      expect(args).toContain('Bash'); // shell still removed for a folder-scoped agent
      expect(args).toContain('PowerShell');
      expect(args).not.toContain('Agent');
      expect(args).not.toContain('Workflow');
      expect(args).toContain('--plugin-dir'); // but skills survive the folder scope
    } finally {
      await backend.stop(50);
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe('ClaudeHeadlessBackend streaming events', () => {
  it('asks claude for partial stream-json messages', async () => {
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer' }),
      undefined,
      undefined,
      { spawn: spawn.fn as any }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    expect(spawn.calls[0].args).toContain('--include-partial-messages');
  });

  it('maps stream_event text and thinking deltas', () => {
    const backend = new ClaudeHeadlessBackend(makeConfig());
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    (backend as any).handleEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } },
    });
    (backend as any).handleEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'why' } },
    });
    expect(() => (backend as any).handleEvent({ type: 'stream_event', event: { type: 'message_stop' } })).not.toThrow();

    expect(events).toEqual([
      { kind: 'assistant_delta', delta: 'hel' },
      { kind: 'reasoning_delta', delta: 'why' },
    ]);
  });

  it('correlates tool_result blocks back to the preceding tool_use name', () => {
    const backend = new ClaudeHeadlessBackend(makeConfig());
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    (backend as any).handleEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
    });
    (backend as any).handleEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'failed loudly', is_error: true }] },
    });

    expect(events).toContainEqual({ kind: 'tool_use', name: 'Bash', input: { command: 'npm test' } });
    expect(events).toContainEqual({
      kind: 'tool_result',
      name: 'Bash',
      ok: false,
      summary: 'failed loudly',
      detail: 'failed loudly',
    });
  });

  it('records the current failed verification rather than a preceding passing Bash result', () => {
    const backend = new ClaudeHeadlessBackend(makeConfig());
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    (backend as any).handleEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'check-pass', name: 'Bash', input: { command: 'npm test' } }] },
    });
    (backend as any).handleEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'check-pass', content: 'passed' }] },
    });
    (backend as any).handleEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'check-fail', name: 'Bash', input: { command: 'npm test' } }] },
    });
    (backend as any).handleEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'check-fail', content: 'failed', is_error: true }] },
    });
    (backend as any).handleEvent({ type: 'result', subtype: 'success', result: 'done' });

    expect(events.find((event) => event.kind === 'turn_complete')?.result.delegationEvidence?.verification)
      .toEqual({ ran: true, passed: false });
  });

  it('does not continue a Claude coordinator turn for a settled-but-undisposed result', () => {
    const unsettled = true;
    const bridge = {
      coordinatorCloseoutState: () => ({
        settledButUndisposed: unsettled ? 1 : 0,
        acceptedButUngated: 0,
        idleWithNoLiveWork: 0,
        hasLiveDelegationWork: false,
        hasVerificationPath: true,
      }),
    } as unknown as TeamMcpBridge;
    const backend = new ClaudeHeadlessBackend(makeConfig({ role: 'pm' }), undefined, undefined, { teamMcpBridge: bridge });
    const writes: string[] = [];
    (backend as any).proc = { stdin: { write: (text: string) => { writes.push(text); return true; } } };
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    (backend as any).handleEvent({ type: 'result', subtype: 'success', result: 'Checks passed; stopping.' });
    expect(events.some((event) => event.kind === 'turn_complete')).toBe(true);
    expect(writes).toHaveLength(0);

  });

  it('does not nudge or host-close a Claude coordinator while another delegation is live', () => {
    const bridge = {
      coordinatorCloseoutState: () => ({
        settledButUndisposed: 1,
        acceptedButUngated: 0,
        idleWithNoLiveWork: 0,
        hasLiveDelegationWork: true,
        hasVerificationPath: true,
        assignmentOpen: true,
        assignmentClosed: false,
      }),
    } as unknown as TeamMcpBridge;
    const backend = new ClaudeHeadlessBackend(makeConfig({ role: 'pm' }), undefined, undefined, { teamMcpBridge: bridge });
    const writes: string[] = [];
    (backend as any).proc = { stdin: { write: (text: string) => { writes.push(text); return true; } } };
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    (backend as any).handleEvent({ type: 'result', subtype: 'success', result: 'One result arrived; another is still working.' });

    expect(writes).toHaveLength(0);
    expect(events.find((event) => event.kind === 'turn_complete')).toMatchObject({
      result: { text: 'One result arrived; another is still working.' },
    });
  });

  it('never turns repeated native execution attempts into a coordinator bounce-count escape', async () => {
    const bridge = {
      hasTeammates: () => true,
      currentCoordinatorTaskAttempt: () => undefined,
      canCoordinatorExecute: () => false,
    } as unknown as TeamMcpBridge;
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'pm', allowedTools: ['read', 'write', 'execute'] }),
      undefined,
      undefined,
      { teamMcpBridge: bridge },
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect((backend as any).decidePreToolUse('Write', {
        file_path: 'src/example.ts',
        content: 'blocked',
      })).resolves.toMatchObject({
        allow: false,
        note: expect.stringMatching(/strict task contract.*no bounce-count escape hatch/is),
      });
    }
  });

  it('does not continue a Claude coordinator turn for a file-changing acceptance with no passing check', () => {
    const acceptedButUngated = true;
    const bridge = {
      coordinatorCloseoutState: () => ({
        settledButUndisposed: 0,
        acceptedButUngated: acceptedButUngated ? 1 : 0,
        idleWithNoLiveWork: 0,
        hasLiveDelegationWork: false,
        hasVerificationPath: true,
      }),
    } as unknown as TeamMcpBridge;
    const backend = new ClaudeHeadlessBackend(makeConfig({ role: 'pm' }), undefined, undefined, { teamMcpBridge: bridge });
    const writes: string[] = [];
    (backend as any).proc = { stdin: { write: (text: string) => { writes.push(text); return true; } } };
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    (backend as any).handleEvent({ type: 'result', subtype: 'success', result: 'Accepted the changed file; stopping before checks.' });
    expect(events.some((event) => event.kind === 'turn_complete')).toBe(true);
    expect(writes).toHaveLength(0);

  });

  it('appends the shared host closeout when a Claude coordinator ends an open assignment without one', () => {
    const bridge = {
      coordinatorCloseoutState: () => ({
        settledButUndisposed: 0,
        acceptedButUngated: 0,
        idleWithNoLiveWork: 0,
        assignmentOpen: true,
        assignmentClosed: false,
      }),
    } as unknown as TeamMcpBridge;
    const backend = new ClaudeHeadlessBackend(makeConfig({ role: 'pm' }), undefined, undefined, { teamMcpBridge: bridge });
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    (backend as any).handleEvent({ type: 'result', subtype: 'success', result: 'The worker result is available.' });

    const complete = events.find((event) => event.kind === 'turn_complete');
    expect(complete?.result.text).toContain('Closeout (written by UnodeAi, not by the coordinator)');
    expect(complete?.result.text).toContain('This assignment ended without a stated conclusion or any recorded delegation decision.');
  });

  it('stays quiet when the Claude coordinator already closed its assignment', () => {
    const bridge = {
      coordinatorCloseoutState: () => ({
        settledButUndisposed: 0,
        acceptedButUngated: 0,
        idleWithNoLiveWork: 0,
        assignmentOpen: true,
        assignmentClosed: true,
      }),
    } as unknown as TeamMcpBridge;
    const backend = new ClaudeHeadlessBackend(makeConfig({ role: 'pm' }), undefined, undefined, { teamMcpBridge: bridge });
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    (backend as any).handleEvent({ type: 'result', subtype: 'success', result: 'Closed: partial.' });

    expect(events.find((event) => event.kind === 'turn_complete')?.result.text).toBe('Closed: partial.');
  });

  it('publishes a host receipt instead of Claude\'s unconstrained terminal prose', () => {
    const bridge = {
      takePublishedTurnDelivery: () => ({
        text: 'The requested document is here:\n\nExact source',
        state: 'shown',
        receiptId: 'receipt-test',
      }),
      hasPendingTurnDelivery: () => false,
      coordinatorCloseoutState: () => undefined,
    } as unknown as TeamMcpBridge;
    const backend = new ClaudeHeadlessBackend(makeConfig({ role: 'pm' }), undefined, undefined, { teamMcpBridge: bridge });
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    // A text block can arrive before the MCP tool result that accepts publication. Once a local read has
    // issued a receipt, it must be buffered too, or the raw claim is already user-visible when the host
    // later replaces it.
    (backend as any).mayPublishContentReceipt = true;
    (backend as any).handleEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'I showed the document.' }] } });
    (backend as any).handleEvent({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'I showed the document.' } } });
    expect(events).toEqual([]);
    (backend as any).handleEvent({ type: 'result', subtype: 'success', result: 'I showed the document.' });

    expect(events.filter((event) => event.kind === 'assistant')).toEqual([{
      kind: 'assistant', text: 'The requested document is here:\n\nExact source',
    }]);
    expect(events.filter((event) => event.kind === 'assistant_delta')).toEqual([{
      kind: 'assistant_delta', delta: 'The requested document is here:\n\nExact source',
    }]);
    expect(events.find((event) => event.kind === 'turn_complete')?.result.text)
      .toBe('The requested document is here:\n\nExact source');
  });

  it('detects Claude native Agent/Workflow tool use once without claiming to gate it', () => {
    const reports: Array<{ tool: string; agentName: string }> = [];
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ name: 'Program Manager' }),
      undefined,
      undefined,
      { onUnmediatedToolUse: (tool, agentName) => reports.push({ tool, agentName }) }
    );
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    (backend as any).handleEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { prompt: 'delegate' } },
          { type: 'tool_use', id: 'toolu_workflow', name: 'Workflow', input: { prompt: 'delegate again' } },
        ],
      },
    });

    expect(reports).toEqual([{ tool: 'Agent', agentName: 'Program Manager' }]);
    expect(events).toContainEqual({
      kind: 'log',
      stream: 'stderr',
      line: expect.stringContaining('Program Manager used Claude native Agent'),
    });
    expect(events.filter((event) => event.kind === 'tool_use').map((event) => event.name)).toEqual(['Agent', 'Workflow']);
  });

  it('flattens array tool_result content', () => {
    const backend = new ClaudeHeadlessBackend(makeConfig());
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    (backend as any).handleEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'a.ts' } }] },
    });
    (backend as any).handleEvent({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
        }],
      },
    });

    expect(events.find((event) => event.kind === 'tool_result')).toMatchObject({
      name: 'Read',
      ok: true,
      summary: 'line one line two',
      detail: 'line one\nline two',
    });
  });

  it('records a native Read receipt only after its successful tool_result and by physical identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-read-receipt-'));
    const store = new ContentAssetStore();
    try {
      await fs.writeFile(path.join(root, 'brief.md'), 'DECLARED', 'utf8');
      const resolver = new TaskInputResolver(store, root);
      const parsed = compileTaskContract({
        version: 1,
        objective: 'Read the declared brief and report it.',
        expected_deliverable: 'A bounded review.',
        effects: { read_files: ['brief.md'], expected_file_effect: 'none' },
        inputs: [{
          input_id: 'brief', kind: 'workspacePath', path: 'brief.md', purpose: 'Review baseline',
          required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
        }],
        constraints: [],
        dependencies: [],
        required_capabilities: { version: 1, capabilities: ['read'] },
        execution_strategy: 'delegate-required',
      }, 'pm');
      expect(parsed.contract).toBeDefined();
      const attempt = await resolver.beginAttempt(parsed.contract!, {
        agentId: 'claude-1',
        workspaceRoot: root,
        capabilities: { read: true, write: false, shell: false },
        taskScope: 'fixed-session-only',
        verificationSensors: [],
        authorizedContentAssetIds: [],
        liveContentAssetIds: [],
        readyArtifacts: [],
      }, 'pm');
      const backend = new ClaudeHeadlessBackend(makeConfig({ workingDirectory: root }), undefined, undefined, {
        taskInputResolver: resolver,
      });
      (backend as any).activeTaskAttempt = attempt.card;

      await (backend as any).handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'failed-read', name: 'Read', input: { file_path: 'brief.md' } }] },
      });
      await (backend as any).handleEvent({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'failed-read', content: 'failed', is_error: true }] },
      });
      expect(resolver.grantsForAttempt(attempt.card!.attemptId)[0].readAt).toBeUndefined();

      await (backend as any).handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'successful-read', name: 'Read', input: { file_path: path.join(root, 'brief.md') } }] },
      });
      await (backend as any).handleEvent({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'successful-read', content: 'DECLARED' }] },
      });
      expect(resolver.grantsForAttempt(attempt.card!.attemptId)[0].readAt).toEqual(expect.any(String));
    } finally {
      await store.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('Anthropic reports usage the OPPOSITE way round from OpenAI-compatible providers', () => {
  it('counts cache_creation + cache_read into inputTokens — input_tokens alone is only the uncached remainder', async () => {
    // Anthropic: real prompt size = input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
    // Reading input_tokens alone made a Claude agent with a high hit rate look like it had barely used any
    // context. (On the OpenAI side the trap is inverted — prompt_tokens INCLUDES the cached part, so there
    // you must SUBTRACT or you double-count. Same bug class, opposite sign.)
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(makeConfig(), undefined, undefined, { spawn: spawn.fn as any });
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    await backend.start({} as NodeJS.ProcessEnv);
    (backend as any).handleEvent({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      usage: {
        input_tokens: 500,                    // the uncached remainder ONLY
        cache_read_input_tokens: 90_000,      // served from the prefix cache
        cache_creation_input_tokens: 9_500,   // written to it (costs 1.25x — NOT a discount)
        output_tokens: 300,
      },
      total_cost_usd: 0.0431,
    });

    const usage = events.find((e) => e.kind === 'turn_complete').result.usage;
    expect(usage.inputTokens, 'input_tokens alone would have reported 500 of a 100,000-token prompt')
      .toBe(100_000);
    // Only the READS are a discount. A cache write costs 1.25x on Anthropic and must not be counted as one.
    expect(usage.cachedInputTokens).toBe(90_000);
    expect(usage.outputTokens).toBe(300);
    expect(usage.costUsd).toBe(0.0431);   // the CLI's own billed figure stays authoritative
  });
});

describe('ClaudeHeadlessBackend cost basis', () => {
  it('marks Claude CLI costs as API-equivalent without ANTHROPIC_API_KEY', async () => {
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(makeConfig(), undefined, undefined, { spawn: spawn.fn as any });
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    await backend.start({} as NodeJS.ProcessEnv);
    (backend as any).handleEvent({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      usage: { input_tokens: 2, output_tokens: 3 },
      total_cost_usd: 0.0431,
    });

    expect(events.find((event) => event.kind === 'turn_complete')).toMatchObject({
      result: { usage: { costUsd: 0.0431, costBasis: 'api-equivalent' } },
    });
  });

  it('marks Claude costs as billed when ANTHROPIC_API_KEY is present', async () => {
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(makeConfig(), undefined, undefined, { spawn: spawn.fn as any });
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    await backend.start({ ANTHROPIC_API_KEY: 'sk-ant-test' } as NodeJS.ProcessEnv);
    (backend as any).handleEvent({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      usage: { input_tokens: 2, output_tokens: 3 },
      total_cost_usd: 0.0431,
    });

    expect(events.find((event) => event.kind === 'turn_complete')).toMatchObject({
      result: { usage: { costUsd: 0.0431, costBasis: 'billed' } },
    });
  });
});

describe('ClaudeHeadlessBackend command-permission gate (unify with unode.commandApproval)', () => {
  it('mounts a per-agent permission server + --permission-prompt-tool (acceptEdits)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-claude-perm-'));
    const perm = fakeLocalServer();
    const spawn = fakeSpawn();
    const approvals: string[] = [];
    const backend = new ClaudeHeadlessBackend(
      makeConfig({
        role: 'developer',
        name: 'Senior Developer',
        workingDirectory: dir,
        autoApprove: false,
        allowedTools: ['read', 'write', 'execute'],
      }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        commandPermission: {
          policy: new CommandPolicy('ask', ['npm test']),
          requestApproval: async (c) => { approvals.push(c); return { allow: true }; },
          createServer: () => perm,
        },
      }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    const args = spawn.calls[0].args;
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args).toContain('--permission-prompt-tool');
    expect(args).toContain('mcp__unode_permission__permission_prompt');
    expect(args).toContain('--allowedTools');

    expect(perm.starts).toBe(1);
    expect(perm.localTools.map((t) => t.name)).toEqual(['permission_prompt']);
    const written = JSON.parse(await fs.readFile(path.join(dir, '.unode', 'mcp.json'), 'utf8'));
    expect(written.mcpServers.unode_permission).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:48123/mcp',
      headers: { Authorization: 'Bearer test-token' },
    });

    // The registered handler routes to the decider: allowlisted → allow silently; else → prompt.
    const handler = perm.localTools[0].handler;
    expect(JSON.parse(await handler({ tool_name: 'Bash', input: { command: 'npm test' } })).behavior).toBe('allow');
    expect(approvals).toEqual([]); // npm test is allowlisted → not prompted
    expect(JSON.parse(await handler({ tool_name: 'Bash', input: { command: 'npm install x' } })).behavior).toBe('allow');
    expect(approvals).toEqual(['npm install x']); // non-allowlisted → prompted (and approved here)

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('omits the gate entirely for an autoApprove (bypassPermissions) agent', async () => {
    const perm = fakeLocalServer();
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer', autoApprove: true, allowedTools: ['read', 'write', 'execute'] }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        commandPermission: { policy: new CommandPolicy('ask', []), requestApproval: async () => ({ allow: true }), createServer: () => perm },
      }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    const args = spawn.calls[0].args;
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(args).not.toContain('--permission-prompt-tool');
    expect(perm.starts).toBe(0); // never mounted — claude wouldn't call it in bypass mode
  });

  it('refuses to start rather than run without its required PreToolUse settings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-claude-nowrite-'));
    const filePath = path.join(dir, 'cwd-is-a-file');
    await fs.writeFile(filePath, 'x'); // workingDirectory is a FILE → .unode/mcp.json write fails
    const perm = fakeLocalServer();
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer', workingDirectory: filePath, autoApprove: false }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        commandPermission: { policy: new CommandPolicy('ask', []), requestApproval: async () => ({ allow: true }), createServer: () => perm },
      }
    );

    await expect(backend.start({} as NodeJS.ProcessEnv)).rejects.toThrow(/failed to write required PreToolUse (wrapper|settings)/);
    expect(spawn.calls).toHaveLength(0);
    expect(perm.starts).toBe(0); // settings fail before any MCP bridge is started

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('cleans up the permission server + config file when claude fails to spawn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-claude-spawnerr-'));
    const perm = fakeLocalServer();
    const spawn = fakeSpawnError();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer', workingDirectory: dir, autoApprove: false }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        commandPermission: { policy: new CommandPolicy('ask', []), requestApproval: async () => ({ allow: true }), createServer: () => perm },
      }
    );

    await expect(backend.start({} as NodeJS.ProcessEnv)).rejects.toThrow(/ENOENT/);

    expect(perm.starts).toBe(1);
    expect(perm.stops).toBe(1); // exit handler never fires on spawn error → explicit cleanup must run
    await expect(fs.access(path.join(dir, '.unode', 'mcp.json'))).rejects.toBeTruthy(); // config removed

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stops the permission server when the backend stops', async () => {
    const perm = fakeLocalServer();
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer', autoApprove: false }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        commandPermission: { policy: new CommandPolicy('ask', []), requestApproval: async () => ({ allow: true }), createServer: () => perm },
      }
    );
    await backend.start({} as NodeJS.ProcessEnv);

    await backend.stop(50);

    expect(perm.stops).toBe(1);
  });

  it('forces the permission gate and denies native write tools for read-only folder access', async () => {
    const perm = fakeLocalServer();
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer', autoApprove: true, allowedTools: ['read', 'write', 'execute'] }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        writeRoots: [],
        commandPermission: { policy: new CommandPolicy('all'), requestApproval: async () => ({ allow: true }), createServer: () => perm },
      }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    const args = spawn.calls[0].args;
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    const disallowedIndex = args.indexOf('--disallowedTools');
    expect(disallowedIndex).toBeGreaterThanOrEqual(0);
    expect(args.slice(disallowedIndex + 1, disallowedIndex + 1 + READ_ONLY_SCOPE_DISALLOWED_TOOLS.length)).toEqual(READ_ONLY_SCOPE_DISALLOWED_TOOLS);
    expect(args).toContain('Agent');
    expect(args).toContain('Workflow');
    expect(args).toContain('ToolSearch');
    expect(args).toContain('--permission-prompt-tool');
    const handler = perm.localTools[0].handler;
    expect(JSON.parse(await handler({ tool_name: 'Write', input: { file_path: 'x.ts' } })).behavior).toBe('deny');
    expect(JSON.parse(await handler({ tool_name: 'Bash', input: { command: 'echo hi' } })).behavior).toBe('deny');
    expect(JSON.parse(await handler({ tool_name: 'EnterWorktree', input: {} })).behavior).toBe('deny');
    expect(JSON.parse(await handler({ tool_name: 'Agent', input: { prompt: 'delegate' } })).behavior).toBe('deny');
    expect(JSON.parse(await handler({ tool_name: 'ToolSearch', input: { query: 'worktree' } })).behavior).toBe('deny');
    expect(JSON.parse(await handler({ tool_name: 'mcp__unode_files__read_file', input: { path: 'x.ts' } })).behavior).toBe('allow');
  });

  it('enforces the role tool ceiling on Claude native Write and Bash tools', async () => {
    const perm = fakeLocalServer();
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ autoApprove: true, allowedTools: ['read'] }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        writeRoots: ['C:\\workspace'],
        commandPermission: { policy: new CommandPolicy('all'), createServer: () => perm },
      }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    const args = spawn.calls[0].args;
    const disallowedIndex = args.indexOf('--disallowedTools');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args.slice(disallowedIndex + 1, disallowedIndex + 1 + READ_ONLY_SCOPE_DISALLOWED_TOOLS.length)).toEqual(READ_ONLY_SCOPE_DISALLOWED_TOOLS);
    expect(args).toContain('Agent');
    expect(args).toContain('Workflow');
    expect(args).toContain('ToolSearch');
    const handler = perm.localTools[0].handler;
    expect(JSON.parse(await handler({ tool_name: 'Write', input: { file_path: 'x.ts' } })).behavior).toBe('deny');
    expect(JSON.parse(await handler({ tool_name: 'Bash', input: { command: 'echo hi' } })).behavior).toBe('deny');
    expect(JSON.parse(await handler({ tool_name: 'EnterWorktree', input: {} })).behavior).toBe('deny');
    expect(JSON.parse(await handler({ tool_name: 'Workflow', input: { prompt: 'delegate' } })).behavior).toBe('deny');
  });

  it('removes Monitor and TaskCreate before a read-only connection can be offered them', async () => {
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ autoApprove: true, allowedTools: ['read'] }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, writeRoots: ['C:\\workspace'] }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    const args = spawn.calls[0].args;
    const disallowedAt = args.indexOf('--disallowedTools');
    expect(disallowedAt).toBeGreaterThanOrEqual(0);
    expect(args.slice(disallowedAt + 1)).toEqual(expect.arrayContaining(['Monitor', 'TaskCreate']));
  });

  it('treats an untrusted workspace as a no-write Claude scope at the inherited CLI layer', async () => {
    const perm = fakeLocalServer();
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ autoApprove: true, allowedTools: ['read', 'write', 'execute'] }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        writeRoots: ['C:\\workspace'],
        commandPermission: { policy: new CommandPolicy('all'), createServer: () => perm, isTrusted: () => false },
      }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    const args = spawn.calls[0].args;
    const disallowedIndex = args.indexOf('--disallowedTools');
    expect(disallowedIndex).toBeGreaterThanOrEqual(0);
    expect(args.slice(disallowedIndex + 1, disallowedIndex + 1 + READ_ONLY_SCOPE_DISALLOWED_TOOLS.length)).toEqual(READ_ONLY_SCOPE_DISALLOWED_TOOLS);
  });

  it('disables Bash for an explicit folder scope even when the role normally allows execute', async () => {
    const perm = fakeLocalServer();
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ autoApprove: true, allowedTools: ['read', 'write', 'execute'] }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        writeRoots: ['C:\\workspace'],
        restrictShell: true,
        commandPermission: { policy: new CommandPolicy('all'), createServer: () => perm },
      }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    const args = spawn.calls[0].args;
    const disallowedIndex = args.indexOf('--disallowedTools');
    expect(args.slice(disallowedIndex + 1)).toContain('Bash');
    expect(args.slice(disallowedIndex + 1)).toContain('PowerShell');
    expect(args.slice(disallowedIndex + 1)).not.toContain('Agent');
    expect(args.slice(disallowedIndex + 1)).not.toContain('Workflow');
    expect(args.slice(disallowedIndex + 1)).not.toContain('Write');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });

  it('does not pass --disallowedTools for a trusted write+execute Claude agent by default', async () => {
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ autoApprove: true, allowedTools: ['read', 'write', 'execute'] }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, writeRoots: ['C:\\workspace'] }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    expect(spawn.calls[0].args).not.toContain('--disallowedTools');
  });

  it('disables Claude native Agent/Workflow only when the user opts in for that agent', async () => {
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({
        autoApprove: true,
        allowedTools: ['read', 'write', 'execute'],
        disableNativeSubagents: true,
      }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, writeRoots: ['C:\\workspace'] }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    const args = spawn.calls[0].args;
    const disallowedIndex = args.indexOf('--disallowedTools');
    expect(disallowedIndex).toBeGreaterThanOrEqual(0);
    expect(args.slice(disallowedIndex + 1, disallowedIndex + 3)).toEqual(['Agent', 'Workflow']);
  });

  it('refuses to start a Claude agent with multiple writable folder roots', async () => {
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer' }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, writeRoots: ['C:\\one', 'C:\\two'] }
    );

    await expect(backend.start({} as NodeJS.ProcessEnv)).rejects.toThrow(/single writable folder/);
    expect(spawn.calls).toHaveLength(0);
  });
});

describe('ClaudeHeadlessBackend fail-closed PreToolUse gate', () => {
  it('starts a token-authenticated matcher-* gate and never puts its credentials on argv', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-gate-'));
    const gate = fakeLocalServer();
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ workingDirectory: dir, allowedTools: ['read', 'write', 'execute'] }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, toolGateServerFactory: () => gate }
    );

    try {
      await backend.start({} as NodeJS.ProcessEnv);
      const args = spawn.calls[0].args;
      expect(gate.starts).toBe(1);
      expect(args).toEqual(expect.arrayContaining(['--settings', '.unode/claude-tool-gate.json']));
      expect(args.join(' ')).not.toContain('test-token');
      expect(args).not.toContain('--bare');
      expect(args).not.toContain('--dangerously-bypass-hook-trust');
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');

      const settings = JSON.parse(await fs.readFile(path.join(dir, '.unode', 'claude-tool-gate.json'), 'utf8'));
      const hook = settings.hooks.PreToolUse[0];
      expect(hook.matcher).toBe('*');
      const wrapperName = process.platform === 'win32' ? 'claude-tool-gate.cmd' : 'claude-tool-gate.sh';
      expect(hook.hooks[0]).toEqual({
        type: 'command',
        command: expect.stringContaining(wrapperName),
        // Claude's seconds-valued hook timeout keeps its 10-second safety margin beyond the human window.
        timeout: 910,
      });
      expect(hook.hooks[0].env).toBeUndefined(); // an env property makes -p silently ignore the settings file
      const wrapper = await fs.readFile(path.join(dir, '.unode', wrapperName), 'utf8');
      expect(wrapper).toContain(process.platform === 'win32' ? 'set "ELECTRON_RUN_AS_NODE=1"' : 'export ELECTRON_RUN_AS_NODE=1');
      // Quoting differs by platform — cmd writes set "VAR=value", sh writes export VAR='value'. Assert the
      // variable and its value, not one platform's quoting, or CI (ubuntu) fails while Windows passes.
      expect(wrapper).toMatch(/UNODE_CLAUDE_TOOL_GATE_URL=['"]?http:\/\/127\.0\.0\.1:48123\/gate['"]?/);
      expect(wrapper).toMatch(/UNODE_CLAUDE_TOOL_GATE_TOKEN=['"]?test-token['"]?/);
      // A user may send a task and work elsewhere; this human window is deliberately generous.
      expect(wrapper).toMatch(/UNODE_CLAUDE_TOOL_GATE_TIMEOUT_MS=['"]?900000['"]?/);
      expect(wrapper).toMatch(/UNODE_CLAUDE_TOOL_GATE_LIVENESS_MS=['"]?3000['"]?/);
      expect(wrapper).toContain(process.platform === 'win32' ? 'if errorlevel 1 exit /b 2' : 'exit 2');
      expect(gate.jsonEndpoints.map((endpoint) => endpoint.path)).toEqual(['/gate']);
    } finally {
      await backend.stop(50);
      expect(existsSync(path.join(dir, '.unode', 'claude-tool-gate.json'))).toBe(false);
      expect(existsSync(path.join(dir, '.unode', process.platform === 'win32' ? 'claude-tool-gate.cmd' : 'claude-tool-gate.sh'))).toBe(false);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to start before spawning Claude when the required hook asset is missing', async () => {
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig(),
      undefined,
      undefined,
      { spawn: spawn.fn as any, toolGateScriptPath: path.join(os.tmpdir(), 'missing-unode-claude-tool-gate.cjs') }
    );

    await expect(backend.start({} as NodeJS.ProcessEnv)).rejects.toThrow(/required fail-closed PreToolUse hook is unreadable/);
    expect(spawn.calls).toHaveLength(0);
  });

  it('checks the final route boundary before the Claude process spawns', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-route-boundary-'));
    const denied = fakeSpawn();
    const hook = path.resolve(process.cwd(), 'src', 'claudeToolGate.cjs');
    const rejected = new ClaudeHeadlessBackend(
      makeConfig({ workingDirectory: dir }),
      undefined,
      undefined,
      {
        spawn: denied.fn as any,
        toolGateScriptPath: hook,
        assertResolvedRoute: () => { throw new Error('Resolved route boundary mismatch: backend.'); },
      }
    );
    try {
      await expect(rejected.start({} as NodeJS.ProcessEnv)).rejects.toThrow(/Resolved route boundary mismatch/);
      expect(denied.calls).toHaveLength(0);

      const allowed = fakeSpawn();
      const positive = new ClaudeHeadlessBackend(
        makeConfig({ workingDirectory: dir }),
        undefined,
        undefined,
        { spawn: allowed.fn as any, toolGateScriptPath: hook, assertResolvedRoute: () => undefined }
      );
      await positive.start({} as NodeJS.ProcessEnv);
      expect(allowed.calls).toHaveLength(1);
      await positive.stop(50);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('acknowledges an open egress-consent decision before waiting for it or spawning Claude (B6)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-egress-consent-'));
    const spawn = fakeSpawn();
    let allow!: () => void;
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ workingDirectory: dir }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        toolGateScriptPath: path.resolve(process.cwd(), 'src', 'claudeToolGate.cjs'),
        onBeforeEgress: async (onPending) => {
          onPending({
            host: 'api.anthropic.com',
            message: 'Consent required to contact api.anthropic.com. Respond to the open UnodeAi network-consent dialog to continue this agent.',
          });
          await new Promise<void>((resolve) => { allow = resolve; });
        },
      }
    );
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));

    try {
      const starting = backend.start({} as NodeJS.ProcessEnv);
      await Promise.resolve();

      expect(events).toContainEqual(expect.objectContaining({ kind: 'consent_required', message: expect.stringContaining('Respond to the open') }));
      expect(spawn.calls).toHaveLength(0);

      allow();
      await starting;
      expect(spawn.calls).toHaveLength(1);
    } finally {
      await backend.stop(50);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not spawn Claude if the user cancels the session while its consent dialog is still open (B6)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-egress-cancel-'));
    const spawn = fakeSpawn();
    let allow!: () => void;
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ workingDirectory: dir }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        toolGateScriptPath: path.resolve(process.cwd(), 'src', 'claudeToolGate.cjs'),
        onBeforeEgress: async (onPending) => {
          onPending({ host: 'api.anthropic.com', message: 'Consent required.' });
          await new Promise<void>((resolve) => { allow = resolve; });
        },
      }
    );

    try {
      const starting = backend.start({} as NodeJS.ProcessEnv);
      await Promise.resolve();
      await backend.stop();
      allow();

      await expect(starting).rejects.toThrow(/cancelled before egress consent completed/);
      expect(spawn.calls).toHaveLength(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('routes shell policy and unknown-tool decisions through the hook endpoint, remembering an explicit answer', async () => {
    const gate = fakeLocalServer();
    const spawn = fakeSpawn();
    const approvals: string[] = [];
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ allowedTools: ['read', 'write', 'execute'] }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        toolGateServerFactory: () => gate,
        commandPermission: { policy: new CommandPolicy('none') },
        requestToolApproval: async (request) => {
          approvals.push(request.toolName);
          return { allow: true, remember: true };
        },
      }
    );

    try {
      await backend.start({} as NodeJS.ProcessEnv);
      const route = gate.jsonEndpoints.find((endpoint) => endpoint.path === '/gate')!;
      expect(await route.handler({ tool_name: 'Bash', tool_input: { command: 'echo no' } })).toMatchObject({ allow: false });
      expect(await route.handler({ tool_name: 'FutureClaudeTool', tool_input: {} })).toMatchObject({ allow: true });
      expect(await route.handler({ tool_name: 'FutureClaudeTool', tool_input: {} })).toMatchObject({ allow: true });
      expect(await route.handler({ tool_name: 'mcp__unode_team_bridge__list_agents', tool_input: {} })).toMatchObject({ allow: true });
      expect(await route.handler({ tool_name: 'mcp__unode_evil__write', tool_input: {} })).toMatchObject({ allow: true });
      expect(approvals).toEqual(['FutureClaudeTool', 'mcp__unode_evil__write']);
      expect(await route.handler({ tool_name: 'Unknown', tool_input: 'not-an-object' })).toMatchObject({ allow: false });
    } finally {
      await backend.stop(50);
    }
  });

  it('uses the same public-web policy for Claude WebFetch, independent of folder write scope', async () => {
    const gate = fakeLocalServer();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ allowedTools: ['read'], workingDirectory: process.cwd() }),
      undefined,
      undefined,
      {
        spawn: fakeSpawn().fn as any,
        toolGateServerFactory: () => gate,
        writeRoots: [],
        webAccess: {
          policy: () => 'allow',
          requestApproval: async () => ({ allow: false }),
        },
      }
    );

    try {
      await backend.start({} as NodeJS.ProcessEnv);
      const route = gate.jsonEndpoints.find((endpoint) => endpoint.path === '/gate')!;
      await expect(route.handler({ tool_name: 'WebFetch', tool_input: { url: 'https://example.test' } }))
        .resolves.toMatchObject({ allow: true });
      await expect(route.handler({ tool_name: 'WebSearch', tool_input: { query: 'unode' } }))
        .resolves.toMatchObject({ allow: true });
    } finally {
      await backend.stop(50);
    }
  });

  it('removes Claude web tools at launch when public-web policy is off, while keeping the denial truthful if invoked', async () => {
    const gate = fakeLocalServer();
    const spawn = fakeSpawn();
    let policyReads = 0;
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ allowedTools: ['read'], workingDirectory: process.cwd() }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        toolGateServerFactory: () => gate,
        writeRoots: [],
        webAccess: {
          policy: () => { policyReads++; return 'off'; },
          requestApproval: async () => ({ allow: true }),
        },
      }
    );

    try {
      await backend.start({} as NodeJS.ProcessEnv);
      const args = spawn.calls[0].args;
      const disallowedAt = args.indexOf('--disallowedTools');
      expect(disallowedAt).toBeGreaterThanOrEqual(0);
      expect(args.slice(disallowedAt + 1)).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
      expect(policyReads).toBe(1); // launch policy is snapshotted; the CLI's advertised set cannot change mid-session

      const route = gate.jsonEndpoints.find((endpoint) => endpoint.path === '/gate')!;
      const webDenied = await route.handler({ tool_name: 'WebFetch', tool_input: { url: 'https://example.test' } });
      expect(webDenied).toMatchObject({ allow: false, reason: 'Public web access is turned off by unode.webAccess.' });
      expect(String(webDenied.reason)).not.toMatch(/writable folder/i);
      const unknownDenied = await route.handler({ tool_name: 'FutureNativeTool', tool_input: {} });
      expect(unknownDenied).toMatchObject({
        allow: false,
        reason: expect.stringMatching(/unrecognized native tool.*read-only folder scope/i),
      });
      expect(String(unknownDenied.reason)).not.toMatch(/grant a writable folder/i);
    } finally {
      await backend.stop(50);
    }
  });

  it('removes Claude web tools when the agent ceiling cannot grant read access', async () => {
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ allowedTools: ['write'], workingDirectory: process.cwd() }),
      undefined,
      undefined,
      {
        spawn: spawn.fn as any,
        webAccess: {
          policy: () => 'ask',
          requestApproval: async () => ({ allow: true }),
        },
      }
    );

    try {
      await backend.start({} as NodeJS.ProcessEnv);
      const args = spawn.calls[0].args;
      const disallowedAt = args.indexOf('--disallowedTools');
      expect(args.slice(disallowedAt + 1)).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
    } finally {
      await backend.stop(50);
    }
  });

  it('returns a clean public-web denial when the human approval window lapses', async () => {
    const gate = fakeLocalServer();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ allowedTools: ['read'], workingDirectory: process.cwd() }),
      undefined,
      undefined,
      {
        spawn: fakeSpawn().fn as any,
        toolGateServerFactory: () => gate,
        humanApprovalTimeoutMs: 50,
        webAccess: {
          policy: () => 'ask',
          requestApproval: async () => await new Promise(() => undefined),
        },
      }
    );

    try {
      await backend.start({} as NodeJS.ProcessEnv);
      const route = gate.jsonEndpoints.find((endpoint) => endpoint.path === '/gate')!;
      await expect(route.handler({ tool_name: 'WebFetch', tool_input: { url: 'https://example.test' } }))
        .resolves.toMatchObject({
          allow: false,
          reason: expect.stringMatching(/Nobody approved WebFetch within 1 minutes/),
        });
    } finally {
      await backend.stop(50);
    }
  });

  it('keeps native write and Bash approvals reachable through the bounded hook decision path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-human-hook-'));
    const gate = fakeLocalServer();
    const commandApprovals: string[] = [];
    const writePreviews: Array<{ path: string; before: string | null; after: string }> = [];
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ allowedTools: ['read', 'write', 'execute'], workingDirectory: dir }),
      undefined,
      undefined,
      {
        spawn: fakeSpawn().fn as any,
        toolGateServerFactory: () => gate,
        commandPermission: {
          policy: new CommandPolicy('ask', []),
          requestApproval: async (command) => { commandApprovals.push(command); return { allow: true }; },
        },
        writeApprovalAsk: () => true,
        requestWriteApproval: async (preview) => { writePreviews.push(preview); return 'once'; },
      }
    );

    try {
      await backend.start({} as NodeJS.ProcessEnv);
      const route = gate.jsonEndpoints.find((endpoint) => endpoint.path === '/gate')!;
      await expect(route.handler({ tool_name: 'Write', tool_input: { file_path: 'note.txt', content: 'approved' } }))
        .resolves.toMatchObject({ allow: true });
      await expect(route.handler({ tool_name: 'Bash', tool_input: { command: 'echo approved' } }))
        .resolves.toMatchObject({ allow: true });
      expect(writePreviews).toEqual([{ path: 'note.txt', before: null, after: 'approved' }]);
      expect(commandApprovals).toEqual(['echo approved']);
    } finally {
      await backend.stop(50);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ClaudeHeadlessBackend does NOT widen Claude native file access (security invariant)', () => {
  // `claude --add-dir` grants read+write (subject to permission mode), so it CANNOT provide a read-only
  // root. Claude agents therefore stay scoped to their cwd — additional read roots reach only the
  // OpenAI-compat WorkspaceTools sandbox, never Claude's native runtime. Regression for the review finding.
  it('never passes --add-dir (no way to widen Claude access read-only)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-root-'));
    const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-extra-'));
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer', workingDirectory: dir }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, additionalReadRoots: [extra] }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    expect(spawn.calls[0].args).not.toContain('--add-dir');
    // The only dir claude sees is its cwd.
    expect(spawn.calls[0].args.join(' ')).not.toMatch(/--add-dir/);

    await backend.stop(50);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(extra, { recursive: true, force: true });
  });
});

describe('ClaudeHeadlessBackend read-only files bridge', () => {
  it('keeps its one-time tools/list schema, including task tools whose handlers still require a live attempt', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-files-root-'));
    const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-files-extra-'));
    await fs.writeFile(path.join(extra, 'lib.ts'), 'export const needle = 1;\n', 'utf8');
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer', workingDirectory: dir }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, additionalReadRoots: [extra] }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    const args = spawn.calls[0].args;
    expect(args).toEqual(expect.arrayContaining([
      '--allowedTools',
      'mcp__unode_files__read_file',
      'mcp__unode_files__list_dir',
      'mcp__unode_files__search_files',
      'mcp__unode_files__read_extracted_content',
      'mcp__unode_files__search_extracted_content',
    ]));
    expect(args).not.toContain('mcp__unode_files__write_file');

    const spec = await filesBridgeSpec(dir);
    const list = await rpcSpec(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = list.body.result.tools.map((t: any) => t.name);
    expect(names).toEqual([
      'read_file', 'list_dir', 'search_files', 'read_extracted_content', 'search_extracted_content',
      'select_workflow_branch', 'report_context_gap', 'publish_task_artifact',
    ]);
    const gapTool = list.body.result.tools.find((tool: any) => tool.name === 'report_context_gap');
    expect(gapTool.inputSchema.required).toEqual(['inputId']);
    expect(gapTool.inputSchema.properties).not.toHaveProperty('reason');
    for (const forbidden of ['write_file', 'apply_edit', 'delete_file', 'run_command']) {
      expect(names).not.toContain(forbidden);
    }

    const read = await rpcSpec(spec, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: path.join(extra, 'lib.ts') } },
    });
    expect(read.body.result.content[0].text).toContain('needle');

    const listed = await rpcSpec(spec, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_dir', arguments: { path: extra } },
    });
    expect(listed.body.result.content[0].text).toContain('lib.ts');

    const search = await rpcSpec(spec, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'search_files', arguments: { query: 'needle' } },
    });
    expect(search.body.result.content[0].text).toMatch(/lib\.ts:1:/);

    await backend.stop(50);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(extra, { recursive: true, force: true });
  });

  it('keeps the artifact handler guard on the frozen bridge when no task attempt is live', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-task-tool-'));
    const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-task-tool-extra-'));
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, dir);
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer', workingDirectory: dir }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, additionalReadRoots: [extra], taskInputResolver: resolver },
    );

    try {
      await backend.start({} as NodeJS.ProcessEnv);
      const spec = await filesBridgeSpec(dir);
      const list = await rpcSpec(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(list.body.result.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining([
        'report_context_gap', 'publish_task_artifact',
      ]));

      const artifact = await rpcSpec(spec, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'publish_task_artifact', arguments: { content: 'stale artifact' } },
      });
      expect(artifact.body.result.content[0].text).toBe(
        'publish_task_artifact refused: capability. Use an allowed tool or ask for the required capability.\n\n'
        + 'This tool is available only while executing a live contracted task attempt.',
      );
    } finally {
      await backend.stop(50);
      await store.dispose();
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(extra, { recursive: true, force: true });
    }
  });

  it('refuses outside paths and catches symlink escapes through the bridge', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-files-root-'));
    const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-files-extra-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-files-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret\n', 'utf8');
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer', workingDirectory: dir }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, additionalReadRoots: [extra] }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    const spec = await filesBridgeSpec(dir);
    const blocked = await rpcSpec(spec, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: path.join(outside, 'secret.txt') } },
    });
    expect(blocked.body.result.content[0].text).toMatch(/refused: workspace-escape/i);
    expect(blocked.body.result.content[0].text).not.toContain(outside);

    try {
      await fs.symlink(outside, path.join(extra, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      const escaped = await rpcSpec(spec, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: path.join(extra, 'escape', 'secret.txt') } },
      });
      expect(escaped.body.result.content[0].text).toMatch(/refused: workspace-escape/i);
      expect(escaped.body.result.content[0].text).not.toContain(outside);
    } finally {
      await backend.stop(50);
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(extra, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('does not mount the files bridge when there are no extra read roots', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-files-root-'));
    const spawn = fakeSpawn();
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer', workingDirectory: dir }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, additionalReadRoots: [] }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    expect(spawn.calls[0].args).not.toContain('--mcp-config');
    await expect(fs.access(path.join(dir, '.unode', 'mcp.json'))).rejects.toBeTruthy();

    await backend.stop(50);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('mounts only its own bounded conversation-log tools when the host supplies a bus', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-conversation-log-'));
    const spawn = fakeSpawn();
    const bus = new MessageBus();
    bus.send('user', 'claude-1', 'agent.message', { message: 'Use the green deployment decision.' });
    bus.send('user', 'other-agent', 'agent.message', { message: 'other agent private decision' });
    const backend = new ClaudeHeadlessBackend(
      makeConfig({ role: 'developer', workingDirectory: dir }),
      undefined,
      undefined,
      { spawn: spawn.fn as any, messageBus: bus }
    );

    await backend.start({} as NodeJS.ProcessEnv);

    expect(spawn.calls[0].args).toEqual(expect.arrayContaining([
      'mcp__unode_files__search_conversation_log',
      'mcp__unode_files__read_conversation_log',
    ]));
    const spec = await filesBridgeSpec(dir);
    const list = await rpcSpec(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.body.result.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining([
      'search_conversation_log', 'read_conversation_log',
    ]));
    const result = await rpcSpec(spec, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'search_conversation_log', arguments: { query: 'decision' } },
    });
    expect(result.body.result.content[0].text).toContain('green deployment decision');
    expect(result.body.result.content[0].text).not.toContain('other agent private decision');

    await backend.stop(50);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

function fakeBridge(): TeamMcpBridge {
  return {} as TeamMcpBridge;
}

function fakeLocalServer(): LocalMcpServer & {
  starts: number;
  stops: number;
  localTools: LocalMcpTool[];
  jsonEndpoints: LocalJsonEndpoint[];
} {
  return {
    port: 48123,
    token: 'test-token',
    starts: 0,
    stops: 0,
    localTools: [],
    jsonEndpoints: [],
    addLocalTool(tool) {
      this.localTools.push(tool);
    },
    addJsonEndpoint(endpoint) {
      this.jsonEndpoints.push(endpoint);
    },
    async start() {
      this.starts++;
    },
    async stop() {
      this.stops++;
    },
  };
}

function fakeSpawnError() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const proc = new EventEmitter() as any;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = { write: () => true, end: () => undefined };
    proc.kill = () => true;
    setTimeout(() => proc.emit('error', new Error('spawn claude ENOENT')), 0);
    return proc;
  };
  return { fn, calls };
}

function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const proc = new EventEmitter() as any;
    proc.pid = 1234;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = { write: () => true, end: () => undefined };
    proc.kill = () => {
      proc.exitCode = 0;
      proc.emit('exit', 0);
      return true;
    };
    setTimeout(() => proc.emit('spawn'), 0);
    return proc;
  };
  return { fn, calls };
}

async function filesBridgeSpec(dir: string): Promise<any> {
  const written = JSON.parse(await fs.readFile(path.join(dir, '.unode', 'mcp.json'), 'utf8'));
  expect(written.mcpServers[FILES_BRIDGE_SERVER_ID]).toBeTruthy();
  return written.mcpServers[FILES_BRIDGE_SERVER_ID];
}

function rpcSpec(spec: any, body: unknown): Promise<{ status: number; body: any }> {
  const url = new URL(spec.url);
  const auth = String(spec.headers?.Authorization ?? '');
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
  return post(Number(url.port), body, token);
}

function post(port: number, body: unknown, token: string | undefined): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (out += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out ? JSON.parse(out) : undefined }));
      }
    );
    req.on('error', reject);
    req.end(text);
  });
}

describe('tool gate script resolution (packaging layouts)', () => {
  // Regression: the bundled VSIX collapses every module into out/extension.js, so a single `..` guess
  // resolved to the EXTENSION ROOT and the hook was unreadable — Claude refused to start (fail-closed did
  // its job, but no Claude agent could run). Both layouts must resolve to out/claudeToolGate.cjs.
  it('resolves the hook in the BUNDLED layout (__dirname is out/)', () => {
    const bundledHook = path.resolve('/ext/out', 'claudeToolGate.cjs');
    const exists = (p: string) => p === bundledHook;
    expect(resolveToolGateScript('/ext/out', exists)).toBe(bundledHook);
  });

  it('resolves the hook in the UNBUNDLED layout (__dirname is out/backend/)', () => {
    const unbundledHook = path.resolve('/ext/out', 'claudeToolGate.cjs');
    const exists = (p: string) => p === unbundledHook;
    expect(resolveToolGateScript('/ext/out/backend', exists)).toBe(unbundledHook);
  });

  it('never silently resolves to the extension root (the shipped bug)', () => {
    const extensionRoot = path.resolve('/ext', 'claudeToolGate.cjs');
    const realHook = path.resolve('/ext/out', 'claudeToolGate.cjs');
    // Only the real hook exists; resolution from the bundled dir must NOT land on the extension root.
    expect(resolveToolGateScript('/ext/out', (p) => p === realHook)).not.toBe(extensionRoot);
  });
});
