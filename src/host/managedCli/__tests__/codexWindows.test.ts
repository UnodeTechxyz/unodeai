import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodexAppServerArgs } from '../../../backend/CodexSpawnArgs';
import type { InstanceRef } from '../contracts';
import { CODEX_WINDOWS_ENTRYPOINT, managedCodexExecutable } from '../updater/codexWindows';

// ADAPTER §6.1 (the package kept exactly, entrypoint `bin/codex.exe`), §6.3 (self-update disabled without an extra
// override) and §6.4 (the executable is `versions/<key>/bin/codex.exe`; the argv is the existing builder, unchanged).

describe('the managed Codex program on Windows x64', () => {
  it('is bin/codex.exe inside the version folder the instance store names', () => {
    const ref: InstanceRef = { storeId: 'a'.repeat(32), root: path.join(path.sep, 'store', 'instances', 'a'.repeat(32)) };
    const asked: Array<[InstanceRef, string]> = [];
    const instances = {
      versionFolder: (instance: InstanceRef, key: string) => {
        asked.push([instance, key]);
        return path.join(instance.root, 'versions', key);
      },
    };
    const key = '0.164.0-win32-x64-0123456789abcdef';
    expect(CODEX_WINDOWS_ENTRYPOINT).toBe('bin/codex.exe');
    expect(managedCodexExecutable(instances, ref, key)).toBe(path.join(ref.root, 'versions', key, 'bin', 'codex.exe'));
    expect(asked).toEqual([[ref, key]]);
  });

  it('starts nothing and builds no path of its own: it imports only the path module and the store types', () => {
    const source = readFileSync(path.join(__dirname, '..', 'updater', 'codexWindows.ts'), 'utf8');
    const imports = [...source.matchAll(/^import\s.*?from\s+'([^']+)';$/gm)].map((match) => match[1]);
    expect(imports).toEqual(['node:path', '../contracts']);
    expect(source).not.toMatch(/child_process|spawn\(|exec\(|instances[\\/]/);
  });

  // ADAPTER §6.3.3: `-c check_for_update_on_startup=false` is not added; `update` and `daemon` are never in the argv.
  it('keeps the existing App Server argv, with no self-update override and no update or daemon word', () => {
    const args = buildCodexAppServerArgs();
    expect(args.slice(0, 2)).toEqual(['app-server', '--stdio']);
    expect(args.some((arg) => arg.includes('check_for_update_on_startup'))).toBe(false);
    for (const word of ['update', 'daemon', 'login', 'logout', 'install']) expect(args).not.toContain(word);
  });
});
