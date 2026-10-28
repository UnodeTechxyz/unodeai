import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBuilderFormRefreshGate, CoalescedPanelRefresh } from '../PanelRefreshControl';

afterEach(() => {
  vi.useRealTimers();
});

describe('Agent Builder registry refresh safety', () => {
  it('keeps unsaved form state from being replaced by a registry refresh', () => {
    const gate = new AgentBuilderFormRefreshGate();
    const refreshStartedAt = gate.currentRevision;

    gate.markDirty();

    expect(gate.canReplaceHtml(refreshStartedAt)).toBe(false);
    expect(gate.isDirty).toBe(true);
  });

  it('coalesces a direct refresh and watcher echo into one effective render', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const refresh = new CoalescedPanelRefresh(render, 125);

    refresh.request(); // direct mutation reload
    vi.advanceTimersByTime(50);
    refresh.request(); // fs.watch echo reload
    vi.advanceTimersByTime(75);

    expect(render).toHaveBeenCalledTimes(1);
  });
});
