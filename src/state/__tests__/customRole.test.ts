import { describe, expect, it } from 'vitest';
import { cleanCustomRole, CUSTOM_ROLE_MAX_LENGTH } from '../customRole';

const a80 = 'a'.repeat(80);

describe('cleanCustomRole: the one rule Builder saves with and the team file loads with', () => {
  it.each<[string, unknown, string]>([
    ['Chinese text', '图像编辑', '图像编辑'],
    ['accented text', 'Éditeur vidéo', 'Éditeur vidéo'],
    ['a two-word name', 'System Integrator', 'System Integrator'],
    ['exactly 80 characters', a80, a80],
    ['81 characters (cut to 80)', `${a80}b`, a80],
    ['leading and trailing spaces', '  Image and Video Editor  ', 'Image and Video Editor'],
    ['an embedded tab', 'System\tIntegrator', 'SystemIntegrator'],
    ['an embedded newline', 'System\nIntegrator', 'SystemIntegrator'],
    ['an embedded NUL', 'System\u0000Integrator', 'SystemIntegrator'],
    ['DEL and C1 controls', 'A\u007fB\u0080C\u009fD', 'ABCD'],
    ['only control characters', '\u0000\t\n\r\u007f\u0085', ''],
    ['only spaces', '   ', ''],
    ['a path-like name (text, not a path)', '../x', '../x'],
    ['separators', 'a/b\\c', 'a/b\\c'],
    ['built-in pm', 'pm', 'pm'],
    ['PM (text)', 'PM', 'PM'],
    ['built-in solo', 'solo', 'solo'],
    ['Solo (text)', 'Solo', 'Solo'],
    ['a NUL inside pm', 'p\u0000m', 'pm'],
    ['a non-string', 42, ''],
    ['undefined', undefined, ''],
  ])('%s', (_label, input, expected) => {
    expect(cleanCustomRole(input)).toBe(expected);
  });

  it('is idempotent at the 80-character boundary where a cut ends on a space (R1)', () => {
    const boundary = `${'a'.repeat(79)} b`;
    const once = cleanCustomRole(boundary);
    expect(once).toBe('a'.repeat(79));
    expect(cleanCustomRole(once)).toBe(once);
  });

  it('never splits a surrogate pair at the cut, and stays idempotent there', () => {
    const emojiAtCut = `${'a'.repeat(79)}😀tail`;
    const once = cleanCustomRole(emojiAtCut);
    expect(once).toBe('a'.repeat(79));
    expect(cleanCustomRole(once)).toBe(once);
    const emojiInside = `${'a'.repeat(78)}😀tail`;
    expect(cleanCustomRole(emojiInside)).toBe(`${'a'.repeat(78)}😀`);
  });

  it('is idempotent and bounded for a sweep of awkward inputs', () => {
    const pieces = ['a', ' ', '\t', '\u0000', '\u0085', '图', '😀', ' ', '\n', 'Z'];
    for (let length = 70; length <= 90; length++) {
      for (let seed = 0; seed < pieces.length; seed++) {
        const input = Array.from({ length }, (_, index) => pieces[(index * 7 + seed) % pieces.length]).join('');
        const once = cleanCustomRole(input);
        expect(once.length).toBeLessThanOrEqual(CUSTOM_ROLE_MAX_LENGTH);
        expect(cleanCustomRole(once)).toBe(once);
        expect(once).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      }
    }
  });
});
