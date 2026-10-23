import { describe, expect, it } from 'vitest';
import { TurnProviderFacts, TurnToolCallIds } from '../toolCallIds';

describe('TurnToolCallIds', () => {
  it('opens a new host id for every use, whether or not the provider named it', () => {
    const ids = new TurnToolCallIds();
    expect([ids.open('toolu_1'), ids.open(), ids.open('toolu_1')]).toEqual(['call-1', 'call-2', 'call-3']);
  });

  it('closes a provider id to the host id opened for it, once', () => {
    const ids = new TurnToolCallIds();
    const first = ids.open('item-a');
    const second = ids.open('item-b');
    expect(ids.close('item-b')).toBe(second);
    expect(ids.close('item-a')).toBe(first);
    // Released: a repeated result cannot borrow the same identity again.
    expect(ids.close('item-a')).toBe('call-3');
  });

  it('gives a result it never saw begin a fresh id rather than another call\'s', () => {
    const ids = new TurnToolCallIds();
    ids.open('item-a');
    expect(ids.close('unknown')).toBe('call-2');
    expect(ids.close('')).toBe('call-3');
    expect(ids.close('item-a')).toBe('call-1');
  });

  it('never pairs a result through a provider id reused while still open', () => {
    const ids = new TurnToolCallIds();
    expect([ids.open('dup'), ids.open('dup')]).toEqual(['call-1', 'call-2']);
    // Neither result can say which use it answers: both get fresh ids and both uses stay unmatched.
    expect([ids.close('dup'), ids.close('dup')]).toEqual(['call-3', 'call-4']);
    // The id stays ambiguous for the rest of the turn.
    expect(ids.open('dup')).toBe('call-5');
    expect(ids.close('dup')).toBe('call-6');
    // Other provider ids are unaffected.
    const other = ids.open('other');
    expect(ids.close('other')).toBe(other);
  });

  it('pairs a provider id reused only after its earlier call closed', () => {
    const ids = new TurnToolCallIds();
    const first = ids.open('seq');
    expect(ids.close('seq')).toBe(first);
    const second = ids.open('seq');
    expect(ids.close('seq')).toBe(second);
  });

  it('joins a noted fact to the one result its provider id names', () => {
    const ids = new TurnToolCallIds();
    const facts = new TurnProviderFacts<string>(ids);
    ids.open('a');
    facts.note('a', 'refused');
    expect(facts.take('a')).toEqual({ fact: 'refused', unjoined: false });
    ids.close('a');
    // Taken once: a later result for the same id finds nothing.
    expect(facts.take('a')).toEqual({ unjoined: false });
  });

  it('joins no fact through a provider id that is ambiguous, whenever the fact was noted', () => {
    const ids = new TurnToolCallIds();
    const facts = new TurnProviderFacts<string>(ids);
    ids.open('dup');
    facts.note('dup', 'refused');
    ids.open('dup');
    expect(facts.take('dup')).toEqual({ unjoined: true });
    // The second result has no fact of its own left to lose.
    expect(facts.take('dup')).toEqual({ unjoined: false });
    facts.note('dup', 'late');
    expect(facts.take('dup')).toEqual({ unjoined: true });
  });

  it('joins neither of two facts noted for one provider id before its result', () => {
    const ids = new TurnToolCallIds();
    const facts = new TurnProviderFacts<string>(ids);
    ids.open('twice');
    facts.note('twice', 'success');
    facts.note('twice', 'refused');
    facts.note('twice', 'third');
    expect(facts.take('twice')).toEqual({ unjoined: true });
    expect(facts.take('twice')).toEqual({ unjoined: true });
    // Other provider ids are unaffected, and a new turn forgets the conflict.
    facts.note('other', 'ok');
    expect(facts.take('other')).toEqual({ fact: 'ok', unjoined: false });
    ids.reset();
    facts.reset();
    facts.note('twice', 'fresh');
    expect(facts.take('twice')).toEqual({ fact: 'fresh', unjoined: false });
  });

  it('restarts ids and forgets provider ids at a new host turn', () => {
    const ids = new TurnToolCallIds();
    ids.open('item-a');
    ids.open('item-b');
    ids.reset();
    expect(ids.close('item-a')).toBe('call-1');
    expect(ids.open('item-b')).toBe('call-2');
    // Ambiguity is turn-local too.
    ids.open('dup');
    ids.open('dup');
    ids.reset();
    const fresh = ids.open('dup');
    expect(ids.close('dup')).toBe(fresh);
  });
});
