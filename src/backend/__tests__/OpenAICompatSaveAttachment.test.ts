/*
 * v0.9.97 P4: an OpenAI-compatible agent has `save_attachment` as a host tool (review resolution §2 route matrix:
 * "save_attachment: OpenAI-compatible: the host tool"). A turn that is handed the user's attachment saves it byte for
 * byte; a coordinator with teammates saves only under a task contract that selects it, as for write_file.
 */
import { realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentFailure } from '../../content/document/DocumentContracts';
import { OpenAICompatBackend, type FetchFn } from '../OpenAICompatBackend';
import type { BackendEvent } from '../AgentBackend';
import type { AgentConfig } from '../../types';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { FileWritePolicy } from '../fileWritePolicy';
import { admitUserTurn, attachment, attachmentIds, PNG, sha } from './attachmentSaveFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { documentInput, documentRouteRenderer } from './documentRouteFixtures';
import { WRITE_DOCUMENT_SPEC } from '../../content/document/DocumentTool';
import { saveHost } from './attachmentSaveFixtures';

afterEach(removeTemporaryFolders);

function config(root: string): AgentConfig {
  return {
    id: 'a1', name: 'Worker', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools: ['read', 'write'],
    workingDirectory: root,
  };
}

const toolCall = (name: string, args: Record<string, unknown>, id: string) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});
const reply = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });

describe('D3 document tool through the actual OpenAI-compatible turn router', () => {
  it('relays PDF failure and one closable notice, then accepts an agent-requested Word write with its own receipt', async () => {
    const h = await saveHost(); const renderer = await documentRouteRenderer();
    vi.spyOn(renderer, 'render').mockRejectedValueOnce(new DocumentFailure('font-unavailable'));
    const bodies: any[] = []; let index = 0;
    const pdf = documentInput('pdf'); const docx = { ...pdf, path: 'out/result.docx', format: 'docx' };
    const replies = [toolCall('write_document', pdf, 'pdf-1'), toolCall('write_document', docx, 'docx-2'), reply('Word is ready.')];
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => JSON.stringify(replies[index++]) };
    }, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, { documentRenderer: renderer, fileWrites: h.fileWrites('a1') });
    const events: BackendEvent[] = [];
    const done = new Promise<void>(resolve => backend.onEvent(event => { events.push(event); if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Make the contract PDF.'); await done;
      expect(JSON.stringify(bodies[1].messages)).toContain('write the same document now with format docx');
      expect(JSON.stringify(bodies[1].messages)).toContain('Export as PDF');
      expect(events.filter(event => event.kind === 'runtime_notice')).toEqual([
        { kind: 'runtime_notice', text: expect.stringContaining('asked the agent to save it as Word') },
      ]);
      const results = events.filter(event => event.kind === 'tool_result');
      expect(results[0]).toMatchObject({ documentWrite: { code: 'font-unavailable' } });
      const bytes = await fs.readFile(path.join(h.root, docx.path));
      expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
      expect(results[1]).toMatchObject({ outcome: { status: 'success' }, documentWrite: { code: 'written', receipt: {
        format: 'docx', path: docx.path, sha256: sha(bytes),
      } } });
      expect(await fs.readdir(path.join(h.root, 'out'))).toEqual(['result.docx']);
    } finally { await backend.stop(); }
  }, 15_000);
  it.each(['docx', 'pdf'] as const)('advertises and writes real %s bytes with one host read-back receipt', async format => {
    const effects: unknown[] = []; const h = await saveHost({ onEffect: effect => effects.push(effect) }); const renderer = await documentRouteRenderer();
    const bodies: any[] = []; let index = 0;
    const replies = [toolCall('write_document', documentInput(format, format === 'docx' ? 'مرحبا' : 'CONTRACT 123'), 'document-1'), reply('Saved.')];
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => JSON.stringify(replies[Math.min(index++, 1)]) };
    }, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, { documentRenderer: renderer, fileWrites: h.fileWrites('a1') });
    const events: BackendEvent[] = [];
    const done = new Promise<void>(resolve => backend.onEvent(event => { events.push(event); if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Make the contract.'); await done;
      expect(bodies[0].tools.find((s: any) => s.function.name === 'write_document')).toEqual(WRITE_DOCUMENT_SPEC);
      const bytes = await fs.readFile(path.join(h.root, `out/result.${format}`));
      expect(bytes.subarray(0, 4).toString('hex')).toBe(format === 'docx' ? '504b0304' : '25504446');
      expect(events.find(event => event.kind === 'tool_result')).toMatchObject({ outcome: { status: 'success', observedBy: 'host' },
        documentWrite: { code: 'written', receipt: { format, bytes: bytes.length, sha256: sha(bytes) } } });
      expect(JSON.stringify(bodies[1].messages)).toContain(sha(bytes));
      expect(effects).toHaveLength(1);
      if (format === 'docx') {
        expect(JSON.stringify(bodies[1].messages)).toContain('reader layout');
        expect(events.find(event => event.kind === 'tool_result')).toMatchObject({ summary: expect.stringContaining('reader layout unverified') });
      }
    } finally { await backend.stop(); }
  }, 15_000);
  it('keeps explicit no-write and Plan scopes, and the coordinator contract', async () => {
    const h = await saveHost(); const renderer = await documentRouteRenderer();
    const backend = new OpenAICompatBackend({ ...config(h.root), allowedTools: ['read'] });
    (backend as any).tools.setDocumentRenderer(renderer);
    expect((backend as any).tools.specs().some((s: any) => s.function.name === 'write_document')).toBe(false);
    expect((await (backend as any).routeToolCall('write_document', documentInput('docx'))).ok).toBe(false);
    // v0.9.99 (B15): a contract the coordinator filed that does not cover the write still refuses it.
    const team = { has: () => false, hasTeammates: () => true, canCoordinatorExecute: () => false, specs: () => [],
      currentCoordinatorTaskAttempt: () => ({ contractId: 'contract-1' }) };
    const pm = new OpenAICompatBackend(config(h.root), undefined, team as any);
    (pm as any).tools.setDocumentRenderer(renderer);
    expect((await (pm as any).routeToolCall('write_document', documentInput('docx'))).output).toContain('outside the task contract you filed');
    (pm as any).currentMode = 'plan';
    expect((await (pm as any).routeToolCall('write_document', documentInput('docx'))).ok).toBe(false);
    expect(await fs.readdir(h.root)).toEqual([]);
  });
});

describe('save_attachment on the OpenAI-compatible route (review resolution §2)', () => {
  it('is offered to the model, and a turn handed the attachment saves it byte for byte', async () => {
    const root = realpathSync.native(await temporaryFolder('unode-p4-openai-'));
    const store = new ContentAssetStore();
    const sources = await admitUserTurn(store, [attachment('image.png', 'image/png', 'image', PNG)]);
    const [id] = attachmentIds(sources);
    const bodies: any[] = [];
    const responses = [toolCall('save_attachment', { asset_id: id, path: 'assets/logo.png' }, 'call-1'), reply('Saved.')];
    let index = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return { ok: true, status: 200, text: async () => JSON.stringify(responses[Math.min(index++, responses.length - 1)]) };
    };
    const writes = new FileWritePolicy({ workspaceId: () => 'w' }).forAgent({ agentId: 'a1', requestId: () => 'r1', decide: async () => 'once' });
    const backend = new OpenAICompatBackend(
      config(root), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { fileWrites: writes, delegationContentAssets: store },
    );
    const results: BackendEvent[] = [];
    const done = new Promise<void>((resolve) => backend.onEvent((event: BackendEvent) => {
      if (event.kind === 'tool_result') results.push(event);
      if (event.kind === 'turn_complete') resolve();
    }));
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    backend.sendUserTurn('save it', { delegationContentSources: sources });
    await done;
    await backend.stop();

    const offered = bodies[0].tools.find((tool: any) => tool.function.name === 'save_attachment');
    expect(offered.function.parameters.required).toEqual(['asset_id', 'path']);
    expect((await fs.readFile(path.join(root, 'assets', 'logo.png'))).equals(PNG)).toBe(true);
    const toolMessage = bodies[1].messages.find((message: any) => message.role === 'tool');
    expect(toolMessage.content).toContain(`Saved attachment ${id} to assets/logo.png as a new file: ${PNG.length} bytes, SHA-256 ${sha(PNG)}`);
    await store.dispose();
  });

  // v0.9.99 (B15): as write_file does, a coordinator with teammates and no contract in force reaches the save under its
  // own permissions (here the host still refuses an attachment this turn did not hand it); a filed contract that does
  // not cover the save refuses it.
  it('follows the coordinator contract rule when the agent coordinates teammates, as write_file does', async () => {
    const root = realpathSync.native(await temporaryFolder('unode-p4-openai-pm-'));
    let attempt: unknown = undefined;
    const team = {
      has: () => false,
      hasTeammates: () => true,
      canCoordinatorExecute: () => false,
      currentCoordinatorTaskAttempt: () => attempt,
      specs: () => [],
    };
    const backend = new OpenAICompatBackend(config(root), (async () => ({ ok: true, status: 200, text: async () => '{}' })) as FetchFn, team as any);
    const own = await (backend as any).routeToolCall('save_attachment', { asset_id: 'content-1', path: 'logo.png' });
    expect(own.ok).toBe(false);
    expect(own.output).toMatch(/not available to this agent/);
    expect(own.output).not.toMatch(/task contract/);
    attempt = { contractId: 'contract-1' };
    const routed = await (backend as any).routeToolCall('save_attachment', { asset_id: 'content-1', path: 'logo.png' });
    expect(routed.ok).toBe(false);
    expect(routed.output).toMatch(/outside the task contract you filed/);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
