import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { HostShutdown } from '../backend/processTree';
import { deactivateHost } from '../host/HostDeactivation';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * extension.ts's own deactivate(), run against stand-ins for the module state it reads. The extension does not load
 * outside VS Code, so the function's source is compiled alone and every name it uses is supplied here.
 */
function loadDeactivate(state: Record<string, unknown>): () => Promise<void> {
  const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
  const start = source.indexOf('export async function deactivate(): Promise<void> {');
  const body = source.slice(start, source.indexOf('\n}\n', start) + 2).replace(/^export /, '');
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('state', `with (state) { ${js}; return deactivate; }`)(state) as () => Promise<void>;
}

/** A window with a run save pending, whose every step writes what it did to `did`. */
function closingWindow(
  persistRunLedger: () => Promise<void>,
  chatDraftMirror?: { writePending(): boolean; flush(): Promise<boolean> },
  resultDrain: () => Promise<void> = async () => {},
) {
  const did: string[] = [];
  const warnings: string[] = [];
  const hostShutdown = new HostShutdown();
  const state = {
    agentRosterEdits: { retryUnsaved: vi.fn(async () => {}) },
    // v0.9.99: shutdown also closes the host, clearing its recovery reminders.
    resultDeliveryHost: { drain: resultDrain, close: vi.fn() },
    deactivateHost,
    hostShutdown,
    outputChannel: { info: () => undefined, warn: (message: string) => { warnings.push(message); } },
    dashboardRefreshTimer: undefined,
    messageSaveTimer: undefined,
    runSaveTimer: setTimeout(() => undefined, 60_000),
    runOwnerHeartbeatTimer: undefined,
    checkpointSaveTimer: undefined,
    persistRunLedger: () => { did.push(`run save, shutdown begun: ${hostShutdown.started}`); return persistRunLedger(); },
    persistence: { saveMessages: () => undefined, saveCheckpoints: () => undefined },
    messageBus: { exportMessages: () => [], dispose: () => { did.push('message bus disposed'); } },
    checkpointStore: { serialize: () => ({}) },
    terminalManager: { disposeAll: async () => { did.push('terminals'); } },
    sessionManager: {
      hostExiting: () => { did.push('host exiting'); },
      shutdown: async () => { did.push('sessions'); },
      dispose: () => { did.push('sessions disposed'); },
    },
    directChildren: { stopAll: async () => { did.push('direct children'); } },
    terminateChildProcessTree: async () => ({ status: 'already-stopped' }),
    resolveHostProgram: (program: string) => program,
    mcpHub: { stopAll: async () => { did.push('mcp'); } },
    agentChannels: new Map(),
    chatDraftMirror,
  };
  return { did, warnings, retryUnsaved: state.agentRosterEdits.retryUnsaved, resultHostClose: state.resultDeliveryHost.close, deactivate: loadDeactivate(state) };
}

const EVERY_STOP = ['host exiting', 'terminals', 'sessions', 'direct children', 'mcp'];

it('the actual shutdown starts the pending Off-save retry without delaying process stops', async () => {
  const window = closingWindow(async () => {});
  await window.deactivate();
  expect(window.retryUnsaved).toHaveBeenCalledOnce();
  expect(window.did).toEqual(expect.arrayContaining(EVERY_STOP));
});
const DISPOSAL = ['sessions disposed', 'message bus disposed', 'terminals'];

describe('the extension\'s deactivate (v0.9.96)', () => {
  it('starts result recovery drain without holding back any stop or disposal', async () => {
    const drain = vi.fn(() => new Promise<void>(() => {}));
    const window = closingWindow(async () => {}, undefined, drain);
    let returned = false;
    void window.deactivate().then(() => { returned = true; });
    await tick();
    expect(drain).toHaveBeenCalledOnce();
    expect(window.resultHostClose).toHaveBeenCalledOnce();
    expect(window.did).toEqual(['run save, shutdown begun: true', ...EVERY_STOP, ...DISPOSAL]);
    expect(returned).toBe(false);
  });
  it('sends every stop while the run save never finishes, and disposes the services once the stops settle', async () => {
    const window = closingWindow(() => new Promise(() => undefined));
    let returned = false;
    void window.deactivate().then(() => { returned = true; });
    await tick();
    // The save takes its snapshot before the stops, as it always did, and is no longer waited for before them.
    expect(window.did).toEqual(['run save, shutdown begun: true', ...EVERY_STOP, ...DISPOSAL]);
    expect(returned).toBe(false);
  });

  it('starts a pending Workbench draft write with the other saves and still sends every stop first, though it never settles', async () => {
    const flushes: string[] = [];
    const window = closingWindow(async () => undefined, {
      writePending: () => true,
      flush: () => {
        flushes.push('draft copy write started');
        return new Promise<boolean>(() => undefined);
      },
    });
    let returned = false;
    void window.deactivate().then(() => { returned = true; });
    await tick();
    expect(flushes).toEqual(['draft copy write started']);
    expect(window.did).toEqual(['run save, shutdown begun: true', ...EVERY_STOP, ...DISPOSAL]);
    // VS Code ends the host on its own deadline; the stuck write never held a stop or a disposal back.
    expect(returned).toBe(false);
  });

  it('starts no draft write when none is pending', async () => {
    const flush = vi.fn(async () => true);
    const window = closingWindow(async () => undefined, { writePending: () => false, flush });
    await window.deactivate();
    expect(flush).not.toHaveBeenCalled();
    expect(window.did).toEqual(['run save, shutdown begun: true', ...EVERY_STOP, ...DISPOSAL]);
  });

  it('sends every stop, disposes and returns when the run save fails, and says so in the output channel', async () => {
    const window = closingWindow(() => Promise.reject(new Error('the disk is full')));
    await window.deactivate();
    expect(window.did).toEqual(['run save, shutdown begun: true', ...EVERY_STOP, ...DISPOSAL]);
    expect(window.warnings).toEqual(['A save while the window closed failed: Error: the disk is full']);
  });
});
