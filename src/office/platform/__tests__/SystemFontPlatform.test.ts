import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { platformSystemFontCandidates } from '../SystemFontPlatform';

it('P2 audit F4: Windows font locations come from the adapter and the system root, never an assumed drive', () => {
  const root = path.win32.join(path.win32.sep, 'Windows'); const fonts = path.win32.join(root, 'Fonts');
  // The adapter builds the Windows folder; the shared candidate list appends file names with the host's own path rules.
  const file = (name: string) => path.join(fonts, name);
  expect(platformSystemFontCandidates('en', 'regular', 'win32', { WINDIR: root }).map(candidate => candidate.file)).toContain(file('arial.ttf'));
  expect(platformSystemFontCandidates('zh-Hans', 'regular', 'win32', { SystemRoot: root })[0]).toMatchObject({ family: 'Microsoft YaHei', file: file('msyh.ttc') });
  expect(platformSystemFontCandidates('en', 'regular', 'win32', {})).toEqual([]);
  expect(platformSystemFontCandidates('en', 'regular', 'win32', { WINDIR: 'Windows' })).toEqual([]);
  expect(platformSystemFontCandidates('en', 'regular', 'darwin', { WINDIR: root })).toEqual([]);
  expect(platformSystemFontCandidates('en', 'regular', 'linux', {})).toEqual([]);
  // Supplementary source check: the PDF edit queue holds no Windows location of its own.
  const editor = readFileSync(path.join(__dirname, '..', '..', 'pdf', 'PdfEditor.ts'), 'utf8');
  expect(editor).not.toMatch(/WINDIR|SystemRoot|[A-Za-z]:\\/); expect(editor).toContain('platformSystemFontCandidates');
});
