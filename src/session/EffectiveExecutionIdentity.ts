/*---------------------------------------------------------------------------------------------
 *  UnodeAi - host-private effective execution identity
 *
 *  This records only what the host selected and the route reported for one produced turn. It does
 *  not identify an underlying model behind a gateway and must not be copied into prompts, tool
 *  results, roster data, ledgers, or portable evidence.
 *--------------------------------------------------------------------------------------------*/

export interface EffectiveExecutionIdentity {
  readonly reportedModelId: string;
  readonly routeVersionKey: {
    readonly connectionId: string;
    readonly revision: number;
  };
}

export interface EffectiveExecutionIdentityComparison {
  readonly sameReportedModel: boolean;
  readonly sameConfiguredRouteAndModel: boolean;
}

/** Freeze the host-observed execution choice at the point a turn is produced. */
export function createEffectiveExecutionIdentity(
  reportedModelId: string,
  connectionId: string,
  revision: number,
): EffectiveExecutionIdentity {
  return Object.freeze({
    reportedModelId,
    routeVersionKey: Object.freeze({ connectionId, revision }),
  });
}

/** Two deliberately separate facts; neither claims that the same underlying model answered. */
export function compareEffectiveExecutionIdentities(
  left: EffectiveExecutionIdentity,
  right: EffectiveExecutionIdentity,
): EffectiveExecutionIdentityComparison {
  const sameReportedModel = left.reportedModelId === right.reportedModelId;
  return Object.freeze({
    sameReportedModel,
    sameConfiguredRouteAndModel: sameReportedModel
      && left.routeVersionKey.connectionId === right.routeVersionKey.connectionId
      && left.routeVersionKey.revision === right.routeVersionKey.revision,
  });
}
