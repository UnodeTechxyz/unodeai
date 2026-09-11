import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_SNAPSHOT_LIMIT,
  automaticSnapshotSlug,
  automaticSnapshotsToPrune,
  describeTeamEntry,
  isAutomaticSnapshotSlug,
  teamSlug,
} from '../TeamLibrary';

describe('naming a saved team', () => {
  it('turns a typed name into a file name that cannot escape the directory', () => {
    expect(teamSlug('Contract & Compliance')).toBe('contract-compliance');
    expect(teamSlug('  Website  Delivery  ')).toBe('website-delivery');
    expect(teamSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(teamSlug('C:\\Users\\me')).toBe('c-users-me');
    expect(teamSlug('team.json')).toBe('team-json');
  });

  // Only a genuinely empty name is refused. A punctuation-only name still has to become a distinct file,
  // because two different names sharing one file is the outcome that loses somebody's work.
  it('refuses an empty name and gives every other name a file of its own', () => {
    for (const empty of ['', '   ']) {
      expect(teamSlug(empty), JSON.stringify(empty)).toBeUndefined();
    }
    const punctuation = ['///', '...', '---'].map((name) => teamSlug(name));
    expect(punctuation.every(Boolean)).toBe(true);
    expect(new Set(punctuation).size).toBe(3);
  });

  /**
   * A name with no ASCII letters or digits used to be refused, under a message telling the user it contained
   * no letters or numbers. It does; they are just not Latin ones. The label round-trips through the file, so
   * the slug only has to be a stable, distinct file name — it does not have to be readable.
   */
  it('saves a name written in any script, and gives the same name the same file every time', () => {
    for (const name of ['研发团队', '合同与合规', 'Команда', 'الفريق']) {
      const slug = teamSlug(name);
      expect(slug, name).toBeTruthy();
      expect(slug, name).toMatch(/^[a-z0-9-]+$/);
      expect(teamSlug(name), name).toBe(slug);
    }
    expect(teamSlug('研发团队')).not.toBe(teamSlug('合同与合规'));
    // A name that is partly ASCII still gets the readable form.
    expect(teamSlug('研发 Team')).toBe('team');
  });

  it('keeps an automatic snapshot distinguishable from anything a person would name', () => {
    const slug = automaticSnapshotSlug(new Date('2026-08-19T10:30:00.000Z'));
    expect(slug).toBe('_autosave-2026-08-19T10-30-00-000');
    expect(isAutomaticSnapshotSlug(slug)).toBe(true);
    expect(isAutomaticSnapshotSlug(teamSlug('My Crew')!)).toBe(false);
  });

  /**
   * The regression this prefix exists for. "Autosave Client" is a name a person can reasonably type; under
   * the old bare `autosave-` prefix it produced `autosave-client`, was classified as a host snapshot, and
   * became eligible for pruning as the eleventh one — breaking the one promise this module makes out loud.
   */
  it('cannot classify any name a person can type as a snapshot the host wrote', () => {
    const names = [
      'Autosave Client', 'autosave', 'AUTOSAVE-2026', '_autosave', '__autosave__', '  _autosave-2026  ',
      '-autosave-', '研发团队', 'autosave-2026-08-19T10-30-00-000',
    ];
    for (const name of names) {
      const slug = teamSlug(name);
      expect(slug, name).toBeTruthy();
      expect(isAutomaticSnapshotSlug(slug!), `"${name}" must never be treated as a host snapshot`).toBe(false);
    }
  });
});

describe('the picker line', () => {
  it('states the two facts a user chooses on, and marks which saves were not theirs', () => {
    const manual = describeTeamEntry({ slug: 'a', label: 'A', savedAt: '2026-08-19T10:00:00.000Z', memberCount: 6 });
    const auto = describeTeamEntry({ slug: 'b', label: 'B', savedAt: '2026-08-19T10:00:00.000Z', memberCount: 1, automatic: true });

    expect(manual).toMatch(/^6 agents · saved /);
    expect(auto).toMatch(/^1 agent · auto-saved /);
  });
});

describe('pruning the safety net', () => {
  const entry = (n: number, automatic: boolean) => ({
    slug: `s${n}`, label: `L${n}`, savedAt: `2026-08-${String(n).padStart(2, '0')}T10:00:00.000Z`,
    memberCount: 1, ...(automatic ? { automatic: true } : {}),
  });

  it('keeps the newest automatic snapshots and drops the rest', () => {
    const entries = Array.from({ length: AUTOMATIC_SNAPSHOT_LIMIT + 3 }, (_, i) => entry(i + 1, true));
    const pruned = automaticSnapshotsToPrune(entries);

    expect(pruned).toHaveLength(3);
    // Oldest three, by the date in the file rather than by directory order.
    expect(pruned.map((p) => p.slug)).toEqual(['s3', 's2', 's1']);
  });

  // Deleting something a person named is not a housekeeping decision.
  it('never prunes a save the user named, however many there are', () => {
    const entries = Array.from({ length: AUTOMATIC_SNAPSHOT_LIMIT + 5 }, (_, i) => entry(i + 1, false));
    expect(automaticSnapshotsToPrune(entries)).toEqual([]);
  });
});
