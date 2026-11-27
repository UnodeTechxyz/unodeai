import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import { CodexBackend, CODEX_CLI_DEFAULT_MODEL } from '../CodexBackend';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import { ManagedDocumentHost } from '../../office/ManagedDocumentHost';
import { docxEmbeddedNanoidPatch } from '../../../scripts/docx-embedded-nanoid-patch.mjs';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { fixedCodexProgram } from './codexProgramFixture';
import { managedClaudeTransport, managedCodexTransport } from './managedNativeFixtures';
import type { AgentConfig } from '../../types';
import { OpenAICompatBackend } from '../OpenAICompatBackend';

let runner: string; let inventory: string;
const toolsToRetire: WorkspaceTools[] = [];
const backends: Array<{ stop(): Promise<unknown> }> = [];
beforeAll(async () => {
  const root = await temporaryFolder('unode-native-managed-worker-'); runner = join(root, 'DocumentRunner.cjs'); inventory = join(root, 'OfficeInventoryWorker.cjs');
  await build({ entryPoints: ['src/office/DocumentRunner.ts'], outfile: runner, bundle: true, platform: 'node', format: 'cjs', target: 'node18', plugins: [docxEmbeddedNanoidPatch], logLevel: 'silent' });
  await build({ entryPoints: ['src/office/OfficeInventoryWorker.ts'], outfile: inventory, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' });
});
afterEach(async () => { for (const backend of backends.splice(0)) await backend.stop(); for (const tools of toolsToRetire.splice(0)) tools.retire(); });
afterAll(removeTemporaryFolders);
async function host() {
  const root = await temporaryFolder('unode-native-managed-'); const tools = new WorkspaceTools(root, new Set(['write', 'execute']), 'native-agent', undefined, new CommandPolicy('all'));
  tools.useManagedDocumentHost(new ManagedDocumentHost(runner), inventory); toolsToRetire.push(tools); return { root, tools };
}
function config(root: string, backend: 'claude' | 'codex'): AgentConfig {
  return { id: 'native-agent', name: 'Native', role: 'developer', skill: '', backend, workingDirectory: root,
    provider: { providerId: backend === 'claude' ? 'anthropic' : 'codex', apiKeySecretName: 'unused' },
    model: backend === 'claude' ? 'claude-sonnet-4-5' : CODEX_CLI_DEFAULT_MODEL, allowedTools: ['read', 'write', 'execute'], autoApprove: true, systemPrompt: 'Work.' };
}
const source = `module.exports = async ctx => { const fs = require('node:fs'); const { Document, Packer, Paragraph } = require('docx'); fs.writeFileSync(ctx.outputs.word, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Actual native bridge artifact')] }] }))); };`;

it('HTTP managed Office run respects a coordinator contract filed after source preparation', async () => {
  const { root } = await host(); let active = false; let result = ''; let count = 0;
  const cfg: AgentConfig = { ...config(root, 'codex'), backend: 'openai-compat', provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'deepseek-chat', toolProtocol: 'native' };
  const params: ConstructorParameters<typeof OpenAICompatBackend> = [cfg, async (_url, init) => {
    const body = JSON.parse(init.body); const outputs = body.messages.filter((m: any) => m.role === 'tool');
    const text = (m: any) => typeof m.content === 'string' ? m.content : m.content.map((block: any) => block.text ?? '').join('\n');
    if (++count > 3) throw Error('Managed contract regression did not converge');
    let call: { operation: string; [key: string]: unknown } | undefined;
    if (!outputs.length) call = { operation: 'prepare', draft: 'word', source, final: true };
    else if (outputs.length === 1) {
      const prepared = JSON.parse(text(outputs[0]).split('\n')[0]); active = true;
      call = { operation: 'run', format: 'docx', program_ref: prepared.program_ref, outputs: [{ name: 'word', path: 'contract-bypass.docx' }] };
    } else result = text(outputs.at(-1));
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: call
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'managed-' + count, type: 'function', function: { name: 'build_office', arguments: JSON.stringify(call) } }] }
      : { role: 'assistant', content: 'Continue within the contract.' } }] }) };
  }, { has: () => false, hasTeammates: () => true, canCoordinatorExecute: () => false, specs: () => [], interruptPending: () => {},
    currentCoordinatorTaskAttempt: () => active ? { contractId: 'restricted-contract' } : undefined } as any];
  params[4] = new CommandPolicy('all'); const backend = new OpenAICompatBackend(...params); backends.push(backend);
  (backend as any).tools.useManagedDocumentHost(new ManagedDocumentHost(runner), inventory);
  const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
  await backend.start({ ROAM_API_KEY: 'fixture-chat-key' }); backend.sendUserTurn('Generate with the current contract.'); await done;
  expect(result).toContain('outside the task contract');
  await expect(fs.stat(join(root, 'contract-bypass.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

async function codexTurn(options: { mode?: 'plan'; old?: boolean; executeOff?: boolean; unsupportedCommand?: boolean } = {}) {
  const { root, tools } = await host(); const transport = managedCodexTransport(options);
  const cfg = config(root, 'codex'); if (options.executeOff) cfg.executePreference = 'deny';
  const backend = new CodexBackend(cfg, undefined, { spawn: transport.spawn, launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
    hostFileTools: tools, access: () => ({ trusted: true, restricted: false, readRoots: [root], writeRoots: [root] }), killProcessTree: transport.stop });
  backends.push(backend); await backend.start({}, { pin: 'take' });
  if (options.old) {
    const signature = JSON.parse((backend as any).dynamicToolSignature()); delete signature.buildOffice;
    backend.restore({ version: 3, backend: 'codex', hostTurnState: 'complete', messages: [{ codexThreadId: 'thread-native', codexDynamicTools: JSON.stringify(signature) }] });
  }
  backend.sendUserTurn('Build.', options.mode ? { mode: options.mode } : undefined);
  await vi.waitFor(() => expect((backend as any).turnId).toBe('turn-native'));
  return { root, tools, transport, backend };
}

it.each(['plan', 'old'] as const)('Codex preserves %s restrictions through the actual dynamic tool router without starting a program', async kind => {
  const { root, transport } = await codexTurn(kind === 'plan' ? { mode: 'plan' } : { old: true });
  const result = await transport.call('build_office', { operation: 'prepare', draft: 'word', source, final: true }, kind);
  expect(result.result.success).toBe(false);
  expect(result.result.contentItems[0].text).toContain(kind === 'plan' ? 'Plan' : 'New Model Conversation (keep chat)');
  if (kind === 'old') {
    expect(transport.messages.some(message => message.method === 'thread/resume')).toBe(true);
    expect(transport.messages.some(message => message.method === 'thread/start')).toBe(false);
  }
  expect(transport.messages.some(message => message.method === 'command/exec')).toBe(false);
  expect(await fs.readdir(root)).toEqual([]);
});

it('Codex turn abort terminates the actual owned managed child and never delivers a late output', async () => {
  const { root, transport, backend } = await codexTurn();
  const marker = join(root, 'started.txt');
  const prepared = await transport.call('build_office', { operation: 'prepare', draft: 'stop', final: true,
    source: `module.exports = async ctx => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); await new Promise(() => setInterval(() => {}, 1000)); };` }, 'stop-prepare');
  const program = JSON.parse(prepared.result.contentItems[0].text.split('\n')[0]);
  const pending = transport.call('build_office', { operation: 'run', format: 'docx', program_ref: program.program_ref, outputs: [{ name: 'word', path: 'late.docx' }] }, 'stop-run');
  await vi.waitFor(async () => expect(await fs.readFile(marker, 'utf8')).toBe('started'), { timeout: 10000 });
  backend.abort(); const result = await pending;
  expect(result.result.success).toBe(false);
  expect(transport.messages.some(message => message.method === 'command/exec/terminate')).toBe(true);
  await expect(fs.stat(join(root, 'late.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 30000);

it('Codex rechecks an explicit Commands Off before native execution', async () => {
  const { root, transport, backend } = await codexTurn();
  const prepared = await transport.call('build_office', { operation: 'prepare', draft: 'off', source, final: true }, 'off-prepare');
  const program = JSON.parse(prepared.result.contentItems[0].text.split('\n')[0]);
  (backend as any).config.executePreference = 'deny';
  const result = await transport.call('build_office', { operation: 'run', format: 'docx', program_ref: program.program_ref, outputs: [{ name: 'word', path: 'off.docx' }] }, 'off-run');
  expect(result.result.success).toBe(false);
  expect(transport.messages.some(message => message.method === 'command/exec')).toBe(false);
  await expect(fs.stat(join(root, 'off.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('Codex reports an unsupported native executor without executing on the host as a fallback', async () => {
  const { root, transport } = await codexTurn({ unsupportedCommand: true });
  const prepared = await transport.call('build_office', { operation: 'prepare', draft: 'unsupported', source, final: true }, 'unsupported-prepare');
  const program = JSON.parse(prepared.result.contentItems[0].text.split('\n')[0]);
  const result = await transport.call('build_office', { operation: 'run', format: 'docx', program_ref: program.program_ref, outputs: [{ name: 'word', path: 'unsupported.docx' }] }, 'unsupported-run');
  expect(result.result.success).toBe(false);
  expect(transport.messages.filter(message => message.method === 'command/exec')).toHaveLength(1);
  await expect(fs.stat(join(root, 'unsupported.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('Codex dynamic build_office prepares, runs real argv through command/exec with the selected sandbox, and returns the actual saved file', async () => {
  const { root, tools } = await host(); const transport = managedCodexTransport();
  const backend = new CodexBackend(config(root, 'codex'), undefined, { spawn: transport.spawn, launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
    hostFileTools: tools, access: () => ({ trusted: true, restricted: false, readRoots: [root], writeRoots: [root] }), killProcessTree: transport.stop });
  backends.push(backend); await backend.start({}, { pin: 'take' });
  const started = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'model_request') resolve(); }));
  backend.sendUserTurn('Build the Word document.');
  // The real turn entry declares the dynamic tools before the deterministic server answers turn/start.
  await started;
  await vi.waitFor(() => expect((backend as any).turnId).toBe('turn-native'));
  const thread = transport.messages.find(message => message.method === 'thread/start');
  expect(thread.params.dynamicTools.some((tool: any) => tool.name === 'build_office')).toBe(true);
  const prepared = await transport.call('build_office', { operation: 'prepare', draft: 'word', source, final: true }, 'prepare');
  const preparedText = prepared.result.contentItems.map((item: any) => item.text ?? '').join('');
  const program = JSON.parse(preparedText.split('\n')[0]);
  const result = await transport.call('build_office', { operation: 'run', format: 'docx', program_ref: program.program_ref, outputs: [{ name: 'word', path: 'native.docx' }] }, 'build');
  expect(result.result.success, JSON.stringify(result)).toBe(true);
  const command = transport.messages.find(message => message.method === 'command/exec');
  expect(command.params.disableTimeout).toBe(true); expect(command.params.command[1]).toBe(await fs.realpath(runner));
  expect(command.params.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  expect(command.params.sandboxPolicy.writableRoots).toContain(root);
  expect(command.params.sandboxPolicy.writableRoots).toHaveLength(2);
  expect(command.params.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  const zip = await JSZip.loadAsync(await fs.readFile(join(root, 'native.docx')));
  expect(await zip.file('word/document.xml')!.async('string')).toContain('Actual native bridge artifact');
}, 30000);

it('Claude actual private files bridge advertises and executes build_office through the real host generator', async () => {
  const { root, tools } = await host(); const transport = managedClaudeTransport();
  const backend = new ClaudeHeadlessBackend(config(root, 'claude'), undefined, undefined, { spawn: transport.spawn, writeRoots: [root], hostFileTools: tools,
    terminateProcessTree: async child => { child.kill(); return { status: 'confirmed-stopped' }; } });
  backends.push(backend); await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Build the Word document.');
  const path = (backend as any).mcpConfigPath;
  const written = JSON.parse(await fs.readFile(path, 'utf8'));
  const key = Object.keys(written.mcpServers).find(name => name.startsWith('unode_files_'))!;
  const server = written.mcpServers[key];
  const request = async (id: number, method: string, params: unknown = {}) => {
    const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...server.headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    return await response.json() as any;
  };
  const listed = await request(1, 'tools/list'); expect(listed.result.tools.some((tool: any) => tool.name === 'build_office')).toBe(true);
  const prepared = await request(2, 'tools/call', { name: 'build_office', arguments: { operation: 'prepare', draft: 'word', source, final: true } });
  const program = JSON.parse(prepared.result.content[0].text.split('\n')[0]);
  const built = await request(3, 'tools/call', { name: 'build_office', arguments: { operation: 'run', format: 'docx', program_ref: program.program_ref, outputs: [{ name: 'word', path: 'native.docx' }] } });
  expect(built.result.isError, JSON.stringify(built)).not.toBe(true);
  const zip = await JSZip.loadAsync(await fs.readFile(join(root, 'native.docx')));
  expect(await zip.file('word/document.xml')!.async('string')).toContain('Actual native bridge artifact');
}, 30000);

it.each(['plan', 'restricted-shell'] as const)('Claude private files bridge keeps %s from executing managed JavaScript', async scope => {
  const { root, tools } = await host(); const transport = managedClaudeTransport();
  const backend = new ClaudeHeadlessBackend(config(root, 'claude'), undefined, undefined, { spawn: transport.spawn, writeRoots: [root], hostFileTools: tools,
    restrictShell: scope === 'restricted-shell', terminateProcessTree: async child => { child.kill(); return { status: 'confirmed-stopped' }; } });
  backends.push(backend); await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Build.', scope === 'plan' ? { mode: 'plan' } : undefined);
  const written = JSON.parse(await fs.readFile((backend as any).mcpConfigPath, 'utf8'));
  const server = written.mcpServers[Object.keys(written.mcpServers).find(name => name.startsWith('unode_files_'))!];
  const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...server.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'build_office', arguments: { operation: 'run', format: 'docx', program_ref: 'not-executable', outputs: [{ name: 'word', path: 'blocked.docx' }] } } }) });
  const result = await response.json() as any;
  expect(result.result.isError).toBe(true);
  expect(result.result.content[0].text).toContain(scope === 'plan' ? 'Plan mode' : 'current shell or Folder Access restriction');
  await expect(fs.stat(join(root, 'blocked.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
});
