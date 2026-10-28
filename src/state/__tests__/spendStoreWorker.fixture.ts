/*
 * Independent-process worker for SpendStore.process.test.ts. Bundled by the test with esbuild and run in its own
 * Node process, so two "windows" share one spend directory through the real file system only.
 */
import { FileSpendLedger, SpendLockBusyError } from '../SpendStore';
import { aggregateSpend, counterTotals, totalsSnapshot } from '../../models/spend/SpendAggregate';
import type { CounterResetV1 } from '../../models/spend/SpendTypes';

const [mode, root, hostEpoch, countText, barrier] = process.argv.slice(2);
const count = Number(countText ?? '0');

async function waitForBarrier(): Promise<void> {
  if (!barrier) return;
  const fs = await import('fs');
  while (!fs.existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 2));
}

/**
 * Takes the lock, passes its ownership check, then stalls just before publishing until the barrier file appears,
 * like a window suspended mid-transaction. It never renews, so its lease runs out while it is stalled.
 */
async function staleHolder(): Promise<void> {
  const store = new FileSpendLedger({
    root, hostEpoch, pollMs: 0, renewMs: 600_000,
    beforeControlPublish: async () => {
      process.stdout.write('at-publish\n');
      await waitForBarrier();
    },
  });
  await store.open();
  try {
    await store.transact((control) => ({
      next: { ...control, noticeClaims: [...control.noticeClaims, { key: 'stale', claimedAt: new Date().toISOString() }] },
      result: undefined,
    }));
    process.stdout.write('committed\n');
  } catch (error) {
    process.stdout.write(error instanceof SpendLockBusyError ? 'rejected\n' : `failed ${String(error)}\n`);
  }
  await store.dispose();
  process.stdout.write('done\n');
}

async function main(): Promise<void> {
  if (mode === 'stale-holder') return staleHolder();
  const store = new FileSpendLedger({ root, hostEpoch, pollMs: 0 });
  await store.open();
  await waitForBarrier();
  if (mode === 'receipts' || mode === 'progress') {
    for (let i = 0; i < count; i++) {
      const unit = `${hostEpoch}-u${i}`;
      await store.append({ kind: 'usage-unit-start', usageUnitId: unit, requestId: 'shared-request', agentId: hostEpoch, connectionId: 'unode', modelId: 'm', providerAttempts: 1 }, `start:${unit}:1`);
      if (mode === 'progress') {
        await store.append({
          kind: 'usage-progress', progressId: `progress:${unit}:1`, usageUnitId: unit, requestId: 'shared-request', providerAttempt: 1,
          tokens: { input: 7, output: 3, basis: 'reported' }, displayCost: { basis: 'unavailable' }, reminderValue: { tokens: 10, basis: 'reported-tokens' },
        }, `progress:${unit}:1`);
      }
      await store.append({ kind: 'usage-receipt', receipt: {
        schemaVersion: 1, receiptId: `usage:${unit}`, requestId: 'shared-request', usageUnitId: unit, providerAttempts: 1,
        ...(mode === 'progress' ? { coveredProgressIds: [`progress:${unit}:1`] } : {}),
        agentId: hostEpoch, connectionId: 'unode', modelId: 'm', observedAt: new Date().toISOString(),
        tokens: { input: mode === 'progress' ? 14 : 7, output: mode === 'progress' ? 6 : 3, basis: 'reported' },
        displayCost: { basis: 'unavailable' }, reminderValue: { tokens: mode === 'progress' ? 20 : 10, basis: 'reported-tokens' },
      } }, `usage:${unit}`);
    }
  } else if (mode === 'reset') {
    for (let i = 0; i < count; i++) {
      for (;;) {
        try {
          await store.transact((control, snapshot) => {
            const aggregate = aggregateSpend(snapshot.events);
            const scope = { kind: 'request' as const, requestId: 'shared-request' };
            const reset: CounterResetV1 = {
              resetId: `reset-${hostEpoch}-${i}`, scope: 'request', requestId: 'shared-request', resetAt: new Date().toISOString(), actor: 'user',
              watermarks: { ...aggregate.watermarks }, previousTotals: totalsSnapshot(counterTotals(aggregate, control, scope)),
            };
            return { next: { ...control, resets: [...control.resets, reset] }, result: undefined };
          });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 3));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } else if (mode === 'hold-lock') {
    await store.transact(() => {
      process.stdout.write('holding\n');
      // Never returns: the parent kills this process while it owns the maintenance lock.
      for (;;) { /* hold */ }
    });
  }
  await store.dispose();
  process.stdout.write('done\n');
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.stack : error));
  process.exit(1);
});
