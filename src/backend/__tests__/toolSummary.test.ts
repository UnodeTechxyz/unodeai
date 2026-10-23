import { describe, expect, it } from 'vitest';
import {
  externalToolOutcome,
  hostToolFailed,
  hostToolRefused,
  hostToolSucceeded,
  parseToolResultFact,
  providerToolFailed,
  providerToolSucceeded,
  summarizeToolResult,
  summarizeToolUse,
  toolCategory,
  toolFactDisplayKind,
  toolFactSucceeded,
  toolOutcomeFact,
} from '../toolSummary';

// Compile-time contracts (impossible tool-result states) live in ../toolResultFact.typecheck.ts, which `tsc` checks;
// test files are outside the TypeScript project.
describe('v0.9.91 tool result fact', () => {
  it('parses a stored fact only when it is exactly one valid fact', () => {
    expect(parseToolResultFact({ status: 'success', observedBy: 'host' })).toEqual({ status: 'success', observedBy: 'host' });
    expect(parseToolResultFact({ status: 'refused', observedBy: 'host', reason: 'trust' })).toEqual({ status: 'refused', observedBy: 'host', reason: 'trust' });
    expect(parseToolResultFact({ status: 'failed', observedBy: 'provider-protocol', failureKind: 'cancelled' }))
      .toEqual({ status: 'failed', observedBy: 'provider-protocol', failureKind: 'cancelled' });
    // A field from another status makes the record invalid; it is never dropped to leave a fact nobody stated.
    for (const contradictory of [
      { status: 'success', observedBy: 'host', failureKind: 'error' },
      { status: 'success', observedBy: 'host', reason: 'consent' },
      { status: 'refused', observedBy: 'host', reason: 'consent', failureKind: 'error' },
      { status: 'failed', observedBy: 'host', failureKind: 'error', reason: 'scope' },
      { status: 'refused', observedBy: 'provider-protocol', reason: 'consent' },
      { status: 'failed', observedBy: 'host', failureKind: 'blocked' },
      { status: 'success' },
      'success',
    ]) {
      expect(parseToolResultFact(contradictory)).toBeUndefined();
    }
  });

  it('carries a host decision unchanged and observed by the host', () => {
    expect(toolOutcomeFact(hostToolSucceeded('ok'))).toEqual({ status: 'success', observedBy: 'host' });
    expect(toolOutcomeFact(hostToolRefused('Command blocked: not approved by the user', 'consent')))
      .toEqual({ status: 'refused', observedBy: 'host', reason: 'consent' });
    expect(toolOutcomeFact(hostToolFailed('not found', { failureKind: 'outcome_unknown' })))
      .toEqual({ status: 'failed', observedBy: 'host', failureKind: 'outcome_unknown' });
  });

  it('records only the transport status of an external result, whatever its text says', () => {
    expect(toolOutcomeFact(externalToolOutcome('Error: user denied, not found'))).toEqual({ status: 'success', observedBy: 'host' });
    expect(toolOutcomeFact(externalToolOutcome('all good', 'failed')))
      .toEqual({ status: 'failed', observedBy: 'host', failureKind: 'error' });
  });

  it('keeps refusal authority separate from external output provenance', () => {
    expect(hostToolRefused('worker result plus host refusal', 'capability', undefined, {
      contentSource: 'mixed-external',
    })).toMatchObject({
      source: 'host',
      status: 'refused',
      reason: 'capability',
      contentSource: 'mixed-external',
    });
  });

  it('records a native provider result as provider-observed and coarse by default', () => {
    expect(providerToolSucceeded()).toEqual({ status: 'success', observedBy: 'provider-protocol' });
    expect(providerToolFailed()).toEqual({ status: 'failed', observedBy: 'provider-protocol', failureKind: 'error' });
    expect(providerToolFailed('cancelled')).toEqual({ status: 'failed', observedBy: 'provider-protocol', failureKind: 'cancelled' });
  });

  it('projects the card look from the fact alone: a refusal keeps its blocked label', () => {
    expect([toolFactSucceeded(providerToolSucceeded()), toolFactDisplayKind(providerToolSucceeded())]).toEqual([true, undefined]);
    const refused = toolOutcomeFact(hostToolRefused('x', 'safety-limit'));
    expect([toolFactSucceeded(refused), toolFactDisplayKind(refused)]).toEqual([false, 'blocked']);
    expect([toolFactSucceeded(providerToolFailed('not_found')), toolFactDisplayKind(providerToolFailed('not_found'))])
      .toEqual([false, 'not_found']);
  });

  it('summarizes a result with its fact and the same projections', () => {
    const summary = summarizeToolResult('run_command', { command: 'npm test' }, hostToolRefused('Command blocked: denied', 'execution-hook'));
    expect(summary).toMatchObject({
      ok: false,
      failureKind: 'blocked',
      fact: { status: 'refused', observedBy: 'host', reason: 'execution-hook' },
    });
  });
});

describe('toolSummary', () => {

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
