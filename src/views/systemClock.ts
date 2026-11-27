import { execFile, execFileSync } from 'node:child_process';
import * as path from 'node:path';

const KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation';

/**
 * v0.9.100 (field): Windows' British Columbia zone is newer than the time zone data in this editor's runtime, which then
 * has no zone and runs an hour off the system clock. Minutes west of UTC as Windows has them, only when the runtime
 * cannot name its zone; a runtime that can gets undefined and no process is started.
 */
export function systemUtcBiasMinutes(deps: { platform: NodeJS.Platform; zone(): string | undefined; query(): string } = {
  platform: process.platform,
  zone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  query: () => execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
    ['query', KEY, '/v', 'ActiveTimeBias'], { encoding: 'utf8', timeout: 2000, windowsHide: true }),
}): number | undefined {
  if (deps.platform !== 'win32') return undefined;
  const zone = deps.zone();
  if (zone && zone !== 'Etc/Unknown') return undefined;
  let output: string;
  try { output = deps.query(); } catch { return undefined; }
  return parseActiveTimeBias(output);
}

/** Minutes west of UTC from `reg query … /v ActiveTimeBias` output; undefined when absent or out of range. */
export function parseActiveTimeBias(output: string): number | undefined {
  const match = /ActiveTimeBias\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(output);
  if (!match) return undefined;
  const bias = parseInt(match[1], 16) | 0;
  return Math.abs(bias) <= 14 * 60 ? bias : undefined;
}

/**
 * v0.9.104 (ROADMAP items 1 and 2, the Owner): the correction for a runtime whose offset for now is `runtimeOffsetNow`,
 * given Windows' bias: Windows' bias when the two differ, else none. L1: a runtime that names its zone but has older
 * rules than Windows is corrected too, not only one that names none. A runtime that agrees with Windows now shifts
 * nothing, so its own rules keep dating past times. Minutes west of UTC.
 */
export function correctionFor(windowsBias: number | undefined, runtimeOffsetNow: number): number | undefined {
  return windowsBias !== undefined && windowsBias !== runtimeOffsetNow ? windowsBias : undefined;
}

let cachedBias: { value: number | undefined } | undefined;
/**
 * The correction this process applies. Read synchronously once only when the runtime names no zone (no process starts
 * on activation otherwise); then kept current by `applyWindowsBias` from each asynchronous read of Windows.
 */
export function systemClockBias(): number | undefined {
  cachedBias ??= { value: systemUtcBiasMinutes() };
  return cachedBias.value;
}

/**
 * v0.9.104 (L2: a correction was kept across a DST change until Reload Window): take Windows' bias as just read. An
 * unread bias changes nothing. Returns whether the correction changed.
 */
export function applyWindowsBias(windowsBias: number | undefined, now: Date = new Date()): boolean {
  if (windowsBias === undefined) return false;
  const next = correctionFor(windowsBias, now.getTimezoneOffset());
  const changed = systemClockBias() !== next;
  cachedBias = { value: next };
  return changed;
}

/**
 * This instant as a Date whose local fields read as the system clock. Every local time on screen goes through this.
 * The runtime's own offset is the one it applies to that instant. A runtime that knows its zone shifts nothing.
 */
export function onSystemClock(when: number | string | Date, bias: number | undefined = systemClockBias()): Date {
  const date = new Date(when);
  return bias === undefined ? date : new Date(date.getTime() + (date.getTimezoneOffset() - bias) * 60_000);
}

/** The bias as an offset time zone name, for formatting that also names the zone. */
export function systemClockZone(bias: number | undefined): string | undefined {
  if (bias === undefined) return undefined;
  const minutes = Math.abs(bias);
  return `${bias > 0 ? '-' : '+'}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * v0.9.103 (the clock investigation): what one runtime says about its clock, so the same moment can be compared across
 * Windows, the extension host and the Chat view in the field. Minutes west of UTC, as `getTimezoneOffset` gives them.
 */
export interface ClockFacts {
  zone?: string;
  locale?: string;
  offsetMinutes: number;
  runtime?: string;
}

/** The extension host's own clock facts. */
export function hostClockFacts(now: Date = new Date()): ClockFacts {
  const options = Intl.DateTimeFormat().resolvedOptions();
  const versions = process.versions as Record<string, string | undefined>;
  const runtime = [
    `Node ${process.version}`,
    versions.icu ? `ICU ${versions.icu}` : '',
    versions.tz ? `tz ${versions.tz}` : '',
    versions.electron ? `Electron ${versions.electron}` : '',
  ].filter(Boolean).join(', ');
  return { zone: options.timeZone || undefined, locale: options.locale, offsetMinutes: now.getTimezoneOffset(), runtime };
}

/**
 * The bias Windows has now, for the clock report only: read without blocking, and off Windows never.
 * Unlike `systemUtcBiasMinutes`, this is read also when the runtime names its zone, because a named zone whose rules
 * are older than Windows' is the case the report exists to show.
 */
export function readWindowsBias(deps: { platform: NodeJS.Platform; query(): Promise<string> } = {
  platform: process.platform,
  query: () => new Promise((resolve, reject) => execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
    ['query', KEY, '/v', 'ActiveTimeBias'], { encoding: 'utf8', timeout: 2000, windowsHide: true },
    (error, stdout) => (error ? reject(error) : resolve(stdout)))),
}): Promise<number | undefined> {
  if (deps.platform !== 'win32') return Promise.resolve(undefined);
  return deps.query().then(parseActiveTimeBias, () => undefined);
}

function utcLabel(minutesWest: number): string {
  return `UTC${systemClockZone(minutesWest)}`;
}

function factsText(facts: ClockFacts): string {
  const runtime = facts.runtime ? ` (${facts.runtime})` : '';
  return `zone ${facts.zone ?? 'not named'}, locale ${facts.locale ?? 'unknown'}, ${utcLabel(facts.offsetMinutes)} now${runtime}`;
}

/**
 * One log line comparing the clocks. `correction` is the bias UnodeAi applies on screen (undefined: none). A time on
 * screen then reads at `correction` when there is one, and otherwise at the runtime's own offset.
 */
export function clockReportLine(input: {
  platform: NodeJS.Platform;
  windowsBias: number | undefined;
  host: ClockFacts;
  view: ClockFacts;
  correction: number | undefined;
}): string {
  const { platform, windowsBias, host, view, correction } = input;
  const windows = platform !== 'win32' ? 'Windows: not Windows'
    : windowsBias === undefined ? 'Windows: its bias could not be read'
    : `Windows: ${utcLabel(windowsBias)} (ActiveTimeBias ${windowsBias} min)`;
  const shown = {
    chat: correction ?? view.offsetMinutes,
    log: correction ?? host.offsetMinutes,
  };
  const applied = correction === undefined ? 'none' : `to ${utcLabel(correction)}`;
  let verdict: string;
  if (platform !== 'win32' || windowsBias === undefined) {
    verdict = `Chat shows ${utcLabel(shown.chat)}, the message log ${utcLabel(shown.log)}; not compared with Windows.`;
  } else {
    // A larger offset west reads an earlier wall time: behind Windows' clock.
    const gap = (where: string, minutesWest: number) => minutesWest === windowsBias ? ''
      : `${where} is ${Math.abs(minutesWest - windowsBias)} min ${minutesWest > windowsBias ? 'behind' : 'ahead of'} Windows`;
    const off = [gap('Chat', shown.chat), gap('the message log', shown.log)].filter(Boolean);
    verdict = off.length === 0 ? 'Times on screen match Windows.' : `Times on screen differ: ${off.join('; ')}.`;
  }
  return `clock: ${windows} | extension host: ${factsText(host)} | Chat view: ${factsText(view)} | correction: ${applied} | ${verdict}`;
}

/**
 * Logs the clock comparison when a Chat view loads or its window regains focus. Windows is read each time (Codex's audit
 * of 093f7d04: a first reading kept for the process said "match" after Windows' clock changed), and a line already
 * logged is not repeated, so a reload adds nothing unless a clock changed. v0.9.104: the reading also keeps the
 * correction current (`apply`), and is returned, so the view that asked corrects its own clock with it.
 */
export class ClockReporter {
  private readonly logged = new Set<string>();

  constructor(
    private readonly log: (line: string) => void,
    private readonly deps: {
      platform: NodeJS.Platform;
      readWindowsBias(): Promise<number | undefined>;
      host(): ClockFacts;
      correction(): number | undefined;
      apply?(windowsBias: number | undefined): void;
    } = {
      platform: process.platform, readWindowsBias: () => readWindowsBias(), host: () => hostClockFacts(),
      correction: () => systemClockBias(), apply: (windowsBias) => { applyWindowsBias(windowsBias); },
    },
    /** Told when a reading changed the correction, so what the host drew with the old one is drawn again. */
    private readonly onCorrectionChange?: () => void,
  ) {}

  report(view: ClockFacts): Promise<number | undefined> {
    return this.deps.readWindowsBias().catch(() => undefined).then((windowsBias) => {
      const before = this.deps.correction();
      try { this.deps.apply?.(windowsBias); } catch { /* the log line still says what was read */ }
      if (this.deps.correction() !== before) {
        try { this.onCorrectionChange?.(); } catch { /* a view that cannot redraw keeps its times until it does */ }
      }
      const line = clockReportLine({ platform: this.deps.platform, windowsBias, host: this.deps.host(), view, correction: this.deps.correction() });
      if (!this.logged.has(line) && this.logged.size < 20) {
        this.logged.add(line);
        this.log(line);
      }
      return windowsBias;
    });
  }
}
