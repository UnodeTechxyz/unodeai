import { describe, expect, it } from 'vitest';
import { CodexSessionNetwork } from '../codexSessionNetwork';

// v0.9.102 (R2, the Owner 2026-11-12): network a person allowed for one Codex agent from a card, for this window only.
describe('Codex network for this session', () => {
  it('starts off, is per agent, and every allow or removal changes the revision', () => {
    const store = new CodexSessionNetwork();
    const changed: string[] = [];
    store.onChange((agentId) => changed.push(agentId));
    expect(store.get('a')).toEqual({ allowed: false, revision: 0 });
    const first = store.allow('a');
    expect(store.get('a')).toEqual({ allowed: true, revision: first });
    expect(store.get('b').allowed).toBe(false);
    expect(store.allowedAgents()).toEqual(['a']);
    expect(store.remove('a')).toBe(true);
    const removed = store.get('a');
    expect(removed.allowed).toBe(false);
    expect(removed.revision).toBeGreaterThan(first);
    expect(store.remove('a')).toBe(false);
    expect(store.allow('a')).toBeGreaterThan(removed.revision);
    expect(changed).toEqual(['a', 'a', 'a']);
  });

  it('allows from a card only while the revision the card read is current', () => {
    const store = new CodexSessionNetwork();
    const read = store.get('a').revision;
    const allowed = store.allowIf('a', read);
    expect(allowed).toBeDefined();
    const cardRead = store.get('a').revision;
    store.remove('a');
    expect(store.allowIf('a', cardRead)).toBeUndefined();
    expect(store.get('a').allowed).toBe(false);
  });

  it('is memory only: a new store, as after a reload, has no network for anyone', () => {
    const before = new CodexSessionNetwork();
    before.allow('a');
    expect(new CodexSessionNetwork().get('a')).toEqual({ allowed: false, revision: 0 });
  });
});
