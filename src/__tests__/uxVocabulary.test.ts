import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function commandTitle(id: string): string | undefined {
  return manifest.contributes.commands.find((entry: { command?: string }) => entry.command === id)?.title;
}

describe('the public UX vocabulary has one meaning per term', () => {
  /**
   * A control is named after what it does. `unode.openWorkbench` opens the Workbench and creates nothing,
   * so calling it "New Task" made the vocabulary less true rather than more — the first pass renamed the
   * label without checking the behaviour (Owner, 2026-08-21). Chat names the transcript view, which is what
   * it is; "New Task" belongs to the act of sending work, not to a surface you navigate to.
   */
  it('names each surface after what it is, and renames no command id', () => {
    expect(commandTitle('unode.openChat')).toBe('UnodeAi: Open Chat');
    expect(commandTitle('unode.chatWithAgent')).toBe('UnodeAi: Open Chat with Agent');
    expect(commandTitle('unode.openWorkbench')).toBe('UnodeAi: Open Workbench');
    expect(commandTitle('unode.openMissionControl')).toBe('UnodeAi: Open Dashboard');

    const transcript = manifest.contributes.views.unode.find((view: { id?: string }) => view.id === 'unode.chat');
    expect(transcript).toMatchObject({ name: 'Chat', contextualTitle: 'UnodeAi Chat' });
  });

  it('keeps retired surface labels out of the current manual and wiki', () => {
    const publicFiles = [
      join(ROOT, 'USAGE.md'),
      ...readdirSync(join(ROOT, 'docs', 'wiki'))
        .filter((name) => name.endsWith('.md') || name.endsWith('.html'))
        .map((name) => join(ROOT, 'docs', 'wiki', name)),
    ];
    // "Mission Control" is the retired surface name. "Open Workbench" and "Open Chat" are not retired —
    // they are what those two commands do, and the manual is allowed to say so.
    const retired = /Mission Control|Show Message Log|Compress Messages View/g;
    const violations = publicFiles.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(retired)].map((match) => `${file.slice(ROOT.length + 1)}: ${match[0]}`);
    });

    expect(violations).toEqual([]);
  });
});
