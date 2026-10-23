/*
 * v0.9.97 P4: `save_attachment`, the host tool that writes a file the user attached into the workspace. Each case
 * names the sentence it realises: handoff §1 ("PNG/JPEG/PDF/text attachments saved with their original bytes to an
 * approved path; the success receipt can be checked independently by SHA-256"), handoff §5 (input exactly
 * { asset_id, path }; only a live user-attachment granted to this agent and turn; raw bytes apart from model text;
 * 10 MiB and 30 minutes, not extended by saving; PNG -> .png, JPEG -> .jpg/.jpeg, PDF -> .pdf, text as admitted with
 * a binary signature checked first and its original bytes; typed outcomes), file effects design §3 (the card shows
 * destination, type from the bytes, size, SHA-256 and the overwrite consequence; every wait is followed by a look at
 * trust, the agent, the attachment and the destination), the original card's acceptance 1-3, and USAGE "Saving a file
 * you attached".
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentAssetStore, CONTENT_ASSET_TTL_MS } from '../../content/ContentAssetStore';
import { saveableAttachmentNote, SAVED_ATTACHMENT_EXTENSIONS } from '../../content/AttachmentSave';
import { MessageBus } from '../../bus/MessageBus';
import type { Message } from '../../types';
import { checkpointRestorePlan } from '../Checkpoints';
import { OptimisticFileCoordinator } from '../FileCoordinator';
import { readTargetState } from '../fileWritePolicy';
import { TeamTools, type TeamView } from '../TeamTools';
import {
  MAY_MUTATE_WORKSPACE_TOOLS,
  requiresTrustedWorkspace,
  SAVE_ATTACHMENT_DESCRIPTION,
  type WorkspaceTools,
} from '../WorkspaceTools';
import {
  admitUserTurn,
  attachment,
  attachmentIds,
  CSV_BOM_CRLF,
  GIF,
  JPEG,
  LATIN1,
  MARKDOWN_LF,
  PDF,
  PNG,
  saveHost,
  sha,
} from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);

const exists = (file: string) => fs.access(file).then(() => true, () => false);

async function hostWith(files: Array<[string, string, 'image' | 'pdf' | 'file', Buffer]>, options: Parameters<typeof saveHost>[0] = {}) {
  const h = await saveHost(options);
  const sources = await admitUserTurn(h.assets, files.map(([name, mime, kind, bytes]) => attachment(name, mime, kind, bytes)));
  const ids = attachmentIds(sources);
  // An attachment's id by the name the user's file had (the test's own lookup; no receipt or note carries names).
  const id = (name: string) => sources.find((source) => source.label === name)!.assetId;
  return { ...h, sources, ids, id, agent: (agentId = 'dev') => h.tools(agentId, sources) };
}

describe('save_attachment writes the exact bytes the user attached (handoff §1, §5; card acceptance 1)', () => {
  it('saves a PNG, a JPEG, a PDF and text files byte for byte, and the receipt is what was read back', async () => {
    const h = await hostWith([
      ['image.png', 'image/png', 'image', PNG],
      ['photo.jpg', 'image/jpeg', 'image', JPEG],
      ['brief.pdf', 'application/pdf', 'pdf', PDF],
      ['people.csv', 'text/csv', 'file', CSV_BOM_CRLF],
      ['notes.md', 'text/markdown', 'file', MARKDOWN_LF],
      ['legacy.txt', 'text/plain', 'file', LATIN1],
    ]);
    const tools = h.agent();
    const cases: Array<[string, string, Buffer]> = [
      [h.id('people.csv'), 'data/people.csv', CSV_BOM_CRLF],
      [h.id('image.png'), 'assets/brand/logo.png', PNG],
      [h.id('photo.jpg'), 'assets/photo.jpeg', JPEG],
      [h.id('brief.pdf'), 'docs/brief.pdf', PDF],
      [h.id('notes.md'), 'notes.md', MARKDOWN_LF],
      [h.id('legacy.txt'), 'legacy.txt', LATIN1],
    ];
    for (const [assetId, destination, bytes] of cases) {
      const result = await tools.run('save_attachment', { asset_id: assetId, path: destination });
      expect(result.status, destination).toBe('success');
      const onDisk = await fs.readFile(path.join(h.root, destination));
      expect(onDisk.equals(bytes), destination).toBe(true);
      expect(result.attachmentSave, destination).toMatchObject({
        code: 'saved',
        receipt: { path: destination, bytes: bytes.length, sha256: sha(bytes), created: true },
      });
      expect(result.attachmentSave?.receipt?.restorePoint, destination).toBeUndefined();
      expect(result.output).toContain(`Saved attachment ${assetId} to ${destination} as a new file: ${bytes.length} bytes, SHA-256 ${sha(bytes)}`);
    }
    // The missing folders were made with the first save into them, and named.
    const first = await h.agent().run('save_attachment', { asset_id: h.id('image.png'), path: 'more/deep/logo.png' });
    expect(first.output).toContain('Created folders more, more/deep.');
    // No name the user's file had, and no temporary path, is in any receipt.
    expect(first.output).not.toMatch(/image\.png|unode-content-/);
  });

  it('keeps a text attachment\'s bytes apart from the text its readers get (handoff §5)', async () => {
    const h = await hostWith([['people.csv', 'text/csv', 'file', CSV_BOM_CRLF]]);
    const tools = h.agent();
    const read = await tools.run('read_extracted_content', { assetId: h.ids[0] });
    expect(read.status).toBe('success');
    // The readers see the formatted file the model saw before, without its byte-order mark...
    expect(read.output).toContain('### people.csv');
    expect(read.output).not.toContain('﻿');
    // ...and the save writes what was attached, mark and CRLF included.
    await tools.run('save_attachment', { asset_id: h.ids[0], path: 'people.csv' });
    expect((await fs.readFile(path.join(h.root, 'people.csv'))).equals(CSV_BOM_CRLF)).toBe(true);
    // The request's own text stays turn-supplied text: it is no attachment, and is not saved.
    const request = h.sources.find((source) => source.kind === 'user-request')!;
    const refused = await tools.run('save_attachment', { asset_id: request.assetId, path: 'request.txt' });
    expect(refused.attachmentSave?.code).toBe('provenance');
    expect(await exists(path.join(h.root, 'request.txt'))).toBe(false);
  });
});

describe('only a live file the user attached, given to this agent for this turn (handoff §5; card acceptance 2)', () => {
  it('refuses a web download and text passed along with the request, even when given to the agent', async () => {
    const h = await hostWith([]);
    const downloaded = await h.assets.storeImage(PNG, 'public-url', 'image/png', 'dev');
    const supplied = await h.assets.storeText('a coordinator summary', 'turn-supplied');
    if ('error' in downloaded || 'error' in supplied) throw new Error('fixture');
    const tools = h.tools('dev', [
      { assetId: supplied.assetId, kind: 'user-request', label: 'x', location: 'x', mediaKind: 'text' },
    ]);
    for (const [assetId, destination] of [[downloaded.assetId, 'logo.png'], [supplied.assetId, 'summary.txt']]) {
      const result = await tools.run('save_attachment', { asset_id: assetId, path: destination });
      expect(result, destination).toMatchObject({ status: 'refused', reason: 'asset-unavailable', attachmentSave: { code: 'provenance' } });
      expect(result.output).toMatch(/saves only a file the user attached.*Do not save a substitute/);
      expect(await exists(path.join(h.root, destination))).toBe(false);
    }
  });

  it('refuses an attachment not given to this agent, and an id the host never issued', async () => {
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]]);
    const other = h.tools('qa', []);
    for (const assetId of [h.ids[0], 'content-999', '../content-1']) {
      const result = await other.run('save_attachment', { asset_id: assetId, path: 'logo.png' });
      expect(result, assetId).toMatchObject({ status: 'refused', reason: 'asset-unavailable', attachmentSave: { code: 'asset-unavailable' } });
    }
    expect(await exists(path.join(h.root, 'logo.png'))).toBe(false);
  });

  it('refuses an attachment past its 30 minutes, says to attach it again, and saving never extends its life', async () => {
    let now = 1_000_000;
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]], { now: () => now });
    const tools = h.agent();
    now += CONTENT_ASSET_TTL_MS - 60_000;
    expect(await tools.run('save_attachment', { asset_id: h.ids[0], path: 'one.png' })).toMatchObject({ status: 'success' });
    // Two minutes later the 30 minutes since it was attached are over, though it was saved a minute before.
    now += 120_000;
    const late = await tools.run('save_attachment', { asset_id: h.ids[0], path: 'two.png' });
    expect(late).toMatchObject({ status: 'refused', reason: 'asset-unavailable', attachmentSave: { code: 'asset-expired' } });
    expect(late.output).toMatch(/30 minutes after it was attached.*Ask the user to attach the file again/);
    expect(await exists(path.join(h.root, 'two.png'))).toBe(false);
  });

  it('takes exactly { asset_id, path }: no bytes, URL, type or claimed permission', async () => {
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]]);
    const tools = h.agent();
    for (const extra of [{ base64: PNG.toString('base64') }, { url: 'https://example.com/logo.png' }, { mime: 'image/png' }, { sourceKind: 'user-attachment' }]) {
      const result = await tools.run('save_attachment', { asset_id: h.ids[0], path: 'logo.png', ...extra });
      expect(result, Object.keys(extra)[0]).toMatchObject({ status: 'failed', attachmentSave: { code: 'invalid-input' } });
      expect(result.output).toContain(`it does not take "${Object.keys(extra)[0]}"`);
    }
    const missing = await tools.run('save_attachment', { asset_id: h.ids[0] });
    expect(missing.output).toMatch(/missing required parameter\(s\): path/);
    expect(await exists(path.join(h.root, 'logo.png'))).toBe(false);
  });
});

describe('the type comes from the bytes, and names the destination\'s extension (handoff §5; card acceptance 2)', () => {
  it('refuses PNG bytes under .svg, an extensionless name, JPEG under .png, text under .exe, and a PDF under .txt', async () => {
    const h = await hostWith([
      ['image.png', 'image/png', 'image', PNG],
      ['photo.jpg', 'image/jpeg', 'image', JPEG],
      ['notes.md', 'text/markdown', 'file', MARKDOWN_LF],
      ['brief.pdf', 'application/pdf', 'pdf', PDF],
    ]);
    const tools = h.agent();
    for (const [assetId, destination] of [
      [h.id('image.png'), 'logo.svg'], [h.id('image.png'), 'logo'], [h.id('image.png'), '.png'], [h.id('photo.jpg'), 'photo.png'],
      [h.id('notes.md'), 'run.exe'], [h.id('notes.md'), 'notes.md.cmd'], [h.id('brief.pdf'), 'brief.txt'],
    ]) {
      const result = await tools.run('save_attachment', { asset_id: assetId, path: destination });
      expect(result, destination).toMatchObject({ status: 'failed', attachmentSave: { code: 'extension-mismatch' } });
      expect(await exists(path.join(h.root, destination)), destination).toBe(false);
    }
    // Case does not matter, and each text extension of the allow-list is accepted.
    expect(await tools.run('save_attachment', { asset_id: h.id('image.png'), path: 'LOGO.PNG' })).toMatchObject({ status: 'success' });
    expect(SAVED_ATTACHMENT_EXTENSIONS.text).toHaveLength(25);
    for (const extension of SAVED_ATTACHMENT_EXTENSIONS.text) {
      expect(await tools.run('save_attachment', { asset_id: h.id('notes.md'), path: `t/notes${extension}` }), extension).toMatchObject({ status: 'success' });
    }
  });

  it('refuses a text attachment whose bytes have a binary signature, and a GIF, before touching the destination', async () => {
    const h = await hostWith([
      ['notes.txt', 'text/plain', 'file', PNG],
      ['anim.gif', 'image/gif', 'image', GIF],
    ]);
    const tools = h.agent();
    const renamed = await tools.run('save_attachment', { asset_id: h.id('notes.txt'), path: 'notes.txt' });
    expect(renamed).toMatchObject({ status: 'failed', attachmentSave: { code: 'type-mismatch' } });
    expect(renamed.output).toMatch(/attached as a text file, but its content looks like a PNG image/);
    const gif = await tools.run('save_attachment', { asset_id: h.id('anim.gif'), path: 'anim.gif' });
    expect(gif).toMatchObject({ status: 'failed', attachmentSave: { code: 'type-unsupported' } });
    expect(await fs.readdir(h.root)).toEqual([]);
  });
});

describe('the same write boundary as write_file (handoff §4; file effects design §3)', () => {
  it('shows the destination, type, size, SHA-256 and consequence on the card, and a denial saves nothing', async () => {
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]], { ask: true, approve: async () => 'deny' });
    const result = await h.agent().run('save_attachment', { asset_id: h.ids[0], path: 'assets/logo.png' });
    expect(result).toMatchObject({ status: 'refused', reason: 'consent', attachmentSave: { code: 'denied' } });
    expect(h.state.approvals).toHaveLength(1);
    expect(h.state.approvals[0]).toMatchObject({ path: 'assets/logo.png', before: null });
    expect(h.state.approvals[0].preview).toBe([
      'Save a file the user attached, byte for byte.',
      'Destination: assets/logo.png (a new file)',
      'Type: PNG image, from its bytes',
      `Size: ${PNG.length} bytes`,
      `SHA-256: ${sha(PNG)}`,
      'Nothing is replaced; restoring this change removes the new file.',
    ].join('\n'));
    expect(await fs.readdir(h.root)).toEqual([]);
    expect(h.text.list()).toEqual([]);
  });

  it('replaces an existing file only after keeping its exact bytes, and the receipt names that restore point', async () => {
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]], { ask: true });
    const target = path.join(h.root, 'logo.png');
    const old = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01]);
    await fs.writeFile(target, old);
    // The file is outside Git and unread: the decision card is asked, with the same preview.
    const result = await h.agent().run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' });
    expect(result.status).toBe('success');
    expect(h.state.decisions).toHaveLength(1);
    expect(h.state.decisions[0].preview).toContain(`The file there now (${old.length} bytes) is replaced. Its exact bytes are kept first as a restore point`);
    expect(h.state.approvals).toEqual([]);
    expect((await fs.readFile(target)).equals(PNG)).toBe(true);
    const store = await h.rawStore();
    const [entry] = store.list();
    expect(result.attachmentSave).toMatchObject({
      code: 'saved',
      receipt: { path: 'logo.png', bytes: PNG.length, sha256: sha(PNG), created: false, restorePoint: entry.id },
    });
    expect(result.output).toContain(`Restore point ${entry.id} keeps the exact bytes the file held before.`);
    expect(await store.readBefore(entry.id)).toEqual({ status: 'read', bytes: old });
    const [record] = h.text.list();
    expect(record).toMatchObject({ raw: { id: entry.id, afterSha256: sha(PNG) } });
  });

  it('says so, and records no change, when the file already held exactly these bytes', async () => {
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]]);
    const tools = h.agent();
    await tools.run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' });
    const again = await tools.run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' });
    expect(again.attachmentSave).toMatchObject({ code: 'saved', receipt: { created: false, sha256: sha(PNG) } });
    expect(again.attachmentSave?.receipt?.restorePoint).toBeUndefined();
    expect(again.output).toContain('The file already held exactly these bytes, so no restore point was needed.');
    expect(h.text.list()).toHaveLength(1);
  });

  it('records a new binary file so that a restore can remove exactly it (card acceptance 3)', async () => {
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]]);
    await h.agent().run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' });
    const [record] = h.text.list();
    expect(record).toMatchObject({ before: null, afterSha256: sha(PNG), operation: 'write' });
    expect(record.after).toMatch(/^\(PNG image, \d+ bytes, SHA-256 [0-9a-f]{64}: saved from a file the user attached\)$/);
    const planned = checkpointRestorePlan(h.text.list(), record);
    expect(planned).toMatchObject({ ok: true, plan: { expected: { kind: 'bytes', sha256: sha(PNG) } } });
  });

  it('refuses when the exact bytes of the file it would replace cannot be kept, and changes nothing', async () => {
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]], { limits: { maxPayloadBytes: 4 } });
    const target = path.join(h.root, 'logo.png');
    await fs.writeFile(target, 'an older logo');
    const result = await h.agent().run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' });
    expect(result).toMatchObject({ status: 'failed', attachmentSave: { code: 'checkpoint-failed' } });
    expect(result.attachmentSave?.receipt).toBeUndefined();
    expect(await fs.readFile(target, 'utf8')).toBe('an older logo');
    expect(h.text.list()).toEqual([]);
  });

  it('gives no receipt when the read-back does not find the attachment\'s bytes (handoff §3)', async () => {
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]], {
      // The destination is new, so only the read-back finds a file there; here it finds other bytes.
      readState: async (physical) => {
        const seen = await readTargetState(physical);
        return seen.state.exists ? { state: { ...seen.state, sha256: sha('something else') } } : seen;
      },
    });
    const result = await h.agent().run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' });
    expect(result).toMatchObject({ status: 'failed', attachmentSave: { code: 'effect-uncertain' } });
    expect(result.attachmentSave?.receipt).toBeUndefined();
    expect(result.output).toMatch(/may have changed it/);
  });

  it('is refused by the write policy as write_file is: a file with two names on disk is not replaced', async () => {
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]]);
    const target = path.join(h.root, 'logo.png');
    await fs.writeFile(target, 'an older logo');
    await fs.link(target, path.join(h.root, 'other-name.png'));
    const result = await h.agent().run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' });
    expect(result).toMatchObject({ status: 'failed', attachmentSave: { code: 'target-refused' } });
    expect(result.output).toMatch(/more than one name on disk/);
    expect(await fs.readFile(target, 'utf8')).toBe('an older logo');
    expect(h.state.decisions).toEqual([]);
  });

  it('keeps the team\'s read-before-write check of write_file: a shared file is replaced only after this agent read it', async () => {
    const h = await hostWith([['notes.md', 'text/markdown', 'file', MARKDOWN_LF]], { coordinator: new OptimisticFileCoordinator() });
    const target = path.join(h.root, 'notes.md');
    await fs.writeFile(target, '# A teammate\'s notes\n');
    const tools = h.agent();
    const unread = await tools.run('save_attachment', { asset_id: h.ids[0], path: 'notes.md' });
    expect(unread).toMatchObject({ status: 'failed', attachmentSave: { code: 'target-refused' } });
    expect(unread.output).toMatch(/You have not read "?.*notes\.md"? yet/);
    expect(await fs.readFile(target, 'utf8')).toBe('# A teammate\'s notes\n');
    await tools.run('read_file', { path: 'notes.md' });
    expect(await tools.run('save_attachment', { asset_id: h.ids[0], path: 'notes.md' })).toMatchObject({ status: 'success' });
    expect((await fs.readFile(target)).equals(MARKDOWN_LF)).toBe(true);
  });

  it('refuses a destination outside the writable folders and in an untrusted workspace', async () => {
    let trusted = true;
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]], { trusted: () => trusted });
    const tools = h.agent();
    expect(await tools.run('save_attachment', { asset_id: h.ids[0], path: '../outside.png' }))
      .toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    trusted = false;
    expect(await tools.run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' })).toMatchObject({ status: 'refused', reason: 'trust' });
    expect(await fs.readdir(h.root)).toEqual([]);
    expect(requiresTrustedWorkspace('save_attachment')).toBe(true);
    expect(MAY_MUTATE_WORKSPACE_TOOLS).toContain('save_attachment');
  });
});

describe('every wait ends in a look again: no effect and no receipt (file effects design §3)', () => {
  type Change = (tools: WorkspaceTools, h: Awaited<ReturnType<typeof hostWith>>) => void | Promise<void>;
  const cases: Array<[string, Change, string, RegExp]> = [
    ['trust lost', () => { trusted = false; }, 'interrupted', /no longer trusted/],
    ['agent stopped', (tools) => { tools.retire(); }, 'interrupted', /agent is stopping/],
    ['host shutting down', (tools) => { (tools as unknown as { backgroundShutdown: { started: boolean } }).backgroundShutdown = { started: true }; }, 'interrupted', /agent is stopping/],
    ['call stopped', () => { abort.abort(); }, 'interrupted', /request was stopped/],
    ['grant revoked', (tools) => { tools.setDelegationContentSources([]); }, 'grant-revoked', /no longer given to this agent/],
    ['attachment expired', () => { now += CONTENT_ASSET_TTL_MS; }, 'asset-expired', /no longer held.*attach the file again/],
    ['destination appeared', async (_tools, h) => { await fs.writeFile(path.join(h.root, 'logo.png'), 'someone else'); }, 'target-changed', /appeared while this change waited/],
  ];
  let trusted = true;
  let now = 1_000_000;
  let abort = new AbortController();
  for (const [name, change, code, message] of cases) {
    it(`${name} while the approval is open`, async () => {
      trusted = true;
      abort = new AbortController();
      // The approval runs during the call, after both are set.
      const h: Awaited<ReturnType<typeof hostWith>> = await hostWith([['image.png', 'image/png', 'image', PNG]], {
        now: () => now,
        trusted: () => trusted,
        ask: true,
        approve: async () => { await change(tools, h); return 'once'; },
      });
      const tools: WorkspaceTools = h.agent();
      const result = await tools.run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' }, { signal: abort.signal });
      expect(result).toMatchObject({ status: 'failed', attachmentSave: { code } });
      expect(result.output).toMatch(message);
      expect(result.attachmentSave?.receipt).toBeUndefined();
      const left = await fs.readFile(path.join(h.root, 'logo.png')).catch(() => undefined);
      expect(left?.equals(PNG) ?? false).toBe(false);
      expect(h.text.list()).toEqual([]);
    });
  }
});

// v0.9.97 field run, item 2: Claude CLI ended a save after 60 s of the person deciding, and the card stayed open for a
// call that had ended. The card is the host's; it can be withdrawn only if it knows the call's own cancellation.
describe("the card belongs to its call: the call's cancellation reaches it, and never another call's", () => {
  it('gives the write card the signal of its own call, and the stopped call saves nothing', async () => {
    const abort = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]], {
      ask: true,
      approve: async (request) => { seen.push(request.signal); abort.abort(); return 'deny'; },
    });
    const result = await h.agent().run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' }, { signal: abort.signal });
    expect(seen).toEqual([abort.signal]);
    expect(result.status).not.toBe('success');
    expect(await exists(path.join(h.root, 'logo.png'))).toBe(false);
  });

  it("gives the decision card for a file that may hold others' work the signal of its own call too", async () => {
    const abort = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]], {
      decide: async (request) => { seen.push(request.signal); return 'deny'; },
    });
    // A file this agent never read nor wrote, outside Git: the policy asks the person before replacing it.
    await fs.writeFile(path.join(h.root, 'logo.png'), "not the agent's");
    const result = await h.agent().run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' }, { signal: abort.signal });
    expect(seen).toEqual([abort.signal]);
    expect(result.status).not.toBe('success');
    expect(await fs.readFile(path.join(h.root, 'logo.png'), 'utf8')).toBe("not the agent's");
  });

  it("keeps two concurrent calls' signals apart: stopping one leaves the other's card and save alone", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const seen = new Map<string, AbortSignal | undefined>();
    let releaseFirst: () => void = () => undefined;
    const firstWaits = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const h = await hostWith([['a.png', 'image/png', 'image', PNG], ['b.png', 'image/png', 'image', PNG]], {
      ask: true,
      approve: async (request) => {
        seen.set(request.path, request.signal);
        // The first call's card stays open while the second call starts, as two cards on screen would.
        if (request.path === 'one.png') await firstWaits;
        return 'once';
      },
    });
    const tools = h.agent();
    const one = tools.run('save_attachment', { asset_id: h.id('a.png'), path: 'one.png' }, { signal: first.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const two = await tools.run('save_attachment', { asset_id: h.id('b.png'), path: 'two.png' }, { signal: second.signal });
    first.abort();
    releaseFirst();
    const oneResult = await one;
    expect(seen.get('one.png')).toBe(first.signal);
    expect(seen.get('two.png')).toBe(second.signal);
    expect(two.status).toBe('success');
    expect((await fs.readFile(path.join(h.root, 'two.png'))).equals(PNG)).toBe(true);
    expect(oneResult.status).not.toBe('success');
    expect(await exists(path.join(h.root, 'one.png'))).toBe(false);
  });
});

describe('the last look is just before the effect (handoff §4: recheck after the checkpoint, before the commit)', () => {
  it('writes nothing when the attachment expires while the replaced file\'s restore point is being kept', async () => {
    let now = 1_000_000;
    let captures = 0;
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]], {
      now: () => now,
      // The first index commit is the restore point's own; the attachment's 30 minutes end during it.
      duringCapture: () => { if (++captures === 1) now += CONTENT_ASSET_TTL_MS; },
    });
    const target = path.join(h.root, 'logo.png');
    await fs.writeFile(target, 'an older logo');
    const result = await h.agent().run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' });
    expect(captures).toBeGreaterThan(0);
    expect(result).toMatchObject({ status: 'failed', attachmentSave: { code: 'asset-expired' } });
    expect(await fs.readFile(target, 'utf8')).toBe('an older logo');
    // A change that was not made keeps no restore point.
    expect((await h.rawStore()).list()).toEqual([]);
    expect(h.text.list()).toEqual([]);
  });
});

describe('the look inside the lock comes before the restore point (handoff §4: lock -> recheck -> checkpoint)', () => {
  it('keeps no copy of a file it will not replace, when trust was lost during the decision', async () => {
    let trusted = true;
    let captures = 0;
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]], {
      trusted: () => trusted,
      // The file is outside Git and was not read: the person is asked the one-change decision.
      decide: async () => { trusted = false; return 'once'; },
      duringCapture: () => { captures++; },
    });
    await fs.writeFile(path.join(h.root, 'logo.png'), 'an older logo');
    const result = await h.agent().run('save_attachment', { asset_id: h.ids[0], path: 'logo.png' });
    expect(result).toMatchObject({ status: 'failed', attachmentSave: { code: 'interrupted' } });
    expect(captures).toBe(0);
    expect(await fs.readFile(path.join(h.root, 'logo.png'), 'utf8')).toBe('an older logo');
  });
});

describe('a delegate saves only what the coordinator handed it (handoff §5: the existing explicit re-grant)', () => {
  it('saves an attachment that came with its assignment, and nothing a later assignment did not carry', async () => {
    const h = await hostWith([['image.png', 'image/png', 'image', PNG]]);
    const bus = new MessageBus();
    const roster = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle' },
      { id: 'tester', role: 'tester', name: 'Tester', status: 'idle' },
    ];
    const team = new TeamTools('pm', {
      list: () => roster,
      preflightTaskScope: () => undefined,
      resolve: (ref: string) => (roster.some((member) => member.id === ref) ? { id: ref } : undefined),
    } as unknown as TeamView, bus, { timeoutMs: 1000, cwd: h.root });
    const assigned: Message[] = [];
    bus.onType('task.assign', (message) => { assigned.push(message); });
    // The coordinator's user turn carries the attachment; its assignment hands it on.
    team.setDelegationContentSources(h.sources);
    await team.run('assign_task_async', { agent: 'dev', instruction: 'Save the logo.' });
    team.setDelegationContentSources(undefined);
    await team.run('assign_task_async', { agent: 'tester', instruction: 'Check the logo.' });
    const [toDev, toTester] = assigned.map((message) => message.payload.delegationContentSources);
    expect(toDev?.map((source) => source.assetId)).toContain(h.id('image.png'));
    expect(toTester).toEqual([]);

    const dev = h.tools('dev', toDev);
    expect(await dev.run('save_attachment', { asset_id: h.id('image.png'), path: 'logo.png' })).toMatchObject({ status: 'success' });
    const tester = h.tools('tester', toTester);
    expect(await tester.run('save_attachment', { asset_id: h.id('image.png'), path: 'copy.png' }))
      .toMatchObject({ status: 'refused', attachmentSave: { code: 'asset-unavailable' } });
    expect(await exists(path.join(h.root, 'copy.png'))).toBe(false);
    team.cancelPending('test cleanup');
    bus.dispose();
  });
});

describe('what the model is told', () => {
  it('lists a user request\'s attachments by id, in order, with no file names', async () => {
    const h = await hostWith([
      ['secret-plan.pdf', 'application/pdf', 'pdf', PDF],
      ['notes.md', 'text/markdown', 'file', MARKDOWN_LF],
      ['image.png', 'image/png', 'image', PNG],
      ['photo.jpg', 'image/jpeg', 'image', JPEG],
    ]);
    const note = saveableAttachmentNote(h.sources);
    // Each file is named by its kind and its place among the files of that kind, as the model receives them.
    expect(note).toBe([
      '',
      '',
      '[attachments of this request]',
      'The user attached these files to this request. To save one into the workspace exactly as attached, call save_attachment with its id; do not write a copy of it any other way. Each is kept for 30 minutes after it was attached.',
      `- ${h.id('notes.md')}: text file 1 of 1, ${MARKDOWN_LF.length} bytes`,
      `- ${h.id('secret-plan.pdf')}: PDF 1 of 1, ${PDF.length} bytes`,
      `- ${h.id('image.png')}: image 1 of 2, ${PNG.length} bytes`,
      `- ${h.id('photo.jpg')}: image 2 of 2, ${JPEG.length} bytes`,
    ].join('\n'));
    expect(note).not.toMatch(/secret-plan|notes\.md|image\.png|photo\.jpg/);
    expect(saveableAttachmentNote(h.sources.filter((source) => source.kind !== 'user-attachment'))).toBe('');
    expect(saveableAttachmentNote(undefined)).toBe('');
  });

  it('advertises exactly { asset_id, path } only to an agent that may write', async () => {
    const h = await hostWith([]);
    const spec = h.agent().specs().find((candidate) => candidate.function.name === 'save_attachment');
    expect(spec?.function.description).toBe(SAVE_ATTACHMENT_DESCRIPTION);
    expect(spec?.function.parameters).toEqual({
      type: 'object',
      properties: { asset_id: expect.any(Object), path: expect.any(Object) },
      required: ['asset_id', 'path'],
    });
    const { WorkspaceTools: Tools } = await import('../WorkspaceTools');
    const reader = new Tools(h.root, new Set(['read']), 'reader', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, new ContentAssetStore());
    expect(reader.specs().map((candidate) => candidate.function.name)).not.toContain('save_attachment');
    expect(await reader.run('save_attachment', { asset_id: 'content-1', path: 'x.png' })).toMatchObject({ status: 'refused', reason: 'capability' });
  });
});
