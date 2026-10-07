/*---------------------------------------------------------------------------------------------
 *  UnodeAi - claudeCheckpointEvents
 *  Deriving restore points from the Claude CLI's stream-json tool events.
 *
 *  WHY THIS EXISTS. Checkpoints (the changed-files rail, its per-file diff, and ⟲ restore) are
 *  recorded inside WorkspaceTools, which only the OpenAI-compatible backend runs. The Claude CLI
 *  applies edits with its own tools, so on a Claude Headless route the rail was structurally empty
 *  and its empty state — "edits appear here as they happen" — was a lie (Owner, 2026-07-30).
 *
 *  WHY WE DO NOT JUST READ THE FILE FIRST. The obvious fix is to read the file when the `tool_use`
 *  event arrives and call that the before-state. That is a race: the CLI owns the write, and by the
 *  time we have parsed the event it may already have applied it. A restore built on a racily-read
 *  before-state can write the WRONG BYTES over the user's work, which is strictly worse than having
 *  no restore at all.
 *
 *  SO: reconstruct, then PROVE. An `Edit` event carries `old_string` and `new_string`, so the
 *  before-state is derivable from the after-state by reversing the substitution — no clock involved.
 *  We then re-apply the edit forward to the reconstruction and require it to reproduce the observed
 *  after-state byte for byte. Anything that fails that round-trip is refused rather than guessed.
 *  Refusing yields a rail entry that is visible and diffable but not restorable — the file is still
 *  surfaced, we simply decline to claim we know what it used to be.
 *--------------------------------------------------------------------------------------------*/

/** The file-mutating Claude tools we can derive a restore point from. */
export type ClaudeEditIntent =
  | { kind: 'edit'; path: string; oldString: string; newString: string; replaceAll: boolean }
  | { kind: 'write'; path: string; content: string };

/** Why a before-state could not be established. Surfaced so the UI can say more than "no". */
export type BeforeRefusal =
  | 'empty-new-string'       // an Edit that only deletes: nothing to locate the reversal by
  | 'ambiguous-occurrence'   // new_string appears more than once; which one was the edit is unknowable
  | 'not-found'              // new_string is absent from the after-state — the event does not describe this file
  | 'replace-all-ambiguous'  // replace_all: the after-state has many preimages and nothing selects the right one
  | 'roundtrip-mismatch';    // the reconstruction does not regenerate the observed after-state

export type BeforeResult =
  | { ok: true; before: string }
  | { ok: false; reason: BeforeRefusal };

const EDIT_TOOLS = new Set(['edit', 'str_replace_based_edit_tool', 'notebookedit']);
const WRITE_TOOLS = new Set(['write', 'create_file']);

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read a Claude `tool_use` block into an edit intent, or undefined when the tool does not mutate a
 * file. Tolerant of both snake_case and camelCase argument spellings — the CLI has shipped both, and
 * a missed spelling here is a silently unrecorded edit, which is the exact failure being fixed.
 */
export function parseClaudeEditIntent(toolName: unknown, input: unknown): ClaudeEditIntent | undefined {
  const name = typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
  if (!name || !input || typeof input !== 'object') {
    return undefined;
  }
  const args = input as Record<string, unknown>;
  const path = str(args.file_path) ?? str(args.filePath) ?? str(args.path);
  if (!path) {
    return undefined;
  }
  if (EDIT_TOOLS.has(name)) {
    const oldString = str(args.old_string) ?? str(args.oldString);
    const newString = str(args.new_string) ?? str(args.newString);
    if (oldString === undefined || newString === undefined) {
      return undefined;
    }
    return {
      kind: 'edit',
      path,
      oldString,
      newString,
      replaceAll: args.replace_all === true || args.replaceAll === true,
    };
  }
  if (WRITE_TOOLS.has(name)) {
    const content = str(args.content) ?? str(args.contents) ?? str(args.file_text);
    if (content === undefined) {
      return undefined;
    }
    return { kind: 'write', path, content };
  }
  return undefined;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Apply an Edit forward, exactly as the CLI would. Used to verify a reconstruction, not to edit. */
function applyEdit(before: string, oldString: string, newString: string, replaceAll: boolean): string {
  if (replaceAll) {
    return before.split(oldString).join(newString);
  }
  const at = before.indexOf(oldString);
  return at === -1 ? before : before.slice(0, at) + newString + before.slice(at + oldString.length);
}

/**
 * Reverse a single-occurrence `Edit` against the observed after-state, and only return a before-state
 * that is provably THE original — not merely one of several that could have produced it.
 *
 * ## Why `replace_all` is refused outright (Codex audit, 2026-07-30 — P0 against the first version)
 *
 * The first version accepted `replace_all` and verified the reversal by re-applying the edit forward.
 * That check is real but proves the wrong thing: it establishes the candidate is *a* preimage, not
 * *the* preimage. With `replace_all` the mapping is many-to-one, so a wrong answer passes:
 *
 *     before "old new" --(replace_all old→new)--> after "new new"
 *     reversing every "new" gives "old old", which also produces "new new". Round-trip passes.
 *     Restoring would write "old old" over a file that said "old new".
 *
 * A brute-force sweep of every string up to length 6 over a two-letter alphabet put the damage at
 * **381 wrong reconstructions against 371 correct** — worse than a coin flip, and the failure is
 * silent. Nothing in the after-state distinguishes a `new_string` the edit produced from one the file
 * already contained, so no amount of checking rescues it: the information is gone. A trusted
 * pre-write snapshot is the only thing that could, and we do not have one.
 *
 * ## Why the single-occurrence case survives
 *
 * The CLI replaces the FIRST occurrence, so the original is `A + old + B` with no `old` inside `A`.
 * The after-state is `A + new + B`. Requiring `new` to occur exactly once pins the split point, which
 * pins `A` and `B` — the preimage is unique. The round-trip then additionally rules out an `A` that
 * contained `old` (the forward pass would have hit that occurrence instead). The same sweep found
 * **225 correct and 0 wrong** for this path.
 */
export function reconstructBeforeFromEdit(
  after: string,
  edit: { oldString: string; newString: string; replaceAll: boolean },
): BeforeResult {
  const { oldString, newString, replaceAll } = edit;
  if (replaceAll) {
    return { ok: false, reason: 'replace-all-ambiguous' };
  }
  if (!newString) {
    // A pure deletion. The after-state carries no marker of where the removed text used to sit, so
    // there is nothing to anchor a reversal to — and an insertion at a guessed offset is a corruption.
    return { ok: false, reason: 'empty-new-string' };
  }
  const occurrences = countOccurrences(after, newString);
  if (occurrences === 0) {
    return { ok: false, reason: 'not-found' };
  }
  if (occurrences > 1) {
    return { ok: false, reason: 'ambiguous-occurrence' };
  }
  const at = after.indexOf(newString);
  const candidate = after.slice(0, at) + oldString + after.slice(at + newString.length);
  if (applyEdit(candidate, oldString, newString, false) !== after) {
    return { ok: false, reason: 'roundtrip-mismatch' };
  }
  return { ok: true, before: candidate };
}

/**
 * The before-state for a `Write`.
 *
 * A Write carries only the new content, so nothing in the event describes what it replaced. The one
 * case we can be certain about is creation: if the file did not exist when the tool was announced,
 * the before-state is "absent" (`null`), and restore means deleting it — no read of the file's
 * contents is involved, so there is no race to lose.
 *
 * Overwriting an existing file is exactly the case we refuse. `existedBefore` is allowed to be
 * `undefined` (we never got to look), which is treated the same as "it existed": unknown.
 */
export function beforeStateForWrite(existedBefore: boolean | undefined): { ok: true; before: null } | { ok: false; reason: 'overwrote-existing' } {
  return existedBefore === false ? { ok: true, before: null } : { ok: false, reason: 'overwrote-existing' };
}