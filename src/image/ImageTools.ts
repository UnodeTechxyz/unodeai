import { IMAGE_MODEL, UNODE_IMAGE_MODEL, type SupportedImageModel } from './ImageConnectionRegistry';
export const GENERATE_IMAGE_TOOL = 'generate_image';
export const SAVE_GENERATED_ASSET_TOOL = 'save_generated_asset';
/** Activity/log/export sinks get no image prompt; the private model history and actual call keep it. */
export function imageActivityInput(name: string, input: unknown): unknown {
  if (name !== GENERATE_IMAGE_TOOL && !name.endsWith('__' + GENERATE_IMAGE_TOOL)) return input;
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return { prompt_omitted: true, size: ['1536x1024', '1024x1024', '1024x1536'].includes(String(args.size)) ? args.size : undefined,
    ...(typeof args.variant_of === 'string' && /^image-[0-9a-f-]{36}$/.test(args.variant_of) ? { variant_of: args.variant_of } : {}) };
}
export type ImageSize = '1536x1024' | '1024x1024' | '1024x1536';
export interface ImageRequest { prompt: string; size: ImageSize; variant_of?: string }
export function defaultImageSize(model: SupportedImageModel): ImageSize {
  return model === UNODE_IMAGE_MODEL ? '1024x1024' : '1536x1024';
}
export function imageRequest(args: Record<string, unknown>, model: SupportedImageModel = IMAGE_MODEL): ImageRequest {
  if (Object.keys(args).some(key => !['prompt', 'size', 'variant_of'].includes(key)) || typeof args.prompt !== 'string' || !args.prompt.trim()
    || args.size !== undefined && !['1536x1024', '1024x1024', '1024x1536'].includes(String(args.size))
    || args.variant_of !== undefined && (typeof args.variant_of !== 'string' || !/^image-[0-9a-f-]{36}$/.test(args.variant_of))) throw Error('invalid-image-request');
  return { prompt: args.prompt, size: (args.size ?? defaultImageSize(model)) as ImageSize, ...(args.variant_of ? { variant_of: args.variant_of as string } : {}) };
}
export const GENERATE_IMAGE_SPEC = { type: 'function' as const, function: {
  name: GENERATE_IMAGE_TOOL,
  description: 'Generate one PNG using the configured image connection. Check Agent Builder > Media models for the member choice or Settings > Providers for the default. A task can generate multiple images in separate operations. Requires no Commands permission. The result is an immutable asset. Use save_generated_asset for a workspace original, or its asset_id in Office image inputs. variant_of creates a new version and retains the original. Never automatically retry an outcome-unknown operation: it may already have been charged. Reference images and image editing are unavailable.',
  parameters: { type: 'object' as const, additionalProperties: false, properties: {
    prompt: { type: 'string', description: 'Image content/style instructions; generate a separate illustration, not a flattened document page.' },
    size: { type: 'string', enum: ['1536x1024', '1024x1024', '1024x1536'], description: 'Omit for the selected model default. Unode supports 1024x1024.' },
    variant_of: { type: 'string', description: 'Prior accessible image operation_id for an intentionally requested new version.' },
  }, required: ['prompt'] },
} };

export function imageSpecForModel(model: SupportedImageModel): typeof GENERATE_IMAGE_SPEC {
  const spec = GENERATE_IMAGE_SPEC.function;
  return { ...GENERATE_IMAGE_SPEC, function: { ...spec, description: `${spec.description} Current image model: ${model}.`,
    parameters: { ...spec.parameters, properties: { ...spec.parameters.properties, size: {
      ...spec.parameters.properties.size,
      enum: model === UNODE_IMAGE_MODEL ? ['1024x1024'] : spec.parameters.properties.size.enum,
      description: `Default ${defaultImageSize(model)}. Requests a medium quality PNG.`,
    } } },
  } };
}
export const SAVE_GENERATED_ASSET_SPEC = { type: 'function' as const, function: {
  name: SAVE_GENERATED_ASSET_TOOL,
  description: 'Save the exact immutable PNG from generate_image through normal file-write approval, restore and readback. Supply its asset_id and destination .png path. A local save failure retains the original asset: correct the path/permission and retry this save, not paid generation. Does not save user attachments; use save_attachment for those.',
  parameters: { type: 'object' as const, additionalProperties: false, properties: { asset_id: { type: 'string' }, path: { type: 'string' } }, required: ['asset_id', 'path'] },
} };
