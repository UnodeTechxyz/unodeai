import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { installedSkillFixture } from './skillResourceFixtures';
import { SkillRegistry } from '../SkillRegistry';
import { OpenAICompatBackend } from '../../backend/OpenAICompatBackend';
import { CommandPolicy } from '../../backend/CommandPolicy';
import type { AgentConfig } from '../../types';

const fixtures: Array<ReturnType<typeof installedSkillFixture>> = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose(); });

function commandFixture() {
  const f = installedSkillFixture(); fixtures.push(f);
  const catalog = path.join(f.root, 'installed extension 空间'); fs.mkdirSync(catalog);
  fs.renameSync(path.join(f.root, 'rigor'), path.join(catalog, 'rigor'));
  const skill = path.join(catalog, 'rigor', 'audit-skill');
  const workspace = path.join(f.root, 'task'); fs.mkdirSync(workspace);
  const helper = path.join(skill, 'scripts', 'helper.cjs');
  fs.writeFileSync(helper, "const fs=require('node:fs'); const path=require('node:path'); fs.writeFileSync(process.argv[2], JSON.stringify({value:require('./lib/value.cjs'),asset:[...fs.readFileSync(path.join(__dirname,'../asset.bin'))]}));");
  return { ...f, catalog, workspace, helper };
}

async function runCommandTurn(mode: 'all' | 'ask' | 'none', options: { delegated?: boolean; outside?: boolean; approval?: boolean;
  atApproval?: 'revoke' | 'redirect' | 'modify' } = {}) {
  const f = commandFixture(); const output = path.join(f.workspace, 'result.json');
  const command = `node "${f.helper}" "${output}"${options.outside ? ` "${path.join(f.root, 'ungranted', 'input.txt')}"` : ''}`;
  const config: AgentConfig = { id: 'resource-helper', name: 'Helper', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'deepseek-chat', systemPrompt: 'Use the granted helper.',
    autoApprove: true, allowedTools: ['execute'], workingDirectory: f.workspace, playbooks: ['audit-skill'] };
  const results: string[] = []; const approvals: string[] = [];
  const parameters: ConstructorParameters<typeof OpenAICompatBackend> = [config, async (_url, init) => {
    const body = JSON.parse(init.body); const tools = body.messages.filter((message: any) => message.role === 'tool');
    if (tools.length > results.length) results.push(tools.at(-1).content);
    const call = tools.length === 0 ? { name: 'load_skill', arguments: JSON.stringify({ name: 'audit-skill' }) }
      : tools.length === 1 ? { name: 'run_command', arguments: JSON.stringify({ command }) } : undefined;
    const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: 'helper-' + tools.length, type: 'function', function: call }] }
      : { role: 'assistant', content: 'Finished.' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
  }];
  parameters[4] = new CommandPolicy(mode);
  if (options.approval) parameters[8] = async command => {
    approvals.push(command);
    if (options.atApproval === 'revoke') config.playbooks = [];
    if (options.atApproval === 'modify') fs.appendFileSync(f.helper, "\nprocess.stdout.write('UPDATED_HELPER');");
    if (options.atApproval === 'redirect') {
      const scripts = path.dirname(f.helper); const moved = scripts + '-old'; fs.renameSync(scripts, moved);
      fs.symlinkSync(moved, scripts, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return { allow: true };
  };
  parameters[17] = SkillRegistry.load(f.catalog);
  const backend = new OpenAICompatBackend(...parameters);
  const events: any[] = [];
  const done = new Promise<void>(resolve => backend.onEvent(event => { events.push(event); if (event.kind === 'turn_complete') resolve(); }));
  try {
    await backend.start({ ROAM_API_KEY: 'sk-local-fixture' });
    backend.sendUserTurn('Run the helper and produce the result.', options.delegated ? { taskWorkspaceAccess: {
      pathBase: f.workspace, commandCwd: f.workspace, readRoots: [f.workspace], writeRoots: [f.workspace],
    } } : undefined);
    await done;
    return { f, output, results, approvals, command, events };
  } finally { await backend.stop(); }
}

it.each([false, true])('HTTP actual turn runs a granted installed helper with a sibling import and binary asset without an outside card (delegated=%s)', async delegated => {
  const run = await runCommandTurn('all', { delegated });
  expect(run.results[1]).not.toContain('BLOCKED_OUTSIDE_WORKDIR');
  expect(fs.existsSync(run.output), JSON.stringify(run.results)).toBe(true);
  expect(JSON.parse(fs.readFileSync(run.output, 'utf8'))).toEqual({ value: 'actual sibling module', asset: [0, 255, 7] });
  expect(run.approvals).toEqual([]);
  expect(run.events.filter(event => event.kind === 'tool_result').map(event => event.outcome.status)).toEqual(['success', 'success']);
});

it('HTTP Ask uses its existing command card once for the exact helper command', async () => {
  const run = await runCommandTurn('ask', { approval: true });
  expect(run.approvals).toEqual([run.command]);
  expect(fs.existsSync(run.output), JSON.stringify(run.results)).toBe(true);
});

it('HTTP Commands Off loads the resource but starts no helper', async () => {
  const run = await runCommandTurn('none');
  expect(fs.existsSync(run.output)).toBe(false);
  expect(run.events.filter(event => event.kind === 'tool_result').map(event => event.outcome.status)).toEqual(['success', 'refused']);
});

it('a helper resource does not excuse a mixed ungranted input path on the unattended HTTP turn', async () => {
  const run = await runCommandTurn('all', { delegated: true, outside: true });
  expect(fs.existsSync(run.output)).toBe(false);
  expect(run.events.filter(event => event.kind === 'tool_result').at(-1).outcome.status).toBe('refused');
});

it.each(['revoke', 'redirect'] as const)('HTTP checks the live skill grant and no-link scope after an approval waits (%s)', async atApproval => {
  const run = await runCommandTurn('ask', { approval: true, atApproval });
  expect(run.approvals).toEqual([run.command]);
  expect(fs.existsSync(run.output)).toBe(false);
  expect(run.results[1]).toContain('skill resource grant or installed path changed');
});

it('a valid installed-source edit during approval executes current bytes without another digest gate or physical copy', async () => {
  const run = await runCommandTurn('ask', { approval: true, atApproval: 'modify' });
  expect(run.approvals).toEqual([run.command]);
  expect(fs.existsSync(run.output), JSON.stringify(run.results)).toBe(true);
  expect(run.results[1]).toContain('UPDATED_HELPER');
});

it('HTTP ordinary reads use the live skill scope without allowing sibling resources, source writes or a revoked grant', async () => {
  const f = commandFixture(); const original = fs.readFileSync(f.helper, 'utf8');
  const sibling = path.join(f.catalog, 'rigor', 'other-skill'); fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'SKILL.md'), '---\nname: other-skill\ndescription: Not granted.\n---\nPRIVATE_SIBLING_RESOURCE');
  const config: AgentConfig = { id: 'scope-reader', name: 'Scope reader', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'deepseek-chat', systemPrompt: 'Read granted resources.',
    autoApprove: true, allowedTools: ['read', 'write'], workingDirectory: f.workspace, playbooks: ['audit-skill'] };
  const calls = [
    { name: 'read_file', arguments: JSON.stringify({ path: f.helper }) },
    { name: 'read_file', arguments: JSON.stringify({ path: path.join(sibling, 'SKILL.md') }) },
    { name: 'write_file', arguments: JSON.stringify({ path: f.helper, content: 'MUST_NOT_WRITE' }) },
    { name: 'read_file', arguments: JSON.stringify({ path: f.helper }) },
  ];
  const outputs: string[] = []; const events: any[] = [];
  const parameters: ConstructorParameters<typeof OpenAICompatBackend> = [config, async (_url, init) => {
    const body = JSON.parse(init.body); const results = body.messages.filter((message: any) => message.role === 'tool');
    if (results.length > outputs.length) outputs.push(results.at(-1).content);
    if (results.length === 3) config.playbooks = [];
    const call = calls[results.length];
    const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: 'scope-' + results.length, type: 'function', function: call }] }
      : { role: 'assistant', content: 'Scope checked.' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
  }];
  parameters[17] = SkillRegistry.load(f.catalog); const backend = new OpenAICompatBackend(...parameters);
  const done = new Promise<void>(resolve => backend.onEvent(event => { events.push(event); if (event.kind === 'turn_complete') resolve(); }));
  try {
    await backend.start({ ROAM_API_KEY: 'sk-local-fixture' }); backend.sendUserTurn('Read only the granted source.'); await done;
    expect(outputs[0]).toContain(original);
    expect(outputs.join('')).not.toContain('PRIVATE_SIBLING_RESOURCE');
    expect(fs.readFileSync(f.helper, 'utf8')).toBe(original);
    expect(events.filter(event => event.kind === 'tool_result').map(event => event.outcome.status))
      .toEqual(['success', 'refused', 'refused', 'refused']);
  } finally { await backend.stop(); }
});
