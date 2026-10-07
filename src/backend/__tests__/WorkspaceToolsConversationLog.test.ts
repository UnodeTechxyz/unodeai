import { describe, expect, it } from 'vitest';
import { MessageBus } from '../../bus/MessageBus';
import type { ContentReceiptObservation } from '../../content/ContentReceipt';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import type { DelegationContentSource } from '../../session/TurnContextManifest';
import { WorkspaceTools } from '../WorkspaceTools';

function conversationTools(
  agentId: string,
  bus?: MessageBus,
  receipts?: ContentReceiptObservation[],
  store?: ContentAssetStore,
): WorkspaceTools {
  return new WorkspaceTools(
    process.cwd(), new Set(['read']), agentId,
    undefined, undefined, undefined, undefined, bus,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, 'apply-edit', store,
    receipts ? (receipt) => receipts.push(receipt) : undefined,
  );
}

describe('WorkspaceTools agent-scoped conversation log', () => {
  it('searches and reads only the calling agent\'s transcript, with a bounded receipt', async () => {
    const bus = new MessageBus();
    const receipts: ContentReceiptObservation[] = [];
    bus.send('user', 'agent-a', 'agent.message', { message: 'Use the amber deployment window.' });
    bus.send('agent-a', 'coordinator', 'agent.message', { message: 'I will verify amber first.' });
    bus.send('user', 'agent-b', 'agent.message', { message: 'agent-b private bio: do not share' });
    const tools = conversationTools('agent-a', bus, receipts);

    const search = await tools.runText('search_conversation_log', { query: 'amber' });
    expect(search).toContain('Searched entries 1-2 of 2 total');
    expect(search).toContain('amber deployment window');
    expect(search).not.toContain('private bio');

    const read = await tools.runText('read_conversation_log', { entries: { start: 1, end: 2 } });
    expect(read).toContain('returned 2 of 2 total');
    expect(read).toContain('amber deployment window');
    expect(read).not.toContain('private bio');
    expect(receipts).toEqual([
      { contentClass: 'conversation', action: 'searched', entries: { start: 1, end: 2, total: 2 } },
      { contentClass: 'conversation', action: 'read', entries: { start: 1, end: 2, total: 2, returned: 2 } },
    ]);
  });

  it('never exposes another agent\'s log, even when both have generic read permission', async () => {
    const bus = new MessageBus();
    bus.send('user', 'agent-a', 'agent.message', { message: 'agent-a only decision' });
    bus.send('user', 'agent-b', 'agent.message', { message: 'agent-b only decision' });

    const agentB = conversationTools('agent-b', bus);
    const output = await agentB.runText('search_conversation_log', { query: 'agent-a only decision' });
    expect(output).toContain('No matching entry');
    expect(output).not.toContain('agent-a only decision');
  });

  it('requires a small inclusive range and never treats unavailable as unrecoverable', async () => {
    const bus = new MessageBus();
    for (let index = 1; index <= 21; index++) {
      bus.send('user', 'agent-a', 'agent.message', { message: `turn ${index}` });
    }
    const tools = conversationTools('agent-a', bus);
    await expect(tools.runText('read_conversation_log', { entries: { start: 1, end: 21 } }))
      .resolves.toMatch(/at most 20 entries/i);
    await expect(conversationTools('agent-a').runText('search_conversation_log', { query: 'turn' }))
      .resolves.toMatch(/unreadable here, not evidence that it is unrecoverable/i);
  });
});

describe('WorkspaceTools shared content-asset authority (D3)', () => {
  it('requires an explicit delegation grant for another agent\'s still-live asset, across turns', async () => {
    const store = new ContentAssetStore();
    try {
      const stored = await store.storeText('OWNER-PRIVATE-BIO-MATERIAL', 'turn-supplied', 'agent-a');
      if ('error' in stored) { throw new Error(stored.error); }
      const agentA = conversationTools('agent-a', undefined, undefined, store);
      const agentB = conversationTools('agent-b', undefined, undefined, store);

      await expect(agentA.runText('read_extracted_content', { assetId: stored.assetId, pages: { start: 1, end: 1 } }))
        .resolves.toContain('OWNER-PRIVATE-BIO-MATERIAL');
      // Same shared store and same live turn: generic `read` is not content authority.
      await expect(agentB.run('read_extracted_content', { assetId: stored.assetId, pages: { start: 1, end: 1 } }))
        .resolves.toMatchObject({ status: 'refused', reason: 'asset-unavailable' });

      const source: DelegationContentSource = {
        assetId: stored.assetId, kind: 'user-request', label: 'user request', location: 'turn input',
        textBytes: 26, mediaKind: 'text',
      };
      agentB.setDelegationContentSources([source]);
      await expect(agentB.runText('search_extracted_content', { assetId: stored.assetId, query: 'PRIVATE' }))
        .resolves.toContain('OWNER-PRIVATE-BIO-MATERIAL');

      // A later turn does not inherit an earlier turn's grant while the store TTL is still live.
      agentB.setDelegationContentSources(undefined);
      await expect(agentB.run('read_extracted_content', { assetId: stored.assetId, pages: { start: 1, end: 1 } }))
        .resolves.toMatchObject({ status: 'refused', reason: 'asset-unavailable' });
    } finally {
      await store.dispose();
    }
  });
});
