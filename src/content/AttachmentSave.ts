/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Saving a file the user attached (v0.9.97)
 *
 *  What `save_attachment` may write, decided from the bytes the user attached: a PNG, a JPEG, a PDF, or a text file
 *  the attachment entry admitted, each only under a destination whose extension names that type. A text attachment
 *  is checked for a binary signature first and is written with its original bytes: its encoding, byte-order mark
 *  and line endings as attached. Anything else is refused. No extension is guessed, nothing is converted, and no
 *  other bytes stand in for the attachment's.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { describeSniffRefusal, sniffContent } from '../contentSniff';
import type { DelegationContentSource } from '../session/TurnContextManifest';
import { type ContentAssetMediaKind, CONTENT_ASSET_TTL_MS, imageMimeFromBytes, isPdf } from './ContentAssetStore';

export const SAVE_ATTACHMENT_TOOL = 'save_attachment';

export type SavedAttachmentType = 'png' | 'jpeg' | 'pdf' | 'text';

/**
 * The destination extensions each type may be saved under, compared without case. For text this is a naming rule,
 * not a claim that the content is valid for the extension or safe to run.
 */
export const SAVED_ATTACHMENT_EXTENSIONS: Readonly<Record<SavedAttachmentType, readonly string[]>> = Object.freeze({
  png: ['.png'],
  jpeg: ['.jpg', '.jpeg'],
  pdf: ['.pdf'],
  text: [
    '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.js',
    '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1', '.sql', '.toml', '.ini', '.log',
  ],
});

const TYPE_LABELS: Readonly<Record<SavedAttachmentType, string>> = {
  png: 'PNG image',
  jpeg: 'JPEG image',
  pdf: 'PDF document',
  text: 'text file',
};

export function savedAttachmentTypeLabel(type: SavedAttachmentType): string {
  return TYPE_LABELS[type];
}

/**
 * The typed outcome of one save. `saved` is the only success; every other code left the destination as it was,
 * except `effect-uncertain`, which may have changed it.
 */
export type AttachmentSaveCode =
  | 'saved'
  /** The call carried something other than exactly `asset_id` and `path`. */
  | 'invalid-input'
  /** Not given to this agent for this turn, or not an id this host issued. */
  | 'asset-unavailable'
  /** Given to this agent, but no longer held: the user must attach the file again. */
  | 'asset-expired'
  /** Not a file the user attached: a web download, or text an agent or the host passed along. */
  | 'provenance'
  /** An attachment whose bytes are of a type this tool does not save (a GIF or WebP image). */
  | 'type-unsupported'
  /** Bytes that are not what the attachment was admitted as (a binary signature in a text attachment). */
  | 'type-mismatch'
  /** A destination whose extension does not name the bytes' type, or that has none. */
  | 'extension-mismatch'
  /** The write policy or the team's read-before-write check refused the destination as it is. */
  | 'target-refused'
  /** The person did not approve, or nobody could be asked. */
  | 'denied'
  /** The attachment's grant to this agent ended while the save waited. */
  | 'grant-revoked'
  /** The destination changed, appeared, moved, or got unsaved editor changes while the save waited. */
  | 'target-changed'
  /** Workspace Trust was lost, the agent or the host is stopping, or the call was stopped. */
  | 'interrupted'
  /** The exact bytes of the file being replaced could not be kept as a restore point. */
  | 'checkpoint-failed'
  /** The commit did not happen, and the destination was seen as it was. */
  | 'not-committed'
  /** The destination may have changed, and what it holds could not be confirmed. */
  | 'effect-uncertain';

/** Only what the host read back from the destination after the commit. */
export interface AttachmentSaveReceipt {
  /** The destination, relative to the agent's folder, with `/`. */
  path: string;
  bytes: number;
  sha256: string;
  /** True for a new file, false when an existing file was replaced. */
  created: boolean;
  /** The restore point that keeps the replaced file's exact bytes; absent for a new file. */
  restorePoint?: string;
}

/** Host-only: what a save did, for the receipt and for tests. Never part of a tool schema. */
export interface AttachmentSaveFact {
  code: AttachmentSaveCode;
  type?: SavedAttachmentType;
  receipt?: AttachmentSaveReceipt;
}

/**
 * The type of an attachment's bytes, given what the attachment entry admitted it as, or why it is not saved. The
 * bytes decide; the declared MIME and the file name the user had are never consulted.
 */
export function savedAttachmentType(
  mediaKind: ContentAssetMediaKind,
  bytes: Uint8Array,
): { ok: true; type: SavedAttachmentType } | { ok: false; code: 'type-unsupported' | 'type-mismatch'; reason: string } {
  switch (mediaKind) {
    case 'image': {
      const mime = imageMimeFromBytes(bytes);
      if (mime === 'image/png') return { ok: true, type: 'png' };
      if (mime === 'image/jpeg') return { ok: true, type: 'jpeg' };
      return mime
        ? { ok: false, code: 'type-unsupported', reason: `it is a ${mime === 'image/gif' ? 'GIF' : 'WebP'} image, and save_attachment saves PNG and JPEG images only` }
        : { ok: false, code: 'type-mismatch', reason: 'it was attached as an image, but its bytes are not one' };
    }
    case 'pdf':
      return isPdf(bytes)
        ? { ok: true, type: 'pdf' }
        : { ok: false, code: 'type-mismatch', reason: 'it was attached as a PDF, but its bytes are not one' };
    case 'text': {
      // A binary signature is checked before anything else: a PNG renamed notes.txt is not saved as text.
      const sniffed = sniffContent(bytes);
      return sniffed.binary
        ? { ok: false, code: 'type-mismatch', reason: `it was attached as a text file, but its content ${describeSniffRefusal(sniffed)}` }
        : { ok: true, type: 'text' };
    }
    default:
      return { ok: false, code: 'type-unsupported', reason: 'save_attachment saves PNG and JPEG images, PDFs and text files only' };
  }
}

/** Whether a destination's extension names the type. A destination without an extension never does. */
export function attachmentExtensionAllowed(type: SavedAttachmentType, destination: string): boolean {
  const extension = path.extname(destination).toLowerCase();
  return extension !== '' && SAVED_ATTACHMENT_EXTENSIONS[type].includes(extension);
}

/** The extensions a type may be saved under, as a sentence names them. */
export function attachmentExtensionList(type: SavedAttachmentType): string {
  const extensions = SAVED_ATTACHMENT_EXTENSIONS[type];
  return extensions.length === 1 ? extensions[0] : `${extensions.slice(0, -1).join(', ')} or ${extensions[extensions.length - 1]}`;
}

/** What the approval card shows instead of a text diff: where, what, how many bytes, which SHA-256, and what it replaces. */
export function attachmentSavePreview(save: {
  path: string;
  type: SavedAttachmentType;
  bytes: number;
  sha256: string;
  /** The file the save replaces, when there is one. */
  replaces?: { bytes?: number };
  /** Whether the host keeps the exact bytes of a file before it replaces it. */
  keepsExactBytes: boolean;
}): string {
  const lines = [
    'Save a file the user attached, byte for byte.',
    `Destination: ${save.path}${save.replaces ? ' (replaces the file there)' : ' (a new file)'}`,
    `Type: ${TYPE_LABELS[save.type]}, from its bytes`,
    `Size: ${save.bytes.toLocaleString('en-US')} bytes`,
    `SHA-256: ${save.sha256}`,
  ];
  if (save.replaces) {
    const size = save.replaces.bytes === undefined ? '' : ` (${save.replaces.bytes.toLocaleString('en-US')} bytes)`;
    lines.push(save.keepsExactBytes
      ? `The file there now${size} is replaced. Its exact bytes are kept first as a restore point; if they cannot be kept, nothing is replaced.`
      : `The file there now${size} is replaced. Only a text copy of it is kept.`);
  } else {
    lines.push('Nothing is replaced; restoring this change removes the new file.');
  }
  return lines.join('\n');
}

/**
 * The text a change record keeps for the saved file, for its diff: the bytes as UTF-8 for a text file, a one-line
 * description for anything else. A restore relies on the bytes' SHA-256, never on this text.
 */
export function attachmentRecordText(type: SavedAttachmentType, bytes: Buffer, sha256: string): string {
  return type === 'text'
    ? bytes.toString('utf8')
    : `(${TYPE_LABELS[type]}, ${bytes.length.toLocaleString('en-US')} bytes, SHA-256 ${sha256}: saved from a file the user attached)`;
}

/** The model-facing receipt of a save, from what was read back. */
export function attachmentSaveReceiptText(
  assetId: string,
  receipt: AttachmentSaveReceipt,
  createdFolders: readonly string[],
  /** The file it replaced already held exactly these bytes. */
  unchanged = false,
): string {
  const replaced = receipt.created
    ? 'as a new file'
    : 'replacing the file that was there';
  const restore = receipt.created
    ? 'No restore point is needed: restoring this change removes the new file.'
    : receipt.restorePoint
      ? `Restore point ${receipt.restorePoint} keeps the exact bytes the file held before.`
      : unchanged
        ? 'The file already held exactly these bytes, so no restore point was needed.'
        : 'No restore point with the exact bytes of the file it replaced was kept.';
  const folders = createdFolders.length > 0
    ? ` Created ${createdFolders.length === 1 ? 'folder' : 'folders'} ${createdFolders.join(', ')}.`
    : '';
  return `Saved attachment ${assetId} to ${receipt.path} ${replaced}: ${receipt.bytes} bytes, SHA-256 ${receipt.sha256}, `
    + `as UnodeAi read it back from the file.${folders} ${restore}`;
}

/**
 * The attachments of a user's own request, by id, for that request's turn: the model sees each attached file, but
 * not the id a save needs. Names are not repeated (a PDF's never enters the conversation); each file is named by its
 * kind and its place among the files of that kind, in the order they were attached, as the model receives them.
 */
export function saveableAttachmentNote(sources: readonly DelegationContentSource[] | undefined): string {
  const attached = (sources ?? []).filter((source) => source.kind === 'user-attachment'
    && /^content-[1-9]\d*$/.test(source.assetId)
    && (source.mediaKind === 'image' || source.mediaKind === 'pdf' || source.mediaKind === 'text'));
  if (attached.length === 0) return '';
  const minutes = Math.round(CONTENT_ASSET_TTL_MS / 60_000);
  const kindLabel = { text: 'text file', pdf: 'PDF', image: 'image' } as const;
  const lines = [
    '[attachments of this request]',
    `The user attached these files to this request. To save one into the workspace exactly as attached, call ${SAVE_ATTACHMENT_TOOL} with its id; do not write a copy of it any other way. Each is kept for ${minutes} minutes after it was attached.`,
    ...attached.map((source) => {
      const ofKind = attached.filter((other) => other.mediaKind === source.mediaKind);
      const size = source.bytes ?? source.textBytes;
      return `- ${source.assetId}: ${kindLabel[source.mediaKind]} ${ofKind.indexOf(source) + 1} of ${ofKind.length}${size === undefined ? '' : `, ${size} bytes`}`;
    }),
  ];
  return `\n\n${lines.join('\n')}`;
}
