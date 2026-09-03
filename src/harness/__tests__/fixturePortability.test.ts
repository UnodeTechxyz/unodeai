import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const P2_RULES_FIXTURE = 'src/harness/fixtures/P2-project-knowledge/.unode/rules.md';

describe('fixture portability', () => {
  it('ships the P2 project-knowledge input that the controlled arm reads', () => {
    expect(existsSync(P2_RULES_FIXTURE)).toBe(true);
    const tracked = execFileSync('git', ['ls-files', '--error-unmatch', P2_RULES_FIXTURE], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    expect(tracked).toBe(P2_RULES_FIXTURE);
  });
});
