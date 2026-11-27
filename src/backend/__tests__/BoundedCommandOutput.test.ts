import { describe, expect, it } from 'vitest';
import {
  AnsiStripper,
  BoundedCommandOutput,
  COMMAND_OUTPUT_HEAD_CHARS,
  COMMAND_OUTPUT_MAX_CHARS,
  COMMAND_OUTPUT_TAIL_CHARS,
  omittedOutputMarker,
} from '../BoundedCommandOutput';

function streamed(chunks: string[], head?: number, tail?: number): BoundedCommandOutput {
  const output = new BoundedCommandOutput(head, tail);
  for (const chunk of chunks) output.push(chunk);
  output.finish();
  return output;
}

describe('BoundedCommandOutput (v0.9.96)', () => {
  it('live snapshots keep collecting output and carry split ANSI sequences without flushing them', () => {
    const output = new BoundedCommandOutput();
    output.push('first\x1b[3');
    expect(output.snapshotWithin(100)).toBe('first');
    output.push('2msecond\x1b[0m');
    expect(output.snapshotWithin(100)).toBe('firstsecond');
    output.push('third');
    expect(output.renderWithin(100)).toBe('firstsecondthird');
  });
  it('returns short output unchanged apart from removed ANSI sequences', () => {
    const output = streamed(['\x1b[32mPASS\x1b[0m src/a.test.ts\n', '\x1b]633;D;0\x07done\n']);
    expect(output.renderWithin(COMMAND_OUTPUT_MAX_CHARS)).toBe('PASS src/a.test.ts\ndone\n');
    expect(output.totalChars).toBe('PASS src/a.test.ts\ndone\n'.length);
  });

  it('removes an escape sequence split across two chunks before counting anything', () => {
    const stripper = new AnsiStripper();
    expect(stripper.push('ok \x1b[3')).toBe('ok ');
    expect(stripper.push('1mred\x1b')).toBe('red');
    expect(stripper.push(']633;E;npm test\x07 after')).toBe(' after');
    expect(stripper.flush()).toBe('');
    // A lone escape left at the end of the stream is released, never swallowed silently with following text.
    const output = streamed(['tail \x1b']);
    expect(output.renderWithin(100)).toBe('tail \x1b');
  });

  it('keeps the exact beginning and end of long output, with the omitted count, within the ceiling', () => {
    const lines = Array.from({ length: 5_000 }, (_, i) => `line ${String(i).padStart(4, '0')}\n`);
    const full = lines.join('');
    const output = streamed(lines);
    const rendered = output.renderWithin(COMMAND_OUTPUT_MAX_CHARS);
    expect(rendered.length).toBeLessThanOrEqual(COMMAND_OUTPUT_MAX_CHARS);
    expect(rendered.startsWith('line 0000\nline 0001\n')).toBe(true);
    expect(rendered.endsWith('line 4998\nline 4999\n')).toBe(true);
    const marker = /\n…\[omitted (\d+) characters; showing command output head and tail\]…\n/.exec(rendered);
    expect(marker).not.toBeNull();
    const [before, after] = rendered.split(marker![0]);
    expect(full.startsWith(before)).toBe(true);
    expect(full.endsWith(after)).toBe(true);
    expect(Number(marker![1])).toBe(full.length - before.length - after.length);
    // The head takes the odd unit.
    expect(before.length - after.length).toBeGreaterThanOrEqual(0);
    expect(before.length - after.length).toBeLessThanOrEqual(1);
  });

  it('never holds more than its head and tail, however long the stream runs', () => {
    const output = new BoundedCommandOutput();
    for (let i = 0; i < 2_000; i += 1) output.push('x'.repeat(1_000));
    output.push('THE ERROR AT THE END');
    output.finish();
    expect(output.totalChars).toBe(2_000_000 + 'THE ERROR AT THE END'.length);
    expect(output.droppedChars).toBe(output.totalChars - COMMAND_OUTPUT_HEAD_CHARS - COMMAND_OUTPUT_TAIL_CHARS);
    expect(output.renderWithin(COMMAND_OUTPUT_MAX_CHARS).endsWith('THE ERROR AT THE END')).toBe(true);
  });

  it('renders the same stream within a smaller budget and still shows both ends', () => {
    const full = `${'a'.repeat(9_000)}${'b'.repeat(9_000)}END`;
    for (const budget of [8_000, 4_000]) {
      const rendered = streamed([full]).renderWithin(budget);
      expect(rendered.length, String(budget)).toBeLessThanOrEqual(budget);
      expect(rendered.startsWith('aaaa')).toBe(true);
      expect(rendered.endsWith('bbbEND')).toBe(true);
    }
    // Output that fits whole in the stored head but not in a small budget still shows its own end.
    const short = `${'h'.repeat(3_000)}${'t'.repeat(3_000)}LAST`;
    const rendered = streamed([short]).renderWithin(1_000);
    expect(rendered.startsWith('hhh')).toBe(true);
    expect(rendered.endsWith('tttLAST')).toBe(true);
  });

  it('does not split a surrogate pair at either cut', () => {
    const emoji = '😀';
    const full = emoji.repeat(20_000);
    const rendered = streamed([full]).renderWithin(COMMAND_OUTPUT_MAX_CHARS);
    const [before, after] = rendered.split(/\n…\[omitted \d+ characters; showing command output head and tail\]…\n/);
    expect(before.length % 2).toBe(0);
    expect(after.length % 2).toBe(0);
    expect([...before].every((char) => char === emoji)).toBe(true);
    expect([...after].every((char) => char === emoji)).toBe(true);
  });

  it('says how much it left out in one stable marker', () => {
    expect(omittedOutputMarker(123456)).toBe('…[omitted 123456 characters; showing command output head and tail]…');
  });
});
