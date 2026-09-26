import { describe, expect, it } from 'vitest';
import { memoryWriterLabel } from '../memoryWriterLabel';

describe('memoryWriterLabel', () => {
  it('shows the agent name while retaining its id', () => {
    expect(memoryWriterLabel('agent-17', 'Reviewer')).toBe('Reviewer (agent-17)');
  });

  it('shows a removed agent id without inventing a name', () => {
    expect(memoryWriterLabel('agent-17')).toBe('agent-17 (removed)');
  });
});
