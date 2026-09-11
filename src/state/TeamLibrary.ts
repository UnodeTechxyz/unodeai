/**
 * Named team snapshots, so configuring a crew is not work you throw away when you switch.
 *
 * Switching teams removes every session and builds the new preset from scratch. Everything that made the
 * outgoing crew yours — edited instructions, per-agent model tuning, folder access, MCP grants, attached
 * skills — went with it, and the only way back was to configure it again by hand.
 *
 * A snapshot is the **roster** from the existing versioned team-file document, written under
 * `.unode/teams/`. Reusing that format rather than inventing a second one is the whole design: it already
 * validates, already migrates routes, and already refuses to serialise a route it cannot resolve. A route
 * carries a connection id and a model id, never a key — API keys live in SecretStorage under a reference.
 *
 * It does **not** follow that the file carries nothing sensitive. An agent's `env` map is persisted
 * verbatim, exactly as `.unode/team.json` already persists it; the `${VAR}` placeholder rule applies to MCP
 * server env, not to this. A file that someone is told they can share needs that stated plainly, which is
 * why the manual says it rather than repeating the stronger claim. `.unode/` is also in the `.gitignore`
 * UnodeAi itself writes, so a saved team is not committed by accident — sharing one is a deliberate copy.
 */

/** Slug rules exist so a name types cleanly on every OS and cannot escape the teams directory. */
export const TEAM_SLUG_MAX_LENGTH = 60;

/** A saved-team name is unique only inside one library. Never use a bare slug across this boundary. */
export type TeamLibraryScope = 'workspace' | 'global';

export interface TeamLibraryRef {
  scope: TeamLibraryScope;
  slug: string;
}

export interface TeamLibraryEntry {
  scope: TeamLibraryScope;
  /** The on-disk file name without its extension. */
  slug: string;
  /** What the user typed. Round-trips through the file so a rename is not needed to re-title. */
  label: string;
  savedAt: string;
  memberCount: number;
  /** True when the host wrote this automatically before replacing a roster. */
  automatic?: boolean;
}

/**
 * A short, stable file name for a label with no ASCII in it.
 *
 * `研发团队` sanitises to nothing, so the first version refused to save it — under an error message claiming
 * the name had no letters or numbers, which is false and unhelpful to anyone not typing in English. The label
 * itself round-trips through the file, so the slug only has to be a stable, collision-resistant file name;
 * it does not have to be readable.
 */
function stableNameHash(label: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `team-${hash.toString(36)}`;
}

/**
 * Turn a typed name into a file name.
 *
 * A name that has no ASCII letters or digits gets a hash of itself rather than a refusal. The one thing that
 * must never happen is two different names sharing a file: an empty sanitised result would have become `-`
 * and overwritten the previous nameless save.
 */
export function teamSlug(label: string): string | undefined {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TEAM_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : stableNameHash(trimmed);
}

/**
 * The prefix the host uses for its own snapshots.
 *
 * It starts with an underscore because `teamSlug` strips every character that is not `a-z0-9` and then
 * strips leading separators — so **no name a person can type produces a slug starting with `_`**. The first
 * version used a bare `autosave-` prefix, which a user typing "Autosave Client" would land on exactly; their
 * named team would then have been classified as a host snapshot and pruned as the eleventh one. A namespace
 * that a manual name can reach is not a namespace.
 */
const AUTOMATIC_SNAPSHOT_PREFIX = '_autosave-';

/** A snapshot the host took on its own, named so it sorts by time and cannot collide with a user's name. */
export function automaticSnapshotSlug(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return `${AUTOMATIC_SNAPSHOT_PREFIX}${stamp}`;
}

/**
 * Snapshots written before the prefix changed keep their old name and are treated as **manual** from here on.
 * That is the safe direction: the cost is that up to ten legacy snapshots stop being pruned automatically,
 * and the alternative — still matching the old prefix — reopens the collision this exists to close.
 */
export function isAutomaticSnapshotSlug(slug: string): boolean {
  return slug.startsWith(AUTOMATIC_SNAPSHOT_PREFIX);
}

/**
 * Describe a saved team in one line for a picker.
 *
 * The count is the fact a user picks on — "the six-agent one" — and the date disambiguates two saves of the
 * same crew. Neither is inferred: both are read from the file.
 */
export function describeTeamEntry(entry: TeamLibraryEntry): string {
  const members = `${entry.memberCount} agent${entry.memberCount === 1 ? '' : 's'}`;
  const when = entry.savedAt ? new Date(entry.savedAt).toLocaleString() : 'unknown date';
  return entry.automatic ? `${members} · auto-saved ${when}` : `${members} · saved ${when}`;
}

/**
 * How many automatic snapshots to keep.
 *
 * A safety net that grows without bound stops being a safety net and becomes clutter that hides the manual
 * saves beside it. Ten is enough to undo a mistake several switches later; the user's own named saves are
 * never pruned, because deleting something a person named is not a housekeeping decision.
 */
export const AUTOMATIC_SNAPSHOT_LIMIT = 10;

export function automaticSnapshotsToPrune(entries: readonly TeamLibraryEntry[]): TeamLibraryEntry[] {
  const automatic = entries
    .filter((entry) => entry.automatic)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return automatic.slice(AUTOMATIC_SNAPSHOT_LIMIT);
}
