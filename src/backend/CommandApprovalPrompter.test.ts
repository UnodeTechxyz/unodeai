/**
 * F2: Unit tests for SAFE_COMMAND_PREFIXES and isApprovalNeeded.
 * Imports from CommandPolicy (pure, no vscode dep) so vitest resolves without issue.
 *
 * Run with: npx vitest run --reporter=verbose
 */

import { describe, it, expect } from 'vitest';
import { isApprovalNeeded, SAFE_COMMAND_PREFIXES } from './CommandPolicy';

// ─── isApprovalNeeded ─────────────────────────────────────────────────

describe('isApprovalNeeded', () => {
  it('returns true when mode is none', () => {
    expect(isApprovalNeeded('none')).toBe(true);
  });

  it('returns false when mode is allowlist', () => {
    expect(isApprovalNeeded('allowlist')).toBe(false);
  });

  it('returns false when mode is all', () => {
    expect(isApprovalNeeded('all')).toBe(false);
  });
});

// ─── SAFE_COMMAND_PREFIXES contract ────────────────────────────────────

describe('SAFE_COMMAND_PREFIXES', () => {
  it('contains essential build/test command templates', () => {
    expect(SAFE_COMMAND_PREFIXES).toContain('npm test');
    expect(SAFE_COMMAND_PREFIXES).toContain('npm run build');
    expect(SAFE_COMMAND_PREFIXES).toContain('git status');
    expect(SAFE_COMMAND_PREFIXES).toContain('tsc');
    expect(SAFE_COMMAND_PREFIXES).toContain('eslint');
  });

  it('does NOT seed bare tool names or install/lifecycle that would run arbitrary code', () => {
    // bare "git" → "git reset --hard"; "node"/"python" = arbitrary code; bare "npm run" = any script;
    // install/ci run lifecycle scripts = arbitrary code. All must go to 'ask', not be pre-seeded.
    expect(SAFE_COMMAND_PREFIXES).not.toContain('git');
    expect(SAFE_COMMAND_PREFIXES).not.toContain('node');
    expect(SAFE_COMMAND_PREFIXES).not.toContain('python');
    expect(SAFE_COMMAND_PREFIXES).not.toContain('npm run');
    expect(SAFE_COMMAND_PREFIXES).not.toContain('npm install');
    expect(SAFE_COMMAND_PREFIXES).not.toContain('npm ci');
  });

  it('every prefix is lowercase', () => {
    for (const prefix of SAFE_COMMAND_PREFIXES) {
      expect(prefix).toBe(prefix.toLowerCase());
    }
  });

  it('every prefix is trimmed (no leading/trailing whitespace)', () => {
    for (const prefix of SAFE_COMMAND_PREFIXES) {
      expect(prefix).toBe(prefix.trim());
    }
  });

  it('no empty strings', () => {
    for (const prefix of SAFE_COMMAND_PREFIXES) {
      expect(prefix.length).toBeGreaterThan(0);
    }
  });

  it('no duplicates', () => {
    const seen = new Set<string>();
    for (const prefix of SAFE_COMMAND_PREFIXES) {
      expect(seen.has(prefix)).toBe(false);
      seen.add(prefix);
    }
  });
});
