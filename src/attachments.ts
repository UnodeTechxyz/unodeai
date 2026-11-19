import { UserAttachment } from './types';
import type { ContextManifestSource } from './session/TurnContextManifest';
import { decodeUtf8Strict, sniffContent } from './contentSniff';
import { CONTENT_ASSET_MAX_BYTES, textContinuationAt } from './content/ContentAssetStore';
import { wholeCharacterIndex } from './content/textBoundary';

/**
 * v0.9.99: the largest image a turn shows to a model. An image goes to the model whole, in one request, so the image
 * size a vision request takes still applies to it; it is the content store's image size. A larger image is still
 * attached and kept: the turn names it and says it was not shown, and `save_attachment` can put it in the workspace.
 * It is never a limit on what the person can attach.
 */
export const MAX_INLINE_IMAGE_BYTES = CONTENT_ASSET_MAX_BYTES;
/**
 * v0.9.99: how much of one text attachment goes into the turn itself. The rest is never dropped: the turn says where
 * it continues, and the model reads it in pages from the stored copy of the file.
 */
export const MAX_INLINED_TEXT_ATTACHMENT_CHARS = 120_000;

export const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export const ALLOWED_TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/log',
  'application/json',
  'application/xml',
  'text/xml',
]);

export interface AttachmentValidationResult {
  attachments: UserAttachment[];
  errors: string[];
}

/**
 * v0.9.99: a file the chat composer handed to the host in pieces before Send. The send names it by `uploadId`; the
 * host resolves the id from its own staged copies for that chat view, never from a path or anything else the view says.
 */
export interface StagedAttachmentReference {
  name: string;
  mime: string;
  kind: UserAttachment['kind'];
  /** The size the view reported; the host's own count of the bytes it received decides. */
  size: number;
  thumbnailDataUrl?: string;
  uploadId: string;
}

/** One attachment of a send as the chat view names it: its bytes inline, or a staged copy the host holds. */
export type UserAttachmentInput = UserAttachment | StagedAttachmentReference;

export function isStagedAttachmentReference(attachment: UserAttachmentInput): attachment is StagedAttachmentReference {
  return typeof (attachment as Partial<StagedAttachmentReference>).uploadId === 'string';
}

/** v0.9.99: the shape of a staged upload id. The chat view makes it; it is only ever a key into the host's own map. */
export const STAGED_UPLOAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

type AttachmentMetadata = Pick<UserAttachment, 'name' | 'mime' | 'kind' | 'thumbnailDataUrl'>;

/** The name, type and kind every attachment must have, with the same checks for inline and staged files. */
function attachmentMetadataOf(candidate: Record<string, unknown>): { ok: true; value: AttachmentMetadata } | { ok: false; error: string } {
  const name = cleanName(candidate.name);
  const mime = typeof candidate.mime === 'string' ? candidate.mime.trim().toLowerCase() : '';
  const kind = candidate.kind === 'image'
    ? 'image'
    : candidate.kind === 'file'
      ? 'file'
      : candidate.kind === 'pdf'
        ? 'pdf'
        : undefined;
  if (!name || !mime || !kind) {
    return { ok: false, error: 'Skipped an attachment with missing metadata.' };
  }
  if (kind === 'image' && !ALLOWED_IMAGE_MIMES.has(mime)) {
    return { ok: false, error: `${name} is not a supported image type.` };
  }
  if (kind === 'file' && !isAllowedTextMime(mime, name)) {
    return { ok: false, error: `${name} is not a supported text file type.` };
  }
  const thumbnailDataUrl = normalizeThumbnail(candidate.thumbnailDataUrl);
  return { ok: true, value: { name, mime, kind, ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}) } };
}

/**
 * Attachments whose bytes come inline in the message. v0.9.99: there is no size limit; every file is stored on disk
 * and read in pages as it is needed. The chat composer hands its files over in pieces instead (see
 * `parseStagedAttachmentReference`); this path stays for callers that already hold the bytes.
 */
export function validateUserAttachments(raw: unknown): AttachmentValidationResult {
  const errors: string[] = [];
  if (raw === undefined || raw === null) {
    return { attachments: [], errors };
  }
  if (!Array.isArray(raw)) {
    return { attachments: [], errors: ['Attachments must be an array.'] };
  }

  // v0.9.99: every valid file is taken, however many there are and however large; each is stored on disk.
  const attachments: UserAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      errors.push('Skipped an invalid attachment.');
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const dataBase64 = normalizeBase64(candidate.dataBase64);
    const metadata = attachmentMetadataOf(candidate);
    if (!metadata.ok || !dataBase64) {
      errors.push(metadata.ok ? 'Skipped an attachment with missing metadata.' : metadata.error);
      continue;
    }
    // The size is counted from the bytes received, never taken from what the view reported.
    attachments.push({ ...metadata.value, dataBase64, size: estimateBase64Bytes(dataBase64) });
  }
  return { attachments, errors };
}

/** v0.9.99: one staged file a send names: its metadata, checked like an inline file's, and the id of its copy. */
export function parseStagedAttachmentReference(raw: unknown): { ok: true; value: StagedAttachmentReference } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Skipped an invalid attachment.' };
  const candidate = raw as Record<string, unknown>;
  const metadata = attachmentMetadataOf(candidate);
  if (!metadata.ok) return metadata;
  const uploadId = typeof candidate.uploadId === 'string' && STAGED_UPLOAD_ID.test(candidate.uploadId) ? candidate.uploadId : undefined;
  const size = typeof candidate.size === 'number' && Number.isSafeInteger(candidate.size) && candidate.size >= 0 ? candidate.size : undefined;
  if (!uploadId || size === undefined) return { ok: false, error: 'Skipped an attachment with missing metadata.' };
  return { ok: true, value: { ...metadata.value, size, uploadId } };
}

/**
 * v0.9.99: the attachment a staged file becomes once the host has read its own copy: the bytes the host received,
 * whatever the view reported. Throws only when this process cannot hold the bytes as one value (a resource limit).
 */
export function userAttachmentFromStagedBytes(reference: StagedAttachmentReference, bytes: Buffer): UserAttachment {
  return {
    name: reference.name,
    mime: reference.mime,
    kind: reference.kind,
    dataBase64: bytes.toString('base64'),
    size: bytes.byteLength,
    ...(reference.thumbnailDataUrl ? { thumbnailDataUrl: reference.thumbnailDataUrl } : {}),
  };
}

/** v0.9.99: whether a turn can show this image to a model: one request carries it whole. */
export function imageFitsInline(attachment: UserAttachment): boolean {
  return estimateBase64Bytes(attachment.dataBase64) <= MAX_INLINE_IMAGE_BYTES;
}

export function splitUserAttachments(attachments: readonly UserAttachment[] | undefined): {
  /** Images a turn shows to the model. */
  images: UserAttachment[];
  /**
   * v0.9.99: images too large for one model request. They are attached and kept like every file, and the turn names
   * each as not shown; they are never put into a request.
   */
  largeImages: UserAttachment[];
  textFiles: UserAttachment[];
  pdfs: UserAttachment[];
} {
  const safe = attachments ?? [];
  const images = safe.filter((a) => a.kind === 'image' && ALLOWED_IMAGE_MIMES.has(a.mime));
  return {
    images: images.filter(imageFitsInline),
    largeImages: images.filter((image) => !imageFitsInline(image)),
    textFiles: safe.filter((a) => a.kind === 'file'),
    pdfs: safe.filter((a) => a.kind === 'pdf'),
  };
}

export function formatUserTextAttachments(attachments: readonly UserAttachment[] | undefined): string {
  return composeUserTextAttachments(attachments).text;
}

/**
 * The text block every route puts into a turn, and which text files it really carries. A file whose bytes are not
 * text is named in the block but not inlined, so it is not among `inlined`: its content did not reach the model.
 *
 * v0.9.99: a text file longer than MAX_INLINED_TEXT_ATTACHMENT_CHARS goes in up to that point, followed by a line
 * that says how much is left and the exact read that continues it from the file's stored copy. A file the host could
 * not store says that its rest was not delivered, never ending silently.
 */
export function composeUserTextAttachments(
  attachments: readonly UserAttachment[] | undefined,
  /** v0.9.99: false on a conversation that cannot read sources in pages (an older Codex thread). */
  options: { pagedReads?: boolean } = {},
): {
  text: string;
  inlined: UserAttachment[];
} {
  const { textFiles: files, largeImages } = splitUserAttachments(attachments);
  // v0.9.99: an image too large for one model request is named, never silently missing.
  const imageNotes = largeImages.length > 0 ? `\n${largeImages.map(largeImageNote).join('\n')}` : '';
  if (files.length === 0) {
    return { text: imageNotes, inlined: [] };
  }
  const inlined: UserAttachment[] = [];
  const blocks = files.map((file) => {
    const decoded = decodeTextAttachment(file);
    if (decoded === undefined) {
      return `### ${file.name}\n(binary attachment, not inlined)`;
    }
    inlined.push(file);
    if (decoded.length <= MAX_INLINED_TEXT_ATTACHMENT_CHARS) {
      return `${textAttachmentHead(file)}${decoded}\n\`\`\``;
    }
    // v0.9.99: the inlined part ends at a whole character, never between the two halves of a pair.
    const shown = wholeCharacterIndex(decoded, MAX_INLINED_TEXT_ATTACHMENT_CHARS);
    return `${textAttachmentHead(file)}${decoded.slice(0, shown)}\n\`\`\`\n${textAttachmentContinuation(file, decoded, shown, options.pagedReads !== false)}`;
  });
  return { text: `${TEXT_ATTACHMENTS_HEADING}${blocks.join('\n\n')}${imageNotes ? `\n${imageNotes}` : ''}`, inlined };
}

/** v0.9.99: an attachment's size as the person reads it. */
export function attachmentSizeLabel(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * v0.9.99: what the model is told about an attached image too large to show it. The image is attached and kept; the
 * model must not claim to have seen it. With a stored copy, the model can save it into the workspace and work on it.
 */
function largeImageNote(image: UserAttachment): string {
  const kept = image.contentAssetId
    ? ` Its exact file is kept: if you have save_attachment, save_attachment({ asset_id: "${image.contentAssetId}", path }) `
      + 'puts it in the workspace, where your tools can work on it (for example, make a smaller copy).'
    : '';
  return `[Image ${image.name} (${attachmentSizeLabel(image.size ?? 0)}) is attached, but it was not shown to you: an image goes `
    + `to the model whole, in one request, and this one is larger than the ${attachmentSizeLabel(MAX_INLINE_IMAGE_BYTES)} that allows. `
    + `Do not describe it as if you saw it; tell the user you could not see it.${kept}]`;
}

const TEXT_ATTACHMENTS_HEADING = '\nAttached text files:\n\n';

/** The lines before one text file's content in its block. */
function textAttachmentHead(file: UserAttachment): string {
  return `### ${file.name}\n\`\`\`${languageForAttachment(file)}\n`;
}

/**
 * v0.9.99: the whole text of one text attachment as its stored copy keeps it for the readers: the same block the
 * turn shows, never cut. A file whose bytes are not text keeps the block that says so, as the turn shows it.
 */
export function storedTextAttachmentSource(file: UserAttachment): string | undefined {
  if (file.kind !== 'file') return undefined;
  const decoded = decodeTextAttachment(file);
  return decoded === undefined ? formatUserTextAttachments([file]) : storedTextBlock(file, decoded);
}

/** The stored copy of one text file: its whole block, heading and head included. */
function storedTextBlock(file: UserAttachment, decoded: string): string {
  return `${TEXT_ATTACHMENTS_HEADING}${textAttachmentHead(file)}${decoded}\n\`\`\``;
}

/**
 * v0.9.99: what follows the inlined part of a long text attachment (its first `shownChars` characters): how much is
 * left and how to read it.
 */
function textAttachmentContinuation(file: UserAttachment, decoded: string, shownChars: number, pagedReads: boolean): string {
  const shown = shownChars.toLocaleString('en-US');
  const total = decoded.length.toLocaleString('en-US');
  if (!file.contentAssetId) {
    return `[Attachment ${file.name}: only its first ${shown} of ${total} characters were delivered here; UnodeAi could not keep a copy to read the rest from. Tell the user the rest of this file was not read.]`;
  }
  if (!pagedReads) {
    return `[Attachment ${file.name}: only its first ${shown} of ${total} characters were delivered here; this conversation was started before it could read files in pages. Tell the user the rest was not read, and that a new model conversation for this agent reads all of it.]`;
  }
  // The stored copy is this file's whole block: the next character is found in it, on the same page boundaries its
  // reads use.
  const { page, offset } = textContinuationAt(
    storedTextBlock(file, decoded),
    TEXT_ATTACHMENTS_HEADING.length + textAttachmentHead(file).length + shownChars,
  );
  return `[Attachment ${file.name} continues: the first ${shown} of ${total} characters are above. Read the rest before relying on the file: `
    + `read_extracted_content({ assetId: "${file.contentAssetId}", pages: { start: ${page} }${offset > 0 ? `, offset: ${offset}` : ''} }), `
    + 'then follow each result\'s continuation to the end.]';
}

/** Positions in `all` of the attachments a route put into its payload, by identity, each once and in order. */
export function userAttachmentIndexes(all: readonly UserAttachment[] | undefined, delivered: readonly UserAttachment[]): number[] {
  const wanted = new Set(delivered);
  return (all ?? []).flatMap((attachment, index) => (wanted.has(attachment) ? [index] : []));
}

/**
 * The receipt line of one attachment the user sent, for the turn's context manifest. The host lists it only once
 * the route that runs the turn has reported the attachment in the payload it sent, never when the user pressed Send.
 */
export function userAttachmentManifestSource(attachment: UserAttachment): ContextManifestSource | undefined {
  if (attachment.kind === 'file') {
    const supplied = formatUserTextAttachments([attachment]);
    return supplied
      ? { kind: 'user-attachment', label: attachment.name, location: 'user text attachment', text: supplied, reason: 'user attached a text file' }
      : undefined;
  }
  if (attachment.kind === 'image' && ALLOWED_IMAGE_MIMES.has(attachment.mime)) {
    return {
      kind: 'user-attachment',
      label: attachment.name,
      location: 'user image attachment',
      bytes: attachment.size ?? 0,
      reason: 'user attached an image; image token estimate is unavailable',
    };
  }
  if (attachment.kind === 'pdf') {
    return {
      kind: 'user-attachment',
      label: attachment.name,
      location: 'user PDF attachment',
      bytes: attachment.size ?? 0,
      reason: 'user attached a PDF; content is available only through the bounded content-asset reader',
    };
  }
  return undefined;
}

function normalizeThumbnail(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 200_000 || !raw.startsWith('data:image/')) {
    return undefined;
  }
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw) ? raw : undefined;
}

function cleanName(raw: unknown): string {
  return typeof raw === 'string'
    ? raw.replace(/[\\/\r\n]/g, '_').trim().slice(0, 160)
    : '';
}

function normalizeBase64(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const value = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const compact = value.replace(/\s/g, '');
  return /^[A-Za-z0-9+/]*={0,2}$/.test(compact) ? compact : undefined;
}

function estimateBase64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}

function isAllowedTextMime(mime: string, name: string): boolean {
  return ALLOWED_TEXT_MIMES.has(mime) || /\.(txt|md|markdown|json|csv|log|xml|yaml|yml)$/i.test(name);
}

/**
 * Decode a text attachment, or report that it is not text.
 *
 * This inferred "binary" from a thrown exception for as long as it has existed, and
 * `Buffer.toString('utf8')` does not throw on invalid bytes — it substitutes U+FFFD and returns a
 * plausible-looking string. **The `(binary attachment, not inlined)` branch above was unreachable.**
 *
 * Nothing went wrong because the MIME allowlist in front of this kept catching what this was meant to catch
 * second. That is the failure mode worth naming: the working half of a defence in depth hid the broken half,
 * and a check nobody can observe failing is not a check.
 */
function decodeTextAttachment(file: UserAttachment): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(file.dataBase64, 'base64');
  } catch {
    return undefined;
  }
  return sniffContent(bytes).binary ? undefined : decodeUtf8Strict(bytes);
}

function languageForAttachment(file: UserAttachment): string {
  if (/\.json$/i.test(file.name) || file.mime === 'application/json') {
    return 'json';
  }
  if (/\.csv$/i.test(file.name) || file.mime === 'text/csv') {
    return 'csv';
  }
  if (/\.md|\.markdown$/i.test(file.name) || file.mime === 'text/markdown') {
    return 'markdown';
  }
  if (/\.ya?ml$/i.test(file.name)) {
    return 'yaml';
  }
  if (/\.xml$/i.test(file.name) || file.mime.includes('xml')) {
    return 'xml';
  }
  return '';
}
