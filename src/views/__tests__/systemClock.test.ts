import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { formatLocalInstant } from '../localInstant';
import { onSystemClock, systemClockZone, systemUtcBiasMinutes } from '../systemClock';

// Field 2026-10-31: Windows British Columbia zone, ActiveTimeBias 0x1a4; Electron 43 and Node 25 have no zone and an
// offset of 480, so every card clock was an hour behind the system clock.
const OUTPUT = 'HKEY_LOCAL_MACHINE\\SYSTEM\r\n    ActiveTimeBias    REG_DWORD    0x1a4\r\n';

describe('the system clock when the runtime has no zone', () => {
  it('a card shows the system clock, and a runtime that agrees shifts nothing', () => {
    const source = readFileSync('src/views/ChatViewProvider.ts', 'utf8');
    const at = source.indexOf('function onSystemClock(ms) {');
    const body = source.slice(at, source.indexOf('\n    }\n', at) + 7);
    const clock = (bias: number | null, offset: number) => {
      class Runtime extends Date { getTimezoneOffset() { return offset; } }
      return new Function('Date', 'SYSTEM_UTC_BIAS', `${body}; return onSystemClock;`)(Runtime, bias) as (ms: number) => Date;
    };
    const t = Date.UTC(2026, 9, 31, 22, 0, 0);
    expect(clock(420, 480)(t).getTime()).toBe(t + 60 * 60_000);
    expect(clock(420, 420)(t).getTime()).toBe(t);
    expect(clock(null, 480)(t).getTime()).toBe(t);
  });

  it('the offset the runtime subtracts is the one it has for that instant, not for today', () => {
    const source = readFileSync('src/views/ChatViewProvider.ts', 'utf8');
    const at = source.indexOf('function onSystemClock(ms) {');
    const body = source.slice(at, source.indexOf('\n    }\n', at) + 7);
    const summer = Date.UTC(2026, 6, 1);
    const winter = Date.UTC(2026, 0, 1);
    class Runtime extends Date { getTimezoneOffset() { return this.getTime() === summer ? 420 : 480; } }
    const clock = new Function('Date', 'SYSTEM_UTC_BIAS', `${body}; return onSystemClock;`)(Runtime, 420) as (ms: number) => Date;
    expect(clock(summer).getTime()).toBe(summer);
    expect(clock(winter).getTime()).toBe(winter + 60 * 60_000);
  });

  it('the host side applies the same rule, and a runtime that knows its zone shifts nothing', () => {
    const at = new Date(Date.UTC(2026, 9, 31, 22, 0, 0));
    expect(onSystemClock(at.toISOString(), at.getTimezoneOffset()).getTime()).toBe(at.getTime());
    expect(onSystemClock(at.getTime(), at.getTimezoneOffset() - 60).getTime()).toBe(at.getTime() + 60 * 60_000);
  });

  it('a time that names its zone names the system offset', () => {
    expect(systemClockZone(undefined)).toBeUndefined();
    expect(systemClockZone(420)).toBe('-07:00');
    expect(systemClockZone(-330)).toBe('+05:30');
    expect(systemClockZone(0)).toBe('+00:00');
    expect(formatLocalInstant('2026-11-01T05:08:19.000Z', 'en-US', '-07:00')).toContain('10:08:19');
  });

  it('every local time on screen goes through the clock', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(full); } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(full);
      }
    };
    walk('src');
    const direct = files.filter((file) => /new Date\([^)]*\)\.toLocale(Time|Date)?String\(/.test(readFileSync(file, 'utf8')));
    expect(direct).toEqual([]);
    for (const [file, used] of [
      ['src/views/MessageLogProvider.ts', 'onSystemClock(m.timestamp)'],
      ['src/views/runCloseoutPresentation.ts', 'onSystemClock(run.startedAt)'],
      ['src/state/TeamLibrary.ts', 'onSystemClock(entry.savedAt)'],
      ['src/views/ChatViewProvider.ts', 'onSystemClock(when.getTime()).toLocaleString()'],
      ['src/views/ChatViewProvider.ts', 'formatLocalInstant(row.instant, undefined, SYSTEM_CLOCK_ZONE)'],
    ] as const) expect(readFileSync(file, 'utf8')).toContain(used);
  });

  it('reads the bias Windows has, only when the runtime cannot name its zone', () => {
    const query = vi.fn(() => OUTPUT);
    expect(systemUtcBiasMinutes({ platform: 'win32', zone: () => undefined, query })).toBe(420);
    expect(systemUtcBiasMinutes({ platform: 'win32', zone: () => 'Etc/Unknown', query })).toBe(420);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('starts no process when the runtime knows its zone, or off Windows', () => {
    const query = vi.fn(() => OUTPUT);
    expect(systemUtcBiasMinutes({ platform: 'win32', zone: () => 'America/Vancouver', query })).toBeUndefined();
    expect(systemUtcBiasMinutes({ platform: 'linux', zone: () => undefined, query })).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('a failed or odd answer changes nothing', () => {
    const on = (query: () => string) => systemUtcBiasMinutes({ platform: 'win32', zone: () => undefined, query });
    expect(on(() => { throw new Error('no reg'); })).toBeUndefined();
    expect(on(() => 'nothing here')).toBeUndefined();
    expect(on(() => 'ActiveTimeBias REG_DWORD 0x7fffffff')).toBeUndefined();
    // West is positive, east negative: a 32-bit value above the sign bit.
    expect(on(() => 'ActiveTimeBias REG_DWORD 0xfffffe20')).toBe(-480);
  });
});

// v0.9.104 (ROADMAP items 1 and 2, the Owner): L1, a runtime that names its zone with older rules than Windows, and L2,
// a correction kept across a DST change until Reload Window.
describe('the correction follows Windows (v0.9.104 L1, L2)', () => {
  it('corrects a runtime whose offset for now differs from Windows, named zone or not, and leaves one that agrees', async () => {
    const { correctionFor } = await import('../systemClock');
    expect(correctionFor(420, 480)).toBe(420); // older rules: an hour behind Windows
    expect(correctionFor(480, 0)).toBe(480); // no zone: the runtime runs at UTC
    expect(correctionFor(480, 480)).toBeUndefined(); // agrees: its own rules date past times
    expect(correctionFor(undefined, 480)).toBeUndefined();
  });

  it('takes each reading of Windows, keeps the last correction when a reading fails, and says when it changed', async () => {
    vi.resetModules();
    const clock = await import('../systemClock');
    const winter = new Date('2026-01-15T12:00:00Z');
    const offset = winter.getTimezoneOffset();
    // A known start, whatever this machine's own Windows reading was: Windows agrees with the runtime.
    clock.applyWindowsBias(offset, winter);
    expect(clock.systemClockBias()).toBeUndefined();
    expect(clock.applyWindowsBias(offset - 60, winter)).toBe(true);
    expect(clock.systemClockBias()).toBe(offset - 60);
    // A failed read changes nothing.
    expect(clock.applyWindowsBias(undefined, winter)).toBe(false);
    expect(clock.systemClockBias()).toBe(offset - 60);
    // Windows moves (a DST change, or its zone data was updated) and now agrees: the correction is dropped.
    expect(clock.applyWindowsBias(offset, winter)).toBe(true);
    expect(clock.systemClockBias()).toBeUndefined();
    expect(clock.applyWindowsBias(offset, winter)).toBe(false);
  });

  it('the clock report applies what it read, so the host corrects itself, and returns it for the view that asked', async () => {
    const { ClockReporter } = await import('../systemClock');
    const applied: Array<number | undefined> = [];
    let correction: number | undefined;
    const lines: string[] = [];
    const reporter = new ClockReporter((line) => lines.push(line), {
      platform: 'win32', readWindowsBias: async () => 420, host: () => ({ zone: 'America/Vancouver', offsetMinutes: 480 }),
      correction: () => correction, apply: (bias) => { applied.push(bias); correction = bias === 480 ? undefined : bias; },
    });
    expect(await reporter.report({ zone: 'America/Vancouver', offsetMinutes: 480 })).toBe(420);
    expect(applied).toEqual([420]);
    // The line describes the corrected screen: both surfaces at Windows' clock.
    expect(lines[0]).toContain('correction: to UTC-07:00');
    expect(lines[0]).toContain('Times on screen match Windows.');
  });
});

// v0.9.104 (Codex's audit of 5ab8dfb0, F3): the host is told when a reading changed the correction, so a view whose times
// the host drew (the Message Log) is drawn again; a reading that changes nothing redraws nothing.
describe('the clock report tells the host when the correction changed', () => {
  it('calls back once per change, never for an unchanged reading, and a failing callback does not stop the report', async () => {
    const { ClockReporter } = await import('../systemClock');
    let correction: number | undefined;
    let reading: number | undefined = 420;
    const changes: Array<number | undefined> = [];
    let fail = false;
    const reporter = new ClockReporter(() => undefined, {
      platform: 'win32', readWindowsBias: async () => reading, host: () => ({ offsetMinutes: 480 }),
      correction: () => correction, apply: (bias) => { if (bias !== undefined) correction = bias === 480 ? undefined : bias; },
    }, () => { changes.push(correction); if (fail) throw new Error('view gone'); });
    await reporter.report({ offsetMinutes: 480 });
    await reporter.report({ offsetMinutes: 480 });
    reading = undefined;
    await reporter.report({ offsetMinutes: 480 });
    expect(changes).toEqual([420]);
    reading = 480;
    fail = true;
    expect(await reporter.report({ offsetMinutes: 480 })).toBe(480);
    expect(changes).toEqual([420, undefined]);
  });
});
