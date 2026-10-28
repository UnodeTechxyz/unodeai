import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { TeamVerificationEditor, type TeamVerificationEditorPort } from '../TeamVerificationEditor';
import type { TeamFileDocument } from '../../state/TeamFileSchema';

const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function nodes<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = []; const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(source); return found;
}
const js = (node: ts.Node) => ts.transpileModule(node.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText.trim().replace(/;$/, '');
function fixture() {
  let document: TeamFileDocument = { members: [], workflows: [], mcpServers: [], completionVerification: { mode: 'auto' } };
  const port: TeamVerificationEditorPort = { workspaceRoot: () => '/workspace', rosterRevision: () => 0,
    isCurrentWorkspace: () => true, skills: () => [], members: () => [], configuration: () => ({ inspect: () => ({}) }),
    readDocument: async () => document, updateDocument: vi.fn(async edit => { document = edit(document); }) };
  const editor = new TeamVerificationEditor(port);
  return { port, editor, document: () => document };
}
async function token(editor: TeamVerificationEditor) {
  const view = await editor.prepare(); if (view.kind !== 'ready' || !view.editToken) throw new Error('no editable view');
  return view.editToken;
}

describe('actual extension Team verification wiring', () => {
  it('passes the actual SettingsPanel save option to the live editor rather than just exposing a form (F8)', async () => {
    const calls = nodes((node): node is ts.CallExpression => ts.isCallExpression(node)
      && node.expression.getText(source) === 'SettingsPanel.createOrShow');
    const options = calls.flatMap(call => ts.isObjectLiteralExpression(call.arguments[1]) ? [call.arguments[1]] : []);
    const properties = options.flatMap(option => option.properties.filter((entry): entry is ts.PropertyAssignment =>
      ts.isPropertyAssignment(entry) && entry.name.getText(source) === 'saveCompletionVerification'));
    expect(properties).toHaveLength(1);
    const h = fixture(); const save = new Function('teamVerificationEditor', `return (${js(properties[0].initializer)});`)(h.editor);
    const spy = vi.spyOn(h.editor, 'save'); const key = await token(h.editor);
    await save(key, { mode: 'disabled' });
    expect(spy).toHaveBeenCalledExactlyOnceWith(key, { mode: 'disabled' });
    expect(h.document().completionVerification).toEqual({ mode: 'disabled' });
  });
  it('actual created/removed handlers invalidate a token through the actual editor rosterRevision port (F9)', async () => {
    const constructions = nodes((node): node is ts.NewExpression => ts.isNewExpression(node)
      && node.expression.getText(source) === 'TeamVerificationEditor');
    expect(constructions).toHaveLength(1);
    const options = constructions[0].arguments![0] as ts.ObjectLiteralExpression;
    const revision = options.properties.find((entry): entry is ts.PropertyAssignment => ts.isPropertyAssignment(entry)
      && entry.name.getText(source) === 'rosterRevision');
    expect(revision).toBeDefined();
    const registrations = ['session.created', 'session.removed'].map(name => {
      const calls = nodes((node): node is ts.CallExpression => ts.isCallExpression(node)
        && node.expression.getText(source) === 'sessionManager.on' && ts.isStringLiteral(node.arguments[0])
        && node.arguments[0].text === name && ts.isArrowFunction(node.arguments[1]));
      expect(calls).toHaveLength(1); return js(calls[0]);
    });
    const sessionManager = new EventEmitter();
    const resultDeliveryHost = { scope: vi.fn() };
    const host = { sessionManager, resultDeliveryHost, SettingsPanel: { refreshTeamCurrent: vi.fn() },
      orchestrationProgress: { refreshNames: () => false }, publishDelegationProgress: vi.fn(), refreshTeam: vi.fn(),
      MarketplacePanel: { refreshCurrent: vi.fn() }, saveRosterInBackground: vi.fn(), scheduleTeamRulesOnRosterChange: vi.fn(),
      chatViewProvider: { clearAgent: vi.fn() }, agentChannels: new Map(), worktreeCoordinator: { release: vi.fn(async () => {}) },
      agentToolAlwaysAllow: { forget: vi.fn(async () => true) }, contentAssetStore: { release: vi.fn() },
      userRequestHolder: (agentId: string) => `request:${agentId}`, userRequestPreparations: { cancel: vi.fn(() => 0) } };
    const readRevision = new Function('host', `with (host) { let teamRosterRevision = 0;
      ${registrations.join(';\n')}; return (${js(revision!.initializer)}); }`)(host);
    const h = fixture(); h.port.rosterRevision = readRevision;
    for (const [i, event] of ['session.created', 'session.removed'].entries()) {
      const key = await token(h.editor); sessionManager.emit(event, { sessionId: 'worker' });
      expect(readRevision()).toBe(i + 1);
      await expect(h.editor.save(key, { mode: 'disabled' })).rejects.toThrow('save was not performed');
    }
    expect(h.port.updateDocument).toHaveBeenCalledTimes(2);
    expect(resultDeliveryHost.scope).toHaveBeenCalledExactlyOnceWith('worker', 'coordinator-removed');
    // v0.9.99 (audit I2): a message to the removed agent that is still being prepared is never submitted.
    expect(host.userRequestPreparations.cancel).toHaveBeenCalledExactlyOnceWith('worker');
    // v0.9.99 B7: a removed agent's kept "Always allow this tool" answers are forgotten with it.
    expect(host.agentToolAlwaysAllow.forget).toHaveBeenCalledExactlyOnceWith('worker');
    // v0.9.99 CF-2: and so is what its request held in the content store.
    expect(host.contentAssetStore.release).toHaveBeenCalledExactlyOnceWith('request:worker');
    expect(h.document().completionVerification).toEqual({ mode: 'auto' });
  });
});
