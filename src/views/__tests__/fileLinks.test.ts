import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyLinkDestination, fileReferenceId, fileReferenceScope, findFileLink } from '../fileLinks';
import { renderMarkdown, type MarkdownInline } from '../markdown';

/*
 * v0.9.97 (CHANGELOG [Unreleased] "File links in replies"; USAGE "File links in a reply"): a reply's link to a
 * workspace file is a file link; another kind of link is text with the reason. Every rule here is asserted under
 * explicit Windows and POSIX path rules, so neither half depends on the machine running the test.
 */
const win = (destination: string) => classifyLinkDestination(destination, path.win32);
const posix = (destination: string) => classifyLinkDestination(destination, path.posix);
const both = (destination: string) => [win(destination), posix(destination)];

const FIELD_FILE = 'PolyFlow_Compliance_Working_Draft_Merged.md';

describe('a reply link destination under the host path rules', () => {
  it('reads the field file name, relative and Windows absolute, as a file and never as a "#" stand-in', () => {
    for (const read of both(FIELD_FILE)) {
      expect(read).toEqual({ kind: 'file', path: FIELD_FILE, absolute: false });
    }
    expect(win(`C:\\Users\\dev\\PolyFlow\\${FIELD_FILE}`)).toEqual({
      kind: 'file', path: `C:\\Users\\dev\\PolyFlow\\${FIELD_FILE}`, absolute: true,
    });
    expect(win(`C:/Users/dev/PolyFlow/${FIELD_FILE}`)).toMatchObject({ kind: 'file', absolute: true });
    expect(posix(`/home/dev/polyflow/${FIELD_FILE}`)).toEqual({ kind: 'file', path: `/home/dev/polyflow/${FIELD_FILE}`, absolute: true });
  });

  it('does not take a drive letter for a URI scheme, and refuses what depends on a current drive or folder', () => {
    expect(win('C:notes.md')).toEqual({ kind: 'refused', reason: 'drive-relative' });
    expect(win('C:')).toEqual({ kind: 'refused', reason: 'drive-relative' });
    expect(win('\\notes.md')).toEqual({ kind: 'refused', reason: 'drive-relative' });
    expect(win('/home/dev/notes.md')).toEqual({ kind: 'refused', reason: 'drive-relative' });
    // On a POSIX host a Windows drive path is not a path on this computer.
    expect(posix('C:\\Users\\dev\\notes.md')).toEqual({ kind: 'refused', reason: 'foreign-path' });
    expect(posix('C:notes.md')).toEqual({ kind: 'refused', reason: 'foreign-path' });
  });

  it('refuses network shares and device paths in either slash', () => {
    for (const read of both('\\\\server\\share\\notes.md')) expect(read).toEqual({ kind: 'refused', reason: 'network-path' });
    for (const read of both('//server/share/notes.md')) expect(read).toEqual({ kind: 'refused', reason: 'network-path' });
    for (const read of both('\\\\?\\C:\\notes.md')) expect(read).toEqual({ kind: 'refused', reason: 'device-path' });
    for (const read of both('\\\\.\\pipe\\agent')) expect(read).toEqual({ kind: 'refused', reason: 'device-path' });
    for (const read of both('//./COM1')) expect(read).toEqual({ kind: 'refused', reason: 'device-path' });
  });

  it('refuses every scheme but http(s) with //, and keeps http(s) a web link as before', () => {
    expect(both('file:///C:/repo/notes.md')).toEqual([{ kind: 'refused', reason: 'file-uri' }, { kind: 'refused', reason: 'file-uri' }]);
    for (const [destination, scheme] of [
      ['command:workbench.action.terminal.new', 'command'],
      ['javascript:alert(1)', 'javascript'],
      ['data:text/html,<script>x</script>', 'data'],
      ['vscode://file/c:/repo/notes.md', 'vscode'],
      ['vscode-insiders://file/x', 'vscode-insiders'],
      ['mailto:dev@example.com', 'mailto'],
      ['HTTP:notes.md', 'http'],
    ] as const) {
      for (const read of both(destination)) expect(read).toEqual({ kind: 'refused', reason: 'scheme', scheme });
    }
    for (const read of both('https://example.com/docs')) expect(read).toEqual({ kind: 'web', href: 'https://example.com/docs' });
    for (const read of both('HTTP://example.com')) expect(read).toEqual({ kind: 'web', href: 'HTTP://example.com' });
    for (const read of both('#section')) expect(read).toEqual({ kind: 'refused', reason: 'in-page' });
  });

  it('decodes once: spaces, Chinese and a literal percent come through; malformed and double escapes do not', () => {
    for (const read of both('docs/My%20Notes.md')) expect(read).toMatchObject({ kind: 'file', path: 'docs/My Notes.md' });
    for (const read of both('docs/%E5%90%88%E8%A7%84%20%E8%8D%89%E7%A8%BF.md')) expect(read).toMatchObject({ kind: 'file', path: 'docs/合规 草稿.md' });
    for (const read of both('docs/合规 草稿(1).md')) expect(read).toMatchObject({ kind: 'file', path: 'docs/合规 草稿(1).md' });
    for (const read of both('docs/100%25.md')) expect(read).toMatchObject({ kind: 'file', path: 'docs/100%.md' });
    for (const destination of [
      '%2e%2e/secret.md', // an encoded parent
      '%2E%2E%2Fsecret.md',
      'docs%2f..%2fsecret.md', // an encoded separator
      'docs%5Csecret.md',
      'docs/a%3Ab.md', // an encoded colon: a drive or a stream
      '%252e%252e/secret.md', // encoded twice: refused, never decoded again
      'docs/%zz.md', // malformed
      'docs/%E0%A4.md', // not UTF-8
      'docs/a%00.md', // an encoded NUL
      'docs/%E2%80%AEdm.txt', // a decoded bidi override
      'docs/%C2%85.md', // a decoded C1 control
    ]) {
      for (const read of both(destination)) expect(read, destination).toEqual({ kind: 'refused', reason: 'encoding' });
    }
    for (const destination of ['docs/a\u0000.md', 'docs/\u202Egnp.md', 'docs/a\u0007.md']) {
      for (const read of both(destination)) expect(read).toEqual({ kind: 'refused', reason: 'control' });
    }
  });

  it('refuses every real parent segment and keeps a child named ..name', () => {
    for (const destination of ['../secret.md', 'docs/../../secret.md', 'docs/..', '..']) {
      for (const read of both(destination)) expect(read, destination).toEqual({ kind: 'refused', reason: 'parent' });
    }
    expect(win('docs\\..\\secret.md')).toEqual({ kind: 'refused', reason: 'parent' });
    expect(win('C:\\repo\\..\\secret.md')).toEqual({ kind: 'refused', reason: 'parent' });
    // On POSIX a backslash is part of a name, so this is one odd name inside the folder, not a parent.
    expect(posix('docs\\..\\secret.md')).toMatchObject({ kind: 'file', path: 'docs\\..\\secret.md' });
    for (const destination of ['..name/notes.md', 'docs/..hidden.md', '...md']) {
      expect(posix(destination), destination).toMatchObject({ kind: 'file', path: destination });
    }
    expect(win('..name\\notes.md')).toMatchObject({ kind: 'file', path: '..name\\notes.md' });
  });

  it('applies the Windows name rules on a Windows host only', () => {
    for (const destination of ['docs/notes.md:secret', 'NUL', 'docs/con.md', 'docs/notes.md.', 'docs/notes.md ']) {
      expect(win(destination), destination).toEqual({ kind: 'refused', reason: 'windows-name' });
      expect(posix(destination).kind, destination).toBe('file');
    }
    // Before any slash, a name and a colon read as a scheme on every host, unless what follows is a line.
    for (const read of both('notes.md:secret')) expect(read).toEqual({ kind: 'refused', reason: 'scheme', scheme: 'notes.md' });
    for (const read of both('README.md:12')) expect(read).toEqual({ kind: 'file', path: 'README.md', absolute: false, position: { line: 12 } });
    for (const read of both('README.md:12:3')) expect(read).toMatchObject({ path: 'README.md', position: { line: 12, column: 3 } });
  });

  it('parses a place apart from the path, after the drive colon, and keeps another location only to name it', () => {
    for (const read of both('docs/a.md#L12')) expect(read).toEqual({ kind: 'file', path: 'docs/a.md', absolute: false, position: { line: 12 } });
    for (const read of both('docs/a.md#L12C3')) expect(read).toMatchObject({ path: 'docs/a.md', position: { line: 12, column: 3 } });
    for (const read of both('docs/a.md#L12-L20')) expect(read).toMatchObject({ path: 'docs/a.md', position: { line: 12 } });
    for (const read of both('docs/a.md:12')) expect(read).toMatchObject({ path: 'docs/a.md', position: { line: 12 } });
    for (const read of both('docs/a.md:12:4')) expect(read).toMatchObject({ path: 'docs/a.md', position: { line: 12, column: 4 } });
    for (const read of both('docs/a.md#L0')) expect(read).toMatchObject({ position: { line: 1 } });
    expect(win('C:\\repo\\a.md:7')).toEqual({ kind: 'file', path: 'C:\\repo\\a.md', absolute: true, position: { line: 7 } });
    expect(win('C:\\repo\\a.md#L7')).toMatchObject({ path: 'C:\\repo\\a.md', position: { line: 7 } });
    for (const read of both('docs/a.md#intro')) expect(read).toEqual({ kind: 'file', path: 'docs/a.md', absolute: false, unsupportedFragment: 'intro' });
    // An unbounded line is not a place: it stays part of the name, which on Windows is refused.
    expect(posix('docs/a.md:123456789')).toMatchObject({ kind: 'file', path: 'docs/a.md:123456789' });
    expect(win('docs/a.md:123456789')).toEqual({ kind: 'refused', reason: 'windows-name' });
    expect(win('docs/a%23b.md')).toMatchObject({ kind: 'file', path: 'docs/a#b.md' });
  });

  it('bounds the destination', () => {
    for (const read of both('a'.repeat(2049))) expect(read).toEqual({ kind: 'refused', reason: 'too-long' });
    for (const read of both('')) expect(read).toEqual({ kind: 'refused', reason: 'empty' });
    for (const read of both(':12')) expect(read).toEqual({ kind: 'refused', reason: 'empty' });
  });
});

describe('a file link id', () => {
  it('names the reply and a digest of the link as written, and nothing else parses as one', () => {
    const id = fileReferenceId(42, FIELD_FILE);
    expect(id).toMatch(/^42\.[0-9a-f]{16}$/);
    expect(id).not.toContain(FIELD_FILE);
    expect(fileReferenceScope(id)).toBe(42);
    expect(fileReferenceId(43, FIELD_FILE)).not.toBe(id);
    expect(fileReferenceId(42, `${FIELD_FILE}#L2`)).not.toBe(id);
    for (const forged of ['42', '42.', 'x.0123456789abcdef', '42.0123456789ABCDEF', '42.0123456789abcde', `42.${'0'.repeat(17)}`, '-1.0123456789abcdef', 'C:\\x.md']) {
      expect(fileReferenceScope(forged), forged).toBeUndefined();
    }
  });
});

describe('file links in rendered Markdown', () => {
  const spans = (text: string, scope?: number): MarkdownInline[] => {
    const [block] = renderMarkdown(text, scope === undefined ? {} : { fileReferences: scope });
    return block && block.type === 'paragraph' ? block.spans : [];
  };
  const native = path.resolve('workspace', FIELD_FILE);

  it('turns a reply\'s relative and absolute file links into file links with an id, never into "#"', () => {
    for (const destination of [FIELD_FILE, `docs/${FIELD_FILE}`, native]) {
      const [, link] = spans(`Saved [the draft](${destination}).`, 7);
      expect(link).toEqual({ type: 'fileLink', text: 'the draft', target: destination, ref: fileReferenceId(7, destination) });
    }
    const rendered = JSON.stringify(renderMarkdown(`[a](${FIELD_FILE}) [b](${native})`, { fileReferences: 1 }));
    expect(rendered).not.toContain('"href":"#"');
  });

  it('gives no id outside a reply, so the link is shown as text there', () => {
    expect(spans(`See [it](${FIELD_FILE}).`)[1]).toEqual({ type: 'fileLink', text: 'it', target: FIELD_FILE });
  });

  it('reads CommonMark destinations: angle brackets with spaces, balanced parentheses and a title', () => {
    expect(spans('[n](<docs/My Notes.md>)', 1)[0]).toMatchObject({ type: 'fileLink', target: 'docs/My Notes.md' });
    expect(spans('[n](<docs/合规 草稿.md#L3>)', 1)[0]).toMatchObject({ type: 'fileLink', target: 'docs/合规 草稿.md#L3' });
    expect(spans('[r](docs/report(1).md)', 1)[0]).toMatchObject({ type: 'fileLink', target: 'docs/report(1).md' });
    expect(spans('[r](docs/a.md "The draft")', 1)[0]).toMatchObject({ type: 'fileLink', target: 'docs/a.md' });
    // Not a link: a bare destination with a space, or an unclosed one, stays text.
    expect(spans('[x](docs/a b.md)', 1)).toEqual([{ type: 'text', text: '[x](docs/a b.md)' }]);
    expect(spans('[x](<docs/a.md)', 1)).toEqual([{ type: 'text', text: '[x](<docs/a.md)' }]);
  });

  it('keeps an http(s) link a web link and shows every other kind as text with its reason, carrying no destination', () => {
    expect(spans('[Roam](https://example.com)', 1)).toEqual([{ type: 'link', text: 'Roam', href: 'https://example.com' }]);
    for (const [destination, note] of [
      ['command:workbench.action.terminal.new', 'link not opened: command: links are not followed'],
      ['javascript:alert(1)', 'link not opened: javascript: links are not followed'],
      ['file:///C:/repo/a.md', 'link not opened: file: links are not followed; a workspace path is'],
      ['%2e%2e/secret.md', 'link not opened: the path is encoded in a way UnodeAi does not accept'],
      ['../secret.md', 'link not opened: paths with .. are not followed'],
      ['//server/share/a.md', 'link not opened: network paths are not followed'],
    ] as const) {
      expect(spans(`[x](${destination})`, 1), destination).toEqual([{ type: 'linkRefused', text: 'x', note }]);
    }
  });

  it('finds a reply\'s file link by its id in paragraphs, lists and tables', () => {
    const blocks = renderMarkdown([
      'Intro [one](docs/one.md).',
      '',
      '- item [two](docs/two.md)',
      '',
      '| File | Note |',
      '|---|---|',
      '| [three](docs/three.md) | x |',
    ].join('\n'), { fileReferences: 3 });
    for (const destination of ['docs/one.md', 'docs/two.md', 'docs/three.md']) {
      expect(findFileLink(blocks, fileReferenceId(3, destination))?.target).toBe(destination);
    }
    expect(findFileLink(blocks, fileReferenceId(4, 'docs/one.md'))).toBeUndefined();
  });
});
