import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CheckpointStore,
  checkpointEvidenceLabel,
  checkpointKeepsText,
  checkpointRestoreDisabledMessage,
  checkpointRestorePlan,
} from '../backend/Checkpoints';
import { commitCheckpointRestore, currentBytesAsPrepared, prepareCheckpointRestore } from '../backend/CheckpointRestore';
import { ClaudeHeadlessBackend } from '../backend/ClaudeHeadlessBackend';
import { FileWritePolicy } from '../backend/fileWritePolicy';
import { PreChangeCheckpoints, rawCheckpointLocation } from '../backend/PreChangeCheckpoints';
import { RawCheckpointStore } from '../backend/RawCheckpointStore';
import { WorkspaceTools } from '../backend/WorkspaceTools';
import { physicalPath, resolveInsideRootPhysical } from '../backend/workspacePath';
import type { AgentConfig } from '../types';
import { restoreTargetForRow } from '../views/checkpointSummary';
import { RequestCloseoutAccumulator, RequestFileEffects, reviseForRestore } from '../session/RequestCloseoutAccumulator';
import { RequestCloseoutStore } from '../observability/RequestCloseoutStore';
import type { RequestCloseoutRecordV1 } from '../observability/RequestCloseout';

/**
 * extension.ts's own checkpoint recorder and restore commands, run against real folders and stand-ins for VS Code.
 * The extension does not load outside VS Code, so these functions are compiled alone and every other name they use
 * is supplied here (as deactivate.test.ts does). Each case realises a sentence of the restore contract in USAGE.md
 * ("Restoring a file"): a restore is a new write, checked when it happens.
 */
// A name missing from the source is skipped, so the same tests also run against the released functions, where
// restoreCheckpoint still calls resolveInsideWorkspace: that run is the evidence these cases fail before the fix.
const FLOW_FUNCTIONS = [
  'timeAgo',
  'recordCheckpoint',
  'scheduleCheckpointSave',
  'restoreCheckpointCommand',
  'restoreCheckpointByIdCommand',
  'resolveInsideWorkspace',
  'liveCheckpointFile',
  'checkpointRestoreAuthority',
  'hasUnsavedEditorChanges',
  'editorFileKey',
  'describeUndoneEdits',
  'restoreCheckpoint',
  'keepCurrentBeforeRestore',
  'restorePointContent',
  'openRawCheckpoints',
  'noteRestoreOnRequestCloseouts',
  'reviseRequestCloseouts',
];

type Flow = {
  recordCheckpoint(entry: Record<string, unknown>): void;
  openRawCheckpoints(storageRoot: string | undefined): Promise<RawCheckpointStore>;
  restoreCheckpointCommand(): Promise<void>;
  restoreCheckpointByIdCommand(id: unknown): Promise<void>;
};

function loadFlow(state: Record<string, unknown>): Flow {
  const source = readFileSync(path.join(process.cwd(), 'src/extension.ts'), 'utf8');
  const bodies: string[] = [];
  const found: string[] = [];
  for (const name of FLOW_FUNCTIONS) {
    const match = new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`).exec(source);
    if (!match) continue;
    const start = match.index + 1;
    bodies.push(source.slice(start, source.indexOf('\n}\n', start) + 2));
    found.push(name);
  }
  const js = ts.transpileModule(bodies.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('state', `with (state) { ${js}; return { ${found.join(', ')} }; }`)(state) as Flow;
}

const NAMES: Record<string, string> = { dev: 'Dev', qa: 'QA', claude: 'Claude Dev' };

function host(folders: string[]) {
  const notices: Array<{ kind: string; message: string }> = [];
  const prompts: string[] = [];
  const details: Array<string | undefined> = [];
  /** The buttons each confirmation offered. */
  const buttons: string[][] = [];
  /** v0.9.99: what the person clicks on a "Restore anyway" confirmation; by default they keep the current file. */
  const answers = { restoreAnyway: false };
  let pick: number | undefined;
  const checkpointStore = new CheckpointStore();
  const vscode = {
    window: {
      showWarningMessage: async (message: string, options?: { detail?: string }, ...offered: string[]) => {
        prompts.push(message);
        details.push(options?.detail);
        buttons.push(offered);
        if (offered.includes('Restore anyway')) return answers.restoreAnyway ? 'Restore anyway' : 'Keep current file';
        return 'Restore';
      },
      showQuickPick: async (items: Array<{ cp: { id: number } }>) => items.find((item) => item.cp.id === pick),
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: folders.map((folder) => ({ uri: { fsPath: folder } })),
      textDocuments: [] as Array<{ isDirty: boolean; uri: { scheme: string; fsPath: string } }>,
      notebookDocuments: [],
    },
  };
  const state: Record<string, unknown> = {
    vscode,
    fs,
    path,
    Buffer,
    process,
    checkpointStore,
    checkpointSaveTimer: undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    persistence: { saveCheckpoints: () => undefined },
    showResultNotice: (kind: string, message: string) => { notices.push({ kind, message }); },
    outputChannel: { warn: () => undefined, info: () => undefined },
    resolveAgentName: (id: string) => NAMES[id] ?? id,
    runLedger: { recordFileChange: () => undefined },
    sessionManager: {
      currentTurnCorrelationId: () => undefined,
      currentRequestId: () => undefined,
      noteFileRestored: () => false,
      getAll: () => [],
    },
    agentFileWrites: new Map(),
    requestCloseoutStore: undefined,
    reviseForRestore,
    chatViewProvider: { refreshChangedFiles: () => undefined },
    workspaceRoot: () => folders[0],
    resolveInsideRootPhysical,
    physicalPath,
    restoreTargetForRow,
    checkpointRestoreDisabledMessage,
    checkpointRestorePlan,
    prepareCheckpointRestore,
    commitCheckpointRestore,
    currentBytesAsPrepared,
    checkpointKeepsText,
    checkpointEvidenceLabel,
    preChangeCheckpoints: undefined,
    RawCheckpointStore,
    rawCheckpointLocation,
    firstWorkspaceRoot: () => folders[0],
  };
  const flow = loadFlow(state);
  return {
    flow,
    vscode,
    state,
    notices,
    prompts,
    details,
    buttons,
    answers,
    store: checkpointStore,
    choose: (id: number) => { pick = id; },
  };
}

/** The agent's own file tools, rooted where its working folder is, recording through the extension's sink. */
function agentTools(base: string, flow: Flow, agentId = 'dev'): WorkspaceTools {
  return new WorkspaceTools(
    base, new Set(['read', 'write']), agentId, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (entry) => flow.recordCheckpoint(entry), () => false, undefined, undefined, undefined, undefined, [], () => true, [base],
  );
}

/**
 * The extension's raw-byte restore points, opened through its own openRawCheckpoints, and an agent whose file tools
 * keep them before each change (the decision rules are P2's; the person approves here).
 */
async function withRawRestorePoints(h: ReturnType<typeof host>) {
  const storage = await workspace();
  const checkpoints = new PreChangeCheckpoints({ open: () => h.flow.openRawCheckpoints(storage), isRequestRunning: () => false });
  h.state.preChangeCheckpoints = checkpoints;
  const policy = new FileWritePolicy({ workspaceId: () => 'workspace', checkpoints });
  const opened = async () => {
    const result = await checkpoints.store();
    if ('unavailable' in result) throw new Error(result.unavailable);
    return result.store;
  };
  return {
    storage,
    store: opened,
    tools: (base: string, agentId = 'dev') => {
      const tools = agentTools(base, h.flow, agentId);
      tools.setFileWrites(policy.forAgent({ agentId, decide: async () => 'once' }));
      return tools;
    },
  };
}

const temps: string[] = [];
async function workspace(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-restore-flow-')));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function put(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}
const read = (file: string) => fs.readFile(file, 'utf8');
async function gone(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => false, () => true);
}

describe('checkpoint restore names the file the change was recorded for', () => {
  it('restores an agent scoped to a subfolder in that subfolder, not under the first workspace folder', async () => {
    const root = await workspace();
    const main = path.join(root, 'main');
    const web = path.join(main, 'packages', 'web');
    await put(path.join(main, 'src', 'a.ts'), 'MAIN ORIGINAL');
    await put(path.join(web, 'src', 'a.ts'), 'WEB BEFORE');
    const { flow, store } = host([main]);

    await agentTools(web, flow).runText('write_file', { path: 'src/a.ts', content: 'WEB AFTER' });
    await flow.restoreCheckpointByIdCommand(store.list()[0].id);

    expect(await read(path.join(main, 'src', 'a.ts'))).toBe('MAIN ORIGINAL');
    expect(await read(path.join(web, 'src', 'a.ts'))).toBe('WEB BEFORE');
  });

  it('restores a worktree agent in its worktree, not in the main checkout', async () => {
    const root = await workspace();
    const main = path.join(root, 'main');
    const worktree = path.join(main, '.unode', 'worktrees', 'dev');
    await put(path.join(main, 'src', 'a.ts'), 'MAIN ORIGINAL');
    await put(path.join(worktree, 'src', 'a.ts'), 'TREE BEFORE');
    const { flow, store } = host([main]);

    await agentTools(worktree, flow).runText('write_file', { path: 'src/a.ts', content: 'TREE AFTER' });
    await flow.restoreCheckpointByIdCommand(store.list()[0].id);

    expect(await read(path.join(main, 'src', 'a.ts'))).toBe('MAIN ORIGINAL');
    expect(await read(path.join(worktree, 'src', 'a.ts'))).toBe('TREE BEFORE');
  });

  it('does not delete a same-named file of the first folder when undoing a file another folder\'s agent created', async () => {
    const root = await workspace();
    const main = path.join(root, 'main');
    const other = path.join(root, 'other');
    await put(path.join(main, 'notes.md'), 'MAIN NOTES');
    await fs.mkdir(other, { recursive: true });
    const { flow, store } = host([main, other]);

    await agentTools(other, flow).runText('write_file', { path: 'notes.md', content: 'NEW IN OTHER' });
    await flow.restoreCheckpointByIdCommand(store.list()[0].id);

    expect(await read(path.join(main, 'notes.md'))).toBe('MAIN NOTES');
    expect(await gone(path.join(other, 'notes.md'))).toBe(true);
  });

  it('restores a Claude edit made by a relative path in a worktree in that worktree', async () => {
    const root = await workspace();
    const main = path.join(root, 'main');
    const worktree = path.join(main, '.unode', 'worktrees', 'claude');
    await put(path.join(main, 'src', 'a.ts'), 'MAIN ORIGINAL');
    await put(path.join(worktree, 'src', 'a.ts'), 'const x = 1;\n');
    const { flow, store } = host([main]);
    const backend = claudeBackend(worktree, flow);

    await claudeEdit(backend, worktree, 'src/a.ts', 'const x = 1;', 'const x = 2;');
    await flow.restoreCheckpointByIdCommand(store.list()[0].id);

    expect(await read(path.join(main, 'src', 'a.ts'))).toBe('MAIN ORIGINAL');
    expect(await read(path.join(worktree, 'src', 'a.ts'))).toBe('const x = 1;\n');
    expect(store.list()[0].restored).toBeDefined();
  });

  it('restores a Claude edit made by an absolute path in the second workspace folder', async () => {
    const root = await workspace();
    const main = path.join(root, 'main');
    const other = path.join(root, 'other');
    await fs.mkdir(main, { recursive: true });
    await put(path.join(other, 'doc.md'), 'alpha\n');
    const { flow, store, notices } = host([main, other]);
    const backend = claudeBackend(other, flow);

    await claudeEdit(backend, other, path.join(other, 'doc.md'), 'alpha', 'beta');
    await flow.restoreCheckpointByIdCommand(store.list()[0].id);

    expect(await read(path.join(other, 'doc.md'))).toBe('alpha\n');
    expect(notices.at(-1)?.kind).toBe('information');
  });

  it('keeps the plain case working: an agent in the first folder gets its file back', async () => {
    const root = await workspace();
    const main = path.join(root, 'main');
    await put(path.join(main, 'a.txt'), 'before');
    const { flow, store, notices } = host([main]);

    await agentTools(main, flow).runText('write_file', { path: 'a.txt', content: 'after' });
    await flow.restoreCheckpointByIdCommand(store.list()[0].id);

    expect(await read(path.join(main, 'a.txt'))).toBe('before');
    expect(notices.at(-1)).toEqual({ kind: 'information', message: 'Restored a.txt.' });
  });
});

describe('checkpoint restore runs under the authority of now', () => {
  it('refuses in an untrusted workspace and changes nothing', async () => {
    const root = await workspace();
    await put(path.join(root, 'a.txt'), 'before');
    const { flow, store, vscode, notices } = host([root]);
    await agentTools(root, flow).runText('write_file', { path: 'a.txt', content: 'after' });

    vscode.workspace.isTrusted = false;
    await flow.restoreCheckpointByIdCommand(store.list()[0].id);

    expect(await read(path.join(root, 'a.txt'))).toBe('after');
    expect(notices.at(-1)?.message).toContain('not trusted');
  });

  it('offers no Restore anyway in an untrusted workspace, even over newer work', async () => {
    const root = await workspace();
    await put(path.join(root, 'a.txt'), 'before');
    const { flow, store, vscode, notices, buttons, answers } = host([root]);
    await agentTools(root, flow).runText('write_file', { path: 'a.txt', content: 'after' });
    await fs.writeFile(path.join(root, 'a.txt'), 'my newer work', 'utf8');
    answers.restoreAnyway = true;

    vscode.workspace.isTrusted = false;
    await flow.restoreCheckpointByIdCommand(store.list()[0].id);

    expect(await read(path.join(root, 'a.txt'))).toBe('my newer work');
    expect(buttons).toEqual([]);
    expect(notices.at(-1)?.message).toContain('not trusted');
  });

  // v0.9.99 (A15): unsaved editor changes and newer work are no longer a dead end. The one confirmation every
  // restore shows says why and offers "Restore anyway"; keeping the current file changes nothing.
  it('offers Restore anyway over unsaved editor changes; keeping the current file changes nothing', async () => {
    const root = await workspace();
    await put(path.join(root, 'a.txt'), 'before');
    const { flow, store, vscode, notices, prompts, buttons } = host([root]);
    await agentTools(root, flow).runText('write_file', { path: 'a.txt', content: 'after' });

    vscode.workspace.textDocuments.push({ isDirty: true, uri: { scheme: 'file', fsPath: path.join(root, 'a.txt') } });
    await flow.restoreCheckpointByIdCommand(store.list()[0].id);

    expect(await read(path.join(root, 'a.txt'))).toBe('after');
    expect(buttons).toEqual([['Keep current file', 'Restore anyway']]);
    expect(prompts.at(-1)).toBe("a.txt: it has unsaved changes in an editor. Restore it anyway to the version before Dev's edit? "
      + 'UnodeAi keeps its current contents as a new restore point first, so ⟲ can bring them back. Your unsaved text stays in the editor.');
    expect(notices).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });

  it('restores over unsaved editor changes when the person chooses Restore anyway, and leaves the editor alone', async () => {
    const root = await workspace();
    await put(path.join(root, 'a.txt'), 'before');
    const h = host([root]);
    await agentTools(root, h.flow).runText('write_file', { path: 'a.txt', content: 'after' });
    const editor = { isDirty: true, uri: { scheme: 'file', fsPath: path.join(root, 'a.txt') } };
    h.vscode.workspace.textDocuments.push(editor);
    h.answers.restoreAnyway = true;

    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);

    expect(await read(path.join(root, 'a.txt'))).toBe('before');
    expect(editor.isDirty).toBe(true);
    expect(h.notices.at(-1)).toEqual({ kind: 'information', message: 'Restored a.txt.' });
  });

  it('keeps the newer work as a restore point of its own before Restore anyway, so the person can bring it back', async () => {
    const root = await workspace();
    await put(path.join(root, 'a.txt'), 'before');
    const h = host([root]);
    await agentTools(root, h.flow).runText('write_file', { path: 'a.txt', content: 'agent edit' });
    await fs.writeFile(path.join(root, 'a.txt'), 'my newer work', 'utf8');

    // Kept: nothing changes, and nothing is recorded.
    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);
    expect(await read(path.join(root, 'a.txt'))).toBe('my newer work');
    expect(h.prompts.at(-1)).toMatch(/^a\.txt: it changed after UnodeAi last recorded it, so a restore would replace work UnodeAi has no record of\. Restore it anyway/);
    expect(h.store.list()).toHaveLength(1);

    h.answers.restoreAnyway = true;
    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);
    expect(await read(path.join(root, 'a.txt'))).toBe('before');
    const yours = h.store.list().find((c) => c.agentName === 'You')!;
    expect(yours).toMatchObject({ path: 'a.txt', before: 'my newer work', after: 'before', operation: 'write' });

    // The person's own ⟲ on that record puts the newer work back, as an ordinary restore.
    await h.flow.restoreCheckpointByIdCommand(yours.id);
    expect(await read(path.join(root, 'a.txt'))).toBe('my newer work');
    expect(h.buttons.at(-1)).toEqual(['Keep current file', 'Restore']);
  });

  it('keeps the exact bytes of newer work that is not text before Restore anyway, and restores from them', async () => {
    const root = await workspace();
    await put(path.join(root, 'a.txt'), 'before');
    const h = host([root]);
    const raw = await withRawRestorePoints(h);
    await raw.tools(root).runText('write_file', { path: 'a.txt', content: 'agent edit' });
    const newer = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0d, 0x0a]);
    await fs.writeFile(path.join(root, 'a.txt'), newer);
    h.answers.restoreAnyway = true;

    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);
    expect(await read(path.join(root, 'a.txt'))).toBe('before');
    const yours = h.store.list().find((c) => c.agentName === 'You')!;
    expect(yours.raw).toBeDefined();
    expect((await raw.store()).get(yours.raw!.id)?.before).toMatchObject({ exists: true, size: newer.length });

    await h.flow.restoreCheckpointByIdCommand(yours.id);
    expect(await fs.readFile(path.join(root, 'a.txt'))).toEqual(newer);
  });

  it('says plainly when newer work cannot be kept, and keeps no fake restore point', async () => {
    const root = await workspace();
    await put(path.join(root, 'a.txt'), 'before');
    const h = host([root]);
    await agentTools(root, h.flow).runText('write_file', { path: 'a.txt', content: 'agent edit' });
    // Not UTF-8 and no raw restore points in this window: neither its bytes nor its text can be kept.
    await fs.writeFile(path.join(root, 'a.txt'), Buffer.from([0xff, 0xfe, 0x00]));
    h.answers.restoreAnyway = true;

    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);

    expect(h.prompts.at(-1)).toMatch(/Its current contents cannot be kept \(there is no restore-point store in this window\), so they cannot be brought back\.$/);
    expect(await read(path.join(root, 'a.txt'))).toBe('before');
    expect(h.store.list().filter((c) => c.agentName === 'You')).toEqual([]);
  });

  it('deletes a created file that was edited afterwards only on Restore anyway, keeping the edit as a restore point', async () => {
    const root = await workspace();
    const h = host([root]);
    await agentTools(root, h.flow).runText('write_file', { path: 'new.md', content: 'agent draft' });

    await fs.writeFile(path.join(root, 'new.md'), 'my rewrite of the draft', 'utf8');
    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);
    expect(await read(path.join(root, 'new.md'))).toBe('my rewrite of the draft');
    expect(h.prompts.at(-1)).toMatch(/^new\.md: .* Delete it anyway\? It didn't exist before Dev's edit\./);

    h.answers.restoreAnyway = true;
    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);
    expect(await gone(path.join(root, 'new.md'))).toBe(true);
    const yours = h.store.list().find((c) => c.agentName === 'You')!;
    await h.flow.restoreCheckpointByIdCommand(yours.id);
    expect(await read(path.join(root, 'new.md'))).toBe('my rewrite of the draft');
  });

  it('Restore anyway still refuses when the file changes after the person chose, and keeps nothing of it', async () => {
    const root = await workspace();
    await put(path.join(root, 'a.txt'), 'before');
    const h = host([root]);
    await agentTools(root, h.flow).runText('write_file', { path: 'a.txt', content: 'agent edit' });
    await fs.writeFile(path.join(root, 'a.txt'), 'my newer work', 'utf8');
    const window = h.vscode.window as unknown as { showWarningMessage: (...args: unknown[]) => Promise<string> };
    window.showWarningMessage = async () => { await fs.writeFile(path.join(root, 'a.txt'), 'typed after the choice', 'utf8'); return 'Restore anyway'; };

    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);

    expect(await read(path.join(root, 'a.txt'))).toBe('typed after the choice');
    expect(h.notices.at(-1)?.message).toMatch(/changed while the restore was waiting/);
    expect(h.store.list().filter((c) => c.agentName === 'You')).toEqual([]);
  });

  it('never writes a deleted folder back as a file holding its listing', async () => {
    const root = await workspace();
    await put(path.join(root, 'build', 'out.js'), 'compiled');
    const { flow, store, notices } = host([root]);
    await agentTools(root, flow).runText('delete_dir', { path: 'build' });

    await flow.restoreCheckpointByIdCommand(store.list()[0].id);

    expect(await gone(path.join(root, 'build'))).toBe(true);
    expect(notices.at(-1)?.message).toContain('cannot be restored');
  });

  it('does not write back decoded text as if it were a file that was not UTF-8', async () => {
    const root = await workspace();
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]); // "café" in Latin-1
    await fs.writeFile(path.join(root, 'menu.txt'), latin1);
    const { flow, store, notices } = host([root]);
    await agentTools(root, flow).runText('write_file', { path: 'menu.txt', content: 'cafe\r\n' });

    await flow.restoreCheckpointByIdCommand(store.list()[0].id);

    expect(await read(path.join(root, 'menu.txt'))).toBe('cafe\r\n');
    expect(notices.at(-1)?.message).toContain('not UTF-8 text');
  });

  it('names every later recorded edit it undoes, by whom, before it acts', async () => {
    const root = await workspace();
    await put(path.join(root, 'shared.ts'), 'v1');
    const { flow, store, prompts, choose } = host([root]);
    await agentTools(root, flow, 'dev').runText('write_file', { path: 'shared.ts', content: 'v2' });
    await agentTools(root, flow, 'qa').runText('write_file', { path: 'shared.ts', content: 'v3' });

    choose(store.list().find((c) => c.agentId === 'dev')!.id);
    await flow.restoreCheckpointCommand();

    expect(prompts.at(-1)).toContain('2 edits (1 by Dev, 1 by QA)');
    expect(await read(path.join(root, 'shared.ts'))).toBe('v1');
  });

  it('does not offer the same restore twice', async () => {
    const root = await workspace();
    await put(path.join(root, 'a.txt'), 'before');
    const { flow, store, notices } = host([root]);
    await agentTools(root, flow).runText('write_file', { path: 'a.txt', content: 'after' });
    const id = store.list()[0].id;
    await flow.restoreCheckpointByIdCommand(id);
    await fs.writeFile(path.join(root, 'a.txt'), 'my next edit', 'utf8');

    await flow.restoreCheckpointByIdCommand(id);

    expect(await read(path.join(root, 'a.txt'))).toBe('my next edit');
    expect(notices.at(-1)?.message).toContain('already restored');
  });
});

describe('checkpoint restore puts back the exact bytes kept before the change', () => {
  it('restores a file that was not UTF-8 byte for byte, and says which restore point it uses', async () => {
    const root = await workspace();
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]); // "café\r\n" in Latin-1
    await fs.writeFile(path.join(root, 'menu.txt'), latin1);
    const h = host([root]);
    const raw = await withRawRestorePoints(h);
    await raw.tools(root).runText('write_file', { path: 'menu.txt', content: 'cafe\r\n' });

    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);

    expect(await fs.readFile(path.join(root, 'menu.txt'))).toEqual(latin1);
    expect(h.details.at(-1)).toContain('Restore point: exact bytes kept before the edit');
    expect(h.notices.at(-1)).toEqual({ kind: 'information', message: 'Restored menu.txt.' });
  });

  it('restores a binary file that write_file replaced with text', async () => {
    const root = await workspace();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0xd8]);
    await fs.writeFile(path.join(root, 'logo.png'), png);
    const h = host([root]);
    const raw = await withRawRestorePoints(h);
    await raw.tools(root).runText('write_file', { path: 'logo.png', content: 'not an image' });

    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);

    expect(await fs.readFile(path.join(root, 'logo.png'))).toEqual(png);
  });

  it('puts back a binary file delete_file removed', async () => {
    const root = await workspace();
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x0d, 0x0a, 0x80]);
    await fs.writeFile(path.join(root, 'blob.bin'), bytes);
    const h = host([root]);
    const raw = await withRawRestorePoints(h);
    await raw.tools(root).runText('delete_file', { path: 'blob.bin' });

    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);

    expect(h.prompts.at(-1)).toMatch(/^Restore blob\.bin to the version before/);
    expect(await fs.readFile(path.join(root, 'blob.bin'))).toEqual(bytes);
  });

  it('restores a file whose text was too large to keep, from its exact bytes', async () => {
    const root = await workspace();
    const before = 'x'.repeat(250_000);
    await fs.writeFile(path.join(root, 'big.txt'), before);
    const h = host([root]);
    const raw = await withRawRestorePoints(h);
    await raw.tools(root).runText('write_file', { path: 'big.txt', content: 'y'.repeat(250_000) });
    expect(h.store.list()[0]).toMatchObject({ truncated: true, before: null });

    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);

    expect(await read(path.join(root, 'big.txt'))).toBe(before);
  });

  it('refuses, and never falls back to the kept text, when the exact bytes cannot be used', async () => {
    const root = await workspace();
    await put(path.join(root, 'a.txt'), 'before');
    const h = host([root]);
    const raw = await withRawRestorePoints(h);
    await raw.tools(root).runText('write_file', { path: 'a.txt', content: 'after' });
    const store = await raw.store();
    const payload = path.join(rawCheckpointLocation(raw.storage, root).directory, 'payloads', `${store.list()[0].id}.bin`);
    await fs.writeFile(payload, 'BEFORE'); // same size, other bytes

    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);

    expect(await read(path.join(root, 'a.txt'))).toBe('after');
    expect(h.notices.at(-1)?.kind).toBe('warning');
    expect(h.notices.at(-1)?.message).toContain('does not match the recorded SHA-256');
  });

  it('drops a record whose exact bytes are gone, when the store opens and whenever it removes them', async () => {
    const root = await workspace();
    await put(path.join(root, 'a.txt'), 'before');
    const h = host([root]);
    // Saved by an earlier session, naming a restore point this workspace's store no longer has.
    h.store.record({ agentId: 'dev', agentName: 'Dev', path: 'gone.txt', target: path.join(root, 'gone.txt'), operation: 'write', before: 'x', after: 'y', raw: { id: 'f'.repeat(32), afterSha256: null } });
    const raw = await withRawRestorePoints(h);
    await raw.tools(root).runText('write_file', { path: 'a.txt', content: 'after' });
    expect(h.store.list().map((c) => c.path)).toEqual(['a.txt']);

    const store = await raw.store();
    expect(await store.remove(store.list()[0].id)).toBe(true);

    expect(h.store.list()).toEqual([]);
  });

  it('labels a text restore point as text where it is confirmed', async () => {
    const root = await workspace();
    await put(path.join(root, 'a.txt'), 'before');
    const h = host([root]);
    await agentTools(root, h.flow).runText('write_file', { path: 'a.txt', content: 'after' });

    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);

    expect(await read(path.join(root, 'a.txt'))).toBe('before');
    expect(h.details.at(-1)).toContain('Restore point: text copy kept by UnodeAi');
  });
});

function claudeBackend(cwd: string, flow: Flow): ClaudeHeadlessBackend {
  const config: AgentConfig = {
    id: 'claude',
    name: 'Claude Dev',
    role: 'developer',
    skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-5',
    systemPrompt: '',
    autoApprove: true,
    allowedTools: [],
    backend: 'claude',
    workingDirectory: cwd,
  };
  return new ClaudeHeadlessBackend(config, undefined, undefined, { recordCheckpoint: (entry) => flow.recordCheckpoint(entry) });
}

/** One native Edit as Claude's stream reports it, with the CLI's own write in between. */
async function claudeEdit(backend: ClaudeHeadlessBackend, cwd: string, filePath: string, oldString: string, newString: string) {
  const id = `edit-${Math.random().toString(16).slice(2)}`;
  (backend as any).handleEvent({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: filePath, old_string: oldString, new_string: newString } }] },
  });
  const file = path.resolve(cwd, filePath);
  await fs.writeFile(file, (await read(file)).replace(oldString, newString), 'utf8');
  (backend as any).handleEvent({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
  });
}


/*
 * v0.9.97 P5: handoff §5, "a later host restore, delete or uncertain effect shows the final observed state", and §7 row
 * P5, "only the existing closeout is updated". A restore of the person names the request each undone change was made
 * for; that request's closeout shows the change as restored, or as removed when the restore deleted a file the change
 * created. Another request's record of the same file is left as it is.
 */
describe('a restore shows on the closeout of the request whose change it undid (v0.9.97 P5)', () => {
  /** The closeout record of one turn of a request that wrote these paths, host-verified. */
  function recordOf(requestId: string, turnId: string, paths: string[]): RequestCloseoutRecordV1 {
    const effects = new RequestFileEffects();
    for (const shown of paths) effects.effect({ path: shown, key: shown, operation: 'write', grade: 'host-verified' });
    const turn = new RequestCloseoutAccumulator({ requestId, rootAgentId: 'dev', originTurnId: turnId, terminalTurnId: turnId }, effects);
    return turn.finish({ terminal: { kind: 'answered' }, recordedAt: '2026-10-20T01:00:00.000Z', eventsCut: false })!;
  }

  async function withCloseouts(held: boolean) {
    const root = await workspace();
    const h = host([root]);
    const values = new Map<string, unknown>();
    const closeouts = new RequestCloseoutStore({ get: (key) => values.get(key), update: (key, value) => { values.set(key, value); } });
    const restoredOnLedger: Array<[string, string, string]> = [];
    const writes = new FileWritePolicy({ workspaceId: () => 'workspace' })
      .forAgent({ agentId: 'dev', base: root, requestId: () => 'req-1', decide: async () => 'once' });
    (h.state.agentFileWrites as Map<string, unknown>).set('dev', writes);
    h.state.requestCloseoutStore = closeouts;
    h.state.sessionManager = {
      currentTurnCorrelationId: () => undefined,
      currentRequestId: (agentId: string) => (agentId === 'dev' ? 'req-1' : undefined),
      noteFileRestored: (requestId: string, shown: string, outcome: string) => { restoredOnLedger.push([requestId, shown, outcome]); return held; },
      getAll: () => [{ id: 'dev' }],
    };
    const tools = agentTools(root, h.flow);
    tools.setFileWrites(writes);
    return { root, h, closeouts, tools, restoredOnLedger };
  }

  it('marks the change restored on its request\'s stored records, and on no other request\'s', async () => {
    const { root, h, closeouts, tools } = await withCloseouts(false);
    await put(path.join(root, 'docs', 'a.md'), 'BEFORE');
    expect(closeouts.upsert(recordOf('req-1', 'turn-1', ['docs/a.md']))).toBe('stored');
    expect(closeouts.upsert(recordOf('req-2', 'turn-2', ['docs/a.md']))).toBe('stored');
    await tools.runText('write_file', { path: 'docs/a.md', content: 'AFTER' });
    const [change] = h.store.list();
    expect(change.request).toEqual({ id: 'req-1', path: 'docs/a.md' });

    await h.flow.restoreCheckpointByIdCommand(change.id);

    expect(await read(path.join(root, 'docs', 'a.md'))).toBe('BEFORE');
    const [first, second] = closeouts.list('dev');
    expect(first.requestId).toBe('req-1');
    expect(first.revision).toBe(2);
    expect(first.observations.changes.files).toEqual([{ path: 'docs/a.md', operation: 'write', evidence: 'host-verified', restore: 'restored' }]);
    expect(second).toEqual(recordOf('req-2', 'turn-2', ['docs/a.md']));
  });

  it('marks a created file the restore deleted as removed', async () => {
    const { root, h, closeouts, tools } = await withCloseouts(false);
    closeouts.upsert(recordOf('req-1', 'turn-1', ['new.txt']));
    await tools.runText('write_file', { path: 'new.txt', content: 'NEW' });
    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);
    expect(await gone(path.join(root, 'new.txt'))).toBe(true);
    expect(closeouts.list('dev')[0].observations.changes.files[0]).toMatchObject({ path: 'new.txt', restore: 'removed' });
  });

  it('tells the request\'s ledger while it is held, which then revises the records itself', async () => {
    const { root, h, closeouts, tools, restoredOnLedger } = await withCloseouts(true);
    await put(path.join(root, 'a.txt'), 'BEFORE');
    closeouts.upsert(recordOf('req-1', 'turn-1', ['a.txt']));
    await tools.runText('write_file', { path: 'a.txt', content: 'AFTER' });
    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);
    expect(restoredOnLedger).toEqual([['req-1', 'a.txt', 'restored']]);
    expect(closeouts.list('dev')[0].revision).toBe(1);
  });

  it('shows nothing for a restore the person declines', async () => {
    const { root, h, closeouts, tools, restoredOnLedger } = await withCloseouts(false);
    await put(path.join(root, 'a.txt'), 'BEFORE');
    closeouts.upsert(recordOf('req-1', 'turn-1', ['a.txt']));
    await tools.runText('write_file', { path: 'a.txt', content: 'AFTER' });
    (h.vscode.window as { showWarningMessage: unknown }).showWarningMessage = async () => 'Keep current file';
    await h.flow.restoreCheckpointByIdCommand(h.store.list()[0].id);
    expect(await read(path.join(root, 'a.txt'))).toBe('AFTER');
    expect(restoredOnLedger).toEqual([]);
    expect(closeouts.list('dev')[0].revision).toBe(1);
  });
});
