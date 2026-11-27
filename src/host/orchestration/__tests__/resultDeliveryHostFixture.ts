// The real ResultDeliveryHost with real body files and a real PersistenceManager, shared by
// ResultDeliveryHost.test.ts and ResultDeliveryHost.capacity.test.ts (v0.9.105 S8: split so the capacity cases run
// in their own file, in parallel). Each test file mocks 'vscode' itself and calls cleanupResultDeliveryCases().
import { vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { ResultDeliveryHost, type ResultDeliveryHostPort } from '../ResultDeliveryHost';
import { PersistenceManager } from '../../../state/PersistenceManager';
import { RunLedger } from '../../../observability/RunLedger';
import { workspaceRootIdentity } from '../../../state/WorkspaceRootIdentity';

const base = path.join(process.cwd(), '.audit-repro', 'result-consumer');
const dirs: string[] = [];
// A heavy case that times out keeps running in the background; restore its prototype spies so they cannot leak into later cases.
export async function cleanupResultDeliveryCases(): Promise<void> { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) {
  if (path.dirname(dir) !== base || !path.basename(dir).startsWith('case-')) throw new Error('Invalid cleanup');
  await fs.rm(dir, { recursive: true, force: true });
} }

export async function setup(options: { storageFolder?: string } = {}) {
  await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'case-')); dirs.push(dir);
  const storageFolder = options.storageFolder ? path.join(dir, options.storageFolder) : dir;
  const data = new Map<string, unknown>();
  let fail = false; let current = true;
  let heldLedger: Promise<void> | undefined;
  const state = { get: (key: string, fallback?: unknown) => data.get(key) ?? fallback, keys: () => [...data.keys()],
    update: async (key: string, value: unknown) => { if (fail) throw new Error('storage failed');
      if (value === undefined) data.delete(key); else data.set(key, structuredClone(value)); } };
  const persistence = new PersistenceManager({ workspaceState: state } as never, undefined, () => '/workspace');
  const ledgerOptions = { activeTurnId: () => undefined };
  let ledger = new RunLedger([], ledgerOptions);
  const markers = new Map<string, string>(); let persistedRuns: unknown[] = [];
  const recoveryReady = vi.fn();
  const archives = new Map<string, string>();
  const archive = vi.fn((_identity, text: string) => { const messageId = `archive-${archives.size + 1}`;
    archives.set(messageId, text); return { conversationId: 'pm', messageId }; }); const notice = vi.fn(); const logRecoveryWarning = vi.fn();
  const port = (): ResultDeliveryHostPort => ({ persistence, ledger, storageUri: { scheme: 'file', fsPath: storageFolder },
    workspaceId: workspaceRootIdentity(dir), assertCurrent: () => { if (!current) throw new Error('stale'); }, owns: () => true,
    archive, hasDelivery: (id, digest) => markers.get(id.settledEventId) === digest,
    recordDelivery: async (id, digest) => { if (fail) throw new Error('marker save failed'); markers.set(id.settledEventId, digest); },
    saveArchive: async () => { if (fail) throw new Error('archive save failed'); },
    saveLedger: async () => { await heldLedger; if (fail) throw new Error('run save failed'); persistedRuns = ledger.snapshot(); }, notice, logRecoveryWarning, recoveryReady });
  let host = new ResultDeliveryHost(port()); await host.open();
  // open() deliberately returns after 500 ms; these ready-store scenarios need the actual initialization.
  await host.drain();
  const dispatch = (handle = 'h') => { ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle, agentId: 'dev',
    requestedAgent: 'dev', instruction: 'do the work', attemptId: `attempt-${handle}`, originCorrelationId: 'user-task' }); host.reserve('pm', handle); };
  const settle = async (handle = 'h', text = 'worker answer') => {
    ledger.recordDelegationEvidence({ handle, agentId: 'dev', outcome: 'no-evidence', evidence: {
      outcome: 'no-evidence', completionState: 'complete', changedFiles: [], hadToolActions: false, unrecordedWrites: false,
      verification: { ran: false } } });
    host.retain('pm', { handle, ref: 'dev', text }); await host.drain();
  };
  // v0.9.101 S4.1: settle without drain(), which would wait for a store that is still opening; wait for the queue only.
  const settleNow = async (handle = 'h', text = 'worker answer') => {
    ledger.recordDelegationEvidence({ handle, agentId: 'dev', outcome: 'no-evidence', evidence: {
      outcome: 'no-evidence', completionState: 'complete', changedFiles: [], hadToolActions: false, unrecordedWrites: false,
      verification: { ran: false } } });
    host.retain('pm', { handle, ref: 'dev', text }); await queued();
  };
  const queued = () => (host as unknown as { tail: Promise<unknown> }).tail;
  return { dispatch, settle, settleNow, queued, data, markers, notice, logRecoveryWarning, archive, dir, persistence, recoveryReady,
    host: () => host, ledger: () => ledger, fail: (value: boolean) => { fail = value; }, stale: () => { current = false; },
    holdLedger: (value: Promise<void> | undefined) => { heldLedger = value; },
    reload: async () => { await host.drain(); host.close(); ledger = new RunLedger(persistedRuns, ledgerOptions); host = new ResultDeliveryHost(port()); await host.open(); await host.drain(); },
    /** As activation does: returns when open() does, which may be before the store is ready. */
    reloadUntilOpenReturns: async () => { await host.drain(); host.close(); ledger = new RunLedger(persistedRuns, ledgerOptions); host = new ResultDeliveryHost(port()); await host.open(); } };
}
