/*---------------------------------------------------------------------------------------------
 *  UnodeAi - MessageBus
 *  Central pub/sub message broker for inter-agent communication
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  Message,
  MessageType,
  MessagePriority,
  MessagePayloadFor,
  MessageHandler,
  MessagePattern,
  MessageFilter,
} from '../types';

export type MessageBusEvent = 'message.sent' | 'message.matched' | 'message.expired' | 'error';

/**
 * Lightweight pub/sub message broker for agent-to-agent communication.
 * Supports pattern-based subscriptions, priority queuing, TTL expiry,
 * correlation tracking, and message persistence.
 */
export class MessageBus {
  private emitter = new EventEmitter();
  private subscriptions: Map<string, { pattern: MessagePattern; handler: MessageHandler }> = new Map();
  private messageStore: Message[] = [];
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(private maxStoreSize: number = 10000) {
    this.startExpiryCheck();
  }

  // ─── Send ───────────────────────────────────────────────────────────

  send<T extends MessageType>(
    from: string,
    to: string | '*',
    type: T,
    payload: MessagePayloadFor<T>,
    priority: MessagePriority = 'normal',
    correlationId?: string,
    ttl?: number
  ): Message<T> {
    const message = {
      id: uuidv4(),
      correlationId,
      from,
      to,
      type,
      priority,
      payload,
      timestamp: new Date().toISOString(),
      ttl,
    } as Message<T>;

    this.storeMessage(message);
    this.emitter.emit('message.sent', message);
    this.matchSubscribers(message);

    return message;
  }

  reply<T extends MessageType>(
    original: Message,
    from: string,
    type: T,
    payload: MessagePayloadFor<T>,
    priority?: MessagePriority
  ): Message<T> {
    return this.send(
      from,
      original.from,
      type,
      payload,
      priority ?? original.priority,
      original.id
    );
  }

  broadcast<T extends MessageType>(
    from: string,
    type: T,
    payload: MessagePayloadFor<T>,
    priority: MessagePriority = 'normal'
  ): Message<T> {
    return this.send(from, '*', type, payload, priority);
  }

  // ─── Subscribe ──────────────────────────────────────────────────────

  subscribe(
    pattern: MessagePattern,
    handler: MessageHandler
  ): () => void {
    const id = uuidv4();
    this.subscriptions.set(id, { pattern, handler });
    return () => this.subscriptions.delete(id);
  }

  /** Subscribe to every message of a given type, regardless of sender/recipient. */
  onType<T extends MessageType>(type: T, handler: (message: Message<T>) => void | Promise<void>): () => void {
    return this.subscribe({ type }, handler as MessageHandler);
  }

  /** Subscribe to every message addressed to a given recipient (broadcasts included). */
  onAddressed(target: string, handler: MessageHandler): () => void {
    return this.subscribe({ to: target }, handler);
  }

  /**
   * Subscribe to all messages matching any of the provided patterns.
   * Returns a single dispose function that removes all subscriptions.
   */
  subscribeMany(
    patterns: MessagePattern[],
    handler: MessageHandler
  ): () => void {
    const disposers = patterns.map((pattern) => this.subscribe(pattern, handler));
    return () => disposers.forEach((dispose) => dispose());
  }

  // ─── Query ──────────────────────────────────────────────────────────

  /**
   * Query stored messages with optional filters
   */
  query(filter?: MessageFilter): Message[] {
    let results = [...this.messageStore];

    if (filter?.before) {
      results = results.filter((m) => m.timestamp < filter.before!);
    }
    if (filter?.after) {
      results = results.filter((m) => m.timestamp > filter.after!);
    }
    if (filter?.from) {
      results = results.filter((m) => m.from === filter.from);
    }
    if (filter?.to) {
      results = results.filter((m) => m.to === filter.to || m.to === '*');
    }
    if (filter?.type) {
      results = results.filter((m) => m.type === filter.type);
    }
    if (filter?.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Get messages in a correlation chain (root + all replies)
   */
  getThread(rootMessageId: string): Message[] {
    return this.messageStore.filter(
      (m) => m.id === rootMessageId || m.correlationId === rootMessageId
    );
  }

  // ─── Listeners (low-level) ──────────────────────────────────────────

  on(event: MessageBusEvent, listener: (data: unknown) => void): void {
    this.emitter.on(event, listener);
  }

  off(event: MessageBusEvent, listener: (data: unknown) => void): void {
    this.emitter.off(event, listener);
  }

  // ─── Maintenance ────────────────────────────────────────────────────

  getMessageCount(): number {
    return this.messageStore.length;
  }

  clearMessages(): void {
    this.messageStore = [];
  }

  /**
   * Export the most recent messages for persistence (P1#5). Bounded so we never serialize the
   * whole 10k ring buffer to workspaceState. User attachment data is intentionally
   * turn-local: raw bytes and display names must not become a durable message-log
   * side channel (local PDFs use their own temporary asset receipt instead).
   */
  exportMessages(limit = 500): Message[] {
    return this.messageStore.slice(-limit).map(stripUserAttachmentsForPersistence);
  }

  /**
   * Seed the store from persisted history (call once on activation, before agents start). Replays
   * are NOT re-dispatched to subscribers — this only restores the queryable log for the UI.
   */
  importMessages(messages: Message[]): void {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }
    this.messageStore = messages.slice(-this.maxStoreSize).map(stripUserAttachmentsForPersistence);
  }

  dispose(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
    }
    this.subscriptions.clear();
    this.emitter.removeAllListeners();
    this.messageStore = [];
  }

  // ─── Private ────────────────────────────────────────────────────────

  private storeMessage(message: Message): void {
    this.messageStore.push(message);
    if (this.messageStore.length > this.maxStoreSize) {
      this.messageStore.splice(0, this.messageStore.length - this.maxStoreSize);
    }
  }

  private matchSubscribers(message: Message): void {
    for (const [id, { pattern, handler }] of this.subscriptions) {
      if (this.matches(message, pattern)) {
        this.emitter.emit('message.matched', { subscriptionId: id, message: message.id });
        try {
          const result = handler(message);
          if (result instanceof Promise) {
            result.catch((err) =>
              this.emitter.emit('error', { subscriptionId: id, error: err })
            );
          }
        } catch (err) {
          this.emitter.emit('error', { subscriptionId: id, error: err });
        }
      }
    }
  }

  private matches(message: Message, pattern: MessagePattern): boolean {
    if (pattern.type !== undefined && pattern.type !== message.type) {
      return false;
    }
    if (pattern.from !== undefined && pattern.from !== message.from) {
      return false;
    }
    if (pattern.to !== undefined) {
      if (message.to !== '*' && message.to !== pattern.to) {
        return false;
      }
    }
    if (pattern.priority !== undefined && pattern.priority !== message.priority) {
      return false;
    }
    return true;
  }

  private startExpiryCheck(): void {
    this.expiryTimer = setInterval(() => {
      const now = new Date().toISOString();
      const expired: Message[] = [];

      this.messageStore = this.messageStore.filter((m) => {
        if (m.ttl && m.timestamp < now) {
          // Simple expiry: TTL in seconds from timestamp
          const age = (Date.now() - new Date(m.timestamp).getTime()) / 1000;
          if (age > m.ttl) {
            expired.push(m);
            return false;
          }
        }
        return true;
      });

      expired.forEach((m) => this.emitter.emit('message.expired', m));
    }, 10000);
  }
}

/**
 * Keep attachment bytes and coordinator-authored brief text out of workspaceState and exported
 * message history. A live task.assign still carries its complete attempt card to the worker; the
 * retained internal run record is the one deliberate audit surface for coordinatorBrief.
 */
function stripUserAttachmentsForPersistence(message: Message): Message {
  const { userAttachments: _attachments, taskAttempt, ...payload } = message.payload;
  const persistedAttempt = taskAttempt && typeof taskAttempt === 'object'
    ? stripCoordinatorBrief(taskAttempt)
    : taskAttempt;
  // Removing one optional field preserves the existing discriminant/payload relationship.
  return {
    ...message,
    payload: structuredClone({
      ...payload,
      ...(persistedAttempt !== undefined ? { taskAttempt: persistedAttempt } : {}),
    }),
  } as Message;
}

function stripCoordinatorBrief(taskAttempt: object): object {
  const attempt = taskAttempt as { contract?: object };
  if (!attempt.contract || typeof attempt.contract !== 'object') {
    return taskAttempt;
  }
  const { coordinatorBrief: _brief, ...contract } = attempt.contract as Record<string, unknown>;
  return { ...attempt, contract };
}
