import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  CodeAction: class {
    command?: { command: string; title: string; arguments?: unknown[] };
    constructor(readonly title: string, readonly kind: unknown) {}
  },
  CodeActionKind: { QuickFix: 'quickfix' },
}));

import {
  ADD_SELECTION_TO_UNODE_COMMAND,
  ADD_SELECTION_TO_UNODE_TITLE,
  MAX_COMPOSER_PAYLOAD_CHARS,
  MAX_COMPOSER_SELECTION_CHARS,
  SelectionToUnodeActionProvider,
  formatSelectionForComposer,
  isAcceptableComposerPayloadLength,
} from '../SelectionToUnodeAction';

const uri = { scheme: 'file', fsPath: '/workspace/src/app.ts' } as never;
const range = { isEmpty: false, start: { line: 4 }, end: { line: 6 } } as never;
const document = {
  uri,
  fileName: 'src/app.ts',
  languageId: 'typescript',
  getText: vi.fn(() => 'const answer = 42;'),
} as never;

describe('SelectionToUnodeActionProvider (B2)', () => {
  it('offers Add to UnodeAi for an in-scope selection and sends only that selection to the composer command', () => {
    const canAttachSelection = vi.fn(() => true);
    const provider = new SelectionToUnodeActionProvider({
      getSelectedAgentId: () => 'dev',
      canAttachSelection,
    });

    const actions = provider.provideCodeActions(document, range);

    expect(actions).toHaveLength(1);
    expect(actions[0].title).toBe(ADD_SELECTION_TO_UNODE_TITLE);
    expect(actions[0].command).toMatchObject({ command: ADD_SELECTION_TO_UNODE_COMMAND });
    expect(actions[0].command?.arguments?.[0]).toMatchObject({
      uri,
      text: 'Selected text from src/app.ts:5-7:\n\n```typescript\nconst answer = 42;\n```',
    });
    expect(document.getText).toHaveBeenCalledWith(range);
    expect(canAttachSelection).toHaveBeenCalledWith(uri);
  });

  it('is absent rather than broken when no team has a selected agent', () => {
    const canAttachSelection = vi.fn(() => true);
    const provider = new SelectionToUnodeActionProvider({
      getSelectedAgentId: () => undefined,
      canAttachSelection,
    });

    expect(provider.provideCodeActions(document, range)).toEqual([]);
    expect(canAttachSelection).not.toHaveBeenCalled();
  });

  it('does not offer a selection outside the selected agent’s read scope', () => {
    const provider = new SelectionToUnodeActionProvider({
      getSelectedAgentId: () => 'dev',
      canAttachSelection: () => false,
    });

    expect(provider.provideCodeActions(document, range)).toEqual([]);
  });
});

describe('composer payload bound (public command entry)', () => {
  it('accepts the largest payload this provider can itself produce', () => {
    // The bound is on the payload, not the selection. A cap set at MAX_COMPOSER_SELECTION_CHARS would
    // reject the provider's own maximum output, because the formatter adds a fence, a location line and
    // a truncation notice around an already-capped selection.
    const widest = formatSelectionForComposer(
      { fileName: 'src/very/deeply/nested/path/to/a/file.ts', languageId: 'typescript' } as never,
      { start: { line: 0 }, end: { line: 999_999 } } as never,
      'x'.repeat(MAX_COMPOSER_SELECTION_CHARS * 2),
    );
    expect(widest.length).toBeGreaterThan(MAX_COMPOSER_SELECTION_CHARS);
    expect(isAcceptableComposerPayloadLength(widest)).toBe(true);
  });

  it('rejects a payload no provider produced, so another extension cannot fill the composer', () => {
    expect(isAcceptableComposerPayloadLength('y'.repeat(MAX_COMPOSER_PAYLOAD_CHARS + 1))).toBe(false);
  });
});
