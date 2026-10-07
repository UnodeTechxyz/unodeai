/* Host-authored terminal facts. These report observed state; they never continue a model turn. */

export interface UnverifiedChangesState {
  verifyObligation: boolean;
  wroteAnything: boolean;
  verifiedSinceLastWrite: boolean;
}

export function unverifiedChangesWarning(state: UnverifiedChangesState): string | undefined {
  return state.verifyObligation && state.wroteAnything && !state.verifiedSinceLastWrite
    ? '⚠ Changes not verified: files were modified but project checks were not run and any diagnostics remain unresolved.'
    : undefined;
}
