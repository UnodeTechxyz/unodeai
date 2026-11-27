import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { ImageGenerationReceipt } from './ImageGenerationHost';
/** A result preview only: no scripts, remote resources, approval button or focus-taking reveal. */
export class ImagePreviewHost implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private disposed = false;
  show(receipt: ImageGenerationReceipt, bytes: Buffer): void {
    if (this.disposed || receipt.state !== 'succeeded' || receipt.sha256 !== createHash('sha256').update(bytes).digest('hex')) return;
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('unode.generatedImagePreview', 'Generated image',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: false, localResourceRoots: [] });
      this.panel = panel;
      panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
    }
    // All text comes from host-minted facts; no prompt, source path, key or provider error is rendered.
    const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
    this.panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
      <style>body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}img{display:block;max-width:100%;height:auto}p{overflow-wrap:anywhere}</style></head>
      <body><p>Generated original · ${receipt.width} × ${receipt.height} · PNG</p>
      <img alt="Generated image result" src="data:image/png;base64,${bytes.toString('base64')}">
      <p>${escape(receipt.operation_id)} · ${escape(receipt.model)}</p>
      <p>This preview shows the latest generated original. Previous versions remain available to the task; saving or document creation does not replace them.</p></body></html>`;
  }
  dispose(): void { this.disposed = true; this.panel?.dispose(); this.panel = undefined; }
}
