import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentConfig } from '../../types';
import {
  CODEX_BANNED_FLAGS,
  CODEX_CLI_DEFAULT_MODEL,
  CodexApprovalRequest,
  CodexBackend,
  CodexRuntimeAccess,
  codexCommandForPolicy,
  codexProjectTrustOverride,
  codexWriteCapable,
  buildCodexAppServerArgs,
  assertSafeCodexSpawnArgs,
  isValidatedCodexCliVersion,
} from '../CodexBackend';
import { EgressConsentDeclinedError } from '../AgentBackend';
import { SkillRegistry } from '../../skills/SkillRegistry';

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'codex-1', name: 'Codex Reviewer', role: 'reviewer', skill: '',
    provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: CODEX_CLI_DEFAULT_MODEL,
    systemPrompt: 'Review the project.', autoApprove: true, allowedTools: ['read', 'search', 'write', 'execute'], backend: 'codex',
    workingDirectory: process.cwd(), ...overrides,
  };
}

function access(overrides: Partial<CodexRuntimeAccess> = {}): CodexRuntimeAccess {
  return {
    trusted: true,
    restricted: false,
    readRoots: [process.cwd()],
    writeRoots: [process.cwd()],
    ...overrides,
  };
}

function tick(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }

function fakeAppServer(options: {
  threadResponse?: (params: any) => any;
  effectiveConfig?: Record<string, unknown> | ((call: { command: string; args: string[]; options: any }) => Record<string, unknown>);
  hooksResponse?: unknown;
  skillsResponse?: (roots: readonly string[]) => unknown;
} = {}) {
  const argvSetting = (args: readonly string[], key: string): string | undefined => {
    const prefix = `${key}=`;
    const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
  };
  const calls: Array<{ command: string; args: string[]; options: any }> = [];
  const clientMessages: any[] = [];
  const responses: any[] = [];
  let proc: any;
  let extraSkillRoots: string[] = [];
  const emit = (message: unknown) => queueMicrotask(() => proc.stdout.emit('data', `${JSON.stringify(message)}\n`));
  const threadResponse = (params: any) => options.threadResponse?.(params) ?? ({
    thread: { id: 'thread-123' },
    cwd: params.cwd,
    approvalPolicy: params.approvalPolicy,
    approvalsReviewer: params.approvalsReviewer,
    modelProvider: params.modelProvider,
    runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
    sandbox: params.sandbox === 'read-only'
      ? { type: 'readOnly', networkAccess: false }
      : params.sandbox === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
      : {
          type: 'workspaceWrite', writableRoots: [], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true,
        },
  });
  const spawn = (command: string, args: string[], spawnOptions: any) => {
    proc = new EventEmitter() as any;
    calls.push({ command, args, options: spawnOptions });
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
          if (message.method === 'initialize') emit({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake' } });
          else if (message.method === 'config/read') emit({
            jsonrpc: '2.0', id: message.id, result: {
              config: (typeof options.effectiveConfig === 'function'
                ? options.effectiveConfig(calls[calls.length - 1])
                : options.effectiveConfig) ?? {
                model_provider: 'openai', openai_base_url: 'https://api.openai.com/v1',
                notify: [], model_providers: {}, mcp_servers: {},
                analytics: { enabled: false }, otel: { exporter: 'none' },
                approval_policy: argvSetting(args, 'approval_policy'),
                approvals_reviewer: argvSetting(args, 'approvals_reviewer'),
                sandbox_mode: argvSetting(args, 'sandbox_mode'),
                sandbox_workspace_write: { network_access: argvSetting(args, 'sandbox_workspace_write.network_access') === true },
                apps: { _default: {
                  default_tools_approval_mode: argvSetting(args, 'apps._default.default_tools_approval_mode'),
                  approvals_reviewer: argvSetting(args, 'apps._default.approvals_reviewer'),
                } },
              },
              origins: {}, layers: [],
            },
          });
          else if (message.method === 'hooks/list') emit({
            jsonrpc: '2.0', id: message.id,
            result: options.hooksResponse ?? { data: [{ cwd: process.cwd(), hooks: [], warnings: [], errors: [] }] },
          });
          else if (message.method === 'model/list') emit({
            jsonrpc: '2.0', id: message.id,
            result: { data: [{ id: 'gpt-test', displayName: 'GPT Test', isDefault: true, hidden: false, inputModalities: ['text'] }] },
          });
          else if (message.method === 'skills/extraRoots/set') {
            extraSkillRoots = [...(message.params?.extraRoots ?? [])];
            emit({ jsonrpc: '2.0', id: message.id, result: {} });
          } else if (message.method === 'skills/list') {
            const result = options.skillsResponse?.(extraSkillRoots) ?? {
              data: extraSkillRoots.length === 0 ? [] : [{
                cwd: process.cwd(),
                skills: extraSkillRoots.flatMap((root) => fs.readdirSync(root, { withFileTypes: true })
                  .filter((entry) => entry.isDirectory())
                  .map((entry) => {
                    const skillPath = fs.realpathSync(path.join(root, entry.name, 'SKILL.md'));
                    const name = /^name:\s*(.+)$/m.exec(fs.readFileSync(skillPath, 'utf8'))?.[1]?.trim() ?? entry.name;
                    return { name, description: 'fixture', path: skillPath, scope: 'user', enabled: true, pluginId: null };
                  })),
                errors: [],
              }],
            };
            emit({ jsonrpc: '2.0', id: message.id, result });
          }
          else if (message.method === 'thread/start' || message.method === 'thread/resume') {
            emit({ jsonrpc: '2.0', id: message.id, result: threadResponse(message.params) });
          } else if (message.method === 'turn/start') {
            emit({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
          } else if (message.method === 'turn/interrupt') {
            emit({ jsonrpc: '2.0', id: message.id, result: {} });
          } else if (message.method === 'turn/steer') {
            emit({ jsonrpc: '2.0', id: message.id, result: { turnId: message.params?.expectedTurnId } });
          } else if (message.method === 'thread/approveGuardianDeniedAction') {
            emit({ jsonrpc: '2.0', id: message.id, result: {} });
          } else if (message.id !== undefined && !message.method) responses.push(message);
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
    calls,
    clientMessages,
    responses,
    request(method: string, params: unknown, id = `server-${Date.now()}-${Math.random()}`) {
      emit({ jsonrpc: '2.0', id, method, params });
      return id;
    },
    notify(method: string, params: unknown) { emit({ jsonrpc: '2.0', method, params }); },
  };
}

async function startedBackend(opts: {
  fake?: ReturnType<typeof fakeAppServer>;
  runtimeAccess?: CodexRuntimeAccess;
  requestApproval?: (request: CodexApprovalRequest) => Promise<{ allow: boolean; note?: string }>;
  approvalTimeoutMs?: number;
  commandPolicy?: { approvalMode: 'none' | 'allowlist' | 'ask' | 'all'; check(command: string): { allowed: boolean; ask?: boolean; reason?: string } };
  writeApprovalAsk?: () => boolean;
  prepareFileCheckpoint?: (changes: readonly any[]) => Promise<{ ok: boolean; note?: string }>;
  onModels?: (models: readonly any[], cliVersion?: string) => void;
  skillRegistry?: SkillRegistry;
  teamMcpBridge?: any;
  mcp?: any;
  executableSkills?: any;
  onConversationReset?: (message: string) => void;
  agent?: Partial<AgentConfig>;
} = {}) {
  const fake = opts.fake ?? fakeAppServer();
  const approvals: CodexApprovalRequest[] = [];
  const backend = new CodexBackend(config(opts.agent), undefined, {
    binaryPath: 'C:/tools/codex.exe',
    spawn: fake.spawn,
    access: () => opts.runtimeAccess ?? access(),
    requestApproval: async (request) => {
      approvals.push(request);
      return opts.requestApproval ? opts.requestApproval(request) : { allow: true };
    },
    approvalTimeoutMs: opts.approvalTimeoutMs,
    commandPolicy: opts.commandPolicy,
    writeApprovalAsk: opts.writeApprovalAsk ?? (() => true),
    prepareFileCheckpoint: opts.prepareFileCheckpoint ?? (async () => ({ ok: true })),
    onModels: opts.onModels,
    skillRegistry: opts.skillRegistry,
    teamMcpBridge: opts.teamMcpBridge,
    mcp: opts.mcp,
    executableSkills: opts.executableSkills,
    onConversationReset: opts.onConversationReset,
    killProcessTree: async () => undefined,
  });
  await backend.start({ PATH: 'safe', OPENAI_API_KEY: 'must-not-leak' });
  return { backend, fake, approvals };
}

async function startTurn(backend: CodexBackend, attachments?: any): Promise<void> {
  backend.sendUserTurn('inspect this', attachments);
  await tick();
  await tick();
}

describe('CodexBackend App Server', () => {
  it('never sends a read-only root as a Codex workspace root, because resume makes it writable', async () => {
    // Field, round 7: every Ask for approval / Approve for me turn was refused with "App Server added writable
    // root(s) ... C:\AI_Program". Measured on 0.155.1: thread/resume turns each runtime workspace root into a
    // writable root (thread/start ignores them), and resume reports both temp exclusions false unless the
    // thread config sets them. The default localReadScope grants the workspace's PARENT as a read root.
    const workspace = path.resolve(process.cwd());
    const parent = path.dirname(workspace);
    const measuredResume = (params: any) => ({
      thread: { id: 'saved-thread' }, cwd: params.cwd,
      approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer,
      modelProvider: params.modelProvider, runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
      sandbox: params.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : {
        type: 'workspaceWrite',
        writableRoots: (params.runtimeWorkspaceRoots ?? [])
          .filter((root: string) => path.resolve(root).toLowerCase() !== path.resolve(params.cwd).toLowerCase()),
        networkAccess: false,
        excludeTmpdirEnvVar: params.config?.sandbox_workspace_write?.exclude_tmpdir_env_var === true,
        excludeSlashTmp: params.config?.sandbox_workspace_write?.exclude_slash_tmp === true,
      },
    });
    const withParentRead = access({ readRoots: [workspace, parent], writeRoots: [workspace] });

    for (const profile of ['ask-for-approval', 'approve-for-me'] as const) {
      const fake = fakeAppServer({ threadResponse: measuredResume });
      const { backend } = await startedBackend({ fake, runtimeAccess: withParentRead, agent: { codexPermissionProfile: profile } });
      backend.restore({ version: 1, messages: [{ codexThreadId: 'saved-thread' }] });
      const events: any[] = [];
      backend.onEvent((event) => events.push(event));
      await startTurn(backend);

      const resume = fake.clientMessages.find((m) => m.method === 'thread/resume');
      expect(resume.params.runtimeWorkspaceRoots).toEqual([workspace]);
      const turn = fake.clientMessages.find((m) => m.method === 'turn/start');
      expect(turn.params.runtimeWorkspaceRoots).toEqual([workspace]);
      expect(events.filter((event) => event.kind === 'error')).toEqual([]);
    }

    // Read-only cannot write any root, so it may still pass the wider read roots.
    const readOnly = fakeAppServer({ threadResponse: measuredResume });
    const planned = await startedBackend({ fake: readOnly, runtimeAccess: withParentRead });
    planned.backend.restore({ version: 1, messages: [{ codexThreadId: 'saved-thread' }] });
    await startTurn(planned.backend, { mode: 'plan' });
    expect([...readOnly.clientMessages.find((m) => m.method === 'thread/resume').params.runtimeWorkspaceRoots].sort())
      .toEqual([workspace, parent].sort());
  });

  it('refuses a workspace-write thread whose temp folders are writable', async () => {
    const leaky = fakeAppServer({ threadResponse: (params) => ({
      thread: { id: 'thread-tmp' }, cwd: params.cwd,
      approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer,
      modelProvider: params.modelProvider, runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
      sandbox: {
        type: 'workspaceWrite', writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
    }) });
    const { backend } = await startedBackend({ fake: leaky });
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));
    await startTurn(backend);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('temp folders') }));
  });

  it('surfaces the reviewer warning and strict-review notices that 0.155.1 sends under Approve for me', async () => {
    // Both are in the 0.155.1 ServerNotification schema. Before this they were dropped, so a user who
    // delegated approvals to the reviewer never saw what it wanted them to know.
    const { backend, fake } = await startedBackend({ agent: { codexPermissionProfile: 'approve-for-me' } });
    await startTurn(backend);
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));
    fake.notify('guardianWarning', { threadId: 'thread-123', message: 'This command reaches the network.' });
    fake.notify('autoApprovalReview/strictReviewRequired', { threadId: 'thread-123', turnId: 'turn-1', startedAtMs: 1 });
    await tick();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'approval_review', status: 'warning', rationale: 'This command reaches the network.' }),
      expect.objectContaining({ kind: 'approval_review', phase: 'started', status: 'strict' }),
    ]));
  });

  it('does not repeat a guardian warning already included in the completed review', async () => {
    const { backend, fake } = await startedBackend({ agent: { codexPermissionProfile: 'approve-for-me' } });
    await startTurn(backend);
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));
    fake.notify('item/autoApprovalReview/completed', {
      action: { type: 'networkAccess', url: 'https://example.com' },
      review: { status: 'approved', rationale: 'Network access is acceptable.' },
    });
    fake.notify('guardianWarning', { message: 'Network access is acceptable.' });
    await tick();
    expect(events.filter((event) => event.kind === 'approval_review')).toHaveLength(1);
    expect(events[0]).toMatchObject({ phase: 'completed', rationale: 'Network access is acceptable.' });
  });

  it('pins Approve for me to auto_review and surfaces its measured audit notifications without a user card', async () => {
    const { backend, fake, approvals } = await startedBackend({ agent: { codexPermissionProfile: 'approve-for-me' } });
    const args = fake.calls[0].args;
    expect(args).toContain('approvals_reviewer="auto_review"');
    await startTurn(backend);
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));
    fake.notify('item/autoApprovalReview/started', {
      action: { type: 'networkAccess', url: 'https://example.com' },
      review: { status: 'inProgress' },
    });
    fake.notify('item/autoApprovalReview/completed', {
      action: { type: 'networkAccess', url: 'https://example.com' },
      review: { status: 'denied', rationale: 'Not needed.' },
    });
    fake.request('item/commandExecution/requestApproval', { command: 'curl.exe https://example.com' }, 'unexpected-auto-card');
    await tick();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'approval_review', phase: 'started', action: expect.stringContaining('example.com') }),
      expect.objectContaining({ kind: 'approval_review', phase: 'completed', status: 'denied' }),
    ]));
    expect(approvals).toHaveLength(0);
    expect(fake.responses).toContainEqual(expect.objectContaining({ id: 'unexpected-auto-card', result: { decision: 'decline' } }));
    fake.notify('item/autoApprovalReview/completed', {
      action: { type: 'networkAccess', url: 'https://example.com' },
      review: { status: 'denied', rationale: 'Needs a human.' },
      event: { id: 'denial-1' },
    });
    await tick();
    await tick();
    expect(approvals).toContainEqual(expect.objectContaining({
      kind: 'guardian-denied', approveAnyway: true,
    }));
    expect(fake.clientMessages).toContainEqual(expect.objectContaining({
      method: 'thread/approveGuardianDeniedAction',
      params: { threadId: 'thread-123', event: { id: 'denial-1' } },
    }));
  });

  it('pins Full access to never/no sandbox prompts and profile-gates its spawn argument', async () => {
    const { backend, fake, approvals } = await startedBackend({ agent: { codexPermissionProfile: 'full-access' } });
    expect(fake.calls[0].args).toEqual(expect.arrayContaining([
      'sandbox_mode="danger-full-access"', 'approval_policy="never"',
      'sandbox_workspace_write.network_access=true',
    ]));
    await startTurn(backend);
    const turn = fake.clientMessages.find((message) => message.method === 'turn/start');
    expect(turn.params).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    fake.request('item/commandExecution/requestApproval', { command: 'whoami' }, 'unexpected-full-card');
    await tick();
    expect(approvals).toHaveLength(0);
    expect(fake.responses).toContainEqual(expect.objectContaining({ id: 'unexpected-full-card', result: { decision: 'decline' } }));
    const fullArgs = buildCodexAppServerArgs(undefined, 'full-access');
    expect(() => assertSafeCodexSpawnArgs(fullArgs, 'ask-for-approval')).toThrow();
  });
  it('uses one explicit App Server process, strips API keys, and keeps banned argv out', async () => {
    const { backend, fake } = await startedBackend();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].command).toBe('C:/tools/codex.exe');
    expect(fake.calls[0].args).toEqual(expect.arrayContaining([
      'app-server', '--stdio', '--strict-config',
      'analytics.enabled=false', 'otel.exporter="none"',
      'apps._default.default_tools_approval_mode="prompt"',
      'apps._default.approvals_reviewer="user"',
    ]));
    for (const suppressed of [
      'mcp_servers={}', 'model_providers={}', 'model_provider="openai"',
      'openai_base_url="https://api.openai.com/v1"', 'notify=[]', 'features.hooks=false',
    ]) expect(fake.calls[0].args).not.toContain(suppressed);
    for (const banned of CODEX_BANNED_FLAGS) expect(fake.calls[0].args).not.toContain(banned);
    expect(fake.calls[0].options).toMatchObject({ shell: false, windowsHide: true, cwd: process.cwd() });
    expect(fake.calls[0].options.env.OPENAI_API_KEY).toBeUndefined();
    await startTurn(backend);
    expect(fake.calls).toHaveLength(1);
    expect(fake.clientMessages.find((m) => m.method === 'turn/start')).toBeTruthy();
  });

  it('pins Codex native Ask for approval at the process boundary', async () => {
    const { fake } = await startedBackend();
    const args = fake.calls[0].args;
    const configValues = args.flatMap((arg, index) => args[index - 1] === '-c' ? [arg] : []);
    expect(configValues).toContain('approval_policy="on-request"');
    expect(configValues).toContain('approvals_reviewer="user"');
    expect(configValues).toContain('sandbox_mode="workspace-write"');
    expect(configValues).toContain('sandbox_workspace_write.network_access=false');
  });

  it('asks for consent before preflight or spawn and declining creates no process', async () => {
    const order: string[] = [];
    const fake = fakeAppServer();
    const backend = new CodexBackend(config(), undefined, {
      binaryPath: 'C:/tools/codex.exe',
      onBeforeEgress: async (onPending) => {
        order.push('consent');
        onPending?.({ host: 'api.openai.com', message: 'OpenAI consent' });
        throw new EgressConsentDeclinedError('api.openai.com');
      },
      preflight: async () => { order.push('preflight'); },
      spawn: ((...args: any[]) => { order.push('spawn'); return (fake.spawn as any)(...args); }) as any,
      access: () => access(),
      killProcessTree: async () => undefined,
    });
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));
    await expect(backend.start({})).rejects.toThrow(/declined/i);
    expect(order).toEqual(['consent']);
    expect(fake.calls).toHaveLength(0);
    expect(events).toContainEqual({ kind: 'consent_required', message: 'OpenAI consent' });
  });

  it('reviews repository configuration before consent and revalidates immediately before spawn', async () => {
    const order: string[] = [];
    const fake = fakeAppServer();
    const backend = new CodexBackend(config(), undefined, {
      binaryPath: 'C:/tools/codex.exe',
      onBeforeRepositoryConfig: async () => {
        order.push('repository');
        return { mode: 'native', projectRoot: process.cwd(), assertCurrent: () => { order.push('revalidate'); } };
      },
      onBeforeEgress: async () => { order.push('egress'); },
      preflight: async () => { order.push('preflight'); },
      spawn: ((...args: any[]) => { order.push('spawn'); return (fake.spawn as any)(...args); }) as any,
      access: () => access(),
      killProcessTree: async () => undefined,
    });
    await backend.start({});
    expect(order).toEqual(['repository', 'egress', 'preflight', 'revalidate', 'spawn']);
  });

  it('starts Codex with a process-local untrusted project map when repository automation is declined', async () => {
    const fake = fakeAppServer();
    const egress = vi.fn();
    const backend = new CodexBackend(config(), undefined, {
      binaryPath: 'C:/tools/codex.exe', spawn: fake.spawn, access: () => access(),
      onBeforeRepositoryConfig: async () => ({ mode: 'user-only', projectRoot: process.cwd(), assertCurrent: vi.fn() }),
      onBeforeEgress: egress, killProcessTree: async () => undefined,
    });
    await expect(backend.start({})).resolves.toBeUndefined();
    expect(egress).toHaveBeenCalledOnce();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].args.join(' ')).toContain('trust_level = "untrusted"');
  });

  it('CodexBackend Track A does not spawn when the final route boundary rejects, while an identical positive path spawns once', async () => {
    const refused = fakeAppServer();
    const consent = vi.fn();
    const backend = new CodexBackend(config(), undefined, {
      binaryPath: 'C:/tools/codex.exe', spawn: refused.spawn, access: () => access(),
      assertResolvedRoute: () => { throw new Error('route mismatch'); },
      onBeforeEgress: consent, killProcessTree: async () => undefined,
    });
    await expect(backend.start({})).rejects.toThrow(/route mismatch/);
    expect(consent).not.toHaveBeenCalled();
    expect(refused.calls).toHaveLength(0);

    const allowed = await startedBackend();
    expect(allowed.fake.calls).toHaveLength(1);
  });

  it.each([
    access({ trusted: false }),
    access({ readRoots: [], writeRoots: [], restricted: true }),
  ])('does not prompt or spawn when host access forbids startup', async (runtimeAccess) => {
    const fake = fakeAppServer();
    const consent = vi.fn();
    const backend = new CodexBackend(config(), undefined, {
      binaryPath: 'C:/tools/codex.exe', spawn: fake.spawn, access: () => runtimeAccess,
      onBeforeEgress: consent, killProcessTree: async () => undefined,
    });
    await expect(backend.start({})).rejects.toThrow();
    expect(consent).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it('preserves native notify, provider, hooks, and MCP config while enforcing privacy pins', async () => {
    const native = fakeAppServer({ effectiveConfig: {
      notify: ['user-notify.cmd'], model_provider: 'proxy', openai_base_url: 'https://provider.example/v1',
      model_providers: { proxy: {} }, mcp_servers: { docs: {} }, analytics: { enabled: false },
      otel: { exporter: 'none' }, approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write',
      apps: { _default: { default_tools_approval_mode: 'prompt', approvals_reviewer: 'user' } },
    } });
    const backend = new CodexBackend(config(), undefined, {
      binaryPath: 'C:/tools/codex.exe', spawn: native.spawn, access: () => access(), killProcessTree: async () => undefined,
    });
    await expect(backend.start({})).resolves.toBeUndefined();
    await startTurn(backend);
    expect(native.clientMessages.find((message) => message.method === 'thread/start')?.params.modelProvider).toBe('proxy');

    for (const planted of [
      {
        model_provider: 'openai', analytics: { enabled: true }, otel: { exporter: 'none' },
        approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write',
        apps: { _default: { default_tools_approval_mode: 'prompt', approvals_reviewer: 'user' } },
      },
      {
        model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'otlp-http' },
        approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write',
        apps: { _default: { default_tools_approval_mode: 'prompt', approvals_reviewer: 'user' } },
      },
      {
        model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
        approval_policy: 'untrusted', sandbox_mode: 'read-only',
        apps: { _default: { default_tools_approval_mode: 'prompt', approvals_reviewer: 'user' } },
      },
      {
        model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
        approval_policy: 'never', approvals_reviewer: 'user', sandbox_mode: 'workspace-write',
        apps: { _default: { default_tools_approval_mode: 'prompt', approvals_reviewer: 'user' } },
      },
      {
        model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
        approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'read-only',
        apps: { _default: { default_tools_approval_mode: 'prompt', approvals_reviewer: 'user' } },
      },
      {
        model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
        approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'danger-full-access',
        apps: { _default: { default_tools_approval_mode: 'prompt', approvals_reviewer: 'user' } },
      },
      {
        model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
        approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write',
        apps: { _default: { default_tools_approval_mode: 'never', approvals_reviewer: 'user' } },
      },
      {
        model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
        approval_policy: 'on-request', approvals_reviewer: 'auto_review', sandbox_mode: 'workspace-write',
        apps: { _default: { default_tools_approval_mode: 'prompt', approvals_reviewer: 'auto' } },
      },
    ]) {
      const fake = fakeAppServer({ effectiveConfig: planted });
      const refused = new CodexBackend(config(), undefined, {
        binaryPath: 'C:/tools/codex.exe', spawn: fake.spawn, access: () => access(), killProcessTree: async () => undefined,
      });
      await expect(refused.start({})).rejects.toThrow(/refused to start|downgraded workspace-write/i);
    }
  });

  it('starts App Server directly without an MCP-list subprocess and preserves configured MCP servers', async () => {
    const fake = fakeAppServer({ effectiveConfig: {
      model_provider: 'openai', mcp_servers: { planted: { enabled: true } },
      analytics: { enabled: false }, otel: { exporter: 'none' },
      approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write',
      apps: { _default: { default_tools_approval_mode: 'prompt', approvals_reviewer: 'user' } },
    } });
    const repositoryGate = vi.fn(async () => ({ mode: 'native' as const, projectRoot: process.cwd(), assertCurrent: vi.fn() }));
    const backend = new CodexBackend(config(), undefined, {
      binaryPath: 'C:/tools/codex.exe', spawn: fake.spawn, access: () => access(),
      onBeforeRepositoryConfig: repositoryGate, killProcessTree: async () => undefined,
    });
    await expect(backend.start({})).resolves.toBeUndefined();
    expect(repositoryGate).toHaveBeenCalledTimes(1);
    expect(fake.calls).toHaveLength(1);
  });

  it('names a writable root App Server adds, and accepts the workspace in extended-length form', async () => {
    // Field, round 5 step 11: "App Server added an unexpected writable root." with no root named, which
    // made the refusal impossible to act on or diagnose.
    const workspace = path.resolve(process.cwd());
    const withWritableRoots = (roots: string[]) => fakeAppServer({ threadResponse: (params) => ({
      thread: { id: 'thread-roots' }, cwd: params.cwd,
      approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer,
      modelProvider: params.modelProvider, runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
      sandbox: {
        type: 'workspaceWrite', writableRoots: roots, networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true,
      },
    }) });
    const errorsFor = async (roots: string[]) => {
      const started = await startedBackend({ fake: withWritableRoots(roots) });
      const events: any[] = [];
      started.backend.onEvent((event) => events.push(event));
      await startTurn(started.backend);
      return events.filter((event) => event.kind === 'error').map((event) => String(event.message));
    };

    const outside = path.resolve(workspace, '..', 'somewhere-else');
    const refused = await errorsFor([outside]);
    expect(refused.join('\n')).toContain(outside);
    expect(refused.join('\n')).toContain('outside this agent\'s write access');

    expect(await errorsFor([workspace, path.join(workspace, 'src')])).toEqual([]);
    if (process.platform === 'win32') {
      // Codex reports canonical \\?\ paths on Windows; the same folder must not read as "outside".
      expect(await errorsFor([`\\\\?\\${workspace}`, `\\\\?\\${path.join(workspace, 'src')}`])).toEqual([]);
    }
  });

  it('pins thread and turn policy and refuses a response that weakens it', async () => {
    const { backend, fake } = await startedBackend();
    await startTurn(backend);
    const start = fake.clientMessages.find((m) => m.method === 'thread/start');
    expect(start.params).toMatchObject({
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write',
      modelProvider: 'openai',
      runtimeWorkspaceRoots: [path.resolve(process.cwd())],
      config: {
        approval_policy: 'on-request', approvals_reviewer: 'user',
        sandbox_mode: 'workspace-write',
        apps: { _default: { default_tools_approval_mode: 'prompt', approvals_reviewer: 'user' } },
      },
      dynamicTools: [],
      developerInstructions: 'Review the project.',
    });
    expect(start.params).not.toHaveProperty('baseInstructions');
    const turn = fake.clientMessages.find((m) => m.method === 'turn/start');
    // Field round 8, step 10b: "the available command tool does not support an escalated retry". Measured on
    // 0.155.1: `environments: []` disables environment access and with it escalation, so no escalation ever
    // reached the user (Ask for approval) or the reviewer (Approve for me). Omitted selects the local default.
    expect(start.params).not.toHaveProperty('environments');
    expect(turn.params).not.toHaveProperty('environments');
    expect(turn.params.sandboxPolicy).toMatchObject({
      type: 'workspaceWrite', writableRoots: [path.resolve(process.cwd())], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    });

    const weakened = fakeAppServer({ threadResponse: (params) => ({
      thread: { id: 'unsafe' }, approvalPolicy: 'never', approvalsReviewer: 'auto_review',
      modelProvider: 'proxy', cwd: params.cwd, runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
      sandbox: { type: 'dangerFullAccess' },
    }) });
    const started = await startedBackend({ fake: weakened });
    const events: any[] = [];
    started.backend.onEvent((event) => events.push(event));
    await startTurn(started.backend);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('policy did not win') }));
    expect(weakened.clientMessages.some((m) => m.method === 'turn/start')).toBe(false);
  });

  it('migrates the legacy empty ceiling to native-default and maps write to workspace-write', async () => {
    // Field, round 4 step 10: every Codex agent created through the dialog carries allowedTools: []
    // because adaptGeneratedConfigToConnection filters the ceiling against a route with no UnodeAi
    // tools. Reading that as "no writes" made workspace-write unreachable for every Codex agent.
    expect(codexWriteCapable(undefined)).toBe(true);
    expect(codexWriteCapable([])).toBe(true);
    expect(codexWriteCapable([], 'native-default')).toBe(true);
    expect(codexWriteCapable([], 'bounded')).toBe(false);
    expect(codexWriteCapable(['read', 'write'])).toBe(true);
    expect(codexWriteCapable(['read', 'execute'])).toBe(false);
    expect(codexWriteCapable(['read', 'write', 'execute'])).toBe(true);
    expect(codexWriteCapable(['read', 'search'])).toBe(false);

    const { backend, fake } = await startedBackend({ agent: { allowedTools: [] } });
    await startTurn(backend);
    const turn = fake.clientMessages.find((m) => m.method === 'turn/start');
    expect(turn.params.sandboxPolicy.type).toBe('workspaceWrite');
    expect(turn.params.sandboxPolicy.networkAccess).toBe(false);
  });

  it('uses developer instructions on thread resume without replacing Codex base instructions', async () => {
    const { backend, fake } = await startedBackend({ agent: { systemPrompt: 'Follow ROLE-MARKER-4412.' } });
    backend.restore({ version: 1, messages: [{ codexThreadId: 'saved-thread' }] });
    await startTurn(backend);
    const resume = fake.clientMessages.find((message) => message.method === 'thread/resume');
    expect(resume.params.developerInstructions).toBe('Follow ROLE-MARKER-4412.');
    expect(resume.params).not.toHaveProperty('baseInstructions');
  });

  it('registers a private namespaced native-Skill root and removes it on stop', async () => {
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    const { backend, fake } = await startedBackend({
      skillRegistry: registry,
      agent: { playbooks: ['api-contract-review'], allowedTools: ['read'], toolCeiling: 'bounded' },
    });
    const set = fake.clientMessages.find((message) => message.method === 'skills/extraRoots/set');
    expect(set.params.extraRoots).toHaveLength(1);
    const root = set.params.extraRoots[0];
    const listed = fake.clientMessages.find((message) => message.method === 'skills/list');
    expect(listed.params).toEqual({ cwds: [path.resolve(process.cwd())], forceReload: true });
    expect(fake.clientMessages.some((message) => message.method === 'skills/config/write')).toBe(false);
    const nativeFolders = fs.readdirSync(root);
    expect(nativeFolders).toHaveLength(1);
    expect(nativeFolders[0]).toMatch(/^unode-[a-f0-9]{8}-api-contract-review-[a-f0-9]{8}$/);
    const markdown = fs.readFileSync(path.join(root, nativeFolders[0], 'SKILL.md'), 'utf8');
    expect(markdown).toContain(`name: ${nativeFolders[0]}`);
    expect(markdown).toContain('API');

    await backend.stop();
    expect(fs.existsSync(root)).toBe(false);
  });

  it('never lets a Playbook grant workspace-write or persist roots into Codex configuration', async () => {
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    const { backend, fake } = await startedBackend({
      skillRegistry: registry,
      agent: { playbooks: ['api-contract-review'], allowedTools: ['read'], toolCeiling: 'bounded' },
    });
    await startTurn(backend);
    expect(fake.clientMessages.some((message) => message.method === 'skills/config/write')).toBe(false);
    expect(fake.clientMessages.find((message) => message.method === 'thread/start').params.sandbox).toBe('read-only');
    expect(fake.clientMessages.find((message) => message.method === 'turn/start').params.sandboxPolicy.type).toBe('readOnly');
  });

  it('gives two Codex agents disjoint native-Skill names and roots', async () => {
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    const first = await startedBackend({ skillRegistry: registry, agent: { id: 'agent-a', playbooks: ['api-contract-review'] } });
    const second = await startedBackend({ skillRegistry: registry, agent: { id: 'agent-b', playbooks: ['api-contract-review'] } });
    const firstRoot = first.fake.clientMessages.find((message) => message.method === 'skills/extraRoots/set').params.extraRoots[0];
    const secondRoot = second.fake.clientMessages.find((message) => message.method === 'skills/extraRoots/set').params.extraRoots[0];
    expect(firstRoot).not.toBe(secondRoot);
    expect(fs.readdirSync(firstRoot)).not.toEqual(fs.readdirSync(secondRoot));
    await first.backend.stop();
    expect(fs.existsSync(firstRoot)).toBe(false);
    expect(fs.existsSync(secondRoot)).toBe(true);
    await second.backend.stop();
  });

  it('fails closed and removes the temporary root when Codex reports a different Skill source path', async () => {
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    let registeredRoot = '';
    const fake = fakeAppServer({
      skillsResponse: (roots) => {
        registeredRoot = roots[0] ?? '';
        const nativeName = fs.readdirSync(registeredRoot)[0];
        return { data: [{
          cwd: process.cwd(), errors: [],
          skills: [{
            name: nativeName, description: 'collision', path: path.join(process.cwd(), 'foreign', 'SKILL.md'),
            scope: 'user', enabled: true, pluginId: null,
          }],
        }] };
      },
    });
    await expect(startedBackend({
      fake,
      skillRegistry: registry,
      agent: { playbooks: ['api-contract-review'] },
    })).rejects.toThrow(/source mismatch/);
    expect(registeredRoot).not.toBe('');
    expect(fs.existsSync(registeredRoot)).toBe(false);
  });

  it('fails closed when Codex discovers the exact Skill path but reports it disabled', async () => {
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    const fake = fakeAppServer({
      skillsResponse: (roots) => {
        const root = roots[0];
        const nativeName = fs.readdirSync(root)[0];
        return { data: [{ cwd: process.cwd(), errors: [], skills: [{
          name: nativeName, description: 'disabled fixture',
          path: fs.realpathSync(path.join(root, nativeName, 'SKILL.md')),
          scope: 'user', enabled: false, pluginId: null,
        }] }] };
      },
    });
    await expect(startedBackend({ fake, skillRegistry: registry, agent: { playbooks: ['api-contract-review'] } }))
      .rejects.toThrow(/reported.*disabled/i);
  });

  it('exposes only host-granted team and MCP dynamic tools and routes their calls back to UnodeAi', async () => {
    const teamCalls: any[] = [];
    const mcpCalls: any[] = [];
    let grants = [{ serverId: 'docs', toolFilter: 'all' as const }];
    const teamMcpBridge = {
      async listTools() { return [{ name: 'dispatch_task', description: 'Delegate.', inputSchema: { type: 'object', properties: {} } }]; },
      async callTool(name: string, args: any) { teamCalls.push({ name, args }); return 'delegated'; },
    };
    const hub = {
      getToolSpecs: () => [{ type: 'function', function: { name: 'docs__lookup', description: 'Look up docs.', parameters: { type: 'object', properties: {} } } }],
      async executeTool(name: string, args: any, grants: any) {
        if (!grants.some((grant: any) => grant.serverId === 'docs')) {
          return { source: 'host', contentSource: 'host', status: 'refused', reason: 'consent', output: `MCP tool "${name}" is not granted to this agent.` };
        }
        mcpCalls.push({ name, args, grants });
        return { source: 'host', contentSource: 'mixed-external', status: 'success', output: 'documentation' };
      },
    };
    const { backend, fake } = await startedBackend({ teamMcpBridge, mcp: { hub, grants: () => grants } });
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));
    await startTurn(backend);

    const dynamicTools = fake.clientMessages.find((message) => message.method === 'thread/start').params.dynamicTools;
    expect(dynamicTools.map((tool: any) => tool.name)).toEqual(['dispatch_task', 'docs__lookup']);
    fake.request('item/tool/call', {
      threadId: 'thread-123', turnId: 'turn-1', callId: 'team-call', namespace: null,
      tool: 'dispatch_task', arguments: { agent: 'dev' },
    }, 'team-request');
    fake.request('item/tool/call', {
      threadId: 'thread-123', turnId: 'turn-1', callId: 'mcp-call', namespace: null,
      tool: 'docs__lookup', arguments: { query: 'skills' },
    }, 'mcp-request');
    await tick(); await tick();

    expect(teamCalls).toEqual([{ name: 'dispatch_task', args: { agent: 'dev' } }]);
    expect(mcpCalls).toEqual([{ name: 'docs__lookup', args: { query: 'skills' }, grants }]);
    expect(fake.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'team-request', result: { success: true, contentItems: [{ type: 'inputText', text: 'delegated' }] } }),
      expect.objectContaining({ id: 'mcp-request', result: { success: true, contentItems: [{ type: 'inputText', text: 'documentation' }] } }),
    ]));
    expect(events.filter((event) => event.kind === 'tool_use').map((event) => event.name))
      .toEqual(['dispatch_task', 'docs__lookup']);

    grants = [];
    fake.request('item/tool/call', {
      threadId: 'thread-123', turnId: 'turn-1', callId: 'revoked-call', namespace: null,
      tool: 'docs__lookup', arguments: { query: 'revoked' },
    }, 'revoked-request');
    await tick();
    expect(mcpCalls).toHaveLength(1);
    expect(fake.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'revoked-request', result: expect.objectContaining({ success: false }) }),
    ]));
    expect(backend.snapshot()?.messages[0]).toMatchObject({
      codexDynamicTools: expect.stringContaining('docs__lookup'),
    });
  });

  it('aborts an in-flight managed MCP call when the Codex turn is interrupted', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const hub = {
      getToolSpecs: () => [{ type: 'function', function: {
        name: 'docs__slow', description: 'Slow lookup.', parameters: { type: 'object', properties: {} },
      } }],
      canExecuteTool: () => true,
      async executeTool(_name: string, _args: any, _grants: any, signal?: AbortSignal) {
        upstreamSignal = signal;
        return await new Promise<any>((resolve) => signal?.addEventListener('abort', () => resolve({
          source: 'host', contentSource: 'host', status: 'failed', failureKind: 'outcome_unknown',
          output: 'cancelled after dispatch',
        }), { once: true }));
      },
    };
    const { backend, fake } = await startedBackend({
      mcp: { hub, grants: () => [{ serverId: 'docs', toolFilter: 'all' as const }] },
    });
    await startTurn(backend);
    fake.request('item/tool/call', {
      threadId: 'thread-123', turnId: 'turn-1', callId: 'slow-call', namespace: null,
      tool: 'docs__slow', arguments: {},
    }, 'slow-request');
    await tick();
    expect(upstreamSignal?.aborted).toBe(false);

    backend.abort();
    await tick();
    expect(upstreamSignal?.aborted).toBe(true);
    expect(fake.responses).toContainEqual(expect.objectContaining({
      id: 'slow-request', result: expect.objectContaining({ success: false }),
    }));
  });

  it('advertises and routes executable Skills only through the host dynamic tool', async () => {
    const calls: any[] = [];
    const executableSkills = {
      toolSpec: () => ({
        type: 'function', returnsExternalContent: true,
        function: { name: 'run_skill_action', description: 'Approved action.', parameters: { type: 'object', properties: {} } },
      }),
      async run(args: any) {
        calls.push(args);
        return { source: 'host', contentSource: 'mixed-external', status: 'success', output: 'approved receipt' };
      },
    };
    const { backend, fake } = await startedBackend({ executableSkills });
    await startTurn(backend);
    expect(fake.clientMessages.find((message) => message.method === 'thread/start').params.dynamicTools)
      .toEqual([expect.objectContaining({ name: 'run_skill_action' })]);
    fake.request('item/tool/call', {
      threadId: 'thread-123', turnId: 'turn-1', callId: 'skill-call', namespace: null,
      tool: 'run_skill_action', arguments: { name: 'audit', action: 'run', input: {} },
    }, 'skill-request');
    await tick(); await tick();
    expect(calls).toEqual([{ name: 'audit', action: 'run', input: {} }]);
    expect(fake.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'skill-request', result: { success: true, contentItems: [{ type: 'inputText', text: 'approved receipt' }] } }),
    ]));
  });

  it('starts a fresh thread when an older snapshot gains coordinator tools', async () => {
    const onConversationReset = vi.fn();
    const teamMcpBridge = {
      async listTools() { return [{ name: 'list_agents', description: 'List agents.', inputSchema: { type: 'object' } }]; },
      async callTool() { return 'agents'; },
    };
    const { backend, fake } = await startedBackend({ teamMcpBridge, onConversationReset });
    backend.restore({ version: 1, messages: [{ codexThreadId: 'pre-v0985-thread' }] });
    await startTurn(backend);

    expect(fake.clientMessages.some((message) => message.method === 'thread/resume')).toBe(false);
    expect(fake.clientMessages.find((message) => message.method === 'thread/start')?.params.dynamicTools)
      .toEqual([expect.objectContaining({ name: 'list_agents' })]);
    expect(backend.snapshot()?.messages[0]).toMatchObject({
      codexThreadId: 'thread-123', codexDynamicTools: expect.stringContaining('"team":true'),
    });
    expect(onConversationReset).toHaveBeenCalledWith(expect.stringContaining('fresh conversation'));
  });

  it('steers an active Codex turn through turn/steer and refuses steering while idle', async () => {
    const { backend, fake } = await startedBackend();
    expect(backend.interject('too early')).toBe(false);
    await startTurn(backend);
    expect(backend.interject('Prioritize the failing test.')).toBe(true);
    await tick();
    expect(fake.clientMessages.find((message) => message.method === 'turn/steer').params).toMatchObject({
      threadId: 'thread-123', expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'Prioritize the failing test.', text_elements: [] }],
    });
  });

  it('uses Codex read-only permissions for Plan mode', async () => {
    const { backend, fake } = await startedBackend();
    await startTurn(backend, { mode: 'plan' });
    const start = fake.clientMessages.find((message) => message.method === 'thread/start');
    const turn = fake.clientMessages.find((message) => message.method === 'turn/start');
    expect(start.params).toMatchObject({
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only',
    });
    expect(turn.params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
  });

  it('forwards command, file-change, and bounded permission requests as single-use user approvals', async () => {
    const { backend, fake, approvals } = await startedBackend();
    const hostWaitPhases: string[] = [];
    backend.onEvent((event) => {
      if (event.kind === 'host_wait') hostWaitPhases.push(event.phase);
    });
    await startTurn(backend);
    fake.request('item/commandExecution/requestApproval', { command: 'npm test', cwd: process.cwd(), reason: 'verify' }, 'cmd');
    fake.notify('item/started', { item: { id: 'file-item', type: 'fileChange', status: 'inProgress', changes: [{ path: 'new.txt', diff: '@@ -0,0 +1 @@\n+hello\n', kind: { type: 'add' } }] } });
    fake.request('item/fileChange/requestApproval', { itemId: 'file-item', reason: 'apply patch' }, 'file');
    fake.request('item/permissions/requestApproval', {
      reason: 'write generated file',
      permissions: { network: null, fileSystem: { read: null, write: [process.cwd()] } },
    }, 'permission');
    await tick();
    expect(approvals.map((request) => request.kind).sort()).toEqual(['command', 'file-change', 'permission'].sort());
    expect(hostWaitPhases).toEqual(['started', 'started', 'started', 'completed', 'completed', 'completed']);
    expect(fake.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cmd', result: { decision: 'accept' } }),
      expect.objectContaining({ id: 'file', result: { decision: 'accept' } }),
      expect.objectContaining({ id: 'permission', result: expect.objectContaining({ scope: 'turn', strictAutoReview: true }) }),
    ]));
  });

  it('applies an optional embedding policy only after Codex emits an eligible command request', async () => {
    const check = vi.fn((command: string) => command === 'git status'
      ? { allowed: true }
      : command === 'npm test'
        ? { allowed: false, ask: true }
        : { allowed: false, reason: 'disabled' });
    const { backend, fake, approvals } = await startedBackend({ commandPolicy: { approvalMode: 'ask', check } });
    await startTurn(backend);
    fake.request('item/commandExecution/requestApproval', {
      command: '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'git status\'',
      commandActions: [{ type: 'read', command: 'git status' }],
    }, 'allowed');
    fake.request('item/commandExecution/requestApproval', { command: 'npm test' }, 'asked');
    fake.request('item/commandExecution/requestApproval', { command: 'touch nope' }, 'denied');
    await tick();
    expect(check).toHaveBeenCalledWith('git status');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: 'command', command: 'npm test' });
    expect(fake.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'allowed', result: { decision: 'accept' } }),
      expect.objectContaining({ id: 'asked', result: { decision: 'accept' } }),
      expect.objectContaining({ id: 'denied', result: { decision: 'decline' } }),
    ]));
  });

  it('checks the full transported command when a single Codex action summarizes only part of it', async () => {
    const transported = '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'node src/hello.js; Remove-Item y\'';
    const check = vi.fn((command: string) => command === 'node src/hello.js'
      ? { allowed: true }
      : { allowed: false, reason: 'not in the allowlist' });
    const { backend, fake, approvals } = await startedBackend({
      commandPolicy: { approvalMode: 'allowlist', check },
    });
    await startTurn(backend);
    fake.request('item/commandExecution/requestApproval', {
      command: transported,
      commandActions: [{ type: 'unknown', command: 'node src/hello.js' }],
    }, 'truncated-action');
    await tick();
    expect(codexCommandForPolicy(transported, ['node src/hello.js'])).toBe(transported);
    expect(check).toHaveBeenCalledWith(transported);
    expect(approvals).toContainEqual(expect.objectContaining({ kind: 'command', command: transported }));
    expect(fake.responses).toContainEqual(expect.objectContaining({
      id: 'truncated-action', result: { decision: 'accept' },
    }));
  });

  it('shows a card for a non-allowlisted Codex command while retaining hard destructive denials', async () => {
    const check = vi.fn((command: string) => command.includes('danger')
      ? { allowed: false, reason: 'matches a blocked destructive pattern' }
      : { allowed: false, reason: 'not in the allowlist' });
    const { backend, fake, approvals } = await startedBackend({
      commandPolicy: { approvalMode: 'allowlist', check },
    });
    await startTurn(backend);
    fake.request('item/commandExecution/requestApproval', { command: 'node src/hello.js' }, 'card');
    fake.request('item/commandExecution/requestApproval', { command: 'danger' }, 'hard-deny');
    await tick();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].command).toBe('node src/hello.js');
    expect(fake.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'card', result: { decision: 'accept' } }),
      expect.objectContaining({ id: 'hard-deny', result: { decision: 'decline' } }),
    ]));
  });

  it('supports the legacy injected Auto callback without changing production Codex semantics', async () => {
    const order: string[] = [];
    const prepared = await startedBackend({
      writeApprovalAsk: () => false,
      prepareFileCheckpoint: async (changes) => { order.push(`checkpoint:${changes[0].path}`); return { ok: true }; },
      requestApproval: async () => { order.push('card'); return { allow: true }; },
    });
    await startTurn(prepared.backend);
    prepared.fake.notify('item/started', { item: {
      id: 'change-1', type: 'fileChange', status: 'inProgress',
      changes: [{ path: 'safe.txt', diff: '@@ -0,0 +1 @@\n+safe\n', kind: { type: 'add' } }],
    } });
    prepared.fake.request('item/fileChange/requestApproval', { itemId: 'change-1' }, 'write-ok');
    await tick();
    expect(order).toEqual(['checkpoint:safe.txt']);
    expect(prepared.fake.responses).toContainEqual(expect.objectContaining({ id: 'write-ok', result: { decision: 'accept' } }));

    const fallback = await startedBackend({
      writeApprovalAsk: () => false,
      prepareFileCheckpoint: async () => ({ ok: false, note: 'checkpoint unavailable' }),
      requestApproval: async () => ({ allow: true }),
    });
    await startTurn(fallback.backend);
    fallback.fake.notify('item/started', { item: {
      id: 'change-2', type: 'fileChange', status: 'inProgress',
      changes: [{ path: 'manual.txt', diff: '@@ -0,0 +1 @@\n+manual\n', kind: { type: 'add' } }],
    } });
    fallback.fake.request('item/fileChange/requestApproval', { itemId: 'change-2' }, 'write-fallback');
    await tick();
    expect(fallback.approvals).toContainEqual(expect.objectContaining({
      kind: 'file-change', title: 'Codex write blocked', detail: expect.stringContaining('Auto could not protect this change'),
    }));
    expect(fallback.fake.responses).toContainEqual(expect.objectContaining({ id: 'write-fallback', result: { decision: 'decline' } }));
  });

  it('discovers account-visible models after initialization and reports the verified CLI version', async () => {
    const fake = fakeAppServer();
    const onModels = vi.fn();
    const backend = new CodexBackend(config(), undefined, {
      binaryPath: 'C:/tools/codex.exe', spawn: fake.spawn, access: () => access(),
      preflight: async () => '0.155.1', onModels, killProcessTree: async () => undefined,
    });
    await backend.start({});
    expect(onModels).toHaveBeenCalledWith([
      { id: 'gpt-test', name: 'GPT Test', vision: false, isDefault: true },
    ], '0.155.1');
  });

  it('routes the validated Codex MCP prompt to a single-use approval and executes only after allow', async () => {
    const { backend, fake, approvals } = await startedBackend();
    await startTurn(backend);
    fake.request('mcpServer/elicitation/request', {
      serverName: 'docs',
      threadId: 'thread-123',
      turnId: 'turn-1',
      mode: 'form',
      message: 'Allow the docs MCP server to run tool "search"?',
      requestedSchema: { type: 'object', properties: {} },
    }, 'mcp');
    await tick();
    expect(approvals).toContainEqual(expect.objectContaining({
      kind: 'mcp-tool', server: 'docs', tool: 'search',
    }));
    expect(fake.responses).toContainEqual(expect.objectContaining({
      id: 'mcp', result: { action: 'accept', content: {} },
    }));
  });

  it('declines MCP forms and malformed approval text without presenting them as tool approval', async () => {
    const { backend, fake, approvals } = await startedBackend();
    await startTurn(backend);
    fake.request('mcpServer/elicitation/request', {
      serverName: 'docs', mode: 'form', message: 'Enter a secret',
      requestedSchema: { type: 'object', properties: { token: { type: 'string' } } },
    }, 'mcp-form');
    fake.request('mcpServer/elicitation/request', {
      serverName: 'other', mode: 'form', message: 'Allow the docs MCP server to run tool "search"?',
      requestedSchema: { type: 'object', properties: {} },
    }, 'mcp-mismatch');
    await tick();
    expect(approvals).toHaveLength(0);
    expect(fake.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mcp-form', result: { action: 'decline' } }),
      expect.objectContaining({ id: 'mcp-mismatch', result: { action: 'decline' } }),
    ]));
  });

  it('declines unknown, malformed, timed-out, and host-forbidden requests without inventing approval', async () => {
    const never = () => new Promise<{ allow: boolean }>(() => undefined);
    const { backend, fake, approvals } = await startedBackend({ requestApproval: never, approvalTimeoutMs: 1 });
    await startTurn(backend, { mode: 'plan' });
    fake.request('item/commandExecution/requestApproval', { command: 'touch marker' }, 'plan-command');
    fake.request('item/fileChange/requestApproval', { reason: 'write' }, 'plan-file');
    fake.request('item/commandExecution/requestApproval', {}, 'malformed');
    fake.request('future/effect/requestApproval', { effect: true }, 'unknown');
    await tick();
    expect(approvals).toHaveLength(0);
    expect(fake.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plan-command', result: { decision: 'decline' } }),
      expect.objectContaining({ id: 'plan-file', result: { decision: 'decline' } }),
      expect.objectContaining({ id: 'malformed', result: { decision: 'decline' } }),
      expect.objectContaining({ id: 'unknown', error: expect.objectContaining({ code: -32601 }) }),
    ]));

    const live = await startedBackend({ requestApproval: never, approvalTimeoutMs: 1 });
    await startTurn(live.backend);
    live.fake.request('item/commandExecution/requestApproval', { command: 'npm test' }, 'timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(live.fake.responses).toContainEqual(expect.objectContaining({ id: 'timeout', result: { decision: 'decline' } }));
  });

  it('declines every file change in read-only Folder Access without showing a prompt', async () => {
    const runtimeAccess = access({ restricted: true, writeRoots: [] });
    const { backend, fake, approvals } = await startedBackend({ runtimeAccess });
    await startTurn(backend);
    fake.request('item/fileChange/requestApproval', { reason: 'write' }, 'read-only-file');
    await tick();
    expect(approvals).toHaveLength(0);
    expect(fake.responses).toContainEqual(expect.objectContaining({ id: 'read-only-file', result: { decision: 'decline' } }));
  });

  it('kills the process tree on stop and retains a thread id for resume', async () => {
    const fake = fakeAppServer();
    const killed: number[] = [];
    const backend = new CodexBackend(config(), undefined, {
      binaryPath: 'C:/tools/codex.exe', spawn: fake.spawn, access: () => access(),
      killProcessTree: async (pid) => { killed.push(pid); },
    });
    await backend.start({});
    await startTurn(backend);
    expect(backend.snapshot()).toEqual({
      version: 1,
      messages: [{ codexThreadId: 'thread-123', codexDynamicTools: '{"team":false,"mcpTools":[],"executableSkills":false}' }],
    });
    await backend.stop();
    expect(killed).toEqual([4321]);
    expect(backend.isAlive()).toBe(false);
  });

  it('maps App Server notifications and estimates usage when telemetry is absent', async () => {
    const { backend, fake } = await startedBackend();
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));
    await startTurn(backend);
    fake.notify('item/started', { item: { type: 'commandExecution', command: 'rg TODO' } });
    fake.notify('item/completed', { item: { type: 'commandExecution', command: 'rg TODO', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' } });
    fake.notify('item/agentMessage/delta', { delta: 'done' });
    fake.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } });
    await tick();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_use' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', ok: true }));
    expect(events).toContainEqual({ kind: 'assistant', text: 'done' });
    const result = events.find((event) => event.kind === 'turn_complete').result;
    expect(result).toMatchObject({ text: 'done', isError: false, usage: { estimated: true } });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it('separates distinct agent-message parts without splitting streaming deltas', async () => {
    const { backend, fake } = await startedBackend();
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));
    await startTurn(backend);

    fake.notify('item/agentMessage/delta', { itemId: 'message-1', partId: 'part-1', delta: 'alpha' });
    fake.notify('item/agentMessage/delta', { itemId: 'message-1', partId: 'part-1', delta: '-continued' });
    fake.notify('item/agentMessage/delta', { itemId: 'message-1', partId: 'part-2', delta: 'beta' });
    fake.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } });
    await tick();

    expect(events.filter((event) => event.kind === 'assistant').map((event) => event.text).join(''))
      .toBe('alpha-continued\n\nbeta');
    expect(events.find((event) => event.kind === 'turn_complete').result.text)
      .toBe('alpha-continued\n\nbeta');
  });

  it('shows native Codex MCP activity without exposing arguments or results', async () => {
    const { backend, fake } = await startedBackend();
    const events: any[] = [];
    backend.onEvent((event) => events.push(event));
    await startTurn(backend);

    fake.notify('item/started', { item: {
      type: 'mcpToolCall', id: 'mcp-1', server: 'native-docs', tool: 'lookup', status: 'inProgress',
      arguments: { secret: 'do-not-display' }, result: 'private result',
    } });
    fake.notify('item/completed', { item: {
      type: 'mcpToolCall', id: 'mcp-1', server: 'native-docs', tool: 'lookup', status: 'completed',
      arguments: { secret: 'do-not-display' }, result: 'private result',
    } });
    await tick();

    const native = events.filter((event) => event.kind === 'native_mcp_activity');
    expect(native).toEqual([
      { kind: 'native_mcp_activity', server: 'native-docs', tool: 'lookup', status: 'inProgress' },
      { kind: 'native_mcp_activity', server: 'native-docs', tool: 'lookup', status: 'completed' },
    ]);
    expect(JSON.stringify(native)).not.toContain('do-not-display');
    expect(JSON.stringify(native)).not.toContain('private result');
  });

  it('accepts Codex CLI 0.155.0 and newer while retaining live handshake and policy verification', () => {
    expect(isValidatedCodexCliVersion('codex-cli 0.155.1')).toBe(true);
    expect(isValidatedCodexCliVersion('codex-cli 0.155.0')).toBe(true);
    expect(isValidatedCodexCliVersion('codex-cli 0.156.0')).toBe(true);
    expect(isValidatedCodexCliVersion('codex-cli 1.0.0')).toBe(true);
    expect(isValidatedCodexCliVersion('codex-cli 0.154.99')).toBe(false);
    // The editor-bundled preview on the validation machine's PATH: below the 0.155.0 floor under semver.
    expect(isValidatedCodexCliVersion('codex-cli 0.155.0-alpha.16')).toBe(false);
    expect(isValidatedCodexCliVersion('codex-cli 0.155.0+build.7')).toBe(true);
    expect(isValidatedCodexCliVersion('codex-cli 0.156.0-alpha.1')).toBe(true);
    expect(isValidatedCodexCliVersion('codex-cli unknown')).toBe(false);
  });

  it('uses the measured full projects-map trust override instead of an ignored dotted key', () => {
    const override = codexProjectTrustOverride(process.cwd(), 'trusted');
    expect(override).toMatch(/^projects=\{ /);
    expect(override).toContain('trust_level = "trusted"');
    expect(override).not.toContain('projects."');
  });

  it('covers the working directory and every folder up to the workspace root in the trust override', async () => {
    // Measured on 0.155.1: in a non-git workspace an agent working in a subfolder is keyed by that subfolder.
    // A root-only override missed it and Codex wrote `[projects.'<subfolder>'] trust_level = "trusted"` into the
    // user's own config.toml — a silent write, and a trust grant the user never made in native Codex.
    const root = path.resolve(process.cwd());
    const cwd = path.join(root, 'packages', 'app');
    const key = (value: string) => JSON.stringify(process.platform === 'win32' ? value.toLowerCase() : value);
    for (const folder of [cwd, path.join(root, 'packages'), root]) {
      expect(buildCodexAppServerArgs({ projectRoot: root, mode: 'native', cwd }).join(' ')).toContain(key(folder));
    }
    // Never above the workspace root, and never for an unrelated folder.
    expect(buildCodexAppServerArgs({ projectRoot: root, mode: 'native', cwd }).join(' '))
      .not.toContain(key(path.dirname(root)));
    expect(buildCodexAppServerArgs({ projectRoot: root, mode: 'user-only', cwd: path.resolve(root, '..', 'elsewhere') })
      .join(' ')).not.toContain('elsewhere');

    // The production backend passes its working directory into the override.
    const fake = fakeAppServer();
    const repositoryGate = vi.fn(async () => ({ mode: 'native' as const, projectRoot: path.dirname(root), assertCurrent: vi.fn() }));
    const backend = new CodexBackend(config({ workingDirectory: root }), undefined, {
      binaryPath: 'C:/tools/codex.exe', spawn: fake.spawn, access: () => access({ readRoots: [root], writeRoots: [root] }),
      onBeforeRepositoryConfig: repositoryGate, killProcessTree: async () => undefined,
    });
    await backend.start({ PATH: 'safe' });
    expect(fake.calls[0].args.join(' ')).toContain(key(root));
  });
});
