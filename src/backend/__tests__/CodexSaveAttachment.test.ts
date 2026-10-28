/*
 * v0.9.97 P4: Codex reaches `save_attachment` as a dynamic tool served by the host's own file tools (review
 * resolution §2 route matrix: "save_attachment ... Codex CLI: exposed through the existing MCP file service as the
 * same host tool"). The App Server is a fake that answers the start-up checks and records what the backend sends.
 */
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend } from '../CodexBackend';
import { SAVE_ATTACHMENT_DESCRIPTION, type WorkspaceTools } from '../WorkspaceTools';
import type { AgentConfig, UserAttachment } from '../../types';
import { admitUserTurn, attachment, attachmentIds, PDF, PNG, saveHost, sha } from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { fixedCodexProgram } from './codexProgramFixture';
import { documentInput, documentRouteRenderer } from './documentRouteFixtures';
import { WRITE_DOCUMENT_SPEC } from '../../content/document/DocumentTool';

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

async function codexWith(options: {
  hostFileTools?: (tools: WorkspaceTools) => WorkspaceTools | undefined; teamMcpBridge?: any;
  requestBoundary?: any; attached?: UserAttachment[]; hostReadFile?: boolean;
} = {}) {
  const h = await saveHost();
  const sources = await admitUserTurn(h.assets, options.attached ?? [attachment('image.png', 'image/png', 'image', PNG)]);
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
    ...(options.requestBoundary ? { requestBoundary: options.requestBoundary } : {}),
    ...(options.hostReadFile ? { hostReadFile: true } : {}),
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
  return vi.waitFor(() => {
    const response = fake.responses.find(response => response.id === id);
    expect(response).toBeDefined(); return response;
  }, { timeout: 10_000 });
}

describe('D3 Codex App Server dynamic document tools', () => {
  it('sends PDF fallback through the dynamic tool and emits one runtime reminder', async () => {
    const renderer = await documentRouteRenderer();
    const { backend, fake } = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; } });
    const events: any[] = []; backend.onEvent(event => events.push(event));
    try {
      await turn(backend, {});
      fake.toolCall('write_document', documentInput('pdf', '\u0627'), 'pdf-fallback');
      const response = await answer(fake, 'pdf-fallback');
      expect(response.result.success).toBe(false);
      expect(JSON.stringify(response)).toContain('write the same document now with format docx');
      expect(JSON.stringify(response)).toContain('Export as PDF');
      expect(events.filter(event => event.kind === 'runtime_notice')).toEqual([
        { kind: 'runtime_notice', text: expect.stringContaining('asked the agent to save it as Word') },
      ]);
    } finally { await backend.stop(); }
  });
  it('keeps the 64 KiB argument cap on non-document dynamic tools', async () => {
    const next = await codexWith();
    try {
      await turn(next.backend, {});
      next.fake.toolCall('save_attachment', { asset_id: 'large', path: 'x'.repeat(70_000) }, 'large-other');
      expect(JSON.stringify(await answer(next.fake, 'large-other'))).toContain('64 KiB host limit');
    } finally { await next.backend.stop(); }
  });
  it.each(['docx', 'pdf'] as const)('registers, writes %s and returns the same read-back host receipt', async format => {
    const renderer = await documentRouteRenderer();
    const { h, fake, backend } = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; } });
    const events: any[] = []; backend.onEvent(event => events.push(event));
    try {
      await turn(backend, {});
      const thread = fake.clientMessages.find(message => message.method === 'thread/start');
      expect(thread.params.dynamicTools.find((tool: any) => tool.name === 'write_document')).toEqual({ name: 'write_document',
        description: WRITE_DOCUMENT_SPEC.function.description, inputSchema: WRITE_DOCUMENT_SPEC.function.parameters });
      expect(backend.snapshot()?.messages[0]).toMatchObject({ codexDynamicTools: expect.stringContaining('"writeDocument":true') });
      fake.toolCall('write_document', documentInput(format, format === 'docx' ? 'مرحبا' : 'CONTRACT 123'), 'document-1');
      const response = await answer(fake, 'document-1'); expect(response.result.success).toBe(true);
      const bytes = await fs.readFile(path.join(h.root, `out/result.${format}`));
      expect(bytes.subarray(0, 4).toString('hex')).toBe(format === 'docx' ? '504b0304' : '25504446');
      expect(response.result.contentItems[0].text).toContain(sha(bytes));
      expect(events.find(event => event.kind === 'tool_result')).toMatchObject({ outcome: { status: 'success', observedBy: 'host' },
        documentWrite: { code: 'written', receipt: { format, sha256: sha(bytes), bytes: bytes.length } } });
      if (format === 'docx') expect(events.find(event => event.kind === 'tool_result')).toMatchObject({ summary: expect.stringContaining('reader layout unverified') });
      (backend as any).threadDynamicToolSignature = JSON.stringify({ saveAttachment: true });
      fake.toolCall('write_document', { ...documentInput(format), path: `old.${format}` }, 'old-thread');
      expect((await answer(fake, 'old-thread')).result.success).toBe(false);
      expect(existsSync(path.join(h.root, `old.${format}`))).toBe(false);
    } finally { await backend.stop(); }
  });
  it('does not offer it without a renderer and refuses it in Plan mode', async () => {
    const old = await codexWith();
    try { await turn(old.backend, {}); expect(JSON.stringify(old.fake.clientMessages)).not.toContain('write_document'); }
    finally { await old.backend.stop(); }
    const renderer = await documentRouteRenderer();
    const next = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; } });
    try { await turn(next.backend, { mode: 'plan' }); next.fake.toolCall('write_document', documentInput('docx'), 'plan-doc');
      expect((await answer(next.fake, 'plan-doc')).result.success).toBe(false);
      expect(existsSync(path.join(next.h.root, 'out/result.docx'))).toBe(false);
    } finally { await next.backend.stop(); }
  });
  // v0.9.99: no 1 MiB document argument ceiling; a draft part writes nothing, so a request limit holds only the final part.
  it('accepts a write_document argument over the former 1 MiB ceiling, and holds only the final draft part at a request limit', async () => {
    const renderer = await documentRouteRenderer(); const held: string[] = [];
    const next = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; },
      requestBoundary: async (_kind: string, detail: { tool?: string }) => { held.push(detail?.tool ?? ''); return held.length > 1 ? 'stopped' : 'proceed'; } });
    try {
      await turn(next.backend, {}); const input = documentInput('docx');
      input.document.blocks = Array.from({ length: 160 }, (_, i) => ({ type: 'paragraph', content: [{ text: `P${i} ${'A'.repeat(7500)}` }] })) as any;
      expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(1_048_576);
      next.fake.toolCall('write_document', input, 'huge-doc'); expect((await answer(next.fake, 'huge-doc')).result.success).toBe(true);
      expect(existsSync(path.join(next.h.root, input.path))).toBe(true); expect(held).toEqual(['write_document']);
      const part = { ...documentInput('docx'), path: 'out/parts.docx', draft: 'parts' };
      next.fake.toolCall('write_document', part, 'part-1'); expect((await answer(next.fake, 'part-1')).result.success).toBe(true);
      expect(held).toEqual(['write_document']);
      next.fake.toolCall('write_document', { ...part, final: true }, 'part-final');
      expect((await answer(next.fake, 'part-final')).result.success).toBe(false);
      expect(held).toEqual(['write_document', 'write_document']); expect(existsSync(path.join(next.h.root, 'out/parts.docx'))).toBe(false);
    } finally { await next.backend.stop(); }
  }, 60_000);
  it('accepts a document over the old generic 64 KiB tool bound, and retains the coordinator execution check', async () => {
    const renderer = await documentRouteRenderer();
    const next = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; } });
    try {
      await turn(next.backend, {}); const input = documentInput('docx');
      input.document.blocks = [{ type: 'paragraph', content: Array.from({ length: 10 }, () => ({ text: 'A'.repeat(7500) })) }] as any;
      expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(65536);
      next.fake.toolCall('write_document', input, 'large-doc'); expect((await answer(next.fake, 'large-doc')).result.success).toBe(true);
    } finally { await next.backend.stop(); }
    const team = { listTools: async () => [], hasTeammates: () => true, currentCoordinatorTaskAttempt: () => ({}), canCoordinatorExecute: () => false };
    const pm = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; }, teamMcpBridge: team });
    try { await turn(pm.backend, {}); pm.fake.toolCall('write_document', documentInput('docx'), 'pm-doc');
      expect((await answer(pm.fake, 'pm-doc')).result.success).toBe(false);
      expect(existsSync(path.join(pm.h.root, 'out/result.docx'))).toBe(false);
    } finally { await pm.backend.stop(); }
  });
  it('keeps a pre-document thread and gives real steps for opting into a new document conversation', async () => {
    const old = await codexWith(); let snapshot;
    try { await turn(old.backend, {}); snapshot = { ...old.backend.snapshot()!, version: 3 as const,
      backend: 'codex' as const, hostTurnState: 'complete' as const }; }
    finally { await old.backend.stop(); }
    const renderer = await documentRouteRenderer();
    const next = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; } });
    try {
      expect(next.backend.restore(snapshot)).toBe(true); await turn(next.backend, {});
      expect(next.fake.clientMessages.filter(message => message.method === 'thread/resume')).toHaveLength(1);
      expect(next.fake.clientMessages.filter(message => message.method === 'thread/start')).toHaveLength(0);
      expect(next.fake.clientMessages.filter(message => message.method === 'turn/start')).toHaveLength(1);
      expect(JSON.stringify(next.backend.snapshot()?.messages[0])).not.toContain('writeDocument');
      expect(JSON.stringify(next.fake.clientMessages.find(message => message.method === 'turn/start'))).toContain('New Model Conversation (keep chat)');
      next.fake.toolCall('write_document', documentInput('docx'), 'old-doc');
      const refused = await answer(next.fake, 'old-doc'); expect(refused.result.success).toBe(false);
      expect(refused.result.contentItems[0].text).toContain('1. Select this agent');
      expect(refused.result.contentItems[0].text).toContain('Ctrl+Shift+P');
      expect(existsSync(path.join(next.h.root, 'out/result.docx'))).toBe(false);
    } finally { await next.backend.stop(); }
  });
});

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

  // v0.9.99 (B15): with no contract in force, a coordinator with teammates saves under its own permissions, with the
  // delegation reminder; a contract it filed that does not cover the save still refuses it.
  it('follows the coordinator contract rule when the agent coordinates teammates', async () => {
    let attempt: unknown = { contractId: 'contract-1' };
    const team = {
      async listTools() { return []; },
      async callTool() { return ''; },
      hasTeammates: () => true,
      currentCoordinatorTaskAttempt: () => attempt,
      canCoordinatorExecute: () => false,
    };
    const { h, sources, fake, backend, id } = await codexWith({ teamMcpBridge: team });
    try {
      await turn(backend, { delegationContentSources: sources });
      fake.toolCall('save_attachment', { asset_id: id, path: 'logo.png' }, 'pm-1');
      const response = await answer(fake, 'pm-1');
      expect(response.result.success).toBe(false);
      expect(response.result.contentItems[0].text).toMatch(/outside the task contract you filed/);
      expect(existsSync(path.join(h.root, 'logo.png'))).toBe(false);
      attempt = undefined;
      fake.toolCall('save_attachment', { asset_id: id, path: 'logo.png' }, 'pm-2');
      const own = await answer(fake, 'pm-2');
      expect(own.result.success).toBe(true);
      expect(own.result.contentItems[0].text).toContain('[host reminder] You have teammates.');
      expect((await fs.readFile(path.join(h.root, 'logo.png'))).equals(PNG)).toBe(true);
    } finally {
      await backend.stop();
    }
  });
});

// v0.9.99 (A11): a PDF a Codex agent cannot take no longer fails the whole turn. The turn goes to App Server without
// it; the model is told it did not get the PDF, never that it was read, and is pointed at the host tools that can
// still reach it; the user gets one notice line. Real content store, host file tools and save path.
describe('a Codex turn with a PDF attachment continues without it (v0.9.99)', () => {
  const pdf = () => attachment('board-pack.pdf', 'application/pdf', 'pdf', PDF);
  const sentText = (fake: ReturnType<typeof fakeAppServer>) =>
    fake.clientMessages.find((message) => message.method === 'turn/start')?.params.input[0].text as string;

  it('sends the turn, names the PDF as not delivered, and the named save and read path works', async () => {
    const attached = [pdf()];
    const { h, sources, fake, backend, id } = await codexWith({ attached, hostReadFile: true });
    const events: any[] = []; backend.onEvent((event) => events.push(event));
    try {
      await turn(backend, { userAttachments: attached, delegationContentSources: sources });
      const text = sentText(fake);
      expect(text).toContain('[attachments not delivered]');
      expect(text).toContain('- board-pack.pdf: Codex CLI does not take PDF files.');
      expect(text).toContain('Do not say you read or reviewed them.');
      expect(text).toContain('save it into the workspace with save_attachment');
      expect(text).toContain('read_file');
      expect(fake.clientMessages.find((message) => message.method === 'turn/start').params.input).toHaveLength(1);
      // Never reported as sent: the turn's delivery receipt carries no user attachment.
      expect(events.filter((event) => event.kind === 'turn_input_delivered').map((event) => event.userAttachments)).toEqual([[]]);
      expect(events.filter((event) => event.kind === 'runtime_notice')).toEqual([{ kind: 'runtime_notice',
        text: expect.stringMatching(/^The agent did not receive board-pack\.pdf: Codex CLI does not take PDF files\. The turn continues without it\./) }]);
      expect(events.some((event) => event.kind === 'turn_complete')).toBe(false);
      // The path the model was given: the existing save tool writes the attached bytes, and read_file is offered.
      const offered = fake.clientMessages.find((message) => message.method === 'thread/start').params.dynamicTools.map((tool: any) => tool.name);
      expect(offered).toEqual(expect.arrayContaining(['save_attachment', 'read_file']));
      fake.toolCall('save_attachment', { asset_id: id, path: 'board-pack.pdf' }, 'save-pdf');
      expect((await answer(fake, 'save-pdf')).result.success).toBe(true);
      expect((await fs.readFile(path.join(h.root, 'board-pack.pdf'))).equals(PDF)).toBe(true);
    } finally {
      await backend.stop();
    }
  });

  it('without a tool that can read it, tells the model to ask the user instead of pointing at a tool it lacks', async () => {
    const attached = [pdf()];
    const { sources, fake, backend } = await codexWith({ attached, hostFileTools: () => undefined });
    try {
      await turn(backend, { userAttachments: attached, delegationContentSources: sources });
      const text = sentText(fake);
      expect(text).toContain('- board-pack.pdf: Codex CLI does not take PDF files.');
      expect(text).toContain('You have no tool here that can read a PDF.');
      expect(text).not.toContain('save_attachment using');
    } finally {
      await backend.stop();
    }
  });

  it('in Plan mode, where saving is refused, does not point at save_attachment', async () => {
    const attached = [pdf()];
    const { sources, fake, backend } = await codexWith({ attached, hostReadFile: true });
    try {
      await turn(backend, { userAttachments: attached, delegationContentSources: sources, mode: 'plan' });
      expect(sentText(fake)).toContain('You have no tool here that can read a PDF.');
    } finally {
      await backend.stop();
    }
  });
});
