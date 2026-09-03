import { describe, it, expect } from 'vitest';
import { MemoryWriter, WorkspaceTools } from '../WorkspaceTools';

describe('WorkspaceTools memory_note', () => {
  const root = process.cwd();

  function toolsWithMemory(writer?: MemoryWriter): WorkspaceTools {
    return new WorkspaceTools(
      root,
      new Set(),
      'alice',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      writer
    );
  }

  it('exposes memory_note to every agent', () => {
    const tools = new WorkspaceTools(root, new Set());
    expect(tools.specs().some((s) => s.function.name === 'memory_note')).toBe(true);
  });

  it('calls the injected writer and returns its confirmation', async () => {
    const calls: Array<{ agentId: string; note: string; kind: string }> = [];
    const tools = toolsWithMemory(async (agentId, note, kind) => {
      calls.push({ agentId, note, kind });
      return 'Noted.';
    });

    await expect(tools.runText('memory_note', { note: 'Use X, not Y', kind: 'decision', tier: 'premium' })).resolves.toBe('Noted.');
    expect(calls).toEqual([{ agentId: 'alice', note: 'Use X, not Y', kind: 'decision' }]);
    const memorySpec = tools.specs().find((spec) => spec.function.name === 'memory_note')?.function.parameters as any;
    expect(memorySpec.required).toEqual(['note', 'kind']);
    expect(memorySpec.properties).not.toHaveProperty('tier');
  });

  it('validates note is non-empty', async () => {
    const tools = toolsWithMemory(async () => 'should not run');

    await expect(tools.runText('memory_note', { note: '   ', kind: 'pitfall' })).resolves.toBe(
      "Error: memory_note requires a non-empty 'note'."
    );
    await expect(tools.runText('memory_note', { note: 'remember this' })).resolves.toBe(
      'Error: memory_note requires kind to be one of pitfall, contract, or decision.'
    );
  });

  it('degrades gracefully without a writer', async () => {
    const tools = toolsWithMemory();

    await expect(tools.runText('memory_note', { note: 'remember this', kind: 'pitfall' })).resolves.toBe(
      'Shared memory is not available in this context.'
    );
  });
});
