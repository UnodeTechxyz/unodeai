/*---------------------------------------------------------------------------------------------
 *  UnodeAi - OpenRouter upstream provider (v0.9.90 Smart compaction design, §8)
 *
 *  OpenRouter returns its routing decision under `openrouter_metadata` when a request carries
 *  `X-OpenRouter-Metadata: enabled` (on the final chunk of a stream). The header goes only to OpenRouter's own host,
 *  it adds no request or call, and the host keeps only the selected endpoint's provider name. Missing or
 *  malformed metadata means "unavailable"; it can never break a turn.
 *--------------------------------------------------------------------------------------------*/

import { displayProviderName } from './emptyReplyOutcome';

export const OPENROUTER_METADATA_HEADER = 'X-OpenRouter-Metadata';

/** Whether requests to this base URL go to OpenRouter itself; no other gateway receives the header. */
export function requestsOpenRouterMetadata(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'openrouter.ai';
  } catch {
    return false;
  }
}

/** The provider of the endpoint OpenRouter marked `selected`, or undefined when the response does not say. */
export function openRouterSelectedProvider(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const metadata = (response as { openrouter_metadata?: unknown }).openrouter_metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const endpoints = (metadata as { endpoints?: unknown }).endpoints;
  const available = endpoints && typeof endpoints === 'object' ? (endpoints as { available?: unknown }).available : undefined;
  if (!Array.isArray(available)) return undefined;
  const selected = available.filter((entry) => entry && typeof entry === 'object' && (entry as { selected?: unknown }).selected === true);
  if (selected.length !== 1) return undefined;
  // A display name only: letters, digits and plain punctuation, so no control, bidi or Markdown character survives.
  return displayProviderName((selected[0] as { provider?: unknown }).provider);
}
