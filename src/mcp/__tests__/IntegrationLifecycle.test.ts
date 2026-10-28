import { describe, expect, it } from 'vitest';
import { IntegrationEvidenceStore, integrationLifecycle } from '../IntegrationLifecycle';
import { MCPServerConfig } from '../../types';

const cfg: MCPServerConfig = { id: 'docs', name: 'Docs', transport: 'stdio', command: 'npx', args: ['pkg'] };

describe('Integration lifecycle', () => {
  it('keeps each host-observed state distinct', () => {
    expect(integrationLifecycle({ configured: true, approved: false, mounted: false })).toEqual({
      listed: true, configured: true, approved: false, mounted: false, exercised: false, succeeded: false,
    });
  });

  it('persists exercised separately from succeeded for the exact launch identity', async () => {
    let saved: Record<string, unknown> = {};
    const state = {
      get: <T>(_key: string, fallback: T): T => (saved.value as T) ?? fallback,
      update: async (_key: string, value: unknown) => { saved = { value }; },
    };
    const store = new IntegrationEvidenceStore(state, 'C:/project');
    await store.noteExercised(cfg, false);
    expect(store.evidenceFor(cfg).exercisedAt).toBeTruthy();
    expect(store.evidenceFor(cfg).succeededAt).toBeUndefined();
    await store.noteExercised(cfg, true);
    expect(store.evidenceFor(cfg).succeededAt).toBeTruthy();
    expect(store.evidenceFor({ ...cfg, args: ['other'] })).toEqual({});
  });
});
