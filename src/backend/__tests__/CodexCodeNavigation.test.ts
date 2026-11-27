/*
 * v0.9.110 (N2): a Codex agent reaches go_to_definition / find_references as App Server dynamic tools. Production
 * CodexBackend and the shared WorkspaceTools handler; the App Server and the language service are fakes that record
 * what they receive. Nothing launches a binary or a model.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend } from '../CodexBackend';
import type { AgentConfig } from '../../types';
import type { ConversationSnapshot } from '../AgentBackend';
import { FIND_REFERENCES_SPEC, setCodeNavigationHost, type CodeNavigationHost } from '../../navigation/CodeNavigation';
import { fixedCodexProgram } from './codexProgramFixture';

const SETTLED = { timeout: 10_000, interval: 5 };

function fakeAppServer() {
  const setting = (args: readonly string[], key: string): unknown => {
    const raw = args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
  };
  const clientMessages: any[] = [];
  const responses: any[] = [];
  let proc: any;
  const emit = (message: unknown) => queueMicrotask(() => proc.stdout.emit('data', `${JSON.stringify(message)}\n`));
  const spawn = (_command: string, args: string[]) => {
    proc = new EventEmitter();
    proc.pid = 4321;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = {
      writable: true,
      write(text: string) {
        for (const line of text.trim().split(/\r?\n/)) {
          if (!line) continue;
          const message = JSON.parse(line);
          clientMessages.push(message);
          const reply = (result: unknown) => emit({ jsonrpc: '2.0', id: message.id, result });
          if (message.method === 'initialize') reply({ userAgent: 'fake' });
          else if (message.method === 'config/read') reply({
            config: {
              model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
              approval_policy: setting(args, 'approval_policy'), approvals_reviewer: setting(args, 'approvals_reviewer'),
              sandbox_mode: setting(args, 'sandbox_mode'),
              sandbox_workspace_write: { network_access: setting(args, 'sandbox_workspace_write.network_access') === true },
              apps: { _default: {
                default_tools_approval_mode: setting(args, 'apps._default.default_tools_approval_mode'),
                approvals_reviewer: setting(args, 'apps._default.approvals_reviewer'),
              } },
            },
            origins: {}, layers: [],
          });
          else if (message.method === 'model/list') reply({ data: [] });
          else if (message.method === 'skills/extraRoots/set' || message.method === 'turn/interrupt') reply({});
          else if (message.method === 'skills/list') reply({ data: [] });
          else if (message.method === 'thread/start' || message.method === 'thread/resume') reply({
            thread: { id: 'thread-1' }, cwd: message.params.cwd, approvalPolicy: message.params.approvalPolicy,
            approvalsReviewer: message.params.approvalsReviewer, modelProvider: message.params.modelProvider,
            runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots,
            sandbox: message.params.sandbox === 'read-only'
              ? { type: 'readOnly', networkAccess: false }
              : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
          });
          else if (message.method === 'turn/start') reply({ turn: { id: 'turn-1', status: 'inProgress' } });
          else if (message.id !== undefined && !message.method) responses.push(message);
        }
        return true;
      },
      end() { proc.stdin.writable = false; },
    };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    return proc;
  };
  return {
    spawn: spawn as any,
    clientMessages,
    responses,
    notify(method: string, params: unknown) { emit({ jsonrpc: '2.0', method, params }); },
    toolCall(tool: string, args: Record<string, unknown>, id: string) {
      emit({ jsonrpc: '2.0', id, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: id, namespace: null, tool, arguments: args } });
    },
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  setCodeNavigationHost(undefined);
  for (const step of cleanup.splice(0).reverse()) await step();
});

function languageService(file: () => string) {
  const calls: Array<{ tool: string; line0: number; character0: number }> = [];
  const host: CodeNavigationHost = {
    openDocument: async (physical) => {
      const lines = readFileSync(physical, 'utf8').split('\n');
      return { version: 1, isDirty: false, lineCount: lines.length, lineText: (n) => lines[n] };
    },
    locate: async (tool, _document, line0, character0) => {
      calls.push({ tool, line0, character0 });
      return [{ filePath: file(), range: { startLine: 0, startCharacter: 14, endLine: 0, endCharacter: 16 } }];
    },
  };
  return { host, calls };
}

async function codexAgent(options: { hostReadFile?: boolean; restore?: ConversationSnapshot; dir?: string } = {}) {
  const dir = options.dir ?? await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-codex-nav-')));
  if (!options.dir) {
    await fs.writeFile(path.join(dir, 'a.ts'), 'const valid = id(input);\n', 'utf8');
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  }
  const config: AgentConfig = {
    id: 'codex-1', name: 'Codex Dev', role: 'developer', skill: '',
    provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: CODEX_CLI_DEFAULT_MODEL,
    systemPrompt: 'Work.', autoApprove: true, allowedTools: ['read', 'write', 'execute'], backend: 'codex', workingDirectory: dir,
  };
  const fake = fakeAppServer();
  const resets: string[] = [];
  const backend = new CodexBackend(config, undefined, {
    launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
    spawn: fake.spawn,
    access: () => ({ trusted: true, restricted: false, readRoots: [dir], writeRoots: [dir] }),
    requestApproval: async () => ({ allow: false }),
    killProcessTree: async () => undefined,
    onConversationReset: (message) => resets.push(message),
    ...(options.hostReadFile === false ? {} : { hostReadFile: true }),
  });
  const events: any[] = [];
  backend.onEvent((event) => events.push(event));
  if (options.restore) backend.restore(options.restore);
  await backend.start({ PATH: 'safe' }, { pin: 'take' });
  cleanup.push(() => backend.stop());
  backend.sendUserTurn('navigate');
  await vi.waitFor(() => {
    expect(fake.clientMessages.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    expect((backend as any).turnId).toBe('turn-1');
  }, SETTLED);
  const offered = (): string[] => (fake.clientMessages.find((message) => message.method === 'thread/start')?.params.dynamicTools ?? [])
    .map((tool: any) => tool.name);
  const call = async (tool: string, args: Record<string, unknown>, id: string): Promise<{ success: boolean; text: string }> => {
    fake.toolCall(tool, args, id);
    const response = await vi.waitFor(() => {
      const found = fake.responses.find((candidate) => candidate.id === id);
      expect(found).toBeDefined();
      return found;
    }, SETTLED);
    return { success: response.result.success, text: response.result.contentItems[0].text };
  };
  const finish = async () => {
    fake.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'done' });
    fake.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'turn_complete')).toBe(true), SETTLED);
  };
  return { dir, backend, fake, resets, offered, call, finish };
}

describe('Codex dynamic tools: go_to_definition / find_references (v0.9.110 N2)', () => {
  it('a new thread is started with the shared schema and a call reaches the shared handler at the resolved position', async () => {
    let file = '';
    const service = languageService(() => file);
    setCodeNavigationHost(service.host);
    const agent = await codexAgent();
    file = path.join(agent.dir, 'a.ts');
    expect(agent.offered()).toEqual(expect.arrayContaining(['go_to_definition', 'find_references']));
    const started = agent.fake.clientMessages.find((message) => message.method === 'thread/start');
    expect(started.params.dynamicTools.find((tool: any) => tool.name === 'find_references'))
      .toEqual({ name: 'find_references', description: FIND_REFERENCES_SPEC.function.description, inputSchema: FIND_REFERENCES_SPEC.function.parameters });
    const answer = await agent.call('find_references', { path: 'a.ts', line: 1, symbol: 'id' }, 'nav-1');
    expect(answer.success).toBe(true);
    expect(service.calls).toEqual([{ tool: 'find_references', line0: 0, character0: 14 }]);
    expect(JSON.parse(answer.text)).toMatchObject({ status: 'ok', resolvedPosition: { line: 1, character: 15 },
      symbolMatchMode: 'whole-identifier', declarationsRequested: true, returned: 1,
      locations: [{ path: 'a.ts', startLine: 1, startCharacter: 15 }] });
  });

  it('a thread started before the tools existed is resumed as it is; a call is told how to get them and reads nothing', async () => {
    const before = await codexAgent();
    expect(before.offered()).not.toContain('find_references');
    await before.finish();
    const snapshot = { ...before.backend.snapshot()!, version: 3, backend: 'codex', hostTurnState: 'complete' } as ConversationSnapshot;
    const service = languageService(() => path.join(before.dir, 'a.ts'));
    setCodeNavigationHost(service.host);
    const resumed = await codexAgent({ restore: snapshot, dir: before.dir });
    expect(resumed.resets).toEqual([]);
    expect(resumed.fake.clientMessages.some((message) => message.method === 'thread/resume')).toBe(true);
    const answer = await resumed.call('go_to_definition', { path: 'a.ts', line: 1, symbol: 'id' }, 'nav-old');
    expect(answer.success).toBe(false);
    expect(answer.text).toContain('cannot gain go_to_definition or find_references mid-thread');
    expect(service.calls).toEqual([]);
  });

  it('is not offered without a language service or to an agent that does not read through the host', async () => {
    const noService = await codexAgent();
    expect(noService.offered()).not.toContain('go_to_definition');
    setCodeNavigationHost(languageService(() => '').host);
    const noReader = await codexAgent({ hostReadFile: false });
    expect(noReader.offered()).not.toContain('go_to_definition');
    const refused = await noReader.call('find_references', { path: 'a.ts', line: 1, symbol: 'id' }, 'nav-none');
    expect(refused.success).toBe(false);
  });
});
