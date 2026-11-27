import { imageMimeFromBytes } from '../content/ContentAssetStore';
import type { McpToolImage } from './MCPHub';

/**
 * v0.9.105 (D5-2): which images an MCP tool returned may go to the model of a CLI route (Codex, Claude), as part of
 * that one tool result. The bytes stay in memory: no record, transcript, log or export holds them, only the counts and
 * reasons in the note this returns. The format is read from the bytes, never from the server's declared type.
 */
export const MCP_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MCP_IMAGES_PER_RESULT = 4;
export const MCP_IMAGES_TOTAL_BYTES = 10 * 1024 * 1024;

export interface McpImageForModel {
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  base64: string;
  byteLength: number;
}

/**
 * The images to attach, in the server's order, and one line for the model's text: how many were attached and why any
 * was left out. `undefined` when the tool returned no image.
 */
export function mcpImagesForModel(images: readonly McpToolImage[]): { accepted: McpImageForModel[]; note?: string; omittedNote?: string } {
  if (images.length === 0) return { accepted: [] };
  const accepted: McpImageForModel[] = [];
  const omitted = { format: 0, size: 0, count: 0, total: 0 };
  let total = 0;
  for (const image of images) {
    const mimeType = imageMimeFromBytes(image.data);
    if (!mimeType) { omitted.format += 1; continue; }
    if (image.data.byteLength > MCP_IMAGE_MAX_BYTES) { omitted.size += 1; continue; }
    if (accepted.length >= MCP_IMAGES_PER_RESULT) { omitted.count += 1; continue; }
    if (total + image.data.byteLength > MCP_IMAGES_TOTAL_BYTES) { omitted.total += 1; continue; }
    total += image.data.byteLength;
    accepted.push({ mimeType, base64: Buffer.from(image.data).toString('base64'), byteLength: image.data.byteLength });
  }
  const plural = (count: number) => (count === 1 ? '1 image' : `${count} images`);
  const omissions = [
    omitted.format > 0 ? `${plural(omitted.format)} not attached: not a PNG, JPEG, GIF or WebP image` : '',
    omitted.size > 0 ? `${plural(omitted.size)} not attached: larger than ${MCP_IMAGE_MAX_BYTES / (1024 * 1024)} MB` : '',
    omitted.count > 0 ? `${plural(omitted.count)} not attached: at most ${MCP_IMAGES_PER_RESULT} images per result` : '',
    omitted.total > 0 ? `${plural(omitted.total)} not attached: more than ${MCP_IMAGES_TOTAL_BYTES / (1024 * 1024)} MB of images in one result` : '',
  ].filter(Boolean);
  const parts = [accepted.length > 0 ? `${plural(accepted.length)} from this tool attached for you to see` : '', ...omissions].filter(Boolean);
  return {
    accepted,
    note: `[UnodeAi: ${parts.join('; ')}.]`,
    // v0.9.105 (D5-3): for a route that keeps the images as assets instead of attaching them.
    ...(omissions.length > 0 ? { omittedNote: `[UnodeAi: ${omissions.join('; ')}.]` } : {}),
  };
}
