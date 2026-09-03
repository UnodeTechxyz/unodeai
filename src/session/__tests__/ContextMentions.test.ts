import { describe, expect, it } from 'vitest';
import * as path from 'path';
import {
  DirectoryEntry,
  DirectoryReader,
  expandContextMentions,
  PathStat,
} from '../ContextMentions';
import { FileReader, RealPathResolver } from '../FileMentions';

const root = path.resolve('/repo');

function reader(files: Record<string, string>): FileReader {
  return async (absPath: string) => {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    if (rel in files) return files[rel];
    throw new Error('ENOENT');
  };
}

function realpathWith(links: Record<string, string> = {}): RealPathResolver {
  return async (absPath: string) => {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    if (rel === '') return root;
    if (rel in links) return links[rel];
    return absPath;
  };
}

function statWith(dirs: string[]): PathStat {
  const set = new Set(dirs);
  return async (absPath: string) => {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    return {
      isDirectory: () => set.has(rel),
      isFile: () => !set.has(rel),
    };
  };
}

function dirent(name: string, dir = false): DirectoryEntry {
  return { name, isDirectory: () => dir, isFile: () => !dir };
}

function readdirWith(tree: Record<string, DirectoryEntry[]>): DirectoryReader {
  return async (absPath: string) => {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    return tree[rel] ?? [];
  };
}

describe('expandContextMentions', () => {
  it('preserves @file behavior and adds a folder tree for @folder', async () => {
    const out = await expandContextMentions('check @src/a.ts and @src/views', root, {
      readFile: reader({ 'src/a.ts': 'export const x = 1;' }),
      realpath: realpathWith(),
      stat: statWith(['src/views']),
      readDir: readdirWith({
        'src/views': [dirent('ChatViewProvider.ts'), dirent('nested', true), dirent('node_modules', true)],
        'src/views/nested': [dirent('Thing.ts')],
      }),
    });

    expect(out).toContain('<attached_files>');
    expect(out).toContain('--- src/a.ts ---');
    expect(out).toContain('export const x = 1;');
    expect(out).toContain('<attached_context>');
    expect(out).toContain('--- @src/views (folder) ---');
    expect(out).toContain('src/views/ChatViewProvider.ts');
    expect(out).toContain('src/views/nested/Thing.ts');
    expect(out).not.toContain('node_modules');
  });

  it('formats @problems with errors first and a none state', async () => {
    const out = await expandContextMentions('fix @problems', root, {
      readFile: reader({}),
      realpath: realpathWith(),
      diagnostics: () => ({
        items: [
          { file: 'src/b.ts', line: 2, col: 3, severity: 'warning', message: 'careful' },
          { file: 'src/a.ts', line: 1, col: 1, severity: 'error', message: 'Cannot find name x', code: 'TS2304' },
        ],
      }),
    });

    expect(out).toContain('--- @problems (1 errors, 1 warnings) ---');
    expect(out.indexOf('src/a.ts:1:1 error TS2304')).toBeLessThan(out.indexOf('src/b.ts:2:3 warning'));

    const none = await expandContextMentions('check @problems', root, {
      readFile: reader({}),
      realpath: realpathWith(),
      diagnostics: () => ({ items: [] }),
    });
    expect(none).toContain('--- @problems --- (none)');
  });

  it('fetches and truncates @url text through an injected reader', async () => {
    const out = await expandContextMentions('read @https://example.com/page', root, {
      readFile: reader({}),
      realpath: realpathWith(),
      fetchText: async () => ({ ok: true, text: `<h1>${'x'.repeat(25_000)}</h1>` }),
    });

    expect(out).toContain('--- @https://example.com/page (url) ---');
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(21_000);
  });

  it('silently skips failed urls, path traversal, and non-path @teammate mentions', async () => {
    const out = await expandContextMentions('hey @reviewer see @../../etc/passwd and @https://bad.example', root, {
      readFile: reader({}),
      realpath: realpathWith(),
      fetchText: async () => ({ ok: false, text: 'nope' }),
    });

    expect(out).toBe('hey @reviewer see @../../etc/passwd and @https://bad.example');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('<attached_context>');
  });

  it('does not treat @problems or @url mentions as local files', async () => {
    const out = await expandContextMentions('check @problems and @https://example.com/x', root, {
      readFile: async () => 'SECRET',
      realpath: realpathWith(),
      diagnostics: () => ({ items: [] }),
      fetchText: async () => ({ ok: false, text: 'nope' }),
    });

    expect(out).toContain('--- @problems --- (none)');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('<attached_files>');
  });

  it('blocks folder symlinks that resolve outside the workspace', async () => {
    const out = await expandContextMentions('list @linked', root, {
      readFile: reader({}),
      realpath: realpathWith({ linked: path.resolve('/outside') }),
      stat: statWith(['linked']),
      readDir: readdirWith({ linked: [dirent('secret.txt')] }),
    });

    expect(out).toBe('list @linked');
    expect(out).not.toContain('secret.txt');
  });
});
