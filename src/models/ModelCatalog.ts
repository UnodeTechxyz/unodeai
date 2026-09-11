import { GatewayHtmlResponseError, parseGatewayJson } from '../backend/GatewayJsonResponse';
import type { ContextWindowMeasurement } from '../types';
import { discoverContextWindow } from './ContextWindowDiscovery';
import { boundedMetadataTtl, credentialFingerprint, metadataAbortError, type MetadataCacheState } from './ScopedMetadataCache';

/*---------------------------------------------------------------------------------------------
 *  UnodeAi - ModelCatalog (remotely-configurable model list service)
 *
 *  The add-agent picker needs "which models can this provider serve right now?". Hardcoding that
 *  in the extension means a release every time a gateway adds a model. Instead this service layers
 *  four sources (later ones only fill gaps, names are back-filled):
 *    0. The user's own unode.extraModels setting — the only source that needs neither a release nor a
 *       reachable host, so it is also the only one that works for a connection with no /models endpoint
 *       (Claude Headless: the CLI cannot be asked what it serves). Highest priority: a local, explicit
 *       instruction outranks anything fetched.
 *    1. A Roam-hosted curated catalog JSON (unode.modelCatalogUrl) — rich names + per-role hints,
 *       fully remote-controllable.
 *    2. The gateway's own GET {baseUrl}/v1/models (OpenAI-compatible) — live availability. Since
 *       Roam runs ComputeVault, editing the gateway IS remote configuration, no extension update.
 *    3. The effective connection registry's per-connection offline metadata — friendly fallback names.
 *
 *  fetch is injected so the merge/parse/cache logic is unit-testable without network. Results are
 *  cached per (provider, baseUrl) with a TTL. Every failure degrades gracefully to the next source;
 *  the caller always also allows a free-typed model id, so an empty catalog never blocks the user.
 *--------------------------------------------------------------------------------------------*/

export interface ModelInfo {
  id: string;
  name?: string;
  vision?: boolean;
  /** Present only when this exact model's user-initiated `/models` record advertised a real window. */
  measuredContextWindow?: ContextWindowMeasurement;
  /** Roles this model is recommended for (from the curated catalog), if any. */
  recommendedFor?: string[];
  source: 'user' | 'catalog' | 'endpoint' | 'static';
}

/** Minimal fetch shape (injectable; the real one is the global fetch). */
export type CatalogFetch = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Shape of the curated catalog document at unode.modelCatalogUrl. */
interface CatalogDoc {
  providers?: Record<string, { models?: Array<{ id: string; name?: string; vision?: boolean; recommendedFor?: string[] }> }>;
}

/**
 * A stable tag for a credential, so a cache entry belongs to one key.
 *
 * **This is a 32-bit FNV-1a hash and not a cryptographic control** (Codex review, 2026-08-21). It exists to
 * keep two credentials in two cache slots, which is a correctness job, not a secrecy one. It happens to
 * avoid putting the key in a string that gets logged, and that is a courtesy rather than a guarantee: do
 * not cite it as protection, and do not put it anywhere the key itself would be unacceptable.
 */
export class ModelCatalog {
  private cache = new Map<string, { models: ModelInfo[]; ts: number }>();
  private inFlight = new Map<string, Promise<ModelInfo[]>>();
  /** Caches the curated catalog doc across providers within a session. */
  private catalogDoc: { doc: CatalogDoc | undefined; ts: number } | undefined;
  private catalogDocInFlight: Promise<CatalogDoc | undefined> | undefined;
  /** Invalidates completions that started before clearCache(), without cancelling another caller's wait. */
  private cacheGeneration = 0;

  constructor(
    private staticModels: (providerKey: string) => ModelInfo[],
    private fetchFn: CatalogFetch,
    private opts: {
      catalogUrl?: string;
      ttlMs?: number;
      timeoutMs?: number;
      /**
       * Reads unode.extraModels. A callback, not a captured value, so an edit to settings.json is seen
       * without reactivating — the host clears the cache on change so it is seen at once rather than
       * whenever the TTL happens to lapse.
       */
      userModels?: (providerKey: string) => ModelInfo[];
      /** Re-checked before a cached remote result is used. A cache is never an egress grant. */
      canReadMetadata?: (url: string) => boolean;
    } = {}
  ) {}

  /**
   * Models available for a provider, merged from curated catalog + live endpoint + static, with
   * names back-filled and ids de-duplicated. Cached per (provider, baseUrl).
   */
  async list(
    providerKey: string,
    baseUrl?: string,
    apiKey?: string,
    request: { signal?: AbortSignal } = {},
  ): Promise<ModelInfo[]> {
    // The credential is part of the identity of this result, not an argument to it. A gateway returns the
    // models THAT KEY may call, and two keys on one account can differ — so a cache keyed by provider and
    // base URL alone hands a new key the previous key's answer until the TTL happens to lapse. Field
    // report, 2026-08-21: a user swapped their Unode key for one in another group and saw no change in
    // either the price or the model range, which reads exactly like the swap not working.
    //
    // A short digest, never the key: a cache key is the kind of string that ends up in a log.
    const cacheKey = `${providerKey}|${baseUrl ?? ''}|${credentialFingerprint(apiKey)}`;
    const remoteUrls = [this.opts.catalogUrl, baseUrl].filter((url): url is string => Boolean(url));
    // A prior lookup is not permission to show remote metadata after its current connection or egress grant
    // has gone away. Be deliberately conservative for the merged result: if any remote constituent is no
    // longer allowed, return only the user/static sources rather than an unlabelled partial cache hit.
    if (remoteUrls.some((url) => this.opts.canReadMetadata !== undefined && !this.opts.canReadMetadata(url))) {
      return this.localModels(providerKey);
    }
    const cached = this.cache.get(cacheKey);
    const ttl = boundedMetadataTtl(this.opts.ttlMs);
    if (cached && Date.now() - cached.ts < ttl) {
      return cached.models;
    }

    let loading = this.inFlight.get(cacheKey);
    if (!loading) {
      loading = this.load(providerKey, baseUrl, apiKey, cacheKey, this.cacheGeneration);
      this.inFlight.set(cacheKey, loading);
      const owned = loading;
      void loading.then(
        () => { if (this.inFlight.get(cacheKey) === owned) { this.inFlight.delete(cacheKey); } },
        () => { if (this.inFlight.get(cacheKey) === owned) { this.inFlight.delete(cacheKey); } },
      );
    }
    return this.waitForCaller(loading, request.signal);
  }

  /** Lets a view label retained-but-expired remote metadata as stale rather than pretending it is current. */
  cacheState(providerKey: string, baseUrl?: string, apiKey?: string): MetadataCacheState {
    const cached = this.cache.get(`${providerKey}|${baseUrl ?? ''}|${credentialFingerprint(apiKey)}`);
    if (!cached) { return 'unknown'; }
    return Date.now() - cached.ts < boundedMetadataTtl(this.opts.ttlMs) ? 'fresh' : 'stale';
  }

  private async load(
    providerKey: string,
    baseUrl: string | undefined,
    apiKey: string | undefined,
    cacheKey: string,
    generation: number,
  ): Promise<ModelInfo[]> {
    const merged = new Map<string, ModelInfo>();
    const add = (m: ModelInfo): void => {
      const existing = merged.get(m.id);
      if (!existing) {
        merged.set(m.id, m);
      } else {
        // keep the higher-priority source's identity, back-fill missing display fields.
        merged.set(m.id, {
          ...existing,
          name: existing.name ?? m.name,
          vision: existing.vision ?? m.vision,
          recommendedFor: existing.recommendedFor ?? m.recommendedFor,
          // A user/catalog label wins for presentation, but it cannot erase a window the gateway just
          // reported for the same opaque model id.
          measuredContextWindow: existing.measuredContextWindow ?? m.measuredContextWindow,
        });
      }
    };

    // First, so a user's own entry keeps its id and name even when a later source names it differently.
    // Never throws: a malformed setting must not be able to empty the picker.
    for (const m of this.fromUserSetting(providerKey)) {
      add(m);
    }
    for (const m of await this.fromCatalog(providerKey)) {
      add(m);
    }
    if (baseUrl) {
      for (const m of await this.fromEndpoint(baseUrl, apiKey)) {
        add(m);
      }
    }
    for (const m of this.staticModels(providerKey)) {
      add(m);
    }

    const models = [...merged.values()];
    if (generation === this.cacheGeneration) {
      this.cache.set(cacheKey, { models, ts: Date.now() });
    }
    return models;
  }

  private localModels(providerKey: string): ModelInfo[] {
    const merged = new Map<string, ModelInfo>();
    for (const model of [...this.fromUserSetting(providerKey), ...this.staticModels(providerKey)]) {
      const existing = merged.get(model.id);
      merged.set(model.id, existing ? {
        ...existing,
        name: existing.name ?? model.name,
        vision: existing.vision ?? model.vision,
      } : model);
    }
    return [...merged.values()];
  }

  private async waitForCaller<T>(loading: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) { return loading; }
    if (signal.aborted) { throw metadataAbortError(); }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(metadataAbortError()); };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      void loading.then(
        (value) => { cleanup(); resolve(value); },
        (error: unknown) => { cleanup(); reject(error); },
      );
    });
  }

  /** Drop cached results (e.g. after the user changes the catalog URL). */
  clearCache(): void {
    this.cacheGeneration++;
    this.cache.clear();
    this.inFlight.clear();
    this.catalogDoc = undefined;
    this.catalogDocInFlight = undefined;
  }

  // ─── Sources ──────────────────────────────────────────────────────────

  /**
   * The user's `unode.extraModels` entry for this connection. Hand-edited JSON, so it is treated as
   * untrusted shape: non-string ids and non-object entries are dropped rather than rendered, and a
   * throwing or non-array reader degrades to "no user models" like every other source.
   */
  private fromUserSetting(providerKey: string): ModelInfo[] {
    let entries: unknown;
    try {
      entries = this.opts.userModels?.(providerKey);
    } catch {
      return [];
    }
    if (!Array.isArray(entries)) {
      return [];
    }
    const seen = new Set<string>();
    const models: ModelInfo[] = [];
    for (const entry of entries) {
      const id = typeof entry === 'string' ? entry : (entry as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !id.trim() || seen.has(id.trim())) {
        continue;
      }
      seen.add(id.trim());
      const record = (typeof entry === 'string' ? {} : entry) as { name?: unknown; vision?: unknown };
      models.push({
        id: id.trim(),
        name: typeof record.name === 'string' && record.name ? record.name : undefined,
        vision: typeof record.vision === 'boolean' ? record.vision : undefined,
        source: 'user',
      });
    }
    return models;
  }

  private async fromCatalog(providerKey: string): Promise<ModelInfo[]> {
    const url = this.opts.catalogUrl;
    if (!url) {
      return [];
    }
    const doc = await this.loadCatalogDoc(url);
    const entries = doc?.providers?.[providerKey]?.models ?? [];
    return entries
      .filter((m) => typeof m?.id === 'string' && m.id)
      .map((m) => ({ id: m.id, name: m.name, vision: m.vision, recommendedFor: m.recommendedFor, source: 'catalog' as const }));
  }

  private async loadCatalogDoc(url: string): Promise<CatalogDoc | undefined> {
    const ttl = boundedMetadataTtl(this.opts.ttlMs);
    if (this.catalogDoc && Date.now() - this.catalogDoc.ts < ttl) {
      return this.catalogDoc.doc;
    }
    if (this.catalogDocInFlight) {
      return this.catalogDocInFlight;
    }
    const loading = this.fetchCatalogDoc(url);
    this.catalogDocInFlight = loading;
    try {
      return await loading;
    } finally {
      if (this.catalogDocInFlight === loading) {
        this.catalogDocInFlight = undefined;
      }
    }
  }

  private async fetchCatalogDoc(url: string): Promise<CatalogDoc | undefined> {
    let doc: CatalogDoc | undefined;
    try {
      const res = await this.fetchFn(url);
      if (res.ok) {
        doc = JSON.parse(await res.text()) as CatalogDoc;
      }
    } catch {
      doc = undefined;
    }
    this.catalogDoc = { doc, ts: Date.now() };
    return doc;
  }

  private async fromEndpoint(baseUrl: string, apiKey?: string): Promise<ModelInfo[]> {
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/models`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      const res = await this.fetchFn(url, { headers });
      if (!res.ok) {
        return [];
      }
      const body = parseGatewayJson(await res.text(), baseUrl) as { data?: unknown; models?: unknown };
      const data: unknown = body?.data ?? body?.models ?? body;
      if (!Array.isArray(data)) {
        return [];
      }
      return data
        .map((m: unknown): ModelInfo | undefined => {
          const id = typeof m === 'string'
            ? m
            : (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string'
              ? (m as { id: string }).id
              : undefined);
          if (!id) { return undefined; }
          return {
            id,
            source: 'endpoint' as const,
            measuredContextWindow: typeof m === 'string' ? undefined : discoverContextWindow(id, m),
          };
        })
        .filter((model): model is ModelInfo => model !== undefined);
    } catch (error) {
      // An HTML 200 is configuration feedback, not a transient catalog miss. Preserve the clear
      // diagnosis for the UI; other failures still degrade to the static catalog as before.
      if (error instanceof GatewayHtmlResponseError) {
        throw error;
      }
      return [];
    }
  }
}
