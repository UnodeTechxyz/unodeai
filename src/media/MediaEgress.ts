/* A compact, content-free description of a proposed remote media upload. */

import type { MediaClass } from './MediaCapability';

export type MediaEgressKind = 'vision' | 'transcription';
export type MediaEgressOutcome = 'sent' | 'refused' | 'omitted';

export interface MediaEgressRequest {
  host: string;
  provider: string;
  kind: MediaEgressKind;
  mediaClass: MediaClass;
  byteCount: number;
  /** Frame count is relevant when video has already been decomposed. */
  frameCount?: number;
  /** Optional because token-equivalent image/audio pricing is route-specific and often unavailable. */
  estimatedInputCostUsd?: number;
}

export function describeMediaEgress(request: MediaEgressRequest): string {
  const boundedBytes = `${Math.max(0, Math.floor(request.byteCount)).toLocaleString()} bytes`;
  const frames = request.frameCount === undefined ? '' : `, ${Math.max(0, Math.floor(request.frameCount))} frame(s)`;
  const estimate = request.estimatedInputCostUsd === undefined
    ? 'Estimated input cost: unavailable for this route.'
    : `Estimated input cost: US$${Math.max(0, request.estimatedInputCostUsd).toFixed(4)}.`;
  return `${request.provider} (${request.host}) will receive ${request.mediaClass} media: ${boundedBytes}${frames}. ${estimate}`;
}

/** Only a preflight-safe, content-free shape may reach a consent presenter. */
export function validateMediaEgressRequest(value: MediaEgressRequest): MediaEgressRequest {
  if (!value.host.trim() || !value.provider.trim() || (value.kind !== 'vision' && value.kind !== 'transcription') ||
      (value.mediaClass !== 'image' && value.mediaClass !== 'audio') || !Number.isFinite(value.byteCount) || value.byteCount < 0 ||
      (value.frameCount !== undefined && (!Number.isFinite(value.frameCount) || value.frameCount < 0)) ||
      (value.estimatedInputCostUsd !== undefined && (!Number.isFinite(value.estimatedInputCostUsd) || value.estimatedInputCostUsd < 0))) {
    throw new Error('Invalid media egress request.');
  }
  return Object.freeze({
    host: value.host.trim(),
    provider: value.provider.trim(),
    kind: value.kind,
    mediaClass: value.mediaClass,
    byteCount: Math.floor(value.byteCount),
    ...(value.frameCount === undefined ? {} : { frameCount: Math.floor(value.frameCount) }),
    ...(value.estimatedInputCostUsd === undefined ? {} : { estimatedInputCostUsd: value.estimatedInputCostUsd }),
  });
}
