import { readFileSync } from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { FileWritePolicy } from '../../backend/fileWritePolicy';

const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function evaluate(node: ts.Node, host: object): any {
  const code = ts.transpileModule(`const projection = ${node.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('host', `with (host) { ${code}; return projection; }`)(host);
}
function find(test: (node: ts.Node) => boolean): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (test(node)) nodes.push(node); ts.forEachChild(node, visit); };
  visit(source); return nodes;
}

it('the production file-write factory captures turn identity and the production effect callback forwards it unchanged', () => {
  const calls = find(node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.getText(source) === 'fileWritePolicy.forAgent') as ts.CallExpression[];
  expect(calls).toHaveLength(1);
  const factory = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'makeFileWritePolicy') as ts.FunctionDeclaration;
  expect(factory).toBeDefined();
  const callbacks: ts.PropertyAssignment[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'onEffect') callbacks.push(node);
    ts.forEachChild(node, visit);
  };
  visit(factory); expect(callbacks).toHaveLength(1);
  let requestId = 'request-1'; let turnId = 'turn-1';
  const forwarded: unknown[][] = [];
  const sessionManager = { currentRequestId: () => requestId, currentTurnId: () => turnId,
    noteFileEffect: (...args: unknown[]) => forwarded.push(args) };
  const options = evaluate(calls[0].arguments[0], { sessionManager, scopedConfig: { id: 'dev', name: 'Dev' },
    requestOverwriteDecision: () => { throw new Error('must not approve'); }, approvalOrigin: {}, agentCwd: process.cwd() });
  const onEffect = evaluate(callbacks[0].initializer, { sessionManager });
  const policy = new FileWritePolicy({ workspaceId: () => 'workspace', dirtyEditorPaths: () => [],
    gitPath: async () => ({ repository: false }), isRequestRunning: () => true, onEffect });
  const writes = policy.forAgent(options);
  const captured = writes.attribution();
  requestId = 'request-2'; turnId = 'turn-2';
  writes.noteUncertain(path.join(process.cwd(), 'observed.ts'), 'write', captured, true);
  expect(forwarded).toEqual([['request-1', expect.objectContaining({ path: 'observed.ts', grade: 'effect-uncertain' }),
    { agentId: 'dev', turnId: 'turn-1' }]]);
});
