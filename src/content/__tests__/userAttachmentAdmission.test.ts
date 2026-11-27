/*
 * v0.9.97 P4: what the chat composer's entry admits for `save_attachment`, and what the content store keeps. Review
 * resolution §10.2: raw text bytes are kept apart from the formatted model text, and `user-attachment` provenance comes
 * only from the real user entry (turn-supplied text is never relabelled as an attachment). Handoff §5: an authorised
 * read does not extend an attachment's 30 minutes.
 */
import * as fs from 'fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTENT_ASSET_MAX_BYTES, CONTENT_ASSET_MAX_PAGE_TEXT, ContentAssetStore, CONTENT_ASSET_TTL_MS } from '../ContentAssetStore';
import { admitDelegationContentSources } from '../../host/orchestration/OrchestrationHostAdapter';
import { attachment, CSV_BOM_CRLF, LATIN1, PNG, saveHost, sha } from '../../backend/__tests__/attachmentSaveFixtures';
import { removeTemporaryFolders } from '../../backend/__tests__/pathSafetyFixtures';

afterEach(removeTemporaryFolders);

describe('the chat composer\'s entry admits a text attachment with its exact bytes', () => {
  it('stores each text file once, as the user\'s attachment, and the request and @ text as turn-supplied text', async () => {
    const store = new ContentAssetStore();
    const file = attachment('people.csv', 'text/csv', 'file', CSV_BOM_CRLF);
    const sources = await admitDelegationContentSources(store, [
      { kind: 'user-request', label: 'Current task', location: 'chat composer', text: 'save it', reason: 'user-entered task' },
      { kind: 'context-mention', label: 'Explicit @ context (1)', location: '@a.ts', text: 'export const a = 1;', reason: 'user @file request' },
      // The manifest's own entry for the same text file, as the composer makes it: a formatted copy, stored no more.
      { kind: 'user-attachment', label: 'people.csv', location: 'user text attachment', text: '### people.csv', reason: 'user attached a text file' },
    ], [file], [], []);
    expect(sources.map((source) => [source.kind, source.mediaKind])).toEqual([
      ['user-request', 'text'], ['context-mention', 'text'], ['user-attachment', 'text'],
    ]);
    const [request, mention, attached] = sources;
    expect(attached).toMatchObject({ label: 'people.csv', location: 'user text attachment', bytes: CSV_BOM_CRLF.length });
    expect(store.userAttachmentState(request.assetId)).toBe('not-user-attachment');
    expect(store.userAttachmentState(mention.assetId)).toBe('not-user-attachment');
    const read = await store.readUserAttachment(attached.assetId);
    expect(read.status === 'ready' && read.bytes.equals(CSV_BOM_CRLF)).toBe(true);
    expect(read.status === 'ready' && read.sha256).toBe(sha(CSV_BOM_CRLF));
    // Its readers page through the same formatted text the model gets, without the byte-order mark or a CR.
    const text = await store.readExtractedContent(attached.assetId);
    expect('items' in text && text.items[0].text).toContain('### people.csv\n```csv\nname,city\r\nZoë,Zürich');
    expect('items' in text && text.items[0].text).not.toContain('﻿');
    await store.dispose();
  });

  it('keeps a Latin-1 file the entry admitted byte for byte, though it is never shown as text', async () => {
    const store = new ContentAssetStore();
    const [source] = await admitDelegationContentSources(store, [], [attachment('legacy.txt', 'text/plain', 'file', LATIN1)], [], []);
    const read = await store.readUserAttachment(source.assetId);
    expect(read.status === 'ready' && read.bytes.equals(LATIN1)).toBe(true);
    const text = await store.readExtractedContent(source.assetId);
    expect('items' in text && text.items[0].text).toContain('(binary attachment, not inlined)');
    await store.dispose();
  });

  it('v0.9.99: keeps a text file past 10 MiB whole, bytes and text; the store sets no size limit of its own', async () => {
    const store = new ContentAssetStore();
    const past = Buffer.concat([Buffer.alloc(CONTENT_ASSET_MAX_BYTES, 0x61), Buffer.from('TAIL')]);
    const stored = await store.storeTextAttachment(past, past.toString('utf8'));
    expect(stored).toMatchObject({ mediaKind: 'text' });
    const read = await store.readUserAttachment(stored.assetId);
    expect(read.status === 'ready' && read.bytes.equals(past)).toBe(true);
    // The last page of its text holds the tail: nothing past the old limit is out of reach.
    const last = Math.ceil(past.length / CONTENT_ASSET_MAX_PAGE_TEXT);
    const tail = await store.readExtractedContent(stored.assetId, { start: last, end: last });
    expect('items' in tail && tail.items[0].text?.endsWith('TAIL')).toBe(true);
    await store.dispose();
  });

  it('cannot make a user attachment out of text alone', async () => {
    const store = new ContentAssetStore();
    // storeText's provenance parameter excludes 'user-attachment' (a compile-time rule for the product code); what it
    // stores is never a file the user attached.
    const stored = await store.storeText('a summary', 'turn-supplied');
    if ('error' in stored) throw new Error('fixture');
    expect(await store.readUserAttachment(stored.assetId)).toEqual({ status: 'not-user-attachment' });
    await store.dispose();
  });
});

describe('a user attachment\'s bytes as the store keeps them', () => {
  it('tells an expired id from one it never issued, and an authorised read does not extend the 30 minutes', async () => {
    let now = 5_000;
    const store = new ContentAssetStore({ now: () => now });
    const stored = await store.storeImage(PNG, 'user-attachment', 'image/png');
    if ('error' in stored) throw new Error('fixture');
    now += CONTENT_ASSET_TTL_MS - 1;
    expect((await store.readUserAttachment(stored.assetId)).status).toBe('ready');
    now += 1;
    expect(await store.readUserAttachment(stored.assetId)).toEqual({ status: 'expired' });
    expect(store.userAttachmentState(stored.assetId)).toBe('expired');
    // Once it is gone from the store, the id is still one this store issued: expired, not unknown.
    await store.cleanupExpired();
    expect(store.userAttachmentState(stored.assetId)).toBe('expired');
    expect(store.userAttachmentState('content-99')).toBe('unknown');
    await store.dispose();
  });

  it('does not return bytes that no longer match what was stored, and the save then refuses', async () => {
    const h = await saveHost();
    const stored = await h.assets.storeImage(PNG, 'user-attachment', 'image/png');
    if ('error' in stored) throw new Error('fixture');
    const kept = (h.assets as unknown as { assets: Map<string, { attached: { path: string } }> }).assets.get(stored.assetId)!.attached.path;
    await fs.writeFile(kept, Buffer.concat([PNG.subarray(0, PNG.length - 1), Buffer.from([0x00])]));
    expect(await h.assets.readUserAttachment(stored.assetId)).toEqual({ status: 'unavailable' });
    const tools = h.tools('dev', [{ assetId: stored.assetId, kind: 'user-attachment', label: 'logo.png', location: 'user image attachment', mediaKind: 'image' }]);
    const result = await tools.run('save_attachment', { asset_id: stored.assetId, path: 'logo.png' });
    expect(result).toMatchObject({ status: 'refused', reason: 'asset-unavailable', attachmentSave: { code: 'asset-unavailable' } });
    expect(result.output).toMatch(/could not read its copy of this attachment as the user attached it/);
  });
});
