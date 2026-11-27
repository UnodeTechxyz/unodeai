export const WEB_SEARCH_TOOL = 'web_search';
export const WEB_SEARCH_TOOL_SPEC = { type: 'function' as const, function: {
  name: WEB_SEARCH_TOOL,
  description: 'Search the public web through the configured Unode connection. Results are external sources and excerpts. Use fetch_url separately when the task needs the full page.',
  parameters: { type: 'object' as const, additionalProperties: false, properties: {
    query: { type: 'string', description: 'A public-web search query for this task.' },
  }, required: ['query'] },
} };

/** Tool events, approval-independent activity and portable evidence may not expose a search query. */
export function publicSearchActivityInput(name: string, input: unknown): unknown {
  return name === WEB_SEARCH_TOOL || name === 'WebSearch' || name.endsWith('__' + WEB_SEARCH_TOOL)
    ? { query_omitted: true } : input;
}
