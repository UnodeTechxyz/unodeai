import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveHostExecutable } from '../security/HostExecutableResolver';

export type LocalApplicationId = 'word' | 'powerpoint' | 'excel' | 'libreoffice' | 'pandoc' | 'windows-pdf';
export interface LocalApplicationFact {
  id: LocalApplicationId; name: string; installed: boolean;
  registration: 'registered' | 'file-only' | 'not-required' | 'not-found';
  qualification: 'not-run'; candidate_operations: string[];
}
export interface LocalApplicationSnapshot {
  version: 1; detected_at: string; platform: NodeJS.Platform; applications: LocalApplicationFact[];
  scope: string;
}
export interface LocalApplicationIdentity { path: string; sha256: string; bytes: number }
export interface LocalApplicationCandidate extends LocalApplicationIdentity { id: LocalApplicationId }
interface CatalogPorts {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv;
  resolveExecutable?: (command: string) => string;
  /** Only fixed HKCR COM keys and 32/64 registry views are passed, never model/document arguments. */
  registryValue?: (key: string, view: '32' | '64') => Promise<string | undefined>;
  /** The Office user name (HKCU Office Common UserInfo), read only inside detection. */
  officeUserName?: () => Promise<string | undefined>;
  now?: () => Date;
}
const OFFICE_USER_INFO = 'HKCU\\Software\\Microsoft\\Office\\Common\\UserInfo';
const CODE_PAGE = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage';
const decoders: Record<string, string> = { '936': 'gbk', '950': 'big5', '932': 'shift_jis', '949': 'euc-kr', '866': 'ibm866', '1252': 'windows-1252', '65001': 'utf-8' };
/** The value text of one `reg query <key> /v <name>` line; a non-UTF-8 output is decoded with the console OEM code page when known. */
export function registryQueryValue(output: Buffer, name: string, oemCodePage?: string): string | undefined {
  let text: string | undefined;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(output); }
  catch { const label = oemCodePage ? decoders[oemCodePage] : undefined; if (!label) return undefined; try { text = new TextDecoder(label, { fatal: true }).decode(output); } catch { return undefined; } }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s+REG_(?:SZ|EXPAND_SZ)\\s+([^\\r\\n]*?)\\s*$`, 'm').exec(text)?.[1];
}
const definitions: Array<{ id: LocalApplicationId; name: string; executable: string; progId?: string; operations: string[] }> = [
  { id: 'word', name: 'Microsoft Word', executable: 'WINWORD.EXE', progId: 'Word.Application', operations: ['render-docx-pages', 'export-docx-pdf', 'convert-pdf-docx'] },
  { id: 'powerpoint', name: 'Microsoft PowerPoint', executable: 'POWERPNT.EXE', progId: 'PowerPoint.Application', operations: ['render-pptx-pages', 'export-pptx-pdf'] },
  { id: 'excel', name: 'Microsoft Excel', executable: 'EXCEL.EXE', progId: 'Excel.Application', operations: [] },
  { id: 'libreoffice', name: 'LibreOffice', executable: 'soffice', operations: ['render-docx-pages', 'render-pptx-pages', 'export-docx-pdf', 'export-pptx-pdf'] },
  { id: 'pandoc', name: 'pandoc', executable: 'pandoc', operations: [] },
];
export function registeredOfficeExecutable(value: string): string | undefined {
  const match = /^\s*(?:"([^"]+\.exe)"|([^"\r\n]+?\.exe))(?:\s|$)/i.exec(value);
  const file = match?.[1] ?? match?.[2];
  return file && path.win32.isAbsolute(file) ? file : undefined;
}
/** Hash actual installed bytes without starting the application or retaining the executable in memory. */
async function fileIdentity(file: string): Promise<LocalApplicationIdentity> {
  const physical = await realpath(file); const before = await stat(physical);
  if (!before.isFile()) throw Error('not-file');
  const hash = createHash('sha256'); for await (const bytes of createReadStream(physical)) hash.update(bytes);
  const after = await stat(physical);
  if (await realpath(file) !== physical || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('application-changed');
  return { path: physical, sha256: hash.digest('hex'), bytes: after.size };
}
/** Detection is a read-only snapshot, never an app launch, native operation PASS, installation or scheduled job. */
export class LocalApplicationCatalog {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolve: (command: string) => string;
  private readonly candidates = new Map<LocalApplicationId, LocalApplicationCandidate>();
  private snapshot?: LocalApplicationSnapshot;
  private pending?: Promise<LocalApplicationSnapshot>;
  private officeUser?: string;
  constructor(private readonly ports: CatalogPorts = {}) {
    this.platform = ports.platform ?? process.platform; this.env = ports.env ?? process.env;
    this.resolve = ports.resolveExecutable ?? (command => resolveHostExecutable(command, { env: this.env, platform: this.platform }));
  }
  current(): LocalApplicationSnapshot | undefined { return this.snapshot ? structuredClone(this.snapshot) : undefined; }
  /** The Word user name cached by the last detection; never starts a query. Undefined when not detected or not on Windows. */
  wordUserName(): string | undefined { return this.officeUser; }
  async detect(refresh = false): Promise<LocalApplicationSnapshot> {
    if (this.pending) return structuredClone(await this.pending);
    if (this.snapshot && !refresh) return structuredClone(this.snapshot);
    this.pending = this.probe();
    try { this.snapshot = await this.pending; return structuredClone(this.snapshot); }
    finally { this.pending = undefined; }
  }
  /** Host-only operation binding; a model never supplies an executable path. Re-check before a later effect. */
  async candidate(id: LocalApplicationId): Promise<LocalApplicationCandidate | undefined> {
    await this.detect(); const found = this.candidates.get(id); if (!found) return undefined;
    try {
      const current = await fileIdentity(this.resolve(found.path));
      if (current.path !== found.path || current.sha256 !== found.sha256) return undefined;
      const definition = definitions.find(item => item.id === id);
      if (this.platform === 'win32' && definition?.progId
        && await this.registered(definition.progId, definition.executable) !== found.path) return undefined;
      return { ...found };
    }
    catch { return undefined; }
  }
  private async registryValue(key: string, view: '32' | '64'): Promise<string | undefined> {
    if (this.ports.registryValue) return this.ports.registryValue(key, view);
    const executable = this.resolve('reg.exe');
    return await new Promise(resolve => {
      execFile(executable, ['query', key, '/ve', '/reg:' + view], { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
        resolve(error ? undefined : /\bREG_(?:SZ|EXPAND_SZ)\s+([^\r\n]+)/.exec(stdout)?.[1]?.trim());
      });
    });
  }
  /** Fixed read-only `reg query` of the Office user name, without a shell and with a time limit. */
  private async officeUserName(): Promise<string | undefined> {
    if (this.ports.officeUserName) return this.ports.officeUserName();
    const executable = this.resolve('reg.exe');
    const query = (key: string, name: string) => new Promise<Buffer | undefined>(resolve => execFile(executable, ['query', key, '/v', name],
      { windowsHide: true, encoding: 'buffer', timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout)));
    const output = await query(OFFICE_USER_INFO, 'UserName'); if (!output) return undefined;
    const direct = registryQueryValue(output, 'UserName'); if (direct !== undefined) return direct;
    const codePage = await query(CODE_PAGE, 'OEMCP');
    return registryQueryValue(output, 'UserName', codePage ? registryQueryValue(codePage, 'OEMCP') : undefined);
  }
  private async registered(progId: string, basename: string): Promise<string | undefined> {
    for (const view of ['64', '32'] as const) {
      const clsid = await this.registryValue('HKCR\\' + progId + '\\CLSID', view);
      if (!clsid || !/^\{[0-9a-f-]{36}\}$/i.test(clsid)) continue;
      const value = await this.registryValue('HKCR\\CLSID\\' + clsid + '\\LocalServer32', view);
      const executable = value && registeredOfficeExecutable(value);
      if (executable && path.win32.basename(executable).toLowerCase() === basename.toLowerCase()) {
        try { return this.resolve(executable); } catch { /* Only real host installations are candidates. */ }
      }
    }
    return undefined;
  }
  private async probe(): Promise<LocalApplicationSnapshot> {
    const detected = new Map<LocalApplicationId, LocalApplicationCandidate>();
    const applications = await Promise.all(definitions.map(async definition => {
      let registered: string | undefined;
      if (this.platform === 'win32' && definition.progId) {
        try { registered = await this.registered(definition.progId, definition.executable); } catch { /* Unreadable registration is not an app launch failure. */ }
      }
      const candidates: string[] = registered ? [registered] : [];
      if (this.platform === 'win32') {
        if (definition.progId) for (const base of [this.env.ProgramFiles, this.env['ProgramFiles(x86)']].filter((value): value is string => !!value)) {
          candidates.push(path.win32.join(base, 'Microsoft Office', 'root', 'Office16', definition.executable), path.win32.join(base, 'Microsoft Office', 'Office16', definition.executable));
        }
        else if (definition.id === 'libreoffice') for (const base of [this.env.ProgramFiles, this.env['ProgramFiles(x86)']].filter((value): value is string => !!value)) candidates.push(path.win32.join(base, 'LibreOffice', 'program', 'soffice.exe'));
      } else if (this.platform === 'darwin') {
        if (definition.progId) candidates.push('/Applications/' + definition.name + '.app/Contents/MacOS/' + definition.name);
        if (definition.id === 'libreoffice') candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
      }
      // Shared host resolver searches absolute PATH entries and excludes workspace/worktree programs when hosted.
      if (!definition.progId) candidates.push(definition.executable);
      let identity: LocalApplicationIdentity | undefined;
      for (const candidate of candidates) {
        try { identity = await fileIdentity(this.resolve(candidate)); break; } catch { /* Try only the remaining fixed candidates. */ }
      }
      if (identity) detected.set(definition.id, { ...identity, id: definition.id });
      const comReady = this.platform === 'win32' && !!registered && identity?.path === registered;
      return { id: definition.id, name: definition.name, installed: !!identity,
        registration: !identity ? 'not-found' as const : definition.progId ? comReady ? 'registered' as const : 'file-only' as const : 'not-required' as const,
        qualification: 'not-run' as const,
        candidate_operations: identity && (!definition.progId || comReady) ? [...definition.operations] : [],
      };
    }));
    this.candidates.clear(); for (const [id, identity] of detected) this.candidates.set(id, identity);
    // v0.9.108: the Word author name for tracked changes is read here, with detection, never during an edit.
    this.officeUser = this.platform === 'win32' && detected.has('word') ? (await this.officeUserName().catch(() => undefined))?.trim() || undefined : undefined;
    return { version: 1, platform: this.platform, detected_at: (this.ports.now?.() ?? new Date()).toISOString(), applications,
      scope: 'Installed-file/registration detection only. No application was started; candidate operations and versions require actual qualification. Excel/pandoc detection grants no recalculation/conversion capability.' };
  }
}
