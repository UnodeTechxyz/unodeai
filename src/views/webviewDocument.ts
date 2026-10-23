import * as vscode from 'vscode';
import { csp, esc, nonce } from './webviewSecurity';

/**
 * The one document skeleton for webviews that render an inlined style block. Panels own their body and
 * characteristic CSS; this owns the doctype, CSP, viewport, title, token base and optional script nonce.
 */
export interface WebviewDocumentOptions {
  title: string;
  styles: string;
  body: string;
  /** A panel may preserve its existing no-token font fallback without owning the token declaration. */
  fontFallback?: string;
  /** JavaScript source only. The shell creates the matching CSP and script nonce. */
  script?: string;
}

function baseWebviewStyles(fontFallback: string): string {
  return /* css */`
    * { box-sizing: border-box; }
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family, ${fontFallback});
      font-size: var(--vscode-font-size, 13px);
    }
`;
}

export function renderWebviewDocument(webview: vscode.Webview, options: WebviewDocumentOptions): string {
  const scriptNonce = options.script === undefined ? undefined : nonce();
  const script = options.script === undefined
    ? ''
    : `<script nonce="${scriptNonce}">${options.script}\n  </script>\n`;
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview, scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(options.title)}</title>
  <style>${baseWebviewStyles(options.fontFallback ?? 'sans-serif')}${options.styles}</style>
</head>
<body>${options.body}${script}</body>
</html>`;
}
