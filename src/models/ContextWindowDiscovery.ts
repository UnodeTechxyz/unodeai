import type { ContextWindowField, ContextWindowMeasurement } from '../types';

const CONTEXT_WINDOW_FIELDS: readonly ContextWindowField[] = [
  'context_length',
  'max_context_length',
  'context_window',
];

/**
 * Read a provider-advertised window from the record for ONE model.
 *
 * OpenAI-compatible gateways agree on `/models`, not on the field spelling or the nesting. Search only
 * the selected model record, so a larger neighbour's number can never be borrowed. Missing or malformed
 * metadata is an ordinary absence: callers retain the existing/default value rather than manufacturing one.
 */
export function discoverContextWindow(
  model: string,
  record: unknown,
): ContextWindowMeasurement | undefined {
  const discovered = findContextWindow(record, new Set<object>());
  return discovered === undefined
    ? undefined
    : { model, tokens: discovered.tokens, field: discovered.field };
}

function findContextWindow(
  value: unknown,
  seen: Set<object>,
): { tokens: number; field: ContextWindowField } | undefined {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findContextWindow(item, seen);
      if (found) { return found; }
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const field of CONTEXT_WINDOW_FIELDS) {
    const tokens = tokenCount(record[field]);
    if (tokens !== undefined) {
      return { tokens, field };
    }
  }
  for (const child of Object.values(record)) {
    const found = findContextWindow(child, seen);
    if (found) { return found; }
  }
  return undefined;
}

function tokenCount(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : undefined;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : undefined;
}
