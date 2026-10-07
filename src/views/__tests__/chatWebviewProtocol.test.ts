import { describe, expect, it } from 'vitest';
import { CHAT_WEBVIEW_PROTOCOL_LIMITS, parseChatWebviewInboundMessage } from '../chatWebviewProtocol';
import { malformedWebviewMessages, overlongWebviewIdentityMessages, validWebviewMessages } from './support/chatWebviewProtocolMessages';

describe('chat webview protocol boundary', () => {
  it.each(Object.entries(validWebviewMessages))('accepts the bounded %s command shape', (_command, message) => {
    expect(parseChatWebviewInboundMessage(message).ok).toBe(true);
  });

  it.each(Object.entries(malformedWebviewMessages))('rejects malformed %s before it reaches a host handler', (_command, message) => {
    expect(parseChatWebviewInboundMessage(message)).toMatchObject({ ok: false });
  });

  it.each(overlongWebviewIdentityMessages)('rejects an overlong %s at the protocol boundary', (_field, message) => {
    expect(parseChatWebviewInboundMessage(message)).toMatchObject({ ok: false });
  });

  it('accepts identifiers exactly at their published limits', () => {
    const at = (limit: number) => 'x'.repeat(limit);
    expect(parseChatWebviewInboundMessage({
      ...validWebviewMessages.send,
      agentId: at(CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId),
      requestId: at(CHAT_WEBVIEW_PROTOCOL_LIMITS.requestId),
    }).ok).toBe(true);
    expect(parseChatWebviewInboundMessage({
      ...validWebviewMessages.openToolFile,
      agentId: at(CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId),
      toolId: at(CHAT_WEBVIEW_PROTOCOL_LIMITS.toolId),
    }).ok).toBe(true);
    expect(parseChatWebviewInboundMessage({
      ...validWebviewMessages.approvalDecision,
      id: at(CHAT_WEBVIEW_PROTOCOL_LIMITS.opaqueId),
    }).ok).toBe(true);
  });

  it('permits outcome repairs to name only an opaque host-issued receipt', () => {
    const outcomeId = 'x'.repeat(CHAT_WEBVIEW_PROTOCOL_LIMITS.opaqueId);
    expect(parseChatWebviewInboundMessage({
      command: 'repairAction', kind: 'retry-delegation', outcomeId,
    })).toMatchObject({ ok: true, message: { command: 'repairAction', kind: 'retry-delegation', outcomeId } });
    expect(parseChatWebviewInboundMessage({
      command: 'repairAction', kind: 'retry-delegation', agentId: 'agent-1', outcomeId: 'outcome-1',
    })).toMatchObject({ ok: false });
    expect(parseChatWebviewInboundMessage({
      command: 'repairAction', kind: 'missing-credential', outcomeId: 'outcome-1',
    })).toMatchObject({ ok: false });
  });

  it('permits the three next steps of a first-action deadline, each naming only its card', () => {
    for (const kind of ['retry-same-route', 'switch-route', 'stop-request'] as const) {
      expect(parseChatWebviewInboundMessage({ command: 'repairAction', kind, outcomeId: 'first-action-deadline:turn-1' }))
        .toMatchObject({ ok: true, message: { command: 'repairAction', kind, outcomeId: 'first-action-deadline:turn-1' } });
      // Neither without a card, nor with an agent or a request of the webview's choosing.
      expect(parseChatWebviewInboundMessage({ command: 'repairAction', kind })).toMatchObject({ ok: false });
      expect(parseChatWebviewInboundMessage({
        command: 'repairAction', kind, outcomeId: 'first-action-deadline:turn-1', agentId: 'agent-1',
      })).toMatchObject({ ok: false });
    }
    expect(parseChatWebviewInboundMessage({ command: 'repairAction', kind: 'retry-other-route', outcomeId: 'x' }))
      .toMatchObject({ ok: false });
  });

  it('allows an attachment-only send without allowing a non-string body', () => {
    expect(parseChatWebviewInboundMessage({
      command: 'send', agentId: 'agent-1', text: '', attachments: [{
        name: 'note.txt', mime: 'text/plain', kind: 'text', dataBase64: 'aGk=', size: 2,
      }],
    }).ok).toBe(true);
    expect(parseChatWebviewInboundMessage({ command: 'send', agentId: 'agent-1', text: null, attachments: [] }).ok).toBe(false);
  });
});
