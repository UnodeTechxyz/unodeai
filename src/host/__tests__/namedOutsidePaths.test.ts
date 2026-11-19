import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_NAMED_OUTSIDE_PATHS, namedOutsidePaths } from '../namedOutsidePaths';

const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

/** A disk that holds exactly these paths, compared by the given rules. */
function disk(host: path.PlatformPath, ...paths: string[]) {
  const held = paths.map((entry) => host.resolve(entry));
  const windows = host.sep === '\\';
  return (target: string) => held.some((entry) => (windows ? entry.toLowerCase() === target.toLowerCase() : entry === target));
}

// v0.9.100 (field, 4523a765): the paths a person's message names, so a request offers Grant access when it starts.
describe('the outside paths a message names', () => {
  it('finds Windows paths, drops trailing punctuation, and skips the workspace and its children', () => {
    const exists = disk(path.win32, 'C:\\AI\\InfiniteCompute\\WorkingDocuments', 'C:\\AI\\InfiniteCompute\\WorkingDocuments\\lease.docx',
      'C:\\AI\\runs', 'C:\\AI\\runs\\output', 'C:\\AI\\runs\\workspace', 'C:\\AI\\runs\\workspace\\notes.md');
    const text = 'Read C:\\AI\\InfiniteCompute\\WorkingDocuments\\lease.docx, then save the summary to C:\\AI\\runs\\output. '
      + 'Do not touch C:\\AI\\runs\\workspace\\notes.md or C:\\.';
    expect(namedOutsidePaths(text, ['C:\\AI\\runs\\workspace'], path.win32, exists)).toEqual([
      'C:\\AI\\InfiniteCompute\\WorkingDocuments\\lease.docx',
      'C:\\AI\\runs\\output',
    ]);
  });

  // Audit of aaf794a2 (1): an unquoted path was cut at its first space and the notice named another folder.
  it('reads an unquoted path across its spaces, to the longest reading that exists or can be made', () => {
    const exists = disk(path.win32, 'C:\\Users\\Jane', 'C:\\Users\\Jane Doe', 'C:\\Users\\Jane Doe\\output',
      'C:\\Contracts', 'C:\\Contracts\\Lease Agreement.docx');
    expect(namedOutsidePaths('Save to C:\\Users\\Jane Doe\\output\\report.docx and tell me when it is there.', ['C:\\ws'], path.win32, exists))
      .toEqual(['C:\\Users\\Jane Doe\\output\\report.docx']);
    expect(namedOutsidePaths('Read C:\\Contracts\\Lease Agreement.docx? Then stop.', ['C:\\ws'], path.win32, exists))
      .toEqual(['C:\\Contracts\\Lease Agreement.docx']);
    // A reading with no folder that exists is not offered: no notice is better than one for another folder.
    expect(namedOutsidePaths('Save to C:\\Nowhere Here\\out\\report.docx please', ['C:\\ws'], path.win32, exists)).toEqual([]);
    // A new folder cannot be told from the words after it, so it is not offered either.
    expect(namedOutsidePaths('Make C:\\Contracts\\Q3 Summary for me', ['C:\\ws'], path.win32, exists)).toEqual([]);
    // An existing shorter neighbour is not offered when the path goes on into another existing folder.
    expect(namedOutsidePaths('Make C:\\Users\\Jane Doe\\new folder please', ['C:\\ws'], path.win32, exists)).toEqual([]);
    // Audit of 5b4180ec: a file still to be made may hold a space in its name.
    const noLease = disk(path.win32, 'C:\\Out');
    expect(namedOutsidePaths('Save to C:\\Out\\Lease Agreement.docx please', ['C:\\ws'], path.win32, noLease))
      .toEqual(['C:\\Out\\Lease Agreement.docx']);
    // Beside an existing `Lease` nothing on disk tells the two apart, so neither is offered.
    const withLease = disk(path.win32, 'C:\\Out', 'C:\\Out\\Lease');
    expect(namedOutsidePaths('Save to C:\\Out\\Lease Agreement.docx please', ['C:\\ws'], path.win32, withLease)).toEqual([]);
    // Once that file exists, it is the one named.
    const withBoth = disk(path.win32, 'C:\\Out', 'C:\\Out\\Lease', 'C:\\Out\\Lease Agreement.docx');
    expect(namedOutsidePaths('Save to C:\\Out\\Lease Agreement.docx please', ['C:\\ws'], path.win32, withBoth))
      .toEqual(['C:\\Out\\Lease Agreement.docx']);
    const posix = disk(path.posix, '/home/jane', '/home/jane/My Documents', '/home/jane/My Documents/report.pdf');
    expect(namedOutsidePaths('Read /home/jane/My Documents/report.pdf and summarise it.', ['/home/jane/ws'], path.posix, posix))
      .toEqual(['/home/jane/My Documents/report.pdf']);
  });

  it('on a real disk, names the folder with the space and never its shorter neighbour', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-named-paths-')));
    cleanup.push(root);
    await fs.mkdir(path.join(root, 'Jane'));
    await fs.mkdir(path.join(root, 'Jane Doe', 'output'), { recursive: true });
    const target = path.join(root, 'Jane Doe', 'output', 'report.docx');
    expect(namedOutsidePaths(`Save the report to ${target} and tell me.`, [path.join(root, 'workspace')])).toEqual([target]);
    // Audit of 5b4180ec: a new file with a space in its name, beside a folder its first word names.
    const lease = path.join(root, 'Lease Agreement.docx');
    expect(namedOutsidePaths(`Save to ${lease} please`, [path.join(root, 'workspace')])).toEqual([lease]);
    await fs.mkdir(path.join(root, 'Lease'));
    expect(namedOutsidePaths(`Save to ${lease} please`, [path.join(root, 'workspace')])).toEqual([]);
  });

  it('keeps a quoted path whole, and reads forward slashes', () => {
    const exists = disk(path.win32, 'C:\\data', 'C:\\data\\out');
    const text = 'Use "C:\\Program Files\\Data\\in put.csv" and c:/data/out/.';
    // Quoted paths come first, then the others; a path keeps the spelling it was typed in.
    expect(namedOutsidePaths(text, ['C:\\ws'], path.win32, exists)).toEqual([
      'C:\\Program Files\\Data\\in put.csv',
      'c:\\data\\out',
    ]);
  });

  // Security re-audit of 77d998cf: checking `\\server\share\...` on disk made Windows open SMB to that server and held
  // the extension host 21 s for an address that did not answer. A pasted message chooses the computer.
  it('never checks or offers a share, a device or an automounted host, quoted or not', () => {
    const asked: string[] = [];
    const winDisk = disk(path.win32, 'C:\\out', '\\\\server\\share', '\\\\server\\share\\in');
    const winExists = (target: string) => { asked.push(target); return winDisk(target); };
    const text = 'Read \\\\server\\share\\in\\lease.docx and "\\\\server\\share\\in\\b.docx", `//server/share/c.docx`, '
      + '\\\\?\\UNC\\server\\share\\d.docx, \\\\.\\pipe\\x and \\\\?\\C:\\out\\e.docx, then save to C:\\out\\summary.docx.';
    expect(namedOutsidePaths(text, ['C:\\ws'], path.win32, winExists)).toEqual(['C:\\out\\summary.docx']);
    expect(asked.filter((target) => /^[\\/]{2}/.test(target))).toEqual([]);
    asked.length = 0;
    const posixDisk = disk(path.posix, '/net/host/share', '/home/me/out');
    const posixExists = (target: string) => { asked.push(target); return posixDisk(target); };
    expect(namedOutsidePaths('Read /net/host/share/a.docx and "/net/host/share/b.docx", save to /home/me/out/s.docx.',
      ['/home/me/ws'], path.posix, posixExists)).toEqual(['/home/me/out/s.docx']);
    // Audit of 362e990b: a spelling that resolves into /net is one too, quoted or not, and in any case.
    expect(namedOutsidePaths('Read /tmp/../net/host/share/c.docx, "/home/me/../../net/host/share/d.docx" and '
      + '/NET/host/share/e.docx, /./Net/host/share/f.docx.', ['/home/me/ws'], path.posix, posixExists)).toEqual([]);
    expect(asked.filter((target) => /^\/net(?:\/|$)/i.test(target))).toEqual([]);
    asked.length = 0;
    // On Windows a folder climbed out of cannot become a share: `..` stops at the drive root.
    expect(namedOutsidePaths('Save to C:\\out\\..\\..\\out\\g.docx', ['C:\\ws'], path.win32, winExists)).toEqual(['C:\\out\\g.docx']);
  });

  it('counts one path once, whatever its case on Windows', () => {
    const exists = disk(path.win32, 'C:\\Out');
    expect(namedOutsidePaths('C:\\Out\\a.docx and c:\\out\\A.DOCX', ['C:\\ws'], path.win32, exists)).toEqual(['C:\\Out\\a.docx']);
  });

  it('reads POSIX paths by POSIX rules: two segments at least, never a URL, a ratio or a Windows spelling', () => {
    const exists = disk(path.posix, '/home/me/output', '/tmp/in', '/tmp/in/lease.docx');
    const text = 'Save to /home/me/output/summary.docx, read /tmp/in/lease.docx; see https://x.example/a/b, '
      + 'a 3/4 split, and/or C:\\Windows\\x. Skip /home/me/ws/inside.md and /etc.';
    expect(namedOutsidePaths(text, ['/home/me/ws'], path.posix, exists)).toEqual(['/home/me/output/summary.docx', '/tmp/in/lease.docx']);
    expect(namedOutsidePaths('a "/Users/me/My Docs/x.docx" file', ['/Users/me/ws'], path.posix, exists)).toEqual(['/Users/me/My Docs/x.docx']);
  });

  it('offers no more than the cap from one message', () => {
    const exists = disk(path.win32, 'C:\\out');
    const text = Array.from({ length: 12 }, (_, index) => `C:\\out\\f${index}.txt`).join(' ');
    expect(namedOutsidePaths(text, ['C:\\ws'], path.win32, exists)).toHaveLength(MAX_NAMED_OUTSIDE_PATHS);
  });
});
