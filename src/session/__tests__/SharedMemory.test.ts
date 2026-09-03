import { describe, it, expect } from 'vitest';
import { SharedMemory, memoryFilePath, oneLine } from '../SharedMemory';

describe('SharedMemory', () => {
  it('appends a timestamped one-line note with host tier and agent-selected kind', async () => {
    const appends: Array<{ file: string; content: string }> = [];
    const mkdirs: string[] = [];
    const sm = new SharedMemory(
      '/ws/.unode/memory/notes.md',
      async () => '',
      async (file, content) => { appends.push({ file, content }); },
      async (dir) => { mkdirs.push(dir); }
    );

    await sm.append('agent-a', 'first line\nsecond line', 'economy', 'contract');

    expect(mkdirs[0]).toMatch(/[\\/]ws[\\/]\.unode[\\/]memory$/);
    expect(appends).toHaveLength(1);
    expect(appends[0].file).toBe('/ws/.unode/memory/notes.md');
    expect(appends[0].content).toMatch(/^- \[\d{4}-\d{2}-\d{2}T.*Z\] \[agent-a\] \[economy\] \[contract\] first line second line\n$/);
  });

  it('loads empty string when the file is missing or unreadable', async () => {
    const sm = new SharedMemory('/ws/.unode/memory/notes.md', async () => { throw new Error('ENOENT'); });

    await expect(sm.load()).resolves.toBe('');
    expect(sm.block()).toBe('');
  });

  it('wraps the most recent notes and returns empty for no content', async () => {
    const sm = new SharedMemory(
      '/ws/.unode/memory/notes.md',
      async () => [
        '- [2026-01-01T00:00:00.000Z] [a] one',
        '- [2026-01-02T00:00:00.000Z] [b] two',
        '- [2026-01-03T00:00:00.000Z] [c] three',
      ].join('\n')
    );

    expect(sm.block()).toBe('');
    await sm.load();
    expect(sm.block(0)).toBe('');
    expect(sm.block(2)).toBe(
      '\n\n<shared_memory>\n' +
      '- [2026-01-02T00:00:00.000Z] [b] [unknown] [unknown] two\n' +
      '- [2026-01-03T00:00:00.000Z] [c] [unknown] [unknown] three\n' +
      '</shared_memory>'
    );
  });

  it('retains contracts before newer pitfall and decision notes without inferring kind from text', async () => {
    const sm = new SharedMemory(
      '/ws/.unode/memory/notes.md',
      async () => [
        '- [2026-01-01T00:00:00.000Z] [a] [economy] [contract] Old interface boundary',
        '- [2026-01-02T00:00:00.000Z] [b] [premium] [pitfall] newest workaround',
        '- [2026-01-03T00:00:00.000Z] [c] [standard] [decision] pitfall appears only in this text',
      ].join('\n')
    );

    await sm.load();
    const block = sm.block(2);
    expect(block).toContain('[economy] [contract] Old interface boundary');
    expect(block).toContain('[standard] [decision] pitfall appears only in this text');
    expect(block).not.toContain('newest workaround');
    expect(block).toContain('[decision]');
  });

  it('keeps the default injected memory block bounded to thirty notes', async () => {
    const sm = new SharedMemory(
      '/ws/.unode/memory/notes.md',
      async () => Array.from({ length: 35 }, (_, index) =>
        `- [2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z] [a] [standard] [decision] note-${index + 1}`
      ).join('\n')
    );

    await sm.load();
    const block = sm.block();
    expect((block.match(/^- /gm) ?? [])).toHaveLength(30);
    expect(block).not.toContain('note-5');
    expect(block).toContain('note-35');
  });

  it('returns false (not throw) when append IO fails, true on success', async () => {
    const failing = new SharedMemory(
      '/ws/.unode/memory/notes.md',
      async () => '',
      async () => { throw new Error('EACCES'); },
      async () => undefined
    );
    await expect(failing.append('agent-a', 'note', 'standard', 'decision')).resolves.toBe(false);

    const ok = new SharedMemory('/ws/.unode/memory/notes.md', async () => '', async () => undefined, async () => undefined);
    await expect(ok.append('agent-a', 'note', 'standard', 'decision')).resolves.toBe(true);
    await expect(ok.append('agent-a', 'note', 'standard', 'not-a-kind' as never)).resolves.toBe(false);
  });

  it('builds the memory path under .unode/memory', () => {
    expect(memoryFilePath('/ws')).toMatch(/[\\/]ws[\\/]\.unode[\\/]memory[\\/]notes\.md$/);
  });

  it('collapses text to one line', () => {
    expect(oneLine('  alpha\n\tbeta   gamma  ')).toBe('alpha beta gamma');
  });
});
