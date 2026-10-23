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
import { admitUserTurn, attachment, attachmentIds, PNG, saveHost, sha } from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';

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

  it('needs a coordinator contract, as Write does, when the agent coordinates teammates', async () => {
    const h = await saveHost();
    const team = {
      hasTeammates: () => true,
      currentCoordinatorTaskAttempt: () => undefined,
      canCoordinatorExecute: () => false,
    };
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, {
      writeRoots: [h.root],
      hostFileTools: h.tools('claude-1'),
      teamMcpBridge: team as any,
    });
    const files = (backend as any).bridgeIds.files as string;
    const decision = await (backend as any).decidePreToolUse(`mcp__${files}__save_attachment`, { asset_id: 'content-1', path: 'a.png' });
    expect(decision).toMatchObject({ allow: false, refusal: 'capability' });
    expect(decision.note).toMatch(/Coordinator execution is not authorised/);
  });
});
