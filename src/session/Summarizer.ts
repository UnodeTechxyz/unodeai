import { AgentModelParams } from '../types';

export interface SummarizerMessage {
  role: string;
  content?: string | null;
}

export interface SummarizerIO {
  chatCompletion: (
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    model: string,
    params?: AgentModelParams
  ) => Promise<string>;
}

export interface Summarizer {
  summarize(
    io: SummarizerIO,
    toDrop: SummarizerMessage[],
    existingSummary: string | undefined,
    economyModel: string
  ): Promise<string>;
}

const SYSTEM_PROMPT =
  'You are a conversation summarizer. Produce a concise, factual summary of the conversation turns below. ' +
  'Only include key facts: decisions made, files changed, errors encountered, and commitments. ' +
  'Omit filler and speculation.';

export class LlmSummarizer implements Summarizer {
  async summarize(
    io: SummarizerIO,
    toDrop: SummarizerMessage[],
    existingSummary: string | undefined,
    economyModel: string
  ): Promise<string> {
    const previous = existingSummary?.trim();
    if (toDrop.length === 0) {
      return previous ?? '';
    }

    const user = [
      previous ? `Previous summary:\n${previous}` : undefined,
      'Now summarize these additional conversation turns into a concise factual summary. ' +
        'Preserve key decisions, commitments, file paths, and error messages.',
      formatTurns(toDrop),
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = (await io.chatCompletion(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      economyModel,
      { temperature: 0.1 }
    )).trim();

    return previous ? `${previous}\n---\n${result}` : result;
  }
}

function formatTurns(messages: SummarizerMessage[]): string {
  return messages
    .map((m, i) => {
      const content = typeof m.content === 'string' ? m.content : '';
      return `Turn ${i + 1} (${m.role}):\n${content}`;
    })
    .join('\n\n');
}
