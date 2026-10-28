import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { commandDisabledNotice } from '../../backend/commandDisabledNotice';

describe('Disabled command host transcript wiring', () => {
  it('the actual session listener paints a runtime notice in the right agent chat, not just Output', () => {
    const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    let listener: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'sessionManager.on'
        && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'session.runtimeNotice') listener = node.arguments[1];
      ts.forEachChild(node, visit);
    };
    visit(source); expect(listener).toBeDefined();
    const js = ts.transpileModule(`const listener = ${listener!.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const postRuntimeNotice = vi.fn();
    const accept = new Function('chatViewProvider', `${js}; return listener;`)({ postRuntimeNotice });
    const text = commandDisabledNotice('echo hello', '/work');
    accept({ sessionId: 'agent-a', data: { text } });
    expect(postRuntimeNotice).toHaveBeenCalledExactlyOnceWith('agent-a', text);
  });
  it('quotes filename/command control characters and applies the shared credential redaction before display', () => {
    const text = commandDisabledNotice('echo Bearer PRIVATE_TOKEN\npretend host status', '/work\nsecond line');
    expect(text).not.toContain('PRIVATE_TOKEN'); expect(text).not.toContain('\n');
    expect(text).toContain('\\n'); expect(text).toContain('Automatic or Ask each at the bottom');
  });
});
