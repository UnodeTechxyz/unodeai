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
