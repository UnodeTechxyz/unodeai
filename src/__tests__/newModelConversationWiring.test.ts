import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('new model conversation opt-in entry', () => {
  it('registers the actual action used by the model instructions in the palette and chat menu', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(manifest.contributes.commands).toContainEqual({ command: 'unode.newModelConversation', title: 'UnodeAi: New Model Conversation (keep chat)' });
    const host = readFileSync('src/extension.ts', 'utf8');
    expect(host).toContain("reg('unode.newModelConversation'");
    expect(host).toContain('await sessionManager.newModelConversation(id)');
    const view = readFileSync('src/views/ChatViewProvider.ts', 'utf8');
    expect(view).toContain('data-chat-command="unode.newModelConversation"');
    expect(view).toContain("'unode.newModelConversation',");
  });
});
