/**
 * v0.9.110 (N1): go_to_definition and find_references, one schema and one handler for every route.
 *
 * Domain only: no VS Code and no OS calls. The host supplies the document, the language-service answers and the
 * read-scope decisions through the ports below. A symbol is located on the asked line here, so the model never counts
 * UTF-16 columns; whole identifiers match only at identifier boundaries, decoded by code point.
 */
import { randomUUID } from 'node:crypto';

export const GO_TO_DEFINITION_TOOL = 'go_to_definition';
export const FIND_REFERENCES_TOOL = 'find_references';
export type CodeNavigationTool = typeof GO_TO_DEFINITION_TOOL | typeof FIND_REFERENCES_TOOL;
export const CODE_NAVIGATION_TOOLS: readonly CodeNavigationTool[] = [GO_TO_DEFINITION_TOOL, FIND_REFERENCES_TOOL];
export const CODE_NAVIGATION_PAGE_SIZE = 100;
export const NO_LOCATIONS_MESSAGE = 'No language-service locations are available here; this does not prove there are no references.';
/**
 * v0.9.110 (smoke N1): every location is in the queried file, and one is the import that brings the symbol in. The
 * language service did not follow the import: a TypeScript project still loading answers from the one file alone.
 */
export const IMPORT_NOT_FOLLOWED_MESSAGE = 'Every location is in this file, and one is its import of the symbol: the language service did not '
  + 'follow the import to another file. It may not have loaded the project yet, or cannot resolve the module. Locations in '
  + 'other files may be missing; this does not prove there are none. Ask again shortly.';

export function isCodeNavigationTool(name: string): name is CodeNavigationTool {
  return name === GO_TO_DEFINITION_TOOL || name === FIND_REFERENCES_TOOL;
}

const SHARED_PROPERTIES: Record<string, unknown> = {
  path: { type: 'string', description: 'A file you may read: relative to the working folder or absolute inside an allowed read root.' },
  line: { type: 'integer', description: '1-based line number of the symbol.' },
  symbol: { type: 'string', description: 'Recommended: the exact symbol text on that line, such as a function or variable name. An identifier matches only as a whole identifier (searching id does not match inside valid); other text such as a.b or + matches literally. Do not combine with character.' },
  occurrence: { type: 'integer', description: 'With symbol only: which match on the line, 1-based from the left, when the symbol appears more than once.' },
  character: { type: 'integer', description: 'Exact mode instead of symbol: 1-based UTF-16 column. Do not combine with symbol or occurrence.' },
  cursor: { type: 'string', description: 'The nextCursor of an earlier result of the same query, to get its next page. Send the same other arguments.' },
};

const RESULT_NOTE = 'The result is JSON: status, locations (1-based line/character ranges, no code; use read_file to see the code), '
  + 'returned/withheld/unsupported counts, resolvedPosition, and nextCursor when more pages remain. Results come from the '
  + 'language service of this editor; withheld counts locations outside your read access, which are never named.';

/** The one declaration every route advertises. Structural, so routes use it without importing a host type. */
export interface CodeNavigationToolSpec {
  type: 'function';
  function: { name: CodeNavigationTool; description: string; parameters: Record<string, unknown> };
}

export const GO_TO_DEFINITION_SPEC: CodeNavigationToolSpec = {
  type: 'function',
  function: {
    name: GO_TO_DEFINITION_TOOL,
    description: 'Find where the symbol at a position is defined, across files, using the editor\'s language service. Read-only. '
      + 'Give path, line and symbol (recommended) or character. ' + RESULT_NOTE,
    parameters: { type: 'object', properties: SHARED_PROPERTIES, required: ['path', 'line'] },
  },
};

export const FIND_REFERENCES_SPEC: CodeNavigationToolSpec = {
  type: 'function',
  function: {
    name: FIND_REFERENCES_TOOL,
    description: 'Find the places that refer to the symbol at a position, across files, using the editor\'s language service. Read-only. '
      + 'The list may include the declaration itself, so the number of locations is not the number of callers. '
      + 'An empty answer does not prove there are no references. Give path, line and symbol (recommended) or character. ' + RESULT_NOTE,
    parameters: { type: 'object', properties: SHARED_PROPERTIES, required: ['path', 'line'] },
  },
};

export const CODE_NAVIGATION_TOOL_SPECS: readonly CodeNavigationToolSpec[] = [GO_TO_DEFINITION_SPEC, FIND_REFERENCES_SPEC];

// ─── Result ─────────────────────────────────────────────────────────────

export interface NavigationLocation {
  path: string; startLine: number; startCharacter: number; endLine: number; endCharacter: number; source: 'language-service';
}

export type NavigationStatus = 'ok' | 'not-available' | 'refused' | 'cancelled' | 'failed';

export interface NavigationResult {
  status: NavigationStatus;
  locations: NavigationLocation[];
  returned: number; withheld: number; unsupported: number;
  resolvedPosition?: { line: number; character: number };
  symbolMatchMode?: SymbolMatchMode;
  matchesOnLine?: number;
  declarationsRequested?: true;
  documentVersion?: number;
  unsaved?: boolean;
  complete: boolean;
  nextCursor?: string;
  reason?: string;
  message?: string;
}

// ─── Symbol location ────────────────────────────────────────────────────

export type SymbolMatchMode = 'whole-identifier' | 'literal';

const IDENTIFIER_START = /^[\p{ID_Start}$_]$/u;
const IDENTIFIER_PART = /^[\p{ID_Continue}$_]$/u;

/** Whole code points of a string; a lone surrogate stays one element. */
function codePoints(text: string): string[] {
  return Array.from(text);
}

export function isIdentifierSymbol(symbol: string): boolean {
  const points = codePoints(symbol);
  if (points.length === 0 || !IDENTIFIER_START.test(points[0])) return false;
  return points.slice(1).every(point => IDENTIFIER_PART.test(point));
}

/** The whole code point that ends just before `index` (UTF-16), decoding a surrogate pair; undefined at line start. */
export function codePointBefore(line: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const low = line.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = line.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return line.slice(index - 2, index);
  }
  return line[index - 1];
}

/** The whole code point that starts at `index` (UTF-16); undefined at line end. */
export function codePointAtIndex(line: string, index: number): string | undefined {
  if (index >= line.length) return undefined;
  const value = line.codePointAt(index);
  return value === undefined ? undefined : String.fromCodePoint(value);
}

function isIdentifierPart(point: string | undefined): boolean {
  return point !== undefined && IDENTIFIER_PART.test(point);
}

/** 0-based UTF-16 start offsets of the symbol's counted matches on one line, left to right. */
export function symbolMatches(line: string, symbol: string): { mode: SymbolMatchMode; starts: number[] } {
  const mode: SymbolMatchMode = isIdentifierSymbol(symbol) ? 'whole-identifier' : 'literal';
  const starts: number[] = [];
  let from = 0;
  while (from <= line.length) {
    const at = line.indexOf(symbol, from);
    if (at < 0) break;
    if (mode === 'literal') {
      starts.push(at);
      from = at + symbol.length;
      continue;
    }
    const end = at + symbol.length;
    if (!isIdentifierPart(codePointBefore(line, at)) && !isIdentifierPart(codePointAtIndex(line, end))) {
      starts.push(at);
      from = end;
    } else {
      from = at + 1;
    }
  }
  return { mode, starts };
}

// ─── Arguments ──────────────────────────────────────────────────────────

export type NavigationArgs =
  | { path: string; line: number; mode: 'symbol'; symbol: string; occurrence?: number; cursor?: string }
  | { path: string; line: number; mode: 'character'; character: number; cursor?: string };

function strictPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Strict reading of the model's input. A wrong type is an error, never a coerced or clamped value. */
export function parseNavigationArgs(raw: Record<string, unknown>): { ok: true; args: NavigationArgs } | { ok: false; message: string } {
  const pathValue = raw.path;
  if (typeof pathValue !== 'string' || pathValue.trim() === '') return { ok: false, message: 'path must be a non-empty string.' };
  if (!strictPositiveInteger(raw.line)) return { ok: false, message: 'line must be a whole number of 1 or more.' };
  const cursor = raw.cursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor === '')) return { ok: false, message: 'cursor must be the nextCursor string of an earlier result.' };
  const hasSymbol = raw.symbol !== undefined && raw.symbol !== null;
  const hasCharacter = raw.character !== undefined && raw.character !== null;
  const hasOccurrence = raw.occurrence !== undefined && raw.occurrence !== null;
  if (hasSymbol === hasCharacter) return { ok: false, message: 'give exactly one of symbol (recommended) or character.' };
  if (hasCharacter) {
    if (hasOccurrence) return { ok: false, message: 'occurrence works only with symbol, not with character.' };
    if (!strictPositiveInteger(raw.character)) return { ok: false, message: 'character must be a whole number of 1 or more (1-based UTF-16 column).' };
    return { ok: true, args: { path: pathValue, line: raw.line, mode: 'character', character: raw.character, ...(cursor ? { cursor } : {}) } };
  }
  const symbol = raw.symbol;
  if (typeof symbol !== 'string' || symbol === '') return { ok: false, message: 'symbol must be non-empty text.' };
  if (/[\r\n]/.test(symbol)) return { ok: false, message: 'symbol must be on one line.' };
  if (hasOccurrence && !strictPositiveInteger(raw.occurrence)) return { ok: false, message: 'occurrence must be a whole number of 1 or more.' };
  return { ok: true, args: { path: pathValue, line: raw.line, mode: 'symbol', symbol,
    ...(hasOccurrence ? { occurrence: raw.occurrence as number } : {}), ...(cursor ? { cursor } : {}) } };
}

/** Where the provider is asked: 0-based UTF-16, or the honest reason no provider call is made. */
export type PositionResolution =
  | { ok: true; character0: number; symbolMatchMode?: SymbolMatchMode; matchesOnLine?: number }
  | { ok: false; reason: 'symbol-not-found-on-line' | 'ambiguous-symbol' | 'invalid-argument'; message: string;
    symbolMatchMode?: SymbolMatchMode; matchesOnLine?: number };

export function resolveNavigationPosition(lineText: string, args: NavigationArgs): PositionResolution {
  if (args.mode === 'character') {
    const character0 = args.character - 1;
    if (character0 > lineText.length) {
      return { ok: false, reason: 'invalid-argument', message: `character ${args.character} is past the end of line ${args.line} (${lineText.length + 1} is the last position).` };
    }
    const unit = lineText.charCodeAt(character0);
    const previous = lineText.charCodeAt(character0 - 1);
    if (character0 > 0 && unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
      return { ok: false, reason: 'invalid-argument', message: `character ${args.character} falls inside one character; use symbol instead.` };
    }
    return { ok: true, character0 };
  }
  const { mode, starts } = symbolMatches(lineText, args.symbol);
  const counts = { symbolMatchMode: mode, matchesOnLine: starts.length };
  if (starts.length === 0) {
    return { ok: false, reason: 'symbol-not-found-on-line', ...counts,
      message: `${JSON.stringify(args.symbol)} is not on line ${args.line}${mode === 'whole-identifier' ? ' as a whole identifier' : ''}.` };
  }
  if (args.occurrence === undefined) {
    if (starts.length > 1) {
      return { ok: false, reason: 'ambiguous-symbol', ...counts,
        message: `${JSON.stringify(args.symbol)} appears ${starts.length} times on line ${args.line}; add occurrence (1 to ${starts.length}).` };
    }
    return { ok: true, character0: starts[0], ...counts };
  }
  if (args.occurrence > starts.length) {
    return { ok: false, reason: 'invalid-argument', ...counts,
      message: `occurrence ${args.occurrence} is out of range: ${JSON.stringify(args.symbol)} appears ${starts.length} time(s) on line ${args.line}.` };
  }
  return { ok: true, character0: starts[args.occurrence - 1], ...counts };
}

// ─── Ports ──────────────────────────────────────────────────────────────

/** 0-based, as the language service reports it. */
export interface RawRange { startLine: number; startCharacter: number; endLine: number; endCharacter: number }

/**
 * One location from the provider. `filePath` only when the host can name it as a file on this host; `sameDocument`
 * when the host knows it is in the queried document itself.
 */
export interface RawNavigationLocation { filePath?: string; range: RawRange; sameDocument?: true }

/** How far an import statement is looked for around a location, in lines: a bound, not a parser. */
const IMPORT_STATEMENT_LINES = 40;

/**
 * Whether the 0-based line is inside an import of another module, by a closed list of forms: an ECMAScript
 * `import … from '…'` or `export … from '…'` (also across lines), `import x = require('…')`, a `require('…')` on the
 * line itself, and Python's `from … import …` and `import …`. Anything else is not an import.
 */
export function inImportStatement(document: NavigationDocument, line0: number): boolean {
  const text = (line: number) => (line >= 0 && line < document.lineCount ? document.lineText(line) : undefined) ?? '';
  if (/\brequire\s*\(\s*['"`]/.test(text(line0))) return true;
  for (let start = line0; start >= 0 && start > line0 - IMPORT_STATEMENT_LINES; start--) {
    const line = text(start);
    // An earlier statement ended: the location is not inside an import that began above it.
    if (start < line0 && /;\s*(\/\/.*)?$/.test(line)) return false;
    const python = /^\s*from\s+[\w.]+\s+import\b/.test(line)
      || /^\s*import\s+[\w.]+(\s+as\s+\w+)?(\s*,\s*[\w.]+(\s+as\s+\w+)?)*\s*$/.test(line);
    if (!python && !/^\s*(import|export)\b/.test(line)) continue;
    // Where the statement ends: the line naming its module, or the parenthesis closing a Python import list. A
    // location below that end is not in it, whether or not the code ends its statements with a semicolon.
    const openList = python && /\(/.test(line) && !/\)/.test(line);
    const ends = (next: number) => python ? !openList || (next > start && /\)/.test(text(next)))
      : /\bfrom\s*['"`]|\brequire\s*\(|;\s*$/.test(text(next));
    let statement = '';
    let end = -1;
    for (let next = start; next < document.lineCount && next < start + IMPORT_STATEMENT_LINES; next++) {
      statement += `${text(next)}\n`;
      if (ends(next)) { end = next; break; }
    }
    if (end < line0) return false;
    return python || /^\s*(import|export)\b[\s\S]*?\bfrom\s*['"`]/.test(statement)
      || /^\s*import\s+[\w$]+\s*=\s*require\s*\(/.test(statement);
  }
  return false;
}

/** The answer stays in the queried file and lands on its import of the symbol: the import was not followed. */
export function importNotFollowed(raw: readonly RawNavigationLocation[], document: NavigationDocument): boolean {
  return raw.length > 0 && raw.every((location) => location.sameDocument === true)
    && raw.some((location) => inImportStatement(document, location.range.startLine));
}

export interface NavigationDocument {
  version: number;
  isDirty: boolean;
  lineCount: number;
  /** 0-based line. */
  lineText(line0: number): string;
}

/** The named host adapter: VS Code's language service. */
export interface CodeNavigationHost {
  openDocument(physicalPath: string): Promise<NavigationDocument>;
  locate(tool: CodeNavigationTool, document: NavigationDocument, line0: number, character0: number): Promise<RawNavigationLocation[] | undefined>;
}

let registeredHost: CodeNavigationHost | undefined;

/** Activation registers the editor's adapter once; without one, no route offers the tools. */
export function setCodeNavigationHost(host: CodeNavigationHost | undefined): void {
  registeredHost = host;
}

export function codeNavigationHost(): CodeNavigationHost | undefined {
  return registeredHost;
}

/** What the read policy decides for one returned file, asked again at every page. */
export type NavigationTargetDecision = { kind: 'readable'; displayPath: string } | { kind: 'withheld' } | { kind: 'unsupported' };

/** The admitted input of one operation, with a check of its live authority and physical identity. */
export interface NavigationInput {
  physicalPath: string;
  /** Still readable now, by the same physical file, without asking anyone. */
  current(): Promise<boolean>;
}

export interface NavigationScope {
  /** The input file, through the same read checks as read_file. Throws the read refusal unchanged. */
  resolveInput(pathArgument: string): Promise<NavigationInput>;
  /** A provider location under its own current authority; never throws, never asks the person anything. */
  classifyTarget(filePath: string): Promise<NavigationTargetDecision>;
  /** The live read authority (grants, Full access and its revision, current local consent), read at each boundary. */
  authorityRevision(): string;
  /** The current turn/attempt generation of the owning tool surface; a result for an older one is discarded. */
  generation(): number;
  retired(): boolean;
}

// ─── Handler ────────────────────────────────────────────────────────────

/** What one call started from; its page is delivered only while all of it still holds. */
interface NavigationOrigin {
  generation: number;
  authority: string;
  input: NavigationInput;
  signal?: AbortSignal;
}

interface CursorSnapshot {
  tool: CodeNavigationTool;
  queryKey: string;
  physicalPath: string;
  documentVersion: number;
  unsaved: boolean;
  authority: string;
  generation: number;
  entries: Array<{ filePath?: string; range: RawRange }>;
  offset: number;
  resolvedPosition?: { line: number; character: number };
  symbolMatchMode?: SymbolMatchMode;
  matchesOnLine?: number;
  /** v0.9.110: the provider did not follow the symbol's import to another file; never reported complete. */
  importNotFollowed?: true;
}

function emptyResult(status: NavigationStatus, extra: Partial<NavigationResult> = {}): NavigationResult {
  return { status, locations: [], returned: 0, withheld: 0, unsupported: 0, complete: status === 'ok' || status === 'not-available', ...extra };
}

function queryKey(args: NavigationArgs): string {
  return JSON.stringify(args.mode === 'symbol'
    ? [args.path, args.line, 'symbol', args.symbol, args.occurrence ?? null]
    : [args.path, args.line, 'character', args.character]);
}

function compareRange(a: RawRange, b: RawRange): number {
  return a.startLine - b.startLine || a.startCharacter - b.startCharacter || a.endLine - b.endLine || a.endCharacter - b.endCharacter;
}

/** Dedupe by file and range, then sort by path and range; locations the host cannot name as files go last. */
export function orderNavigationLocations(raw: readonly RawNavigationLocation[]): RawNavigationLocation[] {
  const seen = new Set<string>();
  const unique: RawNavigationLocation[] = [];
  for (const location of raw) {
    const key = JSON.stringify([location.filePath ?? null, location.range.startLine, location.range.startCharacter, location.range.endLine, location.range.endCharacter]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(location);
  }
  return unique.sort((a, b) => {
    if (a.filePath === undefined || b.filePath === undefined) return a.filePath === b.filePath ? compareRange(a.range, b.range) : a.filePath === undefined ? 1 : -1;
    return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : compareRange(a.range, b.range);
  });
}

/** One navigation surface per tool instance. Cursors live in memory only and die with the instance or its turn. */
export class CodeNavigationService {
  private readonly cursors = new Map<string, CursorSnapshot>();

  constructor(private readonly host: CodeNavigationHost, private readonly scope: NavigationScope) {}

  /** A new turn, attempt or authority: earlier cursors no longer continue. */
  forgetCursors(): void {
    this.cursors.clear();
  }

  async run(tool: CodeNavigationTool, raw: Record<string, unknown>, signal?: AbortSignal): Promise<NavigationResult> {
    const parsed = parseNavigationArgs(raw);
    if (!parsed.ok) return emptyResult('failed', { complete: false, reason: 'invalid-argument', message: parsed.message });
    const args = parsed.args;
    const generation = this.scope.generation();
    const input = await this.scope.resolveInput(args.path);
    const physicalPath = input.physicalPath;
    // Read after admission: admitting the input may itself record the person's consent for its root.
    const authority = this.scope.authorityRevision();
    const origin: NavigationOrigin = { generation, authority, input, ...(signal ? { signal } : {}) };
    if (signal?.aborted) return emptyResult('cancelled', { complete: false, reason: 'cancelled' });
    const document = await this.host.openDocument(physicalPath);
    if (args.cursor !== undefined) return await this.continueCursor(tool, args, document, origin);
    if (args.line > document.lineCount) {
      return emptyResult('failed', { complete: false, reason: 'invalid-argument',
        message: `line ${args.line} is past the end of the file (${document.lineCount} lines).` });
    }
    const resolution = resolveNavigationPosition(document.lineText(args.line - 1), args);
    const facts = {
      ...(resolution.symbolMatchMode ? { symbolMatchMode: resolution.symbolMatchMode } : {}),
      ...(resolution.matchesOnLine !== undefined ? { matchesOnLine: resolution.matchesOnLine } : {}),
      documentVersion: document.version, unsaved: document.isDirty,
    };
    if (!resolution.ok) return emptyResult('failed', { ...facts, complete: false, reason: resolution.reason, message: resolution.message });
    const resolvedPosition = { line: args.line, character: resolution.character0 + 1 };
    const declarations = tool === FIND_REFERENCES_TOOL ? { declarationsRequested: true as const } : {};
    let raw0: RawNavigationLocation[] | undefined;
    try {
      raw0 = await this.host.locate(tool, document, args.line - 1, resolution.character0);
    } catch (error) {
      if (this.stale(generation, signal)) return emptyResult('cancelled', { complete: false, reason: 'cancelled' });
      return emptyResult('failed', { ...facts, resolvedPosition, ...declarations, complete: false, reason: 'language-service-error',
        message: `The language service failed: ${error instanceof Error ? error.message : String(error)}` });
    }
    // The public command cannot stop the provider; a late answer is dropped, never delivered to a later turn.
    if (this.stale(generation, signal)) return emptyResult('cancelled', { complete: false, reason: 'cancelled' });
    if (!raw0 || raw0.length === 0) {
      return emptyResult('not-available', { ...facts, resolvedPosition, ...declarations, reason: 'no-provider-or-no-locations', message: NO_LOCATIONS_MESSAGE });
    }
    const snapshot: CursorSnapshot = {
      tool, queryKey: queryKey(args), physicalPath, documentVersion: document.version, unsaved: document.isDirty, authority, generation,
      entries: orderNavigationLocations(raw0), offset: 0, resolvedPosition,
      ...(importNotFollowed(raw0, document) ? { importNotFollowed: true as const } : {}),
      ...(resolution.symbolMatchMode ? { symbolMatchMode: resolution.symbolMatchMode } : {}),
      ...(resolution.matchesOnLine !== undefined ? { matchesOnLine: resolution.matchesOnLine } : {}),
    };
    return await this.page(snapshot, origin);
  }

  private stale(generation: number, signal?: AbortSignal): boolean {
    return signal?.aborted === true || this.scope.retired() || this.scope.generation() !== generation;
  }

  private async continueCursor(tool: CodeNavigationTool, args: NavigationArgs, document: NavigationDocument,
    origin: NavigationOrigin): Promise<NavigationResult> {
    const { generation, authority } = origin;
    const physicalPath = origin.input.physicalPath;
    const snapshot = this.cursors.get(args.cursor!);
    const expired = (why: string) => emptyResult('failed', { complete: false, reason: 'cursor-expired',
      message: `This cursor no longer continues (${why}). Run the query again without cursor.` });
    if (!snapshot) return expired('unknown, used, or from an earlier turn');
    this.cursors.delete(args.cursor!);
    if (snapshot.tool !== tool || snapshot.queryKey !== queryKey(args) || snapshot.physicalPath !== physicalPath) return expired('it belongs to a different query');
    if (snapshot.generation !== generation) return expired('the turn changed');
    if (snapshot.authority !== authority) return expired('file access changed');
    if (snapshot.documentVersion !== document.version) return expired('the document changed');
    return await this.page(snapshot, origin);
  }

  /**
   * Why this call's page may no longer be delivered, asked with no await between it and the delivery: the call was
   * stopped, its turn or surface ended, or the read authority it was admitted under changed.
   */
  private ended(origin: NavigationOrigin): NavigationResult | undefined {
    if (this.stale(origin.generation, origin.signal)) return emptyResult('cancelled', { complete: false, reason: 'cancelled' });
    if (this.scope.authorityRevision() !== origin.authority) {
      return emptyResult('cancelled', { complete: false, reason: 'authority-changed',
        message: 'File access changed while this query ran; no locations were returned. Run the query again if you still may read the file.' });
    }
    return undefined;
  }

  private async page(snapshot: CursorSnapshot, origin: NavigationOrigin): Promise<NavigationResult> {
    const before = this.ended(origin);
    if (before) return before;
    const slice = snapshot.entries.slice(snapshot.offset, snapshot.offset + CODE_NAVIGATION_PAGE_SIZE);
    const locations: NavigationLocation[] = [];
    let withheld = 0;
    let unsupported = 0;
    for (const entry of slice) {
      if (entry.filePath === undefined) { unsupported++; continue; }
      const decision = await this.scope.classifyTarget(entry.filePath);
      if (decision.kind === 'withheld') { withheld++; continue; }
      if (decision.kind === 'unsupported') { unsupported++; continue; }
      locations.push({ path: decision.displayPath,
        startLine: entry.range.startLine + 1, startCharacter: entry.range.startCharacter + 1,
        endLine: entry.range.endLine + 1, endCharacter: entry.range.endCharacter + 1, source: 'language-service' });
    }
    // The delivery boundary: the input is checked again by its live authority and physical identity, then the
    // origin, with no await between that last check, the cursor's publication and the return.
    if (!(await origin.input.current())) {
      const after = this.ended(origin);
      return after ?? emptyResult('refused', { complete: false, reason: 'input-no-longer-readable',
        message: 'You may no longer read the queried file, or it is no longer the same file; no locations were returned.' });
    }
    const ended = this.ended(origin);
    if (ended) return ended;
    const nextOffset = snapshot.offset + slice.length;
    let nextCursor: string | undefined;
    if (nextOffset < snapshot.entries.length) {
      nextCursor = randomUUID();
      this.cursors.set(nextCursor, { ...snapshot, offset: nextOffset });
    }
    return {
      status: 'ok',
      locations,
      returned: locations.length, withheld, unsupported,
      ...(snapshot.resolvedPosition ? { resolvedPosition: snapshot.resolvedPosition } : {}),
      ...(snapshot.symbolMatchMode ? { symbolMatchMode: snapshot.symbolMatchMode } : {}),
      ...(snapshot.matchesOnLine !== undefined ? { matchesOnLine: snapshot.matchesOnLine } : {}),
      ...(snapshot.tool === FIND_REFERENCES_TOOL ? { declarationsRequested: true as const } : {}),
      documentVersion: snapshot.documentVersion, unsaved: snapshot.unsaved,
      complete: nextCursor === undefined && !snapshot.importNotFollowed,
      ...(nextCursor ? { nextCursor } : {}),
      ...(snapshot.importNotFollowed ? { reason: 'import-not-followed', message: IMPORT_NOT_FOLLOWED_MESSAGE }
        : locations.length === 0 && withheld + unsupported > 0 ? { reason: 'all-locations-withheld-or-unsupported' } : {}),
    };
  }
}

/** The model-facing text of a result: compact JSON. */
export function formatNavigationResult(result: NavigationResult): string {
  return JSON.stringify(result);
}
