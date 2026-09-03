import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lookup } from 'dns/promises';
import { webFetch, VIDEO_UNSUPPORTED_ERROR, WEB_FETCH_MAX_BODY_BYTES, WEB_FETCH_MAX_OUTPUT, numericV4ToDotted } from '../webFetch.js';

// Mock DNS so tests never hit the network; default resolves public so example.com is allowed.
vi.mock('dns/promises', () => ({ lookup: vi.fn() }));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
});

function mockResponse(body: string, contentType: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType, ...extraHeaders },
  });
}

function streamResponse(
  chunks: Uint8Array[],
  contentType: string,
  extraHeaders: Record<string, string> = {},
): { response: Response; cancelled: ReturnType<typeof vi.fn> } {
  let index = 0;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel: cancelled,
  });
  return {
    response: new Response(body, { headers: { 'content-type': contentType, ...extraHeaders } }),
    cancelled,
  };
}

describe('webFetch', () => {
  it('strips HTML from text/html content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('<html><body><p>Hello</p></body></html>', 'text/html')
    );
    const result = await webFetch('http://example.com/');
    expect(result).toBe('Hello');
  });

  it('returns JSON as-is for application/json content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('{"a":1}', 'application/json')
    );
    const result = await webFetch('https://example.com/api');
    expect(result).toBe('{"a":1}');
  });

  it('also returns JSON as-is when content-type includes "json"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('{"b":2}', 'application/vnd.api+json')
    );
    const result = await webFetch('https://example.com/api');
    expect(result).toBe('{"b":2}');
  });

  describe('SSRF / private network blocking', () => {
    const blocked = [
      'http://localhost:8080/',
      'http://127.0.0.1/',
      'http://192.168.1.1/',
      'http://10.0.0.1/',
      'http://169.254.169.254/',
      'http://[::1]/',
      'http://0.0.0.0/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://127.0.0.2/',            // whole 127/8 loopback, not just 127.0.0.1
      'http://[fc00::1]/',            // IPv6 ULA
      'http://[fe80::1]/',            // IPv6 link-local
      'http://[::ffff:127.0.0.1]/',   // IPv4-mapped loopback
    ];

    for (const url of blocked) {
      it(`blocks ${url}`, async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(mockResponse('ok', 'text/plain'));
        const result = await webFetch(url);
        expect(result).toMatch(/^Error:/);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      });
    }
  });

  // DeepSeek follow-up (Codex review): numeric IPv4 encodings of 127.0.0.1 must be blocked by the
  // literal, not left to platform DNS normalization. Regression guard against future runtime changes.
  describe('SSRF: numeric IPv4 encodings of loopback', () => {
    const encoded = [
      'http://2130706433/',        // decimal
      'http://0x7f000001/',        // hex
      'http://0177.0.0.1/',        // octal first octet
      'http://127.1/',             // short form (a.d)
      'http://127.0.1/',           // short form (a.b.d)
    ];
    for (const url of encoded) {
      it(`blocks ${url} before any DNS/fetch`, async () => {
        // Resolver returns PUBLIC so only the literal decode can be what blocks it.
        vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
        globalThis.fetch = vi.fn().mockResolvedValue(mockResponse('ok', 'text/plain'));
        const result = await webFetch(url);
        expect(result).toMatch(/^Error:/);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      });
    }

    it('decodes encodings but leaves public numeric IPs allowed', () => {
      expect(numericV4ToDotted('2130706433')).toBe('127.0.0.1');
      expect(numericV4ToDotted('0x7f000001')).toBe('127.0.0.1');
      expect(numericV4ToDotted('0177.0.0.1')).toBe('127.0.0.1');
      expect(numericV4ToDotted('127.1')).toBe('127.0.0.1');
      expect(numericV4ToDotted('8.8.8.8')).toBe('8.8.8.8'); // public — decoded but not private
      expect(numericV4ToDotted('example.com')).toBeUndefined(); // real hostname
      expect(numericV4ToDotted('999.1')).toBeUndefined(); // out of range
    });
  });

  it('blocks file:// URLs', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse('ok', 'text/plain'));
    const result = await webFetch('file:///etc/passwd');
    expect(result).toMatch(/^Error:/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns error for invalid URL', async () => {
    globalThis.fetch = vi.fn();
    const result = await webFetch('not a url');
    expect(result).toBe('Error: Invalid URL');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('truncates output exceeding WEB_FETCH_MAX_OUTPUT', async () => {
    const longBody = 'x'.repeat(WEB_FETCH_MAX_OUTPUT + 10_000);
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse(longBody, 'text/plain')
    );
    const result = await webFetch('http://example.com/big');
    expect(result.length).toBeLessThanOrEqual(WEB_FETCH_MAX_OUTPUT);
    expect(result.length).toBe(WEB_FETCH_MAX_OUTPUT);
  });

  it('does not truncate output at exactly the limit', async () => {
    const exactBody = 'y'.repeat(WEB_FETCH_MAX_OUTPUT);
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse(exactBody, 'text/plain')
    );
    const result = await webFetch('http://example.com/exact');
    expect(result).toBe(exactBody);
  });

  describe('body safety boundary', () => {
    const binaryError = 'Error: Unsupported or unsafe binary content. No bytes were added to context.';

    it('hands a magic-confirmed PDF only to the host asset callback, never to text decoding', async () => {
      const bytes = new TextEncoder().encode('%PDF-1.7\nbody');
      const { response } = streamResponse([bytes], 'application/pdf');
      const onPdf = vi.fn(async (received: Uint8Array) => {
        expect(received).toEqual(bytes);
        return 'PDF stored as temporary asset content-1.';
      });
      globalThis.fetch = vi.fn().mockResolvedValue(response);

      expect(await webFetch('https://example.com/report.pdf', { onPdf })).toBe('PDF stored as temporary asset content-1.');
      expect(onPdf).toHaveBeenCalledTimes(1);
    });

    it('hands a magic-confirmed supported image only to the host asset callback', async () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
      const { response } = streamResponse([bytes], 'image/png');
      const onImage = vi.fn(async (received: Uint8Array) => {
        expect(received).toEqual(bytes);
        return 'Image stored as temporary asset content-1.';
      });
      globalThis.fetch = vi.fn().mockResolvedValue(response);

      expect(await webFetch('https://example.com/image.png', { onImage })).toBe('Image stored as temporary asset content-1.');
      expect(onImage).toHaveBeenCalledTimes(1);
    });

    it('does not give an image-labelled text body to the image callback', async () => {
      const { response } = streamResponse([new TextEncoder().encode('not an image')], 'image/png');
      const onImage = vi.fn(async () => 'should not run');
      globalThis.fetch = vi.fn().mockResolvedValue(response);

      expect(await webFetch('https://example.com/liar.png', { onImage })).toBe(binaryError);
      expect(onImage).not.toHaveBeenCalled();
    });

    it('states that video is unsupported without reading declared video bytes', async () => {
      const getReader = vi.fn();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { getReader },
        headers: new Headers({ 'content-type': 'video/mp4' }),
      } as unknown as Response);

      expect(await webFetch('https://example.com/clip.mp4')).toBe(VIDEO_UNSUPPORTED_ERROR);
      expect(getReader).not.toHaveBeenCalled();
    });

    it('does not give a PDF-labelled non-PDF body to the parser callback', async () => {
      const { response } = streamResponse([new TextEncoder().encode('not actually a PDF')], 'application/pdf');
      const onPdf = vi.fn(async () => 'should not run');
      globalThis.fetch = vi.fn().mockResolvedValue(response);

      expect(await webFetch('https://example.com/liar.pdf', { onPdf })).toBe(binaryError);
      expect(onPdf).not.toHaveBeenCalled();
    });

    it.each([
      ['PDF', new TextEncoder().encode('%PDF-1.7\nbody')],
      ['JPEG', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])],
    ])('refuses a falsely text/plain %s body after byte sniffing', async (_name, bytes) => {
      const { response } = streamResponse([bytes], 'text/plain');
      globalThis.fetch = vi.fn().mockResolvedValue(response);

      expect(await webFetch('https://example.com/liar')).toBe(binaryError);
    });

    it('refuses a Content-Length above the body limit before opening the stream', async () => {
      const getReader = vi.fn();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { getReader },
        headers: new Headers({
          'content-type': 'text/plain',
          'content-length': String(WEB_FETCH_MAX_BODY_BYTES + 1),
        }),
      } as unknown as Response);

      const result = await webFetch('https://example.com/large');
      expect(result).toContain('safety limit');
      expect(result).toContain('No bytes were added to context.');
      expect(getReader).not.toHaveBeenCalled();
    });

    it('cancels a streamed response as soon as it crosses the body limit', async () => {
      const cancel = vi.fn().mockResolvedValue(undefined);
      const reader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array(WEB_FETCH_MAX_BODY_BYTES) })
          .mockResolvedValueOnce({ done: false, value: new Uint8Array([0x78]) }),
        cancel,
        releaseLock: vi.fn(),
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { getReader: () => reader },
        headers: new Headers({ 'content-type': 'text/plain' }),
      } as unknown as Response);

      const result = await webFetch('https://example.com/streamed-large');
      expect(result).toContain('safety limit');
      expect(result).toContain('No bytes were added to context.');
      expect(reader.read).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('refuses NUL/control data and malformed UTF-8 even with a text Content-Type', async () => {
      const nul = streamResponse([new Uint8Array([0x68, 0x69, 0x00])], 'text/plain');
      globalThis.fetch = vi.fn().mockResolvedValueOnce(nul.response)
        .mockResolvedValueOnce(streamResponse([new Uint8Array([0xc3, 0x28])], 'text/plain').response);

      expect(await webFetch('https://example.com/nul')).toBe(binaryError);
      expect(await webFetch('https://example.com/malformed')).toBe(binaryError);
    });
  });

  it('returns HTTP error for non-2xx status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('Not Found', 'text/html', 404)
    );
    const result = await webFetch('http://example.com/missing');
    expect(result).toBe('Error: HTTP 404');
  });

  it('returns HTTP error for 500 status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('Server Error', 'text/html', 500)
    );
    const result = await webFetch('http://example.com/broken');
    expect(result).toBe('Error: HTTP 500');
  });

  it('handles fetch rejection (network error)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network down'));
    const result = await webFetch('http://example.com/');
    expect(result).toBe('Error: Network down');
  });

  it('returns timeout error when request exceeds 10 seconds', async () => {
    vi.useFakeTimers();

    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal;
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('The operation was aborted', 'AbortError'));
            return;
          }
          const onAbort = () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
    );

    const promise = webFetch('http://example.com/slow');
    // async advance flushes the DNS-resolution microtask first, so the abort timer is in place
    // before we push past the timeout (the literal/DNS SSRF check now runs before fetch).
    await vi.advanceTimersByTimeAsync(10_001);
    const result = await promise;
    expect(result).toBe('Error: Request timed out');

    vi.useRealTimers();
  });

  it('keeps the timeout active while a response body is stalled after headers', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit): Promise<Response> => {
          const signal = init?.signal;
          const reader = {
            read: () => new Promise((_resolve, reject) => {
              const rejectAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
              if (signal?.aborted) {
                rejectAbort();
              } else {
                signal?.addEventListener('abort', rejectAbort, { once: true });
              }
            }),
            cancel: vi.fn().mockResolvedValue(undefined),
            releaseLock: vi.fn(),
          };
          return Promise.resolve({
            ok: true,
            status: 200,
            body: { getReader: () => reader },
            headers: new Headers({ 'content-type': 'text/plain' }),
          } as unknown as Response);
        },
      );

      const promise = webFetch('https://example.com/stalled-body');
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(promise).resolves.toBe('Error: Request timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns success for valid https URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('Hello World', 'text/plain')
    );
    const result = await webFetch('https://example.com/');
    expect(result).toBe('Hello World');
  });

  it('handles missing content-type header gracefully', async () => {
    const res = new Response('some content');
    globalThis.fetch = vi.fn().mockResolvedValue(res);
    const result = await webFetch('http://example.com/');
    expect(result).toBe('some content');
  });

  it('collapses whitespace when stripping HTML', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('<html>\n<body>\n<p>Hello   World</p>\n</body>\n</html>', 'text/html')
    );
    const result = await webFetch('http://example.com/');
    expect(result).toBe('Hello World');
  });

  // P1 SSRF hardening (Codex review): DNS resolution + manual redirect re-validation.
  describe('SSRF: DNS resolution and redirects', () => {
    function redirect(location: string, status = 302): Response {
      return new Response(null, { status, headers: { location } });
    }

    it('blocks when the hostname resolves to a private IP (DNS rebinding)', async () => {
      vi.mocked(lookup).mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as any);
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse('secret', 'text/plain'));
      const result = await webFetch('http://internal.evil.example/');
      expect(result).toMatch(/resolves to a private network/);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('blocks a redirect that points at a private address', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(redirect('http://10.0.0.1/'));
      const result = await webFetch('http://example.com/redir');
      expect(result).toMatch(/private network/);
    });

    it('follows a redirect to another public URL and returns its body', async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(redirect('https://example.org/final'))
        .mockResolvedValueOnce(mockResponse('final body', 'text/plain'));
      const result = await webFetch('http://example.com/start');
      expect(result).toBe('final body');
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('errors after too many redirects', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(redirect('https://example.com/loop'));
      const result = await webFetch('http://example.com/loop');
      expect(result).toBe('Error: Too many redirects');
    });
  });
});
