/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Verbatim reply blocks (v0.9.88 §5.5)
 *
 *  A reply that holds host-published exact content renders as Markdown for the text around it and one
 *  verbatim block for the content itself, so its line breaks and characters survive. The span comes from
 *  the host's typed publication; nothing here looks at the text to decide what is exact.
 *--------------------------------------------------------------------------------------------*/

import type { ChatVerbatim } from './chatHistory';
import { renderMarkdown, type MarkdownBlock } from './markdown';

/** The caption counts Unicode code points, as the model's `visible_characters` does. */
export function verbatimCaption(exact: string, span: ChatVerbatim): string {
  const count = [...exact].length.toLocaleString('en-US');
  if (span.clipped) return `Exact content (first ${count} characters kept in the transcript)`;
  if (span.partial) return `Exact content (first ${count} characters)`;
  return 'Exact content';
}

export function verbatimReplyBlocks(text: string, span: ChatVerbatim): MarkdownBlock[] {
  const exact = text.slice(span.start, span.start + span.length);
  const before = text.slice(0, span.start);
  const after = text.slice(span.start + span.length);
  return [
    ...(before.trim() ? renderMarkdown(before) : []),
    { type: 'verbatim', text: exact, caption: verbatimCaption(exact, span) },
    ...(after.trim() ? renderMarkdown(after) : []),
  ];
}
