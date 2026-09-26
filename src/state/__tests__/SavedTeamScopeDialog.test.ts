import { describe, expect, it } from 'vitest';
import { SAVE_TEAM_SCOPE_DIALOG, savedTeamScopeForChoice } from '../SavedTeamScopeDialog';

describe('saved-team scope modal', () => {
  it('offers both explicit scopes and a cancelling choice', () => {
    expect(SAVE_TEAM_SCOPE_DIALOG).toMatchObject({
      title: 'Where should this team be saved?',
      project: 'Save to This project',
      library: 'Save to All projects',
      cancel: 'Cancel',
    });
    expect(SAVE_TEAM_SCOPE_DIALOG.detail).toContain('Save to This project');
    expect(SAVE_TEAM_SCOPE_DIALOG.detail).toContain('Save to All projects');
    expect(SAVE_TEAM_SCOPE_DIALOG.detail).toContain('Cancel');
  });

  it.each([
    [SAVE_TEAM_SCOPE_DIALOG.project, 'workspace'],
    [SAVE_TEAM_SCOPE_DIALOG.library, 'global'],
    [SAVE_TEAM_SCOPE_DIALOG.cancel, undefined],
    [undefined, undefined],
  ] as const)('maps %s to %s', (choice, scope) => {
    expect(savedTeamScopeForChoice(choice)).toBe(scope);
  });
});
