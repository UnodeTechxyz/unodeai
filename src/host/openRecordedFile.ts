import * as vscode from 'vscode';
import { FileNotOpenedAsText } from './fileNotOpenedAsText';
import { isDocumentFile } from './fileActions';
import { startDocumentOpener, windowsDocumentOpener, type DocumentOpenerCommand } from './systemDocumentOpener';

/** How the system opens a document: the platform, and a start for a program (replaced in tests). */
export interface SystemDocumentOpening {
  platform: NodeJS.Platform;
  systemRoot: string | undefined;
  start(opener: DocumentOpenerCommand): Promise<void>;
}

const systemOpening: SystemDocumentOpening = {
  platform: process.platform,
  systemRoot: process.env.SystemRoot,
  start: startDocumentOpener,
};

/** Called only after the chat-link resolver has checked the recorded path and read roots. */
export async function openRecordedFile(
  filePath: string,
  position?: { line: number; column?: number },
  system: SystemDocumentOpening = systemOpening,
): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  // Word, Excel, PowerPoint and PDF files open in their app; every other file opens in the editor as text.
  if (isDocumentFile(filePath)) {
    if (system.platform === 'win32') {
      await system.start(windowsDocumentOpener(filePath, system.systemRoot));
      return;
    }
    if (!await vscode.env.openExternal(uri)) throw new Error('The system could not open this file.');
    return;
  }
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    throw new FileNotOpenedAsText(filePath, error);
  }
  const at = position
    ? document.validatePosition(new vscode.Position(position.line - 1, (position.column ?? 1) - 1))
    : undefined;
  await vscode.window.showTextDocument(document, { preview: false,
    ...(at ? { selection: new vscode.Range(at, at) } : {}) });
}
