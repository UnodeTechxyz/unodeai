import { UserAttachment } from './types';
import { decodeUtf8Strict, sniffContent } from './contentSniff';
import { CONTENT_ASSET_MAX_BYTES } from './content/ContentAssetStore';

export const MAX_USER_ATTACHMENTS = 6;
/** User-provided binary assets share the temporary content store's one byte ceiling. */
export const MAX_USER_ATTACHMENT_BYTES = CONTENT_ASSET_MAX_BYTES;
export const MAX_USER_PDF_ATTACHMENT_BYTES = CONTENT_ASSET_MAX_BYTES;
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

export function validateUserAttachments(raw: unknown): AttachmentValidationResult {
  const errors: string[] = [];
  if (raw === undefined || raw === null) {
    return { attachments: [], errors };
  }
  if (!Array.isArray(raw)) {
    return { attachments: [], errors: ['Attachments must be an array.'] };
  }
  if (raw.length > MAX_USER_ATTACHMENTS) {
    errors.push(`You can attach at most ${MAX_USER_ATTACHMENTS} files per message.`);
  }

  const attachments: UserAttachment[] = [];
  for (const item of raw.slice(0, MAX_USER_ATTACHMENTS)) {
    if (!item || typeof item !== 'object') {
      errors.push('Skipped an invalid attachment.');
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const name = cleanName(candidate.name);
    const mime = typeof candidate.mime === 'string' ? candidate.mime.trim().toLowerCase() : '';
    const kind = candidate.kind === 'image'
      ? 'image'
      : candidate.kind === 'file'
        ? 'file'
        : candidate.kind === 'pdf'
          ? 'pdf'
          : undefined;
    const dataBase64 = normalizeBase64(candidate.dataBase64);
    const thumbnailDataUrl = normalizeThumbnail(candidate.thumbnailDataUrl);
    const declaredSize = typeof candidate.size === 'number' && Number.isFinite(candidate.size)
      ? Math.max(0, Math.floor(candidate.size))
      : estimateBase64Bytes(dataBase64 ?? '');
    // Admission is conservative over both the reported and received lengths: a
    // forged small `size` cannot bypass the content boundary, while a reported
    // oversize attachment is still refused before its bytes can be routed.
    const byteSize = estimateBase64Bytes(dataBase64 ?? '');
    const size = Math.max(declaredSize, byteSize);

    if (!name || !mime || !kind || !dataBase64) {
      errors.push('Skipped an attachment with missing metadata.');
      continue;
    }
    const maxBytes = kind === 'pdf' ? MAX_USER_PDF_ATTACHMENT_BYTES : MAX_USER_ATTACHMENT_BYTES;
    if (size > maxBytes) {
      errors.push(`${name} is larger than ${maxBytes / (1024 * 1024)} MB.`);
      continue;
    }
    if (kind === 'image' && !ALLOWED_IMAGE_MIMES.has(mime)) {
      errors.push(`${name} is not a supported image type.`);
      continue;
    }
    if (kind === 'file' && !isAllowedTextMime(mime, name)) {
      errors.push(`${name} is not a supported text file type.`);
      continue;
    }

    attachments.push({ name, mime, kind, dataBase64, size: byteSize, thumbnailDataUrl });
  }
  return { attachments, errors };
}

export function splitUserAttachments(attachments: readonly UserAttachment[] | undefined): {
  images: UserAttachment[];
  textFiles: UserAttachment[];
  pdfs: UserAttachment[];
} {
  const safe = attachments ?? [];
  return {
    images: safe.filter((a) => a.kind === 'image' && ALLOWED_IMAGE_MIMES.has(a.mime)),
    textFiles: safe.filter((a) => a.kind === 'file'),
    pdfs: safe.filter((a) => a.kind === 'pdf'),
  };
}

export function formatUserTextAttachments(attachments: readonly UserAttachment[] | undefined): string {
  const files = splitUserAttachments(attachments).textFiles;
  if (files.length === 0) {
    return '';
  }
  const blocks = files.map((file) => {
    const decoded = decodeTextAttachment(file);
    if (decoded === undefined) {
      return `### ${file.name}\n(binary attachment, not inlined)`;
    }
    const truncated = decoded.length > MAX_INLINED_TEXT_ATTACHMENT_CHARS;
    const text = truncated
      ? `${decoded.slice(0, MAX_INLINED_TEXT_ATTACHMENT_CHARS)}\n\n[Attachment truncated at ${MAX_INLINED_TEXT_ATTACHMENT_CHARS} characters.]`
      : decoded;
    return `### ${file.name}\n\`\`\`${languageForAttachment(file)}\n${text}\n\`\`\``;
  });
  return `\nAttached text files:\n\n${blocks.join('\n\n')}`;
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
