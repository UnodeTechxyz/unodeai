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

  it('lets the Edit history close request name nothing at all', () => {
    expect(parseChatWebviewInboundMessage({ command: 'closeInspector' })).toEqual({ ok: true, message: { command: 'closeInspector' } });
    for (const extra of [
      { path: '/ws/src/app.ts' }, { uri: 'file:///ws' }, { agentId: 'agent-1' }, { checkpointId: 1 },
      { target: 'unode.hideWorkbenchInspector' }, { open: false },
    ]) {
      expect(parseChatWebviewInboundMessage({ command: 'closeInspector', ...extra }), JSON.stringify(extra)).toMatchObject({ ok: false });
    }
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

  // v0.9.97 (SECURITY.md "Chat file links open through one host boundary"): a file link click names the conversation
  // and the link's host-issued id, and nothing else.
  it('lets a file link click name only the conversation and a file link id', () => {
    const referenceId = '12.0123456789abcdef';
    expect(parseChatWebviewInboundMessage({ command: 'openFileReference', agentId: 'agent-1', referenceId }))
      .toEqual({ ok: true, message: { command: 'openFileReference', agentId: 'agent-1', referenceId } });
    for (const extra of [
      { path: 'C:\\repo\\notes.md' }, { root: '/repo' }, { uri: 'file:///repo/notes.md' }, { target: 'command:x' },
      { href: 'docs/notes.md' }, { messageSeq: 12 }, { authorized: true },
    ]) {
      expect(parseChatWebviewInboundMessage({ command: 'openFileReference', agentId: 'agent-1', referenceId, ...extra }).ok, JSON.stringify(extra)).toBe(false);
    }
    for (const forged of ['docs/notes.md', 'C:\\repo\\notes.md', '/repo/notes.md', 'file:///x', '12', '12.0123456789ABCDEF', '12.0123456789abcdef\u0000', ' 12.0123456789abcdef']) {
      expect(parseChatWebviewInboundMessage({ command: 'openFileReference', agentId: 'agent-1', referenceId: forged }).ok, forged).toBe(false);
    }
    expect(parseChatWebviewInboundMessage({ command: 'openFileReference', agentId: 'agent-1' }).ok).toBe(false);
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

  describe('the Workbench draft copy messages (v0.9.96)', () => {
    const draft = (overrides: Record<string, unknown> = {}) => ({ agentId: 'agent-1', text: 'x', revision: 1, epoch: 0, basis: 0, ...overrides });

    it('carries a send\'s page generation and draft revision only together, and only as bounded values', () => {
      expect(parseChatWebviewInboundMessage({ command: 'send', agentId: 'agent-1', text: 'go', attachments: [], draftSurface: 's', draftRevision: 4 }))
        .toMatchObject({ ok: true, message: { draftSurface: 's', draftRevision: 4 } });
      for (const extra of [{ draftSurface: 's' }, { draftRevision: 4 }, { draftSurface: 's', draftRevision: -1 }, { draftSurface: 's', draftRevision: 1.5 }, { draftSurface: 7, draftRevision: 1 }]) {
        expect(parseChatWebviewInboundMessage({ command: 'send', agentId: 'agent-1', text: 'go', attachments: [], ...extra }).ok, JSON.stringify(extra)).toBe(false);
      }
    });

    it('accepts an edit at the per-draft limit and rejects one past it, or one that names fields of its own', () => {
      const atLimit = 'x'.repeat(1_000_000);
      expect(parseChatWebviewInboundMessage({ command: 'draftEdit', surface: 's', agentId: 'a', text: atLimit, revision: 1, epoch: 0 }).ok).toBe(true);
      expect(parseChatWebviewInboundMessage({ command: 'draftEdit', surface: 's', agentId: 'a', text: atLimit + 'x', revision: 1, epoch: 0 }).ok).toBe(false);
      expect(parseChatWebviewInboundMessage({ command: 'draftEdit', surface: 's', agentId: 'a', text: 'x', revision: 1, epoch: 0, attachments: [] }).ok).toBe(false);
      expect(parseChatWebviewInboundMessage({ command: 'draftEdit', surface: 's', agentId: 'a', text: 'x', revision: 1, epoch: 0, basis: 3 }).ok).toBe(false);
      expect(parseChatWebviewInboundMessage({ command: 'draftEdit', surface: 's', agentId: 'a', text: 'x', revision: '1', epoch: 0 }).ok).toBe(false);
      expect(parseChatWebviewInboundMessage({ command: 'draftEdit', surface: '', agentId: 'a', text: 'x', revision: 1, epoch: 0 }).ok).toBe(false);
    });

    it('lets an over-limit draft say so only without text', () => {
      expect(parseChatWebviewInboundMessage({ command: 'draftEdit', surface: 's', agentId: 'a', text: '', revision: 1, epoch: 0, overLimit: true }))
        .toMatchObject({ ok: true, message: { overLimit: true, text: '' } });
      expect(parseChatWebviewInboundMessage({ command: 'draftEdit', surface: 's', agentId: 'a', text: 'some', revision: 1, epoch: 0, overLimit: true }).ok).toBe(false);
      expect(parseChatWebviewInboundMessage({ command: 'draftEdit', surface: 's', agentId: 'a', text: '', revision: 1, epoch: 0, overLimit: false }).ok).toBe(false);
    });

    it('bounds a page snapshot to 20 drafts, one per agent, each with known fields only', () => {
      const twenty = Array.from({ length: 20 }, (_, index) => draft({ agentId: `agent-${index}` }));
      expect(parseChatWebviewInboundMessage({ command: 'draftSync', surface: 's', drafts: twenty }).ok).toBe(true);
      expect(parseChatWebviewInboundMessage({ command: 'draftSync', surface: 's', drafts: [...twenty, draft({ agentId: 'agent-20' })] }).ok).toBe(false);
      expect(parseChatWebviewInboundMessage({ command: 'draftSync', surface: 's', drafts: [draft(), draft()] }).ok).toBe(false);
      expect(parseChatWebviewInboundMessage({ command: 'draftSync', surface: 's', drafts: [draft({ attachments: ['a.png'] })] }).ok).toBe(false);
      expect(parseChatWebviewInboundMessage({ command: 'draftSync', surface: 's', drafts: [draft({ basis: undefined })] }).ok).toBe(false);
      expect(parseChatWebviewInboundMessage({ command: 'draftSync', surface: 's', drafts: [draft({ text: 'x'.repeat(1_000_001) })] }).ok).toBe(false);
      expect(parseChatWebviewInboundMessage({ command: 'draftSync', surface: 's', drafts: [draft({ text: '', overLimit: true })] }).ok).toBe(true);
    });
  });

  it('v0.9.99: takes a file piece of up to 4 MiB, and no more, from a bounded upload id', () => {
    const piece = (bytes: number) => Buffer.alloc(bytes, 1).toString('base64');
    const chunk = (extra: Record<string, unknown>) => parseChatWebviewInboundMessage({ command: 'attachmentChunk', uploadId: 'up-1', index: 3, total: 9, data: piece(4), ...extra });
    expect(chunk({})).toEqual({ ok: true, message: { command: 'attachmentChunk', uploadId: 'up-1', index: 3, total: 9, data: piece(4) } });
    expect(chunk({ data: piece(4 * 1024 * 1024) }).ok).toBe(true);
    expect(chunk({ data: piece(4 * 1024 * 1024 + 3) }).ok).toBe(false);
    expect(chunk({ data: 'a,b' }).ok).toBe(false);
    expect(chunk({ index: -1 }).ok).toBe(false);
    expect(chunk({ total: 1.5 }).ok).toBe(false);
    expect(chunk({ uploadId: 'up/1' }).ok).toBe(false);
    expect(chunk({ name: 'a.txt' }).ok).toBe(false);
  });

  it('v0.9.99: keeps a send\'s staged and inline files in order, and names each file it could not take', () => {
    const parsed = parseChatWebviewInboundMessage({
      command: 'send', agentId: 'agent-1', text: '', attachments: [
        { name: 'big.pdf', mime: 'application/pdf', kind: 'pdf', size: 20_000_000, uploadId: 'up-1' },
        { name: 'note.txt', mime: 'text/plain', kind: 'file', dataBase64: 'aGk=', size: 2 },
        { name: 'run.exe', mime: 'application/x-msdownload', kind: 'file', size: 2, uploadId: 'up-2' },
        { name: 'x.txt', mime: 'text/plain', kind: 'file', size: 2, uploadId: '../up-3' },
      ],
    });
    expect(parsed).toEqual({ ok: true, message: {
      command: 'send', agentId: 'agent-1', text: '',
      attachments: [
        { name: 'big.pdf', mime: 'application/pdf', kind: 'pdf', size: 20_000_000, uploadId: 'up-1' },
        { name: 'note.txt', mime: 'text/plain', kind: 'file', dataBase64: 'aGk=', size: 2 },
      ],
      attachmentErrors: ['run.exe is not a supported text file type.', 'Skipped an attachment with missing metadata.'],
    } });
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
