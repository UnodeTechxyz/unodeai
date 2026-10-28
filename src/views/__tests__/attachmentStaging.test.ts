/*
 * v0.9.99: the host's copies of the files a chat composer hands over in pieces before Send. Real files in a real
 * temporary folder; the one limit is the memory one file takes once sent, and the disk.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { constants as bufferConstants } from 'node:buffer';
import { AttachmentStaging, defaultAttachmentMemoryBudget } from '../attachmentStaging';
import { hostReadMemoryBudget } from '../../content/ContentAssetStore';

const made: Array<() => void> = [];
afterEach(() => { while (made.length) made.pop()!(); });

function staging(options: ConstructorParameters<typeof AttachmentStaging>[0] = {}): AttachmentStaging {
  const root = mkdtempSync(join(tmpdir(), 'unode-staging-test-'));
  const value = new AttachmentStaging({ tempRoot: () => root, ...options });
  made.push(() => { value.dispose(); rmSync(root, { recursive: true, force: true }); });
  return value;
}

const piece = (text: string) => Buffer.from(text, 'utf8');

describe('the host keeps a file the composer hands over in pieces', () => {
  it('assembles the pieces in order and hands back exactly the bytes, once', () => {
    const store = staging();
    expect(store.append('sidebar', 'up-1', 0, 9, piece('abc'))).toEqual({ ok: true, received: 3 });
    expect(store.completeSize('sidebar', 'up-1')).toBeUndefined();
    expect(store.append('sidebar', 'up-1', 1, 9, piece('def'))).toEqual({ ok: true, received: 6 });
    expect(store.append('sidebar', 'up-1', 2, 9, piece('ghi'))).toEqual({ ok: true, received: 9 });
    expect(store.completeSize('sidebar', 'up-1')).toBe(9);
    const taken = store.take('sidebar', 'up-1');
    expect(taken.ok && taken.bytes.toString('utf8')).toBe('abcdefghi');
    // Taken means let go of: the copy is gone and a second send cannot name it.
    expect(store.heldCount()).toBe(0);
    expect(store.take('sidebar', 'up-1')).toEqual({ ok: false, reason: 'UnodeAi no longer has the copy this chat received. Attach it again' });
  });

  it('takes an empty file', () => {
    const store = staging();
    expect(store.append('sidebar', 'up-0', 0, 0, Buffer.alloc(0))).toEqual({ ok: true, received: 0 });
    const taken = store.take('sidebar', 'up-0');
    expect(taken.ok && taken.bytes.byteLength).toBe(0);
  });

  it('lets one chat view name only the files it handed over itself', () => {
    const store = staging();
    store.append('sidebar', 'up-1', 0, 2, piece('hi'));
    expect(store.take('workbench', 'up-1').ok).toBe(false);
    store.discardScope('workbench');
    expect(store.take('sidebar', 'up-1').ok).toBe(true);
  });

  it('ends an upload whose pieces come out of order, past their total, or without a start, for that file alone', () => {
    const store = staging();
    store.append('sidebar', 'other', 0, 2, piece('ok'));
    store.append('sidebar', 'up-1', 0, 6, piece('abc'));
    expect(store.append('sidebar', 'up-1', 2, 6, piece('def'))).toEqual({ ok: false, reason: 'its pieces did not arrive as the chat sent them' });
    expect(store.take('sidebar', 'up-1').ok).toBe(false);
    store.append('sidebar', 'up-2', 0, 4, piece('abc'));
    expect(store.append('sidebar', 'up-2', 1, 4, piece('de')).ok).toBe(false);
    store.append('sidebar', 'up-3', 0, 4, piece('ab'));
    expect(store.append('sidebar', 'up-3', 1, 5, piece('cd')).ok).toBe(false);
    expect(store.append('sidebar', 'never-started', 1, 4, piece('ab'))).toEqual({ ok: false, reason: 'UnodeAi did not receive the start of the file' });
    expect(store.take('sidebar', 'other').ok).toBe(true);
  });

  it('does not hand over a file it has not received whole', () => {
    const store = staging();
    store.append('sidebar', 'up-1', 0, 4, piece('ab'));
    expect(store.take('sidebar', 'up-1')).toEqual({ ok: false, reason: 'UnodeAi had not received all of it. Attach it again' });
  });

  it('refuses at the first piece only a file larger than one file may take in memory, and says so in plain words', () => {
    const store = staging({ memoryBudget: () => 5 * 1024 * 1024 });
    expect(store.append('sidebar', 'at-budget', 0, 5 * 1024 * 1024, piece('a')).ok).toBe(true);
    const over = store.append('sidebar', 'over', 0, 5 * 1024 * 1024 + 1, piece('a'));
    expect(over).toEqual({ ok: false, reason: 'at 5.0 MB it is more than this VS Code window can hold in memory for one file (about 5.0 MB). '
      + 'Save it in the workspace folder and ask the agent to work on it there' });
    expect(store.heldCount()).toBe(1);
  });

  it("takes by default up to the host's memory budget for one file, and no more than one base64 text can carry", () => {
    const budget = defaultAttachmentMemoryBudget();
    expect(budget).toBe(Math.min(hostReadMemoryBudget(), Math.floor(bufferConstants.MAX_STRING_LENGTH / 4) * 3));
    // Far above the former 10 MiB: the limit is this process's resources, not a chosen file size.
    expect(budget).toBeGreaterThan(64 * 1024 * 1024);
    expect(new AttachmentStaging().memoryBudget()).toBe(budget);
  });

  it('reports a disk it cannot write to for that file, and keeps the others', () => {
    const root = mkdtempSync(join(tmpdir(), 'unode-staging-test-'));
    made.push(() => rmSync(root, { recursive: true, force: true }));
    const blocked = join(root, 'not-a-folder');
    writeFileSync(blocked, 'a file where the temporary folder would go');
    const store = new AttachmentStaging({ tempRoot: () => blocked });
    made.push(() => store.dispose());
    expect(store.append('sidebar', 'up-1', 0, 2, piece('hi'))).toEqual({ ok: false, reason: 'UnodeAi could not write a temporary copy of it. Attach it again' });
  });

  it('removes a discarded copy and, on dispose, its whole temporary folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'unode-staging-test-'));
    made.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new AttachmentStaging({ tempRoot: () => root });
    store.append('sidebar', 'up-1', 0, 2, piece('hi'));
    store.append('workbench', 'up-2', 0, 2, piece('hi'));
    const [folder] = readdirSync(root);
    expect(readdirSync(join(root, folder))).toHaveLength(2);
    store.discard('sidebar', 'up-1');
    expect(readdirSync(join(root, folder))).toHaveLength(1);
    store.discardScope('workbench');
    expect(readdirSync(join(root, folder))).toHaveLength(0);
    store.dispose();
    expect(existsSync(join(root, folder))).toBe(false);
  });
});
