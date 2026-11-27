import { describe, expect, it } from 'vitest';
import {
  beforeStateForWrite,
  parseClaudeEditIntent,
  reconstructBeforeFromEdit,
} from '../claudeCheckpointEvents';

/*---------------------------------------------------------------------------------------------
 *  The property under test is not "does it produce a before-state" — it is "does it REFUSE to
 *  produce one it cannot prove". A restore built on a wrong before-state overwrites the user's work,
 *  so every refusal case below is a feature, and the round-trip check is the thing that makes the
 *  successes trustworthy rather than plausible.
 *--------------------------------------------------------------------------------------------*/

const edit = (oldString: string, newString: string, replaceAll = false) => ({ oldString, newString, replaceAll });

describe('parseClaudeEditIntent', () => {
  it('reads an Edit in either argument spelling', () => {
    expect(parseClaudeEditIntent('Edit', { file_path: 'a.md', old_string: 'x', new_string: 'y' }))
      .toEqual({ kind: 'edit', path: 'a.md', oldString: 'x', newString: 'y', replaceAll: false });
    // The CLI has shipped both spellings; a missed one is a silently unrecorded edit.
    expect(parseClaudeEditIntent('edit', { filePath: 'a.md', oldString: 'x', newString: 'y', replaceAll: true }))
      .toEqual({ kind: 'edit', path: 'a.md', oldString: 'x', newString: 'y', replaceAll: true });
  });

  it('reads a Write, and ignores tools that do not mutate a file', () => {
    expect(parseClaudeEditIntent('Write', { file_path: 'a.md', content: 'hello' }))
      .toEqual({ kind: 'write', path: 'a.md', content: 'hello' });
    expect(parseClaudeEditIntent('Read', { file_path: 'a.md' })).toBeUndefined();
    expect(parseClaudeEditIntent('Bash', { command: 'ls' })).toBeUndefined();
    expect(parseClaudeEditIntent('Edit', { file_path: 'a.md' })).toBeUndefined(); // no strings to reverse
  });
});

describe('reconstructBeforeFromEdit — proves, or refuses', () => {
  it('reverses a single unambiguous replacement', () => {
    // after: the CLI turned "first" into "first\nsecond"
    const result = reconstructBeforeFromEdit('first\nsecond\n', edit('first\n', 'first\nsecond\n'));
    expect(result).toEqual({ ok: true, before: 'first\n' });
  });

  // Codex audit 2026-07-30, P0 against the first version of this module. It accepted replace_all and
  // verified with a forward re-apply — which proves the candidate is A preimage, not THE preimage.
  it('refuses replace_all outright: the mapping is many-to-one and the loser is the user file', () => {
    // The counterexample that broke the original: "old new" and "old old" both produce "new new",
    // so the round-trip check passed on the wrong answer and restore would have corrupted the file.
    expect(reconstructBeforeFromEdit('new new', edit('old', 'new', true)))
      .toEqual({ ok: false, reason: 'replace-all-ambiguous' });
    expect(reconstructBeforeFromEdit('new new new', edit('old', 'new', true)))
      .toEqual({ ok: false, reason: 'replace-all-ambiguous' });
  });

  it('refuses when new_string occurs more than once and the edit was not replace_all', () => {
    // Only ONE of these two "done"s was written by the edit. Picking either is a coin flip, and the
    // loser is the user's file.
    expect(reconstructBeforeFromEdit('done ... done', edit('todo', 'done')))
      .toEqual({ ok: false, reason: 'ambiguous-occurrence' });
  });

  it('refuses a pure deletion — the after-state has no anchor for the reversal', () => {
    expect(reconstructBeforeFromEdit('kept text', edit('removed', '')))
      .toEqual({ ok: false, reason: 'empty-new-string' });
  });

  it('refuses when the event does not describe this file at all', () => {
    expect(reconstructBeforeFromEdit('unrelated contents', edit('a', 'b')))
      .toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses when the reconstruction does not regenerate the observed bytes', () => {
    // old_string occurs in the after-state ahead of the edit site, so re-applying the (single)
    // replacement to the reversal hits the wrong occurrence and lands somewhere else. Reversal alone
    // looks fine here; only the round-trip catches it.
    const after = 'alpha beta';
    const result = reconstructBeforeFromEdit(after, edit('alpha', 'beta'));
    if (result.ok) {
      // If it ever claims success it must be genuinely sound: re-applying must give back `after`.
      expect(result.before.replace('alpha', 'beta')).toBe(after);
    } else {
      expect(result.reason).toBe('roundtrip-mismatch');
    }
  });

  // THE test the first version needed and did not have. The old sweep asserted "if it succeeds, the
  // round-trip holds" — which is precisely the insufficient property that let the P0 through. This one
  // starts from a KNOWN original, applies the edit forward, and demands the reconstruction equal that
  // original. Exhaustive over a two-letter alphabet up to length 6: it reproduces the audit's numbers
  // (single-replace 0 wrong) and fails loudly the moment an unprovable path is re-admitted.
  it('every accepted reconstruction equals the true original (exhaustive sweep)', () => {
    const applyOne = (b: string, o: string, n: string): string => {
      const at = b.indexOf(o);
      return at === -1 ? b : b.slice(0, at) + n + b.slice(at + o.length);
    };
    const strings: string[] = [];
    for (let len = 0; len <= 6; len++) {
      const build = (s: string): void => {
        if (s.length === len) { strings.push(s); return; }
        build(`${s}a`);
        build(`${s}b`);
      };
      build('');
    }
    const pairs: Array<[string, string]> = [['a', 'b'], ['b', 'a'], ['a', 'ab'], ['ab', 'a'], ['a', 'aa'], ['aa', 'a'], ['ab', 'ba']];

    let accepted = 0;
    for (const [oldString, newString] of pairs) {
      for (const before of strings) {
        if (!before.includes(oldString)) { continue; }
        const after = applyOne(before, oldString, newString);
        if (after === before) { continue; }
        const result = reconstructBeforeFromEdit(after, edit(oldString, newString, false));
        if (!result.ok) { continue; } // refusing is always allowed; being wrong is not
        accepted++;
        expect(
          result.before,
          `wrong original for old=${oldString} new=${newString} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
        ).toBe(before);
      }
    }
    // Guard the guard: if a refactor made everything refuse, the loop above would pass vacuously.
    expect(accepted).toBeGreaterThan(100);
  });
});

describe('beforeStateForWrite', () => {
  it('treats creation as a known before-state: absent, so restore deletes', () => {
    expect(beforeStateForWrite(false)).toEqual({ ok: true, before: null });
  });

  it('refuses an overwrite, including when we never got to look', () => {
    // A Write carries only the new content. What it replaced is gone, and reading the file after the
    // CLI applied it returns the AFTER bytes — recording those as "before" would make ⟲ a no-op that
    // looks like it worked.
    expect(beforeStateForWrite(true)).toEqual({ ok: false, reason: 'overwrote-existing' });
    expect(beforeStateForWrite(undefined)).toEqual({ ok: false, reason: 'overwrote-existing' });
  });
});