import { describe, expect, it } from 'vitest';
import { priceMultiplierBackfill, readPriceGroupSetting, readPriceMultiplierSetting } from '../LivePriceService';

/**
 * A billing group belongs to the key, not to the account.
 *
 * Confirmed with the gateway operator, 2026-08-21: one account can hold two keys in different groups, with
 * different prices and different callable models. `unode.priceGroup` was a single global string sent to
 * every gateway, so a user in that position could not state the truth — pinning it correctly for one
 * connection made it wrong for the other, and there was no way to tell which one the displayed price
 * belonged to.
 */
describe('unode.priceGroup names a group per connection', () => {
  it('applies a plain string everywhere, for the common single-group case', () => {
    const group = readPriceGroupSetting('vip');
    expect(group('roam')).toBe('vip');
    expect(group('unode')).toBe('vip');
  });

  it('lets two connections hold different groups', () => {
    const group = readPriceGroupSetting({ roam: 'vip', unode: 'default' });
    expect(group('roam')).toBe('vip');
    expect(group('unode')).toBe('default');
    // A connection the map does not mention is unpinned, not defaulted to a neighbour's group.
    expect(group('custom:abc')).toBeUndefined();
  });

  it('treats empty, blank and malformed settings as unpinned rather than as a group named ""', () => {
    for (const raw of ['', '   ', undefined, null, 42, [], { roam: '' }, { roam: '  ' }, { roam: 7 }]) {
      expect(readPriceGroupSetting(raw)('roam'), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('trims, because a pasted group name carries whitespace and a lookup would silently miss', () => {
    expect(readPriceGroupSetting('  vip  ')('roam')).toBe('vip');
    expect(readPriceGroupSetting({ roam: ' vip ' })('roam')).toBe('vip');
  });
});

/**
 * The coefficient the gateway will not report.
 *
 * A pricing endpoint publishes what a model costs. What the holder of one key is charged is settled
 * internally and frequently not sent at all — field report, 2026-08-21: a key swapped into another price
 * group changed the model range at once and the prices not at all, because nothing arrived to change them
 * by. Naming a group cannot recover a number nobody sent, so this setting carries the number.
 */
describe('unode.priceMultiplier states what the gateway does not send', () => {
  it('applies a bare number everywhere and a map per connection', () => {
    expect(readPriceMultiplierSetting(0.33)('unode')).toBe(0.33);
    const perKey = readPriceMultiplierSetting({ unode: 0.33, roam: 1 });
    expect(perKey('unode')).toBe(0.33);
    expect(perKey('roam')).toBe(1);
  });

  /**
   * Unstated is not 1, and conflating them was the second half of the double-discount defect.
   *
   * A stated 1 says "this key pays list price" and suppresses the gateway's own group ratio. An absent
   * value says nothing and lets the ratio through. When both were 1, every connection overrode a gateway
   * that did know the answer — the mirror image of the bug Codex found on 2026-08-21, where both were
   * applied and 0.33 against 0.33 displayed 0.1089 of list.
   */
  it('reports a connection nobody has spoken for as unstated, not as list price', () => {
    expect(readPriceMultiplierSetting({ unode: 0.33 })('roam')).toBeUndefined();
    expect(readPriceMultiplierSetting({})('unode')).toBeUndefined();
    expect(readPriceMultiplierSetting(undefined)('unode')).toBeUndefined();
  });

  /**
   * Zero is a real coefficient. A free or internally-settled key costs nothing, and refusing to express
   * that would force the user to state a price they do not pay (Owner, 2026-08-21).
   */
  it('accepts zero, because a key that costs nothing is a fact', () => {
    expect(readPriceMultiplierSetting(0)('unode')).toBe(0);
    expect(readPriceMultiplierSetting({ unode: 0 })('unode')).toBe(0);
  });

  /**
   * A negative price is not a fact about anything, and neither is NaN. Those read as unstated so the
   * gateway's own answer applies, rather than a number nobody meant silently becoming the authority.
   */
  it('treats a value that is not a price as unstated', () => {
    for (const raw of [-1, NaN, Infinity, '0.5', null, {}, { unode: -2 }, { unode: 'half' }]) {
      expect(readPriceMultiplierSetting(raw)('unode'), JSON.stringify(raw) ?? 'undefined').toBeUndefined();
    }
  });
});

/**
 * The backfill that could not fire.
 *
 * Codex review, 2026-08-21: the setting's default was the number 1 and the function returned early on a
 * number, so it never ran for anybody. A backfill that cannot run is indistinguishable from one that ran and
 * found nothing — which is why the handoff claimed it worked.
 */
describe('backfilling a coefficient for keys that predate the prompt', () => {
  it('gives every keyed connection a stated 1, and only those', () => {
    const plan = priceMultiplierBackfill({}, ['unode', 'roam']);
    expect(plan).toEqual({ next: { unode: 1, roam: 1 }, added: ['unode', 'roam'] });
  });

  it('never overwrites a coefficient the user already stated, including zero', () => {
    const plan = priceMultiplierBackfill({ unode: 0.33, roam: 0 }, ['unode', 'roam', 'openai']);
    expect(plan?.next).toEqual({ unode: 0.33, roam: 0, openai: 1 });
    expect(plan?.added).toEqual(['openai']);
  });

  it('does nothing when there is nothing to add, so no settings write and no message happen', () => {
    expect(priceMultiplierBackfill({ unode: 1 }, ['unode'])).toBeUndefined();
    expect(priceMultiplierBackfill({}, [])).toBeUndefined();
  });

  // A bare number is a deliberate "same everywhere" statement; rewriting it into a map changes what the
  // user said. This is also the branch that silently disabled the whole backfill when 1 was the default.
  it('leaves a bare number alone rather than converting it behind the user', () => {
    expect(priceMultiplierBackfill(1, ['unode', 'roam'])).toBeUndefined();
    expect(priceMultiplierBackfill(0.5, ['unode'])).toBeUndefined();
  });
});
