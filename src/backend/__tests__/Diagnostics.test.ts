import { describe, it, expect } from 'vitest';
import { formatPostWriteDiagnostics, hasErrors, FileDiagnostic } from '../Diagnostics';

const err = (over: Partial<FileDiagnostic> = {}): FileDiagnostic => ({
  path: 'src/a.ts',
  line: 12,
  severity: 'error',
  message: "Cannot find name 'foo'.",
  source: 'ts',
  ...over,
});

describe('formatPostWriteDiagnostics', () => {
  it('returns empty string when there are no diagnostics', () => {
    expect(formatPostWriteDiagnostics([])).toBe('');
  });

  it('renders errors with path, line, severity and source', () => {
    const block = formatPostWriteDiagnostics([err()]);
    expect(block).toContain('[post-write diagnostics]');
    expect(block).toContain('1 error(s)');
    expect(block).toContain('- src/a.ts:12 error (ts): ');
    expect(block).toContain("Cannot find name 'foo'.");
  });

  it('prioritizes errors and hides warnings when any error exists', () => {
    const block = formatPostWriteDiagnostics([
      err({ message: 'real error' }),
      { path: 'src/a.ts', line: 3, severity: 'warning', message: 'a warning', source: 'eslint' },
    ]);
    expect(block).toContain('real error');
    expect(block).not.toContain('a warning');
    expect(block).toContain('1 error(s)');
  });

  it('shows warnings only when there are no errors', () => {
    const block = formatPostWriteDiagnostics([
      { path: 'src/a.ts', line: 3, severity: 'warning', message: 'just a warning' },
    ]);
    expect(block).toContain('1 warning(s)');
    expect(block).toContain('just a warning');
  });

  it('caps the number of lines and notes the remainder', () => {
    const many = Array.from({ length: 30 }, (_, i) => err({ line: i + 1, message: `e${i}` }));
    const block = formatPostWriteDiagnostics(many);
    expect(block).toContain('… and 10 more');
    // 20 shown lines
    expect(block.match(/- src\/a\.ts:/g)?.length).toBe(20);
  });
});

describe('hasErrors', () => {
  it('is true when an error is present, false for warnings-only or empty', () => {
    expect(hasErrors([err()])).toBe(true);
    expect(hasErrors([{ path: 'x', line: 1, severity: 'warning', message: 'w' }])).toBe(false);
    expect(hasErrors([])).toBe(false);
  });
});
