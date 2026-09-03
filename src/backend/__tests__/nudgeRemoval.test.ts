import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('v0.9.68 nudge removal', () => {
  it('has no model-prose continuation detector or completion nudge path in either backend', () => {
    const root = process.cwd();
    const openAi = readFileSync(join(root, 'src/backend/OpenAICompatBackend.ts'), 'utf8');
    const claude = readFileSync(join(root, 'src/backend/ClaudeHeadlessBackend.ts'), 'utf8');
    const forbidden = /looksLikeAnnouncedAction|looksLikeToolDistrustRefusal|looksLikeWorkRequest|verificationNudge|noToolActionNudge|coordinatorCloseoutNudge/;

    expect(existsSync(join(root, 'src/backend/announcedAction.ts'))).toBe(false);
    expect(openAi).not.toMatch(forbidden);
    expect(claude).not.toMatch(forbidden);
  });
});
