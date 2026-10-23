import { describe, expect, it } from 'vitest';
import { formatLocalInstant } from '../localInstant';

/*
 * v0.9.93: a Job outcome card states its instants in the person's local time and names the zone; exported
 * evidence keeps UTC and says so. A bare time that could be read as either is what this replaces.
 */
describe('formatLocalInstant', () => {
  const instant = '2026-10-04T08:12:33.123Z';

  it('shows the instant in the given zone and names that zone', () => {
    const shanghai = formatLocalInstant(instant, 'en-US', 'Asia/Shanghai');
    expect(shanghai).toContain('Oct 4, 2026');
    expect(shanghai).toContain('04:12:33');
    expect(shanghai).toContain('GMT+8');
    const utc = formatLocalInstant(instant, 'en-US', 'UTC');
    expect(utc).toContain('08:12:33');
    expect(utc).toContain('UTC');
    // The same instant, two different wall clocks: the zone is what tells them apart.
    expect(shanghai).not.toBe(utc);
  });

  it('moves the date with the zone when the local day differs from the UTC day', () => {
    const late = '2026-10-04T20:30:00.000Z';
    expect(formatLocalInstant(late, 'en-US', 'Asia/Shanghai')).toContain('Oct 5, 2026');
    expect(formatLocalInstant(late, 'en-US', 'America/Los_Angeles')).toContain('Oct 4, 2026');
  });

  it('names a zone without being given one, in the machine\'s own', () => {
    const local = formatLocalInstant(instant);
    expect(local).not.toBe('');
    expect(local).not.toContain('T08:12:33');
    expect(local).toBe(new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).format(new Date(instant)));
  });

  it('returns nothing for a value that is not an instant, so the caller shows the stored text', () => {
    expect(formatLocalInstant('none accepted')).toBe('');
    expect(formatLocalInstant('')).toBe('');
    expect(formatLocalInstant(undefined)).toBe('');
    expect(formatLocalInstant(1_759_565_553_123)).toBe('');
    expect(formatLocalInstant(instant, 'en-US', 'Not/AZone')).toBe('');
  });

  it('works from its own source text, as the Chat webview runs it', () => {
    const standalone = new Function(`return (${formatLocalInstant.toString()});`)() as typeof formatLocalInstant;
    expect(standalone(instant, 'en-US', 'Asia/Shanghai')).toBe(formatLocalInstant(instant, 'en-US', 'Asia/Shanghai'));
    expect(standalone('not a time')).toBe('');
  });
});
