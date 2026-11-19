import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { readablePathCeilings, resolveEffectiveRoots } from '../../backend/folderAccess';
import { isPathInsideOrEqual } from '../../backend/pathContainment';
import type { AgentConfig, ResolvedFileGrant, TaskWorkspaceAccess } from '../../types';

const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const actual = ['selectedAgentCanAttachSelection', 'realpathOrResolved'].map(name => {
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
    && node.name?.text === name);
  if (!declaration) throw new Error(`Missing actual ${name}`);
  return ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}).join('\n');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture(options: { alias?: boolean; tempSpelling?: boolean } = {}) {
  const writtenRoot = mkdtempSync(path.join(os.tmpdir(), 'unode-selection-task-'));
  const root = realpathSync.native(writtenRoot);
  roots.push(root);
  const workspace = path.join(root, 'workspace'); const outside = path.join(root, 'outside');
  mkdirSync(workspace); mkdirSync(outside);
  for (const folder of [workspace, outside]) for (const name of ['allowed.txt', 'sibling.txt']) {
    writeFileSync(path.join(folder, name), name);
  }
  const openedWorkspace = options.alias ? path.join(root, 'workspace-alias')
    : options.tempSpelling ? path.join(writtenRoot, 'workspace') : workspace;
  if (options.alias) symlinkSync(workspace, openedWorkspace, process.platform === 'win32' ? 'junction' : 'dir');
  // Model Windows' legacy realpath retaining an alias while native/async expand it. Real files and effects;
  // only the legacy spelling differs. The tempSpelling case below uses the unmocked filesystem APIs.
  const legacy = options.alias ? Object.assign((target: string) => {
    const real = realpathSync(target);
    return target === openedWorkspace || target.startsWith(openedWorkspace + path.sep)
      ? path.join(openedWorkspace, path.relative(workspace, real)) : real;
  }, { native: realpathSync.native }) : realpathSync;
  const config = { id: 'worker', workingDirectory: openedWorkspace } as AgentConfig;
  const state = { full: true, trusted: true, scoped: false, task: undefined as TaskWorkspaceAccess | undefined };
  const host = { path, realpathSync: legacy, statSync, readablePathCeilings, resolveEffectiveRoots, isPathInsideOrEqual,
    selectionDocumentPath: (uri: { fsPath: string }) => uri.fsPath,
    workspaceRoot: () => openedWorkspace,
    autonomyForAgent: () => ({ fullFileAccess: state.full && state.trusted && !config.folderAccess?.length }),
    chatViewProvider: { getSelectedAgentId: () => 'worker' },
    sessionManager: { get: () => ({ config }), currentTurnHasTaskScope: () => state.scoped,
      currentTurnWorkspaceAccess: () => state.task },
    orchestrationHost: { readRootsForAgent: () => [openedWorkspace] },
    vscode: { workspace: { get isTrusted() { return state.trusted; }, workspaceFolders: [{ uri: { fsPath: openedWorkspace } }] } },
  };
  const functions = new Function('host', `with (host) { ${actual}; return { selectedAgentCanAttachSelection, realpathOrResolved }; }`)(host) as {
    selectedAgentCanAttachSelection(uri: { fsPath: string }): boolean;
    realpathOrResolved(target: string): string;
  };
  const allows = (target: string) => functions.selectedAgentCanAttachSelection({ fsPath: target });
  const scope = (folder: string): TaskWorkspaceAccess => ({ pathBase: workspace, readRoots: [folder], writeRoots: [] });
  const exact = (target: string): ResolvedFileGrant => ({ kind: 'file', permission: 'read', lexicalPath: target,
    realPath: realpathSync.native(target), realParent: realpathSync.native(path.dirname(target)) });
  return { config, state, workspace, outside, openedWorkspace, legacy, allows, scope, exact, resolvePath: functions.realpathOrResolved };
}

describe('actual editor selection task ceiling', () => {
  it('attaches alias-spelled selections with the actual native document and root helpers', () => {
    const h = fixture({ alias: true }); h.state.full = false;
    const written = path.join(h.openedWorkspace, 'allowed.txt'), physical = path.join(h.workspace, 'allowed.txt');
    expect(h.legacy(written)).toBe(written);
    expect(realpathSync.native(written)).toBe(physical);
    expect(h.resolvePath(h.openedWorkspace)).toBe(h.workspace);
    expect(h.resolvePath(path.join(h.openedWorkspace, 'missing.txt'))).toBe(path.join(h.openedWorkspace, 'missing.txt'));
    expect(h.allows(written)).toBe(true);
    expect(h.allows(physical)).toBe(true);
    expect(h.allows(path.join(h.outside, 'allowed.txt'))).toBe(false);
    h.state.scoped = true; h.state.task = h.scope(h.workspace); h.state.full = true;
    expect(h.allows(written)).toBe(true);
    rmSync(h.openedWorkspace);
    symlinkSync(h.outside, h.openedWorkspace, process.platform === 'win32' ? 'junction' : 'dir');
    expect(h.allows(written)).toBe(false);
  });

  it('attaches selections through the real temporary-directory spelling and the physical spelling', () => {
    const h = fixture({ tempSpelling: true }); h.state.full = false;
    expect(h.resolvePath(h.openedWorkspace)).toBe(h.workspace);
    expect(h.allows(path.join(h.openedWorkspace, 'allowed.txt'))).toBe(true);
    expect(h.allows(path.join(h.workspace, 'allowed.txt'))).toBe(true);
    expect(h.allows(path.join(h.outside, 'allowed.txt'))).toBe(false);
    h.state.scoped = true; h.state.task = h.scope(h.workspace);
    expect(h.allows(path.join(h.openedWorkspace, 'allowed.txt'))).toBe(true);
  });

  it('keeps unscoped Full access capable and retains current Workspace and Folder Access restrictions', () => {
    const h = fixture(); const outside = path.join(h.outside, 'allowed.txt');
    expect(h.allows(outside)).toBe(true);
    h.state.full = false;
    expect(h.allows(outside)).toBe(false);
    expect(h.allows(path.join(h.workspace, 'allowed.txt'))).toBe(true);
    h.state.full = true; h.config.folderAccess = [{ path: h.workspace, permission: 'read' }];
    expect(h.allows(outside)).toBe(false);
    h.config.folderAccess = undefined; h.state.trusted = false;
    expect(h.allows(outside)).toBe(false);
  });

  it('intersects Full access and Workspace selections with the running task folder rather than the whole agent scope', () => {
    const h = fixture(); h.state.scoped = true;
    h.state.task = h.scope(h.outside);
    expect(h.allows(path.join(h.outside, 'allowed.txt'))).toBe(true);
    expect(h.allows(path.join(h.workspace, 'allowed.txt'))).toBe(false);
    h.state.task = { pathBase: h.workspace, readRoots: [], writeRoots: [h.outside] };
    expect(h.allows(path.join(h.outside, 'allowed.txt'))).toBe(true);
    h.state.full = false;
    expect(h.allows(path.join(h.outside, 'allowed.txt'))).toBe(false);
    h.state.task = h.scope(h.workspace);
    expect(h.allows(path.join(h.workspace, 'allowed.txt'))).toBe(true);
    const sibling = path.join(h.workspace, '..sibling'); mkdirSync(sibling);
    writeFileSync(path.join(sibling, 'allowed.txt'), 'not inside the task');
    h.state.task = h.scope(path.join(h.workspace, 'nested'));
    mkdirSync(h.state.task.readRoots[0]);
    expect(h.allows(path.join(sibling, 'allowed.txt'))).toBe(false);
  });

  it('does not widen a pending scoped turn when its admitted snapshot is unavailable', () => {
    const h = fixture(); h.state.scoped = true;
    expect(h.allows(path.join(h.outside, 'allowed.txt'))).toBe(false);
    expect(h.allows(path.join(h.workspace, 'allowed.txt'))).toBe(false);
    h.state.scoped = false;
    expect(h.allows(path.join(h.outside, 'allowed.txt'))).toBe(true);
  });

  it('keeps exact task files exact for read-only and write-only snapshots and never promotes a replacement directory', () => {
    const h = fixture(); const target = path.join(h.outside, 'allowed.txt'); const grant = h.exact(target);
    h.state.scoped = true;
    h.state.task = { pathBase: h.workspace, readRoots: [], writeRoots: [], readFiles: [grant] };
    expect(h.allows(target)).toBe(true);
    expect(h.allows(path.join(h.outside, 'sibling.txt'))).toBe(false);
    h.state.task = { pathBase: h.workspace, readRoots: [], writeRoots: [], writeFiles: [grant] };
    expect(h.allows(target)).toBe(true);
    rmSync(target); mkdirSync(target); writeFileSync(path.join(target, 'child.txt'), 'not an exact file');
    expect(h.allows(target)).toBe(false);
    expect(h.allows(path.join(target, 'child.txt'))).toBe(false);
  });

  it('checks the physical selected file against pinned task roots without following a later escaping link', () => {
    const h = fixture(); const taskFolder = path.join(h.workspace, 'task'); mkdirSync(taskFolder);
    const escape = path.join(taskFolder, 'escape');
    symlinkSync(h.outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
    h.state.scoped = true; h.state.task = h.scope(taskFolder);
    expect(h.allows(path.join(escape, 'allowed.txt'))).toBe(false);
    const pinned = path.join(h.workspace, 'pinned'); mkdirSync(pinned);
    writeFileSync(path.join(pinned, 'allowed.txt'), 'original'); h.state.task = h.scope(pinned);
    expect(h.allows(path.join(pinned, 'allowed.txt'))).toBe(true);
    rmSync(pinned, { recursive: true });
    symlinkSync(h.outside, pinned, process.platform === 'win32' ? 'junction' : 'dir');
    expect(h.allows(path.join(pinned, 'allowed.txt'))).toBe(false);
  });
});
