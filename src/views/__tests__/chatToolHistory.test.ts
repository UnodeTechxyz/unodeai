import { describe, expect, it } from 'vitest';
import {
  ChatToolActivity,
  deserializeToolActivities,
  serializeToolActivities,
  CHAT_TOOLS_LIMIT,
} from '../chatToolHistory';

function tool(over: Partial<ChatToolActivity> = {}): ChatToolActivity {
  return {
    kind: 'tool', id: 'tool-1', ts: '2026-06-14T00:00:00.000Z', phase: 'result',
    name: 'write_file', title: 'write_file', summary: 'Wrote 3 bytes', category: 'edit',
    ...over,
  };
}

describe('chatToolHistory serialization', () => {
  it('round-trips a finalized tool card (diff + output preserved)', () => {
    const items = [tool({
      diff: '--- a\n+++ b\n+x', detail: 'exit 0', completedAt: '2026-06-14T00:00:01.400Z',
    })];
    const restored = deserializeToolActivities(serializeToolActivities(items));
    expect(restored).toHaveLength(1);
    expect(restored[0].diff).toContain('+x');
    expect(restored[0].detail).toBe('exit 0');
    expect(restored[0].phase).toBe('result');
    expect(restored[0].completedAt).toBe('2026-06-14T00:00:01.400Z');
  });

  it('drops still-pending (phase "use") cards — never persist a forever-Running card', () => {
    const items = [tool({ id: 'a', phase: 'result' }), tool({ id: 'b', phase: 'use' })];
    const restored = deserializeToolActivities(serializeToolActivities(items));
    expect(restored.map((t) => t.id)).toEqual(['a']);
  });

  it('forces restored cards to a finalized state even if stored as pending', () => {
    // A directly-stored 'use' card (e.g. from an older build) must restore as 'result', not Running.
    const restored = deserializeToolActivities([{ ...tool(), phase: 'use' }]);
    expect(restored[0].phase).toBe('result');
  });

  it('trims to the most recent CHAT_TOOLS_LIMIT', () => {
    const many = Array.from({ length: CHAT_TOOLS_LIMIT + 10 }, (_, i) => tool({ id: `t${i}` }));
    const restored = deserializeToolActivities(serializeToolActivities(many));
    expect(restored).toHaveLength(CHAT_TOOLS_LIMIT);
    expect(restored[restored.length - 1].id).toBe(`t${CHAT_TOOLS_LIMIT + 9}`); // newest kept
  });

  it('rejects junk and non-arrays', () => {
    expect(deserializeToolActivities(undefined)).toEqual([]);
    expect(deserializeToolActivities('nope')).toEqual([]);
    expect(deserializeToolActivities([{ ts: 'x' }, null, 42])).toEqual([]); // no name → dropped
  });

  it('coerces an unknown category to "tool"', () => {
    const restored = deserializeToolActivities([{ ...tool(), category: 'bogus' }]);
    expect(restored[0].category).toBe('tool');
  });

  it('keeps an old finalized card without a completion measurement unknown, not zero', () => {
    const [restored] = deserializeToolActivities([{ ...tool(), completedAt: undefined }]);
    expect(restored.completedAt).toBeUndefined();
  });
});
