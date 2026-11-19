/*
 * v0.9.99: a file the person attaches in the chat composer reaches the agent whole, however large. The composer hands
 * the file to the host in pieces as soon as it is added; the host keeps it on disk and the send names it, so no whole
 * file crosses the chat view in one message and no fixed size refuses it. Everything here runs the real composer
 * script (drop, Send) over the real ChatViewProvider message handler, then the real admission into the content store
 * and its paged reads, on synthetic files: a text file of 10 MiB + 1 byte and a PDF past 10 MiB.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';

vi.mock('vscode', () => ({}));

import { ChatViewProvider, type ChatViewDeps } from '../ChatViewProvider';
import { AttachmentStaging } from '../attachmentStaging';
import { bootWebviewScript, type WebviewElement } from './support/webviewBoot';
import { CONTENT_ASSET_MAX_BYTES, CONTENT_ASSET_MAX_PAGE_TEXT, ContentAssetStore } from '../../content/ContentAssetStore';
import { userTurnSources } from '../../host/orchestration/OrchestrationHostAdapter';
import { composeUserTextAttachments, splitUserAttachments } from '../../attachments';
import type { UserAttachment } from '../../types';
import { prepareAndSubmit, STOPPED_BEFORE_SENDING, stopPreparing, UserRequestPreparations } from '../../host/userRequestPreparations';

const OLD_CUT = 10 * 1024 * 1024;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** What the page forwards from the host: the replies the composer acts on. */
const PAGE_COMMANDS = new Set(['attachmentChunkAck', 'sendAccepted', 'sendRejected', 'sendWaitingStopped']);

/** One chat composer page over one real host, joined like VS Code joins them, with the host's transcript. */
function composerOverHost(options: { staging?: AttachmentStaging; deps?: Partial<ChatViewDeps> } = {}) {
  const send = vi.fn();
  const store = new Map<string, unknown>();
  const deps = {
    listAgents: () => [
      { id: 'dev', name: 'Dev', role: 'Developer', backend: 'openai' },
      { id: 'other', name: 'Other', role: 'Developer', backend: 'openai' },
    ],
    send, interject: vi.fn(), interrupt: vi.fn(), onReply: () => vi.fn(),
    state: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
    ...(options.staging ? { attachmentStaging: options.staging } : {}),
    ...options.deps,
  } as unknown as ChatViewDeps;
  const provider = new ChatViewProvider({} as never, deps);
  cleanups.push(() => provider.dispose());
  provider.selectAgent('dev');
  let hostListener: ((message: unknown) => void) | undefined;
  // Set once the page boots; the host may post before that, and those posts are not the page's.
  const booted: { page?: ReturnType<typeof bootWebviewScript> } = {};
  const hostPosts: any[] = [];
  // While held, what the host posts to the page waits, in order, until it is released.
  const forPage: { held: boolean; queue: any[] } = { held: false, queue: [] };
  const toPage = (message: any) => {
    for (const listener of booted.page!.listeners.message ?? []) listener({ data: message });
  };
  const view = {
    visible: true,
    webview: {
      cspSource: 'test:', html: '', options: {},
      postMessage: (message: any) => {
        hostPosts.push(message);
        if (booted.page && PAGE_COMMANDS.has(message?.command)) {
          if (forPage.held) forPage.queue.push(message);
          else toPage(message);
        }
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (listener: (message: unknown) => void) => { hostListener = listener; return { dispose() {} }; },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };
  provider.resolveWebviewView(view as never);
  const page = bootWebviewScript(view.webview.html);
  booted.page = page;
  let delivered = 0;
  /** Deliver what the page posted, in order, until `done` holds; the page's file reads and waits run in between. */
  async function settle(done: () => boolean): Promise<void> {
    for (let round = 0; round < 20_000 && !done(); round++) {
      while (delivered < page.postedMessages.length) hostListener!(page.postedMessages[delivered++]);
      await new Promise((resolve) => setImmediate(resolve));
    }
    while (delivered < page.postedMessages.length) hostListener!(page.postedMessages[delivered++]);
    if (!done()) throw new Error('the composer and the host did not settle');
  }
  const element = (id: string) => page.elements.get(id) as WebviewElement;
  /** Let the page run its own work, delivering nothing to the host, until it has posted nothing new for a while. */
  async function idle(): Promise<void> {
    let seen = -1;
    for (let round = 0, quiet = 0; round < 20_000 && quiet < 100; round++) {
      await new Promise((resolve) => setImmediate(resolve));
      quiet = page.postedMessages.length === seen ? quiet + 1 : 0;
      seen = page.postedMessages.length;
    }
  }
  /** Like settle, but stop before delivering the first message of `command` the page posts; it stays on its way. */
  async function settleBefore(command: string): Promise<void> {
    for (let round = 0; round < 20_000; round++) {
      while (delivered < page.postedMessages.length) {
        if ((page.postedMessages[delivered] as { command?: string })?.command === command) return;
        hostListener!(page.postedMessages[delivered++]);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`the page never posted ${command}`);
  }
  /** Deliver to the host only what the page has posted so far; the host answers at once. */
  function deliverPosted(): void {
    const upTo = page.postedMessages.length;
    while (delivered < upTo) hostListener!(page.postedMessages[delivered++]);
  }
  return {
    provider, send, page, hostPosts, settle, settleBefore, element, idle, deliverPosted,
    /** Hold what the host posts to the page from now on. */
    holdForPage() { forPage.held = true; },
    /** Deliver the next held host message to the page; undefined when none is held. */
    releaseNextForPage(): any {
      const message = forPage.queue.shift();
      if (message) toPage(message);
      return message;
    },
    /** Deliver the next message the page posted to the host; undefined when none is waiting. */
    deliverNext(): any {
      if (delivered >= page.postedMessages.length) return undefined;
      const message = page.postedMessages[delivered++];
      hostListener!(message);
      return message;
    },
    /** Deliver `count` held host messages to the page, in order; with no count, all of them, and stop holding. */
    releaseForPage(count = Number.POSITIVE_INFINITY) {
      for (let n = 0; n < count && forPage.queue.length > 0; n++) toPage(forPage.queue.shift());
      if (count === Number.POSITIVE_INFINITY) forPage.held = false;
    },
    /** The person drops files on the composer. */
    drop(files: File[]) {
      page.dispatchElementEvent(element('composer'), 'drop', { preventDefault() {}, dataTransfer: { files } });
    },
    /** The person types a message and presses Send. */
    pressSend(text: string) {
      element('input').value = text;
      page.dispatchElementEvent(element('send'), 'click');
    },
    transcriptNotices(): string[] {
      const history = (provider as any).loadHistory('dev');
      return (history as Array<{ runtimeNotice?: boolean; text: string }>).filter((item) => item.runtimeNotice).map((item) => item.text);
    },
  };
}

/** A real two-page PDF past 10 MiB: incompressible padding first, then both pages, written after the old cut. */
async function pdfPastTheOldCut(): Promise<Buffer> {
  const document = await PDFDocument.create();
  // The padding is the first object written, so every page's content comes after it in the file.
  document.context.register(document.context.stream(randomBytes(OLD_CUT + 512 * 1024)));
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage([200, 200]).drawText('Synthetic page 1', { x: 20, y: 100, size: 12, font });
  document.addPage([200, 200]).drawText('Synthetic page 2 after the old cut', { x: 10, y: 100, size: 10, font });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

function bytesOf(attachment: UserAttachment): Buffer {
  return Buffer.from(attachment.dataBase64, 'base64');
}

describe('the chat composer attaches files past the former 8 and 10 MiB limits', () => {
  it('sends a 10 MiB + 1 byte text file and a PDF past 10 MiB whole, and the agent reads both past the old cut', async () => {
    const text = Buffer.concat([Buffer.alloc(OLD_CUT - 4, 0x61), Buffer.from('TAIL'), Buffer.from('!')]);
    expect(text.byteLength).toBe(OLD_CUT + 1);
    const pdf = await pdfPastTheOldCut();
    expect(pdf.byteLength).toBeGreaterThan(OLD_CUT);
    expect(pdf.lastIndexOf(Buffer.from('/Contents'))).toBeGreaterThan(OLD_CUT);

    const chat = composerOverHost();
    chat.drop([new File([text], 'ordinary.txt', { type: 'text/plain' }), new File([pdf], 'brief.pdf', { type: 'application/pdf' })]);
    chat.pressSend('Read both files.');
    await chat.settle(() => chat.send.mock.calls.length > 0);

    // No piece of a file, and no message, carried a whole file across the chat view.
    const largest = Math.max(...chat.page.postedMessages.map((message) => JSON.stringify(message).length));
    expect(largest).toBeLessThan(2 * 1024 * 1024);
    expect(chat.element('attachmentStatus').textContent).toBe('');

    const [agentId, sentText, , attachments] = chat.send.mock.calls[0] as [string, string, string, UserAttachment[]];
    expect([agentId, sentText]).toEqual(['dev', 'Read both files.']);
    expect(attachments.map((attachment) => [attachment.name, attachment.kind, attachment.size])).toEqual([
      ['ordinary.txt', 'file', OLD_CUT + 1], ['brief.pdf', 'pdf', pdf.byteLength],
    ]);
    expect(bytesOf(attachments[0]).equals(text)).toBe(true);
    expect(bytesOf(attachments[1]).equals(pdf)).toBe(true);
    expect(chat.transcriptNotices()).toEqual([]);

    // The host's admission of the turn (extension.ts send) keeps both whole, and the paged readers reach past the cut.
    const store = new ContentAssetStore();
    cleanups.push(() => store.dispose());
    const { delegationContentSources } = await userTurnSources(store, { text: sentText, expanded: sentText, mentions: [], userAttachments: attachments });
    const [textSource, pdfSource] = delegationContentSources.filter((source) => source.kind === 'user-attachment');
    const keptText = await store.readUserAttachment(textSource.assetId);
    expect(keptText.status === 'ready' && keptText.bytes.equals(text)).toBe(true);
    const keptPdf = await store.readUserAttachment(pdfSource.assetId);
    expect(keptPdf.status === 'ready' && keptPdf.bytes.equals(pdf)).toBe(true);

    // The turn inlines the start of the text file and names the exact read of the rest; its last page holds the tail.
    const composed = composeUserTextAttachments(attachments).text;
    expect(composed).toContain(`read_extracted_content({ assetId: "${textSource.assetId}"`);
    const whole = await store.readExtractedContent(textSource.assetId, { start: 1, end: 1 });
    const total = 'pages' in whole ? whole.pages.total : 0;
    expect(total).toBeGreaterThan(Math.floor(OLD_CUT / CONTENT_ASSET_MAX_PAGE_TEXT));
    const last = await store.readExtractedContent(textSource.assetId, { start: total, end: total });
    expect('items' in last && last.items[0].text).toContain('TAIL!');

    // The PDF's second page, written after the old 10 MiB cut, is extracted by the real PDF worker.
    const page2 = await store.readExtractedContent(pdfSource.assetId, { start: 2, end: 2 });
    expect('items' in page2 && page2.items.map((item) => item.text).join(' ')).toContain('Synthetic page 2 after the old cut');
    expect(CONTENT_ASSET_MAX_BYTES).toBe(OLD_CUT);
  }, 120_000);
});

/** The page's chips: name, and whether the file is still being handed over. */
function chipsOf(chat: ReturnType<typeof composerOverHost>): Array<{ name: string; size: string; remove: WebviewElement }> {
  const chips = (chat.element('attachmentChips').children as WebviewElement[]) ?? [];
  return chips.map((chip) => {
    const parts = chip.children as WebviewElement[];
    return { name: String(parts[1].textContent), size: String(parts[2].textContent), remove: parts[3] };
  });
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('the composer and host around a large attachment', () => {
  it('sends an image too large for one model request, keeps it, names it to the model and tells the person', async () => {
    const big = Buffer.concat([PNG_SIGNATURE, randomBytes(OLD_CUT + 1024)]);
    const chat = composerOverHost();
    chat.drop([new File([big], 'photo.png', { type: 'image/png' })]);
    // Send at once, while the picture is still being previewed and handed over: it waits, then carries the image.
    chat.pressSend('What is in the photo?');
    await chat.settle(() => chat.send.mock.calls.length > 0);
    const attachments = chat.send.mock.calls[0][3] as UserAttachment[];
    expect(attachments.map((attachment) => [attachment.name, attachment.kind, attachment.size])).toEqual([['photo.png', 'image', big.byteLength]]);
    // Never put into a model request; named instead.
    expect(splitUserAttachments(attachments).images).toEqual([]);
    expect(chat.transcriptNotices()).toEqual([
      'photo.png (10.0 MB) was sent, but the agent cannot see it: an image goes to the model whole, in one request, and this one '
        + 'is larger than the 10.0 MB that allows. The agent was told, and can save the file into the workspace to work on it.',
    ]);
    const store = new ContentAssetStore();
    cleanups.push(() => store.dispose());
    const { delegationContentSources } = await userTurnSources(store, { text: 'x', expanded: 'x', mentions: [], userAttachments: attachments });
    const kept = delegationContentSources.find((source) => source.mediaKind === 'image')!;
    const read = await store.readUserAttachment(kept.assetId);
    expect(read.status === 'ready' && read.bytes.equals(big)).toBe(true);
    expect(await store.imageForVision(kept.assetId)).toEqual({ error: 'unsupported' });
    expect(composeUserTextAttachments(attachments).text).toContain(`save_attachment({ asset_id: "${kept.assetId}", path })`);
  });

  it('names a file larger than one file may take in memory for that file alone, and sends the others', async () => {
    const staging = new AttachmentStaging({ memoryBudget: () => 5 * 1024 * 1024 });
    const chat = composerOverHost({ staging });
    chat.drop([new File([Buffer.alloc(6 * 1024 * 1024, 0x61)], 'big.txt', { type: 'text/plain' }), new File(['small'], 'small.txt', { type: 'text/plain' })]);
    await chat.settle(() => chipsOf(chat).length === 1 && !chipsOf(chat)[0].size.includes('attaching'));
    expect(chat.element('attachmentStatus').textContent).toBe('big.txt was not attached: at 6.0 MB it is more than this VS Code window can hold '
      + 'in memory for one file (about 5.0 MB). Save it in the workspace folder and ask the agent to work on it there.');
    // The host answered the first piece: no more of the large file was sent, and nothing of it was kept.
    expect(chat.page.postedMessages.filter((message: any) => message.command === 'attachmentChunk' && message.total === 6 * 1024 * 1024)).toHaveLength(1);
    expect(staging.heldCount()).toBe(1);
    chat.pressSend('Read it.');
    await chat.settle(() => chat.send.mock.calls.length > 0);
    expect((chat.send.mock.calls[0][3] as UserAttachment[]).map((attachment) => attachment.name)).toEqual(['small.txt']);
    expect(staging.heldCount()).toBe(0);
  });

  it('waits for the host to take the first piece, then keeps at most four pieces waiting, sending more as the host acknowledges them', async () => {
    const chat = composerOverHost();
    chat.drop([new File([Buffer.alloc(10 * 1024 * 1024, 0x62)], 'ten.txt', { type: 'text/plain' })]);
    const pieces = () => chat.page.postedMessages.filter((message: any) => message.command === 'attachmentChunk');
    await chat.idle();
    expect(pieces().map((message: any) => message.index)).toEqual([0]);
    chat.deliverPosted();
    await chat.idle();
    expect(pieces().map((message: any) => message.index)).toEqual([0, 1, 2, 3, 4]);
    chat.deliverPosted();
    await chat.idle();
    expect(pieces().map((message: any) => message.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    await chat.settle(() => pieces().length === 10 && !chipsOf(chat)[0].size.includes('attaching'));
    expect(pieces().map((message: any) => message.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('names the first reason a file stopped part way, though the pieces already on their way then fail too', async () => {
    // The disk fills while the third piece is written: the host lets go of the upload, so the pieces after it fail.
    class DiskFillsUp extends AttachmentStaging {
      override append(scope: string, uploadId: string, index: number, total: number, data: Buffer) {
        if (index !== 2) return super.append(scope, uploadId, index, total, data);
        this.discard(scope, uploadId);
        return { ok: false as const, reason: "there is no room left on the disk for UnodeAi's temporary copy. Free some space and attach it again" };
      }
    }
    const staging = new DiskFillsUp();
    const chat = composerOverHost({ staging });
    chat.drop([new File([Buffer.alloc(8 * 1024 * 1024, 0x64)], 'eight.txt', { type: 'text/plain' })]);
    await chat.settle(() => chipsOf(chat).length === 0);
    expect(chat.element('attachmentStatus').textContent).toBe('eight.txt was not attached: there is no room left on the disk for '
      + "UnodeAi's temporary copy. Free some space and attach it again.");
    expect(staging.heldCount()).toBe(0);
  });

  it('waits on Send for a file still being handed over, then sends it with the message', async () => {
    const chat = composerOverHost();
    chat.drop([new File([Buffer.alloc(3 * 1024 * 1024, 0x63)], 'notes.txt', { type: 'text/plain' })]);
    chat.pressSend('Now.');
    expect(chat.element('sendStatus').textContent).toBe('Attaching notes.txt… Your message is sent as soon as they are attached.');
    expect(chat.page.postedMessages.some((message: any) => message.command === 'send')).toBe(false);
    await chat.settle(() => chat.send.mock.calls.length > 0);
    expect((chat.send.mock.calls[0][3] as UserAttachment[]).map((attachment) => attachment.size)).toEqual([3 * 1024 * 1024]);
  });

  // v0.9.99 (audit I1): what was sent at the click is what goes, to the agent chosen then. A later agent switch and a
  // new draft stay a draft; nothing is sent to the other agent.
  it('sends the clicked message to the agent chosen at the click, though the person switches agent and types meanwhile', async () => {
    const chat = composerOverHost();
    chat.element('agent').value = 'dev';
    chat.drop([new File([Buffer.alloc(3 * 1024 * 1024, 0x63)], 'notes.txt', { type: 'text/plain' })]);
    chat.pressSend('Message A for Dev.');
    expect(chat.page.postedMessages.some((message: any) => message.command === 'send')).toBe(false);
    // While the file is still being handed over: another agent, another draft, no second Send.
    chat.element('agent').value = 'other';
    chat.page.dispatchElementEvent(chat.element('agent'), 'change');
    chat.element('input').value = 'Draft B, not finished.';
    await chat.settle(() => chat.send.mock.calls.length > 0);
    expect(chat.send.mock.calls).toHaveLength(1);
    expect(chat.send.mock.calls[0][0]).toBe('dev');
    expect(chat.send.mock.calls[0][1]).toBe('Message A for Dev.');
    expect((chat.send.mock.calls[0][3] as UserAttachment[]).map((attachment) => attachment.name)).toEqual(['notes.txt']);
    expect(chat.element('input').value).toBe('Draft B, not finished.');
  });

  it('a file added while a message waits stays for the next message when the first is accepted', async () => {
    const chat = composerOverHost();
    chat.drop([new File([Buffer.alloc(3 * 1024 * 1024, 0x63)], 'first.txt', { type: 'text/plain' })]);
    chat.pressSend('With the first file.');
    chat.drop([new File(['later'], 'later.txt', { type: 'text/plain' })]);
    await chat.settle(() => chat.send.mock.calls.length > 0);
    await chat.idle();
    expect((chat.send.mock.calls[0][3] as UserAttachment[]).map((attachment) => attachment.name)).toEqual(['first.txt']);
    expect(chipsOf(chat).map((chip) => chip.name)).toEqual(['later.txt']);
  });

  it('a second Send while the first still waits for its files says so and sends nothing new', async () => {
    const chat = composerOverHost();
    chat.drop([new File([Buffer.alloc(3 * 1024 * 1024, 0x63)], 'notes.txt', { type: 'text/plain' })]);
    chat.pressSend('First.');
    chat.pressSend('Second.');
    expect(chat.element('sendStatus').textContent).toBe('Your previous message is still being attached. Send this one after it has gone.');
    await chat.settle(() => chat.send.mock.calls.length > 0);
    await chat.idle();
    expect(chat.send.mock.calls.map((call) => call[1])).toEqual(['First.']);
  });

  it('a file removed while its message waits is not sent; the message goes with the rest', async () => {
    const staging = new AttachmentStaging();
    const chat = composerOverHost({ staging });
    chat.drop([new File(['keep'], 'keep.txt', { type: 'text/plain' }), new File([Buffer.alloc(3 * 1024 * 1024, 0x61)], 'big.txt', { type: 'text/plain' })]);
    chat.pressSend('Keep only one.');
    chat.page.dispatchElementEvent(chipsOf(chat).find((chip) => chip.name === 'big.txt')!.remove, 'click');
    await chat.settle(() => chat.send.mock.calls.length > 0);
    expect((chat.send.mock.calls[0][3] as UserAttachment[]).map((attachment) => attachment.name)).toEqual(['keep.txt']);
    // The removed file is not named to the host at all, so no "no longer has the copy" notice appears.
    expect(chat.transcriptNotices()).toEqual([]);
  });

  it('text typed after the click stays as the draft when the waiting message is accepted', async () => {
    const chat = composerOverHost();
    chat.drop([new File([Buffer.alloc(3 * 1024 * 1024, 0x63)], 'notes.txt', { type: 'text/plain' })]);
    chat.pressSend('Sent part.');
    chat.element('input').value = 'Sent part. And a new thought.';
    chat.page.dispatchElementEvent(chat.element('input'), 'input');
    await chat.settle(() => chat.send.mock.calls.length > 0);
    await chat.idle();
    expect(chat.send.mock.calls[0][1]).toBe('Sent part.');
    expect(chat.element('input').value).toBe('Sent part. And a new thought.');
  });

  it('lets go of the host\'s copy when the person removes the file before sending', async () => {
    const staging = new AttachmentStaging();
    const chat = composerOverHost({ staging });
    chat.drop([new File(['keep'], 'keep.txt', { type: 'text/plain' }), new File(['drop'], 'drop.txt', { type: 'text/plain' })]);
    await chat.settle(() => staging.heldCount() === 2 && chipsOf(chat).every((chip) => !chip.size.includes('attaching')));
    chat.page.dispatchElementEvent(chipsOf(chat).find((chip) => chip.name === 'drop.txt')!.remove, 'click');
    await chat.settle(() => staging.heldCount() === 1);
    chat.pressSend('One file.');
    await chat.settle(() => chat.send.mock.calls.length > 0);
    expect((chat.send.mock.calls[0][3] as UserAttachment[]).map((attachment) => attachment.name)).toEqual(['keep.txt']);
  });

  it('hands its files over again to a restarted extension host, so Send still carries them', async () => {
    const staging = new AttachmentStaging();
    const chat = composerOverHost({ staging });
    chat.drop([new File(['survives'], 'survives.txt', { type: 'text/plain' })]);
    await chat.settle(() => staging.heldCount() === 1 && !chipsOf(chat)[0].size.includes('attaching'));
    // The host restarted: it holds none of the files, and its state names another instance.
    staging.discardScope('sidebar');
    const state = (chat.provider as any).currentState();
    for (const listener of chat.page.listeners.message ?? []) {
      listener({ data: { command: 'state', announce: false, state: { ...state, hostInstanceId: 'restarted-host' } } });
    }
    await chat.settle(() => staging.heldCount() === 1 && !chipsOf(chat)[0].size.includes('attaching'));
    chat.pressSend('Still there?');
    await chat.settle(() => chat.send.mock.calls.length > 0);
    const [attachment] = chat.send.mock.calls[0][3] as UserAttachment[];
    expect(Buffer.from(attachment.dataBase64, 'base64').toString('utf8')).toBe('survives');
    expect(chat.transcriptNotices()).toEqual([]);
  });

  it('a send waiting for its file when the host restarts waits for the file to be handed over again, then sends it whole', async () => {
    const staging = new AttachmentStaging();
    const chat = composerOverHost({ staging });
    chat.drop([new File([Buffer.alloc(3 * 1024 * 1024, 0x72)], 'restart.txt', { type: 'text/plain' })]);
    chat.pressSend('Across a restart.');
    // The first piece reaches the host, then the host restarts with none of the file.
    await chat.idle();
    chat.deliverPosted();
    await chat.idle();
    staging.discardScope('sidebar');
    const state = (chat.provider as any).currentState();
    for (const listener of chat.page.listeners.message ?? []) {
      listener({ data: { command: 'state', announce: false, state: { ...state, hostInstanceId: 'restarted-host' } } });
    }
    await chat.settle(() => chat.send.mock.calls.length > 0);
    const [attachment] = chat.send.mock.calls[0][3] as UserAttachment[];
    expect(attachment.size).toBe(3 * 1024 * 1024);
    expect(chat.transcriptNotices()).toEqual([]);
  });

  it('takes a send\'s staged file only from the chat view that handed it over, and names one it does not have', () => {
    const staging = new AttachmentStaging();
    const chat = composerOverHost({ staging });
    staging.append('sidebar', 'up-elsewhere', 0, 2, Buffer.from('hi'));
    (chat.provider as any).onMessage({
      command: 'send', requestId: 'send-w', agentId: 'dev', text: 'From the Workbench.',
      attachments: [{ name: 'other.txt', mime: 'text/plain', kind: 'file', size: 2, uploadId: 'up-elsewhere' }],
    }, 'workbench');
    expect(chat.send.mock.calls[0][3]).toEqual([]);
    expect(chat.transcriptNotices()).toEqual(['other.txt was not sent: UnodeAi no longer has the copy this chat received. Attach it again.']);
    expect(staging.completeSize('sidebar', 'up-elsewhere')).toBe(2);
  });

  it('tells the person that a message to a working agent carried its text only, and lets go of its files', () => {
    const staging = new AttachmentStaging();
    const chat = composerOverHost({ staging });
    staging.append('sidebar', 'up-1', 0, 2, Buffer.from('hi'));
    (chat.provider as any).runningAgentIds.add('dev');
    (chat.provider as any).onMessage({
      command: 'send', requestId: 'send-s', agentId: 'dev', text: 'Also look at this.',
      attachments: [{ name: 'late.txt', mime: 'text/plain', kind: 'file', size: 2, uploadId: 'up-1' }],
    }, 'sidebar');
    expect(chat.transcriptNotices()).toEqual(['late.txt was not sent: a message to an agent that is working carries its text only. '
      + 'Attach the files to your next message.']);
    expect(staging.heldCount()).toBe(0);
  });
});

describe('files that together exceed what the window can safely hold at once', () => {
  const MiB = 1024 * 1024;
  const warning = (lead: string, total: string) => `${lead} are ${total} together, more than this VS Code window can safely hold at once `
    + '(about 5.0 MB). Sending them in one message may make UnodeAi run out of memory. To be safe, send them in separate messages, '
    + 'or save them in the workspace folder and ask the agent to work on them there.';
  const threeFiles = () => ['a.txt', 'b.txt', 'c.txt'].map((name, index) => new File([Buffer.alloc(2 * MiB, 0x61 + index)], name, { type: 'text/plain' }));

  it('warns in the composer while the files are too large together, and stops when a removal makes them fit', async () => {
    const staging = new AttachmentStaging({ memoryBudget: () => 5 * MiB });
    const chat = composerOverHost({ staging });
    const shown = () => (chat.element('attachmentWarning').hidden ? '' : String(chat.element('attachmentWarning').textContent));
    expect(shown()).toBe('');
    chat.drop(threeFiles());
    await chat.settle(() => staging.heldCount() === 3 && chipsOf(chat).every((chip) => !chip.size.includes('attaching')));
    expect(shown()).toBe(warning('These files', '6.0 MB'));
    chat.page.dispatchElementEvent(chipsOf(chat).find((chip) => chip.name === 'c.txt')!.remove, 'click');
    expect(shown()).toBe('');
    chat.pressSend('Two files.');
    await chat.settle(() => chat.send.mock.calls.length > 0);
    expect((chat.send.mock.calls[0][3] as UserAttachment[]).map((attachment) => attachment.name)).toEqual(['a.txt', 'b.txt']);
    expect(chat.transcriptNotices()).toEqual([]);
  });

  it('never stops Send: the files all go, and the transcript records the warning once', async () => {
    const staging = new AttachmentStaging({ memoryBudget: () => 5 * MiB });
    const chat = composerOverHost({ staging });
    chat.drop(threeFiles());
    chat.pressSend('All three.');
    await chat.settle(() => chat.send.mock.calls.length > 0);
    expect(chat.send).toHaveBeenCalledTimes(1);
    expect((chat.send.mock.calls[0][3] as UserAttachment[]).map((attachment) => [attachment.name, attachment.size])).toEqual([
      ['a.txt', 2 * MiB], ['b.txt', 2 * MiB], ['c.txt', 2 * MiB],
    ]);
    expect(chat.hostPosts.some((message) => message.command === 'sendRejected')).toBe(false);
    expect(chat.transcriptNotices()).toEqual([warning('The files of this message', '6.0 MB')]);
    // Sent: the composer has no files left, and no warning.
    expect(chat.element('attachmentWarning').hidden).toBe(true);
  });

  it('says nothing for files that fit together, or for one file', async () => {
    const staging = new AttachmentStaging({ memoryBudget: () => 5 * MiB });
    const chat = composerOverHost({ staging });
    chat.drop([new File([Buffer.alloc(2 * MiB)], 'a.txt', { type: 'text/plain' }), new File([Buffer.alloc(3 * MiB)], 'b.txt', { type: 'text/plain' })]);
    await chat.settle(() => staging.heldCount() === 2 && chipsOf(chat).every((chip) => !chip.size.includes('attaching')));
    expect(chat.element('attachmentWarning').hidden).toBe(true);
    chat.pressSend('Exactly at the budget.');
    await chat.settle(() => chat.send.mock.calls.length > 0);
    expect(chat.transcriptNotices()).toEqual([]);
  });

  it('gives the composer the same budget the host uses for one file', () => {
    const staging = new AttachmentStaging({ memoryBudget: () => 7 * MiB });
    const chat = composerOverHost({ staging });
    expect((chat.provider as any).currentState().attachmentMemoryBudget).toBe(7 * MiB);
  });
});

// v0.9.99 (audit of 2046df43, I1): a Send pressed while its files are still being attached is a message being prepared
// from the click. The host learns of it at once, so a Stop of the person ends it before it reaches the host: nothing is
// sent when the files arrive, the chat says so, and the text and files stay for a deliberate resend. The extension's own
// Stop All, agent Stop and preparation wiring are taken unchanged from extension.ts.
describe('a Stop ends a Send still waiting for its files', () => {
  const extension = readFileSync(path.join(__dirname, '..', '..', 'extension.ts'), 'utf8');
  const js = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  function extensionSlice(from: string, to: string): string {
    const start = extension.indexOf(from);
    expect(start, from).toBeGreaterThan(0);
    return extension.slice(start, extension.indexOf(to, start));
  }

  function stoppableComposer() {
    const preparations = new UserRequestPreparations();
    const beginPreparation = new Function('userRequestPreparations',
      js(`return (${extensionSlice('beginPreparation: ', ',\n').slice('beginPreparation: '.length)});`))(preparations);
    const chat = composerOverHost({ deps: {
      beginPreparation,
      retirePreparing: (agentId: string) => preparations.cancel(agentId) > 0,
    } });
    // The host's send callback prepares through the same tracker; what it submits is recorded.
    const submitted: Array<{ agentId: string; text: string; files: string[] }> = [];
    chat.send.mockImplementation((agentId: string, text: string, _mode: unknown, attachments: UserAttachment[] = []) => prepareAndSubmit(
      preparations, agentId, { prepare: async () => undefined, submit: () => { submitted.push({ agentId, text, files: attachments.map((a) => a.name) }); } },
    ));
    const stopPreparingMessages = new Function('stopPreparing', 'userRequestPreparations', 'chatViewProvider',
      js(`${extensionSlice('const stopPreparingMessages =', '\n\n')}\nreturn stopPreparingMessages;`))(stopPreparing, preparations, chat.provider);
    const commands = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const sessionManager = { stopAll: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), getAll: () => [] };
    for (const name of ['unode.stopAllAgents', 'unode.agentStop']) {
      new Function('reg', 'guard', 'sessionManager', 'stopPreparingMessages', 'userRequestPreparations', 'isE2EFixtureRequest',
        'extensionContext', 'showResultNotice', js(`${extensionSlice(`reg('${name}',`, '\n  }));')}\n  }));`))(
        (_name: string, run: (...args: unknown[]) => Promise<unknown>) => { commands.set(name, run); },
        (run: () => unknown) => run(), sessionManager, stopPreparingMessages, preparations, () => true, undefined, () => {},
      );
    }
    return { chat, preparations, submitted, sessionManager, stopAll: commands.get('unode.stopAllAgents')!, agentStop: commands.get('unode.agentStop')! };
  }

  const bigFile = () => new File([Buffer.alloc(3 * 1024 * 1024, 0x61)], 'notes.txt', { type: 'text/plain' });
  const STOPPED_HERE = 'You stopped this message before it was sent. Its text and files are still here; send it again when you want it.';

  it.each([
    ['Stop All Agents', (c: ReturnType<typeof stoppableComposer>) => c.stopAll()],
    ['the agent\'s Stop', (c: ReturnType<typeof stoppableComposer>) => c.agentStop('dev')],
  ])('%s while the files attach: nothing is sent when they arrive, the chat says so, and the message can be sent again', async (_label, stop) => {
    const c = stoppableComposer();
    c.chat.drop([bigFile()]);
    c.chat.pressSend('Read the attached file.');
    expect(c.chat.element('sendStatus').textContent).toContain('Attaching');
    // The click reaches the host before the files do: the message is being prepared from then.
    c.chat.deliverPosted();
    expect(c.preparations.agents()).toEqual(['dev']);
    await stop(c);
    expect(c.chat.element('sendStatus').textContent).toBe(STOPPED_HERE);
    // The files finish attaching; the message stays unsent.
    await c.chat.settle(() => chipsOf(c.chat).length === 1 && !chipsOf(c.chat)[0].size.includes('attaching'));
    await c.chat.idle();
    c.chat.deliverPosted();
    expect(c.chat.send).not.toHaveBeenCalled();
    expect(c.submitted).toEqual([]);
    expect(c.preparations.agents()).toEqual([]);
    // The page tells the host the waiting Send is over, so the host holds nothing more of it.
    expect((c.chat.provider as any).waitingSends.size).toBe(0);
    expect(c.chat.transcriptNotices()).toEqual([STOPPED_BEFORE_SENDING]);
    // Its text and file are still in the composer; pressing Send again sends them.
    expect(c.chat.element('input').value).toBe('Read the attached file.');
    c.chat.pressSend(c.chat.element('input').value);
    await c.chat.settle(() => c.submitted.length > 0);
    expect(c.submitted).toEqual([{ agentId: 'dev', text: 'Read the attached file.', files: ['notes.txt'] }]);
  });

  it('Stop All before the click has reached the host still ends the waiting Send', async () => {
    const c = stoppableComposer();
    c.chat.drop([bigFile()]);
    c.chat.pressSend('Read the attached file.');
    // Nothing the page posted has reached the host yet, the click's announcement included.
    expect(c.preparations.agents()).toEqual([]);
    await c.stopAll();
    expect(c.chat.element('sendStatus').textContent).toBe(STOPPED_HERE);
    await c.chat.settle(() => chipsOf(c.chat).length === 1 && !chipsOf(c.chat)[0].size.includes('attaching'));
    await c.chat.idle();
    c.chat.deliverPosted();
    expect(c.chat.send).not.toHaveBeenCalled();
    expect(c.submitted).toEqual([]);
    expect(c.preparations.agents()).toEqual([]);
    expect((c.chat.provider as any).waitingSends.size).toBe(0);
    expect(c.chat.element('input').value).toBe('Read the attached file.');
  });

  // Codex's ordering (audit of b7bdd91b): order is kept in each direction and the Stop reaches the page, but only after
  // the page has posted its send. The click notice then reaches the host after the Stop; it is not new permission.
  it('a click notice and send that reach the host after Stop All are refused, with the Stop delivered to the page in order', async () => {
    const c = stoppableComposer();
    c.chat.drop([new File(['tiny'], 'tiny.txt', { type: 'text/plain' })]);
    // The file's only piece is posted; its acknowledgement has not come back.
    await c.chat.idle();
    c.chat.pressSend('Read the attached file.');
    expect(c.chat.element('sendStatus').textContent).toContain('Attaching');
    c.chat.holdForPage();
    // The host takes the piece (its acknowledgement is held); the click notice is still on its way.
    await c.chat.settleBefore('sendWaiting');
    await c.stopAll();
    expect(c.preparations.agents()).toEqual([]);
    // The acknowledgement reaches the page: the file is attached and the page posts its send.
    c.chat.releaseForPage(1);
    await c.chat.idle();
    const posted = c.chat.page.postedMessages.map((message: any) => message.command);
    expect(posted.slice(posted.indexOf('sendWaiting'))).toEqual(['sendWaiting', 'send']);
    // Then the Stop reaches the page, and then the click notice and the send reach the host. The late click notice
    // registers nothing: it is older than the Stop.
    c.chat.releaseForPage();
    await c.chat.settleBefore('send');
    expect(c.preparations.agents()).toEqual([]);
    expect((c.chat.provider as any).waitingSends.size).toBe(0);
    c.chat.deliverPosted();
    await c.chat.idle();
    expect(c.chat.send).not.toHaveBeenCalled();
    expect(c.submitted).toEqual([]);
    expect(c.preparations.agents()).toEqual([]);
    expect((c.chat.provider as any).waitingSends.size).toBe(0);
    expect(c.chat.hostPosts.filter((message) => message.command === 'sendRejected').map((message) => message.reason)).toEqual([STOPPED_BEFORE_SENDING]);
    expect(c.chat.element('input').value).toBe('Read the attached file.');
    // A Send pressed after the page has seen the Stop is new, and goes.
    c.chat.pressSend(c.chat.element('input').value);
    await c.chat.settle(() => c.submitted.length > 0);
    expect(c.submitted).toEqual([{ agentId: 'dev', text: 'Read the attached file.', files: ['tiny.txt'] }]);
  });

  it('a plain Send that crosses Stop All on its way is refused and kept; one pressed after goes', async () => {
    const c = stoppableComposer();
    c.chat.pressSend('Hello.');
    await c.stopAll();
    c.chat.deliverPosted();
    await c.chat.idle();
    expect(c.submitted).toEqual([]);
    expect(c.chat.element('sendStatus').textContent).toBe(STOPPED_BEFORE_SENDING);
    expect(c.chat.element('input').value).toBe('Hello.');
    c.chat.pressSend('Hello.');
    await c.chat.settle(() => c.submitted.length > 0);
    expect(c.submitted).toEqual([{ agentId: 'dev', text: 'Hello.', files: [] }]);
  });

  it('a Stop of another agent does not refuse a Send that crosses it', async () => {
    const c = stoppableComposer();
    c.chat.pressSend('Hello.');
    await c.agentStop('other');
    await c.chat.settle(() => c.submitted.length > 0);
    expect(c.submitted).toEqual([{ agentId: 'dev', text: 'Hello.', files: [] }]);
  });

  it('a send already on its way when Stop All ran is refused by the host, and the draft is kept', async () => {
    const c = stoppableComposer();
    c.chat.drop([bigFile()]);
    c.chat.pressSend('Read the attached file.');
    // Everything up to the page's send reaches the host; the send itself is still on its way when Stop All runs.
    await c.chat.settleBefore('send');
    await c.stopAll();
    c.chat.deliverPosted();
    await c.chat.idle();
    expect(c.chat.send).not.toHaveBeenCalled();
    expect(c.submitted).toEqual([]);
    expect(c.chat.hostPosts.filter((message) => message.command === 'sendRejected').map((message) => message.reason)).toEqual([STOPPED_BEFORE_SENDING]);
    expect(c.chat.element('sendStatus').textContent).toBe(STOPPED_BEFORE_SENDING);
    expect(c.chat.element('input').value).toBe('Read the attached file.');
    expect(c.preparations.agents()).toEqual([]);
  });

  it('another agent\'s Stop leaves the waiting Send, which goes when its files arrive', async () => {
    const c = stoppableComposer();
    c.chat.drop([bigFile()]);
    c.chat.pressSend('Read the attached file.');
    c.chat.deliverPosted();
    await c.agentStop('other');
    await c.chat.settle(() => c.submitted.length > 0);
    expect(c.submitted).toEqual([{ agentId: 'dev', text: 'Read the attached file.', files: ['notes.txt'] }]);
    expect(c.chat.transcriptNotices()).toEqual([]);
    expect(c.preparations.agents()).toEqual([]);
  });

  it('clearing the conversation ends the waiting Send without a notice; its text stays in the composer', async () => {
    const c = stoppableComposer();
    c.chat.drop([bigFile()]);
    c.chat.pressSend('Read the attached file.');
    c.chat.deliverPosted();
    c.chat.provider.clearSelectedAgent();
    await c.chat.settle(() => chipsOf(c.chat).length === 1 && !chipsOf(c.chat)[0].size.includes('attaching'));
    await c.chat.idle();
    c.chat.deliverPosted();
    expect(c.chat.send).not.toHaveBeenCalled();
    expect(c.chat.transcriptNotices()).toEqual([]);
    expect(c.chat.element('input').value).toBe('Read the attached file.');
    expect(c.preparations.agents()).toEqual([]);
  });

  it('a waiting Send whose files are all removed ends; a later Stop finds nothing to end', async () => {
    const c = stoppableComposer();
    c.chat.drop([bigFile()]);
    c.chat.pressSend('');
    c.chat.page.dispatchElementEvent(chipsOf(c.chat)[0].remove, 'click');
    await c.chat.idle();
    c.chat.deliverPosted();
    expect(c.preparations.agents()).toEqual([]);
    await c.stopAll();
    expect(c.chat.transcriptNotices()).toEqual([]);
  });

  it('closing the chat view ends the Sends it was waiting on', () => {
    const c = stoppableComposer();
    c.chat.drop([bigFile()]);
    c.chat.pressSend('Read the attached file.');
    c.chat.deliverPosted();
    expect(c.preparations.agents()).toEqual(['dev']);
    (c.chat.provider as any).disposeSidebarView();
    expect(c.preparations.agents()).toEqual([]);
  });

  it('a restarted host is told again of a Send still waiting for its files, measured against its own Stops', async () => {
    const staging = new AttachmentStaging();
    const chat = composerOverHost({ staging });
    // The page has seen one Stop of the first host (of another agent).
    chat.provider.stopWaitingSends(['other']);
    chat.drop([bigFile()]);
    chat.pressSend('Across a restart.');
    await chat.idle();
    chat.deliverPosted();
    await chat.idle();
    const state = (chat.provider as any).currentState();
    for (const listener of chat.page.listeners.message ?? []) {
      listener({ data: { command: 'state', announce: false, state: { ...state, hostInstanceId: 'restarted-host', stopGeneration: 0 } } });
    }
    const announced = chat.page.postedMessages.filter((message: any) => message.command === 'sendWaiting');
    expect(announced).toHaveLength(2);
    expect(announced[0]).toMatchObject({ agentId: 'dev', stopSeen: 1 });
    // The restarted host has seen no Stop yet: the waiting Send is measured from its generation, not the old host's.
    expect(announced[1]).toEqual({ ...announced[0], stopSeen: 0 });
  });
});

// v0.9.99 (request lifecycle design, Codex 2026-10-27): one Send is one request. It is submitted at most once; a
// cancellation point it had not observed at the click ends it for good; an intent the host does not hold is never begun
// afresh; a cancellation of one agent leaves another's alone; a Send after the composer observed the point goes.
describe('one Send is one request: cancellation is final and nothing begins it again', () => {
  const extension = readFileSync(path.join(__dirname, '..', '..', 'extension.ts'), 'utf8');
  const js = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  function wired() {
    const preparations = new UserRequestPreparations();
    const submitted: string[] = [];
    const chat = composerOverHost({ deps: {
      beginPreparation: (agentId: string) => preparations.begin(agentId),
      retirePreparing: (agentId: string) => preparations.cancel(agentId) > 0,
      // A message to an agent that is working steers it: that is its submission too.
      interject: (_agentId: string, text: string) => { submitted.push(text); },
    } });
    chat.send.mockImplementation((agentId: string, text: string) => prepareAndSubmit(
      preparations, agentId, { prepare: async () => undefined, submit: () => { submitted.push(text); } },
    ));
    const start = extension.indexOf('const stopPreparingMessages =');
    const stopPreparingMessages = new Function('stopPreparing', 'userRequestPreparations', 'chatViewProvider',
      js(`${extension.slice(start, extension.indexOf('\n\n', start))}\nreturn stopPreparingMessages;`))(stopPreparing, preparations, chat.provider);
    const hostSend = (message: Record<string, unknown>) => (chat.provider as any).onMessage(
      { command: 'send', agentId: 'dev', requestId: `r${Math.random()}`, mode: 'act', attachments: [], ...message }, 'sidebar');
    const rejections = () => chat.hostPosts.filter((message) => message.command === 'sendRejected');
    return { chat, preparations, submitted, stopPreparingMessages, hostSend, rejections };
  }

  it('a send naming an intent the host does not hold is refused, not begun as a new request', () => {
    const w = wired();
    w.hostSend({ text: 'Orphan.', intentId: 'never-announced', stopSeen: 0 });
    expect(w.chat.send).not.toHaveBeenCalled();
    expect(w.rejections().at(-1)).toMatchObject({ reason: expect.stringContaining('no longer held it ready') });
  });

  it('the same intent completes once: a repeated send of it is refused', () => {
    const w = wired();
    (w.chat.provider as any).onMessage({ command: 'sendWaiting', agentId: 'dev', intentId: 'i1', stopSeen: 0 }, 'sidebar');
    (w.chat.provider as any).onMessage({ command: 'sendWaiting', agentId: 'dev', intentId: 'i1', stopSeen: 0 }, 'sidebar');
    expect(w.preparations.pending('dev')).toBe(1);
    w.hostSend({ text: 'Once.', intentId: 'i1', stopSeen: 0 });
    w.hostSend({ text: 'Once.', intentId: 'i1', stopSeen: 0 });
    expect(w.chat.send).toHaveBeenCalledTimes(1);
    expect(w.rejections()).toHaveLength(1);
  });

  it('a send of an intent without the cancellation point its composer observed is refused', () => {
    const w = wired();
    (w.chat.provider as any).onMessage({ command: 'sendWaiting', agentId: 'dev', intentId: 'i1' }, 'sidebar');
    expect(w.chat.hostPosts.at(-1)).toMatchObject({ command: 'sendWaitingStopped', intentId: 'i1' });
    w.hostSend({ text: 'Unchecked.', intentId: 'i1' });
    expect(w.chat.send).not.toHaveBeenCalled();
  });

  it('a send of an older page with neither an intent nor an observed point is admitted as before', () => {
    const w = wired();
    w.stopPreparingMessages('all');
    w.hostSend({ text: 'From an older page.' });
    expect(w.chat.send).toHaveBeenCalledTimes(1);
  });

  it('a send and a click notice that cross a clear are not admitted, and say the conversation was cleared', () => {
    const w = wired();
    w.chat.provider.clearSelectedAgent();
    w.hostSend({ text: 'Crossed the clear.', stopSeen: 0 });
    (w.chat.provider as any).onMessage({ command: 'sendWaiting', agentId: 'dev', intentId: 'i1', stopSeen: 0 }, 'sidebar');
    expect(w.chat.send).not.toHaveBeenCalled();
    expect(w.rejections().at(-1)!.reason).toContain('The conversation was cleared before this message was sent.');
    expect(w.chat.hostPosts.at(-1)).toMatchObject({ command: 'sendWaitingStopped', intentId: 'i1', reason: expect.stringContaining('was cleared') });
    expect(w.preparations.agents()).toEqual([]);
    // Once the composer has observed the clear, a Send goes.
    w.hostSend({ text: 'After the clear.', stopSeen: (w.chat.provider as any).currentState().stopGeneration });
    expect(w.chat.send).toHaveBeenCalledTimes(1);
  });

  it('a Stop All after a Stop of the agent applies, though the composer had observed the earlier Stop', () => {
    const w = wired();
    w.stopPreparingMessages(['dev']);
    const observed = (w.chat.provider as any).currentState().stopGeneration;
    w.stopPreparingMessages('all');
    w.hostSend({ text: 'Crossed Stop All.', stopSeen: observed });
    expect(w.chat.send).not.toHaveBeenCalled();
    // And the reverse: a Stop of the agent after a Stop All the composer had observed.
    const afterAll = (w.chat.provider as any).currentState().stopGeneration;
    w.stopPreparingMessages(['dev']);
    w.hostSend({ text: 'Crossed the Stop of Dev.', stopSeen: afterAll });
    expect(w.chat.send).not.toHaveBeenCalled();
    expect(w.rejections().map((rejection) => rejection.reason)).toEqual([STOPPED_BEFORE_SENDING, STOPPED_BEFORE_SENDING]);
  });

  it('a message sent to an agent before it was removed does not reach a later agent with the same id', () => {
    const w = wired();
    w.chat.provider.clearAgent('dev');
    w.hostSend({ text: 'Written before the removal.', stopSeen: 0 });
    expect(w.chat.send).not.toHaveBeenCalled();
    expect(w.rejections().at(-1)!.reason).toContain('was removed before it was sent');
  });

  it('a refused click notice ends the wait in the composer with the reason, and keeps the message', async () => {
    const w = wired();
    w.chat.provider.clearSelectedAgent();
    // The composer has not observed the clear when Send is pressed with a file still attaching.
    w.chat.holdForPage();
    w.chat.drop([new File(['tiny'], 'tiny.txt', { type: 'text/plain' })]);
    await w.chat.idle();
    w.chat.pressSend('After a clear it had not seen.');
    w.chat.deliverPosted();
    w.chat.releaseForPage();
    await w.chat.idle();
    w.chat.deliverPosted();
    expect(w.chat.send).not.toHaveBeenCalled();
    expect(w.chat.element('sendStatus').textContent).toContain('The conversation was cleared before this message was sent.');
    expect(w.chat.element('input').value).toBe('After a clear it had not seen.');
  });

  // A small independent specification, checked against the real composer and host over seeded random interleavings.
  // Both directions keep their order; the test decides when each message moves. The test counts the Stops of Dev it has
  // issued and the Stop notices it has handed to the page, without reading either side's state. Specification: a
  // message is submitted at most once, and exactly when its send reached the host with no Stop of Dev issued that the
  // page had not been handed when Send was pressed. Stops of Other never matter to Dev.
  it.each(Array.from({ length: 24 }, (_, seed) => seed + 1))('random interleavings keep the request rules (seed %i)', async (seed) => {
    let state = seed * 2654435761 % 4294967296;
    const random = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
    const w = wired();
    w.chat.holdForPage();
    let issued = 0;
    let handed = 0;
    const intents = new Map<string, { observed: number; issuedAtSend?: number }>();
    for (let step = 0; step < 30; step++) {
      const roll = random();
      if (roll < 0.18) {
        const text = `m${seed}-${step}`;
        if (random() < 0.6) w.chat.drop([new File([`f${step}`], `f${step}.txt`, { type: 'text/plain' })]);
        await w.chat.idle();
        const before = w.chat.page.postedMessages.length;
        w.chat.pressSend(text);
        const made = w.chat.page.postedMessages.slice(before).some((message: any) => message.command === 'sendWaiting' || (message.command === 'send' && message.text === text));
        if (made) intents.set(text, { observed: handed });
      } else if (roll < 0.26) {
        w.stopPreparingMessages(['dev']); issued++;
      } else if (roll < 0.32) {
        w.stopPreparingMessages('all'); issued++;
      } else if (roll < 0.38) {
        w.stopPreparingMessages(['other']);
      } else if (roll < 0.70) {
        const next = w.chat.deliverNext();
        if (next?.command === 'send' && intents.has(next.text)) intents.get(next.text)!.issuedAtSend = issued;
      } else {
        const message = w.chat.releaseNextForPage();
        if (message?.command === 'sendWaitingStopped' && (message.all === true || message.agentIds?.includes('dev'))) handed++;
      }
      await w.chat.idle();
    }
    // Drain both directions until nothing moves.
    for (let round = 0; round < 200; round++) {
      const next = w.chat.deliverNext();
      if (next?.command === 'send' && intents.has(next.text)) intents.get(next.text)!.issuedAtSend = issued;
      const message = w.chat.releaseNextForPage();
      if (message?.command === 'sendWaitingStopped' && (message.all === true || message.agentIds?.includes('dev'))) handed++;
      await w.chat.idle();
      if (!next && !message) break;
    }
    await new Promise((resolve) => setImmediate(resolve));
    for (const text of new Set(w.submitted)) expect(w.submitted.filter((sent) => sent === text)).toHaveLength(1);
    for (const [text, intent] of intents) {
      const expected = intent.issuedAtSend !== undefined && intent.issuedAtSend === intent.observed;
      expect({ text, sent: w.submitted.includes(text) }).toEqual({ text, sent: expected });
    }
    expect(w.preparations.agents()).toEqual([]);
  });
});
