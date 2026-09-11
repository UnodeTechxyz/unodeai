import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { CodexCliPathFs, resolveCodexCliLaunchPath } from '../codexCliPath';

function fakeFs(directories: Record<string, string[]>, files: string[]): CodexCliPathFs {
  return {
    readDir: (dir) => {
      if (!(dir in directories)) { throw new Error(`missing directory ${dir}`); }
      return directories[dir];
    },
    exists: (file) => files.includes(file),
  };
}

describe('resolveCodexCliLaunchPath', () => {
  it('keeps a native executable explicit and untouched', () => {
    expect(resolveCodexCliLaunchPath('C:/tools/codex.exe', 'win32')).toBe('C:/tools/codex.exe');
  });

  it('resolves the official npm .cmd wrapper to its native binary without using a shell', () => {
    const root = 'C:/Users/test/AppData/Roaming/npm';
    const nodeModules = path.join(root, 'node_modules', '@openai', 'codex', 'node_modules');
    const vendor = path.join(nodeModules, '@openai', 'codex-win32-x64', 'vendor');
    const executable = path.join(vendor, 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    const wrapper = path.join(root, 'codex.cmd');
    const fs = fakeFs({
      [path.join(nodeModules, '@openai')]: ['codex-win32-x64'],
      [vendor]: ['x86_64-pc-windows-msvc'],
    }, [wrapper, executable]);

    expect(resolveCodexCliLaunchPath(wrapper, 'win32', fs)).toBe(executable);
  });

  it('refuses a wrapper whose official native binary cannot be found', () => {
    const wrapper = 'C:/tools/codex.cmd';
    const fs = fakeFs({}, [wrapper]);
    expect(() => resolveCodexCliLaunchPath(wrapper, 'win32', fs))
      .toThrow(/will not launch a \.cmd wrapper through a shell/);
  });

  it('leaves a missing wrapper for the exact configured-path check to reject', () => {
    const fs = fakeFs({}, []);
    expect(resolveCodexCliLaunchPath('C:/missing/codex.cmd', 'win32', fs)).toBe('C:/missing/codex.cmd');
  });
});
