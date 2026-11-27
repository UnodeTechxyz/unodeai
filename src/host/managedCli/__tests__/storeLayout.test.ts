import { describe, expect, it } from 'vitest';
import { cliStoreReachableFrom, cliStoreRoots, isStoreToken, newStoreToken, resolveCliStoreLocation, type CliStoreLocationFs } from '../storeLayout';

// The design these tests realise: the store is `%LOCALAPPDATA%\UnodeAi\cli-store\`, on a local drive letter, with no
// link or junction anywhere on its physical path, on Windows x64 only; it is refused when any folder an agent may
// write can reach it; store ids and tokens are 128 random bits as 32 lowercase hex digits.

const folders = (existing: Record<string, 'dir' | 'link' | 'file'>, physical: Record<string, string> = {}): CliStoreLocationFs => ({
  lstat: (file) => {
    const kind = existing[file.toLowerCase()];
    if (!kind) return undefined;
    return { isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'dir' };
  },
  realpath: (file) => physical[file.toLowerCase()] ?? file,
});

const ENV = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
const EXISTING = { 'c:': 'dir', 'c:\\users': 'dir', 'c:\\users\\me': 'dir', 'c:\\users\\me\\appdata': 'dir', 'c:\\users\\me\\appdata\\local': 'dir' } as const;

describe('resolveCliStoreLocation', () => {
  it('is %LOCALAPPDATA%\\UnodeAi\\cli-store on Windows x64, before the store folders exist', () => {
    expect(resolveCliStoreLocation(ENV, 'win32', 'x64', folders({ ...EXISTING }))).toEqual({ ok: true, root: 'C:\\Users\\me\\AppData\\Local\\UnodeAi\\cli-store' });
  });

  it('is refused on every other platform and architecture', () => {
    for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64'], ['win32', 'arm64'], ['win32', 'ia32']] as const) {
      expect(resolveCliStoreLocation(ENV, platform, arch, folders({ ...EXISTING }))).toMatchObject({ ok: false, reason: 'unsupported-platform' });
    }
  });

  it.each([
    ['unset', undefined, 'no-local-app-data'],
    ['a UNC path', '\\\\server\\share\\Local', 'not-a-local-drive'],
    ['a device path', '\\\\?\\C:\\Users\\me\\AppData\\Local', 'not-a-local-drive'],
    ['relative', 'Users\\me', 'not-a-local-drive'],
    ['with doubled separators', 'C:\\Users\\\\me', 'not-a-local-drive'],
  ])('refuses LOCALAPPDATA %s', (_label, value, reason) => {
    expect(resolveCliStoreLocation({ LOCALAPPDATA: value }, 'win32', 'x64', folders({ ...EXISTING }))).toMatchObject({ ok: false, reason });
  });

  it('refuses a junction or link anywhere on the path, the store folders included', () => {
    expect(resolveCliStoreLocation(ENV, 'win32', 'x64', folders({ ...EXISTING, 'c:\\users\\me\\appdata': 'link' }))).toMatchObject({ ok: false, reason: 'link-in-path' });
    expect(resolveCliStoreLocation(ENV, 'win32', 'x64', folders({ ...EXISTING, 'c:\\users\\me\\appdata\\local\\unodeai': 'link' }))).toMatchObject({ ok: false, reason: 'link-in-path' });
    expect(resolveCliStoreLocation(ENV, 'win32', 'x64', folders({
      ...EXISTING, 'c:\\users\\me\\appdata\\local\\unodeai': 'dir', 'c:\\users\\me\\appdata\\local\\unodeai\\cli-store': 'link',
    }))).toMatchObject({ ok: false, reason: 'link-in-path' });
  });

  it('refuses a folder whose physical path is somewhere else', () => {
    expect(resolveCliStoreLocation(ENV, 'win32', 'x64', folders({ ...EXISTING }, { 'c:\\users\\me': 'D:\\Profiles\\me' }))).toMatchObject({ ok: false, reason: 'link-in-path' });
  });

  it('accepts the same physical path in another letter case', () => {
    expect(resolveCliStoreLocation(ENV, 'win32', 'x64', folders({ ...EXISTING }, { 'c:\\users\\me': 'C:\\USERS\\ME' }))).toMatchObject({ ok: true });
  });

  it('refuses a file where a folder should be, and an unreadable part', () => {
    expect(resolveCliStoreLocation(ENV, 'win32', 'x64', folders({ ...EXISTING, 'c:\\users\\me\\appdata\\local\\unodeai': 'file' }))).toMatchObject({ ok: false, reason: 'unreadable' });
    const denied: CliStoreLocationFs = { lstat: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, realpath: (file) => file };
    expect(resolveCliStoreLocation(ENV, 'win32', 'x64', denied)).toMatchObject({ ok: false, reason: 'unreadable' });
  });
});

describe('cliStoreRoots', () => {
  it('names the fixed parts of the store', () => {
    const roots = cliStoreRoots('/store');
    expect(roots.suspension.replace(/\\/g, '/')).toBe('/store/managed-suspended.json');
    expect(roots.floor.replace(/\\/g, '/')).toBe('/store/control/authority/floor.bin');
    expect(roots.controlManifests.replace(/\\/g, '/')).toBe('/store/control/manifests');
    expect(roots.instances.replace(/\\/g, '/')).toBe('/store/instances');
    expect(roots.instanceTrash.replace(/\\/g, '/')).toBe('/store/instance-trash');
    expect(roots.work.replace(/\\/g, '/')).toBe('/store/work');
    expect(roots.adoptions.replace(/\\/g, '/')).toBe('/store/adoptions');
  });
});

describe('store tokens', () => {
  it('are 32 lowercase hex digits from 16 random bytes', () => {
    expect(newStoreToken(() => Buffer.alloc(16, 0xab))).toBe('ab'.repeat(16));
    expect(isStoreToken(newStoreToken())).toBe(true);
    expect(isStoreToken('AB'.repeat(16))).toBe(false);
    expect(isStoreToken('ab'.repeat(15))).toBe(false);
    expect(isStoreToken('..\\' + 'a'.repeat(29))).toBe(false);
    expect(() => newStoreToken(() => Buffer.alloc(8))).toThrow();
  });
});

describe('cliStoreReachableFrom', () => {
  const store = 'C:\\Users\\me\\AppData\\Local\\UnodeAi\\cli-store';
  it('is reachable from a write root that contains it, or that lies inside it, in any letter case', () => {
    expect(cliStoreReachableFrom(store, ['C:\\Users\\me'], (file) => file)).toBe(true);
    expect(cliStoreReachableFrom(store, ['c:\\users\\ME\\appdata\\local\\unodeai\\CLI-STORE\\instances'], (file) => file)).toBe(true);
    expect(cliStoreReachableFrom(store, [store], (file) => file)).toBe(true);
  });

  it('is reachable through a write root whose physical path leads into it', () => {
    expect(cliStoreReachableFrom(store, ['D:\\work\\link'], (file) => (file === 'D:\\work\\link' ? `${store}\\work` : file))).toBe(true);
  });

  it('is not reachable from unrelated folders or a sibling with a longer name', () => {
    expect(cliStoreReachableFrom(store, ['D:\\project', 'C:\\Users\\me\\AppData\\Local\\UnodeAi\\cli-store-old'], (file) => file)).toBe(false);
  });
});
