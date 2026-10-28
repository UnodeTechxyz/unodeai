import type { ChatMessage } from './OpenAICompatBackend';
import type { CompositionCategory, CompositionSpan, MessageCompositionSource } from './RequestComposition';

function atom(text: string, category: CompositionCategory): CompositionSpan[] {
  return text.length ? [{ start: 0, end: text.length, category }] : [];
}

function sourceFor(message: ChatMessage, category: CompositionCategory): MessageCompositionSource {
  return typeof message.content === 'string' ? { text: atom(message.content, category) }
    : { parts: new Map(Array.isArray(message.content) ? message.content.flatMap((part, index) =>
      part.type === 'text' ? [[index, atom(part.text, category)] as const] : []) : []) };
}

/** Numeric origins only; no serialization, content matching, transport, storage, or authority. */
export function openAICompositionSources(input: {
  history: readonly ChatMessage[];
  requestMessages: readonly ChatMessage[];
  finalMessages: readonly ChatMessage[];
  currentInput: WeakSet<ChatMessage>;
  hints: WeakMap<ChatMessage, MessageCompositionSource>;
  /** v0.9.99: the host's own record of who wrote a user message, kept from the turn it was appended in. */
  historySources?: WeakMap<ChatMessage, 'user' | 'delegation-result'>;
  contextFallback: boolean;
  hasContext: boolean;
  guide: string;
  queuedImage: boolean;
}): ReadonlyMap<number, MessageCompositionSource> {
  const sources = new Map<number, MessageCompositionSource>();
  input.history.forEach((message, index) => {
    const hint = input.hints.get(message);
    if (input.currentInput.has(message) && hint) sources.set(index, { ...hint, history: false });
    else {
      const historySource = message.role === 'user' ? input.historySources?.get(message) : undefined;
      sources.set(index, { history: message.role !== 'system',
        ...(hint?.xmlToolResult ? { xmlToolResult: hint.xmlToolResult }
          : message.role === 'user' ? { precision: 'partial' as const } : {}),
        ...(historySource ? { historySource } : {}) });
    }
  });
  if (input.hasContext) {
    const index = input.contextFallback
      ? input.history.map(message => message.role).lastIndexOf('user') : input.history.length;
    const target = index < 0 ? input.history.length : index;
    // Reviewed rare gateway fallback: the merged atom is host_context, explicitly partial, not guessed apart.
    sources.set(target, { ...sourceFor(input.requestMessages[target], 'host_context'),
      history: index >= 0 && index < input.history.length ? sources.get(index)?.history : false,
      ...(input.contextFallback ? { precision: 'partial' as const } : {}) });
  }
  if (input.queuedImage) {
    const index = input.requestMessages.length - 1;
    sources.set(index, { ...sourceFor(input.requestMessages[index], 'attachments'), history: false });
  }
  if (input.guide) {
    const systemIndex = input.requestMessages.findIndex(message => message.role === 'system');
    if (systemIndex < 0) {
      const shifted = [...sources];
      sources.clear();
      for (const [index, source] of shifted) sources.set(index + 1, source);
      sources.set(0, { text: atom(input.guide, 'tools'), history: false });
    } else {
      const original = input.requestMessages[systemIndex].content;
      const prefix = String(original);
      const source = sources.get(systemIndex);
      sources.set(systemIndex, { history: false, text: [
        ...(typeof original === 'string' && source?.text ? source.text : atom(prefix, 'system')),
        { start: prefix.length, end: prefix.length + 2 + input.guide.length, category: 'tools' },
      ], ...(typeof original !== 'string' || source?.precision ? { precision: 'partial' as const } : {}) });
    }
  }
  input.finalMessages.forEach((message, index) => {
    const source = sources.get(index);
    if (!source) return;
    // Cache breakpoints promote one string to a text block. They do not add context tokens.
    if (source.text && Array.isArray(message.content)) {
      sources.set(index, { ...source, text: undefined, parts: new Map([[0, source.text]]) });
    } else if (!source.text && source.parts && typeof message.content === 'string') {
      // An image rejection flattened the current atom. Retain only a truthful partial classification.
      sources.set(index, { history: source.history, precision: 'partial' });
    }
  });
  return sources;
}
