import { describe, expect, it } from 'vitest';
import {
  normalizeSuggestionOutput,
  selectSuggestionInput,
  suggestionRequestMessages,
  SUGGESTION_MAX_LAST_ANSWER_CODE_POINTS,
  SUGGESTION_MAX_LAST_USER_CODE_POINTS,
  SUGGESTION_MAX_TOTAL_CODE_POINTS,
  SUGGESTION_TRUNCATION_MARKER,
  type SuggestionSourceMessage,
} from '../ReplySuggestionInput';

const user = (text: string): SuggestionSourceMessage => ({ role: 'user', text });
const agent = (text: string, extra: Partial<SuggestionSourceMessage> = {}): SuggestionSourceMessage => ({ role: 'agent', text, ...extra });
const length = (text: string) => Array.from(text).length;

describe('selectSuggestionInput', () => {
  it('keeps at most the last 8 visible messages, oldest first', () => {
    const messages = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? user(`u${i}`) : agent(`a${i}`)));
    const input = selectSuggestionInput(messages);
    expect(input.map((message) => message.text)).toEqual(['u4', 'a5', 'u6', 'a7', 'u8', 'a9', 'u10', 'a11']);
  });

  it('excludes errors, host notices, unfinished replies and compaction summaries', () => {
    const input = selectSuggestionInput([
      user('question'),
      agent('provider failed', { isError: true }),
      agent('UnodeAi notice', { runtimeNotice: true }),
      agent('reminder', { noticeKey: 'spend:80' }),
      agent('half an answer', { interruptedReply: true }),
      agent('summary', { compactionSummary: 'older turns' }),
      agent('the answer'),
    ]);
    expect(input.map((message) => message.text)).toEqual(['question', 'the answer']);
  });

  it('makes nothing when the conversation does not end with an answer', () => {
    expect(selectSuggestionInput([agent('hello'), user('a new question')])).toEqual([]);
    expect(selectSuggestionInput([])).toEqual([]);
  });

  it('keeps the tails of a long last answer and a long last user message, and marks them cut', () => {
    const longUser = `${'u'.repeat(5_000)}END-USER`;
    const longAnswer = `${'a'.repeat(7_000)}END-ANSWER`;
    const input = selectSuggestionInput([user(longUser), agent(longAnswer)]);
    expect(length(input[0].text)).toBe(SUGGESTION_MAX_LAST_USER_CODE_POINTS);
    expect(input[0]).toMatchObject({ truncated: true });
    expect(input[0].text.endsWith('END-USER')).toBe(true);
    expect(length(input[1].text)).toBe(SUGGESTION_MAX_LAST_ANSWER_CODE_POINTS);
    expect(input[1].text.endsWith('END-ANSWER')).toBe(true);
    const prompt = suggestionRequestMessages(input)[1].content;
    expect(prompt).toContain(`User:\n${SUGGESTION_TRUNCATION_MARKER}`);
  });

  it('gives the rest of the 12,000 code point budget to earlier messages, newest first', () => {
    const input = selectSuggestionInput([
      user('o'.repeat(3_000)),
      agent('n'.repeat(3_000)),
      user('u'.repeat(4_000)),
      agent('a'.repeat(6_000)),
    ]);
    const total = input.reduce((sum, message) => sum + length(message.text), 0);
    expect(total).toBe(SUGGESTION_MAX_TOTAL_CODE_POINTS);
    // 10,000 for the last pair, 2,000 left: the tail of the newer earlier message, and nothing older.
    expect(input.map((message) => [message.text[0], length(message.text), message.truncated])).toEqual([
      ['n', 2_000, true], ['u', 4_000, false], ['a', 6_000, false],
    ]);
  });

  it('counts code points, not UTF-16 units', () => {
    const input = selectSuggestionInput([user('😀'.repeat(4_100)), agent('ok')]);
    expect(length(input[0].text)).toBe(SUGGESTION_MAX_LAST_USER_CODE_POINTS);
    expect(input[0].text).toBe('😀'.repeat(4_000));
  });

  it('redacts secrets before counting, also in text already visible in the chat', () => {
    // Built at run time so the test source holds no key-shaped literal.
    const fake = ['sk', 'live', '1234567890abcdef'].join('-');
    const input = selectSuggestionInput([user(`my key is api_key=${fake} please use it`), agent('done')]);
    expect(input[0].text).not.toContain(fake);
    expect(input[0].text).toContain('[redacted]');
  });

  it('keeps code a person quoted into visible text: that text is sent, as the disclosure says', () => {
    const input = selectSuggestionInput([user('```ts\nconst x = 1;\n```'), agent('That declares x.')]);
    expect(input[0].text).toContain('const x = 1;');
  });
});

describe('normalizeSuggestionOutput', () => {
  it('shows one line of plain text of at most 300 code points, or nothing', () => {
    expect(normalizeSuggestionOutput('  Run the tests next.  ')).toBe('Run the tests next.');
    expect(normalizeSuggestionOutput('"Run the tests next."')).toBe('Run the tests next.');
    expect(normalizeSuggestionOutput('a'.repeat(300))).toBe('a'.repeat(300));
    expect(normalizeSuggestionOutput('a'.repeat(301))).toBeUndefined();
    expect(normalizeSuggestionOutput('line one\nline two')).toBeUndefined();
    expect(normalizeSuggestionOutput('bell\u0007')).toBeUndefined();
    expect(normalizeSuggestionOutput('')).toBeUndefined();
    expect(normalizeSuggestionOutput(42)).toBeUndefined();
  });
});
