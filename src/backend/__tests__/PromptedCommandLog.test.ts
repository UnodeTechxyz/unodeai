import { describe, expect, it } from 'vitest';
import { CommandPolicy } from '../CommandPolicy';
import { formatPromptedCommandLog, PromptedCommandLog } from '../PromptedCommandLog';

describe('PromptedCommandLog', () => {
  it('ranks command templates by approval-prompt frequency with a stable tie order', () => {
    const log = new PromptedCommandLog();
    log.record('npm run build');
    log.record('git status');
    log.record('npm run build');
    log.record('git status');
    log.record('cargo test');

    expect(log.ranked()).toEqual([
      { template: 'git status', count: 2 },
      { template: 'npm run build', count: 2 },
      { template: 'cargo test', count: 1 },
    ]);
  });

  it('persists and restores only valid local aggregate rows', () => {
    const original = new PromptedCommandLog();
    original.record('npm run build');
    original.record('npm run build');
    const restored = new PromptedCommandLog();
    restored.restoreFrom({
      ...original.serialize(),
      entries: [...original.serialize().entries, { template: 'bad', count: 0 }],
    });

    expect(restored.ranked()).toEqual([{ template: 'npm run build', count: 2 }]);
  });

  it('records a CommandPolicy template, never a raw command with secret-bearing arguments', () => {
    const raw = 'curl -H "Authorization: Bearer secret-token-value" https://example.test/private';
    const log = new PromptedCommandLog();
    log.record(CommandPolicy.commandTemplate(raw));
    const rendered = formatPromptedCommandLog(log.ranked()).join('\n');

    expect(rendered).toContain('curl');
    expect(rendered).not.toContain('secret-token-value');
    expect(rendered).not.toContain('example.test');
  });

  it('gives an actionable empty report', () => {
    expect(formatPromptedCommandLog([])).toEqual([
      'No command approval prompts have been logged on this machine yet.',
    ]);
  });
});
