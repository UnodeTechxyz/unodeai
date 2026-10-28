import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionTypeScriptFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('workspaceState root boundary', () => {
  it('keeps every raw workspaceState access at the scoped adapter or the one global UI preference', () => {
    const src = path.resolve(process.cwd(), 'src');
    const accesses = productionTypeScriptFiles(src).flatMap((file) => {
      const relative = path.relative(process.cwd(), file).replace(/\\/g, '/');
      return readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, index) =>
        line.includes('context.workspaceState') ? [`${relative}:${index + 1}:${line.trim()}`] : [],
      );
    });

    expect(accesses).toHaveLength(4);
    expect(accesses.filter((line) => line.includes('RootScopedWorkspaceState'))).toHaveLength(0);
    expect(accesses.some((line) => line.includes('context.workspaceState,'))).toBe(true);
    expect(accesses.some((line) => line.includes('workspaceState ?? context.workspaceState'))).toBe(true);
    expect(accesses.filter((line) => line.includes('WORKBENCH_INSPECTOR_KEY'))).toHaveLength(2);
    expect(accesses.join('\n')).not.toMatch(/roam\.|approvedMcp|checkpoints|executionHooks|teamPolicy|onboarding/i);
  });

  // Until v0.9.96 this pinned the defect: every restore read the recorded path against the first workspace folder.
  // The behaviour (the file the change was recorded for, under the authority of now) is in checkpointRestoreFlow.test.ts;
  // this keeps the one restore path from growing a write of its own beside the checked one.
  it('writes a checkpoint restore only through the checked restore, after it is prepared again at commit', () => {
    const extension = readFileSync(path.resolve(process.cwd(), 'src', 'extension.ts'), 'utf8');
    expect(extension).not.toContain('resolveInsideRootPhysical(workspaceRoot(), relativePath)');
    const restore = /async function restoreCheckpoint\([\s\S]*?\n\}/.exec(extension)?.[0] ?? '';
    expect(restore).not.toMatch(/fs\.(?:writeFile|rm|unlink|rename)\(/);
    expect(restore.indexOf('await prepareCheckpointRestore(')).toBeGreaterThan(-1);
    expect(restore.indexOf('await prepareCheckpointRestore(')).toBeLessThan(restore.indexOf('showWarningMessage('));
    expect(restore.indexOf('showWarningMessage(')).toBeLessThan(restore.indexOf('await commitCheckpointRestore('));
  });
});
