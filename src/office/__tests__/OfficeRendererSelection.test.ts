import { expect, it, vi } from 'vitest';
import { officeRendererPreference, selectOfficeRenderer } from '../OfficeRendererSelection';
import type { LocalApplicationId } from '../LocalApplicationCatalog';

it.each([
  ['docx', 'automatic', false, ['word', 'libreoffice'], 'libreoffice'],
  ['docx', 'automatic', true, ['word', 'libreoffice'], 'word'],
  ['pptx', 'automatic', true, ['powerpoint', 'libreoffice'], 'powerpoint'],
  ['docx', 'automatic', false, ['word'], undefined],
  ['docx', 'word-powerpoint', false, ['word', 'libreoffice'], 'word'],
  ['pptx', 'word-powerpoint', false, ['libreoffice'], 'libreoffice'],
  ['docx', 'libreoffice', true, ['word', 'libreoffice'], 'libreoffice'],
  ['docx', 'libreoffice', true, ['word'], 'word'],
  ['pptx', 'automatic', true, [], undefined],
] as const)('selects %s / %s with COM automatic=%s from %j as %s without starting an app', async (kind, preferred, automaticWindowsCom, available, expected) => {
  const candidate = vi.fn(async (id: LocalApplicationId) => (available as readonly string[]).includes(id)
    ? { id, path: `inert-${id}`, sha256: 'a'.repeat(64), bytes: 1 } : undefined);
  expect(await selectOfficeRenderer(kind, { preferred, automaticWindowsCom }, { candidate })).toBe(expected);
  expect(candidate.mock.calls[0][0]).toBe(preferred === 'libreoffice' || !automaticWindowsCom && preferred !== 'word-powerpoint' ? 'libreoffice' : kind === 'docx' ? 'word' : 'powerpoint');
});
it('parses only the renderer preference vocabulary, without accepting executable paths or permissions', () => {
  expect(officeRendererPreference('word-powerpoint')).toBe('word-powerpoint');
  expect(officeRendererPreference('libreoffice')).toBe('libreoffice');
  for (const value of [undefined, null, 'C:\\tools\\app.exe', { allowCommands: true }]) expect(officeRendererPreference(value)).toBe('automatic');
});
