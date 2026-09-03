import { describe, expect, it } from 'vitest';
import { keysToReset } from '../resetWorkspaceKeys';

const FIXED = [
  'roam.agents',
  'roam.messages',
  'roam.workflows',
  'roam.approvedMcpServers',
  'roam.checkpoints',
  'roam.pendingDelegationResults',
  'roam.runs',
  'roam.onboardingComplete',
];
const PREFIXES = ['roam.snapshot.', 'roam.chat.'];

describe('keysToReset', () => {
  it('selects fixed keys plus any prefixed (snapshot/chat) keys, and leaves others alone', () => {
    const all = [
      'roam.agents',
      'roam.messages',
      'roam.snapshot.dev-1',
      'roam.snapshot.pm-1',
      'roam.chat.dev-1',
      'roam.chat.tools.dev-1',
      'roam.chat.qa-1',
      'roam.checkpoints',
      'roam.someUnrelatedSetting', // must NOT be cleared
      'editor.fontSize', // unrelated, must NOT be cleared
    ];
    const result = keysToReset(all, FIXED, PREFIXES).sort();
    expect(result).toEqual(
      [
        ...FIXED,
        'roam.snapshot.dev-1',
        'roam.snapshot.pm-1',
        'roam.chat.dev-1',
        'roam.chat.tools.dev-1',
        'roam.chat.qa-1',
      ].sort()
    );
    expect(result).not.toContain('roam.someUnrelatedSetting');
    expect(result).not.toContain('editor.fontSize');
  });

  it('includes fixed keys even when none are present in workspaceState yet', () => {
    expect(keysToReset([], FIXED, PREFIXES).sort()).toEqual([...FIXED].sort());
  });

  it('does not duplicate a fixed key that also appears in the enumerated keys', () => {
    const result = keysToReset(['roam.agents', 'roam.chat.a'], FIXED, PREFIXES);
    expect(result.filter((k) => k === 'roam.agents')).toHaveLength(1);
  });
});
