import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  boundedDownload,
  type BoundedDownloadRequest,
  type DownloadFetch,
  type DownloadRequestInit,
  type DownloadResponse,
  type DownloadTimers,
} from '../boundedDownload';

// ADAPTER §5.3.1–§5.3.6 and Revision 5 §11 item 7: the download of one pinned artifact.

const ARTIFACT = Buffer.from(Array.from({ length: 10_000 }, (_, index) => (index * 7 + 3) % 251));
const SHA256 = createHash('sha256').update(ARTIFACT).digest('hex');
const PRIMARY = 'https://releases.openai.com/codex/releases/0.163.0/codex-package-x86_64-pc-windows-msvc.tar.gz';
const SECONDARY = 'https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-package-x86_64-pc-windows-msvc.tar.gz';
const ASSET_HOST = 'release-assets.githubusercontent.com';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function targetPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unode-download-'));
  dirs.push(dir);
  return path.join(dir, 'artifact.part');
}

interface Counter { pulled: number }

/** A body that hands out one chunk per read, so the bytes the download pulled can be counted. */
function streamOf(bytes: Uint8Array, chunk = 1000, counter?: Counter): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      const piece = bytes.subarray(at, at + chunk);
      at += piece.length;
      if (counter) counter.pulled += piece.length;
      controller.enqueue(piece);
    },
  }, { highWaterMark: 0 });
}

/** A body that sends `first` and then never sends another byte, or fails when told to. */
function stallingStream(first: Uint8Array, failWith?: unknown): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(first);
        return;
      }
      if (failWith !== undefined) {
        controller.error(failWith);
        return;
      }
      return new Promise<void>(() => undefined);
    },
  }, { highWaterMark: 0 });
}

function ok(bytes: Uint8Array, headers: Record<string, string> = {}, counter?: Counter): DownloadResponse {
  return { status: 200, headers: new Headers({ 'content-length': String(bytes.length), ...headers }), body: streamOf(bytes, 1000, counter) };
}

function redirect(location: string, status = 302, headers: Record<string, string> = {}): DownloadResponse {
  return { status, headers: new Headers({ location, ...headers }), body: null };
}

interface Call { url: string; init: DownloadRequestInit }

function fakeFetch(routes: Record<string, () => DownloadResponse | Promise<DownloadResponse>>): { fetch: DownloadFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: DownloadFetch = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return { status: 404, headers: new Headers(), body: null };
    return route();
  };
  return { fetch, calls };
}

function request(overrides: Partial<BoundedDownloadRequest> = {}): BoundedDownloadRequest {
  return {
    urls: [PRIMARY, SECONDARY],
    redirectHosts: [ASSET_HOST],
    size: ARTIFACT.length,
    sha256: SHA256,
    targetPath: targetPath(),
    signal: new AbortController().signal,
    shouldContinue: () => true,
    ...overrides,
  };
}

/** Timers the test moves by hand. Callbacks run in time order; `now` follows them. */
function manualTimers(): DownloadTimers & { advance(ms: number): void } {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = ++next;
      pending.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => { pending.delete(handle as number); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let due: [number, { at: number; callback: () => void }] | undefined;
        for (const item of pending) if (item[1].at <= end && (!due || item[1].at < due[1].at)) due = item;
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
  };
}

/**
 * Waits on real I/O (file writes) until the condition holds, for up to `UNTIL_MS` of real time. A count of event-loop
 * turns is not a bound: GitHub's Windows runner, running the whole suite, has taken more than 2000 turns to open and
 * write the target file. After the first turns it polls every few milliseconds, so the wait does not spin.
 */
const UNTIL_MS = 10_000;
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + UNTIL_MS;
  for (let turn = 0; !condition() && Date.now() < deadline; turn++) {
    await new Promise((resolve) => (turn < 2000 ? setImmediate(resolve) : setTimeout(resolve, 5)));
  }
  expect(condition()).toBe(true);
}

// Several real-I/O waits in one test can add up past the 5 s default on a slow host; each wait has its own bound.
describe('boundedDownload', { timeout: 60_000 }, () => {
  it('streams the artifact into a new file with only the identity-encoding header, no credentials and manual redirects', async () => {
    const { fetch, calls } = fakeFetch({ [PRIMARY]: () => ok(ARTIFACT) });
    const req = request();
    const progress: number[] = [];
    const result = await boundedDownload({ ...req, onProgress: (bytes) => progress.push(bytes) }, { fetch });
    expect(result).toMatchObject({ ok: true, bytes: ARTIFACT.length, sha256: SHA256, servedBy: 'releases.openai.com/codex/releases/0.163.0/codex-package-x86_64-pc-windows-msvc.tar.gz' });
    expect(fs.readFileSync(req.targetPath).equals(ARTIFACT)).toBe(true);
    expect(calls).toHaveLength(1);
    const { signal, ...init } = calls[0].init;
    expect(init).toEqual({ method: 'GET', redirect: 'manual', credentials: 'omit', headers: { 'accept-encoding': 'identity' } });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(progress[progress.length - 1]).toBe(ARTIFACT.length);
  });

  // ADAPTER §5.3.2: https only, an allowed host, no userinfo, no IP literal, no port.
  it.each([
    ['http', 'http://releases.openai.com/codex/pkg.tar.gz', 'is not https'],
    ['userinfo', 'https://user:secret@releases.openai.com/codex/pkg.tar.gz', 'carries userinfo'],
    ['a port', 'https://releases.openai.com:8443/codex/pkg.tar.gz', 'names a port'],
    ['an IPv4 literal', 'https://192.0.2.10/codex/pkg.tar.gz', 'IP-literal'],
    ['a numeric IPv4 literal', 'https://3221225994/codex/pkg.tar.gz', 'IP-literal'],
    ['an IPv6 literal', 'https://[2001:db8::1]/codex/pkg.tar.gz', 'IP-literal'],
  ])('refuses a URL with %s before any request', async (_label, url, reason) => {
    const { fetch, calls } = fakeFetch({ [url]: () => ok(ARTIFACT) });
    const req = request({ urls: [url] });
    const result = await boundedDownload(req, { fetch });
    expect(result).toMatchObject({ ok: false, failure: 'refused-url' });
    expect(result.ok === false && result.reason).toContain(reason);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(req.targetPath)).toBe(false);
  });

  it('ends the download on a refused URL without trying the next one (the conservative reading)', async () => {
    const { fetch, calls } = fakeFetch({ [SECONDARY]: () => ok(ARTIFACT) });
    const result = await boundedDownload(request({ urls: ['http://releases.openai.com/codex/pkg.tar.gz', SECONDARY] }), { fetch });
    expect(result).toMatchObject({ ok: false, failure: 'refused-url' });
    expect(calls).toHaveLength(0);
  });

  // ADAPTER §5.3.2 and §9: at most 3 redirects, each destination allowed.
  it.each([0, 1, 2, 3])('follows %i redirects across the listed hosts', async (count) => {
    const hops = [SECONDARY, `https://${ASSET_HOST}/hop/1?sig=a`, `https://${ASSET_HOST}/hop/2?sig=b`, `https://github.com/hop/3`];
    const routes: Record<string, () => DownloadResponse> = {};
    for (let index = 0; index < count; index++) routes[hops[index]] = () => redirect(hops[index + 1]);
    routes[hops[count]] = () => ok(ARTIFACT);
    const { fetch, calls } = fakeFetch(routes);
    const result = await boundedDownload(request({ urls: [SECONDARY] }), { fetch });
    expect(result).toMatchObject({ ok: true, attempts: [{ redirects: count }] });
    expect(calls.map((call) => call.url)).toEqual(hops.slice(0, count + 1));
  });

  it('refuses the fourth redirect without requesting its location', async () => {
    const hops = [SECONDARY, `https://${ASSET_HOST}/1`, `https://${ASSET_HOST}/2`, `https://${ASSET_HOST}/3`, `https://${ASSET_HOST}/4`];
    const routes: Record<string, () => DownloadResponse> = {};
    for (let index = 0; index < 4; index++) routes[hops[index]] = () => redirect(hops[index + 1], 301 + (index % 2));
    routes[hops[4]] = () => ok(ARTIFACT);
    const { fetch, calls } = fakeFetch(routes);
    const result = await boundedDownload(request({ urls: [SECONDARY] }), { fetch });
    expect(result).toMatchObject({ ok: false, failure: 'refused-url' });
    expect(result.ok === false && result.reason).toContain('more than 3 redirects');
    expect(calls.map((call) => call.url)).toEqual(hops.slice(0, 4));
  });

  it('refuses a redirect to a host the entry does not list, and never requests it', async () => {
    const { fetch, calls } = fakeFetch({
      [PRIMARY]: () => redirect('https://downloads.example.net/codex/pkg.tar.gz'),
      'https://downloads.example.net/codex/pkg.tar.gz': () => ok(ARTIFACT),
    });
    const result = await boundedDownload(request({ urls: [PRIMARY] }), { fetch });
    expect(result).toMatchObject({ ok: false, failure: 'refused-url' });
    expect(result.ok === false && result.reason).toContain('downloads.example.net/codex/pkg.tar.gz has a host the entry does not list');
    expect(calls.map((call) => call.url)).toEqual([PRIMARY]);
  });

  it.each([
    ['http', `http://${ASSET_HOST}/pkg`],
    ['userinfo', `https://token@${ASSET_HOST}/pkg`],
    ['a port', `https://${ASSET_HOST}:444/pkg`],
    ['an IP literal', 'https://192.0.2.10/pkg'],
  ])('re-checks every redirect location: %s is refused', async (_label, location) => {
    const { fetch, calls } = fakeFetch({ [PRIMARY]: () => redirect(location), [location]: () => ok(ARTIFACT) });
    const result = await boundedDownload(request({ urls: [PRIMARY], redirectHosts: [ASSET_HOST, '192.0.2.10'] }), { fetch });
    expect(result).toMatchObject({ ok: false, failure: 'refused-url' });
    expect(calls).toHaveLength(1);
  });

  it('resolves a relative location against the current URL, and allows the host of another listed URL', async () => {
    const { fetch, calls } = fakeFetch({
      [PRIMARY]: () => redirect('/codex/elsewhere/pkg.tar.gz', 307),
      'https://releases.openai.com/codex/elsewhere/pkg.tar.gz': () => redirect('https://github.com/openai/codex/pkg.tar.gz', 308),
      'https://github.com/openai/codex/pkg.tar.gz': () => ok(ARTIFACT),
    });
    const result = await boundedDownload(request({ redirectHosts: [] }), { fetch });
    expect(result).toMatchObject({ ok: true, servedBy: 'github.com/openai/codex/pkg.tar.gz', attempts: [{ redirects: 2 }] });
    expect(calls).toHaveLength(3);
  });

  it('refuses a response that fetch reached by following a redirect itself', async () => {
    for (const response of [
      { ...ok(ARTIFACT), redirected: true },
      { ...ok(ARTIFACT), url: 'https://downloads.example.net/codex/pkg.tar.gz' },
    ]) {
      const { fetch } = fakeFetch({ [PRIMARY]: () => response });
      const result = await boundedDownload(request({ urls: [PRIMARY] }), { fetch });
      expect(result).toMatchObject({ ok: false, failure: 'refused-url' });
    }
  });

  // ADAPTER §5.3.4: a Content-Length other than the size is refused before the body is read.
  it.each([
    ['one byte more', { 'content-length': String(ARTIFACT.length + 1) }],
    ['one byte less', { 'content-length': String(ARTIFACT.length - 1) }],
    ['two values', { 'content-length': `${ARTIFACT.length}, ${ARTIFACT.length}` }],
  ])('refuses a Content-Length of %s before reading the body', async (_label, headers) => {
    const counter = { pulled: 0 };
    const response: DownloadResponse = { status: 200, headers: new Headers(headers), body: streamOf(ARTIFACT, 1000, counter) };
    const { fetch, calls } = fakeFetch({ [PRIMARY]: () => response, [SECONDARY]: () => ok(ARTIFACT) });
    const req = request();
    const result = await boundedDownload(req, { fetch });
    expect(result).toMatchObject({ ok: false, failure: 'size' });
    expect(counter.pulled).toBe(0);
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(req.targetPath)).toBe(false);
  });

  it('refuses a missing Content-Length before reading the body (the conservative reading; the design does not decide)', async () => {
    const counter = { pulled: 0 };
    const response: DownloadResponse = { status: 200, headers: new Headers(), body: streamOf(ARTIFACT, 1000, counter) };
    const { fetch } = fakeFetch({ [PRIMARY]: () => response });
    const result = await boundedDownload(request({ urls: [PRIMARY] }), { fetch });
    expect(result).toMatchObject({ ok: false, failure: 'size', reason: expect.stringContaining('no Content-Length') });
    expect(counter.pulled).toBe(0);
  });

  it('cuts the stream at size + 1 bytes', async () => {
    const counter = { pulled: 0 };
    const long = Buffer.concat([ARTIFACT, ARTIFACT, ARTIFACT, ARTIFACT]);
    const response: DownloadResponse = { status: 200, headers: new Headers({ 'content-length': String(ARTIFACT.length) }), body: streamOf(long, 1000, counter) };
    const { fetch } = fakeFetch({ [PRIMARY]: () => response });
    const req = request({ urls: [PRIMARY] });
    const result = await boundedDownload(req, { fetch });
    expect(result).toMatchObject({ ok: false, failure: 'size', reason: expect.stringContaining('more than') });
    expect(counter.pulled).toBe(ARTIFACT.length + 1000);
    expect(fs.existsSync(req.targetPath)).toBe(false);
  });

  it('refuses a short body', async () => {
    const short = ARTIFACT.subarray(0, ARTIFACT.length - 1);
    const response: DownloadResponse = { status: 200, headers: new Headers({ 'content-length': String(ARTIFACT.length) }), body: streamOf(short) };
    const { fetch } = fakeFetch({ [PRIMARY]: () => response });
    const req = request({ urls: [PRIMARY] });
    const result = await boundedDownload(req, { fetch });
    expect(result).toMatchObject({ ok: false, failure: 'size', reason: expect.stringContaining('less than') });
    expect(fs.existsSync(req.targetPath)).toBe(false);
  });

  // ADAPTER §5.3.6 and §5.10: a mismatch removes the file and is never retried.
  it('removes the file on a digest mismatch and does not try the next URL', async () => {
    const other = Buffer.from(ARTIFACT);
    other[5000] ^= 0xff;
    const { fetch, calls } = fakeFetch({ [PRIMARY]: () => ok(other), [SECONDARY]: () => ok(ARTIFACT) });
    const req = request();
    const result = await boundedDownload(req, { fetch });
    expect(result).toMatchObject({ ok: false, failure: 'integrity', targetLeft: false });
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(req.targetPath)).toBe(false);
  });

  it('moves to the next URL after a network failure, starting from an empty file', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    for (const first of [
      () => Promise.reject(reset),
      () => ({ status: 200, headers: new Headers({ 'content-length': String(ARTIFACT.length) }), body: stallingStream(ARTIFACT.subarray(0, 3000), reset) }),
    ]) {
      const { fetch, calls } = fakeFetch({ [PRIMARY]: first, [SECONDARY]: () => ok(ARTIFACT) });
      const req = request();
      const result = await boundedDownload(req, { fetch });
      expect(result).toMatchObject({ ok: true, attempts: [{ failure: 'network', reason: expect.stringContaining('ECONNRESET') }, {}] });
      expect(calls).toHaveLength(2);
      expect(fs.readFileSync(req.targetPath).equals(ARTIFACT)).toBe(true);
    }
  });

  it('moves to the next URL after an HTTP failure, and reports the last failure when every URL fails', async () => {
    const first = fakeFetch({ [PRIMARY]: () => ({ status: 503, headers: new Headers(), body: null }), [SECONDARY]: () => ok(ARTIFACT) });
    expect(await boundedDownload(request(), { fetch: first.fetch })).toMatchObject({ ok: true, attempts: [{ failure: 'http' }, {}] });
    const both = fakeFetch({ [PRIMARY]: () => ({ status: 500, headers: new Headers(), body: null }) });
    const req = request();
    const result = await boundedDownload(req, { fetch: both.fetch });
    expect(result).toMatchObject({ ok: false, failure: 'http', reason: expect.stringContaining('HTTP 404') });
    expect(fs.existsSync(req.targetPath)).toBe(false);
  });

  it('refuses a status other than 200 and an encoded body', async () => {
    for (const response of [
      { status: 206, headers: new Headers({ 'content-length': String(ARTIFACT.length) }), body: streamOf(ARTIFACT) },
      ok(ARTIFACT, { 'content-encoding': 'gzip' }),
    ]) {
      const { fetch } = fakeFetch({ [PRIMARY]: () => response });
      expect(await boundedDownload(request({ urls: [PRIMARY] }), { fetch })).toMatchObject({ ok: false, failure: 'http' });
    }
  });

  // ADAPTER §5.3.5: cancelled after 30 s without progress.
  it('ends the download after 30 seconds without a byte, and not before', async () => {
    const timers = manualTimers();
    let received = 0;
    const response: DownloadResponse = { status: 200, headers: new Headers({ 'content-length': String(ARTIFACT.length) }), body: stallingStream(ARTIFACT.subarray(0, 4000)) };
    const { fetch, calls } = fakeFetch({ [PRIMARY]: () => response, [SECONDARY]: () => ok(ARTIFACT) });
    const req = request();
    let settled: unknown;
    const pending = boundedDownload({ ...req, onProgress: (bytes) => { received = bytes; } }, { fetch, timers }).then((result) => { settled = result; });
    await until(() => received === 4000);
    timers.advance(29_999);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBeUndefined();
    timers.advance(1);
    await pending;
    expect(settled).toMatchObject({ ok: false, failure: 'timeout', reason: 'no data arrived for 30 seconds' });
    // The stall ends the download; the next URL is not tried (the conservative reading).
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(req.targetPath)).toBe(false);
  });

  it('counts the wait for the response headers as no progress', async () => {
    const timers = manualTimers();
    let asked = false;
    const fetch: DownloadFetch = () => {
      asked = true;
      return new Promise<DownloadResponse>(() => undefined);
    };
    const pending = boundedDownload(request(), { fetch, timers });
    await until(() => asked);
    timers.advance(30_000);
    expect(await pending).toMatchObject({ ok: false, failure: 'timeout' });
  });

  // ADAPTER §5.3.5: 5 min in total.
  it('ends the download after 5 minutes in total even while bytes keep arriving', async () => {
    const timers = manualTimers();
    let received = 0;
    let at = 0;
    let pulls = 0;
    const slow = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        return new Promise<void>((resolve) => {
          timers.setTimeout(() => {
            controller.enqueue(ARTIFACT.subarray(at, at + 10));
            at += 10;
            resolve();
          }, 20_000);
        });
      },
    }, { highWaterMark: 0 });
    const response: DownloadResponse = { status: 200, headers: new Headers({ 'content-length': String(ARTIFACT.length) }), body: slow };
    const { fetch } = fakeFetch({ [PRIMARY]: () => response });
    let settled: unknown;
    const pending = boundedDownload({ ...request({ urls: [PRIMARY] }), onProgress: (bytes) => { received = bytes; } }, { fetch, timers })
      .then((result) => { settled = result; });
    // Each step waits until the stream has asked for its next chunk, so that chunk's timer exists before time moves.
    await until(() => pulls === 1);
    for (let step = 1; step < 15; step++) {
      timers.advance(20_000);
      await until(() => received === step * 10 && pulls === step + 1);
    }
    expect(settled).toBeUndefined();
    timers.advance(20_000);
    await pending;
    expect(settled).toMatchObject({ ok: false, failure: 'timeout', reason: 'the download took longer than 5 minutes' });
  });

  // ADAPTER §5.3.7 as replaced by Revision 5 §7.2: the task's check, every 5 s and between phases.
  it('cancels when shouldContinue turns false during the body, at the next five-second check', async () => {
    const timers = manualTimers();
    let received = 0;
    let wanted = true;
    const response: DownloadResponse = { status: 200, headers: new Headers({ 'content-length': String(ARTIFACT.length) }), body: stallingStream(ARTIFACT.subarray(0, 2000)) };
    const { fetch } = fakeFetch({ [PRIMARY]: () => response });
    const req = request({ urls: [PRIMARY], shouldContinue: () => wanted });
    let settled: unknown;
    const pending = boundedDownload({ ...req, onProgress: (bytes) => { received = bytes; } }, { fetch, timers }).then((result) => { settled = result; });
    await until(() => received === 2000);
    timers.advance(4_000);
    wanted = false;
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBeUndefined();
    timers.advance(1_000);
    await pending;
    expect(settled).toMatchObject({ ok: false, failure: 'cancelled', reason: expect.stringContaining('told to stop') });
    expect(fs.existsSync(req.targetPath)).toBe(false);
  });

  it('asks shouldContinue before the first request and after the response headers', async () => {
    const before = fakeFetch({ [PRIMARY]: () => ok(ARTIFACT) });
    const req = request({ shouldContinue: () => false });
    expect(await boundedDownload(req, { fetch: before.fetch })).toMatchObject({ ok: false, failure: 'cancelled' });
    expect(before.calls).toHaveLength(0);
    expect(fs.existsSync(req.targetPath)).toBe(false);

    // Asked before it starts, before the request, then after the headers: the third answer is no.
    let asked = 0;
    const counter = { pulled: 0 };
    const after = fakeFetch({ [PRIMARY]: () => ok(ARTIFACT, {}, counter) });
    expect(await boundedDownload(request({ shouldContinue: () => ++asked < 3 }), { fetch: after.fetch }))
      .toMatchObject({ ok: false, failure: 'cancelled', reason: expect.stringContaining('after the response headers') });
    expect(counter.pulled).toBe(0);

    const throwing = fakeFetch({ [PRIMARY]: () => ok(ARTIFACT) });
    expect(await boundedDownload(request({ shouldContinue: () => { throw new Error('manifest unreadable'); } }), { fetch: throwing.fetch }))
      .toMatchObject({ ok: false, failure: 'cancelled' });
    expect(throwing.calls).toHaveLength(0);
  });

  // ADAPTER §5.12.1: shutdown aborts the fetch.
  it('cancels on the abort signal, during the body and before anything starts', async () => {
    const controller = new AbortController();
    let received = 0;
    const response: DownloadResponse = { status: 200, headers: new Headers({ 'content-length': String(ARTIFACT.length) }), body: stallingStream(ARTIFACT.subarray(0, 1000)) };
    const { fetch } = fakeFetch({ [PRIMARY]: () => response });
    const req = request({ signal: controller.signal });
    const pending = boundedDownload({ ...req, onProgress: (bytes) => { received = bytes; } }, { fetch });
    await until(() => received === 1000);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, failure: 'cancelled', reason: 'the download was cancelled' });
    expect(fs.existsSync(req.targetPath)).toBe(false);

    const early = fakeFetch({ [PRIMARY]: () => ok(ARTIFACT) });
    const aborted = new AbortController();
    aborted.abort();
    const earlyReq = request({ signal: aborted.signal });
    expect(await boundedDownload(earlyReq, { fetch: early.fetch })).toMatchObject({ ok: false, failure: 'cancelled' });
    expect(early.calls).toHaveLength(0);
    expect(fs.existsSync(earlyReq.targetPath)).toBe(false);
  });

  // ADAPTER §5.3.2: no cookies, no Authorization and no API key, on every hop.
  it('sends no cookie, Authorization or API key on any hop, even after a response sets a cookie', async () => {
    const { fetch, calls } = fakeFetch({
      [SECONDARY]: () => redirect(`https://${ASSET_HOST}/a`, 302, { 'set-cookie': 'session=abc', 'www-authenticate': 'Bearer' }),
      [`https://${ASSET_HOST}/a`]: () => redirect(`https://${ASSET_HOST}/b`, 302, { 'set-cookie': 'other=def' }),
      [`https://${ASSET_HOST}/b`]: () => ok(ARTIFACT),
    });
    expect(await boundedDownload(request({ urls: [SECONDARY] }), { fetch })).toMatchObject({ ok: true });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init.headers).toEqual({ 'accept-encoding': 'identity' });
      expect(call.init.credentials).toBe('omit');
    }
  });

  // ADAPTER §5.3.2: logs hold the host and path only; signed asset URLs carry tokens.
  it('names hosts and paths only, never a query string, in every log line, attempt and reason', async () => {
    const first = `${PRIMARY}?token=SECRET-ONE`;
    const second = `${SECONDARY}?X-Amz-Signature=SECRET-TWO`;
    const asset = `https://${ASSET_HOST}/github-production-release-asset/pkg?sig=SECRET-THREE&sp=r`;
    const other = Buffer.from(ARTIFACT);
    other[0] ^= 1;
    const { fetch } = fakeFetch({
      [first]: () => Promise.reject(new TypeError(`request to ${first} failed`)),
      [second]: () => redirect(asset),
      [asset]: () => ok(other),
    });
    const lines: string[] = [];
    const result = await boundedDownload(request({ urls: [first, second], log: (line) => lines.push(line) }), { fetch });
    expect(result).toMatchObject({ ok: false, failure: 'integrity' });
    const everything = JSON.stringify({ lines, result });
    expect(lines.length).toBeGreaterThan(3);
    expect(everything).not.toMatch(/SECRET|\?/);
    expect(everything).toContain(`${ASSET_HOST}/github-production-release-asset/pkg`);
  });

  it('creates the target with wx: an existing file fails before any request and is left as it was', async () => {
    const { fetch, calls } = fakeFetch({ [PRIMARY]: () => ok(ARTIFACT) });
    const req = request();
    fs.writeFileSync(req.targetPath, 'mine');
    expect(await boundedDownload(req, { fetch })).toMatchObject({ ok: false, failure: 'file', reason: expect.stringContaining('EEXIST') });
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(req.targetPath, 'utf8')).toBe('mine');
  });

  it('does not report a target that could not be closed as downloaded, and removes it', async () => {
    const { fetch } = fakeFetch({ [PRIMARY]: () => ok(ARTIFACT) });
    const req = request();
    const files = {
      open: async (file: string, flags: 'wx') => {
        const handle = await fs.promises.open(file, flags);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          throw Object.assign(new Error('close failed'), { code: 'EIO' });
        };
        return handle;
      },
      rm: (file: string, options: { force: true }) => fs.promises.rm(file, options),
    };
    expect(await boundedDownload(req, { fetch, files })).toMatchObject({ ok: false, failure: 'file', reason: 'the target file could not be closed (EIO)' });
    expect(fs.existsSync(req.targetPath)).toBe(false);
  });

  it('refuses a malformed request instead of downloading', async () => {
    const { fetch } = fakeFetch({});
    await expect(boundedDownload(request({ size: 512 * 1024 * 1024 + 1 }), { fetch })).rejects.toThrow(TypeError);
    await expect(boundedDownload(request({ sha256: 'abc' }), { fetch })).rejects.toThrow(TypeError);
    await expect(boundedDownload(request({ targetPath: 'relative.part' }), { fetch })).rejects.toThrow(TypeError);
    await expect(boundedDownload(request({ urls: [] }), { fetch })).rejects.toThrow(TypeError);
  });
});
