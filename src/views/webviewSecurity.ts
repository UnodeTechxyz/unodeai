import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

/** A CSP-grade nonce: cryptographically random (not Math.random), URL-safe base64. */
export function nonce(): string {
  return randomBytes(16).toString('base64').replace(/[+/=]/g, '');
}

export function csp(webview: vscode.Webview, scriptNonce?: string): string {
  const scriptSrc = scriptNonce ? `'nonce-${scriptNonce}'` : `'none'`;
  return [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${scriptSrc}`,
  ].join('; ');
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

export function sanitizeHref(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface ResolvedExternalUrl {
  url: string;
  origin: string;
  isDefault: boolean;
}

/**
 * Validate a workspace-configurable external link before it reaches `openExternal`.
 *
 * A repository's `.vscode/settings.json` can set values like `unode.marketplace.skillLibraryUrl`.
 * A bare `Uri.parse(raw)` would let that repository point a trusted-looking button at a `file:` URI,
 * a custom protocol handler, or an unrelated host. We require `https:` (the only scheme these links
 * are ever meant to use), fail closed on anything else, and report whether the value is the bundled
 * default so the caller can disclose an off-default destination before navigating.
 */
export function resolveHttpsExternalUrl(raw: string, bundledDefault: string): ResolvedExternalUrl | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') {
    return undefined;
  }
  // Reject embedded credentials: `https://github.com@evil.example/` reads as trusted but resolves to `evil.example`.
  if (url.username !== '' || url.password !== '') {
    return undefined;
  }
  let isDefault = false;
  try {
    isDefault = url.toString() === new URL(bundledDefault).toString();
  } catch {
    isDefault = false;
  }
  return { url: url.toString(), origin: url.origin, isDefault };
}
