/*
 * v0.9.99 (B11): chat and planning in a window with no folder. The OpenAI-compatible route runs with no file or
 * command tools, through the real backend and its real tool surface; a CLI route still needs a folder; the
 * extension's own guard is run from the actual source of extension.ts.
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { FOLDERLESS_UNAVAILABLE_REASON, folderlessChatAllowed, folderlessChatConfig } from '../FolderlessChat';
import { OpenAICompatBackend } from '../../backend/OpenAICompatBackend';
import { MessageBus } from '../../bus/MessageBus';
import { SessionManager } from '../../session/SessionManager';
import type { AgentConfig } from '../../types';
import type { AgentBackend, BackendEvent } from '../../backend/AgentBackend';

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'planner', name: 'Planner', role: 'custom', skill: '',
    provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' }, model: 'example-model', backend: 'openai-compat',
    systemPrompt: 'Plan.', autoApprove: true, allowedTools: ['read', 'write', 'execute'],
    mcpServers: ['files'], playbooks: ['api-contract-review'],
    folderAccess: [{ path: '/elsewhere', permission: 'readwrite' }],
    ...over,
  };
}
const FILE_AND_COMMAND_TOOL_NAMES = ['read_file', 'list_dir', 'search_files', 'fetch_url', 'write_file', 'apply_edit', 'apply_patch',
  'delete_file', 'delete_dir', 'save_attachment', 'write_document', 'run_command', 'check_command', 'kill_command', 'inspect_git_tag',
  'read_extracted_content', 'search_extracted_content'];

describe('the configuration an agent runs with without a folder', () => {
  it('has no file or command tools, no Folder Access, no integrations and no skills, in the transient root', () => {
    const config = agent();
    const folderless = folderlessChatConfig(config, '/tmp/unodeai-chat-x');
    expect(folderless).toMatchObject({ workingDirectory: '/tmp/unodeai-chat-x', allowedTools: [], mcpServers: [], playbooks: [] });
    expect(folderless.folderAccess).toBeUndefined();
    // The saved agent is unchanged.
    expect(config.allowedTools).toEqual(['read', 'write', 'execute']);
    // "Every tool" (no list) becomes no tool, and permissions that do not reach files survive.
    expect(folderlessChatConfig(agent({ allowedTools: undefined }), '/t').allowedTools).toEqual([]);
    expect(folderlessChatConfig(agent({ allowedTools: ['read', 'delegate'] }), '/t').allowedTools).toEqual(['delegate']);
  });

  it('only the OpenAI-compatible route runs without a folder', () => {
    expect(folderlessChatAllowed('openai-compat')).toBe(true);
    expect(folderlessChatAllowed('claude')).toBe(false);
    expect(folderlessChatAllowed('codex')).toBe(false);
    expect(folderlessChatAllowed(undefined)).toBe(false);
  });

  it('the real OpenAI-compatible backend then offers no file or command tool, and refuses one the model names anyway', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'unodeai-chat-test-'));
    const backend = new OpenAICompatBackend(folderlessChatConfig(agent(), root));
    const offered = (backend as any).tools.specs().map((spec: any) => spec.function.name);
    for (const name of FILE_AND_COMMAND_TOOL_NAMES) expect(offered).not.toContain(name);
    const write = await (backend as any).routeToolCall('write_file', { path: 'note.md', content: 'x' });
    expect(write.ok).toBe(false);
    const run = await (backend as any).routeToolCall('run_command', { command: 'echo hi' });
    expect(run.ok).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});

class FakeBackend implements AgentBackend {
  readonly turns: string[] = [];
  private handlers: Array<(event: BackendEvent) => void> = [];
  constructor(readonly config: AgentConfig) {}
  async start(): Promise<void> { this.emit({ kind: 'ready' }); }
  sendUserTurn(instruction: string): void { this.turns.push(instruction); }
  async stop() { return { stopped: true as const }; }
  abort(): void {}
  onEvent(handler: (event: BackendEvent) => void) { this.handlers.push(handler); return () => {}; }
  snapshot() { return undefined; }
  restore() { return false; }
  emit(event: BackendEvent): void { this.handlers.forEach((handler) => handler(event)); }
}

describe('a session without a folder', () => {
  it('starts and runs an agent the host allows without a folder, and refuses a CLI agent with what still works', async () => {
    const bus = new MessageBus();
    const backends = new Map<string, FakeBackend>();
    const manager = new SessionManager(5, bus, {
      createBackend: (config) => { const backend = new FakeBackend(config); backends.set(config.id, backend); return backend as unknown as AgentBackend; },
      resolveEnv: async () => ({}),
      workspaceAvailable: (config) => !!config && folderlessChatAllowed(config.backend),
      workspaceUnavailableReason: () => FOLDERLESS_UNAVAILABLE_REASON,
    });
    manager.create(agent());
    manager.create(agent({ id: 'cli', name: 'CLI', backend: 'claude', provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' } }));
    await manager.start('planner', { pin: 'take' });
    await expect(manager.start('cli', { pin: 'take' })).rejects.toThrow(FOLDERLESS_UNAVAILABLE_REASON);
    expect(backends.has('cli')).toBe(false);
    bus.send('user', 'planner', 'ask.question', { instruction: 'Plan the release.' });
    await vi.waitFor(() => expect(backends.get('planner')!.turns.join('')).toContain('Plan the release.'));
  });
});

describe('the actual extension guard without a folder', () => {
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  function sessionOption(name: string): string {
    const found: ts.PropertyAssignment[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'SessionManager') {
        const options = node.arguments?.[2];
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (ts.isPropertyAssignment(property) && property.name.getText(source) === name) found.push(property);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(found, name).toHaveLength(1);
    return ts.transpileModule(`(${found[0].initializer.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText.trim().replace(/;$/, '');
  }
  function load<T>(name: string, host: Record<string, unknown>): T {
    return new Function('host', `with (host) { return ${sessionOption(name)}; }`)(host) as T;
  }
  const host = (root: string | undefined, admissionAllowed = true) => ({
    agentRosterEdits: { admissionAllowed },
    firstWorkspaceRoot: () => root,
    folderlessChatAllowed,
    defaultBackendKind: (config: AgentConfig) => config.backend ?? 'openai-compat',
    effectiveConnectionRegistry: {},
    FOLDERLESS_UNAVAILABLE_REASON,
    folderlessChatRoot: () => '/tmp/unodeai-chat-x',
  });

  it('admits an OpenAI-compatible agent and refuses a CLI agent without a folder; with a folder, every agent', () => {
    const available = load<(config?: AgentConfig) => boolean>('workspaceAvailable', host(undefined));
    expect(available(agent())).toBe(true);
    expect(available(agent({ backend: 'claude' }))).toBe(false);
    expect(available(agent({ backend: 'codex' }))).toBe(false);
    expect(available()).toBe(false);
    const withFolder = load<(config?: AgentConfig) => boolean>('workspaceAvailable', host('/ws'));
    expect(withFolder(agent({ backend: 'claude' }))).toBe(true);
    // A team switch still holds every agent.
    expect(load<(config?: AgentConfig) => boolean>('workspaceAvailable', host('/ws', false))(agent())).toBe(false);
    expect(load<() => string>('workspaceUnavailableReason', host(undefined))()).toBe(FOLDERLESS_UNAVAILABLE_REASON);
  });

  it('roots an agent without a folder in the host-owned transient folder', async () => {
    const resolve = load<(config: AgentConfig) => Promise<string | undefined>>('resolveWorkingDirectory', host(undefined));
    await expect(resolve(agent())).resolves.toBe('/tmp/unodeai-chat-x');
  });
});
