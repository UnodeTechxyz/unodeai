/**
 * The host's future media-analysis boundary. It is intentionally not a downloader: bytes first enter the
 * temporary ContentAssetStore, and a route-specific capability then decides whether any analysis is offered.
 */
export interface RichContentCapabilities {
  /** Local OCR can inspect an image without sending it to another provider. */
  canRunLocalOcr(assetId: string): boolean;
  /** Vision is a separate, explicit egress grant. Web-download consent never implies this. */
  canSendImageToVisionProvider(assetId: string): boolean;
  /** Video remains deliberately unimplemented in PDF v1. */
  canAnalyzeVideo(assetId: string): boolean;
}

export function unsupportedRichContentMessage(media: 'image' | 'video'): string {
  return media === 'image'
    ? 'Image analysis is unsupported in this release. The image was not converted to binary text or uploaded to a vision provider.'
    : 'Video analysis is unsupported in this release. The video was not transcribed, frame-sampled, or uploaded to a provider.';
}
