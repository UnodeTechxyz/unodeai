import { describe, expect, it } from 'vitest';
import { resolveHttpsExternalUrl, sanitizeHref } from '../webviewSecurity';

describe('sanitizeHref', () => {
  it('allows http and https URLs', () => {
    expect(sanitizeHref('https://www.unodetech.xyz/pricing?lang=en')).toBe('https://www.unodetech.xyz/pricing?lang=en');
    expect(sanitizeHref('http://localhost:3000/docs')).toBe('http://localhost:3000/docs');
  });

  it('rejects non-web and malformed URLs', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeHref('not a url')).toBeUndefined();
  });
});

describe('resolveHttpsExternalUrl', () => {
  const DEFAULT = 'https://github.com/UnodeTechxyz/unode-skills';

  it('marks the bundled default as default and reports its origin', () => {
    const r = resolveHttpsExternalUrl(DEFAULT, DEFAULT);
    expect(r).toEqual({ url: DEFAULT, origin: 'https://github.com', isDefault: true });
  });

  it('accepts a different https url but flags it as non-default with its origin', () => {
    const r = resolveHttpsExternalUrl('https://evil.example/skills', DEFAULT);
    expect(r?.isDefault).toBe(false);
    expect(r?.origin).toBe('https://evil.example');
  });

  it('fails closed on non-https schemes a workspace could inject', () => {
    // The exact escalation R3 describes: a repository setting skillLibraryUrl to a non-web scheme.
    expect(resolveHttpsExternalUrl('http://github.com/UnodeTechxyz/unode-skills', DEFAULT)).toBeUndefined();
    expect(resolveHttpsExternalUrl('file:///C:/Windows/System32/calc.exe', DEFAULT)).toBeUndefined();
    expect(resolveHttpsExternalUrl('vscode://ms-vscode.node-debug/launch', DEFAULT)).toBeUndefined();
    expect(resolveHttpsExternalUrl('javascript:alert(1)', DEFAULT)).toBeUndefined();
  });

  it('rejects embedded credentials that disguise the real host', () => {
    // Parses to origin https://evil.example despite the trusted-looking prefix.
    expect(resolveHttpsExternalUrl('https://github.com@evil.example/skills', DEFAULT)).toBeUndefined();
    expect(resolveHttpsExternalUrl('https://user:pass@github.com/UnodeTechxyz/unode-skills', DEFAULT)).toBeUndefined();
  });

  it('fails closed on malformed input', () => {
    expect(resolveHttpsExternalUrl('not a url', DEFAULT)).toBeUndefined();
    expect(resolveHttpsExternalUrl('', DEFAULT)).toBeUndefined();
  });
});
