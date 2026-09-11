import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'crypto';
import {
  parseCatalogResilient, fetchHostedCatalog, resolveCatalog, verifyCatalogSignature, describeHostedCatalogStatus,
} from '../catalogSource';

// The Security panel is the screen a user checks precisely because they do not want to read the code, so it
// must report BEHAVIOUR, never intent. It used to render `fetchCatalog: true` as "Catalog fetch: ON" — while
// in the state this build actually ships in (no signing key) the code refuses to make the request at all.
// It was telling the user the opposite of what the extension does. (Codex, v0.9.29 review.)
describe('describeHostedCatalogStatus — the panel says what the code does', () => {
  const KEY = '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n';
  const url = 'https://catalog.example/c.json';

  it('setting off, or no URL → off', () => {
    expect(describeHostedCatalogStatus({ enabled: false, url, publicKeyPem: KEY, outcome: 'not-attempted' }).text)
      .toMatch(/off — bundled catalog only/);
    expect(describeHostedCatalogStatus({ enabled: true, url: '  ', publicKeyPem: KEY, outcome: 'not-attempted' }).text)
      .toMatch(/off — bundled catalog only/);
  });

  // THE state this build ships in: the user turned the setting ON, and nothing is fetched anyway.
  it('setting ON but no bundled signing key → "unavailable, signing not configured" (NOT "fetch ON")', () => {
    const s = describeHostedCatalogStatus({ enabled: true, url, publicKeyPem: '', outcome: 'disabled-no-key' });
    expect(s.text).toMatch(/publisher signing is not configured/);
    expect(s.text).not.toMatch(/ON/);
    expect(s.ok).toBe(true); // nothing is fetched and nothing unverified can merge — this is not a warning
  });

  it('key configured, nothing fetched yet → enabled, and will only use a signed catalog', () => {
    const s = describeHostedCatalogStatus({ enabled: true, url, publicKeyPem: KEY, outcome: 'not-attempted' });
    expect(s.text).toMatch(/only a validly signed catalog/);
  });

  it('key configured, valid signed catalog loaded → verified', () => {
    expect(describeHostedCatalogStatus({ enabled: true, url, publicKeyPem: KEY, outcome: 'verified' }).text)
      .toMatch(/verified/i);
  });

  it('key configured, signature missing or invalid → unverified, bundled only, and it WARNS', () => {
    const s = describeHostedCatalogStatus({ enabled: true, url, publicKeyPem: KEY, outcome: 'rejected' });
    expect(s.text).toMatch(/unverified/i);
    expect(s.text).toMatch(/bundled catalog only/);
    expect(s.ok).toBe(false); // someone served us something that did not verify — the user should see that
  });

  it('key configured, offline → unavailable, bundled only, not a warning', () => {
    const s = describeHostedCatalogStatus({ enabled: true, url, publicKeyPem: KEY, outcome: 'unreachable' });
    expect(s.text).toMatch(/could not be fetched/);
    expect(s.ok).toBe(true);
  });
});

const validAgent = {
  id: 'dev', name: 'Developer', role: 'developer', summary: 's',
  skills: ['code-generation'], model: 'claude-sonnet-4-6', tier: 'standard', systemPrompt: 'p',
};
const validMcp = { id: 'fs', name: 'Filesystem', summary: 's', transport: 'stdio', command: 'npx' };

/** Response whose body is delivered via text() (what the source reads) and json() (belt-and-suspenders). */
function textResponse(body: unknown, ok = true): Response {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok, text: async () => s, json: async () => JSON.parse(s) } as unknown as Response;
}

/** Fetch fake that routes by exact URL: missing entries resolve to a non-OK response. */
function routedFetch(map: Record<string, Response>) {
  return vi.fn(async (url: string) => map[url] ?? ({ ok: false } as unknown as Response));
}

describe('parseCatalogResilient', () => {
  it('parses all three sections', () => {
    const cat = parseCatalogResilient({ agents: [validAgent], mcp: [validMcp], skills: [] });
    expect(cat.agents).toHaveLength(1);
    expect(cat.mcp).toHaveLength(1);
  });
  it('one bad section becomes [] without throwing or blanking the others', () => {
    const warn = vi.fn();
    const cat = parseCatalogResilient({ agents: [{ id: 'x' }], mcp: [validMcp], skills: [] }, warn);
    expect(cat.agents).toEqual([]); // invalid agent → dropped
    expect(cat.mcp).toHaveLength(1); // mcp survives
    expect(warn).toHaveBeenCalled();
  });
  it('treats missing sections as empty', () => {
    expect(parseCatalogResilient({})).toEqual({ agents: [], mcp: [], skills: [] });
  });
});

// Signing is not a mode this function has — it is the only way it works. `verify` is a REQUIRED field and
// there is no branch that reaches JSON.parse on unverified bytes.
//
// The block that used to live here was called "fetchHostedCatalog (no signature verification)" and its first
// case asserted that an unverified body PARSES AND MERGES. It was passing, and it was preserving the exact
// bypass it should have been forbidding: while a caller could omit `verify`, the invariant "an unverified
// catalog never merges" rested on every future caller remembering an optional field. A test that documents
// the escape hatch is a test that keeps the escape hatch open. (Codex, v0.9.29 review.)
//
// Everything below therefore signs its fixtures. The transport-failure cases (no url, non-OK, offline,
// unparseable) are still covered — they just cannot be reached by opting out of verification.
describe('fetchHostedCatalog — verification is not optional', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const verify = { publicKeyPem: pubPem };
  const url = 'https://x/catalog.json';
  const sigUrl = `${url}.sig`;
  const signed = (body: unknown): Record<string, Response> => {
    const s = JSON.stringify(body);
    return { [url]: textResponse(s), [sigUrl]: textResponse(edSign(null, Buffer.from(s, 'utf8'), privateKey).toString('base64')) };
  };

  it('returns the parsed body when — and only when — it is validly signed', async () => {
    const fetchImpl = routedFetch(signed({ agents: [validAgent] }));
    const out = await fetchHostedCatalog({ url, fetchImpl: fetchImpl as never, verify });
    expect(out).toEqual({ agents: [validAgent] });
  });
  it('returns undefined with no url', async () => {
    expect(await fetchHostedCatalog({ url: '', verify })).toBeUndefined();
  });
  it('returns undefined on non-OK status', async () => {
    const fetchImpl = vi.fn(async () => textResponse({}, false));
    expect(await fetchHostedCatalog({ url, fetchImpl: fetchImpl as never, verify })).toBeUndefined();
  });
  it('returns undefined when fetch throws (offline)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    expect(await fetchHostedCatalog({ url, fetchImpl: fetchImpl as never, verify })).toBeUndefined();
  });
  it('returns undefined on an unparseable body, even when the signature over it is valid', async () => {
    const bad = 'not json{';
    const fetchImpl = routedFetch({
      [url]: textResponse(bad),
      [sigUrl]: textResponse(edSign(null, Buffer.from(bad, 'utf8'), privateKey).toString('base64')),
    });
    expect(await fetchHostedCatalog({ url, fetchImpl: fetchImpl as never, verify })).toBeUndefined();
  });
});

describe('verifyCatalogSignature (Ed25519)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const bytes = '{"agents":[]}';
  const sig = edSign(null, Buffer.from(bytes, 'utf8'), privateKey).toString('base64');

  it('verifies a correct detached signature over the exact bytes', () => {
    expect(verifyCatalogSignature(bytes, sig, pubPem)).toBe(true);
  });
  it('rejects when the bytes were tampered with', () => {
    expect(verifyCatalogSignature(bytes + ' ', sig, pubPem)).toBe(false);
  });
  it('rejects a blank key or blank signature (returns false, never throws)', () => {
    expect(verifyCatalogSignature(bytes, sig, '')).toBe(false);
    expect(verifyCatalogSignature(bytes, '', pubPem)).toBe(false);
  });
  it('rejects a signature from a different key', () => {
    const other = generateKeyPairSync('ed25519');
    const otherSig = edSign(null, Buffer.from(bytes, 'utf8'), other.privateKey).toString('base64');
    expect(verifyCatalogSignature(bytes, otherSig, pubPem)).toBe(false);
  });
});

describe('fetchHostedCatalog (signature verification)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const url = 'https://x/catalog.json';
  const sigUrl = `${url}.sig`;
  const body = JSON.stringify({ agents: [validAgent] });
  const goodSig = edSign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64');

  it('merges when the signature is valid', async () => {
    const fetchImpl = routedFetch({ [url]: textResponse(body), [sigUrl]: textResponse(goodSig) });
    const out = await fetchHostedCatalog({ url, fetchImpl: fetchImpl as never, verify: { publicKeyPem: pubPem } });
    expect(out).toEqual({ agents: [validAgent] });
  });

  it('rejects (undefined) and warns when a present signature does NOT verify', async () => {
    const warn = vi.fn();
    const fetchImpl = routedFetch({ [url]: textResponse(body), [sigUrl]: textResponse('AAAA') });
    const out = await fetchHostedCatalog({ url, fetchImpl: fetchImpl as never, verify: { publicKeyPem: pubPem }, warn });
    expect(out).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did NOT verify'));
  });

  // Was: "merges with an unsigned warning (transition window)". That was the bug. A catalog entry can carry
  // an MCP server's stdio command + args, which makes the hosted catalog the one place where remote content
  // can influence what runs on a user's machine — so "we could not verify this, but here it is" is not a
  // posture this feature can hold, and a warning in a console nobody reads is not a control.
  // (Codex, v0.9.29 review.) Missing and invalid are now the same answer: no.
  it('REJECTS an unsigned catalog — an unverified catalog is not merged', async () => {
    const warn = vi.fn();
    const fetchImpl = routedFetch({ [url]: textResponse(body) }); // no .sig route → non-OK
    const out = await fetchHostedCatalog({ url, fetchImpl: fetchImpl as never, verify: { publicKeyPem: pubPem }, warn });
    expect(out).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('REJECTED'));
  });

  // The state this codebase actually ships in today (CATALOG_PUBLIC_KEY_PEM = ''). Not-yet-configured
  // signing must mean THE FEATURE IS OFF, never THE PROTECTION IS OFF — and it must refuse before the
  // request, because fetching something you have no way to verify only tempts someone to use it.
  it('does not even FETCH when no signing key is configured (blank key ⇒ hosted catalog disabled)', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(routedFetch({ [url]: textResponse(body), [sigUrl]: textResponse(goodSig) }));
    const out = await fetchHostedCatalog({ url, fetchImpl: fetchImpl as never, verify: { publicKeyPem: '  ' }, warn });
    expect(out).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled(); // no key ⇒ no request at all
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('a catalog signed with the WRONG key is rejected (tamper / key rotation)', async () => {
    const other = generateKeyPairSync('ed25519');
    const wrongSig = edSign(null, Buffer.from(body, 'utf8'), other.privateKey).toString('base64');
    const fetchImpl = routedFetch({ [url]: textResponse(body), [sigUrl]: textResponse(wrongSig) });
    const out = await fetchHostedCatalog({ url, fetchImpl: fetchImpl as never, verify: { publicKeyPem: pubPem } });
    expect(out).toBeUndefined();
  });

  it('a signature valid for DIFFERENT bytes is rejected (the body was swapped after signing)', async () => {
    const tampered = JSON.stringify({ agents: [validAgent], mcp: [] }); // re-serialized ⇒ different bytes
    const fetchImpl = routedFetch({ [url]: textResponse(tampered), [sigUrl]: textResponse(goodSig) });
    const out = await fetchHostedCatalog({ url, fetchImpl: fetchImpl as never, verify: { publicKeyPem: pubPem } });
    expect(out).toBeUndefined();
  });

  // The bypass itself, nailed shut. `verify` is a REQUIRED field, so omitting it does not compile — but
  // TypeScript is not present at runtime, and a JS caller (or an `as any`) could still hand us nothing. The
  // old code answered that by skipping verification entirely and merging the body. It must answer by
  // refusing, without a request. This is the invariant Codex asked for: an unverified catalog cannot merge
  // by ANY caller shape, not merely by the two we happen to have written.
  it('a caller that omits verify entirely is REFUSED, not silently trusted', async () => {
    const fetchImpl = vi.fn(routedFetch({ [url]: textResponse(body), [sigUrl]: textResponse(goodSig) }));
    const out = await fetchHostedCatalog({ url, fetchImpl: fetchImpl as never } as never);
    expect(out).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled(); // no verification config ⇒ no request at all
  });
});

describe('resolveCatalog', () => {
  it('returns bundled only when no hosted source', async () => {
    const cat = await resolveCatalog({ bundled: { agents: [validAgent], mcp: [validMcp], skills: [] } });
    expect(cat.agents).toHaveLength(1);
    expect(cat.mcp).toHaveLength(1);
  });

  // A hosted catalog can only ever win by being SIGNED — so the merge test has to sign it. There is no
  // longer any way to write "hosted overrides bundled" without producing a valid signature, which is the
  // point: the test suite cannot express the unsafe configuration either.
  it('merges hosted over bundled (hosted wins on id collision) — signed', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const url = 'https://x/catalog.json';
    const hostedAgent = { ...validAgent, name: 'Hosted Dev' };
    const bodyText = JSON.stringify({ agents: [hostedAgent] });
    const fetchImpl = routedFetch({
      [url]: textResponse(bodyText),
      [`${url}.sig`]: textResponse(edSign(null, Buffer.from(bodyText, 'utf8'), privateKey).toString('base64')),
    });
    const cat = await resolveCatalog({
      bundled: { agents: [validAgent], mcp: [validMcp], skills: [] },
      hosted: { url, fetchImpl: fetchImpl as never, verify: { publicKeyPem: pubPem } },
    });
    expect(cat.agents).toHaveLength(1);
    expect(cat.agents[0].name).toBe('Hosted Dev'); // override wins
    expect(cat.mcp).toHaveLength(1); // bundled mcp preserved
  });

  it('falls back to bundled when the hosted fetch fails', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    const cat = await resolveCatalog({
      bundled: { agents: [validAgent], mcp: [], skills: [] },
      hosted: {
        url: 'https://x',
        fetchImpl: fetchImpl as never,
        verify: { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string },
      },
    });
    expect(cat.agents).toHaveLength(1);
  });

  it('falls back to bundled when a present hosted signature does not verify', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const url = 'https://x/catalog.json';
    const body = JSON.stringify({ agents: [{ ...validAgent, name: 'Hosted Dev' }] });
    // sign DIFFERENT bytes so the signature is present but invalid for `body`
    const badSig = edSign(null, Buffer.from('tampered', 'utf8'), privateKey).toString('base64');
    const fetchImpl = routedFetch({ [url]: textResponse(body), [`${url}.sig`]: textResponse(badSig) });
    const cat = await resolveCatalog({
      bundled: { agents: [validAgent], mcp: [], skills: [] },
      hosted: { url, fetchImpl: fetchImpl as never, verify: { publicKeyPem: pubPem } },
    });
    expect(cat.agents).toHaveLength(1);
    expect(cat.agents[0].name).toBe('Developer'); // bundled, not the unverified hosted override
  });
});
