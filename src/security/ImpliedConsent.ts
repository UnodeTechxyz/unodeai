/**
 * v0.9.99: the person's own setup is the consent.
 *
 * Saving a connection with its key, choosing it for an agent, choosing a Codex program, or setting up a vision or
 * transcription model is already the person's decision to send work there. Asking again in a modal before the first
 * request only made ordinary use wait. So the first request records the grant, shows one non-modal notice that
 * says where the work goes and how to stop it, and continues.
 *
 * An explicit decline is kept: revoking a grant in the Security panel, or answering "Do not allow" to the question,
 * is remembered per destination. While it stands the existing question is asked again before anything is sent, and
 * only an "Allow" in that question releases it.
 */

export type ConsentDeclineKind = 'model' | 'codex' | 'media';

export function modelDeclineKey(profileId: string, destination: string): string {
  return `model\u0000${profileId}\u0000${destination}`;
}

export function codexDeclineKey(host: string): string {
  return `codex\u0000${host.trim().toLowerCase()}`;
}

export function mediaDeclineKey(host: string, mediaKind: string): string {
  return `media\u0000${host}\u0000${mediaKind}`;
}

/** Persisted declines. Stored as a plain list of keys; anything else in storage is ignored, never widened. */
export class ConsentDeclines {
  private readonly keys = new Set<string>();

  restore(raw: unknown): void {
    this.keys.clear();
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (typeof entry === 'string' && entry.length > 0 && entry.length <= 4096) this.keys.add(entry);
    }
  }

  has(key: string): boolean { return this.keys.has(key); }

  /** True only when this call recorded a new decline. */
  add(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }

  /** True only when a decline was released. */
  delete(key: string): boolean { return this.keys.delete(key); }

  serialize(): string[] { return [...this.keys].sort(); }
}

export interface ImpliedConsentPort {
  /** A grant for exactly this destination already exists. */
  granted(): boolean;
  /** The person declined or revoked this destination earlier. */
  declined(): boolean;
  /** Record the grant (with its provenance) and persist it. True only when this call created it. */
  grant(): Promise<boolean>;
  /** One non-modal notice: where the work goes and how to stop it. Never awaited for a click. */
  notify(): void;
  /** The existing question, asked only while a decline stands. Resolves true for Allow. */
  ask(): Promise<boolean>;
  /** Persist the decline (answer "Do not allow") or release it (answer "Allow"). */
  rememberDecline(): Promise<void>;
  forgetDecline(): Promise<void>;
}

/**
 * The one decision every model, Codex and media egress gate uses. Resolves true when the request may be sent.
 */
export async function resolveImpliedConsent(port: ImpliedConsentPort): Promise<boolean> {
  if (port.granted()) return true;
  if (!port.declined()) {
    // Two agents starting together on one connection record one grant and show one notice.
    if (await port.grant()) {
      try { port.notify(); } catch { /* a notice that cannot be shown does not hold up the request */ }
    }
    return true;
  }
  if (!(await port.ask())) {
    await port.rememberDecline();
    return false;
  }
  await port.forgetDecline();
  await port.grant();
  return true;
}
