import { isBlockedWebHost } from './webFetch';

export interface SearchSource {
  title: string;
  url: string;
  page_age?: string;
  cited_text: string[];
  source_status: 'search-result' | 'body-retrieved';
}

export interface SearchUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  web_search_requests?: number;
}

export interface SearchResponse {
  state: 'completed' | 'partial' | 'no-results' | 'no-structured-sources' | 'no-search-executed' | 'service-failed';
  answer: string;
  sources: SearchSource[];
  usage: SearchUsage;
  estimatedSearchCount?: number;
  error?: 'max-uses' | 'upstream-search-failed';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function publicSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !isBlockedWebHost(url.hostname)) {
      return url.href;
    }
  } catch { /* Malformed sources remain outside the result. */ }
  return undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1e12 ? value : undefined;
}

/** Native CLI text and markdown links carry no structured attribution. */
export function structuredSearchSources(blocks: readonly unknown[]): SearchSource[] {
  const sources = new Map<string, SearchSource>();
  for (const raw of blocks) {
    const source = record(raw);
    if (source?.type !== 'web_search_result' || typeof source.title !== 'string') continue;
    const url = publicSourceUrl(source.url);
    if (!url || sources.has(url)) continue;
    sources.set(url, { title: source.title, url, source_status: 'search-result', cited_text: [],
      ...(typeof source.page_age === 'string' ? { page_age: source.page_age } : {}) });
  }
  return [...sources.values()];
}

/** A Messages reply contains both model text and structured sources. Only the latter establish attribution. */
export function parseUnodeSearchResponse(value: unknown): { result: SearchResponse; queries: string[] } | undefined {
  const message = record(value);
  if (message?.type !== 'message' || message.role !== 'assistant' || !Array.isArray(message.content)) return undefined;
  const blocks = message.content.map(record).filter(block => block !== undefined);
  const calls = new Map<string, string | undefined>();
  for (const block of blocks) {
    const query = record(block.input)?.query;
    if (block.type === 'server_tool_use' && block.name === 'web_search' && typeof block.id === 'string') {
      calls.set(block.id, typeof query === 'string' ? query : undefined);
    }
  }
  const queries = [...calls.values()].filter((query): query is string => query !== undefined);

  const sources = new Map<string, SearchSource>();
  const matchedSearches = new Set<string>();
  let hasResultBlock = false;
  let receivedResult = false;
  let error: SearchResponse['error'];
  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result') continue;
    hasResultBlock = true;
    if (typeof block.tool_use_id !== 'string' || !calls.has(block.tool_use_id)) continue;
    matchedSearches.add(block.tool_use_id);
    if (!Array.isArray(block.content)) {
      const failure = record(block.content);
      if (failure?.type === 'web_search_tool_result_error') {
        error = failure.error_code === 'max_uses_exceeded' ? 'max-uses' : 'upstream-search-failed';
      }
      continue;
    }
    receivedResult = true;
    for (const source of structuredSearchSources(block.content)) {
      if (!sources.has(source.url)) sources.set(source.url, source);
    }
  }

  const text: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    text.push(block.text);
    if (!Array.isArray(block.citations)) continue;
    for (const raw of block.citations) {
      const citation = record(raw);
      if (citation?.type !== 'web_search_result_location' || typeof citation.cited_text !== 'string') continue;
      const url = publicSourceUrl(citation.url);
      const source = url ? sources.get(url) : undefined;
      if (source && !source.cited_text.includes(citation.cited_text)) source.cited_text.push(citation.cited_text);
    }
  }

  const rawUsage = record(message.usage);
  const serverUsage = record(rawUsage?.server_tool_use);
  const usage: SearchUsage = {};
  for (const field of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
    const measured = count(rawUsage?.[field]);
    if (measured !== undefined) usage[field] = measured;
  }
  const searches = count(serverUsage?.web_search_requests);
  if (searches !== undefined) usage.web_search_requests = searches;

  if (!hasResultBlock && (searches === undefined || searches === 0)) {
    usage.web_search_requests = 0;
    return { queries, result: { state: 'no-search-executed',
      answer: 'The search service answered without searching. There are no sources; this answer must not be presented as sourced.\n' + text.join(''),
      sources: [], usage } };
  }

  let state: SearchResponse['state'] = receivedResult ? 'no-results' : 'no-structured-sources';
  if (error) state = receivedResult ? 'partial' : 'service-failed';
  else if (sources.size) state = message.stop_reason === 'max_tokens' || message.stop_reason === 'pause_turn' ? 'partial' : 'completed';
  return { queries, result: { state, answer: text.join(''), sources: [...sources.values()], usage,
    ...(searches === undefined && matchedSearches.size > 0 ? { estimatedSearchCount: matchedSearches.size } : {}),
    ...(error ? { error } : {}) } };
}
