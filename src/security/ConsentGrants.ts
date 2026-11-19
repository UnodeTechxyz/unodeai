/**
 * Persisted network-consent grants are user data, not cache entries. Keep their provenance with the
 * grant so the Security panel can tell a user what they approved without guessing from today's config.
 */

export type ConsentGrantKind = 'model' | 'metadata' | 'media' | 'codex';
export type MediaConsentKind = 'vision' | 'transcription';

export interface ConsentGrant {
  host: string;
  /** Codex grants are bound to the canonical executable that was disclosed to the user. */
  executablePath?: string;
  /** Exact model-route authority. Legacy host-only grants omit these and are re-prompted, never widened. */
  profileId?: string;
  destination?: string;
  profileRevision?: number;
  /** Present only for remote-media approval; vision and transcription are separate decisions. */
  mediaKind?: MediaConsentKind;
  /** ISO timestamp for grants created in 0.9.35+. Undefined means a migrated legacy approval. */
  grantedAt?: string;
  /** The provider, connection, or user-initiated feature that asked for the grant. */
  requester?: string;
}

type StoredGrant = ConsentGrant;

/**
 * In-memory owner of the separate grant kinds. Its `restore` return value tells the host
 * whether it must write the new shape back to globalState; restoring a legacy string never invents a date.
 */
export class ConsentGrantRegistry {
  private readonly grants: Record<ConsentGrantKind, Map<string, ConsentGrant>> = {
    model: new Map(),
    metadata: new Map(),
    media: new Map(),
    codex: new Map(),
  };

  restore(kind: ConsentGrantKind, raw: unknown): { migratedLegacy: boolean } {
    const target = this.grants[kind];
    target.clear();
    if (!Array.isArray(raw)) { return { migratedLegacy: false }; }

    let migratedLegacy = false;
    for (const entry of raw) {
      if (typeof entry === 'string') {
        // Media approval was introduced with structured, class-specific entries. A legacy host-only
        // string cannot honestly mean either vision or transcription, so it authorizes neither.
        if (kind === 'media') { continue; }
        const host = entry.trim();
        if (host) {
          // Do not stamp Date.now(): this approval predates provenance and its real time is unknowable.
          target.set(host, { host });
          migratedLegacy = true;
        }
        continue;
      }
      if (!isRecord(entry) || typeof entry.host !== 'string' || !entry.host.trim()) { continue; }
      const host = entry.host.trim();
      const grantedAt = validTimestamp(entry.grantedAt) ? entry.grantedAt : undefined;
      const requester = typeof entry.requester === 'string' && entry.requester.trim()
        ? entry.requester.trim()
        : undefined;
      const mediaKind = entry.mediaKind === 'vision' || entry.mediaKind === 'transcription'
        ? entry.mediaKind
        : undefined;
      const profileId = typeof entry.profileId === 'string' && entry.profileId.trim() ? entry.profileId.trim() : undefined;
      const destination = typeof entry.destination === 'string' && entry.destination.trim() ? entry.destination.trim() : undefined;
      const profileRevision = typeof entry.profileRevision === 'number' && Number.isSafeInteger(entry.profileRevision)
        ? entry.profileRevision
        : undefined;
      const executablePath = typeof entry.executablePath === 'string' && entry.executablePath.trim()
        ? entry.executablePath.trim()
        : undefined;
      if (kind === 'media' && !mediaKind) { continue; }
      const scopedModel = kind === 'model' && profileId && destination && profileRevision !== undefined;
      const storageKey = kind === 'codex' && executablePath
        ? codexGrantKey(host, executablePath)
        : scopedModel
          ? modelGrantKey(profileId, destination, profileRevision)
          : grantKey(kind, host, mediaKind);
      target.set(
        storageKey,
        {
          host,
          ...(kind === 'codex' && executablePath ? { executablePath } : {}),
          ...(scopedModel ? { profileId, destination, profileRevision } : {}),
          ...(mediaKind ? { mediaKind } : {}),
          grantedAt,
          requester,
        },
      );
    }
    return { migratedLegacy };
  }

  has(kind: ConsentGrantKind, host: string): boolean {
    return kind !== 'media' && this.grants[kind].has(host);
  }

  /** Returns true only when this call created a new approval; first provenance wins. */
  grant(kind: ConsentGrantKind, host: string, requester: string, now = new Date()): boolean {
    if (kind === 'media') {
      throw new Error('Use grantMedia for a class-specific media approval.');
    }
    if (!host || this.has(kind, host)) { return false; }
    this.grants[kind].set(host, { host, grantedAt: now.toISOString(), requester });
    return true;
  }

  hasModel(profileId: string, destination: string, profileRevision: number): boolean {
    return this.grants.model.has(modelGrantKey(profileId, destination, profileRevision));
  }

  hasModelForHost(host: string): boolean {
    return [...this.grants.model.values()].some((grant) => grant.host === host);
  }

  grantModel(
    profileId: string,
    destination: string,
    profileRevision: number,
    host: string,
    requester: string,
    now = new Date(),
  ): boolean {
    const key = modelGrantKey(profileId, destination, profileRevision);
    if (!profileId || !destination || !host || this.grants.model.has(key)) return false;
    this.grants.model.set(key, {
      host,
      profileId,
      destination,
      profileRevision,
      grantedAt: now.toISOString(),
      requester,
    });
    return true;
  }

  revokeModel(profileId: string, destination: string, profileRevision: number): boolean {
    return this.grants.model.delete(modelGrantKey(profileId, destination, profileRevision));
  }

  hasCodex(host: string, executablePath: string): boolean {
    return this.grants.codex.has(codexGrantKey(host, executablePath));
  }

  grantCodex(host: string, executablePath: string, requester: string, now = new Date()): boolean {
    if (!host || !executablePath || this.hasCodex(host, executablePath)) return false;
    this.grants.codex.set(codexGrantKey(host, executablePath), {
      host,
      executablePath,
      grantedAt: now.toISOString(),
      requester,
    });
    return true;
  }

  /** Revoking the displayed host removes both legacy host-only and executable-bound Codex grants. */
  revokeCodexHost(host: string): boolean {
    let changed = false;
    for (const [key, grant] of this.grants.codex) {
      if (grant.host === host) changed = this.grants.codex.delete(key) || changed;
    }
    return changed;
  }

  revoke(kind: ConsentGrantKind, host: string): boolean {
    if (kind === 'media') {
      throw new Error('Use revokeMedia for a class-specific media approval.');
    }
    return this.grants[kind].delete(host);
  }

  hasMedia(host: string, mediaKind: MediaConsentKind): boolean {
    return this.grants.media.has(grantKey('media', host, mediaKind));
  }

  /** Returns true only when this call creates an approval for this exact host and media purpose. */
  grantMedia(host: string, mediaKind: MediaConsentKind, requester: string, now = new Date()): boolean {
    if (!host || this.hasMedia(host, mediaKind)) { return false; }
    this.grants.media.set(grantKey('media', host, mediaKind), {
      host,
      mediaKind,
      grantedAt: now.toISOString(),
      requester,
    });
    return true;
  }

  revokeMedia(host: string, mediaKind: MediaConsentKind): boolean {
    return this.grants.media.delete(grantKey('media', host, mediaKind));
  }

  list(kind: ConsentGrantKind): ConsentGrant[] {
    return [...this.grants[kind].values()]
      .sort((a, b) => a.host.localeCompare(b.host)
        || (a.executablePath ?? '').localeCompare(b.executablePath ?? '')
        || (a.mediaKind ?? '').localeCompare(b.mediaKind ?? ''))
      .map((grant) => ({ ...grant }));
  }

  serialize(kind: ConsentGrantKind): StoredGrant[] {
    return this.list(kind);
  }
}

function grantKey(kind: ConsentGrantKind, host: string, mediaKind?: MediaConsentKind): string {
  return kind === 'media' ? `${host}\u0000${mediaKind ?? ''}` : host;
}

function modelGrantKey(profileId: string, destination: string, profileRevision: number): string {
  return `${profileId}\u0000${destination}\u0000${profileRevision}`;
}

function codexGrantKey(host: string, executablePath: string): string {
  return `${host}\u0000${executablePath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
