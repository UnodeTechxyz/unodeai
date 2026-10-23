/*
 * v0.9.97 P4: Codex reaches `save_attachment` as a dynamic tool served by the host's own file tools (review
 * resolution §2 route matrix: "save_attachment ... Codex CLI: exposed through the existing MCP file service as the
 * same host tool"). The App Server is a fake that answers the start-up checks and records what the backend sends.
 */
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend } from '../CodexBackend';
import { SAVE_ATTACHMENT_DESCRIPTION, type WorkspaceTools } from '../WorkspaceTools';
import type { AgentConfig } from '../../types';
import { admitUserTurn, attachment, attachmentIds, PNG, saveHost, sha } from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { fixedCodexProgram } from './codexProgramFixture';

afterEach(removeTemporaryFolders);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function config(dir: string): AgentConfig {
  return {
    id: 'codex-1', name: 'Codex Dev', role: 'developer', skill: '',
    provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: CODEX_CLI_DEFAULT_MODEL,
    systemPrompt: 'Work.', autoApprove: true, allowedTools: ['read', 'write', 'execute'], backend: 'codex', workingDirectory: dir,
  };
}

/** Just enough App Server: the start-up checks answered from the host's own argv, one thread, one turn. */
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
            // The sandbox asked for, as App Server reports it back: Plan mode asks for read-only.
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
    toolCall(tool: string, args: Record<string, unknown>, id: string) {
      emit({ jsonrpc: '2.0', id, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: id, namespace: null, tool, arguments: args } });
    },
  };
}

async function codexWith(options: { hostFileTools?: (tools: WorkspaceTools) => WorkspaceTools | undefined; teamMcpBridge?: any } = {}) {
  const h = await saveHost();
  const sources = await admitUserTurn(h.assets, [attachment('image.png', 'image/png', 'image', PNG)]);
  const tools = h.tools('codex-1');
  const fake = fakeAppServer();
  const hostFileTools = options.hostFileTools ? options.hostFileTools(tools) : tools;
  const backend = new CodexBackend(config(h.root), undefined, {
    launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
    spawn: fake.spawn,
    access: () => ({ trusted: true, restricted: false, readRoots: [h.root], writeRoots: [h.root] }),
    requestApproval: async () => ({ allow: false }),
    killProcessTree: async () => undefined,
    ...(hostFileTools ? { hostFileTools } : {}),
    ...(options.teamMcpBridge ? { teamMcpBridge: options.teamMcpBridge } : {}),
  });
  await backend.start({ PATH: 'safe' }, { pin: 'take' });
  return { h, sources, tools, fake, backend, id: attachmentIds(sources)[0] };
}

async function turn(backend: CodexBackend, attachments: Record<string, unknown>): Promise<void> {
  backend.sendUserTurn('save it', attachments as any);
  await tick();
  await tick();
}

async function answer(fake: ReturnType<typeof fakeAppServer>, id: string): Promise<any> {
  for (let i = 0; i < 50 && !fake.responses.some((response) => response.id === id); i++) await tick();
  return fake.responses.find((response) => response.id === id);
}

describe('save_attachment as a Codex dynamic tool (review resolution §2)', () => {
  it('offers the one description and input, and saves byte for byte through the host tools', async () => {
    const { h, sources, fake, backend, id } = await codexWith();
    try {
      await turn(backend, { delegationContentSources: sources });
      const offered = fake.clientMessages.find((message) => message.method === 'thread/start').params.dynamicTools;
      const tool = offered.find((candidate: any) => candidate.name === 'save_attachment');
      expect(tool).toEqual({
        name: 'save_attachment',
        description: SAVE_ATTACHMENT_DESCRIPTION,
        inputSchema: { type: 'object', properties: { asset_id: expect.any(Object), path: expect.any(Object) }, required: ['asset_id', 'path'] },
      });
      fake.toolCall('save_attachment', { asset_id: id, path: 'assets/logo.png' }, 'save-1');
      const response = await answer(fake, 'save-1');
      expect(response.result.success).toBe(true);
      expect(response.result.contentItems[0].text).toContain(`Saved attachment ${id} to assets/logo.png as a new file: ${PNG.length} bytes, SHA-256 ${sha(PNG)}`);
      expect((await fs.readFile(path.join(h.root, 'assets', 'logo.png'))).equals(PNG)).toBe(true);
      // The thread records that it was started with the tool, so a thread without it is not resumed as if it had it.
      expect(backend.snapshot()?.messages[0]).toMatchObject({ codexDynamicTools: expect.stringContaining('"saveAttachment":true') });
    } finally {
      await backend.stop();
    }
  });

  it('refuses in Plan mode', async () => {
    const { h, sources, fake, backend, id } = await codexWith();
    try {
      await turn(backend, { mode: 'plan', delegationContentSources: sources });
      fake.toolCall('save_attachment', { asset_id: id, path: 'plan.png' }, 'plan-1');
      const planned = await answer(fake, 'plan-1');
      expect(planned.result.success).toBe(false);
      expect(planned.result.contentItems[0].text).toMatch(/save_attachment is unavailable in Plan mode/);
      expect(existsSync(path.join(h.root, 'plan.png'))).toBe(false);
    } finally {
      await backend.stop();
    }
  });

  it('saves nothing for an attachment the turn did not grant', async () => {
    const { h, fake, backend, id } = await codexWith();
    try {
      await turn(backend, {});
      fake.toolCall('save_attachment', { asset_id: id, path: 'ungranted.png' }, 'ungranted-1');
      const ungranted = await answer(fake, 'ungranted-1');
      expect(ungranted.result.success).toBe(false);
      expect(ungranted.result.contentItems[0].text).toMatch(/asset-unavailable/);
      expect(existsSync(path.join(h.root, 'ungranted.png'))).toBe(false);
    } finally {
      await backend.stop();
    }
  });

  it('is not offered without the host tools, and leaves the thread\'s tool signature as it was', async () => {
    const { fake, backend } = await codexWith({ hostFileTools: () => undefined });
    try {
      await turn(backend, {});
      const offered = fake.clientMessages.find((message) => message.method === 'thread/start').params.dynamicTools ?? [];
      expect(offered.map((candidate: any) => candidate.name)).not.toContain('save_attachment');
      expect(JSON.stringify(backend.snapshot()?.messages[0] ?? {})).not.toContain('saveAttachment');
    } finally {
      await backend.stop();
    }
  });

  it('stopping the agent retires the host tools', async () => {
    const { h, sources, tools, backend, id } = await codexWith();
    await turn(backend, { delegationContentSources: sources });
    await backend.stop();
    expect(await tools.run('save_attachment', { asset_id: id, path: 'logo.png' })).toMatchObject({ attachmentSave: { code: 'interrupted' } });
    expect(existsSync(path.join(h.root, 'logo.png'))).toBe(false);
  });

  it('needs a coordinator contract when the agent coordinates teammates', async () => {
    const team = {
      async listTools() { return []; },
      async callTool() { return ''; },
      hasTeammates: () => true,
      currentCoordinatorTaskAttempt: () => undefined,
      canCoordinatorExecute: () => false,
    };
    const { h, sources, fake, backend, id } = await codexWith({ teamMcpBridge: team });
    try {
      await turn(backend, { delegationContentSources: sources });
      fake.toolCall('save_attachment', { asset_id: id, path: 'logo.png' }, 'pm-1');
      const response = await answer(fake, 'pm-1');
      expect(response.result.success).toBe(false);
      expect(response.result.contentItems[0].text).toMatch(/Coordinator execution is not authorised/);
      expect(existsSync(path.join(h.root, 'logo.png'))).toBe(false);
    } finally {
      await backend.stop();
    }
  });
});
