/*---------------------------------------------------------------------------------------------
 *  UnodeAi - HostDeactivation (v0.9.96)
 *  The order in which the extension host winds down when its window closes or reloads. The editor ends the host a
 *  few seconds after it starts to deactivate it, and the host's exit ends each direct child at once, which leaves
 *  the child's descendants out of reach. So every stop is sent before anything is waited for. A pending save is
 *  started first, so that it stores the state from before the stops, as it always did, and it is waited for last:
 *  a save that never finishes or that fails holds back no stop and no disposal. vscode-free.
 *--------------------------------------------------------------------------------------------*/

export interface HostDeactivationSteps {
  /** Begins the host shutdown: from here no direct command starts, and every tree stop sends its kill first. */
  beginShutdown(): void;
  /** The saves still pending. Each takes its snapshot when it is called. */
  pendingSaves(): ReadonlyArray<() => unknown>;
  /** Says that the turns the stops are about to end are cut off by the window, so their records stay unfinished. */
  hostExiting(): void;
  /** Each stop, all started at once: the terminals, the sessions, the host's direct children, the MCP servers. */
  stops: ReadonlyArray<() => Promise<unknown>>;
  /** Disposes the services the stops report through. Called once every stop has settled. */
  disposeServices(): Promise<void>;
  /** A save that threw or failed. */
  saveFailed(error: unknown): void;
}

/** Wind the host down. Settles once the services are disposed and every save has settled. */
export async function deactivateHost(steps: HostDeactivationSteps): Promise<void> {
  steps.beginShutdown();
  const failed = (error: unknown): void => {
    try { steps.saveFailed(error); } catch { /* a report must not stop the shutdown */ }
  };
  let saves: ReadonlyArray<() => unknown> = [];
  try {
    saves = steps.pendingSaves();
  } catch (error) {
    failed(error);
  }
  const saving = startEach(saves).map((save) => save.then(() => undefined, failed));
  steps.hostExiting();
  await Promise.allSettled(startEach(steps.stops));
  try {
    await steps.disposeServices();
  } finally {
    await Promise.all(saving);
  }
}

/** Start every step at once. One that throws counts as failed and keeps none of the others from starting. */
function startEach(steps: ReadonlyArray<() => unknown>): Promise<unknown>[] {
  return steps.map((step) => {
    try {
      return Promise.resolve(step());
    } catch (error) {
      return Promise.reject(error);
    }
  });
}
