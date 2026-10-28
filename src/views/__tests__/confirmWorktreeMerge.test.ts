import { describe, expect, it, vi } from 'vitest';
const show = vi.hoisted(() => vi.fn());
vi.mock('vscode', () => ({ window: { showWarningMessage: show } }));
import { confirmWorktreeMerge } from '../confirmWorktreeMerge';

describe('manual lane merge confirmation', () => {
  it.each(['enter', 'close', 'cancel', 'not-now', 'merge', 'forged'] as const)('only the explicit affirmative item consents (%s)', async mode => {
    show.mockImplementation(async (_message, _options, ...items) => {
      // VS Code moves a close-affordance item to the cancel slot. Enter chooses the first ordinary item,
      // not the first API argument. This deliberately reproduces the rule that exposed I1.
      const ordinary = items.filter(item => !item.isCloseAffordance);
      const cancel = items.find(item => item.isCloseAffordance);
      const title = (item: any) => typeof item === 'string' ? item : item.title;
      return mode === 'merge' ? items.find(item => title(item) === 'Merge without verification')
        : mode === 'enter' ? ordinary[0] : mode === 'not-now' ? items.find(item => title(item) === 'Not now')
          : mode === 'cancel' ? cancel : mode === 'forged' ? { title: 'Merge without verification' } : undefined;
    });
    const result = await confirmWorktreeMerge({ agentId: 'uuid-dev', agentName: 'Mira — Developer', branch: 'unode/dev', head: 'a'.repeat(40), reason: 'Check not run (disabled).' });
    expect(result).toBe(mode === 'merge');
    const [, options, first, second] = show.mock.calls.at(-1)!;
    expect(options).toMatchObject({ modal: true });
    expect(first).toBe('Not now');
    expect(second).toBe('Merge without verification');
    expect(options.detail).toContain('Agent: Mira — Developer'); expect(options.detail).toContain('Agent ID: uuid-dev');
    expect(options.detail).toContain('Branch: unode/dev');
    expect(options.detail).toContain('Commit: ' + 'a'.repeat(40)); expect(options.detail).toContain('Check not run (disabled).');
    expect(options.detail).toContain('not check evidence');
  });
});
