/**
 * One answer to "are these bytes text", shared by every entrance that takes bytes from outside.
 *
 * There were three entrances and three different answers. `fetch_url` decoded the whole body and asked what
 * it was afterwards. `read_file` called `toString('utf8')` on anything the workspace held, so a PNG reached
 * an agent as a screen of replacement characters. The attachment path had a check that could never fire —
 * it inferred "binary" from a thrown exception, and `Buffer.toString('utf8')` does not throw on invalid
 * bytes, it substitutes U+FFFD. That branch was unreachable from the day it was written, and nothing went
 * wrong only because the MIME allowlist in front of it kept catching what it was meant to catch second.
 *
 * A safety check nobody can observe failing is not a safety check. Hence one module: same bytes, same
 * verdict, wherever they arrive from — and one place to improve when a format is missed.
 *
 * **This is a boundary, not a classifier.** It answers "is it safe to treat these bytes as text", which is a
 * narrower and more answerable question than "what is this file". A false positive costs a refusal with a
 * reason; a false negative costs mojibake in a model's context, or worse. It is tuned accordingly.
 */

/** Signatures whose presence settles the question on its own. */
const BINARY_SIGNATURES: readonly { readonly bytes: readonly number[]; readonly label: string }[] = [
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], label: 'PDF' },
  { bytes: [0xff, 0xd8, 0xff], label: 'JPEG image' },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], label: 'PNG image' },
  { bytes: [0x47, 0x49, 0x46, 0x38], label: 'GIF image' },
  { bytes: [0x42, 0x4d], label: 'BMP image' },
  { bytes: [0x00, 0x00, 0x01, 0x00], label: 'ICO image' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], label: 'ZIP archive' },
  { bytes: [0x50, 0x4b, 0x05, 0x06], label: 'ZIP archive' },
  { bytes: [0x50, 0x4b, 0x07, 0x08], label: 'ZIP archive' },
  { bytes: [0x1f, 0x8b], label: 'gzip archive' },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: '7z archive' },
  { bytes: [0x42, 0x5a, 0x68], label: 'bzip2 archive' },
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], label: 'xz archive' },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], label: 'ELF executable' },
  { bytes: [0x4d, 0x5a], label: 'Windows executable' },
  { bytes: [0x25, 0x21, 0x50, 0x53], label: 'PostScript document' },
  { bytes: [0x4f, 0x67, 0x67, 0x53], label: 'Ogg media' },
  { bytes: [0x66, 0x4c, 0x61, 0x43], label: 'FLAC audio' },
  { bytes: [0x49, 0x44, 0x33], label: 'MP3 audio' },
];

/** Ratio of C0 control characters above which unrecognised bytes are treated as binary. */
const CONTROL_RATIO_LIMIT = 0.1;
/** Below this many bytes the ratio is noise — a short file of odd characters is not evidence. */
const CONTROL_RATIO_MIN_BYTES = 32;

export interface ContentSniffResult {
  /** True when these bytes must not be decoded and shown as text. */
  binary: boolean;
  /** A name for the detected format, when a signature matched. Safe to show a user. */
  label?: string;
  /** Why it was refused, when no signature matched. */
  reason?: 'nul-byte' | 'control-character-ratio' | 'invalid-utf8';
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + prefix.length
    && prefix.every((value, index) => bytes[offset + index] === value);
}

/**
 * Decide whether bytes may be treated as text.
 *
 * Order matters: a signature is the strongest evidence and is checked first, a NUL byte is decisive on its
 * own, and the control-character ratio is the last line for a format nothing here recognises. Strict UTF-8
 * validation runs last because it is the most expensive and the most easily fooled — a file of Latin-1 prose
 * fails it while being perfectly readable text, which is why it is a *supporting* signal and the caller is
 * told which check refused.
 */
export function sniffContent(bytes: Uint8Array): ContentSniffResult {
  for (const signature of BINARY_SIGNATURES) {
    if (hasPrefix(bytes, signature.bytes)) {
      return { binary: true, label: signature.label };
    }
  }
  // RIFF containers need their fourth word to be read before they mean anything.
  if (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12) {
    if (hasPrefix(bytes, [0x57, 0x45, 0x42, 0x50], 8)) { return { binary: true, label: 'WebP image' }; }
    if (hasPrefix(bytes, [0x41, 0x56, 0x49, 0x20], 8)) { return { binary: true, label: 'AVI video' }; }
    if (hasPrefix(bytes, [0x57, 0x41, 0x56, 0x45], 8)) { return { binary: true, label: 'WAV audio' }; }
  }
  // ISO base media (mp4/mov) puts its brand at offset 4, after a length word.
  if (hasPrefix(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    return { binary: true, label: 'MP4/QuickTime video' };
  }

  let controls = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      return { binary: true, reason: 'nul-byte' };
    }
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      controls++;
    }
  }
  if (bytes.length >= CONTROL_RATIO_MIN_BYTES && controls / bytes.length > CONTROL_RATIO_LIMIT) {
    return { binary: true, reason: 'control-character-ratio' };
  }
  return { binary: false };
}

/**
 * Decode bytes as UTF-8, or say why not.
 *
 * `TextDecoder` with `fatal: true` is the check the attachment path believed it was making. Plain
 * `Buffer.toString('utf8')` never throws — it substitutes U+FFFD and returns a string that looks like it
 * worked, which is exactly how an unreachable `catch` survives review.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** A sentence for a user or an agent, naming what was detected rather than only that something was refused. */
export function describeSniffRefusal(result: ContentSniffResult): string {
  if (result.label) {
    return `looks like a ${result.label}`;
  }
  if (result.reason === 'nul-byte') {
    return 'contains NUL bytes';
  }
  if (result.reason === 'control-character-ratio') {
    return 'is mostly control characters';
  }
  return 'is not valid UTF-8 text';
}
