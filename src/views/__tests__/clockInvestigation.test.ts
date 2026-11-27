import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { parseChatWebviewInboundMessage } from '../chatWebviewProtocol';
import { ClockReporter, clockReportLine, readWindowsBias, type ClockFacts } from '../systemClock';

// v0.9.103, the T103-10 clock investigation. Probed on the Owner's machine (Windows "British Columbia Standard Time",
// ActiveTimeBias 0x1a4 = UTC-07:00 all year), 2026-11-14:
// - VS Code's Electron 43.8.6 (tz 2026e) names America/Vancouver at UTC-07:00: it agrees with Windows.
// - Cursor's Electron 42.10.0 and Devin's 42.2.0 (tz 2025c), and Node 25.9 (tz 2026a), name no zone and run at UTC-08:00;
//   the v0.9.100 correction applies there.
// - Node 25.9 with TZ=America/Vancouver names the zone with the old rules (UTC-08:00 after 2026-11-01): a named zone
//   whose rules are older than Windows'. Nothing corrects that; the clock report below is what shows it in the field.
// The two instants: 09:30Z reads 02:30 at UTC-07:00 all year, and 01:30 in a runtime that fell back.
const INSTANTS = ['2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z'] as const;

const facts = (offsetMinutes: number, zone?: string): ClockFacts => ({ zone, locale: 'en-CA', offsetMinutes, runtime: 'test' });

describe('the clock report', () => {
  it('a runtime that knows the zone and agrees with Windows: nothing differs', () => {
    const line = clockReportLine({ platform: 'win32', windowsBias: 420, host: facts(420, 'America/Vancouver'), view: facts(420, 'America/Vancouver'), correction: undefined });
    expect(line).toContain('Windows: UTC-07:00 (ActiveTimeBias 420 min)');
    expect(line).toContain('extension host: zone America/Vancouver, locale en-CA, UTC-07:00 now (test)');
    expect(line).toContain('correction: none');
    expect(line).toMatch(/Times on screen match Windows\.$/);
  });

  it('a named zone with rules older than Windows: the report says each surface is behind', () => {
    const line = clockReportLine({ platform: 'win32', windowsBias: 420, host: facts(480, 'America/Vancouver'), view: facts(480, 'America/Vancouver'), correction: undefined });
    expect(line).toMatch(/Times on screen differ: Chat is 60 min behind Windows; the message log is 60 min behind Windows\.$/);
  });

  it('a runtime without the zone, corrected to the Windows bias: nothing differs', () => {
    const line = clockReportLine({ platform: 'win32', windowsBias: 420, host: facts(480), view: facts(480), correction: 420 });
    expect(line).toContain('zone not named');
    expect(line).toContain('correction: to UTC-07:00');
    expect(line).toMatch(/Times on screen match Windows\.$/);
  });

  it('only the Chat view off, and ahead: named as such', () => {
    const line = clockReportLine({ platform: 'win32', windowsBias: 420, host: facts(420, 'America/Vancouver'), view: facts(360, 'America/Denver'), correction: undefined });
    expect(line).toMatch(/Times on screen differ: Chat is 60 min ahead of Windows\.$/);
  });

  it('off Windows, or when the bias cannot be read: not compared', () => {
    expect(clockReportLine({ platform: 'linux', windowsBias: undefined, host: facts(0, 'UTC'), view: facts(0, 'UTC'), correction: undefined }))
      .toMatch(/^clock: Windows: not Windows \|.*not compared with Windows\.$/);
    expect(clockReportLine({ platform: 'win32', windowsBias: undefined, host: facts(480), view: facts(480), correction: undefined }))
      .toContain('Windows: its bias could not be read');
  });

  it('logs a line once, and again only when a clock changed', async () => {
    const lines: string[] = [];
    const read = vi.fn(async () => 420);
    const reporter = new ClockReporter((line) => lines.push(line), { platform: 'win32', readWindowsBias: read, host: () => facts(420, 'America/Vancouver'), correction: () => undefined });
    await reporter.report(facts(420, 'America/Vancouver'));
    await reporter.report(facts(420, 'America/Vancouver'));
    await reporter.report(facts(480, 'America/Vancouver'));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Chat is 60 min behind Windows');
  });

  it("reads Windows at each load: a correction kept from before Windows' clock changed is reported, not called a match", async () => {
    // Codex's audit of 093f7d04 (L2): a runtime without the zone, open across a change of Windows' bias from 420 to 480,
    // keeps its process-cached correction of 420. The report must compare with Windows as it is now.
    const lines: string[] = [];
    let windows = 420;
    let runtime = 420;
    const reporter = new ClockReporter((line) => lines.push(line), { platform: 'win32', readWindowsBias: async () => windows, host: () => facts(runtime), correction: () => 420 });
    await reporter.report(facts(runtime));
    windows = 480;
    runtime = 480;
    await reporter.report(facts(runtime));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/Times on screen match Windows\.$/);
    expect(lines[1]).toContain('Windows: UTC-08:00 (ActiveTimeBias 480 min)');
    expect(lines[1]).toMatch(/Times on screen differ: Chat is 60 min ahead of Windows; the message log is 60 min ahead of Windows\.$/);
  });

  it('a failed Windows read is reported as not compared, and a later read compares', async () => {
    const lines: string[] = [];
    const read = vi.fn<() => Promise<number | undefined>>(async () => { throw new Error('reg.exe missing'); });
    const reporter = new ClockReporter((line) => lines.push(line), { platform: 'win32', readWindowsBias: read, host: () => facts(480), correction: () => undefined });
    await reporter.report(facts(480));
    await reporter.report(facts(480));
    read.mockImplementation(async () => 480);
    await reporter.report(facts(480));
    expect(lines).toEqual([expect.stringContaining('Windows: its bias could not be read'), expect.stringMatching(/Times on screen match Windows\.$/)]);
  });

  it('reads the Windows bias only on Windows, and a failed query is undefined', async () => {
    const query = vi.fn(async () => 'HKEY_LOCAL_MACHINE\\SYSTEM\r\n    ActiveTimeBias    REG_DWORD    0x1a4\r\n');
    await expect(readWindowsBias({ platform: 'linux', query })).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    await expect(readWindowsBias({ platform: 'win32', query })).resolves.toBe(420);
    await expect(readWindowsBias({ platform: 'win32', query: async () => { throw new Error('no'); } })).resolves.toBeUndefined();
  });

  it('the Chat view reports its clock once as it loads, and the host passes it on unchanged', () => {
    const source = readFileSync('src/views/ChatViewProvider.ts', 'utf8');
    expect(source).toContain("command: 'clockReport', zone: clockOptions.timeZone || undefined, locale: clockOptions.locale || undefined,");
    expect(source).toContain('offsetMinutes: new Date().getTimezoneOffset(), runtime: engine || undefined,');
    expect(source).toContain("this.deps.onClockReport?.({ zone: msg.zone, locale: msg.locale, offsetMinutes: msg.offsetMinutes, runtime: msg.runtime });");
    expect(readFileSync('src/extension.ts', 'utf8')).toContain('onClockReport: (view) => clockReporter.report(view),');
    // v0.9.104 (Codex's audit of 5ab8dfb0, F3): a changed correction redraws the Message Log's host-drawn times.
    expect(readFileSync('src/extension.ts', 'utf8')).toContain('new ClockReporter((line) => outputChannel.info(line), undefined, () => messageLogProvider?.refresh());');
  });
});

describe('the clock report from the webview is bounded', () => {
  it('accepts a zone, a locale, an offset and an engine', () => {
    expect(parseChatWebviewInboundMessage({ command: 'clockReport', zone: 'America/Vancouver', locale: 'en-CA', offsetMinutes: 420, runtime: 'Chrome/138.0.7204.251, Electron/43.8.6' }))
      .toEqual({ ok: true, message: { command: 'clockReport', zone: 'America/Vancouver', locale: 'en-CA', offsetMinutes: 420, runtime: 'Chrome/138.0.7204.251, Electron/43.8.6' } });
    expect(parseChatWebviewInboundMessage({ command: 'clockReport', zone: undefined, offsetMinutes: -330 }))
      .toEqual({ ok: true, message: { command: 'clockReport', offsetMinutes: -330 } });
  });

  it('refuses a second log line, an offset beyond a day, a fraction and an unknown field', () => {
    for (const bad of [
      { command: 'clockReport', zone: 'America/Vancouver\n[error] forged', offsetMinutes: 420 },
      { command: 'clockReport', runtime: 'x'.repeat(121), offsetMinutes: 420 },
      { command: 'clockReport', offsetMinutes: 1441 },
      { command: 'clockReport', offsetMinutes: 420.5 },
      { command: 'clockReport', offsetMinutes: '420' },
      { command: 'clockReport', offsetMinutes: 420, extra: 1 },
    ]) expect(parseChatWebviewInboundMessage(bad).ok).toBe(false);
  });
});

/** The webview's own functions, cut from the script source as it is emitted. */
function webviewFunction(source: string, name: string): string {
  const at = source.indexOf(`    function ${name}(`);
  expect(at, name).toBeGreaterThan(0);
  return source.slice(at, source.indexOf('\n    }\n', at) + 7);
}

function compiled(file: string): string {
  return ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}

/**
 * The same instant through the footer, a card row and a tool time as the webview script has them, and through the
 * host's message log formatter, in a separate runtime whose zone is `tz`. Each shown time comes back with its stored
 * text.
 */
function renderEverywhere(tz: string, bias: number | null): Array<Record<'stored' | 'footer' | 'card' | 'tool' | 'log', string>> {
  const chat = readFileSync('src/views/ChatViewProvider.ts', 'utf8');
  const zone = bias === null ? 'undefined' : JSON.stringify(`${bias > 0 ? '-' : '+'}${String(Math.floor(Math.abs(bias) / 60)).padStart(2, '0')}:${String(Math.abs(bias) % 60).padStart(2, '0')}`);
  const script = [
    'const exportsOf = (text) => { const module = { exports: {} }; new Function("module", "exports", "require", text)(module, module.exports, require); return module.exports; };',
    `const host = exportsOf(${JSON.stringify(compiled('src/views/systemClock.ts'))});`,
    `const { formatLocalInstant } = exportsOf(${JSON.stringify(compiled('src/views/localInstant.ts'))});`,
    `const SYSTEM_UTC_BIAS = ${JSON.stringify(bias)};`,
    `const SYSTEM_CLOCK_ZONE = ${zone};`,
    webviewFunction(chat, 'onSystemClock'),
    webviewFunction(chat, 'formatTurnFinishedAt'),
    webviewFunction(chat, 'absoluteToolTime'),
    `const rows = ${JSON.stringify(INSTANTS)}.map((stored) => ({`,
    '  stored,',
    '  footer: formatTurnFinishedAt(stored),',
    '  card: formatLocalInstant(stored, undefined, SYSTEM_CLOCK_ZONE),',
    '  tool: absoluteToolTime(stored),',
    // MessageLogProvider: `onSystemClock(m.timestamp).toLocaleTimeString()`, its bias the same one the webview got.
    '  log: host.onSystemClock(stored, SYSTEM_UTC_BIAS === null ? undefined : SYSTEM_UTC_BIAS).toLocaleTimeString(),',
    '}));',
    'process.stdout.write(JSON.stringify(rows));',
  ].join('\n');
  const env = { ...process.env, TZ: tz };
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }));
}

/** The hour and minute a shown time reads, on a 24-hour clock. */
function wallTime(shown: string): string {
  const match = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?/i.exec(shown);
  expect(match, shown).not.toBeNull();
  let hour = Number(match![1]) % 12 + (match![3]?.toLowerCase() === 'p' ? 12 : 0);
  if (!match![3]) hour = Number(match![1]);
  return `${String(hour).padStart(2, '0')}:${match![2]}`;
}

describe('one instant reads the same everywhere it is shown', () => {
  it('a runtime without the zone (UTC-08:00 all year) and Windows at UTC-07:00: every surface shows the Windows clock', () => {
    const rows = renderEverywhere('Etc/GMT+8', 420);
    expect(rows.map((row) => row.stored)).toEqual([...INSTANTS]);
    for (const [row, expected] of rows.map((row, i) => [row, ['01:30', '02:30'][i]] as const)) {
      expect({ footer: wallTime(row.footer), card: wallTime(row.card), tool: wallTime(row.tool), log: wallTime(row.log) })
        .toEqual({ footer: expected, card: expected, tool: expected, log: expected });
    }
  });

  it('a runtime that names America/Vancouver: every surface agrees with that runtime, whichever rules it has', () => {
    const rows = renderEverywhere('America/Vancouver', null);
    expect(rows.map((row) => row.stored)).toEqual([...INSTANTS]);
    for (const row of rows) {
      const own = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      // This runtime's own reading may differ from the child's only if their zone data differ; both are this Node.
      const expected = own.format(new Date(row.stored));
      expect({ footer: wallTime(row.footer), card: wallTime(row.card), tool: wallTime(row.tool), log: wallTime(row.log) })
        .toEqual({ footer: expected, card: expected, tool: expected, log: expected });
    }
  });
});
