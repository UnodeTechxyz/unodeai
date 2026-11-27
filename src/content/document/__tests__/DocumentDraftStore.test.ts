import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentDraftStore } from '../DocumentDraftStore';
import type { DocumentBlock } from '../DocumentContracts';
import { temporaryFolder, removeTemporaryFolders } from '../../../backend/__tests__/pathSafetyFixtures';

afterEach(removeTemporaryFolders);
const root = () => temporaryFolder('unode-draft-test-');
const para = (text: string): DocumentBlock => ({ type: 'paragraph', content: [{ text, bold: false, language: 'en' }] });

describe('v0.9.99 document drafts on disk', () => {
  it('retains and shifts binding coordinates on disk and rejects loss of provenance metadata', async () => {
    const folder = await root(); const store = new DocumentDraftStore(async () => folder);
    const binding = { block_index: 0, target: { row: 1, column: 1 }, data_from: { transformation_ref: 'transformation-test', fields: ['total'] } };
    await store.append('d', [para('prefix')]); await store.append('d', [para('bound')], [binding]);
    await store.append('d', [para('another'), para('bound')], [{ ...binding, block_index: 1 }]);
    expect((await store.read('d'))?.source_bindings?.map(binding => binding.block_index)).toEqual([1, 3]);
    const file = join(folder, 'draft-1.jsonl'); const records = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    records[1].bindings = []; await writeFile(file, records.map(record => JSON.stringify(record) + '\n').join(''));
    await expect(store.read('d')).rejects.toThrow('changed on disk'); await store.discardAll();
  });
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
