import type { ConnectionResolver } from '../routes/ConnectionRegistry';
import { canonicalEndpointBase } from '../routes/RouteContracts';
import { effectiveMediaModel, type MediaSelection } from '../models/MediaModelSelection';
import { UNODE_DEFAULT_BASE_URL } from '../backend/openAICompatBaseUrl';

export const IMAGE_MODEL = 'gpt-image-2.6-flare';
export const UNODE_IMAGE_MODEL = 'gpt-image-2';
export const IMAGE_ENDPOINT = 'https://api.openai.com/v1';
export type SupportedImageModel = typeof IMAGE_MODEL | typeof UNODE_IMAGE_MODEL;
export class ImageOperationFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
export interface ImageConnection {
  capability: 'image-generation';
  connectionId: string; revision: number; endpointBase: string; secretName: string; epoch: string;
  agentId?: string;
  modelId: SupportedImageModel;
}
/** Capability selection references the central connection identity; it owns no accounts or credentials. */
export class ImageConnectionRegistry {
  private epoch = 0;
  private readonly profileEpochs = new Map<string, number>();
  private readonly memberEpochs = new Map<string, number>();
  private readonly pending = new Map<AbortController, ImageConnection>();
  constructor(
    private readonly resolver: () => ConnectionResolver,
    private readonly selected: () => string | undefined,
    private readonly memberSelection: (agentId: string) => MediaSelection | undefined = () => undefined,
    private readonly defaultModel: () => string | undefined = () => IMAGE_MODEL,
  ) {}
  supports(connectionId: string): boolean {
    return this.resolve(connectionId) !== undefined;
  }
  modelForConnection(connectionId: string): SupportedImageModel | undefined {
    return this.resolve(connectionId)?.modelId;
  }
  private resolve(connectionId: string) {
    const profile = this.resolver().connectionProfile(connectionId);
    if (!profile || profile.availability !== 'available' || profile.authKind !== 'api-key' || profile.backendKind !== 'openai-compat') return undefined;
    try {
      const endpointBase = canonicalEndpointBase(profile.presentation.endpointDefault ?? '');
      if (endpointBase === IMAGE_ENDPOINT) return { profile, endpointBase, modelId: IMAGE_MODEL } as const;
      if (connectionId === 'unode' && endpointBase === UNODE_DEFAULT_BASE_URL) return { profile, endpointBase, modelId: UNODE_IMAGE_MODEL } as const;
    } catch { /* Connection has no canonical endpoint. */ }
    return undefined;
  }
  capture(agentId?: string): ImageConnection {
    const id = this.selected();
    const modelId = this.defaultModel();
    const model = effectiveMediaModel(agentId ? this.memberSelection(agentId) : undefined,
      id && modelId ? { connectionId: id, modelId } : undefined);
    if (!model) throw new ImageOperationFailure('image-connection-not-selected');
    const route = this.resolve(model.connectionId);
    if (!route || model.modelId !== route.modelId) throw new ImageOperationFailure('image-endpoint-not-implemented');
    const { profile, endpointBase, modelId: selectedModel } = route;
    if (!profile.apiKeySecretName) throw new ImageOperationFailure('image-key-not-configured');
    return {
      capability: 'image-generation', connectionId: model.connectionId, modelId: selectedModel,
      revision: profile.revision, endpointBase, secretName: profile.apiKeySecretName,
      ...(agentId ? { agentId } : {}),
      epoch: `${this.epoch}:${this.profileEpochs.get(model.connectionId) ?? 0}:${agentId ? this.memberEpochs.get(agentId) ?? 0 : 0}`,
    };
  }
  check(expected: ImageConnection): void {
    const current = this.capture(expected.agentId);
    if (Object.keys(expected).some(key => expected[key as keyof ImageConnection] !== current[key as keyof ImageConnection])) {
      throw new ImageOperationFailure('image-connection-changed');
    }
  }
  watch(expected: ImageConnection, controller: AbortController): () => void {
    this.check(expected); this.pending.set(controller, expected);
    return () => this.pending.delete(controller);
  }
  /** Called synchronously on selection, credential, registry and egress changes, before another effect starts. */
  invalidate(connectionId?: string): void {
    if (connectionId) this.profileEpochs.set(connectionId, (this.profileEpochs.get(connectionId) ?? 0) + 1); else this.epoch++;
    for (const [controller, expected] of this.pending) if (!connectionId || expected.connectionId === connectionId) controller.abort();
  }
  refresh(): void { for (const [controller, expected] of this.pending) { try { this.check(expected); } catch { controller.abort(); } } }
  invalidateMember(agentId: string): void {
    this.memberEpochs.set(agentId, (this.memberEpochs.get(agentId) ?? 0) + 1);
    for (const [controller, expected] of this.pending) if (expected.agentId === agentId) controller.abort();
  }
  dispose(): void { this.invalidate(); }
}
