import { describe, expect, it, vi } from 'vitest';
import {
  buildCompletionVerificationSettingsView,
  readLegacyGlobalVerificationCommand,
} from '../CompletionVerificationSettings';

describe('completion verification Settings projection', () => {
  it('reads only the User/global legacy value, never the merged workspace value', () => {
    const configuration = {
      inspect: vi.fn(() => ({ globalValue: 'npm test', workspaceValue: 'node repository-command.js' })),
      get: vi.fn(() => { throw new Error('merged get() must not be used'); }),
    };

    expect(readLegacyGlobalVerificationCommand(configuration)).toBe('npm test');
    expect(configuration.inspect).toHaveBeenCalledWith('verifyCommand');
    expect(configuration.get).not.toHaveBeenCalled();
  });

  it('shows all three effective modes with their source and cwd', () => {
    const common = { workspaceRoot: 'C:/repo', agentSkills: [] as string[], readLegacyGlobalCommand: () => undefined };
    expect(buildCompletionVerificationSettingsView({ ...common, completionVerification: { mode: 'disabled' } }))
      .toMatchObject({ kind: 'ready', mode: 'disabled', source: 'team-document', cwd: 'C:/repo' });
    expect(buildCompletionVerificationSettingsView({ ...common, completionVerification: { mode: 'auto' } }))
      .toMatchObject({ kind: 'ready', mode: 'auto', source: 'team-document', cwd: 'C:/repo' });
    expect(buildCompletionVerificationSettingsView({ ...common, completionVerification: { mode: 'command', command: 'npm test' } }))
      .toMatchObject({ kind: 'ready', mode: 'command', command: 'npm test', source: 'team-document', cwd: 'C:/repo' });
  });

  it('does not read the legacy command for a knowledge team', () => {
    const readLegacyGlobalCommand = vi.fn(() => 'npm test');
    expect(buildCompletionVerificationSettingsView({
      workspaceRoot: '/repo', agentSkills: ['market-research'], readLegacyGlobalCommand,
    })).toMatchObject({ kind: 'ready', mode: 'disabled', source: 'legacy-default', teamKind: 'knowledge' });
    expect(readLegacyGlobalCommand).not.toHaveBeenCalled();
  });

  it('describes an invalid legacy value without retaining its contents', () => {
    const view = buildCompletionVerificationSettingsView({
      workspaceRoot: '/repo', agentSkills: [], readLegacyGlobalCommand: () => 'private-token\nrun',
    });
    expect(view).toMatchObject({
      kind: 'configuration-invalid', source: 'legacy-global', repair: 'legacy-user-settings',
      detail: expect.stringContaining('single line'),
    });
    expect(JSON.stringify(view)).not.toContain('private-token');
  });

  it('keeps an invalid or unreadable team file distinct from a missing field', () => {
    expect(buildCompletionVerificationSettingsView({
      workspaceRoot: '/repo', agentSkills: [], readLegacyGlobalCommand: () => 'npm test',
      teamDocumentState: 'configuration-invalid',
    })).toMatchObject({ kind: 'configuration-invalid', source: 'team-document', repair: 'team-file' });
    expect(buildCompletionVerificationSettingsView({
      workspaceRoot: '/repo', agentSkills: [], readLegacyGlobalCommand: () => 'npm test',
      teamDocumentState: 'unreadable',
    })).toMatchObject({ kind: 'unavailable', detail: expect.stringContaining('could not be read') });
  });

  it('does not resolve settings without a workspace', () => {
    const readLegacyGlobalCommand = vi.fn(() => 'npm test');
    expect(buildCompletionVerificationSettingsView({ agentSkills: [], readLegacyGlobalCommand }))
      .toEqual({ kind: 'unavailable', detail: 'Open a workspace folder to view this team setting.' });
    expect(readLegacyGlobalCommand).not.toHaveBeenCalled();
  });
});
