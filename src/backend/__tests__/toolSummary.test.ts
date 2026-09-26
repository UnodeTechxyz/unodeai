import { describe, expect, it } from 'vitest';
import { summarizeToolResult, summarizeToolUse, toolCategory, type HostToolOutcome } from '../toolSummary';

describe('toolSummary', () => {
  it('makes a bare host result a compile-time error', () => {
    // @ts-expect-error A host result must state success, refusal, or failure at its producer.
    const invalid: HostToolOutcome = 'Web access denied';
    expect(invalid).toBe('Web access denied');
  });

  it('classifies built-in tools for chat cards', () => {
    expect(toolCategory('read_file')).toBe('read');
    expect(toolCategory('list_dir')).toBe('list');
    expect(summarizeToolUse('list_dir', { path: '.' })).toMatchObject({ category: 'list', title: 'List .' });
    expect(toolCategory('write_file')).toBe('edit');
    expect(toolCategory('apply_edit')).toBe('edit'); // a targeted edit shows as a file edit, not generic tool activity
    expect(toolCategory('apply_patch')).toBe('edit');
    expect(toolCategory('run_command')).toBe('run');
    expect(toolCategory('github__create_pr')).toBe('mcp');
  });

  it('builds a readable pending title', () => {
    expect(summarizeToolUse('write_file', { path: 'src/app.ts' })).toMatchObject({
      category: 'edit',
      title: 'Edit src/app.ts',
    });
  });

  it('marks blocked/error outputs as not ok and caps detail', () => {
    const result = summarizeToolResult('run_command', { command: 'npm test' }, {
      source: 'host',
      contentSource: 'mixed-external',
      status: 'failed',
      failureKind: 'error',
      exitCode: 1,
      output: `Error: ${'x'.repeat(5000)}`,
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Error:');
    expect(result.detail?.length).toBeLessThan(4100);
  });

  it('labels a large Markdown read as a truncated content receipt with an explicit count', () => {
    const output = `# Release notes\n${'x'.repeat(5_000)}`;
    const result = summarizeToolResult('read_file', { path: 'docs/release.md' }, {
      source: 'host', contentSource: 'host', status: 'success', output,
    });

    expect(result.summary).toContain('Markdown content receipt');
    expect(result.summary).toContain('preview truncated by');
    expect(result.detail).toMatch(/\[detail truncated \d+ chars\]$/);
  });

  it('uses the producer refusal fact instead of parsing its wording', () => {
    const result = summarizeToolResult('fetch_url', { url: 'https://example.test' }, {
      source: 'host',
      contentSource: 'host',
      status: 'refused',
      reason: 'consent',
      output: 'Web access denied: test denied',
    });

    expect(result).toMatchObject({ ok: false, failureKind: 'blocked' });
  });

  it('keeps foreign text on an explicitly external transport path', () => {
    const result = summarizeToolResult('server__tool', {}, {
      source: 'external',
      transportStatus: 'success',
      output: 'Error: this text belongs to the remote tool',
    });

    expect(result).toMatchObject({ ok: true, failureKind: undefined });
  });
});
