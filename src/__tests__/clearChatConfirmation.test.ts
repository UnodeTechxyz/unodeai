import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/*
 * v0.9.94: Clear Chat removes the messages UnodeAi shows and keeps for an agent. It does not touch the
 * conversation the agent's backend holds. Its confirmation said that the saved conversation history was deleted,
 * and a person who relied on that found the model still knew everything. The words now say what the command does;
 * the command is unchanged.
 */
describe('the confirmation of Clear Chat', () => {
  const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
  const start = source.indexOf("reg('unode.clearChat'");
  const command = source.slice(start, source.indexOf("reg('unode.archiveChat'", start));

  it('says that the shown messages are deleted and that the model\'s conversation is not reset', () => {
    expect(start).toBeGreaterThan(0);
    expect(command).toContain(
      '`Clear the visible chat with ${who}? This permanently deletes the messages shown in Chat. '
      + "It does not reset the model's conversation, so the model may still remember them.`",
    );
    expect(command).not.toContain('saved conversation history');
  });

  it('still asks first, with keeping the chat as the first answer, and only clears what Chat shows', () => {
    expect(command).toContain('{ modal: true },');
    expect(command.indexOf("'Keep chat'")).toBeGreaterThan(0);
    expect(command.indexOf("'Keep chat'")).toBeLessThan(command.indexOf('CLEAR\n'));
    expect(command).toContain('if (choice === CLEAR) {\n      chatViewProvider?.clearSelectedAgent();\n    }');
    // The words above are true only while this stays so.
    expect(command).not.toContain('clearSnapshot');
    expect(command).not.toContain('sessionManager.');
  });
});
