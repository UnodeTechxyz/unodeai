import { describe, it, expect } from 'vitest';
import { buildEvidenceReport, evidenceVerdict, EvidenceInput } from '../evidenceReport';

const base: EvidenceInput = {
  goal: 'Add password reset',
  coordinatorName: 'PM',
  agents: [
    { agentName: 'Senior Dev', task: 'implement reset route', status: 'done', result: 'added route + tests', retries: 1 },
    { agentName: 'Reviewer', task: 'review the change', status: 'done', result: 'PASS' },
  ],
  filesChanged: ['src/auth/reset.ts', 'src/auth/reset.test.ts'],
  checks: { command: 'npm test', passed: true },
  verified: true,
};

describe('evidenceVerdict', () => {
  it('ranks blocked > unverified > verified (most severe wins)', () => {
    expect(evidenceVerdict({ verified: true })).toBe('verified');
    expect(evidenceVerdict({ verified: false })).toBe('unverified');
    expect(evidenceVerdict({ verified: true, blocked: true })).toBe('blocked');
    expect(evidenceVerdict({ verified: false, blocked: true })).toBe('blocked');
  });
});

describe('buildEvidenceReport', () => {
  it('renders a verified report with crew, work, files, and a passing check', () => {
    const md = buildEvidenceReport(base);
    expect(md).toContain('# Evidence Report — Add password reset');
    expect(md).toContain('✅ Verified');
    expect(md).toContain('PM + 2 teammates');
    expect(md).toContain('**Senior Dev**: implement reset route — added route + tests _(after 1 fix cycle)_');
    expect(md).toContain('## Files changed (2)');
    expect(md).toContain('`src/auth/reset.ts`');
    expect(md).toContain('`npm test` → ✅ passed');
    expect(md).not.toContain('## Open items'); // verified ⇒ no open items
  });

  it('shows a failing check with its output and an open-items section when unverified', () => {
    const md = buildEvidenceReport({
      ...base,
      verified: false,
      checks: { command: 'npm test', passed: false, outputTail: 'FAIL src/auth/reset.test.ts' },
    });
    expect(md).toContain('⚠ Unverified');
    expect(md).toContain('`npm test` → ❌ failed');
    expect(md).toContain('FAIL src/auth/reset.test.ts');
    expect(md).toContain('## Open items');
  });

  it('renders a blocked verdict with the human-handoff guidance', () => {
    const md = buildEvidenceReport({ ...base, verified: false, blocked: true });
    expect(md).toContain('🚧 Blocked');
    expect(md).toMatch(/retry with a stronger model/i);
  });

  it('handles an empty/no-op run gracefully', () => {
    const md = buildEvidenceReport({ goal: 'look into X', agents: [], filesChanged: [], verified: true });
    expect(md).toContain('_No delegated work recorded._');
    expect(md).toContain('## Files changed (0)');
    expect(md).toContain('_No files were modified._');
    expect(md).toContain('No verification command was configured');
  });

  it('truncates long task/result lines and computes duration', () => {
    const md = buildEvidenceReport({
      ...base,
      startedAt: '2026-06-17T10:00:00Z',
      completedAt: '2026-06-17T10:01:30Z',
      agents: [{ agentName: 'Dev', task: 'x'.repeat(300), status: 'working' }],
    });
    expect(md).toContain('Duration:** 1m 30s');
    expect(md).toContain('⏳ **Dev**');
    expect(md).toContain('…'); // long task line trimmed
  });
});
