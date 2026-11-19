import { describe, expect, it } from 'vitest';
import { PendingDelegationResults } from '../PendingDelegationResults';

describe('PendingDelegationResults', () => {
  it('keeps only valid settled results and isolates coordinators with the same handle', () => {
    const results = new PendingDelegationResults([
      { coordinatorId: 'pm-a', handle: 'same', ref: 'dev-a', text: 'A' },
      { coordinatorId: 'pm-b', handle: 'same', ref: 'dev-b', text: 'B' },
      { coordinatorId: '', handle: 'broken', ref: 'dev', text: 'ignored' },
    ]);

    expect(results.forCoordinator('pm-a')).toEqual([
      { coordinatorId: 'pm-a', handle: 'same', ref: 'dev-a', text: 'A' },
    ]);

    results.consume('pm-a', 'same');
    expect(results.forCoordinator('pm-a')).toEqual([]);
    expect(results.forCoordinator('pm-b')).toEqual([
      { coordinatorId: 'pm-b', handle: 'same', ref: 'dev-b', text: 'B' },
    ]);
  });
});

describe('v0.9.91 retained delegation settlements', () => {
  it('keeps a valid typed settlement with its result and drops one that is not exactly a fact', () => {
    const store = new PendingDelegationResults([
      { coordinatorId: 'pm', handle: 'h-1', ref: 'dev', text: 'done', outcome: { status: 'failed', observedBy: 'host', failureKind: 'error' } },
      { coordinatorId: 'pm', handle: 'h-2', ref: 'dev', text: 'done', outcome: { status: 'success', observedBy: 'host', failureKind: 'error' } as never },
      { coordinatorId: 'pm', handle: 'h-3', ref: 'dev', text: 'done' },
    ]);
    const restored = new PendingDelegationResults(JSON.parse(JSON.stringify(store.snapshot())));
    expect(restored.forCoordinator('pm').map((entry) => [entry.handle, entry.outcome ?? null])).toEqual([
      ['h-1', { status: 'failed', observedBy: 'host', failureKind: 'error' }],
      // A contradictory or missing settlement leaves the result unclassified; the result itself is kept.
      ['h-2', null],
      ['h-3', null],
    ]);
  });
});
