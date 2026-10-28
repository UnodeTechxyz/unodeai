import { mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatFileLinkReference } from '../../../views/fileLinks';
import { agentConfig, navigationHost, tempFolder } from '../../../views/__tests__/support/fileNavigationHost';

/*
 * v0.9.97 FOPEN: the host navigation boundary a reply's file link and a read_file receipt share. Real folders on
 * disk; the editor and the notices are recorded. USAGE "File links in a reply" and SECURITY.md "Chat file links open
 * through one host boundary" state what each test pins.
 */
const FIELD_FILE = 'PolyFlow_Compliance_Working_Draft_Merged.md';
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

function folder(files: Record<string, string>): string {
  const made = tempFolder(files);
  cleanups.push(made.cleanup);
  return made.root;
}

// FOPEN-N1: a reply now also records the agent's read ceiling when it was written. Here it defaults to the recorded
// folders (the agent's scope in these tests), and a test passes it explicitly to model a later widening/narrowing.
function link(destination: string, roots?: string[], stillShown = () => true, ceilings = roots): ChatFileLinkReference {
  return { destination, ...(roots ? { roots } : {}), ...(ceilings ? { ceilings } : {}), stillShown };
}

describe('a reply file link through the host navigation boundary', () => {
  it('opens the field file by its relative path in the folder recorded with the reply, at its real path', async () => {
    const ws = folder({ [FIELD_FILE]: '# Draft', 'docs/notes.md': 'notes' });
    const host = navigationHost([ws], [agentConfig('dev')]);

    await host.adapter.openFileReference('dev', link(FIELD_FILE, [ws]));
    await host.adapter.openFileReference('dev', link('docs/notes.md#L3', [ws]));
    await host.adapter.openFileReference('dev', link(path.join(ws, FIELD_FILE), undefined, undefined, [ws]));

    expect(host.opened).toEqual([
      { path: path.join(ws, FIELD_FILE) },
      { path: path.join(ws, 'docs', 'notes.md'), position: { line: 3 } },
      { path: path.join(ws, FIELD_FILE) },
    ]);
    expect(host.notices).toEqual([]);
  });

  it('keeps reading an old reply against its own folder after the agent moved to another one', async () => {
    const before = folder({ 'docs/plan.md': 'the old plan' });
    const after = folder({ 'docs/plan.md': 'a different plan' });
    const config = agentConfig('dev', { workingDirectory: after });
    const host = navigationHost([before, after], [config]);

    await host.adapter.openFileReference('dev', link('docs/plan.md', [before]));

    expect(host.opened).toEqual([{ path: path.join(before, 'docs', 'plan.md') }]);
    expect(host.pick).not.toHaveBeenCalled();
  });

  it('asks which folder when the reply recorded several, opens only the chosen one, and opens nothing on cancel', async () => {
    const first = folder({ 'docs/same.md': 'first' });
    const second = folder({ 'docs/same.md': 'second' });
    const host = navigationHost([first, second], [agentConfig('dev')]);

    host.pick.mockResolvedValueOnce(second);
    await host.adapter.openFileReference('dev', link('docs/same.md', [first, second]));
    expect(host.pick).toHaveBeenCalledWith([first, second], 'docs/same.md');
    expect(host.opened).toEqual([{ path: path.join(second, 'docs', 'same.md') }]);

    host.pick.mockResolvedValueOnce(undefined);
    await host.adapter.openFileReference('dev', link('docs/same.md', [first, second]));
    host.pick.mockResolvedValueOnce(path.join(first, 'docs'));
    await host.adapter.openFileReference('dev', link('docs/same.md', [first, second]));
    expect(host.opened).toHaveLength(1);
    expect(host.notices).toEqual([
      { message: 'No folder was chosen for "docs/same.md", so nothing was opened.', reference: 'docs/same.md' },
      { message: 'No folder was chosen for "docs/same.md", so nothing was opened.', reference: 'docs/same.md' },
    ]);
  });

  it('opens nothing for a reply with no recorded read ceiling (FOPEN-N1: fail closed, grants nothing)', async () => {
    // A reply written before the message-time ceiling was recorded (or one imported, whose scope is dropped) has no
    // provable authority, so clicking its link opens nothing even though the file is inside the agent's scope now.
    const only = folder({ 'a.md': 'a' });
    const host = navigationHost([only], [agentConfig('dev')]);
    await host.adapter.openFileReference('dev', { destination: 'a.md', roots: [only], stillShown: () => true }); // no ceilings
    expect(host.opened).toEqual([]);
    expect(host.notices).toEqual([{
      message: `"a.md" is outside the read folders the agent had when it wrote this reply, so UnodeAi did not open it. A later change to the agent's folders does not open an old link.`,
      reference: 'a.md',
    }]);
  });

  it('FOPEN-N1: widening the agent after a reply does not open an old out-of-scope link', async () => {
    // The reply is written when the agent may read only <ws>/docs; it contains an absolute link to <ws>/private.
    const ws = folder({ 'docs/note.md': 'in scope', 'private/secret.md': 'out of scope at write time' });
    const docsOnly = agentConfig('dev', { folderAccess: [{ path: path.join(ws, 'docs'), permission: 'read' }] });
    const host = navigationHost([ws], [docsOnly]);
    const secret = link(path.join(ws, 'private', 'secret.md'), undefined, () => true, [path.join(ws, 'docs')]);

    await host.adapter.openFileReference('dev', secret); // refused: outside the message-time ceiling (docs)
    host.configs.set('dev', agentConfig('dev')); // the user later widens the agent to the whole workspace
    await host.adapter.openFileReference('dev', secret); // still refused: an old link does not gain the new scope

    expect(host.opened).toEqual([]);
    expect(host.notices.map((notice) => notice.reference)).toEqual([
      path.join(ws, 'private', 'secret.md'),
      path.join(ws, 'private', 'secret.md'),
    ]);
    // The first refusal is the current-ceiling check (docs); the second is the message-time ceiling (FOPEN-N1).
    expect(host.notices[1].message).toContain('when it wrote this reply');
  });

  it('FOPEN-RC-N1: an old reply keeps the real folder it was written in when a junction is pointed elsewhere', async () => {
    const before = folder({ 'note.md': 'in A' });
    const after = folder({ 'secret.md': 'in B: outside the agent\'s folders when the reply was written' });
    const workspaceLink = path.join(folder({}), 'workspace-link');
    // A junction on Windows; a directory symlink elsewhere. Neither needs elevation.
    symlinkSync(before, workspaceLink, 'junction');
    const host = navigationHost([workspaceLink], [agentConfig('dev')]);
    const ceilings = host.adapter.fileLinkCeilings('dev');
    expect(ceilings).toEqual([before]);

    await host.adapter.openFileReference('dev', link(path.join(workspaceLink, 'note.md'), undefined, () => true, ceilings));
    unlinkSync(workspaceLink);
    symlinkSync(after, workspaceLink, 'junction');
    await host.adapter.openFileReference('dev', link(path.join(workspaceLink, 'secret.md'), undefined, () => true, ceilings));
    await host.adapter.openFileReference('dev', link('secret.md', [workspaceLink], () => true, ceilings));

    // The agent may read B through the link today; the reply was written when it could read only A.
    expect(host.opened).toEqual([{ path: path.join(before, 'note.md') }]);
    expect(host.notices.map((notice) => notice.reference)).toEqual([path.join(workspaceLink, 'secret.md'), 'secret.md']);
    expect(host.notices.every((notice) => notice.message.includes('when it wrote this reply'))).toBe(true);
  });

  it('FOPEN-RC-N1: the recorded real folder is not resolved again when it is itself replaced by a junction', async () => {
    const before = folder({ 'note.md': 'in A' });
    const after = folder({ 'secret.md': 'in B: outside the agent\'s folders when the reply was written' });
    const host = navigationHost([before], [agentConfig('dev')]);
    const ceilings = host.adapter.fileLinkCeilings('dev');
    expect(ceilings).toEqual([before]);

    // A's own path becomes a junction to B. The agent reads B through it today.
    rmSync(before, { recursive: true, force: true });
    symlinkSync(after, before, 'junction');
    await host.adapter.openFileReference('dev', link(path.join(before, 'secret.md'), undefined, () => true, ceilings));

    expect(host.opened).toEqual([]);
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].message).toContain('when it wrote this reply');
  });

  it('FOPEN-RC-N1: a read folder whose real path cannot be read is not recorded, so it grants nothing later', () => {
    const ws = folder({});
    const missing = path.join(folder({}), 'not-yet-made');
    const host = navigationHost([ws], [agentConfig('dev', { workingDirectory: missing })]);
    const ceilings = host.adapter.fileLinkCeilings('dev') ?? [];
    expect(ceilings).not.toContain(missing);
    expect(ceilings.every((ceiling) => realpathSync(ceiling) === ceiling)).toBe(true);
  });

  it('checks again after the folder choice: a link no longer shown opens nothing', async () => {
    const first = folder({ 'a.md': 'a' });
    const second = folder({ 'a.md': 'b' });
    const host = navigationHost([first, second], [agentConfig('dev')]);
    let shown = true;
    host.pick.mockImplementationOnce(async () => { shown = false; return first; });

    await host.adapter.openFileReference('dev', link('a.md', [first, second], () => shown));

    expect(host.opened).toEqual([]);
    expect(host.notices).toEqual([{
      message: 'The conversation shown changed before the file could open, so nothing was opened. Click the link again.',
    }]);
  });

  it('applies the agent\'s read folders as they are when clicked: removed agent, narrowed folders, other folders', async () => {
    const ws = folder({ 'docs/a.md': 'a', 'src/b.ts': 'b' });
    const elsewhere = folder({ 'secret.md': 'not in the workspace' });
    const host = navigationHost([ws], [agentConfig('dev')]);

    await host.adapter.openFileReference('dev', link(path.join(elsewhere, 'secret.md')));
    host.configs.set('dev', agentConfig('dev', { folderAccess: [{ path: path.join(ws, 'docs'), permission: 'read' }] }));
    await host.adapter.openFileReference('dev', link('src/b.ts', [ws]));
    await host.adapter.openFileReference('dev', link('docs/a.md', [ws]));
    host.configs.delete('dev');
    await host.adapter.openFileReference('dev', link('docs/a.md', [ws]));

    expect(host.opened).toEqual([{ path: path.join(ws, 'docs', 'a.md') }]);
    expect(host.notices).toEqual([
      { message: `"${path.join(elsewhere, 'secret.md')}" is outside this agent's current read folders, so UnodeAi did not open it.`, reference: path.join(elsewhere, 'secret.md') },
      { message: '"src/b.ts" is outside this agent\'s current read folders, so UnodeAi did not open it.', reference: 'src/b.ts' },
      { message: 'The agent that wrote "docs/a.md" no longer exists, so its read folders cannot be checked.', reference: 'docs/a.md' },
    ]);
  });

  it('refuses a link out of the workspace through a junction or symlink', async () => {
    const ws = folder({});
    const outside = folder({ 'secret.md': 'outside' });
    symlinkSync(outside, path.join(ws, 'linked'), 'junction');
    const host = navigationHost([ws], [agentConfig('dev')]);

    await host.adapter.openFileReference('dev', link('linked/secret.md', [ws]));

    expect(host.opened).toEqual([]);
    expect(host.notices).toEqual([{
      message: '"linked/secret.md" is outside this agent\'s current read folders, so UnodeAi did not open it.',
      reference: 'linked/secret.md',
    }]);
  });

  it('says so for a missing file, a renamed one, a directory and a remote workspace, and opens nothing', async () => {
    const ws = folder({ 'docs/renamed.md': 'moved here' });
    mkdirSync(path.join(ws, 'reports'));
    const host = navigationHost([ws], [agentConfig('dev')]);

    await host.adapter.openFileReference('dev', link('docs/old-name.md', [ws]));
    await host.adapter.openFileReference('dev', link('reports', [ws]));
    host.local.value = false;
    await host.adapter.openFileReference('dev', link('docs/renamed.md', [ws]));

    expect(host.opened).toEqual([]);
    expect(host.notices).toEqual([
      { message: '"docs/old-name.md" does not exist. It may have been moved, renamed or deleted.', reference: 'docs/old-name.md' },
      { message: '"reports" is a directory. Opening a directory from the chat is not supported yet.', reference: 'reports' },
      { message: 'Chat file links open only in a local window whose workspace folders are on this computer; a remote window or a virtual folder is not supported yet.', reference: 'docs/renamed.md' },
    ]);
  });

  it('reads the destination again and refuses what is not a path on this computer, even if a caller passed it', async () => {
    const ws = folder({ 'a.md': 'a' });
    const host = navigationHost([ws], [agentConfig('dev')]);
    for (const destination of ['command:workbench.action.terminal.new', '../a.md', '%2e%2e/a.md', '//server/share/a.md', 'file:///a.md']) {
      await host.adapter.openFileReference('dev', link(destination, [ws]));
    }
    expect(host.opened).toEqual([]);
    expect(host.notices.map((notice) => notice.reference)).toEqual(['command:workbench.action.terminal.new', '../a.md', '%2e%2e/a.md', '//server/share/a.md', 'file:///a.md']);
    expect(host.notices.every((notice) => notice.message.endsWith('it is not a path on this computer.'))).toBe(true);
  });

  it('opens a file at its start and says so for a location that is not a line, and reports an editor failure', async () => {
    const ws = folder({ 'guide.md': '# Guide' });
    const host = navigationHost([ws], [agentConfig('dev')]);

    await host.adapter.openFileReference('dev', link('guide.md#install', [ws]));
    expect(host.opened).toEqual([{ path: path.join(ws, 'guide.md') }]);
    expect(host.notices).toEqual([{
      message: 'Opened "guide.md#install" at its start: "#install" is not a line, and UnodeAi goes only to #L12 or :12.',
      reference: 'guide.md#install',
    }]);

    host.editorFails.value = true;
    await host.adapter.openFileReference('dev', link('guide.md:9', [ws]));
    expect(host.notices.at(-1)).toEqual({ message: 'VS Code could not open "guide.md:9".', reference: 'guide.md:9' });
  });

  it('shows every chat-side refusal in the same words for both chat surfaces', () => {
    const host = navigationHost([], [agentConfig('dev')]);
    host.adapter.refuseFileNavigation('not-shown');
    host.adapter.refuseFileNavigation('unknown-link');
    host.adapter.refuseFileNavigation('unknown-receipt');
    host.adapter.refuseFileNavigation('changed');
    expect(host.notices.map((notice) => notice.message)).toEqual([
      'That link is in a conversation this chat does not show now. Open that agent\'s conversation and click it there.',
      'This file link is no longer in the conversation UnodeAi keeps, so nothing was opened. Ask the agent for the file again.',
      'This receipt is no longer in the conversation UnodeAi keeps, so its file was not opened.',
      'The conversation shown changed before the file could open, so nothing was opened. Click the link again.',
    ]);
  });
});

describe('a read_file receipt through the same boundary', () => {
  it('keeps its host-recorded path and gains the shared checks: ..name, a link out, a directory', async () => {
    const ws = folder({ '..notes/a.md': 'a' });
    const outside = folder({ 'secret.md': 'outside' });
    symlinkSync(outside, path.join(ws, 'linked'), 'junction');
    const host = navigationHost([ws], [agentConfig('dev')]);

    await host.adapter.openRecordedWorkspaceFile('dev', '..notes/a.md');
    await host.adapter.openRecordedWorkspaceFile('dev', 'linked/secret.md');
    await host.adapter.openRecordedWorkspaceFile('dev', '.');
    await host.adapter.openRecordedWorkspaceFile('gone', 'a.md');

    expect(host.opened).toEqual([{ path: path.join(ws, '..notes', 'a.md') }]);
    expect(host.notices).toEqual([
      { message: '"linked/secret.md" is outside this agent\'s current read folders, so UnodeAi did not open it.', reference: 'linked/secret.md' },
      { message: '"." is a directory. Opening a directory from the chat is not supported yet.', reference: '.' },
      { message: 'This receipt is no longer in the conversation UnodeAi keeps, so its file was not opened.' },
    ]);
  });
});

describe('the folders a reply records for its links', () => {
  it('names the agent\'s own folder when the host knows it, and every folder for the default of a multi-root workspace', () => {
    const one = folder({});
    const two = folder({});
    const worktree = folder({});
    const single = navigationHost([one], [agentConfig('dev')]);
    expect(single.adapter.fileLinkRoots('dev', one)).toEqual([one]);
    expect(single.adapter.fileLinkRoots('dev')).toEqual([one]);

    const multi = navigationHost([one, two], [agentConfig('dev'), agentConfig('set', { workingDirectory: two })]);
    expect(multi.adapter.fileLinkRoots('dev', one)).toEqual([one, two]);
    expect(multi.adapter.fileLinkRoots('dev', worktree)).toEqual([worktree]);
    expect(multi.adapter.fileLinkRoots('set', two)).toEqual([two]);
    expect(multi.adapter.fileLinkRoots('set')).toEqual([two]);
    expect(realpathSync(multi.adapter.fileLinkRoots('dev', worktree)[0])).toBe(worktree);
  });
});
