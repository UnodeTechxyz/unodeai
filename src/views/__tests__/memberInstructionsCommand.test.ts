import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

it.each(['instructions', 'smart-compaction', 'unknown'])('the actual builder command admits only its known focus values (%s)', async focus => {
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true); let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'reg' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'unode.openAgentBuilder') callback = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(source); expect(callback).toBeDefined(); const createOrShow = vi.fn();
  const js = ts.transpileModule('const invoke = ' + callback!.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const host = { guard: (run: () => Promise<unknown>) => run(), AgentBuilderPanel: { createOrShow }, context: { extensionUri: {} },
    pickMemberMediaModel: vi.fn() };
  const invoke = new Function('host', `with(host) { ${js}; return invoke; }`)(host);
  await invoke({ agentId: 'member-id', focus }); expect(createOrShow).toHaveBeenCalledOnce();
  expect(createOrShow.mock.calls[0].slice(2)).toEqual(['member-id', focus === 'unknown' ? undefined : focus]);
});
