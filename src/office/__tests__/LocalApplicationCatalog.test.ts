import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { temporaryFolder, removeTemporaryFolders } from '../../backend/__tests__/pathSafetyFixtures';
const processState = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => processState.exec(...args) }));
import { LocalApplicationCatalog, registeredOfficeExecutable } from '../LocalApplicationCatalog';
import { resolveHostExecutable } from '../../security/HostExecutableResolver';
afterEach(async () => { vi.clearAllMocks(); await removeTemporaryFolders(); });
const clsid = '{000209FF-0000-0000-C000-000000000046}';
async function fixture() {
  const root = await fs.realpath(await temporaryFolder('unode-app-catalog-')); const word = path.join(root, 'WINWORD.EXE'); const office = path.join(root, 'soffice.exe');
  await fs.writeFile(word, 'owned inert file, never executed'); await fs.writeFile(office, 'owned inert LibreOffice fixture');
  const registry = vi.fn(async (key: string) => key === 'HKCR\\Word.Application\\CLSID' ? clsid
    : key === 'HKCR\\CLSID\\' + clsid + '\\LocalServer32' ? '"C:\\Office\\WINWORD.EXE" /Automation' : undefined);
  const resolve = vi.fn((command: string) => {
    if (command === 'C:\\Office\\WINWORD.EXE' || command === word) return word;
    if (command === 'soffice' || command === office) return office;
    throw Error('fixture program not installed');
  });
  const catalog = new LocalApplicationCatalog({ platform: 'win32', env: {}, resolveExecutable: resolve, registryValue: registry,
    now: () => new Date('2026-11-19T20:00:00Z') });
  return { root, word, office, registry, resolve, catalog };
}
it('detects registration and actual installed bytes without launching applications, and keeps executable paths host-private', async () => {
  const f = await fixture(); expect(f.catalog.current()).toBeUndefined();
  const snapshot = await f.catalog.detect();
  expect(snapshot.applications.find(app => app.id === 'word')).toMatchObject({ installed: true, registration: 'registered', qualification: 'not-run', candidate_operations: ['render-docx-pages', 'export-docx-pdf', 'convert-pdf-docx'] });
  expect(snapshot.applications.find(app => app.id === 'libreoffice')).toMatchObject({ installed: true, qualification: 'not-run' });
  expect(snapshot.applications.find(app => app.id === 'excel')?.candidate_operations).toEqual([]);
  expect(JSON.stringify(snapshot)).not.toContain(f.root); expect(processState.exec).not.toHaveBeenCalled();
  const candidate = await f.catalog.candidate('word'); expect(candidate).toMatchObject({ path: await fs.realpath(f.word), bytes: (await fs.stat(f.word)).size });
  expect(candidate?.sha256).toMatch(/^[0-9a-f]{64}$/);
});
it('rechecks current workspace exclusion even for an unchanged previously detected LibreOffice executable', async () => {
  const f = await fixture(); let workspaceRoots: string[] = [];
  const executable = path.join(f.root, process.platform === 'win32' ? 'soffice.exe' : 'soffice');
  await fs.writeFile(executable, 'inert host executable fixture'); await fs.chmod(executable, 0o755);
  const catalog = new LocalApplicationCatalog({ platform: process.platform, env: {}, registryValue: async () => undefined,
    resolveExecutable: command => resolveHostExecutable(command, { platform: process.platform, env: { PATH: f.root, PATHEXT: '.EXE' }, workspaceRoots }) });
  expect(await catalog.candidate('libreoffice')).toMatchObject({ path: await fs.realpath(executable) });
  workspaceRoots = [f.root];
  expect(await catalog.candidate('libreoffice')).toBeUndefined(); expect(processState.exec).not.toHaveBeenCalled();
});
it('coalesces first detection, returns detached snapshots, and refreshes only on request', async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.catalog.detect(), f.catalog.detect()]);
  const queries = f.registry.mock.calls.length; a.applications[0].installed = false;
  expect(b.applications[0].installed).toBe(true); expect(f.catalog.current()?.applications[0].installed).toBe(true);
  await f.catalog.detect(); expect(f.registry).toHaveBeenCalledTimes(queries);
  await f.catalog.detect(true); expect(f.registry.mock.calls.length).toBeGreaterThan(queries);
  expect(processState.exec).not.toHaveBeenCalled();
});
it('will not bind a changed executable to an operation until explicit re-detection', async () => {
  const f = await fixture(); await f.catalog.detect(); const before = await f.catalog.candidate('word');
  await fs.writeFile(f.word, 'different installed version bytes'); expect(await f.catalog.candidate('word')).toBeUndefined();
  await f.catalog.detect(true); const after = await f.catalog.candidate('word');
  expect(after?.sha256).not.toBe(before?.sha256); expect(after).toBeDefined();
});
it('does not bind a stale COM registration even when the former installed executable is unchanged', async () => {
  const f = await fixture(); await f.catalog.detect(); expect(await f.catalog.candidate('word')).toBeDefined();
  f.registry.mockImplementation(async () => undefined);
  expect(await f.catalog.candidate('word')).toBeUndefined();
  expect(f.catalog.current()?.applications.find(app => app.id === 'word')?.installed).toBe(true);
  await f.catalog.detect(true); expect(f.catalog.current()?.applications.find(app => app.id === 'word')?.installed).toBe(false);
});
it('uses only fixed read-only registry query argv in the default Windows probe', async () => {
  const f = await fixture();
  processState.exec.mockImplementation((_exe: string, args: string[], _options: unknown, done: (error: null, stdout: string) => void) => {
    const value = args[1] === 'HKCR\\Word.Application\\CLSID' ? clsid
      : args[1] === 'HKCR\\CLSID\\' + clsid + '\\LocalServer32' ? '"' + f.word + '" /Automation' : '';
    done(null, value ? '    (Default)    REG_SZ    ' + value + '\r\n' : '');
  });
  const catalog = new LocalApplicationCatalog({ platform: 'win32', env: {}, resolveExecutable: command => {
    if (command === 'reg.exe') return 'C:\\Windows\\System32\\reg.exe';
    if (command === f.word) return f.word; throw Error('not installed');
  } });
  expect((await catalog.detect()).applications.find(app => app.id === 'word')?.registration).toBe('registered');
  // v0.9.108: detection also reads the Office user name with one more fixed read-only query (and the OEM code page only when needed).
  const userName = processState.exec.mock.calls.filter(([, args]) => args[1] === 'HKCU\\Software\\Microsoft\\Office\\Common\\UserInfo');
  expect(userName.map(([exe, args, options]) => [exe, args, options.windowsHide, options.timeout])).toEqual([['C:\\Windows\\System32\\reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Office\\Common\\UserInfo', '/v', 'UserName'], true, 10000]]);
  for (const [exe, args, options] of processState.exec.mock.calls.filter(([, args]) => args[1] !== 'HKCU\\Software\\Microsoft\\Office\\Common\\UserInfo')) {
    expect(exe).toBe('C:\\Windows\\System32\\reg.exe'); expect(args[0]).toBe('query'); expect(args.slice(2)).toEqual(['/ve', expect.stringMatching(/^\/reg:(32|64)$/)]);
    expect(args[1]).toMatch(/^HKCR\\(?:Word\.Application|PowerPoint\.Application|Excel\.Application|CLSID\\\{[0-9a-f-]+\})\\(?:CLSID|LocalServer32)$/i);
    expect(options.windowsHide).toBe(true);
  }
});
it('parses only absolute registry executable paths and never treats switches as executable content', () => {
  expect(registeredOfficeExecutable('"C:\\Program Files\\Office\\WINWORD.EXE" /Automation')).toBe('C:\\Program Files\\Office\\WINWORD.EXE');
  expect(registeredOfficeExecutable('C:\\Office\\WINWORD.EXE /Automation')).toBe('C:\\Office\\WINWORD.EXE');
  expect(registeredOfficeExecutable('WINWORD.EXE /Automation')).toBeUndefined();
  expect(registeredOfficeExecutable('powershell -Command run')).toBeUndefined();
});
