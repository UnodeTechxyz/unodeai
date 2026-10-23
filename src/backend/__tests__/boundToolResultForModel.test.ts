import { describe, expect, it } from 'vitest';
import { boundToolResultForModel, MODEL_TOOL_RESULT_MAX_CHARS } from '../boundToolResultForModel';

describe('boundToolResultForModel', () => {
  it('puts a stricter bound on model history and says what was not read', () => {
    const result = boundToolResultForModel('read_file', 'x'.repeat(MODEL_TOOL_RESULT_MAX_CHARS + 1));
    expect(result).toHaveLength(MODEL_TOOL_RESULT_MAX_CHARS + '[Tool result truncated. Omitted content was not read; do not claim complete coverage.]'.length + 1);
    expect(result).toContain('[Tool result truncated. Omitted content was not read; do not claim complete coverage.]');
  });

  it('never sends PDF-like bytes on to a provider', () => {
    expect(boundToolResultForModel('fetch_url', '%PDF-1.7\u0000raw bytes'))
      .toContain('No raw bytes were added to model context.');
  });

  it('envelopes any remote fetch result as untrusted data', () => {
    expect(boundToolResultForModel('fetch_url', 'ordinary page text')).toMatch(/^\[Untrusted remote content/);
  });
});
