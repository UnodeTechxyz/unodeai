/**
 * v0.9.110 (N1): the named VS Code adapter behind go_to_definition and find_references.
 *
 * It asks only the public language-service commands. `vscode.executeReferenceProvider` passes
 * `{ includeDeclaration: true }` to the provider (checked against VS Code 1.147.0), so a references answer may hold the
 * declaration. Nothing here searches text or calls symbols/outline to invent an answer.
 */
import * as vscode from 'vscode';
import { samePath } from '../backend/folderAccess';
import {
  FIND_REFERENCES_TOOL,
  type CodeNavigationHost,
  type CodeNavigationTool,
  type NavigationDocument,
  type RawNavigationLocation,
} from '../navigation/CodeNavigation';

interface VscodeNavigationDocument extends NavigationDocument {
  readonly uri: vscode.Uri;
}

function isLocationLink(value: vscode.Location | vscode.LocationLink): value is vscode.LocationLink {
  return (value as vscode.LocationLink).targetUri !== undefined;
}

function rangeOf(range: vscode.Range): RawNavigationLocation['range'] {
  return { startLine: range.start.line, startCharacter: range.start.character, endLine: range.end.line, endCharacter: range.end.character };
}

export class VscodeCodeNavigation implements CodeNavigationHost {
  async openDocument(physicalPath: string): Promise<NavigationDocument> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(physicalPath));
    const wrapped: VscodeNavigationDocument = {
      uri: document.uri,
      version: document.version,
      isDirty: document.isDirty,
      lineCount: document.lineCount,
      lineText: (line0: number) => document.lineAt(line0).text,
    };
    return wrapped;
  }

  async locate(tool: CodeNavigationTool, document: NavigationDocument, line0: number, character0: number): Promise<RawNavigationLocation[] | undefined> {
    const uri = (document as VscodeNavigationDocument).uri;
    const position = new vscode.Position(line0, character0);
    const command = tool === FIND_REFERENCES_TOOL ? 'vscode.executeReferenceProvider' : 'vscode.executeDefinitionProvider';
    const answer = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(command, uri, position);
    if (!Array.isArray(answer)) return undefined;
    return answer.map((item) => {
      const target = isLocationLink(item) ? item.targetUri : item.uri;
      const range = isLocationLink(item) ? item.targetSelectionRange ?? item.targetRange : item.range;
      // Only a location this host can name as a file is named; any other scheme is counted unsupported, never fetched.
      const sameHost = target.scheme === uri.scheme && target.authority === uri.authority && target.scheme === 'file';
      // v0.9.110: whether it is in the queried document itself, compared as the platform compares paths: a provider
      // may spell the same Windows file with another case.
      const sameDocument = sameHost && samePath(target.fsPath, uri.fsPath);
      return { ...(sameHost ? { filePath: target.fsPath } : {}), range: rangeOf(range), ...(sameDocument ? { sameDocument: true as const } : {}) };
    });
  }
}
