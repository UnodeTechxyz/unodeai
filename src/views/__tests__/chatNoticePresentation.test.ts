import { describe, expect, it } from 'vitest';
import { noticeKeyFor, presentNotices, readDismissedNotices } from '../chatNoticePresentation';

const notice = (seq: number, text = 'Same') => ({ role: 'agent', runtimeNotice: true, text, seq, ts: '2026-10-25T00:00:00Z' });

describe('reminder view projection', () => {
  it('leaves every source row unchanged and keeps all rows in the projected state', () => {
    const source = [notice(1), notice(2), notice(3)];
    const before = structuredClone(source);
    const projected = presentNotices(source, []);
    expect(source).toEqual(before); expect(projected).toHaveLength(3);
    expect(projected.map(row => row.notice?.hidden)).toEqual([false, true, true]);
    expect(projected[0].notice?.keys).toHaveLength(3);
    expect(projected[0].notice?.count).toBe(3);
    const closed = presentNotices(source, projected[0].notice!.keys);
    expect(closed.every(row => row.notice?.hidden)).toBe(true); expect(source).toEqual(before);
  });

  it('only merges equal titles AND equal text, and never across a non-notice', () => {
    const items = [
      { ...notice(1), outcomeCard: { title: 'First', detail: 'Same' } },
      { ...notice(2), outcomeCard: { title: 'Other', detail: 'Same' } },
      { ...notice(3), outcomeCard: { title: 'Other', detail: 'Different' } },
      { role: 'user', text: 'Next', seq: 4 }, notice(5),
    ];
    expect(presentNotices(items, []).map(row => row.notice?.count)).toEqual([1, 1, 1, undefined, 1]);
  });

  it('never treats a live row, a user, or an ordinary model reply as a dismissible reminder', () => {
    expect(presentNotices([
      { ...notice(1), live: true }, { ...notice(2), role: 'user' },
      { role: 'agent', fromName: 'PM', text: 'Answer', seq: 3 },
    ], []).every(row => row.notice === undefined)).toBe(true);
  });

  it('preserves keyed identity through a settled wording change, and distinguishes legacy duplicate rows', () => {
    expect(noticeKeyFor({ ...notice(1), noticeKey: 'outcome-repair/x' }))
      .toBe(noticeKeyFor({ ...notice(1, 'Settled'), noticeKey: 'outcome-repair/x' }));
    const legacy = { ...notice(1), seq: undefined, runtimeNotice: undefined, fromName: 'UnodeAi' };
    expect(noticeKeyFor(legacy, 0)).not.toBe(noticeKeyFor(legacy, 1));
    expect(noticeKeyFor(legacy, 0)).toBe(noticeKeyFor(structuredClone(legacy), 0));
    expect(noticeKeyFor(legacy, 1)).toBe(noticeKeyFor({ ...legacy, seq: 1234 }, 1));
  });
  it('does not hide the active actions by merging equal prose in different card states', () => {
    const base = { title: 'Retry', detail: 'Same text' };
    const rows = [
      { ...notice(1), outcomeCard: { ...base, state: 'unavailable' } },
      { ...notice(2), outcomeCard: { ...base, state: 'offered', actions: [{ kind: 'retry-same-route', label: 'Retry' }] } },
    ];
    expect(presentNotices(rows, []).map(row => row.notice?.hidden)).toEqual([false, false]);
    expect(presentNotices(rows, []).map(row => row.notice?.count)).toEqual([1, 1]);
  });

  it('restores at most 500 bounded unique view keys, with no notice content', () => {
    const keys = Array.from({ length: 510 }, (_, n) => 'notice:' + n.toString(16).padStart(64, '0'));
    expect(readDismissedNotices([null, {}, 'Raw command text', ...keys, keys.at(-1)]))
      .toEqual(keys.slice(-500));
    expect(readDismissedNotices({})).toEqual([]);
  });
});
