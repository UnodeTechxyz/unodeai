import { ChatHistoryMessage, serializeChatHistory } from './chatHistory';
import { MessageLogItem } from './transcriptPort';

/**
 * The host-owned, UI-safe event model shared by the human-to-agent transcript and
 * agent-to-agent Messages surfaces. It deliberately stores only presentation data:
 * no backend instances, credentials, raw tool payloads, or workspace paths.
 *
 * A Workbench is a second projection of this model, not a second session store.
 */
export type AgentCoordinationMessage = MessageLogItem;

export type PresentationEvent =
  | { seq: number; stream: 'human-agent'; sessionId: string; message: ChatHistoryMessage }
  | { seq: number; stream: 'agent-agent'; message: AgentCoordinationMessage };

export class SessionPresentationModel {
  private events: PresentationEvent[] = [];
  private nextSequence = 0;
  private readonly hydratedTranscripts = new Set<string>();
  private _selectedAgentId = '';

  get selectedAgentId(): string {
    return this._selectedAgentId;
  }

  selectAgent(agentId: string): void {
    this._selectedAgentId = agentId;
  }

  hasTranscript(sessionId: string): boolean {
    return this.hydratedTranscripts.has(sessionId);
  }

  transcript(sessionId: string): ChatHistoryMessage[] {
    return this.events
      .filter((event): event is Extract<PresentationEvent, { stream: 'human-agent' }> =>
        event.stream === 'human-agent' && event.sessionId === sessionId)
      .sort(comparePresentationEvents)
      .map((event) => cloneChatMessage(event.message));
  }

  replaceTranscript(sessionId: string, messages: readonly ChatHistoryMessage[]): void {
    const next = serializeChatHistory([...messages]);
    const candidates = next.map((message) => ({ message, matched: false }));
    const candidatesByKey = groupCandidates(candidates, chatMessageKey);

    const preserved: PresentationEvent[] = [];
    for (const event of this.events) {
      if (event.stream !== 'human-agent' || event.sessionId !== sessionId) {
        preserved.push(event);
        continue;
      }
      const candidate = candidatesByKey.get(chatMessageKey(event.message))?.shift();
      if (candidate) {
        candidate.matched = true;
        // Preserve the model-assigned sequence and therefore the event's position relative to the other stream.
        preserved.push({ ...event, message: cloneChatMessage(candidate.message) });
      }
    }
    for (const candidate of candidates) {
      if (!candidate.matched) {
        preserved.push({
          seq: this.nextSequence++,
          stream: 'human-agent',
          sessionId,
          message: cloneChatMessage(candidate.message),
        });
      }
    }
    this.events = preserved;
    this.hydratedTranscripts.add(sessionId);
  }

  clearTranscript(sessionId: string): void {
    this.replaceTranscript(sessionId, []);
  }

  agentMessages(): AgentCoordinationMessage[] {
    return this.events
      .filter((event): event is Extract<PresentationEvent, { stream: 'agent-agent' }> => event.stream === 'agent-agent')
      .sort(comparePresentationEvents)
      .map((event) => cloneAgentMessage(event.message));
  }

  appendAgentMessage(message: AgentCoordinationMessage): void {
    this.events.push({ seq: this.nextSequence++, stream: 'agent-agent', message: cloneAgentMessage(message) });
  }

  /** Replace the newest coordination projection in place, preserving its cross-stream arrival sequence. */
  replaceLastAgentMessage(message: AgentCoordinationMessage): boolean {
    let newest: Extract<PresentationEvent, { stream: 'agent-agent' }> | undefined;
    for (const event of this.events) {
      if (event.stream === 'agent-agent' && (!newest || event.seq > newest.seq)) {
        newest = event;
      }
    }
    if (!newest) {
      return false;
    }
    newest.message = cloneAgentMessage(message);
    return true;
  }

  replaceAgentMessages(messages: readonly AgentCoordinationMessage[]): void {
    const candidates = messages.map((message) => ({ message, matched: false }));
    const candidatesByKey = groupCandidates(candidates, agentMessageKey);

    const preserved: PresentationEvent[] = [];
    for (const event of this.events) {
      if (event.stream !== 'agent-agent') {
        preserved.push(event);
        continue;
      }
      const candidate = candidatesByKey.get(agentMessageKey(event.message))?.shift();
      if (candidate) {
        candidate.matched = true;
        preserved.push({ ...event, message: cloneAgentMessage(candidate.message) });
      }
    }
    for (const candidate of candidates) {
      if (!candidate.matched) {
        preserved.push({ seq: this.nextSequence++, stream: 'agent-agent', message: cloneAgentMessage(candidate.message) });
      }
    }
    this.events = preserved;
  }

  clearAgentMessages(): void {
    this.replaceAgentMessages([]);
  }

  /** Drop only the oldest coordination events. Human-to-agent transcript events retain their position. */
  trimAgentMessages(limit: number): number {
    const safeLimit = Math.max(0, Math.floor(limit));
    const overflow = this.events.filter((event) => event.stream === 'agent-agent').length - safeLimit;
    if (overflow <= 0) {
      return 0;
    }
    const evicted = new Set(
      this.events
        .filter((event): event is Extract<PresentationEvent, { stream: 'agent-agent' }> => event.stream === 'agent-agent')
        .sort(comparePresentationEvents)
        .slice(0, overflow)
        .map((event) => event.seq)
    );
    this.events = this.events.filter((event) => !evicted.has(event.seq));
    return overflow;
  }

  /** The future Workbench reads this one event log; it never needs to reconstruct chronology from `time`. */
  orderedEvents(): PresentationEvent[] {
    return this.events
      .slice()
      .sort(comparePresentationEvents)
      .map((event) => event.stream === 'human-agent'
        ? { ...event, message: cloneChatMessage(event.message) }
        : { ...event, message: cloneAgentMessage(event.message) });
  }
}

function cloneChatMessage(message: ChatHistoryMessage): ChatHistoryMessage {
  return {
    ...message,
    attachments: message.attachments?.map((attachment) => ({ ...attachment })),
  };
}

function cloneAgentMessage(message: AgentCoordinationMessage): AgentCoordinationMessage {
  return { ...message };
}

function comparePresentationEvents(a: PresentationEvent, b: PresentationEvent): number {
  return a.seq - b.seq;
}

function chatMessageKey(message: ChatHistoryMessage): string {
  return JSON.stringify([
    message.seq ?? null,
    message.role,
    message.text,
    message.ts,
    message.fromName ?? null,
    message.isError === true,
    message.completionState ?? null,
    message.attachments ?? [],
  ]);
}

function agentMessageKey(message: AgentCoordinationMessage): string {
  return JSON.stringify([
    message.timestamp ?? null,
    message.time,
    message.from,
    message.to,
    message.type,
    message.priority,
    message.content,
  ]);
}

function groupCandidates<T>(
  candidates: Array<{ message: T; matched: boolean }>,
  keyFor: (message: T) => string,
): Map<string, Array<{ message: T; matched: boolean }>> {
  const byKey = new Map<string, Array<{ message: T; matched: boolean }>>();
  for (const candidate of candidates) {
    const key = keyFor(candidate.message);
    const group = byKey.get(key) ?? [];
    group.push(candidate);
    byKey.set(key, group);
  }
  return byKey;
}
