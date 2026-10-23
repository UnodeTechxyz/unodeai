import { lookup } from 'dns/promises';
import { decodeUtf8Strict, sniffContent } from '../contentSniff';
import { imageMimeFromBytes } from '../content/ContentAssetStore';

export const WEB_FETCH_MAX_OUTPUT = 100_000;
/**
 * Maximum response body accepted by the public-web tool. This limits extension memory, rather than
 * merely limiting the string later placed in model context (`WEB_FETCH_MAX_OUTPUT`). Keep this
 * deliberately separate from the output cap: bytes must be bounded before decoding.
 */
export const WEB_FETCH_MAX_BODY_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const UNSAFE_BINARY_ERROR = 'Error: Unsupported or unsafe binary content. No bytes were added to context.';
export const VIDEO_UNSUPPORTED_ERROR = 'Error: Video is unsupported in v0.9.58. No bytes were added to context.';

// Hostnames that compare equal after stripping optional IPv6 brackets.
const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
]);

/** True for an IPv4 string in a loopback / "this host" / link-local / RFC1918 private range. */
function isPrivateV4(v4: string): boolean {
  return /^127\./.test(v4)          // loopback 127.0.0.0/8 (not just 127.0.0.1)
      || /^0\./.test(v4)            // "this host" 0.0.0.0/8
      || /^169\.254\./.test(v4)     // link-local / cloud metadata 169.254.0.0/16
      || /^10\./.test(v4)           // RFC1918
      || /^172\.(1[6-9]|2\d|3[01])\./.test(v4)
      || /^192\.168\./.test(v4);
}

/**
 * Decode an inet_aton-style numeric IPv4 host into dotted-quad form, or undefined if it isn't one.
 * Covers the SSRF-bypass encodings of 127.0.0.1: decimal (2130706433), hex (0x7f000001), octal
 * (0177.0.0.1), and short forms (127.1). Defense-in-depth so we block these by the literal even when
 * platform DNS wouldn't normalize them for us. A real DNS hostname contains a non-numeric label and
 * returns undefined here (→ falls through to the normal DNS-resolution check).
 */
export function numericV4ToDotted(host: string): string | undefined {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return undefined;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === '') return undefined;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[1-9]\d*$/.test(p) || p === '0') n = parseInt(p, 10);
    else return undefined; // a non-numeric label → a real hostname, not a numeric IP literal
    if (!Number.isSafeInteger(n) || n < 0) return undefined;
    nums.push(n);
  }
  // inet_aton: the final part fills all the bytes the leading single-byte parts didn't.
  const last = nums.pop()!;
  let value = 0;
  for (const n of nums) {
    if (n > 0xff) return undefined;
    value = value * 256 + n;
  }
  const remaining = 4 - nums.length; // bytes the last part must fill
  if (last > 2 ** (8 * remaining) - 1) return undefined;
  value = value * 2 ** (8 * remaining) + last;
  if (value < 0 || value > 0xffffffff) return undefined;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

/** True if a hostname OR resolved IP literal points at a private/internal address. */
function isBlocked(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(h)) return true;
  if (isPrivateV4(h)) return true;
  // Numeric-encoded IPv4 (decimal/hex/octal/short) that decodes into a private range — block by the
  // literal, before any DNS step, so e.g. http://2130706433/ (=127.0.0.1) never connects.
  const decoded = numericV4ToDotted(h);
  if (decoded && isPrivateV4(decoded)) return true;
  // IPv6 loopback / ULA (fc00::/7 → fc,fd) / link-local (fe80::/10).
  if (h === '::1' || /^f[cd]/.test(h) || /^fe80:/.test(h)) return true;
  // IPv4-mapped IPv6 (::ffff:… — Node may normalize the embedded v4 to hex): block the whole class,
  // since mapped addresses are essentially never needed for a legitimate public fetch.
  if (h.startsWith('::ffff:')) return true;
  return false;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function contentTypeValue(header: string): string {
  return header.split(';', 1)[0].trim().toLowerCase();
}

/** Whether a declared type is one the text-only fetch tool can safely interpret in this release. */
function isTextualContentType(type: string): boolean {
  return type === ''
    || type.startsWith('text/')
    || type === 'application/json'
    || type.endsWith('+json')
    || type === 'application/javascript'
    || type === 'application/xml'
    || type.endsWith('+xml');
}

function declaredLengthIsTooLarge(value: string | null, maxBytes: number): boolean {
  if (!value || !/^\d+$/.test(value.trim())) return false;
  const length = Number(value);
  return Number.isSafeInteger(length) && length > maxBytes;
}

/** Read a WHATWG response stream without ever materialising an unbounded string. */
async function readBoundedBody(response: Response, controller: AbortController, maxBytes: number): Promise<Uint8Array | undefined> {
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Both cancellation mechanisms matter: cancel asks the stream producer to stop, while abort
        // stops a fetch-backed body on runtimes that keep pulling after a reader is cancelled.
        await reader.cancel('response body exceeds safety limit').catch(() => undefined);
        controller.abort();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Resolve a hostname to its IPs. Injectable so tests don't hit the network. */
export type HostResolver = (hostname: string) => Promise<string[]>;
const defaultResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((r) => r.address);

export interface WebFetchOptions {
  signal?: AbortSignal;
  /** Override DNS resolution (tests). Defaults to dns.lookup. */
  resolve?: HostResolver;
  /** Higher only for a host-owned binary asset store; text output remains capped by the default. */
  maxBodyBytes?: number;
  /** PDF bytes can be handed only to the host-owned temporary asset store, never to model text. */
  onPdf?: (bytes: Uint8Array, declaredContentType: string) => Promise<string>;
  /** Image bytes can be handed only to the host-owned temporary asset store, never to model text. */
  onImage?: (bytes: Uint8Array, declaredContentType: string) => Promise<string>;
}

/** Block if the host's DNS records resolve to a private/internal address (anti-rebinding). DNS
 *  failures are NOT treated as blocked — fetch will surface the real error. */
async function resolvesToPrivate(hostname: string, resolve: HostResolver): Promise<boolean> {
  try {
    const ips = await resolve(hostname);
    return ips.some((ip) => isBlocked(ip));
  } catch {
    return false;
  }
}

/**
 * Fetch a public http/https URL and return its text (HTML stripped, JSON as-is), capped & timed out.
 * SSRF-guarded: rejects private/internal hosts by literal (incl. decimal/hex/octal IPv4 encodings)
 * AND by DNS resolution, and follows redirects MANUALLY so every hop is re-validated (a public URL
 * can't 302 into the internal network).
 *
 * KNOWN RESIDUAL (TOCTOU): we resolve DNS to validate, then fetch() resolves again at connect time —
 * a hostname could in theory rebind between the two. Closing it fully needs pinning the validated IP
 * onto the connection (a custom agent/lookup), which Node's global fetch doesn't expose cleanly. The
 * literal + DNS checks block the practical cases; tracked in BACKLOG 10b.
 */
export async function webFetch(url: string, opts: WebFetchOptions = {}): Promise<string> {
  const resolve = opts.resolve ?? defaultResolver;
  const maxBodyBytes = typeof opts.maxBodyBytes === 'number' && Number.isFinite(opts.maxBodyBytes)
    ? Math.max(1, opts.maxBodyBytes)
    : WEB_FETCH_MAX_BODY_BYTES;
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return 'Error: Invalid URL';
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      return 'Error: URL not allowed';
    }
    if (isBlocked(current.hostname)) {
      return 'Error: URL not allowed - private network';
    }
    if (await resolvesToPrivate(current.hostname, resolve)) {
      return 'Error: URL not allowed - resolves to a private network';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const abortFromCaller = () => controller.abort();
    if (opts.signal?.aborted) {
      controller.abort();
    } else {
      opts.signal?.addEventListener('abort', abortFromCaller, { once: true });
    }
    const cleanupRequest = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abortFromCaller);
    };

    let response: Response;
    try {
      response = await fetch(current.toString(), { signal: controller.signal, redirect: 'manual' });
    } catch (err: any) {
      cleanupRequest();
      if (controller.signal.aborted) {
        return 'Error: Request timed out';
      }
      return `Error: ${err?.message ?? err}`;
    }

    try {
      // Follow redirects ourselves so the next hop goes through the same SSRF checks.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return `Error: HTTP ${response.status}`;
        }
        try {
          current = new URL(location, current);
        } catch {
          return 'Error: Invalid redirect target';
        }
        continue;
      }

      if (!response.ok) return `Error: HTTP ${response.status}`;
      const contentType = contentTypeValue(response.headers.get('content-type') ?? '');
      // A response must be classified before its body is touched. This makes a PDF/image response a
      // clean, context-free error instead of a large mojibake string in the conversation history.
      const declaredPdf = contentType === 'application/pdf' || contentType === 'application/x-pdf';
      const declaredImage = contentType === 'image/png' || contentType === 'image/jpeg' || contentType === 'image/webp' || contentType === 'image/gif';
      if (contentType.startsWith('video/')) return VIDEO_UNSUPPORTED_ERROR;
      if (!isTextualContentType(contentType) && !declaredPdf && !declaredImage) return UNSAFE_BINARY_ERROR;
      if (declaredLengthIsTooLarge(response.headers.get('content-length'), maxBodyBytes)) {
        return `Error: Response body exceeds the ${maxBodyBytes}-byte safety limit. No bytes were added to context.`;
      }

      const bytes = await readBoundedBody(response, controller, maxBodyBytes);
      if (!bytes) {
        return `Error: Response body exceeds the ${maxBodyBytes}-byte safety limit. No bytes were added to context.`;
      }
      // The same sniffer the workspace reader and the attachment path use. Content-Type is metadata the
      // remote server controls, so it is never the only binary boundary — and there is one verdict for a
      // given set of bytes rather than one per entrance.
      const sniff = sniffContent(bytes);
      if (sniff.label === 'PDF') {
        return opts.onPdf ? await opts.onPdf(bytes, contentType) : UNSAFE_BINARY_ERROR;
      }
      if (sniff.label?.includes('video')) return VIDEO_UNSUPPORTED_ERROR;
      if (imageMimeFromBytes(bytes)) {
        return opts.onImage ? await opts.onImage(bytes, contentType) : UNSAFE_BINARY_ERROR;
      }
      // A server calling ordinary bytes PDF is not enough. The magic header must agree before a parser sees
      // them; otherwise this stays on the existing binary refusal path.
      if (declaredPdf || declaredImage || sniff.binary) return UNSAFE_BINARY_ERROR;

      const decoded = decodeUtf8Strict(bytes);
      if (decoded === undefined) return UNSAFE_BINARY_ERROR;
      const text = decoded;
      let output = contentType.includes('json') ? text : stripHtml(text);
      if (output.length > WEB_FETCH_MAX_OUTPUT) {
        output = output.slice(0, WEB_FETCH_MAX_OUTPUT);
      }
      return output;
    } catch (err: any) {
      if (controller.signal.aborted) {
        return 'Error: Request timed out';
      }
      return `Error: ${err?.message ?? err}`;
    } finally {
      // The deadline covers the body, not only response headers. A server that sends headers and then
      // stalls must not hold fetch_url (or a PDF intake) open forever.
      cleanupRequest();
    }
  }

  return 'Error: Too many redirects';
}
