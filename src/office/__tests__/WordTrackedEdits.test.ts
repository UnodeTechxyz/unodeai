import { describe, expect, it } from 'vitest';
import { resolveWordAuthor, wordRevisionDate } from '../word/WordAuthor';
import { checkWordAnnotations, wordAnnotationFacts, WordIdAllocator } from '../word/WordIdAllocator';
import { LocalApplicationCatalog, registryQueryValue } from '../LocalApplicationCatalog';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const doc = (body: string) => `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;

describe('W2 author (design 4.5)', () => {
  it('uses the setting, then the cached Word user name, then the member name; initials and limits', () => {
    expect(resolveWordAuthor({ authorName: ' Dana  Q Reviewer Extra ', memberName: 'Writer', wordUserName: 'Word Person' })).toEqual({ name: 'Dana  Q Reviewer Extra (via Writer)', initials: 'DQR', source: 'setting' });
    expect(resolveWordAuthor({ authorName: '', memberName: 'Writer', wordUserName: 'word person' })).toEqual({ name: 'word person (via Writer)', initials: 'WP', source: 'word-user-name' });
    expect(resolveWordAuthor({ authorName: '\u0007', memberName: 'Writer\u0000' })).toEqual({ name: 'Writer (UnodeAi)', initials: 'UA', source: 'member-name' });
    expect([...resolveWordAuthor({ authorName: '名'.repeat(300), memberName: 'W' }).name]).toHaveLength(255);
    expect(wordRevisionDate(new Date('2026-11-21T08:00:00.987Z'))).toBe('2026-11-21T08:00:00Z');
  });
  it('detection caches the Word user name only on Windows with Word detected, through the fixed export reader', async () => {
    const line = (value: Buffer) => Buffer.concat([Buffer.from('\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Office\\Common\\UserInfo\r\n    UserName    REG_SZ    '), value, Buffer.from('\r\n\r\n')]);
    expect(registryQueryValue(line(Buffer.from('Dana Q Reviewer')), 'UserName')).toBe('Dana Q Reviewer');
    const gbk = Buffer.from([0xd5, 0xc5, 0xc8, 0xfd]); // "张三" in code page 936, as reg.exe writes it to a pipe on a Chinese system
    expect(registryQueryValue(line(gbk), 'UserName')).toBeUndefined(); expect(registryQueryValue(line(gbk), 'UserName', '936')).toBe('张三');
    expect(registryQueryValue(Buffer.from('    Other    REG_SZ    x'), 'UserName')).toBeUndefined();
    let reads = 0; const word = (platform: NodeJS.Platform, found: boolean) => new LocalApplicationCatalog({ platform, env: {}, registryValue: async () => undefined,
      resolveExecutable: command => { if (found && command === 'pandoc') return process.execPath; throw new Error('missing'); }, officeUserName: async () => { reads++; return 'Cached Name'; } });
    const none = word('win32', false); await none.detect(); expect(none.wordUserName()).toBeUndefined(); expect(reads).toBe(0);
    const linux = word('linux', true); await linux.detect(); expect(linux.wordUserName()).toBeUndefined(); expect(reads).toBe(0);
  });
});

describe('W2 annotation IDs (design 13.1)', () => {
  it('allocates above every decimal ID in every part and refuses beyond the Word range', () => {
    const ids = new WordIdAllocator([wordAnnotationFacts(doc('<w:p><w:bookmarkStart w:id="40" w:name="b"/><w:bookmarkEnd w:id="40"/><w:ins w:id="7"/></w:p>')), wordAnnotationFacts(`<w:comments xmlns:w="${W}"><w:comment w:id="55"/></w:comments>`)]);
    expect([ids.allocate(), ids.allocate()]).toEqual(['56', '57']);
    const full = new WordIdAllocator([wordAnnotationFacts(doc('<w:p><w:ins w:id="2147483647"/></w:p>'))]); expect(() => full.allocate()).toThrow('word-id-space-exhausted');
  });
  it('accepts existing bookmarks and comments beside a new revision and a new comment; refuses a conflicting definition, a broken pair or a dangling reference', () => {
    const before = [wordAnnotationFacts(doc('<w:p><w:bookmarkStart w:id="1" w:name="b"/><w:commentRangeStart w:id="2"/><w:r><w:t>x</w:t></w:r><w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r><w:bookmarkEnd w:id="1"/></w:p>')),
      wordAnnotationFacts(`<w:comments xmlns:w="${W}"><w:comment w:id="2"/></w:comments>`)];
    const own = new Set(['3', '4']);
    const good = [wordAnnotationFacts(doc('<w:p><w:bookmarkStart w:id="1" w:name="b"/><w:commentRangeStart w:id="2"/><w:ins w:id="3"><w:r><w:t>y</w:t></w:r></w:ins><w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="4"/><w:commentRangeEnd w:id="4"/><w:r><w:commentReference w:id="4"/></w:r></w:p>')),
      wordAnnotationFacts(`<w:comments xmlns:w="${W}"><w:comment w:id="2"/><w:comment w:id="4"/></w:comments>`)];
    expect(checkWordAnnotations(before, good, own)).toBe(true);
    const conflict = [wordAnnotationFacts(doc('<w:p><w:ins w:id="3"/><w:del w:id="3"/><w:bookmarkStart w:id="1" w:name="b"/><w:bookmarkEnd w:id="1"/></w:p>')), before[1]];
    expect(checkWordAnnotations(before, conflict, own)).toBe(false);
    expect(checkWordAnnotations(before, [wordAnnotationFacts(doc('<w:p><w:bookmarkStart w:id="1" w:name="b"/></w:p>')), before[1]], own)).toBe(false);
    expect(checkWordAnnotations(before, [wordAnnotationFacts(doc('<w:p><w:r><w:commentReference w:id="9"/></w:r></w:p>')), before[1]], own)).toBe(false);
    expect(checkWordAnnotations(before, [wordAnnotationFacts(doc('<w:p><w:ins w:id="2"/></w:p>')), before[1]], new Set(['2']))).toBe(false);
  });
});
