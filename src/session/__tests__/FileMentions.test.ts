import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseMentions, expandFileMentions, FileReader, RealPathResolver } from '../FileMentions';

const root = path.resolve('/repo');

function reader(files: Record<string, string>): FileReader {
  return async (absPath: string) => {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    if (rel in files) return files[rel];
    throw new Error('ENOENT');
  };
}

// Identity realpath for in-workspace files; `links` simulates symlinks/junctions whose target may
// resolve OUTSIDE the workspace (keyed by workspace-relative mention path).
function realpathWith(links: Record<string, string> = {}): RealPathResolver {
  return async (absPath: string) => {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    if (rel === '') return root; // the root resolves to itself
    if (rel in links) return links[rel];
    return absPath;
  };
}

describe('parseMentions', () => {
  it('extracts unique @path tokens and strips trailing punctuation', () => {
    expect(parseMentions('look at @src/a.ts and @src/b.ts.')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(parseMentions('@a @a @a')).toEqual(['a']);
    expect(parseMentions('no mentions here')).toEqual([]);
    expect(parseMentions('email foo@bar.com is not a leading mention')).toEqual([]);
  });
});

describe('expandFileMentions', () => {
  it('appends an attached_files block with resolved file contents', async () => {
    const out = await expandFileMentions(
      'explain @src/a.ts',
      root,
      reader({ 'src/a.ts': 'export const x = 1;' }),
      realpathWith()
    );
    expect(out).toMatch(/explain @src\/a\.ts/);
    expect(out).toMatch(/<attached_files>/);
    expect(out).toMatch(/--- src\/a\.ts ---/);
    expect(out).toMatch(/export const x = 1;/);
  });

  it('leaves text unchanged when there are no mentions', async () => {
    const out = await expandFileMentions('just a question', root, reader({}), realpathWith());
    expect(out).toBe('just a question');
  });

  it('silently skips unreadable mentions (e.g. @teammate) and returns text unchanged', async () => {
    const out = await expandFileMentions('hey @reviewer take a look', root, reader({}), realpathWith());
    expect(out).toBe('hey @reviewer take a look');
  });

  it('blocks path traversal outside the workspace', async () => {
    const out = await expandFileMentions('@../../etc/passwd', root, async () => 'SECRET', realpathWith());
    expect(out).toBe('@../../etc/passwd'); // not attached
    expect(out).not.toMatch(/SECRET/);
  });

  it('blocks a symlink/junction that resolves outside the workspace', async () => {
    // `@secret.txt` passes the string-level containment check, but realpath shows it points outside.
    const out = await expandFileMentions(
      'read @secret.txt',
      root,
      async () => 'TOP-SECRET',
      realpathWith({ 'secret.txt': path.resolve('/etc/passwd') })
    );
    expect(out).toBe('read @secret.txt'); // not attached
    expect(out).not.toMatch(/TOP-SECRET/);
  });

  it('attaches a symlink that resolves to a file still inside the workspace', async () => {
    const out = await expandFileMentions(
      'read @link.ts',
      root,
      reader({ 'real/a.ts': 'inside = true' }),
      realpathWith({ 'link.ts': path.join(root, 'real', 'a.ts') })
    );
    expect(out).toMatch(/<attached_files>/);
    expect(out).toMatch(/inside = true/);
  });

  it('returns text unchanged when the workspace root itself cannot be realpath-resolved', async () => {
    const out = await expandFileMentions('explain @src/a.ts', root, reader({ 'src/a.ts': 'x' }), async () => {
      throw new Error('ENOENT');
    });
    expect(out).toBe('explain @src/a.ts');
  });

  it('truncates a file larger than the per-file cap', async () => {
    const big = 'y'.repeat(25_000);
    const out = await expandFileMentions('@src/big.ts', root, reader({ 'src/big.ts': big }), realpathWith());
    expect(out).toMatch(/truncated/);
    expect(out.length).toBeLessThan(big.length + 200);
  });
});
