import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { liveCommandCapability } from '../LiveCommandCapability';
import { CommandPolicy, type CommandApprovalMode } from '../CommandPolicy';
import { AgentCommandPolicy } from '../AgentCommandPolicy';
import { TeamTools } from '../TeamTools';
import { MessageBus } from '../../bus/MessageBus';

function actualCapabilityReader(policy: CommandApprovalMode, trusted: boolean, command = true) {
  const source = ts.createSourceFile('extension.ts', readFileSync(resolve('src/extension.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'delegationCapabilitiesFor');
  expect(fn).toBeDefined();
  const js = ts.transpileModule(fn!.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const host = { liveCommandCapability, AgentCommandPolicy, commandPolicy: new CommandPolicy(policy),
    vscode: { workspace: { isTrusted: trusted } }, connectionProfileForAgent: () => ({ capabilities: { command, read: true, write: true, delegation: false } }),
    effectiveConnectionRegistry: {}, defaultBackendKind: () => 'openai-compat', configuredSetting: (_key: string, fallback: unknown) => fallback,
    canDelegate: () => false, taskScopeCapabilityFor: () => 'per-turn' };
  return new Function('host', `with(host) { ${js}; return delegationCapabilitiesFor; }`)(host);
}
describe('CAP live command capability facts', () => {
  it.each([
    ['all', true, true, ['execute'], true, []], ['ask', true, true, ['execute'], true, []],
    ['none', true, true, ['execute'], false, ['commands-none']], ['all', false, true, ['execute'], false, ['workspace-untrusted']],
    ['all', true, false, ['execute'], false, ['connection-no-command']], ['all', true, true, ['read'], false, ['tool-disabled']],
  ] as const)('actual host facts respect %s / trust=%s / connection=%s', (mode, trusted, command, tools, expected, reasons) => {
    const facts = actualCapabilityReader(mode, trusted, command)({ id: 'worker', name: 'Worker', allowedTools: tools });
    expect(facts.shell).toBe(expected); expect(facts.commandAvailability.reasons).toEqual(reasons);
    expect(facts.verificationSensors.includes('command-exit-zero')).toBe(expected);
    expect(facts.toolFamilies.includes('execute')).toBe(expected);
  });
  it('agent narrowing and native-default/bounded empty lists agree with the existing runtime ceiling', () => {
    const read = actualCapabilityReader('all', true);
    expect(read({ name: 'Worker', allowedTools: ['execute'], commandNarrowing: { approvalMode: 'none', allowedCommands: [] } }).shell).toBe(false);
    expect(read({ name: 'Worker', backend: 'codex', toolCeiling: 'native-default', allowedTools: [] }).shell).toBe(true);
    expect(read({ name: 'Worker', backend: 'codex', toolCeiling: 'bounded', allowedTools: [] }).shell).toBe(false);
    expect(liveCommandCapability({ connection: false, tool: false, trusted: false, policy: 'none', restricted: true }).reasons)
      .toEqual(['connection-no-command', 'tool-disabled', 'commands-none', 'workspace-untrusted', 'mode-or-scope-restricted']);
  });
  it('the actual list_agents tool explains refusal and presents Ask each as requestability, not authorization', async () => {
    const commandAvailability = liveCommandCapability({ connection: true, tool: true, trusted: true, policy: 'ask' });
    const tools = new TeamTools('pm', { resolve: () => undefined, list: () => [{ id: 'worker', name: 'Contract analyst', role: 'custom', status: 'stopped',
      capabilities: { read: true, write: true, shell: commandAvailability.canRequest, commandAvailability, toolFamilies: ['read', 'write', 'execute'] } }] }, new MessageBus());
    const ready = await tools.run('list_agents', {});
    expect(ready).toContain('policy=ask'); expect(ready).toContain('may require approval');
    commandAvailability.canRequest = false; commandAvailability.reasons = ['commands-none'];
    expect(await tools.run('list_agents', {})).toContain('command requests unavailable: commands-none');
  });
});
