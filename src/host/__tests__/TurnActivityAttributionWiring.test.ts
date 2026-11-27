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

const forAgentCalls = () => find(node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
  && node.expression.getText(source) === 'fileWritePolicy.forAgent') as ts.CallExpression[];
const passes = (call: ts.CallExpression, name: string) => ts.isObjectLiteralExpression(call.arguments[0])
  && call.arguments[0].properties.some(property => property.name?.getText(source) === name);
/** The member's own writer passes its turn; the person's Export PDF writer (v0.9.108 L1) is no model turn's. */
const agentCall = () => forAgentCalls().filter(call => passes(call, 'turnId'));
const personCall = () => forAgentCalls().filter(call => !passes(call, 'turnId'));

it('the production file-write factory captures turn identity and the production effect callback forwards it unchanged', () => {
  const calls = agentCall();
  expect(forAgentCalls()).toHaveLength(2); expect(calls).toHaveLength(1);
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

it('the person\'s Export PDF writer passes no request or turn, so its file effect reaches no running turn of the member', () => {
  const [call] = personCall(); expect(personCall()).toHaveLength(1);
  expect(passes(call, 'requestId')).toBe(false);
  const factory = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'makeFileWritePolicy') as ts.FunctionDeclaration;
  let onEffectNode: ts.PropertyAssignment | undefined;
  const visit = (node: ts.Node) => { if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'onEffect') onEffectNode = node; ts.forEachChild(node, visit); };
  visit(factory);
  const forwarded: unknown[][] = [];
  // The member has a running request and turn while the person exports.
  const sessionManager = { currentRequestId: () => 'request-1', currentTurnId: () => 'turn-1', noteFileEffect: (...args: unknown[]) => forwarded.push(args) };
  const options = evaluate(call.arguments[0], { scopedConfig: { id: 'dev', name: 'Dev' }, agentCwd: process.cwd() });
  const onEffect = evaluate(onEffectNode!.initializer, { sessionManager });
  const policy = new FileWritePolicy({ workspaceId: () => 'workspace', dirtyEditorPaths: () => [],
    gitPath: async () => ({ repository: false }), isRequestRunning: () => true, onEffect });
  const writes = policy.forAgent(options);
  const captured = writes.attribution();
  expect(captured).toEqual({ scope: 'agent:dev', at: expect.any(Number) });
  writes.noteUncertain(path.join(process.cwd(), 'export.pdf'), 'write', captured, true);
  expect(forwarded).toEqual([[undefined, expect.objectContaining({ path: 'export.pdf', grade: 'effect-uncertain' }), undefined]]);
});
