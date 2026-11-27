import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeCommand, openTextDocument, Position, uri } = vi.hoisted(() => {
  class HoistedPosition { constructor(readonly line: number, readonly character: number) {} }
  return {
    executeCommand: vi.fn(),
    openTextDocument: vi.fn(),
    Position: HoistedPosition,
    uri: (fsPath: string, scheme = 'file', authority = '') => ({ fsPath, scheme, authority }),
  };
});
const range = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });

vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => uri(fsPath) },
  Position,
  workspace: { openTextDocument },
  commands: { executeCommand },
}));

import { VscodeCodeNavigation } from '../VscodeCodeNavigation';

describe('VscodeCodeNavigation (N1 adapter)', () => {
  beforeEach(() => {
    executeCommand.mockReset();
    openTextDocument.mockReset().mockResolvedValue({ uri: uri('/w/a.ts'), version: 7, isDirty: true, lineCount: 2, lineAt: (n: number) => ({ text: ['one', 'two'][n] }) });
  });

  it('opens the document and reports its version, unsaved state and lines', async () => {
    const document = await new VscodeCodeNavigation().openDocument('/w/a.ts');
    expect(openTextDocument).toHaveBeenCalledWith(uri('/w/a.ts'));
    expect(document).toMatchObject({ version: 7, isDirty: true, lineCount: 2 });
    expect(document.lineText(1)).toBe('two');
  });

  it('asks the public reference command with only uri and position, and keeps file locations of this host', async () => {
    const adapter = new VscodeCodeNavigation();
    const document = await adapter.openDocument('/w/a.ts');
    executeCommand.mockResolvedValue([
      { uri: uri('/w/b.ts'), range: range(3, 4, 3, 9) },
      { uri: uri('/x/c.ts', 'vscode-vfs'), range: range(0, 0, 0, 1) },
      { uri: uri('/w/d.ts', 'file', 'other-host'), range: range(0, 0, 0, 1) },
    ]);
    const answer = await adapter.locate('find_references', document, 1, 2);
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith('vscode.executeReferenceProvider', uri('/w/a.ts'), new Position(1, 2));
    expect(answer).toEqual([
      { filePath: '/w/b.ts', range: { startLine: 3, startCharacter: 4, endLine: 3, endCharacter: 9 } },
      { range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 } },
      { range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 } },
    ]);
  });

  it('normalizes a LocationLink to its target selection range', async () => {
    const adapter = new VscodeCodeNavigation();
    const document = await adapter.openDocument('/w/a.ts');
    executeCommand.mockResolvedValue([
      { targetUri: uri('/w/def.ts'), targetRange: range(10, 0, 20, 1), targetSelectionRange: range(10, 16, 10, 21) },
      { targetUri: uri('/w/def2.ts'), targetRange: range(5, 0, 5, 9) },
    ]);
    const answer = await adapter.locate('go_to_definition', document, 0, 0);
    expect(executeCommand.mock.calls[0][0]).toBe('vscode.executeDefinitionProvider');
    expect(answer).toEqual([
      { filePath: '/w/def.ts', range: { startLine: 10, startCharacter: 16, endLine: 10, endCharacter: 21 } },
      { filePath: '/w/def2.ts', range: { startLine: 5, startCharacter: 0, endLine: 5, endCharacter: 9 } },
    ]);
  });

  it('marks the locations in the queried document itself, and no other', async () => {
    const adapter = new VscodeCodeNavigation();
    const document = await adapter.openDocument('/w/a.ts');
    executeCommand.mockResolvedValue([
      { uri: uri('/w/a.ts'), range: range(0, 9, 0, 14) },
      { uri: uri('/w/other.ts'), range: range(0, 16, 0, 21) },
      { uri: uri('/w/a.ts', 'vscode-vfs'), range: range(1, 0, 1, 1) },
    ]);
    expect(await adapter.locate('find_references', document, 0, 9)).toEqual([
      { filePath: '/w/a.ts', range: { startLine: 0, startCharacter: 9, endLine: 0, endCharacter: 14 }, sameDocument: true },
      { filePath: '/w/other.ts', range: { startLine: 0, startCharacter: 16, endLine: 0, endCharacter: 21 } },
      { range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 1 } },
    ]);
  });

  it('compares the queried document as the platform compares paths: another case is the same file only where case folds', async () => {
    const folder = path.join(os.tmpdir(), 'Nav-Case', 'src');
    const queried = path.join(folder, 'b.ts');
    const otherCase = path.join(folder.toUpperCase(), 'b.ts');
    openTextDocument.mockResolvedValue({ uri: uri(queried), version: 1, isDirty: false, lineCount: 1, lineAt: () => ({ text: "import { total } from './a';" }) });
    const adapter = new VscodeCodeNavigation();
    const document = await adapter.openDocument(queried);
    executeCommand.mockResolvedValue([{ uri: uri(otherCase), range: range(0, 9, 0, 14) }]);
    const [location] = (await adapter.locate('go_to_definition', document, 0, 9))!;
    expect(location.filePath).toBe(otherCase);
    if (process.platform === 'win32') expect(location.sameDocument).toBe(true);
    else expect(location.sameDocument).toBeUndefined();
  });

  it('an undefined answer stays undefined (no provider), never an invented empty list', async () => {
    const adapter = new VscodeCodeNavigation();
    executeCommand.mockResolvedValue(undefined);
    expect(await adapter.locate('go_to_definition', await adapter.openDocument('/w/a.ts'), 0, 0)).toBeUndefined();
  });
});
