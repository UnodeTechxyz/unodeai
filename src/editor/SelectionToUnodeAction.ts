/*---------------------------------------------------------------------------------------------
 *  UnodeAi - editor selection to composer code action
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const ADD_SELECTION_TO_UNODE_COMMAND = 'unode.addSelectionToComposer';
export const ADD_SELECTION_TO_UNODE_TITLE = 'Add to UnodeAi';
export const MAX_COMPOSER_SELECTION_CHARS = 120_000;
/**
 * The command is a public entry point: any extension can invoke it with a payload this provider never
 * produced. The bound is the payload, not the selection — `formatSelectionForComposer` wraps a capped
 * selection in a fence, a location line and a truncation notice, so the provider's own largest legitimate
 * output is deliberately longer than `MAX_COMPOSER_SELECTION_CHARS`.
 */
export const MAX_COMPOSER_PAYLOAD_CHARS = MAX_COMPOSER_SELECTION_CHARS + 1_000;

export function isAcceptableComposerPayloadLength(text: string): boolean {
  return text.length <= MAX_COMPOSER_PAYLOAD_CHARS;
}

export interface SelectionToUnodeTarget {
  /** Undefined means there is no team/selected conversation to receive the selection. */
  getSelectedAgentId(): string | undefined;
  /** Applies the selected agent's existing folder-access/read-root boundary to this document. */
  canAttachSelection(uri: vscode.Uri): boolean;
}

export interface SelectionComposerPayload {
  uri: vscode.Uri;
  text: string;
}

/**
 * Editor-only affordance: it never reads the document itself. VS Code supplies exactly the current
 * selection, and the command re-checks scope before it reaches a composer.
 */
export class SelectionToUnodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly target: SelectionToUnodeTarget) {}

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    if (range.isEmpty || !this.target.getSelectedAgentId() || !this.target.canAttachSelection(document.uri)) {
      return [];
    }
    const selected = document.getText(range);
    if (!selected.trim()) {
      return [];
    }
    const action = new vscode.CodeAction(ADD_SELECTION_TO_UNODE_TITLE, vscode.CodeActionKind.QuickFix);
    action.command = {
      command: ADD_SELECTION_TO_UNODE_COMMAND,
      title: ADD_SELECTION_TO_UNODE_TITLE,
      arguments: [{
        uri: document.uri,
        text: formatSelectionForComposer(document, range, selected),
      } satisfies SelectionComposerPayload],
    };
    return [action];
  }
}

export function formatSelectionForComposer(
  document: Pick<vscode.TextDocument, 'fileName' | 'languageId'>,
  range: vscode.Range,
  selected: string,
): string {
  const truncated = selected.length > MAX_COMPOSER_SELECTION_CHARS;
  const text = truncated ? selected.slice(0, MAX_COMPOSER_SELECTION_CHARS) : selected;
  const language = /^[a-z0-9_+-]+$/i.test(document.languageId) ? document.languageId : '';
  const location = `${document.fileName}:${range.start.line + 1}-${range.end.line + 1}`;
  const notice = truncated ? `\n\n[Selection truncated at ${MAX_COMPOSER_SELECTION_CHARS} characters.]` : '';
  return `Selected text from ${location}:\n\n\`\`\`${language}\n${text}\n\`\`\`${notice}`;
}
