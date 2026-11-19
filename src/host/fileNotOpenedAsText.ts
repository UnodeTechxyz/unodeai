import { basename } from 'node:path';

/**
 * v0.9.102: VS Code did not open the file in the editor. The message names the file and VS Code's reason; whoever
 * asked shows it, and may offer to reveal the file. Nothing is shown where this is thrown.
 */
export class FileNotOpenedAsText extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`VS Code did not open "${basename(filePath)}" in the editor: ${editorReason(cause)}. `
      + 'UnodeAi opens Word, Excel, PowerPoint and PDF files in their app, and other files in the editor. '
      + 'To open this one, reveal it in File Explorer and open it there.');
    this.name = 'FileNotOpenedAsText';
  }
}

/** VS Code's own words: the part after "Detail:" when it gives one, without the encoded URI before it. */
function editorReason(cause: unknown): string {
  const text = (cause instanceof Error ? cause.message : String(cause ?? '')).trim();
  const detail = /Detail:\s*([\s\S]+)$/.exec(text)?.[1]?.trim() || text || 'no reason was given';
  const oneLine = detail.replace(/\s+/g, ' ').replace(/[.。]\s*$/, '');
  return oneLine.length > 300 ? `${oneLine.slice(0, 299)}…` : oneLine;
}
