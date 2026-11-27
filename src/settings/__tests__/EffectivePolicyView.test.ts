import { expect, it } from 'vitest';
import { effectivePolicyView, effectivePolicyLines } from '../EffectivePolicyView';
import { policyObservations } from './effectivePolicyFixtures';
import { CommandPolicy } from '../../backend/CommandPolicy';
import { hostFileToolCapabilities } from '../../host/HostFileToolCapabilities';
import type { AgentConfig } from '../../types';

it('reads changed existing authority afresh, preserves explicit Off, and cannot mutate the owner through display facts', () => {
  const policy = new CommandPolicy('none', []); const input = policyObservations({ hostCommands: policy.approvalMode });
  const before = effectivePolicyView(input); expect(before.runCommands.value).toBe('Host tools: Off');
  expect(before.runCommands.explicit).toBe(true); expect(Object.isFrozen(before.runCommands)).toBe(true);
  input.connection = 'Different connection'; expect(before.connection.value).toBe('Chosen connection / model');
  policy.reload('all', []); const after = effectivePolicyView({ ...input, hostCommands: policy.approvalMode, taskScoped: true });
  expect(after.runCommands.value).toContain('Task-scoped; configured ceiling Automatic'); expect(before.runCommands.value).toBe('Host tools: Off');
  expect(after.connection.explicit).toBe('unknown'); expect(policy.approvalMode).toBe('all');
});
it('keeps native execution, host ceilings, image adapter support and app qualification distinct', () => {
  const input = policyObservations({ nativeExecution: 'full-access; running turn started as ask-for-approval',
    imageConnection: { id: 'custom:chosen', supported: false }, rendererSnapshot: { version: 1, detected_at: 'fixture-observation', platform: 'win32', scope: 'Detection only',
      applications: [{ id: 'word', name: 'Word', installed: true, registration: 'registered', qualification: 'not-run', candidate_operations: ['render-docx-pages'] }] } });
  const view = effectivePolicyView(input); expect(view.runCommands.value).toContain('Host tools: Off; native Codex: full-access');
  expect(view.imageConnection.value).toContain('image adapter unavailable'); expect(view.rendererAvailability.value).toContain('operation qualification not run');
  const lines = effectivePolicyLines(view); expect(lines).toHaveLength(7); expect(lines.join('\n')).toContain('Team Rules');
  input.rendererSnapshot!.applications[0].installed = false; expect(view.rendererAvailability.value).toContain('Word');
});
it.each([
  ['claude', undefined, undefined, undefined, false, true, true],
  ['claude', [], undefined, undefined, false, false, false],
  ['claude', ['write', 'execute'], undefined, 'deny', false, true, false],
  ['claude', ['write', 'execute'], undefined, undefined, true, true, false],
  ['claude', ['execute'], undefined, undefined, false, false, false],
  ['codex', [], undefined, undefined, false, true, true],
  ['codex', [], 'bounded', undefined, false, false, false],
  ['codex', ['read'], 'native-default', undefined, false, true, true],
  ['codex', ['write'], 'bounded', 'deny', false, true, false],
  ['openai-compat', ['execute'], undefined, undefined, false, false, true],
] as const)('keeps factory capability semantics for %s / %j / %s / %s / restricted=%s', (kind, allowedTools, toolCeiling, executePreference, restricted, write, execute) => {
  expect(hostFileToolCapabilities({ allowedTools, toolCeiling, executePreference } as AgentConfig, kind, restricted)).toEqual({ write, execute });
});
