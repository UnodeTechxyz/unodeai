/*---------------------------------------------------------------------------------------------
 * The bounded download of one pinned CLI artifact. In-process fetch only: no child process, no package manager,
 * no installer script.
 *
 * The URLs come only from the policy entry and are tried in order. Every request, the first and every redirect, is
 * `https:` to a host of those URLs or of the entry's redirect hosts, with no userinfo, no IP-literal host and no port.
 * Redirects are followed here, never by fetch, and at most three of them. No cookie, `Authorization` or API key is
 * sent. The exact size and SHA-256 are known before the first byte: a `Content-Length` other than the size is refused
 * before the body is read, the stream is cut at size + 1 bytes, a short body is refused, and a digest mismatch removes
 * the file and is never retried. Five minutes in total, and 30 seconds without a byte ends it. The caller's
 * `shouldContinue` is asked between the phases and every five seconds; `false` cancels. Every diagnostic names a host
 * and a path, never a query string: signed asset URLs carry tokens. vscode-free.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import { isIP } from 'net';
import * as path from 'path';

export const DOWNLOAD_LIMITS = {
  totalMs: 5 * 60_000,
  stallMs: 30_000,
  continueCheckMs: 5_000,
  maxRedirects: 3,
  /** The policy bound on an artifact; the validator holds entries to it, and the download checks it again. */
  maxArtifactBytes: 512 * 1024 * 1024,
} as const;

/**
 * Why a download failed. The scheduler retries by class: `network`, `http` and `timeout` may be tried again later;
 * `integrity` (unexpected bytes) never is.
 * - `network`: the connection or the body failed.
 * - `http`: a status, or a response form, that is not a plain 200 with the artifact.
 * - `refused-url`: a scheme, host, userinfo, IP literal, port or redirect bound refused a request before it was sent.
 * - `size`: a `Content-Length` other than the size, a missing one, or a body longer or shorter than the size.
 * - `integrity`: the bytes have the right size and another SHA-256.
 * - `timeout`: five minutes in total, or 30 seconds without a byte.
 * - `cancelled`: the signal, or `shouldContinue` said no.
 * - `file`: the target file could not be created or written (it existed, for one).
 */
export type DownloadFailureClass = 'network' | 'http' | 'refused-url' | 'size' | 'integrity' | 'timeout' | 'cancelled' | 'file';

/** The response fields the download reads. The global fetch's `Response` has them. */
export interface DownloadResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  /** True when fetch followed a redirect itself, which `redirect: 'manual'` must prevent. */
  redirected?: boolean;
  url?: string;
}

export interface DownloadRequestInit {
  method: 'GET';
  redirect: 'manual';
  credentials: 'omit';
  headers: Record<string, string>;
  signal: AbortSignal;
}

export type DownloadFetch = (url: string, init: DownloadRequestInit) => Promise<DownloadResponse>;

export interface DownloadTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DownloadFiles {
  open(file: string, flags: 'wx'): Promise<fsp.FileHandle>;
  rm(file: string, options: { force: true }): Promise<void>;
}

export interface BoundedDownloadRequest {
  /** The entry's URLs, tried in order. */
  urls: readonly string[];
  /** The hosts a redirect may lead to, besides the hosts of `urls`. */
  redirectHosts: readonly string[];
  /** The artifact's exact size in bytes. */
  size: number;
  /** The artifact's SHA-256, hex. */
  sha256: string;
  /** An absolute path. It is created with `wx`; the caller owns its folder. */
  targetPath: string;
  /** Cancels the download, for example at shutdown. */
  signal: AbortSignal;
  /** Asked between the phases and every five seconds: false (or a throw) cancels the download. */
  shouldContinue: () => boolean | Promise<boolean>;
  onProgress?: (receivedBytes: number, size: number) => void;
  /** Every line names hosts and paths only. */
  log?: (line: string) => void;
}

export interface BoundedDownloadDeps {
  /** Default: the global fetch. */
  fetch?: DownloadFetch;
  timers?: DownloadTimers;
  files?: DownloadFiles;
}

export interface DownloadAttempt {
  /** The URL tried, as host and path. */
  url: string;
  /** The redirects followed on this attempt. */
  redirects: number;
  failure?: DownloadFailureClass;
  reason?: string;
}

export type BoundedDownloadResult =
  | { ok: true; bytes: number; sha256: string; servedBy: string; attempts: DownloadAttempt[]; elapsedMs: number }
  | {
      ok: false;
      failure: DownloadFailureClass;
      reason: string;
      attempts: DownloadAttempt[];
      /** True only when the target file this download created could not be removed. */
      targetLeft: boolean;
      elapsedMs: number;
    };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** The only request header. Asking for the identity encoding keeps `Content-Length` the artifact's own size. */
const REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'accept-encoding': 'identity' });
/** Thrown inside the download when it was halted (cancelled or timed out); the halt holds the reason. */
const HALTED = Symbol('halted');

class AttemptFailure extends Error {
  constructor(readonly failure: DownloadFailureClass, readonly reason: string) {
    super(reason);
  }
}

/** A URL as host and path, for every diagnostic: never a query string, a fragment or userinfo. */
export function downloadUrlLabel(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '(not a URL)';
  }
}

/** Why a request to this URL is refused before it is sent, or undefined when it may be sent. */
export function refusedDownloadUrl(url: URL, allowedHosts: ReadonlySet<string>): string | undefined {
  if (url.protocol !== 'https:') return 'is not https';
  if (url.username !== '' || url.password !== '') return 'carries userinfo';
  if (url.port !== '') return 'names a port';
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) return 'has an IP-literal host';
  if (!allowedHosts.has(url.hostname.toLowerCase())) return 'has a host the entry does not list';
  return undefined;
}

function checkRequest(request: BoundedDownloadRequest): void {
  if (!Array.isArray(request.urls) || request.urls.length === 0) throw new TypeError('A download needs at least one URL.');
  if (!Number.isSafeInteger(request.size) || request.size <= 0 || request.size > DOWNLOAD_LIMITS.maxArtifactBytes) {
    throw new TypeError('A download needs a positive size within the artifact bound.');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(request.sha256)) throw new TypeError('A download needs a SHA-256 in hex.');
  if (!path.isAbsolute(request.targetPath)) throw new TypeError('A download needs an absolute target path.');
  if (typeof request.shouldContinue !== 'function') throw new TypeError('A download needs shouldContinue.');
}

function defaultTimers(): DownloadTimers {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function globalFetch(): DownloadFetch {
  return (url, init) => {
    const fetchFn = (globalThis as { fetch?: (url: string, init: DownloadRequestInit) => Promise<DownloadResponse> }).fetch;
    if (typeof fetchFn !== 'function') return Promise.reject(new Error('fetch is not available'));
    return fetchFn(url, init);
  };
}

/** An error code such as `ECONNRESET`, never a message: messages can quote the URL. */
function errorCode(error: unknown): string | undefined {
  const candidate = (error as { cause?: { code?: unknown }; code?: unknown } | undefined);
  const code = candidate?.cause?.code ?? candidate?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}

/** Download the artifact to `targetPath`. Never throws for a network, file or bytes problem: the result says which. */
export async function boundedDownload(request: BoundedDownloadRequest, deps: BoundedDownloadDeps = {}): Promise<BoundedDownloadResult> {
  checkRequest(request);
  const fetchFn = deps.fetch ?? globalFetch();
  const timers = deps.timers ?? defaultTimers();
  const files: DownloadFiles = deps.files ?? fsp;
  const expected = request.sha256.toLowerCase();
  const started = timers.now();
  const attempts: DownloadAttempt[] = [];
  const allowedHosts = new Set<string>(request.redirectHosts.map((host) => host.toLowerCase()));
  for (const raw of request.urls) {
    try { allowedHosts.add(new URL(raw).hostname.toLowerCase()); } catch { /* refused when it is tried */ }
  }
  const log = (line: string): void => {
    try { request.log?.(line); } catch { /* a log line never changes the download */ }
  };

  // The halt ends the whole download: cancellation, the total time or the stall. The attempt's own controller drops
  // its connection when that attempt ends for any reason.
  const halted = new AbortController();
  let halt: { failure: DownloadFailureClass; reason: string } | undefined;
  let attemptController: AbortController | undefined;
  const stop = (failure: DownloadFailureClass, reason: string): void => {
    if (!halt) halt = { failure, reason };
    halted.abort();
    attemptController?.abort();
  };
  const onSignal = (): void => stop('cancelled', 'the download was cancelled');
  if (request.signal.aborted) onSignal();
  else request.signal.addEventListener('abort', onSignal, { once: true });

  const untilHalted = <T>(work: Promise<T>): Promise<T> => {
    work.catch(() => undefined); // a result that lost the race is never an unhandled rejection
    if (halted.signal.aborted) return Promise.reject(HALTED);
    return new Promise<T>((resolve, reject) => {
      const onHalt = (): void => reject(HALTED);
      halted.signal.addEventListener('abort', onHalt, { once: true });
      work.then(
        (value) => { halted.signal.removeEventListener('abort', onHalt); resolve(value); },
        (error) => { halted.signal.removeEventListener('abort', onHalt); reject(error); },
      );
    });
  };
  const stillWanted = async (): Promise<boolean> => {
    try {
      return (await request.shouldContinue()) === true;
    } catch {
      return false;
    }
  };
  /** A phase boundary: the caller is asked whether the download is still wanted. */
  const checkpoint = async (phase: string): Promise<void> => {
    if (halt) throw HALTED;
    if (!(await untilHalted(stillWanted()))) {
      stop('cancelled', `the download was told to stop ${phase}`);
      throw HALTED;
    }
  };

  let stallTimer: unknown;
  const armStall = (): void => {
    if (stallTimer !== undefined) timers.clearTimeout(stallTimer);
    stallTimer = timers.setTimeout(() => stop('timeout', `no data arrived for ${DOWNLOAD_LIMITS.stallMs / 1000} seconds`), DOWNLOAD_LIMITS.stallMs);
  };
  const disarmStall = (): void => {
    if (stallTimer !== undefined) timers.clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  const totalTimer = timers.setTimeout(
    () => stop('timeout', `the download took longer than ${DOWNLOAD_LIMITS.totalMs / 60_000} minutes`),
    DOWNLOAD_LIMITS.totalMs,
  );
  let continueTimer: unknown;
  let finished = false;
  const scheduleContinueCheck = (): void => {
    continueTimer = timers.setTimeout(() => {
      void stillWanted().then((wanted) => {
        if (finished) return;
        if (!wanted) stop('cancelled', 'the download was told to stop while it ran');
        else scheduleContinueCheck();
      });
    }, DOWNLOAD_LIMITS.continueCheckMs);
  };

  let handle: fsp.FileHandle | undefined;
  let created = false;
  const finish = async (outcome: BoundedDownloadResult): Promise<BoundedDownloadResult> => {
    finished = true;
    disarmStall();
    timers.clearTimeout(totalTimer);
    if (continueTimer !== undefined) timers.clearTimeout(continueTimer);
    request.signal.removeEventListener('abort', onSignal);
    attemptController?.abort();
    let result = outcome;
    try {
      await handle?.close();
    } catch (error) {
      // A file that could not be closed is not reported as downloaded.
      if (result.ok) {
        const code = errorCode(error);
        result = { ok: false, failure: 'file', reason: `the target file could not be closed${code ? ` (${code})` : ''}`, attempts, targetLeft: false, elapsedMs: result.elapsedMs };
      }
    }
    if (!result.ok && created) {
      try {
        await files.rm(request.targetPath, { force: true });
      } catch {
        return { ...result, targetLeft: true };
      }
    }
    if (!result.ok) log(`download failed (${result.failure}): ${result.reason}`);
    return result;
  };
  const failed = (failure: DownloadFailureClass, reason: string): Promise<BoundedDownloadResult> =>
    finish({ ok: false, failure, reason, attempts, targetLeft: false, elapsedMs: timers.now() - started });

  try {
    await checkpoint('before it started');
    // Not raced against the halt: an open that finished after the race would leave a file nobody reports.
    try {
      handle = await files.open(request.targetPath, 'wx');
      created = true;
    } catch (error) {
      return await failed('file', `the target file could not be created${errorCode(error) ? ` (${errorCode(error)})` : ''}`);
    }
    if (halt) throw HALTED;
    scheduleContinueCheck();

    let last: AttemptFailure | undefined;
    for (const raw of request.urls) {
      const attempt: DownloadAttempt = { url: downloadUrlLabel(raw), redirects: 0 };
      attempts.push(attempt);
      try {
        const done = await downloadFrom(raw, attempt);
        await checkpoint('after the body arrived');
        return await finish({ ok: true, bytes: done.bytes, sha256: done.sha256, servedBy: done.servedBy, attempts, elapsedMs: timers.now() - started });
      } catch (error) {
        if (error === HALTED || halt) throw HALTED;
        last = error instanceof AttemptFailure ? error : new AttemptFailure('network', 'the download failed');
        attempt.failure = last.failure;
        attempt.reason = last.reason;
        log(`attempt failed (${last.failure}): ${last.reason}`);
        // Only a network or HTTP failure may move to the next URL; any other ends the download.
        if (last.failure !== 'network' && last.failure !== 'http') break;
      }
    }
    return await failed(last?.failure ?? 'network', last?.reason ?? 'no URL could be tried');
  } catch (error) {
    if (error === HALTED || halt) {
      const reason = halt ?? { failure: 'cancelled' as const, reason: 'the download was cancelled' };
      const current = attempts[attempts.length - 1];
      if (current && !current.failure) {
        current.failure = reason.failure;
        current.reason = reason.reason;
      }
      return await failed(reason.failure, reason.reason);
    }
    return await failed('network', 'the download failed');
  }

  /** One URL with its redirects. Throws AttemptFailure, or HALTED. */
  async function downloadFrom(raw: string, attempt: DownloadAttempt): Promise<{ bytes: number; sha256: string; servedBy: string }> {
    let current: URL;
    try {
      current = new URL(raw);
    } catch {
      throw new AttemptFailure('refused-url', 'an entry URL is not a URL');
    }
    for (;;) {
      current.hash = '';
      const refusal = refusedDownloadUrl(current, allowedHosts);
      if (refusal) throw new AttemptFailure('refused-url', `${downloadUrlLabel(current)} ${refusal}`);
      await checkpoint('before a request');
      attemptController?.abort();
      const controller = new AbortController();
      attemptController = controller;
      if (halted.signal.aborted) controller.abort();
      log(`GET ${downloadUrlLabel(current)}`);
      armStall();
      let response: DownloadResponse;
      try {
        response = await untilHalted(fetchFn(current.href, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: { ...REQUEST_HEADERS },
          signal: controller.signal,
        }));
      } catch (error) {
        if (error === HALTED || halt) throw HALTED;
        const code = errorCode(error);
        throw new AttemptFailure('network', `the request to ${downloadUrlLabel(current)} failed${code ? ` (${code})` : ''}`);
      }
      const discard = (): void => {
        void response.body?.cancel().catch(() => undefined);
        controller.abort();
      };
      if (response.redirected === true || (typeof response.url === 'string' && response.url !== '' && response.url !== current.href)) {
        discard();
        throw new AttemptFailure('refused-url', `fetch followed a redirect from ${downloadUrlLabel(current)} itself`);
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        discard();
        if (attempt.redirects >= DOWNLOAD_LIMITS.maxRedirects) {
          throw new AttemptFailure('refused-url', `more than ${DOWNLOAD_LIMITS.maxRedirects} redirects from ${attempt.url}`);
        }
        const location = response.headers.get('location');
        let next: URL;
        try {
          if (!location) throw new Error('no location');
          next = new URL(location, current);
        } catch {
          throw new AttemptFailure('refused-url', `a redirect from ${downloadUrlLabel(current)} has no usable location`);
        }
        attempt.redirects++;
        log(`redirect ${response.status} from ${downloadUrlLabel(current)} to ${downloadUrlLabel(next)}`);
        current = next;
        continue;
      }
      if (response.status !== 200) {
        discard();
        throw new AttemptFailure('http', `${downloadUrlLabel(current)} answered HTTP ${response.status}`);
      }
      const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
      if (encoding !== '' && encoding !== 'identity') {
        discard();
        throw new AttemptFailure('http', `${downloadUrlLabel(current)} sent an encoded body`);
      }
      const declared = (response.headers.get('content-length') ?? '').trim();
      if (!/^\d{1,16}$/.test(declared) || Number(declared) !== request.size) {
        discard();
        throw new AttemptFailure('size', declared === ''
          ? `${downloadUrlLabel(current)} sent no Content-Length`
          : `${downloadUrlLabel(current)} declared a size other than the artifact's`);
      }
      await checkpoint('after the response headers');
      const result = await readBody(response, controller, current);
      return { ...result, servedBy: downloadUrlLabel(current) };
    }
  }

  /** Streams the body into the target with an incremental SHA-256. Throws AttemptFailure, or HALTED. */
  async function readBody(response: DownloadResponse, controller: AbortController, from: URL): Promise<{ bytes: number; sha256: string }> {
    const target = handle as fsp.FileHandle;
    // An earlier attempt may have written part of a body: every attempt starts from an empty file.
    try {
      await target.truncate(0);
    } catch (error) {
      throw new AttemptFailure('file', `the target file could not be emptied${errorCode(error) ? ` (${errorCode(error)})` : ''}`);
    }
    const hash = createHash('sha256');
    let received = 0;
    const reader = response.body?.getReader();
    try {
      for (;;) {
        if (!reader) break;
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await untilHalted(reader.read());
        } catch (error) {
          if (error === HALTED || halt) throw HALTED;
          const code = errorCode(error);
          throw new AttemptFailure('network', `the body from ${downloadUrlLabel(from)} failed${code ? ` (${code})` : ''}`);
        }
        if (chunk.done) break;
        const value = chunk.value;
        if (!value || value.byteLength === 0) continue;
        if (received + value.byteLength > request.size) {
          throw new AttemptFailure('size', `${downloadUrlLabel(from)} sent more than the artifact's size`);
        }
        hash.update(value);
        try {
          let written = 0;
          while (written < value.byteLength) {
            const { bytesWritten } = await target.write(value, written, value.byteLength - written, received + written);
            if (bytesWritten <= 0) throw new Error('nothing written');
            written += bytesWritten;
          }
        } catch (error) {
          if (error === HALTED || halt) throw HALTED;
          throw new AttemptFailure('file', `the target file could not be written${errorCode(error) ? ` (${errorCode(error)})` : ''}`);
        }
        received += value.byteLength;
        armStall();
        try { request.onProgress?.(received, request.size); } catch { /* progress never changes the download */ }
      }
    } finally {
      disarmStall();
      if (reader) void reader.cancel().catch(() => undefined);
      controller.abort();
    }
    if (received < request.size) {
      throw new AttemptFailure('size', `${downloadUrlLabel(from)} sent less than the artifact's size`);
    }
    const sha256 = hash.digest('hex');
    if (sha256 !== expected) {
      throw new AttemptFailure('integrity', `the artifact from ${downloadUrlLabel(from)} has another SHA-256`);
    }
    return { bytes: received, sha256 };
  }
}
