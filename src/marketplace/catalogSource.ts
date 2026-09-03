/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Marketplace catalog source (v0.6.1a)
 *  Resolves the effective catalog = the bundled in-repo catalog, optionally merged with a
 *  Roam-hosted catalog fetched at runtime (hosted wins on id collisions). This is the vehicle that
 *  lets the catalog grow WITHOUT shipping a new VSIX each time. Offline-safe: any fetch/parse
 *  failure falls back to the bundled set; one bad section never blanks the rest. No vscode coupling
 *  here (the reader/config/fetch are injected) so it's unit-testable.
 *--------------------------------------------------------------------------------------------*/

import { createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  CatalogSourceName,
  MarketplaceCatalog,
  mergeCatalogs,
  parseAgentCatalog,
  parseMcpCatalog,
  parseSkillCatalog,
} from './catalog';

/**
 * Ed25519 PUBLIC key (SPKI PEM) that signs the hosted catalog in UnodeTechxyz/unode-skills. Bundled in the
 * VSIX so a tampered hosted push can't change what installs fetch. The matching PRIVATE key lives only in
 * the publish secret store and never enters this repo.
 *
 * **While this is blank, the hosted catalog is DISABLED — nothing is fetched, and only the bundled catalog
 * is used.** It used to run "warn-only": an unsigned hosted catalog merged anyway, with a console warning.
 * That was backwards. A catalog entry can carry an MCP server's stdio `command` and `args`, which makes the
 * hosted catalog the one place where remote content can influence what runs on a user's machine — so the
 * failure mode of "we haven't finished setting up signing yet" must be *the feature is off*, not *the
 * protection is off*. A warning in a console nobody reads is not a security control. (Codex, v0.9.29 review.)
 *
 * To turn the hosted catalog on:
 *   1. `node scripts/sign-catalog.mjs --genkey` → keep the private PEM in the publish secret store, paste
 *      the public PEM here.
 *   2. Sign on publish: `node scripts/sign-catalog.mjs catalog.json <private-key.pem>` → commit
 *      `catalog.json` + `catalog.json.sig` to unode-skills.
 * From then on: valid signature → merged; missing or invalid signature → rejected, bundled catalog stands.
 */
export const CATALOG_PUBLIC_KEY_PEM = '';

/**
 * Verify a detached Ed25519 signature (base64) over the exact catalog bytes against an SPKI-PEM public key.
 * Never throws: a blank/invalid key, malformed signature, or any crypto error → false (treated as a failed
 * verification by the caller). Verifying the raw fetched bytes (not a re-serialized object) is essential.
 */
export function verifyCatalogSignature(bytes: string, signatureB64: string, publicKeyPem: string): boolean {
  if (!publicKeyPem.trim() || !signatureB64.trim()) {
    return false;
  }
  try {
    const key = createPublicKey(publicKeyPem);
    return cryptoVerify(null, Buffer.from(bytes, 'utf8'), key, Buffer.from(signatureB64.trim(), 'base64'));
  } catch {
    return false;
  }
}

/**
 * What actually happened the last time a hosted catalog was resolved — so the Security panel can report the
 * TRUTH instead of echoing a setting.
 *
 * The panel used to render `unode.marketplace.fetchCatalog: true` as "Catalog fetch: ON". In the state this
 * build ships in (no signing key) the code refuses to make the request at all, so the panel was telling the
 * user the opposite of what the extension does. A security panel that reports intent rather than behaviour is
 * worse than no panel: it is the one screen a user checks precisely because they do not want to read the code.
 */
export type HostedCatalogOutcome =
  | 'not-attempted'   // nothing has asked for the catalog yet (it is lazy, and stays lazy)
  | 'disabled-no-key' // no signing key bundled ⇒ the feature is off, and no request was made
  | 'verified'        // fetched and the signature checked out
  | 'rejected'        // fetched, but unsigned / wrong key / tampered ⇒ bundled only
  | 'unreachable';    // offline, non-OK, or unparseable ⇒ bundled only

let lastOutcome: HostedCatalogOutcome = 'not-attempted';
/** The last hosted-catalog resolution outcome. Reset per session; purely for honest reporting. */
export function lastHostedCatalogOutcome(): HostedCatalogOutcome {
  return lastOutcome;
}

/**
 * The effective, user-facing state of the hosted catalog — derived from the setting, the URL, the bundled
 * signing key, and what the last attempt actually did. Pure, so it can be asserted state by state.
 */
export function describeHostedCatalogStatus(input: {
  enabled: boolean;
  url: string;
  publicKeyPem: string;
  outcome: HostedCatalogOutcome;
}): { text: string; ok: boolean } {
  if (!input.enabled || !input.url.trim()) {
    return { text: 'Hosted catalog off — bundled catalog only.', ok: true };
  }
  if (!input.publicKeyPem.trim()) {
    return {
      text: 'Hosted catalog unavailable — publisher signing is not configured; bundled catalog only.',
      ok: true, // not a warning state: nothing is fetched, and nothing unverified can merge
    };
  }
  switch (input.outcome) {
    case 'verified':
      return { text: 'Hosted catalog verified.', ok: true };
    case 'rejected':
      return { text: 'Hosted catalog unverified — signature missing or invalid; bundled catalog only.', ok: false };
    case 'unreachable':
      return { text: 'Hosted catalog unavailable — could not be fetched; bundled catalog only.', ok: true };
    default:
      return { text: 'Hosted catalog enabled — only a validly signed catalog will be used.', ok: true };
  }
}

/** Untrusted, unparsed catalog payload (from a bundled file or a hosted endpoint). */
export interface RawCatalog {
  agents?: unknown;
  mcp?: unknown;
  skills?: unknown;
}

/**
 * Parse a raw {agents,mcp,skills} payload section by section. A missing/invalid section becomes []
 * (reported via `warn`) instead of throwing — so one broken section can't blank the others.
 */
export function parseCatalogResilient(raw: RawCatalog, warn: (msg: string) => void = () => {}): MarketplaceCatalog {
  const section = <T>(name: CatalogSourceName, value: unknown, parse: (r: unknown) => T[]): T[] => {
    try {
      return parse(value ?? []);
    } catch (err) {
      warn(`${name} catalog skipped: ${String(err)}`);
      return [];
    }
  };
  return {
    agents: section('agents', raw.agents, parseAgentCatalog),
    mcp: section('mcp', raw.mcp, parseMcpCatalog),
    skills: section('skills', raw.skills, parseSkillCatalog),
  };
}

export interface HostedCatalogOptions {
  url: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * REQUIRED. The hosted catalog is ALWAYS integrity-checked against a detached Ed25519 signature, fetched
   * from `sigUrl` (default `${url}.sig`). Every failure path rejects — the bundled catalog stands:
   *  - public key blank/absent     → reject WITHOUT FETCHING (signing is not configured ⇒ feature is off);
   *  - signature missing           → reject (an unsigned catalog is an unverified catalog);
   *  - signature present & invalid → reject (tamper, or wrong key);
   *  - signature present & valid   → merge.
   *
   * It is required, and there is deliberately no "skip verification" mode, because the previous version made
   * it OPTIONAL: the two production call sites passed a key, so the behaviour was correct — but the invariant
   * "an unverified catalog never merges" rested on every future caller remembering an optional field. A
   * caller who omits it would silently reactivate the acceptance of unverified remote MCP `command`/`args`.
   * An invariant you can opt out of by omission is a convention, not an invariant. (Codex, v0.9.29 review —
   * the third round of exactly this lesson: make it impossible, do not make it correct-by-convention.)
   */
  verify: { publicKeyPem: string; sigUrl?: string };
  /** Optional diagnostics sink (threaded from resolveCatalog). */
  warn?: (msg: string) => void;
}

/**
 * Fetch a hosted catalog JSON ({agents,mcp,skills}). Offline-safe: a missing url, non-OK status,
 * timeout, network error, or non-object/unparseable body all resolve to `undefined` (caller falls back).
 * When `verify` is set, the raw bytes are checked against a detached Ed25519 signature first.
 */
export async function fetchHostedCatalog(o: HostedCatalogOptions): Promise<RawCatalog | undefined> {
  const doFetch = o.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!doFetch || !o.url) {
    return undefined;
  }
  const warn = o.warn ?? (() => {});
  const outcome = <T>(state: HostedCatalogOutcome, value: T): T => { lastOutcome = state; return value; };

  // No key ⇒ signing is not configured ⇒ the hosted catalog is OFF. Refuse BEFORE the request: with no way
  // to verify what comes back, fetching it would only tempt someone to use it. The bundled catalog stands.
  // `verify` is a required field, so this also catches a caller that passed it as undefined at runtime.
  if (!o.verify?.publicKeyPem?.trim()) {
    warn('hosted catalog is disabled: no catalog signing key is configured, so a hosted catalog cannot be '
      + 'verified and is not fetched. Using the bundled catalog.');
    return outcome('disabled-no-key', undefined);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 5000);
  try {
    const res = await doFetch(o.url, { signal: controller.signal });
    if (!res.ok) {
      return outcome('unreachable', undefined);
    }
    const text = await res.text(); // raw bytes — signature must be verified over exactly what we parse

    // UNCONDITIONAL. There is no branch that reaches JSON.parse on unverified bytes — that is the invariant,
    // and it is held by control flow rather than by a caller's diligence.
    const sigUrl = o.verify.sigUrl ?? `${o.url}.sig`;
    let sig: string | undefined;
    try {
      const sigRes = await doFetch(sigUrl, { signal: controller.signal });
      if (sigRes.ok) {
        sig = await sigRes.text();
      }
    } catch {
      // no signature available — rejected below, same as an invalid one
    }
    // An UNSIGNED catalog is an UNVERIFIED catalog. It used to merge with a warning; a catalog entry can
    // carry an MCP server's stdio command+args, so "we couldn't check this, but here it is" is not a
    // posture this feature can hold. Missing and invalid are the same answer: no.
    if (!sig || !sig.trim()) {
      warn(`hosted catalog is unsigned (no signature at ${sigUrl}) — REJECTED, using the bundled catalog only`);
      return outcome('rejected', undefined);
    }
    if (!verifyCatalogSignature(text, sig, o.verify.publicKeyPem)) {
      warn(`hosted catalog signature did NOT verify (${sigUrl}) — ignoring the hosted catalog (using bundled only)`);
      return outcome('rejected', undefined);
    }

    const json = JSON.parse(text) as unknown;
    return json && typeof json === 'object'
      ? outcome('verified', json as RawCatalog)
      : outcome('unreachable', undefined); // signed, but not a catalog — nothing to merge
  } catch {
    return outcome('unreachable', undefined);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the effective catalog: the bundled payload, optionally merged with a fetched hosted one
 * (hosted wins on id collisions, via mergeCatalogs). Hosted failure → bundled only. Never throws.
 */
export async function resolveCatalog(args: {
  bundled: RawCatalog;
  hosted?: HostedCatalogOptions;
  warn?: (msg: string) => void;
}): Promise<MarketplaceCatalog> {
  const base = parseCatalogResilient(args.bundled, args.warn);
  const fetched = args.hosted
    ? await fetchHostedCatalog({ ...args.hosted, warn: args.hosted.warn ?? args.warn })
    : undefined;
  if (!fetched) {
    return base;
  }
  return mergeCatalogs(base, parseCatalogResilient(fetched, args.warn));
}
