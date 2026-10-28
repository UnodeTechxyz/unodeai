/*---------------------------------------------------------------------------------------------
 *  UnodeAi - The spend port of a session's turns, also shown to the request limit meter (v0.9.94)
 *
 *  Every usage call a turn makes goes to the meter first and then to the spend port, with the same arguments.
 *  The meter is told first so a request's totals are current before anything the spend call sets off. What the
 *  spend port does and returns is unchanged.
 *--------------------------------------------------------------------------------------------*/

import type { RequestLimitMeter } from '../host/RequestLimitMeter';
import type { SpendSessionPort } from './SessionManager';

export function meteredSpendPort(spend: SpendSessionPort, meter: RequestLimitMeter): SpendSessionPort {
  return {
    beginRequest: (requestId, rootAgentId) => spend.beginRequest(requestId, rootAgentId),
    beginUsageUnit: (unit) => {
      meter.beginUsageUnit(unit);
      spend.beginUsageUnit(unit);
    },
    noteModelRequest: (usageUnitId) => {
      meter.noteModelRequest(usageUnitId);
      spend.noteModelRequest(usageUnitId);
    },
    noteUsageProgress: (usageUnitId, progress) => {
      meter.noteUsageProgress(usageUnitId, progress);
      spend.noteUsageProgress(usageUnitId, progress);
    },
    settleUsageUnit: (usageUnitId, usage) => {
      meter.settleUsageUnit(usageUnitId, usage);
      return spend.settleUsageUnit(usageUnitId, usage);
    },
    closeUsageUnit: (usageUnitId) => {
      meter.closeUsageUnit(usageUnitId);
      spend.closeUsageUnit(usageUnitId);
    },
  };
}
