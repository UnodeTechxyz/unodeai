/**
 * v0.9.110 (N1): go_to_definition / find_references through the real WorkspaceTools run entry.
 * The language service is a recording fake; the files, read roots and scope checks are real.
 */
import * as fs from 'fs/promises';
import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../WorkspaceTools';
import { SessionLocalReadScopeConsent } from '../localReadScope';

// A controlled barrier, not a timer: every physical-path lookup is the real one, then the hook a test armed runs
// before the lookup's answer reaches the caller.
const barrier = vi.hoisted(() => ({ onRealpath: undefined as undefined | ((target: string) => void) }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, realpath: async (...args: Parameters<typeof actual.realpath>) => {
    const answer = await actual.realpath(...args);
    barrier.onRealpath?.(String(args[0]));
    return answer;
  } };
});
import {
  CODE_NAVIGATION_PAGE_SIZE, IMPORT_NOT_FOLLOWED_MESSAGE, NO_LOCATIONS_MESSAGE,
  type CodeNavigationHost, type CodeNavigationTool, type NavigationDocument, type NavigationResult, type RawNavigationLocation,
} from '../../navigation/CodeNavigation';

interface Call { tool: CodeNavigationTool; physicalPath: string; line0: number; character0: number }

class FakeLanguageService implements CodeNavigationHost {
  calls: Call[] = [];
  versions = new Map<string, number>();
  answer: (call: Call) => Promise<RawNavigationLocation[] | undefined> | RawNavigationLocation[] | undefined = () => [];
  async openDocument(physicalPath: string): Promise<NavigationDocument> {
    const lines = readFileSync(physicalPath, 'utf8').split('\n');
    const version = this.versions.get(physicalPath) ?? 1;
    return { version, isDirty: false, lineCount: lines.length, lineText: (line0) => lines[line0], physicalPath } as NavigationDocument & { physicalPath: string };
  }
  async locate(tool: CodeNavigationTool, document: NavigationDocument, line0: number, character0: number): Promise<RawNavigationLocation[] | undefined> {
    const call = { tool, physicalPath: (document as NavigationDocument & { physicalPath: string }).physicalPath, line0, character0 };
    this.calls.push(call);
    return await this.answer(call);
  }
}

const cleanup: string[] = [];
afterEach(async () => {
  barrier.onRealpath = undefined;
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function fixture(lines: string[], options: { allowed?: string[]; extraRoots?: string[] } = {}) {
  // The root in the same physical spelling as the file locations the fake service returns (`file`, a realpath). Under
  // an 8.3 short TEMP (GitHub's Windows runner) the two spellings would otherwise differ: these cases check symbol
  // location and paging, not a short-name workspace root, whose display falls back to an absolute path.
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-nav-')));
  cleanup.push(parent);
  const root = path.join(parent, 'workspace');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), lines.join('\n'), 'utf8');
  const tools = new WorkspaceTools(root, new Set(options.allowed ?? ['read']), 'agent-1');
  const service = new FakeLanguageService();
  tools.setCodeNavigationHost(service);
  return { parent, root, tools, service, file: await fs.realpath(path.join(root, 'src', 'a.ts')) };
}

async function nav(tools: WorkspaceTools, tool: CodeNavigationTool, args: Record<string, unknown>) {
  const run = await tools.run(tool, args);
  return { run, result: JSON.parse(run.output) as NavigationResult };
}

const at = (filePath: string, line0: number, character0: number, length = 2): RawNavigationLocation =>
  ({ filePath, range: { startLine: line0, startCharacter: character0, endLine: line0, endCharacter: character0 + length } });

describe('N1 symbol location (F10 fixtures, plan §5)', () => {
  // [line text, symbol, occurrence, expected]
  const located: Array<[string, string, number | undefined, { mode: string; matches: number; character: number }]> = [
    ['const valid = id(input);', 'id', undefined, { mode: 'whole-identifier', matches: 1, character: 15 }],
    ['const valid = id(input);', 'id', 1, { mode: 'whole-identifier', matches: 1, character: 15 }],
    ['$elm; $el;', '$el', undefined, { mode: 'whole-identifier', matches: 1, character: 7 }],
    ['编号项; 编号;', '编号', undefined, { mode: 'whole-identifier', matches: 1, character: 6 }],
    ['id + id', 'id', 1, { mode: 'whole-identifier', matches: 2, character: 1 }],
    ['id + id', 'id', 2, { mode: 'whole-identifier', matches: 2, character: 6 }],
    ['\u{10400}id; id\u{10400}; id;', 'id', undefined, { mode: 'whole-identifier', matches: 1, character: 13 }],
    ['obj.id', 'obj.id', undefined, { mode: 'literal', matches: 1, character: 1 }],
    ['a + b', '+', undefined, { mode: 'literal', matches: 1, character: 3 }],
    ['\tconst 名前 = use(名前);', '名前', 2, { mode: 'whole-identifier', matches: 2, character: 17 }],
  ];
  it.each(located)('%j / %s (occurrence %s) asks the provider at the identifier', async (text, symbol, occurrence, expected) => {
    const { tools, service, file } = await fixture(['// header', text]);
    service.answer = () => [at(file, 1, expected.character - 1)];
    const { run, result } = await nav(tools, 'find_references', { path: 'src/a.ts', line: 2, symbol, ...(occurrence ? { occurrence } : {}) });
    expect(run.status).toBe('success');
    expect(service.calls).toEqual([{ tool: 'find_references', physicalPath: file, line0: 1, character0: expected.character - 1 }]);
    expect(result).toMatchObject({ status: 'ok', symbolMatchMode: expected.mode, matchesOnLine: expected.matches,
      resolvedPosition: { line: 2, character: expected.character }, declarationsRequested: true, returned: 1, complete: true });
    expect(result.locations[0]).toEqual({ path: 'src/a.ts', startLine: 2, startCharacter: expected.character,
      endLine: 2, endCharacter: expected.character + 2, source: 'language-service' });
  });

  const refusedBeforeProvider: Array<[string, Record<string, unknown>, Partial<NavigationResult>]> = [
    ['const valid = id(input);', { symbol: 'id', occurrence: 2 }, { reason: 'invalid-argument', symbolMatchMode: 'whole-identifier', matchesOnLine: 1 }],
    ['const valid = 1;', { symbol: 'id' }, { reason: 'symbol-not-found-on-line', symbolMatchMode: 'whole-identifier', matchesOnLine: 0 }],
    ['id + id', { symbol: 'id' }, { reason: 'ambiguous-symbol', symbolMatchMode: 'whole-identifier', matchesOnLine: 2 }],
    ['a + b + c', { symbol: '+' }, { reason: 'ambiguous-symbol', symbolMatchMode: 'literal', matchesOnLine: 2 }],
    ['$elm;', { symbol: '$el' }, { reason: 'symbol-not-found-on-line', symbolMatchMode: 'whole-identifier', matchesOnLine: 0 }],
  ];
  it.each(refusedBeforeProvider)('%j %j never reaches the provider', async (text, args, expected) => {
    const { tools, service } = await fixture([text]);
    const { run, result } = await nav(tools, 'find_references', { path: 'src/a.ts', line: 1, ...args });
    expect(run.status).toBe('failed');
    expect(service.calls).toEqual([]);
    expect(result).toMatchObject({ status: 'failed', ...expected });
    expect(result.resolvedPosition).toBeUndefined();
  });
});

describe('N1 character mode and argument strictness', () => {
  it('character mode passes the exact UTF-16 column and sets no symbolMatchMode', async () => {
    const { tools, service, file } = await fixture(['\u{1F600} x = y;']);
    service.answer = () => [at(file, 0, 3, 1)];
    const { result } = await nav(tools, 'go_to_definition', { path: 'src/a.ts', line: 1, character: 4 });
    expect(service.calls[0]).toMatchObject({ tool: 'go_to_definition', line0: 0, character0: 3 });
    expect(result.status).toBe('ok');
    expect(result.symbolMatchMode).toBeUndefined();
    expect(result.matchesOnLine).toBeUndefined();
    expect(result.declarationsRequested).toBeUndefined();
    expect(result.resolvedPosition).toEqual({ line: 1, character: 4 });
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ['both modes', { symbol: 'x', character: 4 }],
    ['neither mode', {}],
    ['occurrence with character', { character: 4, occurrence: 1 }],
    ['character past end of line', { character: 99 }],
    ['character inside a surrogate pair', { character: 2 }],
    ['non-integer line', { line: 1.5, symbol: 'x' }],
    ['string character', { character: '4' }],
    ['zero occurrence', { symbol: 'x', occurrence: 0 }],
    ['multi-line symbol', { symbol: 'x\ny' }],
    ['line past end of file', { line: 9, symbol: 'x' }],
  ];
  it.each(invalid)('%s is an invalid argument and asks no provider', async (_label, args) => {
    const { tools, service } = await fixture(['\u{1F600} x = y;']);
    const { result } = await nav(tools, 'go_to_definition', { path: 'src/a.ts', line: 1, ...args });
    expect(result).toMatchObject({ status: 'failed', reason: 'invalid-argument' });
    expect(service.calls).toEqual([]);
  });
});

describe('smoke N1: a provider that did not follow the import is never reported complete', () => {
  const lines = ["import { total } from './other';", '', 'export const sum = total(1) + total(2);'];
  const here = (file: string, line0: number, character0: number): RawNavigationLocation => ({ ...at(file, line0, character0, 5), sameDocument: true });

  for (const tool of ['go_to_definition', 'find_references'] as const) {
    it(`${tool}: keeps the provider's locations, says complete: false and why`, async () => {
      const { tools, service, file } = await fixture(lines);
      service.answer = () => tool === 'go_to_definition' ? [here(file, 0, 9)] : [here(file, 0, 9), here(file, 2, 19), here(file, 2, 30)];
      const { run, result } = await nav(tools, tool, { path: 'src/a.ts', line: 3, symbol: 'total', occurrence: 1 });
      expect(run.status).toBe('success');
      expect(result).toMatchObject({ status: 'ok', complete: false, reason: 'import-not-followed', message: IMPORT_NOT_FOLLOWED_MESSAGE,
        returned: tool === 'go_to_definition' ? 1 : 3, withheld: 0 });
      expect(result.locations[0]).toMatchObject({ path: 'src/a.ts', startLine: 1, startCharacter: 10 });
      expect(result.nextCursor).toBeUndefined();
    });
  }

  it('a followed import, or a local symbol, stays complete', async () => {
    const { root, tools, service, file } = await fixture(lines);
    await fs.writeFile(path.join(root, 'src', 'other.ts'), 'export function total(n: number) { return n; }\n', 'utf8');
    const other = await fs.realpath(path.join(root, 'src', 'other.ts'));
    service.answer = () => [here(file, 0, 9), here(file, 2, 19), at(other, 0, 16, 5)];
    expect((await nav(tools, 'find_references', { path: 'src/a.ts', line: 3, symbol: 'total', occurrence: 1 })).result)
      .toMatchObject({ status: 'ok', complete: true, returned: 3 });
    service.answer = () => [here(file, 2, 13)];
    const local = (await nav(tools, 'go_to_definition', { path: 'src/a.ts', line: 3, symbol: 'sum' })).result;
    expect(local).toMatchObject({ status: 'ok', complete: true });
    expect(local.reason).toBeUndefined();
  });
});

describe('N1 honest results, scope and paging', () => {
  it.each([[[]], [undefined]])('an empty provider answer (%j) is not-available, never zero references', async (answer) => {
    const { tools, service } = await fixture(['useIt();']);
    service.answer = () => answer as RawNavigationLocation[] | undefined;
    const { run, result } = await nav(tools, 'find_references', { path: 'src/a.ts', line: 1, symbol: 'useIt' });
    expect(run.status).toBe('success');
    expect(result).toMatchObject({ status: 'not-available', reason: 'no-provider-or-no-locations', message: NO_LOCATIONS_MESSAGE,
      returned: 0, declarationsRequested: true });
  });

  it('withholds locations outside read access without naming them, and counts non-file locations unsupported', async () => {
    const { parent, tools, service, file } = await fixture(['useIt();']);
    const secret = path.join(parent, 'outside-secret', 'private.ts');
    await fs.mkdir(path.dirname(secret), { recursive: true });
    await fs.writeFile(secret, 'export function useIt() {}\n');
    service.answer = () => [at(file, 0, 0), at(secret, 0, 16), { range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 } },
      at(path.join(path.dirname(file), 'gone.ts'), 0, 0)];
    const { run, result } = await nav(tools, 'find_references', { path: 'src/a.ts', line: 1, symbol: 'useIt' });
    expect(result).toMatchObject({ status: 'ok', returned: 1, withheld: 1, unsupported: 2, complete: true });
    expect(run.output).not.toContain('outside-secret');
    expect(run.output).not.toContain('private.ts');
    expect(run.output).not.toContain('gone.ts');
  });

  it('refuses an input outside read access before any provider call', async () => {
    const { parent, tools, service } = await fixture(['x']);
    const outside = path.join(parent, 'elsewhere.ts');
    await fs.writeFile(outside, 'x\n');
    const run = await tools.run('go_to_definition', { path: outside, line: 1, symbol: 'x' });
    expect(run.status).toBe('refused');
    expect(service.calls).toEqual([]);
  });

  it('without Read the call is refused and the tools are not advertised; without a language service they are not advertised', async () => {
    const noRead = await fixture(['x'], { allowed: ['execute'] });
    const run = await noRead.tools.run('find_references', { path: 'src/a.ts', line: 1, symbol: 'x' });
    expect(run.status).toBe('refused');
    expect(noRead.service.calls).toEqual([]);
    expect(noRead.tools.specs().map((spec) => spec.function.name)).not.toContain('find_references');
    const reader = await fixture(['x']);
    expect(reader.tools.specs().map((spec) => spec.function.name)).toEqual(expect.arrayContaining(['go_to_definition', 'find_references']));
    reader.tools.setCodeNavigationHost(undefined);
    expect(reader.tools.specs().map((spec) => spec.function.name)).not.toContain('go_to_definition');
  });

  it('pages of 100 continue by cursor, sorted and deduplicated, and every page checks scope again', async () => {
    const { tools, service, file } = await fixture(['useIt();', ...Array.from({ length: 260 }, () => 'useIt();')]);
    const many = Array.from({ length: 250 }, (_, i) => at(file, 250 - i, 0, 5));
    service.answer = () => [...many, many[0], many[1]];
    const first = await nav(tools, 'find_references', { path: 'src/a.ts', line: 1, symbol: 'useIt' });
    expect(first.result).toMatchObject({ returned: CODE_NAVIGATION_PAGE_SIZE, complete: false });
    expect(first.result.locations[0].startLine).toBe(2);
    expect(first.result.nextCursor).toEqual(expect.any(String));
    const second = await nav(tools, 'find_references', { path: 'src/a.ts', line: 1, symbol: 'useIt', cursor: first.result.nextCursor });
    expect(second.result.locations[0].startLine).toBe(102);
    const third = await nav(tools, 'find_references', { path: 'src/a.ts', line: 1, symbol: 'useIt', cursor: second.result.nextCursor });
    expect(third.result).toMatchObject({ returned: 50, complete: true });
    expect(third.result.nextCursor).toBeUndefined();
    expect(service.calls).toHaveLength(1);
    // A used cursor does not continue again.
    const reused = await nav(tools, 'find_references', { path: 'src/a.ts', line: 1, symbol: 'useIt', cursor: first.result.nextCursor });
    expect(reused.result).toMatchObject({ status: 'failed', reason: 'cursor-expired' });
  });

  it.each([
    ['a new turn', (tools: WorkspaceTools) => tools.beginTurn()],
    ['a document change', (_tools: WorkspaceTools, service: FakeLanguageService, file: string) => { service.versions.set(file, 2); }],
    ['a different query', undefined],
  ] as const)('a cursor ends after %s and is never re-run silently', async (_label, change) => {
    const { tools, service, file } = await fixture(['useIt(); other();', ...Array.from({ length: 150 }, () => 'x')]);
    service.answer = () => Array.from({ length: 150 }, (_, i) => at(file, i + 1, 0, 1));
    const first = await nav(tools, 'find_references', { path: 'src/a.ts', line: 1, symbol: 'useIt' });
    if (change) change(tools, service, file);
    const next = await nav(tools, 'find_references', { path: 'src/a.ts', line: 1, symbol: change ? 'useIt' : 'other', cursor: first.result.nextCursor });
    expect(next.result).toMatchObject({ status: 'failed', reason: 'cursor-expired' });
    expect(service.calls).toHaveLength(1);
  });

  it('a provider answer that arrives after the turn moved on is discarded, not delivered', async () => {
    const { tools, service, file } = await fixture(['useIt();']);
    let release!: () => void;
    service.answer = () => new Promise((resolve) => { release = () => resolve([at(file, 0, 0)]); });
    const pending = tools.run('find_references', { path: 'src/a.ts', line: 1, symbol: 'useIt' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    tools.beginTurn();
    release();
    const run = await pending;
    expect(JSON.parse(run.output)).toMatchObject({ status: 'cancelled', returned: 0, locations: [] });
    expect(run.status).toBe('failed');
  });
});

/** A workspace and a sibling project under a local-scope root (the workspace's parent), as the host wires them. */
async function siblingFixture(consent: SessionLocalReadScopeConsent | undefined, options: { fullAccess?: () => boolean; revision?: () => unknown } = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-nav-local-')));
  cleanup.push(parent);
  const root = path.join(parent, 'workspace');
  const sibling = path.join(parent, 'sibling');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  const input = path.join(root, 'a.ts');
  const external = path.join(sibling, 'lib.ts');
  await fs.writeFile(input, 'useIt();\n', 'utf8');
  await fs.writeFile(external, 'export function useIt() {}\n', 'utf8');
  const extraRoots = consent ? [parent] : [];
  const tools = new WorkspaceTools(root, new Set(['read']), 'agent-1', undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, extraRoots);
  if (consent) tools.setLocalReadScopeAccess([parent], consent);
  if (options.fullAccess) tools.setFullFileAccess(options.fullAccess, options.revision);
  const service = new FakeLanguageService();
  tools.setCodeNavigationHost(service);
  return { parent, root, sibling, input, external, tools, service };
}

describe('audit F1: authority is live through the provider wait and every delivery boundary', () => {
  it('a local-scope consent revoked while the provider waits delivers no location and no cursor', async () => {
    const consent = new SessionLocalReadScopeConsent(async () => true);
    const f = await siblingFixture(consent);
    let revoked = false;
    f.service.answer = () => { revoked = consent.revoke(f.parent); return [at(f.external, 0, 16, 5)]; };
    const { run, result } = await nav(f.tools, 'find_references', { path: f.external, line: 1, symbol: 'useIt' });
    expect(revoked).toBe(true);
    expect(result).toMatchObject({ status: 'cancelled', reason: 'authority-changed', returned: 0, locations: [] });
    expect(result.nextCursor).toBeUndefined();
    expect(run.output).not.toContain('lib.ts');
    expect((await f.tools.run('read_file', { path: f.external })).status).toBe('refused');
  });

  it('Full access turned off while the provider waits delivers no location', async () => {
    let full = true;
    let revision = 1;
    const f = await siblingFixture(undefined, { fullAccess: () => full, revision: () => revision });
    f.service.answer = () => { full = false; revision++; return [at(f.input, 0, 0, 5)]; };
    const { result } = await nav(f.tools, 'go_to_definition', { path: f.external, line: 1, symbol: 'useIt' });
    expect(result).toMatchObject({ status: 'cancelled', reason: 'authority-changed', returned: 0, locations: [] });
    expect((await f.tools.run('read_file', { path: f.external })).status).toBe('refused');
  });

  it("consent revoked during a target's physical check, after the provider answered, still delivers nothing", async () => {
    const consent = new SessionLocalReadScopeConsent(async () => true);
    const f = await siblingFixture(consent);
    expect((await f.tools.run('read_file', { path: f.external })).status).toBe('success');
    f.service.answer = () => {
      barrier.onRealpath = (target) => { if (path.resolve(target) === f.external) { barrier.onRealpath = undefined; consent.revoke(f.parent); } };
      return [at(f.external, 0, 16, 5)];
    };
    const { run, result } = await nav(f.tools, 'find_references', { path: f.input, line: 1, symbol: 'useIt' });
    expect(result).toMatchObject({ status: 'cancelled', reason: 'authority-changed', returned: 0, locations: [] });
    expect(run.output).not.toContain('lib.ts');
  });

  it('unchanged permitted authority still returns the locations (local scope and Full access)', async () => {
    const consent = new SessionLocalReadScopeConsent(async () => true);
    const local = await siblingFixture(consent);
    local.service.answer = () => [at(local.external, 0, 16, 5)];
    const fromLocal = await nav(local.tools, 'find_references', { path: local.external, line: 1, symbol: 'useIt' });
    expect(fromLocal.result).toMatchObject({ status: 'ok', returned: 1, withheld: 0 });
    const full = await siblingFixture(undefined, { fullAccess: () => true, revision: () => 1 });
    full.service.answer = () => [at(full.input, 0, 0, 5)];
    const fromFull = await nav(full.tools, 'go_to_definition', { path: full.external, line: 1, symbol: 'useIt' });
    expect(fromFull.result).toMatchObject({ status: 'ok', returned: 1, locations: [{ path: 'a.ts' }] });
  });
});

describe('audit F2: an ended origin gets no page and no cursor', () => {
  it("Stop during the first page's target checks (101 locations) returns cancelled, no locations, no cursor", async () => {
    const { tools, service, file } = await fixture(['useIt();', ...Array.from({ length: 120 }, () => 'useIt();')]);
    const controller = new AbortController();
    service.answer = () => {
      barrier.onRealpath = (target) => { if (path.resolve(target) === file) { barrier.onRealpath = undefined; controller.abort(); } };
      return Array.from({ length: 101 }, (_, i) => at(file, i, 0, 5));
    };
    const run = await tools.run('find_references', { path: 'src/a.ts', line: 1, symbol: 'useIt' }, { signal: controller.signal });
    const result = JSON.parse(run.output) as NavigationResult;
    expect(controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({ status: 'cancelled', reason: 'cancelled', returned: 0, locations: [] });
    expect(result.nextCursor).toBeUndefined();
  });

  it('a new turn during a continuation page returns cancelled and publishes no further cursor', async () => {
    const { tools, service, file } = await fixture(['useIt();', ...Array.from({ length: 260 }, () => 'useIt();')]);
    service.answer = () => Array.from({ length: 250 }, (_, i) => at(file, i, 0, 5));
    const first = await nav(tools, 'find_references', { path: 'src/a.ts', line: 1, symbol: 'useIt' });
    expect(first.result.nextCursor).toEqual(expect.any(String));
    const open = service.openDocument.bind(service);
    let turned = false;
    service.openDocument = async (physical) => {
      const document = await open(physical);
      barrier.onRealpath = (target) => { if (path.resolve(target) === file) { barrier.onRealpath = undefined; turned = true; tools.beginTurn(); } };
      return document;
    };
    const next = await nav(tools, 'find_references', { path: 'src/a.ts', line: 1, symbol: 'useIt', cursor: first.result.nextCursor });
    expect(turned).toBe(true);
    expect(next.result).toMatchObject({ status: 'cancelled', reason: 'cancelled', returned: 0, locations: [] });
    expect(next.result.nextCursor).toBeUndefined();
  });
});

describe("audit F3: targets are judged by their own current authority, never by the input's root", () => {
  it('a workspace source reaches a definition in an already-approved sibling root, with no second question', async () => {
    let prompts = 0;
    const consent = new SessionLocalReadScopeConsent(async () => { prompts++; return true; });
    const f = await siblingFixture(consent);
    expect((await f.tools.run('read_file', { path: f.external })).status).toBe('success');
    f.service.answer = () => [at(f.external, 0, 16, 5)];
    const { result } = await nav(f.tools, 'go_to_definition', { path: 'a.ts', line: 1, symbol: 'useIt' });
    expect(result).toMatchObject({ status: 'ok', returned: 1, withheld: 0, locations: [{ path: f.external, startLine: 1, startCharacter: 17 }] });
    expect(prompts).toBe(1);
  });

  it("a root implied by the person's own localReadScope choice is returned without a question or a notice", async () => {
    let prompts = 0;
    let notices = 0;
    const consent = new SessionLocalReadScopeConsent(async () => { prompts++; return true; }, undefined,
      { autoGrant: () => true, onAutoGranted: () => { notices++; } });
    const f = await siblingFixture(consent);
    f.service.answer = () => [at(f.external, 0, 16, 5)];
    const { result } = await nav(f.tools, 'go_to_definition', { path: 'a.ts', line: 1, symbol: 'useIt' });
    expect(result).toMatchObject({ status: 'ok', returned: 1, withheld: 0 });
    expect([prompts, notices]).toEqual([0, 0]);
  });

  it('an unapproved or revoked root stays withheld, unnamed, and nobody is asked', async () => {
    let prompts = 0;
    const consent = new SessionLocalReadScopeConsent(async () => { prompts++; return true; });
    const f = await siblingFixture(consent);
    f.service.answer = () => [at(f.external, 0, 16, 5)];
    const unapproved = await nav(f.tools, 'go_to_definition', { path: 'a.ts', line: 1, symbol: 'useIt' });
    expect(unapproved.result).toMatchObject({ status: 'ok', returned: 0, withheld: 1 });
    expect(unapproved.run.output).not.toContain('sibling');
    expect(prompts).toBe(0);
    expect((await f.tools.run('read_file', { path: f.external })).status).toBe('success');
    expect(consent.revoke(f.parent)).toBe(true);
    const revoked = await nav(f.tools, 'go_to_definition', { path: 'a.ts', line: 1, symbol: 'useIt' });
    expect(revoked.result).toMatchObject({ status: 'ok', returned: 0, withheld: 1 });
    expect(revoked.run.output).not.toContain('sibling');
    expect(prompts).toBe(1);
  });
});

describe('audit F1: the input is checked again by its physical identity at delivery', () => {
  it('an input file that is gone when the provider answers is refused, and nothing is delivered', async () => {
    const { root, tools, service, file } = await fixture(['useIt();']);
    const other = path.join(root, 'src', 'b.ts');
    await fs.writeFile(other, 'useIt();\n', 'utf8');
    const otherPhysical = await fs.realpath(other);
    service.answer = async () => { await fs.rm(file); return [at(otherPhysical, 0, 0, 5)]; };
    const { run, result } = await nav(tools, 'find_references', { path: 'src/a.ts', line: 1, symbol: 'useIt' });
    expect(result).toMatchObject({ status: 'refused', reason: 'input-no-longer-readable', returned: 0, locations: [] });
    expect(result.nextCursor).toBeUndefined();
    expect(run.output).not.toContain('b.ts');
  });
});
