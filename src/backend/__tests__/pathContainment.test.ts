import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPathInsideOrEqual, isPathStrictlyInside } from '../pathContainment';

describe('path containment by whole segments (v0.9.96)', () => {
  it('counts a child whose name starts with two dots as inside, and only a whole .. segment as outside', () => {
    for (const [pathApi, root, sep] of [[path.win32, 'C:\\repo', '\\'], [path.posix, '/repo', '/']] as const) {
      const at = (...parts: string[]) => [root, ...parts].join(sep);
      expect(isPathInsideOrEqual(root, at('..storage'), pathApi)).toBe(true);
      expect(isPathInsideOrEqual(root, at('..', 'storage'), pathApi)).toBe(false);
      expect(isPathInsideOrEqual(root, at('a', '..', '..storage'), pathApi)).toBe(true);
      expect(isPathInsideOrEqual(root, `${root}-storage`, pathApi)).toBe(false);
      expect(isPathInsideOrEqual(root, root, pathApi)).toBe(true);
      expect(isPathStrictlyInside(root, root, pathApi)).toBe(false);
      expect(isPathStrictlyInside(root, at('..storage', 'x'), pathApi)).toBe(true);
      expect(isPathStrictlyInside(root, at('..'), pathApi)).toBe(false);
    }
    // Windows compares without case, and another drive is outside.
    expect(isPathInsideOrEqual('C:\\Repo', 'c:\\repo\\..cache', path.win32)).toBe(true);
    expect(isPathInsideOrEqual('C:\\repo', 'D:\\repo\\x', path.win32)).toBe(false);
  });
});

/*
 * v0.9.97 P1: every containment site of the file tools, Folder Access, task scopes, the Codex and receipt gates and the
 * context senders now asks these two questions. The design's list, under each platform's own rules: "Allow an
 * authorised child named `..agent` or `..cache`, but never a real `..` parent, sibling `repo-cache`, different
 * drive/share or physical link escape. Windows path case equality must not make an ancestor walk continue above root;
 * POSIX retains case sensitivity. Equal-root acceptance is explicit per caller." (the file-effects design, §5). The
 * links are the sites' own physical checks, tested where each site resolves them.
 */
describe('P1: the containment rule under explicit Windows and POSIX path rules', () => {
  const cases = [
    { name: 'win32', api: path.win32, root: 'C:\\work\\repo', sep: '\\' },
    { name: 'posix', api: path.posix, root: '/work/repo', sep: '/' },
  ] as const;

  for (const { name, api, root, sep } of cases) {
    const at = (...parts: string[]) => [root, ...parts].join(sep);
    const both = (candidate: string) => [isPathInsideOrEqual(root, candidate, api), isPathStrictlyInside(root, candidate, api)];

    it(`${name}: a "..name" child at any depth is inside, inclusively and strictly`, () => {
      for (const child of [at('..agent'), at('..cache', 'x.json'), at('..cache', '..data', 'x'), at('src', '..agent', 'x'), at('...cfg'), at('..cache', '.')]) {
        expect(both(child), child).toEqual([true, true]);
      }
    });

    it(`${name}: the real parent, and any path that climbs out through a "..name" folder, is outside`, () => {
      for (const escape of [at('..'), at('..', 'x'), at('..', '..'), at('..cache', '..', '..'), at('..cache', '..', '..', 'repo-x'), at('a', '..', '..', 'x')]) {
        expect(both(escape), escape).toEqual([false, false]);
      }
      // Climbing back into the root itself is the root: inside or equal, and not strictly inside.
      expect(both(at('..cache', '..'))).toEqual([true, false]);
    });

    it(`${name}: a sibling whose name starts like the root, or like it plus dots, is outside`, () => {
      for (const sibling of [`${root}-cache`, `${root}..cache`, `${root}.d`, `${root}cache`, at('..', 'repo-cache', 'x')]) {
        expect(both(sibling), sibling).toEqual([false, false]);
      }
    });

    it(`${name}: root equality is accepted only by the inclusive question`, () => {
      for (const same of [root, `${root}${sep}`, at('.'), at('src', '..')]) {
        expect(both(same), same).toEqual([true, false]);
      }
    });
  }

  it('win32: another drive, a share and a different case of the same folder', () => {
    const root = 'C:\\work\\repo';
    for (const elsewhere of ['D:\\work\\repo\\x', 'D:\\work\\repo', '\\\\server\\share\\repo\\x', '\\\\server\\share']) {
      expect(isPathInsideOrEqual(root, elsewhere, path.win32), elsewhere).toBe(false);
    }
    // Case does not make a different folder on Windows, in either the root or the child.
    expect(isPathStrictlyInside('C:\\Work\\Repo', 'c:\\work\\repo\\..CACHE\\X.json', path.win32)).toBe(true);
    expect(isPathInsideOrEqual('C:\\Work\\Repo', 'c:\\work\\repo', path.win32)).toBe(true);
    // A case-equal ancestor is still an ancestor: it is above the root, not the root.
    expect(isPathInsideOrEqual('C:\\Work\\Repo', 'c:\\WORK', path.win32)).toBe(false);
    // A share root holds its own children, and nothing of another share.
    expect(isPathStrictlyInside('\\\\server\\share', '\\\\server\\share\\..cache\\x', path.win32)).toBe(true);
    expect(isPathInsideOrEqual('\\\\server\\share', '\\\\server\\other\\x', path.win32)).toBe(false);
  });

  it('posix: case makes a different folder, and another top-level folder is outside', () => {
    expect(isPathInsideOrEqual('/work/repo', '/work/Repo/x', path.posix)).toBe(false);
    expect(isPathInsideOrEqual('/work/Repo', '/work/repo', path.posix)).toBe(false);
    expect(isPathInsideOrEqual('/work/repo', '/other/repo/x', path.posix)).toBe(false);
  });

  it('a drive or filesystem root holds its files', () => {
    expect(isPathStrictlyInside('C:\\', 'C:\\x.txt', path.win32)).toBe(true);
    expect(isPathStrictlyInside('C:\\', 'C:\\..cache\\x.txt', path.win32)).toBe(true);
    expect(isPathInsideOrEqual('C:\\', 'D:\\x.txt', path.win32)).toBe(false);
    expect(isPathStrictlyInside('/', '/x.txt', path.posix)).toBe(true);
    expect(isPathStrictlyInside('/', '/', path.posix)).toBe(false);
  });
});

/*
 * A ratchet, not the evidence: the behaviour of each site is pinned by its own tests. This keeps the first-two-
 * characters test, which reads `..cache` as the parent, out of the shipped containment checks it was removed from.
 * The command guard (CommandPolicy, ShellCommandGate) is being redesigned in its own slice and keeps its checks
 * until then.
 */
describe('P1: no shipped containment check reads a leading ".." as the parent', () => {
  it('finds no `startsWith(\'..\')` in the shipped source outside the command guard', () => {
    const deferred = new Set(['src/backend/CommandPolicy.ts', 'src/backend/ShellCommandGate.ts']);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const relative = path.relative(process.cwd(), full).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !deferred.has(relative)) {
          fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, index) => {
            if (line.includes("startsWith('..')")) offenders.push(`${relative}:${index + 1}`);
          });
        }
      }
    };
    walk(path.join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});
