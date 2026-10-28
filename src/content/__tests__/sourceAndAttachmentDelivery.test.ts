/*
 * v0.9.99 CF-2: complete source and attachment delivery. Each test goes through the real store, the real reader tools
 * (WorkspaceTools read_extracted_content), the real task-input resolver, the real attachment entry and composer, and
 * the real delegated-source reader. PDF pages here come from an injected extractor: these tests are about the host's
 * paging, continuation and lifecycle policy, not PDF parsing (the real worker is covered in contentWorkers.test.ts).
 * Synthetic data only.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_ASSET_MAX_PAGE_TEXT,
  CONTENT_ASSET_TTL_MS,
  ContentAssetStore,
  type PdfExtractor,
} from '../ContentAssetStore';
import { readDelegatedSourceInline, readDelegatedSourcePage } from '../DelegatedSourceRead';
import { composeUserTextAttachments, MAX_INLINED_TEXT_ATTACHMENT_CHARS, validateUserAttachments } from '../../attachments';
import { admitDelegationContentSources } from '../../host/orchestration/OrchestrationHostAdapter';
import { WorkspaceTools } from '../../backend/WorkspaceTools';
import { compileTaskContract, TaskInputResolver } from '../../backend/TaskContract';
import { boundToolResultForModel } from '../../backend/boundToolResultForModel';
import type { DelegationContentSource } from '../../session/TurnContextManifest';
import type { UserAttachment } from '../../types';

const PDF = new TextEncoder().encode('%PDF-1.7\nsynthetic fixture');
const MINUTE = 60_000;

/** The real reader tools of one agent over a shared store. */
function readerOf(store: ContentAssetStore, agentId: string, sources: DelegationContentSource[] = []): WorkspaceTools {
  const tools = new WorkspaceTools(
    process.cwd(), new Set(['read']), agentId, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, 'apply-edit', store,
  );
  tools.setDelegationContentSources(sources);
  return tools;
}

function handed(assetId: string, mediaKind: 'text' | 'pdf' = 'text'): DelegationContentSource {
  return { assetId, kind: 'user-request', label: 'Current task', location: 'chat composer', mediaKind };
}

const CONTINUATION = /read_extracted_content\(\{ assetId: "(content-\d+)", pages: \{ start: (\d+)(?:, end: (\d+))? \}(?:, offset: (\d+))? \}\)/;

/** The arguments of the read a result's continuation (or a turn's attachment line) names, if any. */
function continuationOf(text: string): Record<string, unknown> | undefined {
  const match = CONTINUATION.exec(text);
  if (!match) return undefined;
  return {
    assetId: match[1],
    pages: { start: Number(match[2]), ...(match[3] ? { end: Number(match[3]) } : {}) },
    ...(match[4] ? { offset: Number(match[4]) } : {}),
  };
}

/** Follow every continuation from a first read, as a model would; returns each result as the model receives it. */
async function readToTheEnd(tools: WorkspaceTools, first: Record<string, unknown>): Promise<string[]> {
  const results: string[] = [];
  let args: Record<string, unknown> | undefined = first;
  while (args) {
    const result = await tools.run('read_extracted_content', args);
    expect(result.status, result.output).toBe('success');
    const seen = boundToolResultForModel('read_extracted_content', result.output);
    results.push(seen);
    args = continuationOf(seen.slice(seen.lastIndexOf('More follows')));
    if (results.length > 500) throw new Error('no end');
  }
  return results;
}

function pdfExtractor(pageText: (page: number) => string | undefined, totalPages: number, calls: Array<{ start: number; end: number }> = []): PdfExtractor {
  return {
    async extract(_path, range) {
      calls.push({ ...range });
      const last = Math.min(totalPages, range.end);
      return {
        totalPages,
        pages: Array.from({ length: Math.max(0, last - range.start + 1) }, (_, index) => {
          const page = range.start + index;
          const text = pageText(page);
          return { page, text, truncated: false, ocrRequired: !text };
        }),
      };
    },
  };
}

function textAttachment(name: string, text: string): UserAttachment {
  return { name, mime: 'text/plain', kind: 'file', dataBase64: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text) };
}

describe('CF-2: a source is read to its end, whatever its length (inverted reproductions 4, 6, 7)', () => {
  it('reads the tail of a 200,001-character text source by following each result\'s continuation', async () => {
    const store = new ContentAssetStore();
    try {
      const body = `${'x'.repeat(199_997)}TAIL`;
      expect(body.length).toBe(200_001);
      const stored = await store.storeText(body, 'turn-supplied');
      const tools = readerOf(store, 'dev', [handed(stored.assetId)]);
      const results = await readToTheEnd(tools, { assetId: stored.assetId });
      // Eleven pages of 20,000 characters; each result fits what the model receives, continuation included.
      expect(results).toHaveLength(11);
      expect(results[0]).toContain('of 11 total');
      expect(results[0]).toContain(`More follows from page 2. To read it, call read_extracted_content({ assetId: "${stored.assetId}", pages: { start: 2, end: 11 } }).`);
      expect(results.every((output) => !output.includes('Tool result truncated'))).toBe(true);
      // Page 11 holds the last character; everything shown adds up to the whole source, its tail included.
      expect(results.at(-1)).toMatch(/Page 11: L$/);
      const shown = results.map((output) => [...output.matchAll(/Page \d+: ([xTAIL]*)/g)].map((match) => match[1]).join('')).join('');
      expect(shown).toBe(body);
    } finally {
      await store.dispose();
    }
  });

  it('reads page 1 and page 201 of a 201-page PDF, and asks the extractor only for pages near the ones read', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const store = new ContentAssetStore({ extractor: pdfExtractor((page) => `text of page ${page}`, 201, calls) });
    try {
      const stored = await store.storePdf(PDF, 'user-attachment');
      if ('error' in stored) throw new Error(stored.error);
      const tools = readerOf(store, 'dev', [handed(stored.assetId, 'pdf')]);
      const first = await tools.run('read_extracted_content', { assetId: stored.assetId, pages: { start: 1, end: 1 } });
      expect(first.output).toContain('pages requested 1-1, extracted 1 of 201 total');
      expect(first.output).toContain('Page 1: text of page 1');
      const last = await tools.run('read_extracted_content', { assetId: stored.assetId, pages: { start: 201, end: 201 } });
      expect(last.output).toContain('pages requested 201-201, extracted 1 of 201 total');
      expect(last.output).toContain('Page 201: text of page 201');
      expect(calls.every((range) => range.end - range.start < 20)).toBe(true);
    } finally {
      await store.dispose();
    }
  });

  it('reaches the tail of a page longer than one result by its continuation, and extracts it again after the cache let it go', async () => {
    let extractions = 0;
    const long = `${'x'.repeat(CONTENT_ASSET_MAX_PAGE_TEXT)}TAIL`;
    const counting = pdfExtractor((page) => (page === 1 ? long : `other ${'y'.repeat(30_000)}`), 2);
    const store = new ContentAssetStore({
      cacheChars: 25_000,
      extractor: { extract: async (path, range, options) => { extractions++; return counting.extract(path, range, options); } },
    });
    try {
      const stored = await store.storePdf(PDF, 'public-url');
      if ('error' in stored) throw new Error(stored.error);
      const tools = readerOf(store, 'dev', [handed(stored.assetId, 'pdf')]);
      const first = await tools.run('read_extracted_content', { assetId: stored.assetId, pages: { start: 1, end: 1 } });
      expect(first.output).toContain('Page 1 [characters 0-20,000 of 20,004]: ');
      expect(first.output).not.toContain('TAIL');
      expect(first.output).toContain(`More follows: page 1 continues at character 20,000. To read the rest, call read_extracted_content({ assetId: "${stored.assetId}", pages: { start: 1, end: 1 }, offset: 20000 }).`);
      const rest = await tools.run('read_extracted_content', continuationOf(first.output)!);
      expect(rest.output).toContain('Page 1 [characters 20,000-20,004 of 20,004]: TAIL');
      expect(rest.output).not.toContain('More follows');
      // Reading page 2 fills the small cache, so page 1 is let go; the same continuation extracts it again, whole.
      const before = extractions;
      await tools.run('read_extracted_content', { assetId: stored.assetId, pages: { start: 2, end: 2 } });
      const again = await tools.run('read_extracted_content', continuationOf(first.output)!);
      expect(again.output).toContain('Page 1 [characters 20,000-20,004 of 20,004]: TAIL');
      expect(extractions).toBeGreaterThan(before + 1);
    } finally {
      await store.dispose();
    }
  });
});

describe('CF-2: attachments are all delivered (inverted reproductions 8 and 9)', () => {
  it('takes a seventh attachment, and an eighth, and puts every text file in the turn', () => {
    const raw = Array.from({ length: 8 }, (_, index) => ({
      name: `${index}.txt`, mime: 'text/plain', kind: 'file', dataBase64: Buffer.from(`file ${index}`).toString('base64'),
    }));
    const result = validateUserAttachments(raw);
    expect(result.errors).toEqual([]);
    expect(result.attachments.map((attachment) => attachment.name)).toEqual(raw.map((item) => item.name));
    const composed = composeUserTextAttachments(result.attachments);
    expect(composed.inlined).toHaveLength(8);
    expect(composed.text).toContain('### 6.txt\n```\nfile 6\n```');
    expect(composed.text).toContain('### 7.txt\n```\nfile 7\n```');
  });

  it('puts the first 120,000 characters of a long text attachment in the turn and the rest in reach: following the named read ends at its tail', async () => {
    const store = new ContentAssetStore();
    try {
      const file = textAttachment('long.txt', `${'x'.repeat(MAX_INLINED_TEXT_ATTACHMENT_CHARS)}TAIL`);
      // The chat entry's admission, as a request is sent: it stores the whole file and names the copy on the attachment.
      const sources = await admitDelegationContentSources(store, [], [file], [], []);
      expect(file.contentAssetId).toBe(sources[0].assetId);
      const composed = composeUserTextAttachments([file]);
      expect(composed.inlined).toEqual([file]);
      expect(composed.text).not.toContain('TAIL');
      expect(composed.text).toContain('[Attachment long.txt continues: the first 120,000 of 120,004 characters are above.');
      expect(composed.text).not.toMatch(/truncated/i);
      // The receiving agent is given the request's sources; the read the turn names reaches the tail.
      const tools = readerOf(store, 'pm', sources);
      const named = continuationOf(composed.text)!;
      expect(named.assetId).toBe(sources[0].assetId);
      const results = await readToTheEnd(tools, named);
      // The named read starts at the first character after the inlined part: exactly the rest, and the block's end.
      expect(results).toHaveLength(1);
      expect(results[0]).toMatch(/\]: TAIL\n```$/);
    } finally {
      await store.dispose();
    }
  });

  it('never ends a long text attachment silently: without a stored copy, or on a conversation that cannot page, it says the rest was not read', () => {
    const file = textAttachment('long.txt', `${'x'.repeat(MAX_INLINED_TEXT_ATTACHMENT_CHARS)}TAIL`);
    expect(composeUserTextAttachments([file]).text).toContain('UnodeAi could not keep a copy to read the rest from. Tell the user the rest of this file was not read.');
    const stored = { ...file, contentAssetId: 'content-9' };
    expect(composeUserTextAttachments([stored], { pagedReads: false }).text)
      .toContain('this conversation was started before it could read files in pages. Tell the user the rest was not read');
  });
});

describe('CF-2: an attachment lives as long as something holds it (inverted reproduction 5, inventory B19)', () => {
  it('keeps an attachment usable 31 minutes and more while its request holds it, then while a task holds it', async () => {
    let now = 1_000_000;
    const store = new ContentAssetStore({ now: () => now });
    try {
      const [source] = await admitDelegationContentSources(store, [], [textAttachment('brief.txt', 'the brief')], [], []);
      store.holdForUserRequest('pm', [source.assetId]);
      now += 31 * MINUTE;
      expect(store.userAttachmentState(source.assetId)).toBe('live');
      expect((await store.readUserAttachment(source.assetId)).status).toBe('ready');
      now += 24 * 60 * MINUTE;
      expect(store.userAttachmentState(source.assetId)).toBe('live');

      // A delegated attempt takes it as an input; the person's next request then takes over from the first.
      const resolver = new TaskInputResolver(store, process.cwd());
      const attempt = await resolver.beginAttempt(contentContract(source.assetId), candidate('dev', [source.assetId]), 'pm');
      expect(attempt.error).toBeUndefined();
      store.holdForUserRequest('pm', []);
      now += 31 * MINUTE;
      expect(store.userAttachmentState(source.assetId)).toBe('live');
      // The attempt ends: nothing holds it, so it is reclaimed after the idle period, not before.
      resolver.endAttempt(attempt.card!.attemptId, 'settled');
      now += CONTENT_ASSET_TTL_MS - 1;
      expect(store.userAttachmentState(source.assetId)).toBe('live');
      now += 1;
      expect(store.userAttachmentState(source.assetId)).toBe('expired');
    } finally {
      await store.dispose();
    }
  });

  it('reclaims an asset, its files included, only after the last of its holders lets go', async () => {
    let now = 5_000;
    const store = new ContentAssetStore({ now: () => now, ttlMs: 10 * MINUTE });
    try {
      const attachment = await store.storeTextAttachment(Buffer.from('raw bytes'), 'the text');
      const files = (store as unknown as { assets: Map<string, { path: string; textPath: string }> }).assets.get(attachment.assetId)!;
      expect(store.retain([attachment.assetId], 'request:pm')).toEqual([attachment.assetId]);
      store.retain([attachment.assetId], 'attempt:a1');
      now += 60 * MINUTE;
      store.release('request:pm');
      now += 60 * MINUTE;
      expect(store.getReceipt(attachment.assetId)).toBeDefined();
      expect(store.isHeld(attachment.assetId)).toBe(true);
      store.release('attempt:a1');
      expect(store.isHeld(attachment.assetId)).toBe(false);
      now += 10 * MINUTE - 1;
      await store.cleanupExpired();
      expect(store.getReceipt(attachment.assetId)).toBeDefined();
      expect(existsSync(files.path)).toBe(true);
      now += 1;
      await store.cleanupExpired();
      expect(store.getReceipt(attachment.assetId)).toBeUndefined();
      expect(existsSync(files.path)).toBe(false);
      expect(existsSync(files.textPath)).toBe(false);
      // An asset nothing ever held is still reclaimed: storage does not grow without bound.
      const unheld = await store.storeText('never held', 'turn-supplied');
      now += 10 * MINUTE;
      expect(store.getReceipt(unheld.assetId)).toBeUndefined();
      // And a removal still acts at once, whatever holds the asset.
      const held = await store.storeText('held', 'turn-supplied');
      store.retain([held.assetId], 'request:pm');
      await store.discard(held.assetId);
      expect(store.getReceipt(held.assetId)).toBeUndefined();
    } finally {
      await store.dispose();
    }
  });
});

describe('CF-2: authority stays, and a delegated source reaches its tail on every route', () => {
  it('refuses a handle to an agent it was not given, on the reader tools and the paged delegated reader', async () => {
    const store = new ContentAssetStore();
    try {
      const stored = await store.storeText('private source', 'turn-supplied');
      const intruder = readerOf(store, 'intruder');
      const refused = await intruder.run('read_extracted_content', { assetId: stored.assetId });
      expect(refused).toMatchObject({ status: 'refused', reason: 'asset-unavailable' });
      expect(refused.output).not.toContain('private source');
      const notHanded = await readDelegatedSourcePage(store, undefined, 'intruder', stored.assetId, undefined, false, {});
      expect(notHanded).toMatchObject({ ok: false, reason: 'not-granted' });
      expect(notHanded.output).not.toContain('private source');
    } finally {
      await store.dispose();
    }
  });

  it('lets the attempt\'s own agent read a forwarded source to its tail, and refuses another agent the same attempt', async () => {
    const store = new ContentAssetStore();
    try {
      const body = `${'y'.repeat(250_000)}TAIL`;
      const source = await store.storeText(body, 'turn-supplied');
      const resolver = new TaskInputResolver(store, process.cwd());
      const attempt = (await resolver.beginAttempt(contentContract(source.assetId), candidate('dev', [source.assetId]), 'pm')).card!;
      const dev = readerOf(store, 'dev');
      dev.setTaskInputResolver(resolver);
      dev.beginTurn();
      dev.setTaskAttempt(attempt);
      const results = await readToTheEnd(dev, { assetId: source.assetId });
      expect(results).toHaveLength(13);
      expect(results.at(-1)).toMatch(/yTAIL$/);
      expect(resolver.grantsForAttempt(attempt.attemptId)[0].readAt).toBeDefined();

      const other = readerOf(store, 'other');
      other.setTaskInputResolver(resolver);
      other.beginTurn();
      other.setTaskAttempt(attempt);
      expect(await other.run('read_extracted_content', { assetId: source.assetId })).toMatchObject({ status: 'refused', reason: 'asset-unavailable' });
    } finally {
      await store.dispose();
    }
  });

  it('gives a route without the reader tools (Codex) the whole text inline and the rest by the paged delegated reader, to the tail', async () => {
    const store = new ContentAssetStore();
    try {
      const body = `${'z'.repeat(210_000)}TAIL`;
      const source = await store.storeText(body, 'turn-supplied');
      const inline = await readDelegatedSourceInline(store, undefined, 'codex-dev', handed(source.assetId), undefined);
      expect(inline).toEqual({ kind: 'text', assetId: source.assetId, text: body });
      let request: { pages?: { start?: number; end?: number }; offset?: number } | undefined = { pages: { start: 11 }, offset: 0 };
      let last = '';
      let reads = 0;
      while (request) {
        const page = await readDelegatedSourcePage(store, undefined, 'codex-dev', source.assetId, undefined, true, { ...request, maxChars: 8_000 });
        expect(page.ok, page.output).toBe(true);
        last = page.output;
        reads++;
        const next = continuationOf(page.output);
        request = next ? { pages: next.pages as { start: number }, ...(next.offset !== undefined ? { offset: next.offset as number } : {}) } : undefined;
      }
      // Page 11 holds 10,004 characters: two reads of at most 8,000.
      expect(reads).toBe(2);
      expect(last).toMatch(/zTAIL$/);
    } finally {
      await store.dispose();
    }
  });
});

describe('CF-2: an authorised file is read without a fixed size limit', () => {
  it('reads the last line of an 11 MiB workspace file with read_file, which the former 10 MiB limit refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-cf2-read-'));
    try {
      const line = `${'r'.repeat(1023)}\n`;
      await writeFile(join(root, 'big.log'), `${line.repeat(11 * 1024)}TAIL\n`, 'utf8');
      const tools = new WorkspaceTools(root, new Set(['read']), 'dev');
      const result = await tools.run('read_file', { path: 'big.log', offset: 11 * 1024, limit: 1 });
      expect(result.status, result.output).toBe('success');
      expect(result.output).toContain('TAIL');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('CF-2: a required snapshot or artifact is not refused for the store\'s size', () => {
  it('publishes an artifact past the former 200,000 characters, readable to its tail by the next attempt', async () => {
    const store = new ContentAssetStore();
    try {
      const resolver = new TaskInputResolver(store, process.cwd());
      const producer = (await resolver.beginAttempt(contentContract(), candidate('writer', []), 'pm')).card!;
      const published = await resolver.publishArtifact(producer.attemptId, 'writer', `${'w'.repeat(200_001)}TAIL`);
      expect(published.error).toBeUndefined();
      const tail = await store.readExtractedContent(published.artifact!.contentAssetId, { start: 11, end: 11 });
      expect('items' in tail && tail.items[0].text).toBe('wTAIL');
    } finally {
      await store.dispose();
    }
  });
});

function contentContract(assetId?: string) {
  const compiled = compileTaskContract({
    version: 1,
    objective: 'Work from the handed source.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: assetId ? [{
      input_id: 'source', kind: 'contentAsset', asset_id: assetId, purpose: 'The source', required: true,
      freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: [] },
    }] : [],
    required_capabilities: { version: 1, capabilities: ['read'] },
    execution_strategy: 'delegate-required',
  }, 'pm');
  if (!compiled.contract) throw new Error(JSON.stringify(compiled));
  return compiled.contract;
}

function candidate(agentId: string, assetIds: string[]) {
  return {
    agentId, capabilities: { read: true, write: false, shell: false }, taskScope: 'per-turn' as const,
    verificationSensors: [], authorizedContentAssetIds: assetIds, liveContentAssetIds: assetIds, readyArtifacts: [],
  };
}
