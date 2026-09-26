import { randomUUID } from 'crypto';
import type { ToolSpec } from './WorkspaceTools';
import { hostToolFailed, hostToolSucceeded, type HostToolOutcome } from './toolSummary';

export const PUBLISH_CONTENT_RECEIPT_TOOL = 'publish_content_receipt';

export type ReceiptDeliveryState = 'shown' | 'partial' | 'not-delivered';

export interface PublishedTurnDelivery {
  text: string;
  state: ReceiptDeliveryState;
  receiptId: string;
  visibleCharacters?: number;
}

/**
 * Per-turn content publication for agents that do not have coordinator TeamTools.
 * The host retains the exact read bytes; the model names only an opaque receipt and a closed state.
 */
export class TurnContentDelivery {
  private receipts = new Map<string, string>();
  private accepted?: PublishedTurnDelivery;
  private pending?: PublishedTurnDelivery;

  beginTurn(): void {
    this.receipts.clear();
    this.accepted = undefined;
    this.pending = undefined;
  }

  register(content: string): { id: string } | undefined {
    if (!content) return undefined;
    const id = `receipt-${randomUUID()}`;
    this.receipts.set(id, content);
    return { id };
  }

  takePublished(): PublishedTurnDelivery | undefined {
    const delivery = this.pending;
    this.pending = undefined;
    return delivery;
  }

  publish(args: Record<string, unknown>): HostToolOutcome {
    if (this.accepted) {
      return hostToolFailed('Error: a terminal content receipt was already accepted for this turn. Start a new turn rather than revising a published state.');
    }
    const receiptId = typeof args.receipt_id === 'string' ? args.receipt_id.trim() : '';
    if (!receiptId) {
      return hostToolFailed('Error: receipt_id is required. Name the opaque receipt id returned by a successful read in this turn.');
    }
    const content = this.receipts.get(receiptId);
    if (content === undefined) {
      return hostToolFailed('Error: unknown or foreign content receipt. A receipt may be published only in the agent turn that recorded it.');
    }
    const state = args.state as ReceiptDeliveryState;
    if (state !== 'shown' && state !== 'partial' && state !== 'not-delivered') {
      return hostToolFailed('Error: state must be one of shown, partial, not-delivered.');
    }

    const framing = typeof args.framing === 'string' ? args.framing : '';
    if (framing.length > 4_000) {
      return hostToolFailed('Error: framing exceeds the 4000-character limit; state it concisely.');
    }

    let text: string;
    let visibleCharacters: number | undefined;
    if (state === 'shown') {
      text = frameContent(framing, content);
    } else if (state === 'partial') {
      const totalCharacters = [...content].length;
      const requestedVisible = args.visible_characters;
      if (typeof requestedVisible !== 'number' || !Number.isSafeInteger(requestedVisible)
          || requestedVisible <= 0 || requestedVisible >= totalCharacters) {
        return hostToolFailed(`Error: partial requires visible_characters as a safe integer from 1 through ${Math.max(0, totalCharacters - 1)}. Fractions are not rounded.`);
      }
      visibleCharacters = requestedVisible;
      text = frameContent(framing, [...content].slice(0, requestedVisible).join(''));
    } else {
      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      if (!reason) return hostToolFailed('Error: not-delivered requires a concrete reason.');
      if (reason.length > 4_000) {
        return hostToolFailed('Error: reason exceeds the 4000-character limit; state it concisely.');
      }
      text = reason;
    }

    const delivery: PublishedTurnDelivery = {
      text,
      state,
      receiptId,
      ...(visibleCharacters === undefined ? {} : { visibleCharacters }),
    };
    this.accepted = delivery;
    this.pending = delivery;
    return hostToolSucceeded(state === 'shown'
      ? `Recorded: host is publishing receipt ${receiptId} as the final reply.`
      : state === 'partial'
        ? `Recorded: host is publishing the first ${visibleCharacters} Unicode code point(s) of receipt ${receiptId} as the final reply.`
        : 'Recorded: host is publishing the stated non-delivery reason as the final reply.');
  }
}

export function publishContentReceiptSpec(): ToolSpec {
  return {
    type: 'function',
    function: {
      name: PUBLISH_CONTENT_RECEIPT_TOOL,
      description: 'Publish exact text returned by read_file in this turn. Use shown when the user asked to see, show, print, or paste the file contents. Name the opaque receipt id from read_file; never retype the content. The host emits the retained bytes as the real assistant reply.',
      parameters: {
        type: 'object',
        properties: {
          receipt_id: { type: 'string', description: 'Opaque host-issued content receipt id from this turn.' },
          state: { type: 'string', enum: ['shown', 'partial', 'not-delivered'], description: 'shown publishes the complete receipt; partial publishes a prefix; not-delivered publishes only a reason.' },
          framing: { type: 'string', description: 'Optional concise text placed before shown or partial content.' },
          visible_characters: { type: 'integer', description: 'Required only for partial: Unicode-code-point prefix length.' },
          reason: { type: 'string', description: 'Required only for not-delivered.' },
        },
        required: ['receipt_id', 'state'],
      },
    },
  };
}

function frameContent(framing: string, content: string): string {
  return framing ? `${framing}\n\n${content}` : content;
}
