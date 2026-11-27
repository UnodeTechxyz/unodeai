import { describe, expect, it } from 'vitest';
import { ReplySuggestionState, type SuggestionIdentity } from '../ReplySuggestionState';
import { parseChatWebviewInboundMessage } from '../../views/chatWebviewProtocol';

const base: Omit<SuggestionIdentity, 'composerRevision'> = {
  workspaceId: 'w', conversationId: 'pm:3:0', branchId: 'main', agentId: 'pm', turnId: 't1', settingsRevision: 1,
};

function state() {
  let n = 0;
  return new ReplySuggestionState(() => `id${++n}`);
}

describe('ReplySuggestionState', () => {
  it('starts only from the offered view, once, and delivers only to that view', () => {
    const s = state();
    const offerId = s.offerFor('sidebar', base);
    expect(s.start(offerId, 'workbench', 0, base)).toBeUndefined();
    const op = s.start(offerId, 'sidebar', 4, base);
    expect(op?.identity.composerRevision).toBe(4);
    expect(s.start(offerId, 'sidebar', 4, base)).toBeUndefined();
    expect(s.deliverable(op!.opId, base)).toBe('sidebar');
    // Delivered once.
    expect(s.deliverable(op!.opId, base)).toBeUndefined();
  });

  it.each([
    ['workspace', { workspaceId: 'w2' }], ['conversation', { conversationId: 'pm:4:0' }], ['branch', { branchId: 'b2' }],
    ['agent', { agentId: 'dev' }], ['turn', { turnId: 't2' }], ['settings', { settingsRevision: 2 }],
  ])('a changed %s makes the result stale and aborts it', (_part, change) => {
    const s = state();
    const op = s.start(s.offerFor('sidebar', base), 'sidebar', 0, base)!;
    expect(s.deliverable(op.opId, { ...base, ...change })).toBeUndefined();
    expect(op.signal.aborted).toBe(true);
  });

  it('accepts only the delivered suggestion at the composer revision it was made for', () => {
    const s = state();
    const op = s.start(s.offerFor('workbench', base), 'workbench', 2, base)!;
    expect(s.accepted(op.opId, 'workbench', 2)).toBe(false);
    s.deliverable(op.opId, base);
    expect(s.accepted(op.opId, 'workbench', 3)).toBe(false);
    expect(s.accepted(op.opId, 'sidebar', 2)).toBe(false);
    expect(s.accepted(op.opId, 'workbench', 2)).toBe(true);
    expect(s.snapshot().opId).toBeUndefined();
  });

  it('a newer answer supersedes the older suggestion, and a filtered dismiss leaves others alone', () => {
    const s = state();
    const first = s.start(s.offerFor('sidebar', base), 'sidebar', 0, base)!;
    s.offerFor('sidebar', { ...base, turnId: 't2' });
    expect(first.signal.aborted).toBe(true);
    expect(s.dismiss('stop', { agentId: 'dev' })).toBe(false);
    expect(s.snapshot().offerId).toBeDefined();
    expect(s.dismiss('stop', { agentId: 'pm' })).toBe(true);
    expect(s.snapshot().offerId).toBeUndefined();
  });

  it('end() ends only the operation it names', () => {
    const s = state();
    const op = s.start(s.offerFor('sidebar', base), 'sidebar', 0, base)!;
    s.end('op-other', 'stale');
    expect(op.signal.aborted).toBe(false);
    s.end(op.opId, 'stale');
    expect(op.signal.aborted).toBe(true);
  });
});

describe('reply suggestion webview messages', () => {
  it('accept only host-shaped ids, a revision and a known reason', () => {
    expect(parseChatWebviewInboundMessage({ command: 'replySuggestionStart', offerId: 'offer-abc-1', composerRevision: 0 }).ok).toBe(true);
    expect(parseChatWebviewInboundMessage({ command: 'replySuggestionStart', offerId: 'op-abc', composerRevision: 0 }).ok).toBe(false);
    expect(parseChatWebviewInboundMessage({ command: 'replySuggestionStart', offerId: 'offer-abc', composerRevision: -1 }).ok).toBe(false);
    expect(parseChatWebviewInboundMessage({ command: 'replySuggestionStart', offerId: 'offer-abc', composerRevision: 0, text: 'x' }).ok).toBe(false);
    expect(parseChatWebviewInboundMessage({ command: 'replySuggestionAccepted', opId: 'op-1', composerRevision: 3 }).ok).toBe(true);
    expect(parseChatWebviewInboundMessage({ command: 'replySuggestionAccepted', opId: 'op-../x', composerRevision: 3 }).ok).toBe(false);
    expect(parseChatWebviewInboundMessage({ command: 'replySuggestionDismiss', reason: 'typing' }).ok).toBe(true);
    expect(parseChatWebviewInboundMessage({ command: 'replySuggestionDismiss', reason: 'settings' }).ok).toBe(false);
  });
});
