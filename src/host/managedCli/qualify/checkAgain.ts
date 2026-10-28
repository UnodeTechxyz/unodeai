/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Check again, after the check of a Codex version could not confirm that its process stopped (v0.9.97)
 *  An unconfirmed stop is a prohibition recorded in control: nothing automatic runs that version again. Only the
 *  user's Check again, after the warning that the earlier process may still run, starts one more bounded check. It
 *  passes exactly that one entry; a suspension, another reason, another setup or any other condition still refuses.
 *  Its result replaces the entry: a pass is recorded as a fact in the instance first, and only then is the entry
 *  removed, in a control generation of its own.
 *--------------------------------------------------------------------------------------------*/

import type { InstanceRef, VersionKey } from '../contracts';
import { boundedDetail } from './keyFacts';
import { qualifyVersion, type QualificationDeps, type QualificationOutcome } from './qualification';

export interface CheckAgainRequest {
  readonly ref: InstanceRef;
  readonly key: VersionKey;
  /**
   * The caller showed `checkAgainWarning` and the user chose to go on. Required, with no default: Check again never
   * runs without the warning, and never automatically.
   */
  readonly warningShown: true;
}

/** The warning shown before Check again: the earlier check's process may still be running. */
export function checkAgainWarning(version: string, detail: string | undefined): string {
  return `UnodeAi could not confirm that the earlier check of Codex ${version} stopped${detail ? ` (${boundedDetail(detail)})` : ''}. `
    + 'If it still runs, the new check runs beside it. End any process started from UnodeAi\'s managed Codex folder, '
    + 'then choose Check again.';
}

/** The user's Check again for one version whose only `disabled` entry is an unconfirmed stop. */
export async function checkAgain(deps: QualificationDeps, request: CheckAgainRequest): Promise<QualificationOutcome> {
  if (request.warningShown !== true) {
    return { outcome: 'refused', reason: 'warning', detail: 'Check again starts only after the warning about the earlier check was shown.' };
  }
  return qualifyVersion(deps, request.ref, request.key, { checkAgain: true });
}
