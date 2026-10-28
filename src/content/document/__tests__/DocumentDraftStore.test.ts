import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentDraftStore } from '../DocumentDraftStore';
import type { DocumentBlock } from '../DocumentContracts';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const root = async () => { const folder = await mkdtemp(join(tmpdir(), 'unode-draft-test-')); folders.push(folder); return folder; };
const para = (text: string): DocumentBlock => ({ type: 'paragraph', content: [{ text, bold: false, language: 'en' }] });

describe('v0.9.99 document drafts on disk', () => {
  it('keeps parts in call order even when calls overlap, on disk rather than in memory, and never names a file after the draft', async () => {
    let folder = ''; const store = new DocumentDraftStore(async () => (folder = await root()));
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.append('contract/../x', [para(`P${i}a`), para(`P${i}b`)])));
    const read = await store.read('contract/../x');
    expect(read?.parts).toBe(12);
    expect(read?.blocks.map(block => (block as any).content[0].text)).toEqual(Array.from({ length: 12 }, (_, i) => [`P${i}a`, `P${i}b`]).flat());
    expect(await readdir(folder)).toEqual(['draft-1.jsonl']);
    expect(await store.read('other')).toBeUndefined();
    await store.discard('contract/../x'); expect(await readdir(folder)).toEqual([]); expect(store.has('contract/../x')).toBe(false);
  });
  it('removes a draft whose part could not be written instead of keeping a shorter one, and discardAll removes the folder', async () => {
    const folder = await root(); let calls = 0;
    const store = new DocumentDraftStore(async () => (++calls === 1 ? join(folder, 'missing', 'deeper') : folder));
    await expect(store.append('d', [para('lost')])).rejects.toThrow();
    expect(store.has('d')).toBe(false); expect(await store.read('d')).toBeUndefined();
    // A vanished folder is not reused: the next part starts a new one.
    expect(await store.append('d', [para('fresh')])).toEqual({ parts: 1, blocks: 1 }); expect(calls).toBe(2);
    const own = await root(); const working = new DocumentDraftStore(async () => own);
    await working.append('a', [para('one')]); await working.append('b', []);
    expect(await working.read('b')).toEqual({ parts: 1, blocks: [] });
    await working.discardAll();
    await expect(stat(own)).rejects.toThrow();
    await working.append('c', [para('after stop')]).catch(() => undefined);
  });
});
