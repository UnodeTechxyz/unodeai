import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatFileLinkReference, FileLinkClickResult } from '../../../views/fileLinks';
import type { TaskWorkspaceAccess } from '../../../types';
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
    expect(host.notices.at(-1)).toEqual({ message: 'UnodeAi could not open "guide.md:9": the editor could not open it.', reference: 'guide.md:9' });
  });

  // v0.9.102: what a click came to is shown beside the clicked link; a notification only when that surface is gone.
  it('shows a click\'s result through the clicked link, and as a notification only when the surface is gone', async () => {
    const ws = folder({ 'guide.md': '# Guide' });
    const host = navigationHost([ws], [agentConfig('dev')]);
    const shown: FileLinkClickResult[] = [];
    let surfaceAlive = true;
    const reported = (destination: string): ChatFileLinkReference => ({
      ...link(destination, [ws]), report: (result) => { if (surfaceAlive) shown.push(result); return surfaceAlive; },
    });

    await host.adapter.openFileReference('dev', reported('missing.md'));
    await host.adapter.openFileReference('dev', reported('guide.md#install'));
    expect(shown).toEqual([
      { message: '"missing.md" does not exist. It may have been moved, renamed or deleted.' },
      { message: 'Opened "guide.md#install" at its start: "#install" is not a line, and UnodeAi goes only to #L12 or :12.' },
    ]);
    expect(host.notices).toEqual([]);

    surfaceAlive = false;
    await host.adapter.openFileReference('dev', reported('missing.md'));
    expect(host.notices).toEqual([{ message: '"missing.md" does not exist. It may have been moved, renamed or deleted.', reference: 'missing.md' }]);

    const refusals: string[] = [];
    await host.adapter.refuseFileNavigation('unknown-link', (message) => { refusals.push(message); return true; });
    await host.adapter.refuseFileNavigation('not-shown', () => false);
    expect(refusals).toEqual(['This file link is no longer in the conversation UnodeAi keeps, so nothing was opened. Ask the agent for the file again.']);
    expect(host.notices.at(-1)).toEqual({ message: 'That link is in a conversation this chat does not show now. Open that agent\'s conversation and click it there.' });
  });

  it('offers Reveal for a checked file that opens neither in the editor nor in an app, and Reveal checks the link again', async () => {
    const ws = folder({ 'tool.bin': 'binary', 'docs/a.md': 'a' });
    const outside = folder({ 'secret.bin': 'outside' });
    const host = navigationHost([ws], [agentConfig('dev')]);
    host.notText.value = true;
    const shown: FileLinkClickResult[] = [];
    const reported = (destination: string): ChatFileLinkReference => ({
      ...link(destination, [ws]), report: (result) => { shown.push(result); return true; },
    });

    await host.adapter.openFileReference('dev', reported('tool.bin'));
    expect(shown).toEqual([{ reveal: true, message: 'VS Code did not open "tool.bin" in the editor: File seems to be binary and cannot be '
      + 'opened as text. UnodeAi opens Word, Excel, PowerPoint and PDF files in their app, and other files in the editor. '
      + 'To open this one, reveal it in File Explorer and open it there.' }]);
    expect(host.opened).toEqual([]);
    expect(host.revealed).toEqual([]);

    await host.adapter.openFileReference('dev', reported('tool.bin'), 'reveal');
    expect(host.revealed).toEqual([path.join(ws, 'tool.bin')]);
    // Reveal is the same check as opening: a link out of the read folders and a missing file reveal nothing.
    await host.adapter.openFileReference('dev', reported(path.join(outside, 'secret.bin')), 'reveal');
    rmSync(path.join(ws, 'tool.bin'));
    await host.adapter.openFileReference('dev', reported('tool.bin'), 'reveal');
    expect(host.revealed).toEqual([path.join(ws, 'tool.bin')]);
    expect(shown.slice(1).map((result) => result.message)).toEqual([
      `"${path.join(outside, 'secret.bin')}" is outside this agent's current read folders, so UnodeAi did not open it.`,
      '"tool.bin" does not exist. It may have been moved, renamed or deleted.',
    ]);
    expect(host.opened).toEqual([]);
    expect(host.notices).toEqual([]);
  });

  it('offers Reveal on the notification of a read_file receipt that does not open as text', async () => {
    const ws = folder({ 'tool.bin': 'binary' });
    const host = navigationHost([ws], [agentConfig('dev')]);
    host.notText.value = true;
    await host.adapter.openRecordedWorkspaceFile('dev', 'tool.bin');
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].message).toContain('VS Code did not open "tool.bin" in the editor: File seems to be binary');
    expect(host.notices[0].reference).toBe('tool.bin');
    await host.notices[0].reveal!();
    expect(host.revealed).toEqual([path.join(ws, 'tool.bin')]);
  });

  // Codex's L1 audit, finding 1: a notification's Reveal must not reuse a path checked before. It is a new request
  // through the same boundary, checked when it is clicked: after a narrowing and after a removal it reveals nothing.
  it('checks a reply link\'s notification Reveal again when it is clicked: allowed, after narrowing, after removal', async () => {
    const ws = folder({ 'tool.bin': 'binary', 'docs/a.md': 'a' });
    const host = navigationHost([ws], [agentConfig('dev')]);
    host.notText.value = true;
    const reference: ChatFileLinkReference = { ...link('tool.bin', [ws]), report: () => false };

    await host.adapter.openFileReference('dev', reference);
    expect(host.notices).toHaveLength(1);
    const reveal = host.notices[0].reveal!;
    expect(host.revealed).toEqual([]);

    await reveal();
    expect(host.revealed).toEqual([path.join(ws, 'tool.bin')]);

    host.configs.set('dev', agentConfig('dev', { folderAccess: [{ path: path.join(ws, 'docs'), permission: 'read' }] }));
    await reveal();
    expect(host.revealed).toEqual([path.join(ws, 'tool.bin')]);
    expect(host.notices.at(-1)?.message).toBe('"tool.bin" is outside this agent\'s current read folders, so UnodeAi did not open it.');

    host.configs.set('dev', agentConfig('dev'));
    rmSync(path.join(ws, 'tool.bin'));
    await reveal();
    expect(host.revealed).toEqual([path.join(ws, 'tool.bin')]);
    expect(host.notices.at(-1)?.message).toBe('"tool.bin" does not exist. It may have been moved, renamed or deleted.');
    expect(host.opened).toEqual([]);
  });

  it('checks a read_file receipt\'s notification Reveal again when it is clicked, with the receipt still shown', async () => {
    const ws = folder({ 'tool.bin': 'binary', 'docs/a.md': 'a' });
    const host = navigationHost([ws], [agentConfig('dev')]);
    host.notText.value = true;
    let shown = true;

    await host.adapter.openRecordedWorkspaceFile('dev', 'tool.bin', () => shown);
    const reveal = host.notices[0].reveal!;
    await reveal();
    expect(host.revealed).toEqual([path.join(ws, 'tool.bin')]);

    host.configs.set('dev', agentConfig('dev', { folderAccess: [{ path: path.join(ws, 'docs'), permission: 'read' }] }));
    await reveal();
    host.configs.set('dev', agentConfig('dev'));
    shown = false;
    await reveal();
    shown = true;
    rmSync(path.join(ws, 'tool.bin'));
    await reveal();

    expect(host.revealed).toEqual([path.join(ws, 'tool.bin')]);
    expect(host.notices.slice(1).map((notice) => notice.message)).toEqual([
      '"tool.bin" is outside this agent\'s current read folders, so UnodeAi did not open it.',
      'The conversation shown changed before the file could open, so nothing was opened. Click the link again.',
      '"tool.bin" does not exist. It may have been moved, renamed or deleted.',
    ]);
    expect(host.opened).toEqual([]);
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

describe('Full access file navigation through the host boundary', () => {
  it('opens an outside physical target after irrelevant roots without recording or enumerating a volume list', async () => {
    const irrelevant = [folder({}), folder({}), folder({})];
    const ws = folder({ 'inside.md': 'workspace' });
    const outside = folder({ 'report.md': 'outside' });
    const host = navigationHost([...irrelevant, ws], [agentConfig('dev', { workingDirectory: ws })],
      { fullFileAccess: () => true });
    const ceilings = host.adapter.fileLinkCeilings('dev')!;
    const reference = path.join(outside, 'report.md');
    expect(ceilings[0]).toMatch(/^\0/);
    expect(ceilings).not.toContain(path.parse(outside).root);
    expect(host.adapter.fileLinkRoots('dev')).toEqual([ws]);

    await host.adapter.openFileReference('dev', link(reference, [ws], () => true, ceilings));
    await host.adapter.openRecordedWorkspaceFile('dev', reference);

    expect(host.opened).toEqual([{ path: reference }, { path: reference }]);
    expect(host.notices).toEqual([]);
  });

  it('does not widen an old Workspace reply when Full access is enabled later', async () => {
    const ws = folder({ 'inside.md': 'workspace' });
    const outside = folder({ 'report.md': 'outside' });
    let full = false;
    const host = navigationHost([ws], [agentConfig('dev')], { fullFileAccess: () => full });
    const ceilings = host.adapter.fileLinkCeilings('dev')!;
    expect(ceilings).toEqual([ws]);
    full = true;

    await host.adapter.openFileReference('dev', link(path.join(outside, 'report.md'), [ws], () => true, ceilings));
    await host.adapter.openFileReference('dev', link('inside.md', [ws], () => true, ceilings));

    expect(host.opened).toEqual([{ path: path.join(ws, 'inside.md') }]);
    expect(host.notices[0].message).toContain('when it wrote this reply');
  });

  it('requires current Full access for an old Full marker even after an independent outside folder grant', async () => {
    const ws = folder({ 'inside.md': 'workspace' });
    const outside = folder({ 'report.md': 'outside' });
    let full = true;
    const host = navigationHost([ws], [agentConfig('dev')], { fullFileAccess: () => full });
    const ceilings = host.adapter.fileLinkCeilings('dev')!;
    const reference = path.join(outside, 'report.md');
    full = false;
    await host.adapter.openFileReference('dev', link(reference, [ws], () => true, ceilings));
    expect(host.opened).toEqual([]);
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].message).toContain('current read folders');
    host.configs.set('dev', agentConfig('dev', { folderAccess: [{ path: outside, permission: 'read' }] }));
    await host.adapter.openFileReference('dev', link(reference, [ws], () => true, ceilings));

    expect(host.opened).toEqual([]);
    expect(host.notices[1].message).toContain('when it wrote this reply');
  });

  it('keeps trust, Folder Access and the host task policy binding instead of inferring Full from config', async () => {
    const ws = folder({ 'inside.md': 'workspace' });
    const outside = folder({ 'report.md': 'outside' });
    let trusted = true;
    let taskScope = false;
    let full = true;
    const host = navigationHost([ws], [agentConfig('dev', { autonomyMode: 'full-access' })],
      { fullFileAccess: () => full, taskScopeActive: () => taskScope, isTrusted: () => trusted });
    const ceilings = host.adapter.fileLinkCeilings('dev')!;
    const reference = path.join(outside, 'report.md');

    trusted = false;
    await host.adapter.openFileReference('dev', link(reference, [ws], () => true, ceilings));
    trusted = true;
    host.configs.set('dev', agentConfig('dev', { folderAccess: [{ path: ws, permission: 'read' }] }));
    await host.adapter.openFileReference('dev', link(reference, [ws], () => true, ceilings));
    host.configs.set('dev', agentConfig('dev', { autonomyMode: 'full-access' }));
    taskScope = true;
    const taskCeilings = host.adapter.fileLinkCeilings('dev')!;
    expect(taskCeilings).toEqual([ws]);
    await host.adapter.openFileReference('dev', link(reference, [ws], () => true, ceilings));

    expect(host.opened).toEqual([]);
    expect(host.notices).toHaveLength(3);
    // The current host decision can be narrower than a saved Full choice. A marker from the earlier
    // permitted reply must not turn that saved spelling into live authority after the host withdraws it.
    taskScope = false;
    full = false;
    await host.adapter.openFileReference('dev', link(reference, [ws], () => true, ceilings));
    expect(host.opened).toEqual([]);
    expect(host.notices).toHaveLength(4);
    expect(host.notices[3].message).toContain('current read folders');
    // Conversely a confirmed inherited Full default need not have a per-agent autonomyMode field.
    full = true;
    host.configs.set('dev', agentConfig('dev'));
    await host.adapter.openFileReference('dev', link(reference, [ws], () => true, ceilings));
    expect(host.opened).toEqual([{ path: reference }]);
    expect(host.notices).toHaveLength(4);
  });

  it('rechecks current Full access after the existing relative-folder choice', async () => {
    const ws = folder({ 'inside.md': 'workspace' });
    const outside = folder({ 'report.md': 'outside' });
    let full = true;
    const host = navigationHost([ws], [agentConfig('dev')], { fullFileAccess: () => full });
    const ceilings = host.adapter.fileLinkCeilings('dev')!;
    host.pick.mockImplementationOnce(async () => { full = false; return outside; });

    await host.adapter.openFileReference('dev', link('report.md', [ws, outside], () => true, ceilings));

    expect(host.opened).toEqual([]);
    expect(host.notices[0].message).toContain('current read folders');
  });

  it('keeps regular-file, local-window and existing UNC-link parsing checks under Full access', async () => {
    const ws = folder({});
    const outside = folder({ 'report.md': 'outside' });
    const host = navigationHost([ws], [agentConfig('dev')], { fullFileAccess: () => true });
    const ceilings = host.adapter.fileLinkCeilings('dev')!;
    await host.adapter.openFileReference('dev', link(outside, [ws], () => true, ceilings));
    expect(host.notices[0].message).toContain('is a directory');
    await host.adapter.openFileReference('dev', link('\\\\server\\share\\report.md', [ws], () => true, ceilings));
    expect(host.notices[1].message).toContain('not a path on this computer');
    host.local.value = false;
    await host.adapter.openFileReference('dev', link(path.join(outside, 'report.md'), [ws], () => true, ceilings));
    expect(host.notices[2].message).toContain('only in a local window');
    expect(host.opened).toEqual([]);
  });

  it('records only the admitted outside task folder and keeps its links usable after task end without sibling widening', async () => {
    const ws = folder({});
    const outside = folder({ 'allowed.md': 'task file' });
    const sibling = folder({ 'not-in-task.md': 'different outside folder' });
    const config = agentConfig('dev');
    let active = true;
    let task: TaskWorkspaceAccess | undefined;
    const host = navigationHost([ws], [config], { fullFileAccess: () => true,
      taskScopeActive: () => active, taskWorkspaceAccess: () => task });
    task = host.adapter.resolveTaskWorkspaceAccess(config, { folderAccess: [{ path: outside, permission: 'read' }] }).access;
    expect(task).toBeDefined();
    const ceilings = host.adapter.fileLinkCeilings('dev')!;
    expect(ceilings).toEqual([outside]);
    const allowed = path.join(outside, 'allowed.md');
    const denied = path.join(sibling, 'not-in-task.md');

    await host.adapter.openFileReference('dev', link(allowed, [ws], () => true, ceilings));
    await host.adapter.openRecordedWorkspaceFile('dev', allowed);
    active = false;
    await host.adapter.openFileReference('dev', link(allowed, [ws], () => true, ceilings));
    await host.adapter.openFileReference('dev', link(denied, [ws], () => true, ceilings));

    expect(host.opened).toEqual([{ path: allowed }, { path: allowed }, { path: allowed }]);
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].message).toContain('when it wrote this reply');
  });

  it('keeps pinned exact files exact for current and historical opens when the file is replaced by a directory', async () => {
    const ws = folder({});
    const outside = folder({ 'allowed.md': 'exact task file', 'sibling.md': 'not admitted' });
    const target = path.join(outside, 'allowed.md');
    const config = agentConfig('dev');
    let active = true;
    let task: TaskWorkspaceAccess | undefined;
    const host = navigationHost([ws], [config], { fullFileAccess: () => true,
      taskScopeActive: () => active, taskWorkspaceAccess: () => task });
    task = host.adapter.resolveTaskWorkspaceAccess(config, { folderAccess: [{ path: target, permission: 'read' }] }).access;
    expect(task).toBeDefined();
    const ceilings = host.adapter.fileLinkCeilings('dev')!;
    expect(ceilings).toHaveLength(1);
    await host.adapter.openFileReference('dev', link(target, [ws], () => true, ceilings));
    await host.adapter.openRecordedWorkspaceFile('dev', path.join(outside, 'sibling.md'));

    unlinkSync(target);
    mkdirSync(target);
    const child = path.join(target, 'child.md');
    writeFileSync(child, 'file name became a directory');
    await host.adapter.openRecordedWorkspaceFile('dev', child);
    active = false;
    await host.adapter.openFileReference('dev', link(child, [ws], () => true, ceilings));

    expect(host.opened).toEqual([{ path: target }]);
    expect(host.notices).toHaveLength(3);
    expect(host.notices.at(-1)?.message).toContain('when it wrote this reply');
  });

  it('treats a pinned task as a ceiling rather than authority that survives revoking Full access', async () => {
    const ws = folder({});
    const outside = folder({ 'allowed.md': 'task file' });
    const config = agentConfig('dev');
    let full = true;
    let task: TaskWorkspaceAccess | undefined;
    const host = navigationHost([ws], [config], { fullFileAccess: () => full,
      taskScopeActive: () => true, taskWorkspaceAccess: () => task });
    task = host.adapter.resolveTaskWorkspaceAccess(config, { folderAccess: [{ path: outside, permission: 'read' }] }).access;
    expect(task).toBeDefined();
    const ceilings = host.adapter.fileLinkCeilings('dev')!;
    full = false;
    await host.adapter.openFileReference('dev', link(path.join(outside, 'allowed.md'), [ws], () => true, ceilings));
    await host.adapter.openRecordedWorkspaceFile('dev', path.join(outside, 'allowed.md'));
    expect(host.opened).toEqual([]);
    expect(host.adapter.fileLinkCeilings('dev')).toEqual([]);

    host.configs.set('dev', agentConfig('dev', { folderAccess: [{ path: outside, permission: 'read' }] }));
    await host.adapter.openFileReference('dev', link(path.join(outside, 'allowed.md'), [ws], () => true, ceilings));
    expect(host.opened).toEqual([{ path: path.join(outside, 'allowed.md') }]);
  });

  it('intersects an old Full reply with the actual current task instead of refusing its permitted outside target', async () => {
    const ws = folder({});
    const outside = folder({ 'allowed.md': 'task file', 'sibling.md': 'not admitted by the current task' });
    const target = path.join(outside, 'allowed.md');
    const config = agentConfig('dev');
    let active = false;
    let task: TaskWorkspaceAccess | undefined;
    const host = navigationHost([ws], [config], { fullFileAccess: () => true,
      taskScopeActive: () => active, taskWorkspaceAccess: () => task });
    const ceilings = host.adapter.fileLinkCeilings('dev')!;
    active = true;
    task = host.adapter.resolveTaskWorkspaceAccess(config, { folderAccess: [{ path: target, permission: 'read' }] }).access;
    await host.adapter.openFileReference('dev', link(target, [ws], () => true, ceilings));
    await host.adapter.openFileReference('dev', link(path.join(outside, 'sibling.md'), [ws], () => true, ceilings));
    expect(host.opened).toEqual([{ path: target }]);
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].message).toContain('current read folders');
  });

  it('does not resolve a pinned physical task root into a replacement junction target', async () => {
    const ws = folder({});
    const outer = folder({ 'a/allowed.md': 'original task', 'b/secret.md': 'not admitted' });
    const before = path.join(outer, 'a');
    const after = path.join(outer, 'b');
    const config = agentConfig('dev');
    let active = true;
    let task: TaskWorkspaceAccess | undefined;
    const host = navigationHost([ws], [config], { fullFileAccess: () => true,
      taskScopeActive: () => active, taskWorkspaceAccess: () => task });
    task = host.adapter.resolveTaskWorkspaceAccess(config, { folderAccess: [{ path: before, permission: 'read' }] }).access;
    expect(task).toBeDefined();
    const ceilings = host.adapter.fileLinkCeilings('dev')!;
    expect(ceilings).toEqual([before]);
    renameSync(before, path.join(outer, 'old-a'));
    symlinkSync(after, before, 'junction');
    expect(host.adapter.fileLinkCeilings('dev')).toEqual([]);
    await host.adapter.openRecordedWorkspaceFile('dev', path.join(before, 'secret.md'));
    active = false;
    await host.adapter.openFileReference('dev', link(path.join(before, 'secret.md'), [ws], () => true, ceilings));
    expect(host.opened).toEqual([]);
  });

  it('rechecks current task ceiling after the existing relative-folder choice', async () => {
    const ws = folder({});
    const outside = folder({ 'allowed.md': 'first task file' });
    const other = folder({ 'different.md': 'second task file' });
    const config = agentConfig('dev');
    let task: TaskWorkspaceAccess | undefined;
    const host = navigationHost([ws], [config], { fullFileAccess: () => true,
      taskScopeActive: () => true, taskWorkspaceAccess: () => task });
    task = host.adapter.resolveTaskWorkspaceAccess(config, { folderAccess: [{ path: outside, permission: 'read' }] }).access;
    const ceilings = host.adapter.fileLinkCeilings('dev')!;
    host.pick.mockImplementationOnce(async () => {
      task = host.adapter.resolveTaskWorkspaceAccess(config, { folderAccess: [{ path: other, permission: 'read' }] }).access;
      return outside;
    });
    await host.adapter.openFileReference('dev', link('allowed.md', [ws, outside], () => true, ceilings));
    expect(host.opened).toEqual([]);
    expect(host.notices[0].message).toContain('current read folders');
  });
});
