import { afterAll, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { saveHost } from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { solidScreenshotPng } from './presentationImageFixtures';
import { managedClaudeTransport, managedCodexTransport } from './managedNativeFixtures';
import { fixedCodexProgram } from './codexProgramFixture';
import { EffectiveConnectionRegistry } from '../../routes/ConnectionRegistry';
import { ImageConnectionRegistry } from '../../image/ImageConnectionRegistry';
import { ImageGenerationHost } from '../../image/ImageGenerationHost';
import { CodexBackend, CODEX_CLI_DEFAULT_MODEL } from '../CodexBackend';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import type { AgentConfig } from '../../types';
const png = solidScreenshotPng(1536, 1024);
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });
afterAll(removeTemporaryFolders);
async function fixture(kind: 'codex' | 'claude') {
  const h = await saveHost(); const tools = h.tools('image-native');
  const registry = new EffectiveConnectionRegistry({ registryRevision: 1, profiles: [
    { connectionId: 'custom:images', revision: 1, displayName: 'Image fixture', endpointBase: 'https://api.openai.com/v1', secretRef: 'fixture-key' } as any,
  ] });
  const connections = new ImageConnectionRegistry(() => registry, () => 'custom:images');
  const calls: any[] = [];
  const images = new ImageGenerationHost(h.assets, { connections, secret: async () => 'fixture-only-key', egress: async () => {}, egressCurrent: () => true,
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init!.body as string) }); return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); } });
  tools.setImageGeneration(images);
  const config: AgentConfig = { id: 'image-native', name: 'Native image', role: 'developer', backend: kind, skill: '',
    provider: { providerId: kind === 'codex' ? 'codex' : 'anthropic', apiKeySecretName: 'unused' }, model: kind === 'codex' ? CODEX_CLI_DEFAULT_MODEL : 'sonnet',
    workingDirectory: h.root, allowedTools: ['read', 'write', 'execute'], autoApprove: true, systemPrompt: 'Work.' };
  cleanup.push(() => h.assets.dispose(), () => { tools.retire(); images.dispose(); connections.dispose(); });
  return { h, tools, config, calls };
}
it('Codex dynamic image tools produce and save the actual PNG while keeping prompt out of activity events', async () => {
  const f = await fixture('codex'); const transport = managedCodexTransport();
  const backend = new CodexBackend(f.config, undefined, { spawn: transport.spawn, launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
    hostFileTools: f.tools, access: () => ({ trusted: true, restricted: false, readRoots: [f.h.root], writeRoots: [f.h.root] }), killProcessTree: transport.stop });
  cleanup.push(() => backend.stop()); const events: unknown[] = []; backend.onEvent(e => events.push(e));
  await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Generate.');
  await vi.waitFor(() => expect((backend as any).turnId).toBe('turn-native'));
  const names = transport.messages.find(m => m.method === 'thread/start').params.dynamicTools.map((t: any) => t.name);
  expect(transport.messages.find(m => m.method === 'thread/start').params.config.features).toEqual({ image_generation: false });
  expect(names).toContain('generate_image'); expect(names).toContain('save_generated_asset');
  const result = await transport.call('generate_image', { prompt: 'Private native image content' }, 'image');
  expect(result.result.success, JSON.stringify(result)).toBe(true); const receipt = JSON.parse(result.result.contentItems[0].text);
  const saved = await transport.call('save_generated_asset', { asset_id: receipt.asset_id, path: 'native.png' }, 'save');
  expect(saved.result.success, JSON.stringify(saved)).toBe(true); expect(await fs.readFile(join(f.h.root, 'native.png'))).toEqual(png);
  expect(f.calls[0].body.prompt).toBe('Private native image content');
  expect(JSON.stringify(events)).not.toContain('Private native image content');
  expect(transport.messages.some(m => m.method === 'command/exec')).toBe(false);
});
it('Claude private MCP image tools reach actual generation and save without native CLI credentials or Commands', async () => {
  const f = await fixture('claude'); f.config.allowedTools = ['read', 'write']; const transport = managedClaudeTransport();
  const backend = new ClaudeHeadlessBackend(f.config, undefined, undefined, { spawn: transport.spawn, hostFileTools: f.tools, writeRoots: [f.h.root],
    terminateProcessTree: async child => { child.kill(); return { status: 'confirmed-stopped' }; } });
  cleanup.push(() => backend.stop()); await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Generate.');
  const config = JSON.parse(await fs.readFile((backend as any).mcpConfigPath, 'utf8'));
  const server = config.mcpServers[Object.keys(config.mcpServers).find(name => name.startsWith('unode_files_'))!];
  const call = async (id: number, method: string, params: unknown = {}) => {
    const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...server.headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    return await response.json() as any;
  };
  const list = await call(1, 'tools/list'); expect(list.result.tools.map((t: any) => t.name)).toContain('generate_image');
  const generated = await call(2, 'tools/call', { name: 'generate_image', arguments: { prompt: 'Private Claude prompt' } });
  expect(generated.result.isError).not.toBe(true); const receipt = JSON.parse(generated.result.content[0].text);
  const saved = await call(3, 'tools/call', { name: 'save_generated_asset', arguments: { asset_id: receipt.asset_id, path: 'claude.png' } });
  expect(saved.result.isError).not.toBe(true); expect(await fs.readFile(join(f.h.root, 'claude.png'))).toEqual(png);
  expect(f.calls).toHaveLength(1);
});
