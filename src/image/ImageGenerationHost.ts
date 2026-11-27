import { randomUUID } from 'node:crypto';
import { ContentAssetStore, CONTENT_ASSET_MAX_BYTES, hostReadMemoryBudget } from '../content/ContentAssetStore';
import { decodePng } from '../office/PngDecode';
import { IMAGE_MODEL, UNODE_IMAGE_MODEL, ImageConnectionRegistry, ImageOperationFailure, type ImageConnection, type SupportedImageModel } from './ImageConnectionRegistry';
import { defaultImageSize, imageRequest, type ImageSize } from './ImageTools';

export interface ImageUsage { input_tokens?: number; output_tokens?: number; total_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number; cached_tokens?: number } }
export interface ImageGenerationReceipt {
  kind: 'generated-image'; version: 1; operation_id: string; state: 'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown';
  model: SupportedImageModel | 'unselected'; connection_id?: string; connection_revision?: number; endpoint_base?: string; requested_size: ImageSize;
  quality: 'low' | 'medium' | 'high' | 'unknown'; requested_quality?: 'medium'; output_format: 'png'; started_at: string; ended_at?: string; request_id?: string;
  variant_of?: string; asset_id?: string; sha256?: string; bytes?: number; width?: number; height?: number;
  error_code?: string; may_have_cost: boolean; usage?: ImageUsage;
  pricing: { status: 'estimated' | 'partly-unpriced'; estimate_usd?: number; source: string; snapshot_at: string; basis: string;
    usd_per_million_tokens: { text_input: number; cached_text_input: number; image_input: number; cached_image_input: number; image_output: number } }
    | { status: 'unavailable'; source: string; basis: string };
}
interface Generated { receipt: ImageGenerationReceipt; assetId: string; sha256: string }
export interface ImageGenerationPorts {
  connections: ImageConnectionRegistry;
  secret(name: string): Promise<string | undefined>;
  egress(connection: ImageConnection, signal: AbortSignal): Promise<void>;
  egressCurrent(connection: ImageConnection): boolean;
  fetch?: typeof fetch;
  now?: () => Date;
  preview?(receipt: ImageGenerationReceipt): void | Promise<void>;
  /** Captured before async work, so a late completion cannot charge a newer user request. Never gates generation. */
  usage?(agentId: string, attemptId?: string): {
    started(receipt: ImageGenerationReceipt): void;
    settled(receipt: ImageGenerationReceipt, rawUsage?: unknown): void;
  } | undefined;
}
/** The three operation maps keep at most this many entries, evicting only saved images' metadata that nothing holds. */
export const GENERATED_IMAGE_RECORD_LIMIT = 50;
const priceSource = 'https://developers.openai.com/api/docs/models/gpt-image-2.6-flare';
const priceSnapshot = '2026-11-20T00:29:00Z';
function usageOf(value: unknown): ImageUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>; const output: ImageUsage = {};
  const valid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens'] as const) if (valid(raw[key])) output[key] = raw[key];
  if (raw.input_tokens_details && typeof raw.input_tokens_details === 'object') {
    const details = raw.input_tokens_details as Record<string, unknown>;
    output.input_tokens_details = {};
    for (const key of ['text_tokens', 'image_tokens', 'cached_tokens'] as const) if (valid(details[key])) output.input_tokens_details[key] = details[key];
  }
  return Object.keys(output).length ? output : undefined;
}
function pricing(model: ImageGenerationReceipt['model'], usage?: ImageUsage): ImageGenerationReceipt['pricing'] {
  if (model !== IMAGE_MODEL) return {
    status: 'unavailable', source: model === UNODE_IMAGE_MODEL ? 'Unode' : 'No selected connection',
    basis: 'A confirmed price for this image operation is unavailable.',
  };
  const detail = usage?.input_tokens_details;
  // A cache total does not identify cached text vs cached image tokens. Never guess that split.
  const complete = usage?.output_tokens !== undefined && usage.input_tokens !== undefined
    && detail?.text_tokens !== undefined && detail.image_tokens !== undefined && detail.cached_tokens === 0
    && detail.text_tokens + detail.image_tokens === usage.input_tokens;
  return { status: complete ? 'estimated' : 'partly-unpriced',
    ...(complete ? { estimate_usd: (detail.text_tokens! * 5 + detail.image_tokens! * 8 + usage.output_tokens! * 30) / 1e6 } : {}),
    source: priceSource, snapshot_at: priceSnapshot,
    usd_per_million_tokens: { text_input: 5, cached_text_input: 1.25, image_input: 8, cached_image_input: 2, image_output: 30 },
    basis: 'Official model token rates; estimate, not a bill. Unknown or unsplit cached token classes remain unpriced.' };
}
/** Host-minted provenance is private to this store/host; it cannot be supplied by a model or an attachment. */
export class ImageGenerationHost {
  private readonly generated = new Map<string, Generated>();
  private readonly operations = new Map<string, ImageGenerationReceipt>();
  /** Provider's original usage stays private; exported receipts carry only the numeric allowlist. */
  private readonly rawUsage = new Map<string, unknown>();
  private readonly controllers = new Set<AbortController>();
  /** Operations whose image a save wrote to the workspace, oldest save first. */
  private readonly saved = new Set<string>();
  private disposed = false;
  constructor(readonly assets: ContentAssetStore, private readonly ports: ImageGenerationPorts) {}
  modelFor(agentId: string): SupportedImageModel | undefined {
    try { return this.ports.connections.capture(agentId).modelId; }
    catch { return undefined; }
  }
  availableFor(agentId: string): boolean {
    return this.modelFor(agentId) !== undefined;
  }
  generatedAsset(id: string): Readonly<Generated> | undefined {
    const generated = this.generated.get(id);
    return generated && this.assets.sourceKindOf(id) === 'tool-result' ? generated : undefined;
  }
  operation(id: string): ImageGenerationReceipt | undefined {
    const found = this.operations.get(id); return found ? structuredClone(found) : undefined;
  }
  async generate(args: Record<string, unknown>, agentId: string, signal: AbortSignal | undefined,
    current: () => boolean, canAccess: (assetId: string) => boolean, attemptId?: string): Promise<ImageGenerationReceipt> {
    const request = imageRequest(args);
    if (request.variant_of) {
      const prior = this.operations.get(request.variant_of);
      if (!prior?.asset_id || !this.generatedAsset(prior.asset_id) || !canAccess(prior.asset_id)) throw new ImageOperationFailure('image-variant-unavailable');
    }
    const now = () => (this.ports.now?.() ?? new Date()).toISOString();
    const receipt: ImageGenerationReceipt = { kind: 'generated-image', version: 1, operation_id: 'image-' + randomUUID(), state: 'failed',
      model: 'unselected', requested_size: request.size, quality: 'unknown', requested_quality: 'medium', output_format: 'png', started_at: now(),
      ...(request.variant_of ? { variant_of: request.variant_of } : {}), may_have_cost: false, pricing: pricing('unselected') };
    this.operations.set(receipt.operation_id, receipt); this.forgetSaved(GENERATED_IMAGE_RECORD_LIMIT);
    let usage: ReturnType<NonNullable<ImageGenerationPorts['usage']>>;
    try { usage = this.ports.usage?.(agentId, attemptId); } catch { /* Spend visibility never gates work. */ }
    const reportUsage = (phase: 'started' | 'settled') => {
      try {
        if (phase === 'settled') usage?.settled(structuredClone(receipt), structuredClone(this.rawUsage.get(receipt.operation_id)));
        else usage?.started(structuredClone(receipt));
      } catch { /* Usage/history visibility never gates work. */ }
    };
    const controller = new AbortController(); this.controllers.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let unwatch: (() => void) | undefined; let connection: ImageConnection | undefined; let sent = false; let responseReceived = false;
    const check = () => {
      if (this.disposed || controller.signal.aborted || !current()) throw new ImageOperationFailure('image-operation-cancelled');
      if (connection) this.ports.connections.check(connection);
    };
    try {
      check(); connection = this.ports.connections.capture(agentId); unwatch = this.ports.connections.watch(connection, controller);
      receipt.connection_id = connection.connectionId; receipt.connection_revision = connection.revision;
      receipt.endpoint_base = connection.endpointBase; receipt.model = connection.modelId;
      receipt.requested_size = args.size === undefined ? defaultImageSize(connection.modelId) : request.size;
      receipt.pricing = pricing(connection.modelId);
      if (connection.modelId === UNODE_IMAGE_MODEL && receipt.requested_size !== '1024x1024') throw new ImageOperationFailure('image-size-not-supported');
      await this.ports.egress(connection, controller.signal); check();
      if (!this.ports.egressCurrent(connection)) throw new ImageOperationFailure('image-egress-disabled');
      const key = await this.ports.secret(connection.secretName); check();
      if (!key?.trim()) throw new ImageOperationFailure('image-key-not-configured');
      if (!this.ports.egressCurrent(connection)) throw new ImageOperationFailure('image-egress-disabled');
      // Endpoint and key come from this exact captured connection. Never follow a redirect with the bearer.
      sent = true; receipt.may_have_cost = true;
      reportUsage('started');
      const response = await (this.ports.fetch ?? fetch)(connection.endpointBase + '/images/generations', {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: connection.modelId, prompt: request.prompt, n: 1, size: receipt.requested_size, quality: 'medium', output_format: 'png' }),
      });
      check();
      const requestId = response.headers.get('x-request-id');
      if (requestId && /^[A-Za-z0-9_.:-]{1,256}$/.test(requestId)) receipt.request_id = requestId;
      if (response.status >= 300 && response.status < 400) { responseReceived = true; throw new ImageOperationFailure('image-redirect-not-followed'); }
      if (!response.ok) { responseReceived = true; throw new ImageOperationFailure('image-http-' + response.status); }
      const limit = Math.min(hostReadMemoryBudget(), Math.ceil(CONTENT_ASSET_MAX_BYTES * 4 / 3) + 65536);
      const reader = response.body?.getReader(); if (!reader) throw new ImageOperationFailure('image-response-missing');
      const chunks: Uint8Array[] = []; let count = 0;
      try {
        while (true) { check(); const part = await reader.read(); if (part.done) break; count += part.value.length;
          if (count > limit) throw new ImageOperationFailure('image-response-memory-limited'); chunks.push(part.value); }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      responseReceived = true;
      check();
      let body: any; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new ImageOperationFailure('image-response-invalid'); }
      if (body?.usage !== undefined) this.rawUsage.set(receipt.operation_id, structuredClone(body.usage));
      receipt.usage = usageOf(body?.usage); receipt.pricing = pricing(connection.modelId, receipt.usage);
      const quality = body?.quality;
      receipt.quality = quality === 'low' || quality === 'medium' || quality === 'high' ? quality : 'unknown';
      if (!Array.isArray(body?.data) || body.data.length !== 1 || typeof body.data[0]?.b64_json !== 'string') throw new ImageOperationFailure('image-response-invalid');
      const encoded = body.data[0].b64_json;
      if (!encoded.length || encoded.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new ImageOperationFailure('image-base64-invalid');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length > CONTENT_ASSET_MAX_BYTES || bytes.toString('base64') !== encoded) throw new ImageOperationFailure('image-base64-invalid');
      let decoded: ReturnType<typeof decodePng>;
      try { decoded = decodePng(bytes, hostReadMemoryBudget()); } catch { throw new ImageOperationFailure('image-png-invalid'); }
      const [width, height] = receipt.requested_size.split('x').map(Number);
      if (decoded.width !== width || decoded.height !== height) throw new ImageOperationFailure('image-dimensions-mismatch');
      check(); if (!this.ports.egressCurrent(connection)) throw new ImageOperationFailure('image-egress-disabled');
      const asset = await this.assets.storeImage(bytes, 'tool-result', 'image/png', agentId); check();
      if ('error' in asset) throw new ImageOperationFailure('image-asset-' + asset.error);
      this.assets.retain([asset.assetId], 'generated:' + receipt.operation_id);
      Object.assign(receipt, { state: 'succeeded', asset_id: asset.assetId, sha256: decoded.sha256, bytes: bytes.length, width, height });
      this.generated.set(asset.assetId, { receipt: structuredClone(receipt), assetId: asset.assetId, sha256: decoded.sha256 });
      this.assets.registerOfficeImage(asset.assetId, { kind: 'generated-image', operation_id: receipt.operation_id,
        sha256: decoded.sha256, bytes: bytes.length, width, height, model: receipt.model }, { agent_id: agentId, ...(attemptId ? { attempt_id: attemptId } : {}) });
    } catch (error) {
      const code = error instanceof ImageOperationFailure ? error.code : 'image-transport-failed';
      receipt.error_code = code;
      receipt.state = sent && !responseReceived ? 'outcome-unknown' : controller.signal.aborted || !current() || this.disposed ? 'cancelled' : 'failed';
    } finally {
      receipt.ended_at = now(); unwatch?.(); this.controllers.delete(controller); signal?.removeEventListener('abort', abort);
      if (receipt.asset_id) this.generated.get(receipt.asset_id)!.receipt = structuredClone(receipt);
      reportUsage('settled');
    }
    if (receipt.state === 'succeeded') void Promise.resolve().then(() => this.ports.preview?.(structuredClone(receipt))).catch(() => undefined);
    return structuredClone(receipt);
  }
  /**
   * v0.9.108: the image is saved in the workspace, so generation lets go of its own hold. The image stays while a task,
   * draft or pending action holds it, otherwise for the store's idle period.
   */
  savedToWorkspace(assetId: string): void {
    const generated = this.generated.get(assetId); if (!generated) return;
    const operation = generated.receipt.operation_id;
    this.saved.delete(operation); this.saved.add(operation);
    this.assets.release('generated:' + operation, [assetId]);
    this.forgetSaved(GENERATED_IMAGE_RECORD_LIMIT);
  }
  /** v0.9.108: at the end of a turn, forget the metadata of every saved image that nothing holds any more. */
  endTurn(): void { this.forgetSaved(0); }
  /**
   * Drop saved, no-longer-held images' records, oldest save first, until at most `limit` operations remain. Unsaved
   * images, running operations and images a task, draft or pending action still holds are never dropped.
   */
  private forgetSaved(limit: number): void {
    for (const operation of [...this.saved]) {
      if (this.operations.size <= limit) return;
      const asset = this.operations.get(operation)?.asset_id;
      if (asset && this.assets.isHeld(asset)) continue;
      this.saved.delete(operation); this.operations.delete(operation); this.rawUsage.delete(operation);
      if (asset) this.generated.delete(asset);
    }
  }
  dispose(): void {
    this.disposed = true; for (const controller of this.controllers) controller.abort();
    for (const operation of this.operations.values()) this.assets.release('generated:' + operation.operation_id);
  }
}
