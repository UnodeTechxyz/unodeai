import * as vscode from 'vscode';
import { basename, extname } from 'node:path';

/** Called only after the chat-link resolver has checked the recorded path and read roots. */
export async function openRecordedFile(filePath: string, position?: { line: number; column?: number }): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const external = async () => {
    if (!await vscode.env.openExternal(uri)) throw new Error('The system could not open this file.');
  };
  if (['.docx', '.xlsx', '.pptx', '.pdf'].includes(extname(filePath).toLowerCase())) {
    await external();
    return;
  }
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    const reveal = 'Reveal in File Explorer';
    const choice = await vscode.window.showWarningMessage(
      'UnodeAi opens Word, Excel, PowerPoint and PDF files in their app, and text files in the editor. '
      + `To open "${basename(filePath)}", reveal it in File Explorer and open it there.`, reveal);
    if (choice === reveal) await vscode.commands.executeCommand('revealFileInOS', uri);
    return;
  }
  const at = position
    ? document.validatePosition(new vscode.Position(position.line - 1, (position.column ?? 1) - 1))
    : undefined;
  await vscode.window.showTextDocument(document, { preview: false,
    ...(at ? { selection: new vscode.Range(at, at) } : {}) });
}
