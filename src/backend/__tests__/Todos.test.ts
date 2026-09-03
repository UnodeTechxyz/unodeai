import { describe, it, expect } from 'vitest';
import { parseTodos, todoSummary } from '../Todos';

describe('parseTodos', () => {
  it('accepts a raw array of valid items', () => {
    expect(parseTodos([
      { content: 'Build', status: 'completed' },
      { content: 'Test', status: 'in_progress' },
      { content: 'Ship', status: 'pending' },
    ])).toEqual([
      { content: 'Build', status: 'completed' },
      { content: 'Test', status: 'in_progress' },
      { content: 'Ship', status: 'pending' },
    ]);
  });

  it('unwraps a { todos: [...] } payload (the tool-call input shape)', () => {
    expect(parseTodos({ todos: [{ content: 'A', status: 'pending' }] })).toEqual([
      { content: 'A', status: 'pending' },
    ]);
  });

  it('accepts todos delivered as a JSON string (recovered/leaked tool call) — both wrapped and bare', () => {
    // recoverLeakedToolCalls extracts the param as raw text, so todos arrives as a JSON string.
    expect(parseTodos({ todos: '[{"content":"A","status":"in_progress"}]' })).toEqual([
      { content: 'A', status: 'in_progress' },
    ]);
    expect(parseTodos('[{"content":"B","status":"completed"}]')).toEqual([
      { content: 'B', status: 'completed' },
    ]);
  });

  it('trims content and drops items with empty/non-string content', () => {
    expect(parseTodos([
      { content: '  Keep me  ', status: 'pending' },
      { content: '', status: 'pending' },
      { content: '   ', status: 'pending' },
      { status: 'pending' },
      { content: 42, status: 'pending' },
    ])).toEqual([{ content: 'Keep me', status: 'pending' }]);
  });

  it('falls back to pending for unknown/missing status', () => {
    expect(parseTodos([
      { content: 'X', status: 'bogus' },
      { content: 'Y' },
    ])).toEqual([
      { content: 'X', status: 'pending' },
      { content: 'Y', status: 'pending' },
    ]);
  });

  it('returns [] for non-array / non-object / nullish input', () => {
    expect(parseTodos(undefined)).toEqual([]);
    expect(parseTodos(null)).toEqual([]);
    expect(parseTodos('nope')).toEqual([]);
    expect(parseTodos({})).toEqual([]);
    expect(parseTodos([null, 7, 'x'])).toEqual([]);
  });

  it('caps the list at 50 items', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ content: `step ${i}`, status: 'pending' as const }));
    expect(parseTodos(many)).toHaveLength(50);
  });
});

describe('todoSummary', () => {
  it('counts completed over total', () => {
    expect(todoSummary([
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'completed' },
      { content: 'C', status: 'in_progress' },
      { content: 'D', status: 'pending' },
    ])).toBe('2/4 done');
  });

  it('handles an empty list', () => {
    expect(todoSummary([])).toBe('0/0 done');
  });
});
