import type { TeamLibraryScope } from './TeamLibrary';

/** Copy and mapping for the save-scope modal, kept pure so both scope choices and Cancel are testable. */
export const SAVE_TEAM_SCOPE_DIALOG = {
  title: 'Where should this team be saved?',
  detail: 'Save to This project — share .unode/teams/ with this repository; it loads read-only until you confirm saved permissions.\n'
    + 'Save to All projects — store it only in your personal UnodeAi library.\n'
    + 'Cancel — leave the current team unchanged.',
  project: 'Save to This project',
  library: 'Save to All projects',
  cancel: 'Cancel',
} as const;

export function savedTeamScopeForChoice(choice: string | undefined): TeamLibraryScope | undefined {
  if (choice === SAVE_TEAM_SCOPE_DIALOG.project) return 'workspace';
  if (choice === SAVE_TEAM_SCOPE_DIALOG.library) return 'global';
  return undefined;
}
