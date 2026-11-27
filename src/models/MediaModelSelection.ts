export type MediaCapability = 'image-generation' | 'audio-transcription';
export interface MediaModel {
  connectionId: string;
  modelId: string;
}
export type MediaSelection = 'inherit' | 'off' | MediaModel;
export interface AgentMediaModels {
  imageGeneration?: MediaSelection;
  transcription?: MediaSelection;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseMediaModel(value: unknown): MediaModel | undefined {
  const input = record(value);
  if (!input || Object.keys(input).some(key => key !== 'connectionId' && key !== 'modelId')) return undefined;
  const { connectionId, modelId } = input;
  if (typeof connectionId !== 'string' || !connectionId.trim() || connectionId !== connectionId.trim()
    || typeof modelId !== 'string' || !modelId.trim() || modelId !== modelId.trim()) return undefined;
  return { connectionId, modelId };
}

export function parseAgentMediaModels(value: unknown): AgentMediaModels | undefined {
  const input = record(value);
  if (!input || Object.keys(input).some(key => key !== 'imageGeneration' && key !== 'transcription')) return undefined;
  const parsed: AgentMediaModels = {};
  for (const feature of ['imageGeneration', 'transcription'] as const) {
    const raw = input[feature];
    if (raw === undefined) continue;
    const selection = raw === 'inherit' || raw === 'off' ? raw : parseMediaModel(raw);
    if (!selection) return undefined;
    parsed[feature] = selection;
  }
  return parsed;
}

export function effectiveMediaModel(selection: MediaSelection | undefined, defaultModel: MediaModel | undefined): MediaModel | undefined {
  if (selection === 'off') return undefined;
  return selection === 'inherit' || selection === undefined ? defaultModel : selection;
}

export function readMediaEndpointTypes(value: unknown): MediaCapability[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((entry): entry is MediaCapability =>
    entry === 'image-generation' || entry === 'audio-transcription'))];
}
