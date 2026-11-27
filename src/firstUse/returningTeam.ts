/*
 * v0.9.106 (first use, design §3.8; Owner 2026-11-17: "For experienced user who just re-install the extension, we
 * should leave it way to go to the UI/UX which they are familiar with quickly"). Which saved team a returning person
 * is offered in one click when this workspace has none. The team library records only when a team was saved, so the
 * host also records when a saved team was opened; the offer says which of the two it rests on.
 */
import type { TeamLibraryEntry, TeamLibraryRef } from '../state/TeamLibrary';

/** The state key (workspace state for project teams, global state for teams of all projects) of the last opened team. */
export const TEAM_LAST_USED_KEY = 'unode.teamLibrary.lastUsed';

export interface TeamUseRecord extends TeamLibraryRef {
  /** When the team was opened (ISO). */
  at: string;
}

export function parseTeamUseRecord(raw: unknown): TeamUseRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if ((value.scope !== 'workspace' && value.scope !== 'global') || typeof value.slug !== 'string' || !value.slug
    || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return undefined;
  return { scope: value.scope, slug: value.slug, at: value.at };
}

export interface ReturningTeamChoice {
  ref: TeamLibraryRef;
  label: string;
  detail: string;
}

const time = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * The team to offer: the one opened last, when it is still in the library; otherwise the team saved most recently;
 * otherwise the newest automatic snapshot. Undefined when the library is empty.
 */
export function returningTeamChoice(entries: readonly TeamLibraryEntry[], used: ReadonlyArray<TeamUseRecord | undefined>): ReturningTeamChoice | undefined {
  const byUse = used.filter((record): record is TeamUseRecord => !!record).sort((a, b) => time(b.at) - time(a.at));
  for (const record of byUse) {
    const entry = entries.find((candidate) => candidate.scope === record.scope && candidate.slug === record.slug);
    if (entry) return { ref: { scope: entry.scope, slug: entry.slug }, label: `Load your team: ${entry.label}`, detail: 'The saved team you opened last.' };
  }
  const newest = (automatic: boolean) => entries.filter((entry) => !!entry.automatic === automatic)
    .sort((a, b) => time(b.savedAt) - time(a.savedAt))[0];
  const saved = newest(false);
  if (saved) return { ref: { scope: saved.scope, slug: saved.slug }, label: `Load your team: ${saved.label}`, detail: 'Your most recently saved team.' };
  const snapshot = newest(true);
  if (snapshot) {
    return { ref: { scope: snapshot.scope, slug: snapshot.slug }, label: 'Restore your previous team',
      detail: `Saved automatically before it was replaced: ${snapshot.label}.` };
  }
  return undefined;
}
