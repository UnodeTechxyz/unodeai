import { describe, expect, it } from 'vitest';
import { SessionStatus } from '../../types';
import { shouldRestartAfterAgentConfigEdit } from '../sessionLifecycle';

describe('shouldRestartAfterAgentConfigEdit', () => {
  it.each<SessionStatus>(['idle', 'running'])('restarts live %s sessions', (status) => {
    expect(shouldRestartAfterAgentConfigEdit(status)).toBe(true);
  });

  it.each<SessionStatus>(['stopped', 'starting', 'consent_required', 'stopping', 'error'])('does not revive %s sessions', (status) => {
    expect(shouldRestartAfterAgentConfigEdit(status)).toBe(false);
  });
});
