import { describe, expect, it } from 'vitest';
import { deactivateHost, type HostDeactivationSteps } from '../HostDeactivation';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise the test settles by hand. */
function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** The steps, each writing what it did to `log`; the stops wait for the test. */
function windowClosing(saves: Array<() => unknown>) {
  const log: string[] = [];
  const failures: string[] = [];
  const stops = ['terminals', 'sessions', 'direct', 'mcp'].map((name) => ({ name, ...deferred() }));
  const steps: HostDeactivationSteps = {
    beginShutdown: () => { log.push('begin'); },
    pendingSaves: () => saves.map((save, index) => () => { log.push(`save ${index}`); return save(); }),
    hostExiting: () => { log.push('host exiting'); },
    stops: stops.map((stop) => () => { log.push(`stop ${stop.name}`); return stop.promise; }),
    disposeServices: async () => { log.push('dispose'); },
    saveFailed: (error) => { failures.push(error instanceof Error ? error.message : String(error)); },
  };
  const settleStops = () => { for (const stop of stops) stop.resolve(); };
  return { log, failures, stops, steps, settleStops };
}

describe('deactivateHost (v0.9.96)', () => {
  it('sends every stop while a save never finishes, disposes once the stops settle, and still waits for the save', async () => {
    const closing = windowClosing([() => new Promise(() => undefined)]);
    let returned = false;
    void deactivateHost(closing.steps).then(() => { returned = true; });
    await tick();
    expect(closing.log).toEqual(['begin', 'save 0', 'host exiting', 'stop terminals', 'stop sessions', 'stop direct', 'stop mcp']);

    // The services stay until the last stop has settled.
    closing.stops[0].resolve();
    closing.stops[1].resolve();
    closing.stops[2].resolve();
    await tick();
    expect(closing.log).not.toContain('dispose');
    closing.stops[3].resolve();
    await tick();
    expect(closing.log.at(-1)).toBe('dispose');
    // The save is handed over before the host may end.
    expect(returned).toBe(false);
  });

  it('holds back no stop and no disposal for a save that throws or fails, and reports each', async () => {
    const closing = windowClosing([
      () => { throw new Error('the storage is gone'); },
      () => Promise.reject(new Error('the disk is full')),
      () => undefined,
    ]);
    const deactivating = deactivateHost(closing.steps);
    await tick();
    expect(closing.log).toEqual(['begin', 'save 0', 'save 1', 'save 2', 'host exiting', 'stop terminals', 'stop sessions', 'stop direct', 'stop mcp']);
    closing.settleStops();
    await deactivating;
    expect(closing.log.at(-1)).toBe('dispose');
    expect(closing.failures).toEqual(['the storage is gone', 'the disk is full']);
  });

  it('still sends every stop when the pending saves cannot even be listed, and when the report itself fails', async () => {
    const closing = windowClosing([]);
    const deactivating = deactivateHost({
      ...closing.steps,
      pendingSaves: () => { throw new Error('no saves'); },
      saveFailed: () => { throw new Error('no channel'); },
    });
    await tick();
    expect(closing.log).toEqual(['begin', 'host exiting', 'stop terminals', 'stop sessions', 'stop direct', 'stop mcp']);
    closing.settleStops();
    await deactivating;
    expect(closing.log.at(-1)).toBe('dispose');
  });

  it('starts every stop when one throws or fails, and disposes only after the rest have settled', async () => {
    const closing = windowClosing([]);
    const slow = deferred();
    const deactivating = deactivateHost({
      ...closing.steps,
      stops: [
        () => { closing.log.push('stop throws'); throw new Error('no terminals'); },
        () => { closing.log.push('stop fails'); return Promise.reject(new Error('no sessions')); },
        () => { closing.log.push('stop slow'); return slow.promise; },
      ],
    });
    await tick();
    expect(closing.log).toEqual(['begin', 'host exiting', 'stop throws', 'stop fails', 'stop slow']);
    slow.resolve();
    await deactivating;
    expect(closing.log.at(-1)).toBe('dispose');
  });
});
