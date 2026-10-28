import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_CONVERSATION_NOTICE, REQUEST_INTERRUPTED_NOTICE, REQUEST_UNANSWERED_NOTICE,
  backendKindChangeNotice, conversationNotRestoredLogLine, conversationNotRestoredNotice,
} from '../ConversationNotRestored';

describe('what the person is told when a stored model conversation is not restored', () => {
  it('names the kind that kept it and the kind that cannot continue it', () => {
    expect(conversationNotRestoredNotice({ reason: 'other-backend', writtenBy: 'codex', startedAs: 'openai-compat' })).toBe(
      'UnodeAi: This agent\'s saved model conversation was kept by Codex CLI and cannot be continued by an '
      + 'OpenAI-compatible connection, so it was discarded. The model starts a new conversation: it has not seen the '
      + 'messages above.',
    );
    expect(conversationNotRestoredNotice({ reason: 'other-backend', writtenBy: 'openai-compat', startedAs: 'codex' }))
      .toContain('was kept by an OpenAI-compatible connection and cannot be continued by Codex CLI,');
  });

  it('says so without a name when the kind that kept it is not known', () => {
    expect(conversationNotRestoredNotice({ reason: 'other-backend', startedAs: 'codex' }))
      .toContain('was kept by another provider type and cannot be continued by Codex CLI,');
  });

  it('says nothing in the chat of an agent whose backend keeps no conversation between starts', () => {
    // The Claude CLI backend names no kind. Its model starts new at every start, so a leftover of an earlier kind
    // that is discarded changes nothing the person could see. The log still gets its line.
    expect(conversationNotRestoredNotice({ reason: 'other-backend', writtenBy: 'openai-compat' })).toBeUndefined();
    expect(conversationNotRestoredNotice({ reason: 'other-backend' })).toBeUndefined();
    expect(conversationNotRestoredNotice({ reason: 'not-a-conversation' })).toBeUndefined();
    expect(conversationNotRestoredLogLine({ reason: 'other-backend', writtenBy: 'openai-compat' }))
      .toBe('reason=other-backend writtenBy=openai-compat');
  });

  it('says that a record which is no conversation was discarded and that nothing of it is sent', () => {
    expect(conversationNotRestoredNotice({ reason: 'not-a-conversation', startedAs: 'openai-compat' })).toBe(
      'UnodeAi: This agent\'s saved model conversation could not be read as a conversation of its provider type, so it '
      + 'was discarded and nothing of it is sent. The model starts a new conversation: it has not seen the messages above.',
    );
  });

  it('gives the log the reason and the kinds only', () => {
    expect(conversationNotRestoredLogLine({ reason: 'other-backend', writtenBy: 'codex', startedAs: 'openai-compat' }))
      .toBe('reason=other-backend writtenBy=codex startedAs=openai-compat');
    expect(conversationNotRestoredLogLine({ reason: 'not-a-conversation' })).toBe('reason=not-a-conversation');
  });
});

describe('what the person is told when a restored conversation leaves a request out (v0.9.95)', () => {
  it('says that an unanswered request was interrupted and has to be sent again, in these words', () => {
    for (const startedAs of ['openai-compat', 'codex'] as const) {
      expect(conversationNotRestoredNotice({ reason: 'request-interrupted', startedAs })).toBe(
        'Your earlier request was interrupted and was not resumed. Send it again if you still want it.',
      );
    }
    expect(REQUEST_INTERRUPTED_NOTICE).toBe('Your earlier request was interrupted and was not resumed. Send it again if you still want it.');
    // Nothing shows that this one was cut off: it may have failed, or it was saved before that was recorded.
    expect(conversationNotRestoredNotice({ reason: 'request-unanswered', startedAs: 'openai-compat' }))
      .toBe('Your earlier request ended without an answer and was not resumed. Send it again if you still want it.');
    expect(REQUEST_UNANSWERED_NOTICE).not.toMatch(/interrupted/);
    expect(conversationNotRestoredNotice({ reason: 'request-unanswered' })).toBeUndefined();
  });

  it('says of a thread saved before the marker that its completion is not known, and does not call it interrupted', () => {
    const notice = conversationNotRestoredNotice({ reason: 'legacy-completion-unknown', startedAs: 'codex' });
    expect(notice).toBe(
      'This conversation was saved by an earlier version of UnodeAi, which did not record whether its last request had '
      + 'finished. The agent starts a new conversation; the messages above stay as history.',
    );
    expect(notice).toBe(LEGACY_CONVERSATION_NOTICE);
    expect(notice).not.toContain('interrupted');
  });

  it('gives the log the counts and the reason codes, and nothing of a message', () => {
    expect(conversationNotRestoredLogLine({
      reason: 'request-interrupted', startedAs: 'openai-compat',
      restoredMessages: 12, quarantinedMessages: 3, reasonCodes: ['host-turn-incomplete', 'unfinished-tail'],
    })).toBe('reason=request-interrupted startedAs=openai-compat restoredMessages=12 quarantinedMessages=3 codes=host-turn-incomplete,unfinished-tail');
    // A count of none is still a count.
    expect(conversationNotRestoredLogLine({
      reason: 'legacy-completion-unknown', startedAs: 'codex', restoredMessages: 0, quarantinedMessages: 0, reasonCodes: ['legacy-thread'],
    })).toBe('reason=legacy-completion-unknown startedAs=codex restoredMessages=0 quarantinedMessages=0 codes=legacy-thread');
  });
});

describe('what Agent Builder says when an edit changes the provider type', () => {
  it('says that the model starts a new conversation', () => {
    expect(backendKindChangeNotice('codex', 'openai-compat')).toBe(
      ' Its provider type changed from Codex CLI to an OpenAI-compatible connection, so the model starts a new '
      + 'conversation: the earlier messages stay in Chat, but the new model has not seen them.',
    );
    expect(backendKindChangeNotice('openai-compat', 'claude')).toContain('from an OpenAI-compatible connection to Claude CLI,');
  });

  it('says nothing for a new agent or an edit that keeps the kind', () => {
    expect(backendKindChangeNotice('openai-compat', 'openai-compat')).toBe('');
    expect(backendKindChangeNotice('codex', 'codex')).toBe('');
    expect(backendKindChangeNotice(undefined, 'codex')).toBe('');
    expect(backendKindChangeNotice('codex', undefined)).toBe('');
  });

  it('is said with the kind the agent had before the edit, taken before the saved config is changed', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    const captured = source.indexOf('const priorBackendKind = existing');
    const mutated = source.indexOf('config.backend = profileForSave.backendKind;');
    expect(captured).toBeGreaterThan(0);
    expect(mutated).toBeGreaterThan(captured);
    expect(source).toContain('? existing.config.backend ?? defaultBackendKind(existing.config, effectiveConnectionRegistry)');
    expect(source).toContain("const backendChangeNotice = backendKindChanged ? backendKindChangeNotice(priorBackendKind, profileForSave.backendKind) : '';");
    expect(source).toContain('message: `Updated ${config.name}.${backendChangeNotice}${contextWindowNotice}${droppedGrantsNotice}`');
  });

  it('has the session manager discard the stored conversation at the save that changes the kind', () => {
    // The start of an agent sees only the kind it has by then. An agent changed to another kind and back before
    // it starts must not get its old conversation back, so the save itself reports the change.
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    const saved = source.indexOf('const backendKindChanged = priorBackendKind !== profileForSave.backendKind;');
    const told = source.indexOf('await sessionManager.configEdited(existing.id, { backendKindChanged });');
    expect(saved).toBeGreaterThan(source.indexOf('config.backend = profileForSave.backendKind;'));
    expect(told).toBeGreaterThan(saved);
    // After the roster is saved, and before the message that says the model starts a new conversation.
    const committed = source.indexOf('await agentRosterEdits.commit(config, existing.config, rosterCurrent');
    expect(committed).toBeGreaterThan(0);
    expect(told).toBeGreaterThan(committed);
    expect(source.indexOf('const backendChangeNotice = backendKindChanged', told)).toBeGreaterThan(told);
  });
});
