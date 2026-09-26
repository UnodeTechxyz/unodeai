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

  it('re-resolves every checkpoint restore against the current bound root at write time', () => {
    const extension = readFileSync(path.resolve(process.cwd(), 'src', 'extension.ts'), 'utf8');
    expect(extension).toContain('return resolveInsideRootPhysical(workspaceRoot(), relativePath);');
    const restore = /async function restoreCheckpoint\([\s\S]*?\n\}/.exec(extension)?.[0] ?? '';
    expect(restore).toContain('await resolveInsideWorkspace(c.path)');
    expect(restore.indexOf('await resolveInsideWorkspace(c.path)')).toBeLessThan(restore.indexOf('await fs.writeFile(abs'));
    expect(restore.indexOf('await resolveInsideWorkspace(c.path)')).toBeLessThan(restore.indexOf('await fs.rm(abs'));
  });
});
