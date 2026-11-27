import { expect, it, vi } from 'vitest';
import { SetupGuideSession, type SetupGuideHost, type SetupGuideSnapshot } from '../setupGuideSession';
import { parseSetupGuideMessage } from '../setupGuideProtocol';
import { policyFixture } from '../../settings/__tests__/effectivePolicyFixtures';

it('derives the same live policy rows in the existing Permissions step without starting or changing anything', async () => {
  let current = policyFixture(); const forbidden = vi.fn(() => { throw Error('Display must not start or change anything'); });
  const host: SetupGuideHost = { snapshot: async () => ({ defaultConnectionId: 'unode', defaultExplicit: false, connections: [], mcpServers: [],
    agents: [{ id: 'dev', name: 'Developer', role: 'custom', connection: 'Chosen connection', model: 'chosen', autonomy: 'Workspace', autonomyLimits: [],
      effectivePolicy: current, folders: [], mcp: [], skills: 0, playbooks: 0 }],
    permissions: { commandSetting: 'none', commandExplicit: true, projectEnabled: false, commandEffective: 'none', writeApproval: 'ask', autonomyDefault: 'workspace', webAccess: 'off', trusted: true } }),
    readiness: { check: forbidden } as never, createTeam: forbidden, chooseModel: forbidden, addGateway: forbidden, testConnection: forbidden,
    setDefault: forbidden, run: forbidden, secretNameFor: forbidden, loginCommandFor: forbidden, log: vi.fn() };
  const guide = new SetupGuideSession(host, vi.fn()); await guide.action('step', 'permissions');
  expect(JSON.stringify((await guide.view()).blocks)).toContain('Commands: Host tools: Off');
  current = policyFixture({ hostCommands: 'all' }); expect(JSON.stringify((await guide.view()).blocks)).toContain('Commands: Host tools: Automatic');
  expect(forbidden).not.toHaveBeenCalled();
});

it.each(['starter', 'solo'] as const)('stages role choices without any readiness or network action and forwards the right %s rows only on Create', async preset => {
  const snapshot: SetupGuideSnapshot = { defaultConnectionId: 'unode', defaultExplicit: true, agents: [], mcpServers: [],
    connections: ['unode', 'claude-cli', 'codex-cli'].map(id => ({ id, name: id, kind: id === 'unode' ? 'api-key' : id as 'claude-cli' | 'codex-cli',
      configured: true, hasKey: id === 'unode', canSetKey: id === 'unode', status: 'Configured, not tested here' })),
    permissions: { commandSetting: 'none', commandExplicit: true, projectEnabled: false, commandEffective: 'none', writeApproval: 'ask',
      autonomyDefault: 'workspace', webAccess: 'off', trusted: true } };
  const createTeam = vi.fn(async () => [{ name: 'Created', role: preset === 'starter' ? 'pm' : 'solo' }]);
  const forbidden = vi.fn(() => { throw Error('Selecting roles must not test, log in or start anything'); });
  const configureRoles = vi.fn(async () => ({ connectionId: 'unode', roleConnections: [
    { roleIndex: 0, roleKey: 'pm', connectionId: 'claude-cli', model: 'pm-choice' },
    { roleIndex: 3, roleKey: 'solo', connectionId: 'codex-cli', model: 'solo-choice' },
  ] }));
  const host: SetupGuideHost = { snapshot: async () => structuredClone(snapshot), createTeam, configureRoles,
    readiness: { check: forbidden } as never, chooseModel: forbidden, addGateway: forbidden, testConnection: forbidden,
    setDefault: forbidden, run: forbidden, secretNameFor: forbidden, loginCommandFor: forbidden, log: vi.fn() };
  const guide = new SetupGuideSession(host, vi.fn());
  expect(parseSetupGuideMessage({ command: 'action', action: 'configure-roles' }).ok).toBe(true);
  await guide.action('step', 'team'); await guide.action('configure-roles');
  expect(createTeam).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled();
  const view = await guide.view(); expect(JSON.stringify(view.blocks)).toContain('pm-choice');
  const copy = guide.creationChoice()!; copy.roleConnections![0].model = 'changed outside controller';
  expect(guide.creationChoice()!.roleConnections![0].model).toBe('pm-choice');
  await guide.action(preset === 'starter' ? 'create-team' : 'create-solo');
  expect(createTeam).toHaveBeenCalledExactlyOnceWith(preset, { connectionId: 'unode', roleConnections: preset === 'starter'
    ? [{ roleIndex: 0, roleKey: 'pm', connectionId: 'claude-cli', model: 'pm-choice' }, { roleIndex: 3, roleKey: 'solo', connectionId: 'codex-cli', model: 'solo-choice' }]
    : [{ roleIndex: 0, roleKey: 'solo', connectionId: 'codex-cli', model: 'solo-choice' }] });
  expect(forbidden).not.toHaveBeenCalled(); expect((await guide.view()).note?.text).toContain('Each role keeps its chosen connection and model');
});
