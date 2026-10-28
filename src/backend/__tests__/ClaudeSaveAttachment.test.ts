/*
 * v0.9.97 P4: Claude reaches `save_attachment` through its existing files bridge, served by the host's own file tools
 * (review resolution §2 route matrix: "save_attachment ... Claude CLI: exposed through the existing MCP file service
 * as the same host tool"). The bridge's read tools stay read-only; Plan mode, a stopped agent and a coordinator
 * without a contract make no save.
 */
import { EventEmitter } from 'events';
import { existsSync, readdirSync } from 'fs';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import { SAVE_ATTACHMENT_DESCRIPTION } from '../WorkspaceTools';
import type { AgentConfig } from '../../types';
import { admitUserTurn, attachment, attachmentIds, PDF, PNG, saveHost, sha } from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { documentInput, documentRouteRenderer } from './documentRouteFixtures';
import { WRITE_DOCUMENT_SPEC } from '../../content/document/DocumentTool';

afterEach(removeTemporaryFolders);

function config(dir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'claude-1', name: 'Claude Dev', role: 'developer', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' }, model: 'claude-sonnet-4-5',
    systemPrompt: 'Follow the role.', autoApprove: true, allowedTools: ['read', 'write'], backend: 'claude',
    workingDirectory: dir, ...overrides,
  };
}

function fakeSpawn() {
  const calls: Array<{ args: string[] }> = [];
  const fn = (_cmd: string, args: string[]) => {
    calls.push({ args });
    const proc = new EventEmitter() as any;
    proc.pid = 1234;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = { write: () => true, end: () => undefined };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    setTimeout(() => proc.emit('spawn'), 0);
    return proc;
  };
  return { fn, calls };
}

async function filesBridge(dir: string): Promise<{ url: string; headers?: Record<string, string> }> {
  const root = path.join(dir, '.unode', 'claude');
  const [file] = existsSync(root) ? readdirSync(root).map((id) => path.join(root, id, 'mcp.json')).filter(existsSync) : [];
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  const id = Object.keys(written.mcpServers).find((key) => /^unode_files_[a-f0-9]{32}$/.test(key))!;
  return written.mcpServers[id];
}

function rpc(spec: { url: string; headers?: Record<string, string> }, body: unknown): Promise<any> {
  const url = new URL(spec.url);
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: Number(url.port), path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Authorization: String(spec.headers?.Authorization ?? '') },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (out += chunk));
      res.on('end', () => resolve(out ? JSON.parse(out) : undefined));
    });
    req.on('error', reject);
    req.end(text);
  });
}

const call = (spec: { url: string }, args: Record<string, unknown>) =>
  rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'save_attachment', arguments: args } });

async function claudeWithHostTools(withTools = true) {
  const h = await saveHost();
  const sources = await admitUserTurn(h.assets, [attachment('image.png', 'image/png', 'image', PNG)]);
  const tools = h.tools('claude-1');
  const spawn = fakeSpawn();
  const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, {
    spawn: spawn.fn as any,
    writeRoots: [h.root],
    // As the host passes it: the bridge then exists for its readers, with or without the host tools.
    delegationContentAssets: h.assets,
    ...(withTools ? { hostFileTools: tools } : {}),
  });
  await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
  return { h, sources, tools, backend, spawn, id: attachmentIds(sources)[0] };
}

describe('D3 actual Claude files bridge to real document worker', () => {
  it('sends a PDF fallback through the actual files bridge and emits one runtime reminder', async () => {
    const h = await saveHost(); const tools = h.tools('claude-1');
    tools.setDocumentRenderer(await documentRouteRenderer());
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: fakeSpawn().fn as any,
      writeRoots: [h.root], hostFileTools: tools });
    const events: any[] = []; backend.onEvent(event => events.push(event));
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Make a PDF.'); const spec = await filesBridge(h.root);
      const result = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'write_document', arguments: documentInput('pdf', '\u0627'),
      } });
      expect(result.result.isError).toBe(true);
      expect(result.result.content[0].text).toContain('write the same document now with format docx');
      expect(result.result.content[0].text).toContain('Export as PDF');
      expect(events.filter(event => event.kind === 'runtime_notice')).toEqual([
        { kind: 'runtime_notice', text: expect.stringContaining('asked the agent to save it as Word') },
      ]);
    } finally { await backend.stop(50); }
  });
  it.each(['docx', 'pdf'] as const)('lists and writes %s, with a host fact joined to the CLI tool-use id', async format => {
    const h = await saveHost(); const tools = h.tools('claude-1'); tools.setDocumentRenderer(await documentRouteRenderer());
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: fakeSpawn().fn as any,
      writeRoots: [h.root], hostFileTools: tools });
    const events: any[] = []; backend.onEvent(event => events.push(event));
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Make a contract.'); const spec = await filesBridge(h.root);
      const input = documentInput(format, format === 'docx' ? 'مرحبا' : 'CONTRACT 123');
      const listed = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(listed.result.tools.find((tool: any) => tool.name === 'write_document')).toEqual({
        name: 'write_document', description: WRITE_DOCUMENT_SPEC.function.description, inputSchema: WRITE_DOCUMENT_SPEC.function.parameters });
      const name = `mcp__${(backend as any).bridgeIds.files}__write_document`;
      (backend as any).handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'doc-1', name, input }] } });
      await (backend as any).eventChain;
      const result = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'write_document', arguments: input, _meta: { 'claudecode/toolUseId': 'doc-1' } } });
      expect(result.result.isError).toBeFalsy(); const output = result.result.content[0].text;
      (backend as any).handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'doc-1', content: output }] } });
      await (backend as any).eventChain;
      const bytes = await fs.readFile(path.join(h.root, `out/result.${format}`));
      expect(bytes.subarray(0, 4).toString('hex')).toBe(format === 'docx' ? '504b0304' : '25504446');
      expect(events.find(event => event.kind === 'tool_result')).toMatchObject({ outcome: { status: 'success', observedBy: 'host' },
        documentWrite: { code: 'written', receipt: { format, sha256: sha(bytes), bytes: bytes.length } } });
      if (format === 'docx') expect(events.find(event => event.kind === 'tool_result')).toMatchObject({ summary: expect.stringContaining('reader layout unverified') });
      backend.sendUserTurn('Plan only.', { mode: 'plan' });
      const plan = await rpc(spec, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_document', arguments: documentInput(format) } });
      expect(plan.result.isError).toBe(true); expect(plan.result.content[0].text).toContain('unavailable in Plan mode');
    } finally { await backend.stop(50); }
  });
  // v0.9.99 (B15): a contract the coordinator filed still governs its own writes in the actual handler; with no
  // contract in force the write runs under its own permissions and the result carries the delegation reminder.
  it('checks the coordinator contract in the actual handler, not only the PreToolUse hook', async () => {
    const h = await saveHost(); const tools = h.tools(); tools.setDocumentRenderer(await documentRouteRenderer());
    let attempt: unknown = { contractId: 'contract-1' };
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { hostFileTools: tools,
      teamMcpBridge: { hasTeammates: () => true, currentCoordinatorTaskAttempt: () => attempt, canCoordinatorExecute: () => false } as any });
    const doc = (backend as any).buildFilesBridgeTools(new (tools.constructor as any)(h.root, new Set(['read']))).find((tool: any) => tool.name === 'write_document');
    const refused = await doc.handler(documentInput('docx'), { signal: new AbortController().signal });
    expect(refused.outcome).toMatchObject({ status: 'refused' });
    expect(JSON.stringify(refused)).toContain('outside the task contract you filed');
    expect(await fs.readdir(h.root)).toEqual([]);
    attempt = undefined;
    const own = await doc.handler(documentInput('docx'), { signal: new AbortController().signal });
    expect(own.outcome).toMatchObject({ status: 'success' });
    expect(JSON.stringify(own)).toContain('[host reminder] You have teammates.');
    expect(existsSync(path.join(h.root, 'out/result.docx'))).toBe(true);
  });
  it('accepts a valid structured document over 64 KiB without widening other bridge tool bodies', async () => {
    const h = await saveHost(); const tools = h.tools(); tools.setDocumentRenderer(await documentRouteRenderer());
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: fakeSpawn().fn as any,
      writeRoots: [h.root], hostFileTools: tools });
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Make a long document.'); const spec = await filesBridge(h.root);
      const input = documentInput('docx'); input.document.blocks = [{ type: 'paragraph', content: Array.from({ length: 10 }, () => ({ text: 'A'.repeat(7500) })) }] as any;
      expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(65536);
      const result = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_document', arguments: input } });
      expect(result.result.isError).toBeFalsy(); expect(existsSync(path.join(h.root, input.path))).toBe(true);
      const other = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'x', extra: 'A'.repeat(70000) } } });
      expect(other).toEqual({ error: 'bad request' });
    } finally { await backend.stop(50); }
  });
  // v0.9.99: the local MCP body no longer caps a document at 1 MiB; draft parts are not request effects.
  it('accepts a write_document body over the former 1 MiB document ceiling and holds only the final draft part at a request limit', async () => {
    const h = await saveHost(); const tools = h.tools(); tools.setDocumentRenderer(await documentRouteRenderer());
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: fakeSpawn().fn as any,
      writeRoots: [h.root], hostFileTools: tools });
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Make a very long document.'); const spec = await filesBridge(h.root);
      const input = documentInput('docx');
      input.document.blocks = Array.from({ length: 160 }, (_, i) => ({ type: 'paragraph', content: [{ text: `P${i} ${'A'.repeat(7500)}` }] })) as any;
      expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(1_048_576);
      const result = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_document', arguments: input } });
      expect(result.result.isError).toBeFalsy(); expect(result.result.content[0].text).toContain('Document written');
      expect(existsSync(path.join(h.root, input.path))).toBe(true);
      const files = `mcp__${(backend as any).bridgeIds.files}__write_document`.toLowerCase();
      expect((backend as any).isRequestEffect(files, { ...input, draft: 'long' })).toBe(false);
      expect((backend as any).isRequestEffect(files, { ...input, draft: 'long', final: true })).toBe(true);
      expect((backend as any).isRequestEffect(files, input)).toBe(true);
    } finally { await backend.stop(50); }
  }, 60_000);
});

describe('save_attachment over Claude\'s files bridge (review resolution §2)', () => {
  it('lists the tool with its one description and input, allows it at launch, and saves byte for byte', async () => {
    const { h, sources, backend, spawn, id } = await claudeWithHostTools();
    try {
      const spec = await filesBridge(h.root);
      const list = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const tool = list.result.tools.find((candidate: any) => candidate.name === 'save_attachment');
      expect(tool.description).toBe(SAVE_ATTACHMENT_DESCRIPTION);
      expect(tool.inputSchema).toEqual({ type: 'object', properties: { asset_id: expect.any(Object), path: expect.any(Object) }, required: ['asset_id', 'path'] });
      // The bridge's other tools stay what they were: no write tool of the host is offered beside it.
      expect(list.result.tools.map((candidate: any) => candidate.name)).not.toContain('write_file');
      expect(spawn.calls[0].args).toContainEqual(expect.stringMatching(/^mcp__unode_files_[a-f0-9]{32}__save_attachment$/));

      // Before the turn names its attachments, the tools hold no grant to them.
      expect((await call(spec, { asset_id: id, path: 'early.png' })).result.content[0].text).toMatch(/asset-unavailable/);
      backend.sendUserTurn('save it', { delegationContentSources: sources });
      const saved = await call(spec, { asset_id: id, path: 'assets/logo.png' });
      expect(saved.result.isError).toBeFalsy();
      expect(saved.result.content[0].text).toContain(`Saved attachment ${id} to assets/logo.png as a new file: ${PNG.length} bytes, SHA-256 ${sha(PNG)}`);
      expect((await fs.readFile(path.join(h.root, 'assets', 'logo.png'))).equals(PNG)).toBe(true);
      expect(existsSync(path.join(h.root, 'early.png'))).toBe(false);
    } finally {
      await backend.stop(50);
    }
  });

  it('refuses in Plan mode, and the next turn holds only its own grants', async () => {
    const { h, sources, backend, id } = await claudeWithHostTools();
    try {
      const spec = await filesBridge(h.root);
      backend.sendUserTurn('plan it', { mode: 'plan', delegationContentSources: sources });
      expect((await call(spec, { asset_id: id, path: 'plan.png' })).result.content[0].text).toMatch(/unavailable in Plan mode/);
      backend.sendUserTurn('another request', {});
      expect((await call(spec, { asset_id: id, path: 'later.png' })).result.content[0].text).toMatch(/asset-unavailable/);
      expect(existsSync(path.join(h.root, 'plan.png')) || existsSync(path.join(h.root, 'later.png'))).toBe(false);
    } finally {
      await backend.stop(50);
    }
  });

  it('stopping the agent retires the host tools, so a save still on its way makes no effect', async () => {
    const { h, sources, tools, backend, id } = await claudeWithHostTools();
    backend.sendUserTurn('save it', { delegationContentSources: sources });
    await backend.stop(50);
    const result = await tools.run('save_attachment', { asset_id: id, path: 'logo.png' });
    expect(result).toMatchObject({ status: 'failed', attachmentSave: { code: 'interrupted' } });
    expect(existsSync(path.join(h.root, 'logo.png'))).toBe(false);
  });

  it('is not listed without the host tools', async () => {
    const { h, backend } = await claudeWithHostTools(false);
    try {
      const list = await rpc(await filesBridge(h.root), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(list.result.tools.map((candidate: any) => candidate.name)).not.toContain('save_attachment');
    } finally {
      await backend.stop(50);
    }
  });

  // v0.9.99 (B15): as Write does, a coordinator with teammates saves under its own permissions when no contract is in
  // force, and is refused only by a contract it filed that does not cover the save.
  it('follows the coordinator contract rule, as Write does, when the agent coordinates teammates', async () => {
    const h = await saveHost();
    let attempt: unknown = undefined;
    const team = {
      hasTeammates: () => true,
      currentCoordinatorTaskAttempt: () => attempt,
      canCoordinatorExecute: () => false,
    };
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, {
      writeRoots: [h.root],
      hostFileTools: h.tools('claude-1'),
      teamMcpBridge: team as any,
    });
    const files = (backend as any).bridgeIds.files as string;
    const own = await (backend as any).decidePreToolUse(`mcp__${files}__save_attachment`, { asset_id: 'content-1', path: 'a.png' });
    expect(own.refusal).not.toBe('capability');
    attempt = { contractId: 'contract-1' };
    const decision = await (backend as any).decidePreToolUse(`mcp__${files}__save_attachment`, { asset_id: 'content-1', path: 'a.png' });
    expect(decision).toMatchObject({ allow: false, refusal: 'capability' });
    expect(decision.note).toMatch(/outside the task contract you filed/);
  });
});

// v0.9.99 (A11, the same failure on the Claude CLI): a PDF no longer fails the whole turn. Its bytes never go into the
// CLI's input; the model reads it through its files bridge's extracted-content reader, with the id the turn grants.
describe('a Claude turn with a PDF attachment continues (v0.9.99)', () => {
  function writingSpawn(writes: string[]) {
    const base = fakeSpawn();
    return (cmd: string, args: string[]) => {
      const proc = base.fn(cmd, args);
      proc.stdin = { write: (text: string) => { writes.push(text); return true; }, end: () => undefined };
      return proc;
    };
  }
  const userText = (writes: string[]): string => {
    const content = JSON.parse(writes.find((w) => w.includes('"type":"user"'))!).message.content;
    return typeof content === 'string' ? content : content.map((part: any) => part.text ?? '').join(' ');
  };

  it('sends the turn, points the model at read_extracted_content, and the bridge reads the granted PDF', async () => {
    const h = await saveHost();
    const pdf = attachment('board-pack.pdf', 'application/pdf', 'pdf', PDF);
    const sources = await admitUserTurn(h.assets, [pdf]);
    const writes: string[] = [];
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, {
      spawn: writingSpawn(writes) as any, writeRoots: [h.root], delegationContentAssets: h.assets,
    });
    const events: any[] = []; backend.onEvent((event) => events.push(event));
    await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
    try {
      backend.sendUserTurn('Summarise it.', { userAttachments: [pdf], delegationContentSources: sources } as any);
      const text = userText(writes);
      expect(text).toContain('[attached PDFs]');
      expect(text).toContain('read_extracted_content');
      expect(text).toContain('- board-pack.pdf');
      expect(writes.join('')).not.toContain(pdf.dataBase64);
      expect(events.some((event) => event.kind === 'turn_complete')).toBe(false);
      expect(events.some((event) => event.kind === 'runtime_notice')).toBe(false);
      // Never reported as sent: the reader reaches it, the CLI's input does not carry it.
      expect(events.filter((event) => event.kind === 'turn_input_delivered').map((event) => event.userAttachments)).toEqual([[]]);
      const spec = await filesBridge(h.root);
      const read = await rpc(spec, { jsonrpc: '2.0', id: 9, method: 'tools/call',
        params: { name: 'read_extracted_content', arguments: { assetId: attachmentIds(sources)[0] } } });
      // The grant reaches the asset: the fixture PDF has no pages, so the reader reports its content, not its access.
      expect(read.result.content[0].text).toContain('extracted content is malformed');
      expect(read.result.content[0].text).not.toContain('not available to this agent');
    } finally { await backend.stop(50); }
  });

  it('without a reader, sends the turn, says the PDF was not delivered, and tells the user', async () => {
    const h = await saveHost();
    const pdf = attachment('board-pack.pdf', 'application/pdf', 'pdf', PDF);
    const writes: string[] = [];
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: writingSpawn(writes) as any });
    const events: any[] = []; backend.onEvent((event) => events.push(event));
    await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
    try {
      backend.sendUserTurn('Summarise it.', { userAttachments: [pdf] } as any);
      const text = userText(writes);
      expect(text).toContain('[attachments not delivered]');
      expect(text).toContain('Do not say you read or reviewed them.');
      expect(text).not.toContain('read_extracted_content');
      expect(events.filter((event) => event.kind === 'runtime_notice')).toEqual([{ kind: 'runtime_notice',
        text: expect.stringMatching(/^The agent did not receive board-pack\.pdf: .*The turn continues without it\./) }]);
      expect(events.some((event) => event.kind === 'turn_complete')).toBe(false);
    } finally { await backend.stop(50); }
  });
});
