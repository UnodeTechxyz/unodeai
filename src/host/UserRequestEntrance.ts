import type { MessageBus } from '../bus/MessageBus';
import type { Message, MessagePayloadFor, MessagePriority, MessageType } from '../types';

export interface UserRequestEntranceDeps {
  /** What a new request of the person resets before it is routed, such as an earlier decline of a local read. */
  beginUserRequest(): void;
  bus: Pick<MessageBus, 'send'>;
  agents: {
    /** Whether the agent is still on the roster. */
    has(agentId: string): boolean;
    isRunning(agentId: string): boolean;
    start(agentId: string): Promise<unknown>;
  };
}

/**
 * The one entrance of a top-level request the person makes of an agent. A message typed in Chat, a goal given to
 * the editor's chat participant and a request the person starts again all come in here, so the host begins each
 * of them as a new request in the same way. A tool retry, a delegate wake and an automatic continuation are not
 * requests of the person and never come through.
 */
export class UserRequestEntrance {
  constructor(private readonly deps: UserRequestEntranceDeps) {}

  submit<T extends MessageType>(
    agentId: string,
    type: T,
    payload: MessagePayloadFor<T>,
    priority: MessagePriority = 'normal',
  ): Message<T> {
    this.deps.beginUserRequest();
    return this.deps.bus.send('user', agentId, type, payload, priority);
  }

  /**
   * Starts a request of the person again, as a new request. The agent is started if it is not running, and the
   * original payload is submitted without the host metadata of the earlier attempt, so its turn is composed
   * afresh. False when there is nothing to start again or the agent could not be started; nothing is submitted
   * then.
   */
  async resubmit(agentId: string, request: Message | undefined): Promise<boolean> {
    if (!request || request.from !== 'user' || !this.deps.agents.has(agentId)) return false;
    try {
      if (!this.deps.agents.isRunning(agentId)) await this.deps.agents.start(agentId);
    } catch {
      return false;
    }
    const { metadata: _metadata, ...payload } = request.payload;
    this.submit(agentId, request.type, payload, request.priority);
    return true;
  }
}
