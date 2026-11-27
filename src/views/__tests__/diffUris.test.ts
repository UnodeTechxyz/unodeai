import { describe, expect, it } from 'vitest';
import {
  checkpointDiffTitle,
  checkpointRef,
  laneBaseRef,
  laneDiffTitle,
  parseCheckpointRef,
  parseLaneBaseRef,
} from '../diffUris';

describe('checkpoint diff refs', () => {
  it('round-trips an identity', () => {
    const ref = checkpointRef({ id: 12, path: 'src/app.ts' }, 'before');
    expect(ref).toEqual({ path: 'src/app.ts', query: '12:before' });
    expect(parseCheckpointRef(ref.query)).toEqual({ id: 12, side: 'before' });
    expect(parseCheckpointRef(checkpointRef({ id: 0, path: 'a' }, 'after').query)).toEqual({ id: 0, side: 'after' });
  });

  it('fails closed on anything it did not write', () => {
    // These address recorded file contents. A parser that guesses is a disclosure bug, so every
    // malformed form must be undefined rather than a best-effort id.
    for (const query of [
      '', '12', 'before', '12:', ':before', '12:sideways', '-1:before', '1.5:before', '12:before:after',
      '1e3:before', ' 12:before', '12:before ', '99999999999999999999:before', 'NaN:before',
    ]) {
      expect(parseCheckpointRef(query), query).toBeUndefined();
    }
  });
});

const SHA = 'a'.repeat(39) + '9';

describe('lane base refs', () => {
  it('round-trips a pinned commit', () => {
    const ref = laneBaseRef({ baseSha: SHA, file: 'src/app.ts' });
    expect(parseLaneBaseRef(ref.query, ref.path)).toEqual({ baseSha: SHA, file: 'src/app.ts' });
  });

  it('strips the leading slash a URI path picks up', () => {
    expect(parseLaneBaseRef(SHA, '/src/app.ts')).toEqual({ baseSha: SHA, file: 'src/app.ts' });
  });

  it('accepts nothing but a full commit sha', () => {
    // This value is interpolated into `git show <sha>:<file>`. A branch name, a range, a short sha,
    // or anything carrying an option or a separator must not survive the parser.
    for (const query of [
      '', 'HEAD', 'main', SHA.slice(0, 7), SHA + '0', SHA.toUpperCase(), `${SHA} `, `--upload-pack=x`,
      `${SHA}:evil`, `${SHA}^`, 'a'.repeat(40).replace('a', 'z'), '../../etc/passwd',
    ]) {
      expect(parseLaneBaseRef(query, 'src/app.ts'), query).toBeUndefined();
    }
  });

  it('fails closed without a file', () => {
    expect(parseLaneBaseRef(SHA, '')).toBeUndefined();
    expect(parseLaneBaseRef(SHA, '/')).toBeUndefined();
  });
});

describe('diff titles', () => {
  it('names the file once and says which two versions are compared', () => {
    expect(checkpointDiffTitle('src/deep/app.ts', 'Developer', true)).toBe("app.ts — before Developer's edit ↔ current file");
    expect(checkpointDiffTitle('src/deep/app.ts', 'Developer', false)).toBe("app.ts — before Developer's edit ↔ after");
    // The tab outlives the branch position it was opened against, so the title names the commit.
    expect(laneDiffTitle('src/deep/app.ts', 'Developer', SHA)).toBe(`app.ts — base ${SHA.slice(0, 7)} ↔ Developer's lane`);
  });
});
