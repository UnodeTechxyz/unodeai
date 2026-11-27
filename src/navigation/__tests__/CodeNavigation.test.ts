import { describe, expect, it } from 'vitest';
import {
  codePointBefore, importNotFollowed, inImportStatement, isIdentifierSymbol, orderNavigationLocations, parseNavigationArgs, symbolMatches,
  type NavigationDocument,
} from '../CodeNavigation';

describe('identifier boundaries are decided by code point, not ASCII \\b', () => {
  it.each([
    ['id', true], ['$el', true], ['_x1', true], ['编号', true], ['\u{10400}x', true],
    ['obj.id', false], ['+', false], ['1x', false], ['a-b', false],
  ])('%j is an identifier: %s', (symbol, expected) => {
    expect(isIdentifierSymbol(symbol)).toBe(expected);
  });

  it('decodes a surrogate pair before the match instead of treating its low half as a separator', () => {
    expect(codePointBefore('\u{10400}id', 2)).toBe('\u{10400}');
    expect(codePointBefore('id', 0)).toBeUndefined();
  });

  it('whole identifiers skip substrings; literals count every non-overlapping occurrence', () => {
    expect(symbolMatches('valid id valid_id id', 'id')).toEqual({ mode: 'whole-identifier', starts: [6, 18] });
    expect(symbolMatches('a+b+c', '+')).toEqual({ mode: 'literal', starts: [1, 3] });
    expect(symbolMatches('x.y.z x.y', 'x.y')).toEqual({ mode: 'literal', starts: [0, 6] });
    expect(symbolMatches('café id', 'caf')).toEqual({ mode: 'whole-identifier', starts: [] });
  });
});

describe('arguments', () => {
  it('reads strict modes and keeps the cursor', () => {
    expect(parseNavigationArgs({ path: 'a.ts', line: 3, symbol: 'id', occurrence: 2, cursor: 'c' }))
      .toEqual({ ok: true, args: { path: 'a.ts', line: 3, mode: 'symbol', symbol: 'id', occurrence: 2, cursor: 'c' } });
    expect(parseNavigationArgs({ path: 'a.ts', line: 3, character: 5 }))
      .toEqual({ ok: true, args: { path: 'a.ts', line: 3, mode: 'character', character: 5 } });
    expect(parseNavigationArgs({ path: '', line: 3, character: 5 }).ok).toBe(false);
    expect(parseNavigationArgs({ path: 'a.ts', line: 0, character: 5 }).ok).toBe(false);
  });
});

describe('ordering', () => {
  it('dedupes by file and range and puts unnamed locations last', () => {
    const r = (l: number) => ({ startLine: l, startCharacter: 0, endLine: l, endCharacter: 1 });
    expect(orderNavigationLocations([{ range: r(0) }, { filePath: 'b', range: r(2) }, { filePath: 'a', range: r(5) },
      { filePath: 'b', range: r(1) }, { filePath: 'b', range: r(2) }]))
      .toEqual([{ filePath: 'a', range: r(5) }, { filePath: 'b', range: r(1) }, { filePath: 'b', range: r(2) }, { range: r(0) }]);
  });
});

const doc = (lines: string[]): NavigationDocument => ({ version: 1, isDirty: false, lineCount: lines.length, lineText: (n) => lines[n] });

describe('smoke N1: an answer that stops at the import of the symbol', () => {
  // [lines, 0-based line of the location, inside an import of another module]
  const cases: Array<[string[], number, boolean]> = [
    [["import { total } from './a';"], 0, true],
    [['import {', '  total,', "} from './a';"], 1, true],
    [["import { total } from './a'", '', 'console.log(total)'], 2, false],
    [["import { total } from './a'", 'total()'], 0, true],
    [["const { total } = require('./a');"], 0, true],
    [["import total = require('./a');"], 0, true],
    [["export { total } from './a';"], 0, true],
    [["import { a } from './a';", 'total();'], 1, false],
    [['export function total() {', '  return 1;', '}'], 0, false],
    [['const total = 1;'], 0, false],
    [['from pkg.a import total'], 0, true],
    [['from a import (', '    total,', ')', 'print(total)'], 1, true],
    [['from a import (', '    total,', ')', 'print(total)'], 3, false],
    [['import os'], 0, true],
    [['import os', 'os.path'], 1, false],
  ];
  it.each(cases)('%j line %i: %s', (lines, line0, expected) => {
    expect(inImportStatement(doc(lines), line0)).toBe(expected);
  });

  const r = (line: number) => ({ startLine: line, startCharacter: 9, endLine: line, endCharacter: 14 });
  it('flags only an answer wholly in the queried file with a location on its import', () => {
    const b = doc(["import { total } from './a';", '', 'export const sum = total(1);']);
    expect(importNotFollowed([{ filePath: 'b', range: r(0), sameDocument: true }, { filePath: 'b', range: r(2), sameDocument: true }], b)).toBe(true);
    // A location in another file: the import was followed.
    expect(importNotFollowed([{ filePath: 'b', range: r(0), sameDocument: true }, { filePath: 'a', range: r(0) }], b)).toBe(false);
    // A local symbol: every location in the file, none on an import.
    expect(importNotFollowed([{ filePath: 'b', range: r(2), sameDocument: true }], b)).toBe(false);
    // A host that cannot say a location is the queried file never flags it.
    expect(importNotFollowed([{ filePath: 'b', range: r(0) }], b)).toBe(false);
    expect(importNotFollowed([], b)).toBe(false);
  });
});
