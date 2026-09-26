import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { formatProjectKnowledgeIndex, indexSummary, ProjectKnowledge } from '../ProjectKnowledge';

describe('ProjectKnowledge (P1)', () => {
  it('indexes structured docs without injecting their full bodies, and points to read_file on demand', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-project-knowledge-'));
    try {
      await fs.mkdir(path.join(root, 'docs', 'guide'), { recursive: true });
      await fs.writeFile(path.join(root, 'docs', 'guide', 'workflow.md'), '# Workflow\n\nUse the release checklist before publishing.\n' + 'x'.repeat(2_000), 'utf8');
      await fs.writeFile(path.join(root, 'docs', 'ignore.txt'), 'not indexed', 'utf8');
      const knowledge = new ProjectKnowledge(root);

      await knowledge.load();

      expect(knowledge.snapshot()).toHaveLength(1);
      expect(knowledge.snapshot()[0]).toMatchObject({ relativePath: 'docs/guide/workflow.md' });
      const prompt = knowledge.promptBlock();
      expect(prompt).toContain('Structured docs are indexed, not loaded whole');
      expect(prompt).toContain('`read_file`');
      expect(prompt).toContain('docs/guide/workflow.md');
      expect(prompt).not.toContain('x'.repeat(2_000));
      expect(prompt).toContain('do not change the fixed precedence');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('uses deterministic headings and excerpts rather than a semantic model summary', () => {
    expect(indexSummary('# First\n\nRead this source first.\n## Second')).toBe('Headings: First / Second. Excerpt: Read this source first.');
    expect(formatProjectKnowledgeIndex([{ relativePath: 'docs/a.md', bytes: 10, summary: 'Headings: A' }]))
      .toContain('`docs/a.md` (10 bytes) — Headings: A');
  });
});
