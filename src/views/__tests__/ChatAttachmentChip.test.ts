/*
 * v0.9.97 P5: the chip of a file the person attached, in the bubble of their message. Handoff §5: "the image history
 * chip uses the existing thumbnail first, then the current dataUrl; with neither it is IMG, never TXT; never put
 * full-size bytes into history to fix the chip". P0 lead B finding 5: `renderAttachmentChip` showed a picture only
 * when `attachment.dataUrl` existed, which host state never carries, so a sent image read TXT.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  ViewColumn: { One: 1, Active: 1 },
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn(),
  },
}));

import { ChatViewProvider } from '../ChatViewProvider';
import { chatHistoryKey } from '../chatHistory';
import { bootWebviewScript, type WebviewElement } from './support/webviewBoot';

/** A real 1x1 PNG: the bytes the person attached. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** The small preview the composer made of it. */
const THUMBNAIL = 'data:image/webp;base64,UklGRhYAAABXRUJQVlA4IAoAAAAwAQCdASoBAAEAAA==';

function chatOn(store: Map<string, unknown>, send = vi.fn()): ChatViewProvider {
  return new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm' }],
    send, interject: vi.fn(), interrupt: vi.fn(),
    onReply: () => vi.fn(),
    state: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => {
        if (value === undefined) store.delete(key); else store.set(key, structuredClone(value));
        return Promise.resolve();
      },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
  } as never);
}

const kids = (node: WebviewElement | undefined): WebviewElement[] => (Array.isArray(node?.children) ? node.children : []) as WebviewElement[];

/** Every attachment chip the real webview script rendered in the transcript: its picture or its mark, and its name. */
function chips(chat: ChatViewProvider): Array<{ picture?: string; mark?: string; name: string }> {
  const boot = bootWebviewScript((chat as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string);
  const found: WebviewElement[] = [];
  const walk = (node: WebviewElement): void => {
    if (String(node.className).split(' ').includes('attachment-chip')) found.push(node);
    else kids(node).forEach(walk);
  };
  walk(boot.elements.get('transcript')!);
  return found.map((chip) => {
    const [first, name] = kids(chip);
    return String(first.className) === 'file-mark'
      ? { mark: String(first.textContent), name: String(name.textContent) }
      : { picture: String(first.src), name: String(name.textContent) };
  });
}

function sendWith(chat: ChatViewProvider, attachments: unknown[]): void {
  (chat as any).onMessage({ command: 'send', requestId: 'send-1', agentId: 'pm', text: 'save these', mode: 'act', attachments });
}

const image = (extra: Record<string, unknown> = {}) => ({ name: 'logo.png', mime: 'image/png', kind: 'image', size: 70, dataBase64: PNG_BASE64, ...extra });
const textFile = { name: 'notes.txt', mime: 'text/plain', kind: 'file', size: 5, dataBase64: Buffer.from('notes').toString('base64') };

describe('the chip of an attached file in a sent message', () => {
  it('shows an image by its kept preview, right after the send and after a reload, and a text file as TXT', () => {
    const store = new Map<string, unknown>();
    const send = vi.fn();
    sendWith(chatOn(store, send), [image({ thumbnailDataUrl: THUMBNAIL }), textFile]);
    expect(send).toHaveBeenCalledTimes(1);
    const expected = [{ picture: THUMBNAIL, name: 'logo.png' }, { mark: 'TXT', name: 'notes.txt' }];
    expect(chips(chatOn(store))).toEqual(expected);
    // The history keeps the small preview and never the image's bytes.
    const saved = JSON.stringify(store.get(chatHistoryKey('pm')));
    expect(saved).toContain(THUMBNAIL);
    expect(saved).not.toContain(PNG_BASE64);
    expect(saved).not.toContain('dataBase64');
  });

  it('shows the chip of the message as it was just sent, before any reload', () => {
    const chat = chatOn(new Map());
    sendWith(chat, [image({ thumbnailDataUrl: THUMBNAIL })]);
    expect(chips(chat)).toEqual([{ picture: THUMBNAIL, name: 'logo.png' }]);
  });

  it('marks an image without a preview IMG, never TXT, also after a reload', () => {
    const store = new Map<string, unknown>();
    const chat = chatOn(store);
    sendWith(chat, [image()]);
    expect(chips(chat)).toEqual([{ mark: 'IMG', name: 'logo.png' }]);
    expect(chips(chatOn(store))).toEqual([{ mark: 'IMG', name: 'logo.png' }]);
  });

  it('shows no preview a stored history could not have been admitted with', () => {
    const store = new Map<string, unknown>();
    const forged = (thumbnailDataUrl: string) => ({ name: 'x.png', mime: 'image/png', kind: 'image', size: 1, thumbnailDataUrl });
    store.set(chatHistoryKey('pm'), [{
      role: 'user', text: 'forged', ts: '2026-10-20T01:00:00.000Z', seq: 1,
      attachments: [
        forged('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='),
        forged('https://example.invalid/track.png'),
        forged(`data:image/png;base64,${'A'.repeat(200_001)}`),
        forged('data:image/png;base64,AAAA" onerror="x'),
      ],
    }]);
    expect(chips(chatOn(store)).map((chip) => chip.mark ?? chip.picture)).toEqual(['IMG', 'IMG', 'IMG', 'IMG']);
  });
});

describe('the chip function itself', () => {
  /** The webview's own renderAttachmentChip, run against a minimal document. */
  function chipOf(attachment: Record<string, unknown>): { picture?: string; mark?: string } {
    const html = (chatOn(new Map()) as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string;
    const script = bootWebviewScript(html).script;
    const start = script.indexOf('function renderAttachmentChip(');
    const end = script.indexOf('\n    }\n', start) + '\n    }\n'.length;
    const element = () => {
      const node: Record<string, unknown> & { children: unknown[] } = { children: [] };
      node.appendChild = (child: unknown) => { node.children.push(child); return child; };
      node.addEventListener = () => undefined;
      return node;
    };
    const render = new Function('document', 'humanSize', `${script.slice(start, end)}; return renderAttachmentChip;`)(
      { createElement: element }, () => '',
    ) as (attachment: unknown) => { children: Array<Record<string, unknown>> };
    const [first] = render(attachment).children;
    return first.className === 'file-mark' ? { mark: String(first.textContent) } : { picture: String(first.src) };
  }

  it('prefers the kept preview, then the file itself in the composer, then IMG; a PDF and a text file keep their marks', () => {
    expect(chipOf({ name: 'a.png', kind: 'image', thumbnailDataUrl: THUMBNAIL, dataUrl: `data:image/png;base64,${PNG_BASE64}` })).toEqual({ picture: THUMBNAIL });
    expect(chipOf({ name: 'a.png', kind: 'image', dataUrl: `data:image/png;base64,${PNG_BASE64}` })).toEqual({ picture: `data:image/png;base64,${PNG_BASE64}` });
    expect(chipOf({ name: 'a.png', kind: 'image' })).toEqual({ mark: 'IMG' });
    expect(chipOf({ name: 'a.pdf', kind: 'pdf' })).toEqual({ mark: 'PDF' });
    expect(chipOf({ name: 'a.txt', kind: 'file' })).toEqual({ mark: 'TXT' });
  });
});
