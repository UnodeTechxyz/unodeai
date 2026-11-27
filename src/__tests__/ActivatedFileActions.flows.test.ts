import { beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/*
 * v0.9.108 (L1): the person's buttons on a delivered file's card, through the extension's real entry: activate(), the
 * chat page it serves, the request's card built from what the request really wrote, the provider, the extension's own
 * navigation wiring and its Export PDF. Only the VS Code API and the model's HTTP endpoint are stood in. No native
 * Office application runs here: where an export is meant to save a PDF, only the native renderer's helper, its
 * application catalog and the source reader's worker are fixtures; the person's ports, authority, approvals, the
 * export path and the file commit are the extension's own.
 */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());
vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));
// The one seam: the native fixtures go into the ports the extension built; everything else in them is untouched.
const native = vi.hoisted(() => ({ fixtures: undefined as undefined | ((ports: any) => any), runs: [] as any[] }));
vi.mock('../host/personOfficeExport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host/personOfficeExport')>();
  return { ...actual, runPersonPdfExport: (ports: any, ...rest: [string, string, AbortSignal?]) => {
    native.runs.push(ports);
    return actual.runPersonPdfExport(native.fixtures ? native.fixtures(ports) : ports, ...rest);
  } };
});

import { chatScreen, context, installActivatedExtension, lastToolResult, pumpWhile, replies, scripts, workspace } from './support/activatedHarness';
import { RootScopedWorkspaceState } from '../state/RootScopedWorkspaceState';
import { chatHistoryKey } from '../views/chatHistory';
import { revealInOsLabel } from '../host/fileActions';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let screen: ReturnType<typeof chatScreen>;
/*
 * v0.9.108 (L1): what a reload keeps. Before this window opens, Writer's chat already holds a reply linking a DOCX in the
 * workspace, as the window before stored it; Writer is not started in this window until a test starts it.
 */
const RELOADED_LINK = 'reloaded-brief';
beforeAll(async () => {
  const kept = new RootScopedWorkspaceState(context.workspaceState as never, workspace);
  await kept.update(chatHistoryKey('writer'), [
    { role: 'user', text: 'Write the reloaded brief.', ts: '2026-11-22T00:00:00.000Z', seq: 0 },
    { role: 'agent', text: `The brief is ready: [${RELOADED_LINK}](<${path.join(workspace, `${RELOADED_LINK}.docx`).split(path.sep).join('/')}>)`,
      ts: '2026-11-22T00:00:01.000Z', seq: 1, turnFinal: true, fileLinkRoots: [workspace], fileLinkCeilings: [workspace] },
  ]);
});
installActivatedExtension(host, (ready) => { screen = ready.screen; });

const executed: Array<{ command: string; args: unknown[] }> = [];
host.overrides['vscode.commands.executeCommand'] = async (command: string, ...args: unknown[]) => { executed.push({ command, args }); return undefined; };

const descendants = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);

it('a delivered file\'s card offers Reveal and, on Windows, Export PDF; Reveal shows the real file, and Export PDF in Plan mode starts nothing', async () => {
  scripts.set('dev-model', (request) => lastToolResult(request)
    ? { text: 'Saved the report and the notes.' }
    : { calls: [{ name: 'write_file', args: { path: 'report.docx', content: 'report body' } }, { name: 'write_file', args: { path: 'notes.md', content: '# notes' } }] });
  await screen.select('dev');
  await screen.send('Write the report and the notes.');
  await pumpWhile(() => !replies('dev').includes('Saved the report and the notes.'), screen.pump);
  expect(fs.existsSync(path.join(workspace, 'report.docx'))).toBe(true);

  const groups = () => descendants(screen.page().elements.get('transcript')).filter((node) => node.className === 'job-outcome-file');
  await pumpWhile(() => groups().length < 2, screen.pump);
  const reveal = revealInOsLabel(process.platform);
  const labels = groups().map((group) => group.children.map((button: any) => button.textContent));
  expect(labels).toEqual([
    ['Open report.docx', reveal, ...(process.platform === 'win32' ? ['Export PDF'] : [])],
    ['Open notes.md', reveal],
  ]);

  // Reveal: the real boundary checks the file, then VS Code's own command shows it.
  screen.page().dispatchElementEvent(groups()[1].children[1], 'click');
  await pumpWhile(() => !executed.some((call) => call.command === 'revealFileInOS'), screen.pump);
  const revealed = executed.find((call) => call.command === 'revealFileInOS')!;
  expect((revealed.args[0] as { fsPath: string }).fsPath).toBe(fs.realpathSync.native(path.join(workspace, 'notes.md')));

  if (process.platform !== 'win32') return;
  // Export PDF in Plan mode: refused before any tool runs, with where to go next; nothing is written beside the source.
  screen.page().dispatchElementEvent(screen.page().elements.get('planMode') as never, 'click');
  await screen.pump();
  const warned = host.warnings.length;
  screen.page().dispatchElementEvent(groups()[0].children[2], 'click');
  await pumpWhile(() => host.warnings.length === warned, screen.pump);
  expect(host.warnings.at(-1)).toBe('Export PDF saves a file, and this chat is in Plan mode, which makes no changes. Choose Act at the top of the chat, then click Export PDF again.');
  expect(fs.existsSync(path.join(workspace, 'report.pdf'))).toBe(false);
  expect(executed.filter((call) => call.command === 'revealFileInOS')).toHaveLength(1);
});

/*
 * v0.9.108 (L1 fix, Codex's audit of ab94eb4b, F1): the person's Export PDF is an operation of its own. Pressed on an
 * earlier card while the same member works on another request, it completes; that request is not stopped, goes on,
 * and its card lists only what it wrote. Windows only: Export PDF exists only where the native export runs.
 */
it.runIf(process.platform === 'win32')('Export PDF on an earlier card completes while the same member works on another request, which goes on untouched', async () => {
  const { officeRouteReader, officeRouteDocument } = await import('../backend/__tests__/officeInventoryRouteFixtures');
  const { NativeOfficeRenderer } = await import('../office/NativeOfficeRenderer');
  const { OfficeRenderPureHost } = await import('../office/OfficeRenderPureHost');
  const { OfficeReader } = await import('../office/OfficeReader');
  const { build } = await import('esbuild');
  const { PDFDocument } = await import('pdf-lib');
  const reader = await officeRouteReader();
  const readerWorker = (reader as any).worker as string;
  const pureWorker = path.join(path.dirname(readerWorker), 'OfficeRenderPureWorker.cjs');
  await build({ entryPoints: ['src/office/OfficeRenderPureWorker.ts'], outfile: pureWorker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const pdfDocument = await PDFDocument.create(); pdfDocument.addPage();
  const pdfBytes = Buffer.from(await pdfDocument.save());
  const nativeJobs: any[] = [];
  const catalog = { candidate: async (id: 'word' | 'powerpoint' | 'libreoffice') => ({ id, path: path.join(workspace, `inert-${id}.exe`), sha256: 'a'.repeat(64), bytes: 1 }) };
  const renderer = new NativeOfficeRenderer({ platform: 'win32', pure: new OfficeRenderPureHost(pureWorker), catalog,
    execute: async (request: any) => {
      const job = JSON.parse(Buffer.from(request.input, 'base64').toString()); nativeJobs.push(job);
      fs.writeFileSync(job.pdf, pdfBytes);
      return { status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId,
        status: 'passed', page_count: 0, completed_pages: 0, document_closed: true, app_version: 'fixture', native_app: 'quit-by-helper', stage_released: true }) };
    } });
  native.fixtures = (ports) => ({ ...ports, nativeOfficeRenderer: renderer, officeApplicationCatalog: catalog, officeReader: new OfficeReader(readerWorker) });
  let progress: Promise<unknown> | undefined;
  host.overrides['vscode.window.withProgress'] = (_options: unknown, work: any) => {
    progress = work({}, { onCancellationRequested: () => ({ dispose() {} }) }); return progress;
  };
  const text = (node: any): string => [node?.textContent, ...(Array.isArray(node?.children) ? node.children.map(text) : [])].filter(Boolean).join(' ');
  const transcript = () => descendants(screen.page().elements.get('transcript'));
  const groupOf = (label: string) => transcript().find((node) => node.className === 'job-outcome-file' && node.children[0]?.textContent === label);
  try {
    await screen.select('dev');
    screen.page().dispatchElementEvent(screen.page().elements.get('actMode') as never, 'click');
    await screen.pump();
    const source = await officeRouteDocument();
    scripts.set('dev-model', (request) => lastToolResult(request) ? { text: 'The brief is saved.' }
      : { calls: [{ name: 'write_file', args: { path: 'brief.docx', content: 'placeholder' } }] });
    await screen.send('Save the brief.');
    await pumpWhile(() => !replies('dev').includes('The brief is saved.'), screen.pump);
    // The delivered file is a real DOCX by the time the person presses Export PDF.
    fs.writeFileSync(path.join(workspace, 'brief.docx'), source);
    await pumpWhile(() => !groupOf('Open brief.docx'), screen.pump);

    // Another request of the same member, held at its model mid-way.
    let release!: () => void; let entered = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    scripts.set('dev-model', async (request) => {
      if (lastToolResult(request)) return { text: 'The other work is done.' };
      entered = true; await held;
      return { calls: [{ name: 'write_file', args: { path: 'other.md', content: '# other' } }] };
    });
    await screen.send('Do the other work.');
    await pumpWhile(() => !entered, screen.pump);

    const warnings = host.warnings.length; const infos = host.infos.length; const runs = native.runs.length;
    screen.page().dispatchElementEvent(groupOf('Open brief.docx').children.find((button: any) => button.textContent === 'Export PDF'), 'click');
    await pumpWhile(() => !progress, screen.pump);
    await progress;
    expect(native.runs).toHaveLength(runs + 1);
    expect(host.warnings.slice(warnings)).toEqual([]);
    expect(host.infos.slice(infos).join('\n')).toContain('The PDF of brief.docx saved to brief.pdf: 1 page, exported by Word.');
    expect(fs.readFileSync(path.join(workspace, 'brief.pdf'))).toEqual(pdfBytes);
    expect(fs.readFileSync(path.join(workspace, 'brief.docx'))).toEqual(source);
    expect(nativeJobs).toHaveLength(1);

    // The request the member works on was not stopped: it goes on, and its card lists only what it wrote.
    release();
    await pumpWhile(() => !replies('dev').includes('The other work is done.'), screen.pump);
    await pumpWhile(() => !groupOf('Open other.md'), screen.pump);
    const card = transcript().filter((node) => String(node.className).includes('request-summary')).find((node) => text(node).includes('Open other.md'));
    expect(text(card)).not.toContain('brief.pdf');
    expect(transcript().filter((node) => node.className === 'job-outcome-file').map((group) => group.children[0].textContent)).not.toContain('Open brief.pdf');
  } finally {
    native.fixtures = undefined;
    delete host.overrides['vscode.window.withProgress'];
    await reader.dispose();
  }
});
/*
 * v0.9.108 (L1 fix, Codex's re-audit of 9df491fc, F1): a person export of a file outside the workspace, read under the
 * member's Full access, holds that access for as long as the person's authority holds, not for as long as a model
 * request of the member runs. An unrelated request ending during the export does not cancel it; revoking Full access
 * or choosing Plan during the export still does. Windows only: Export PDF exists only where the native export runs.
 */
async function outsideExportFixtures(during: () => Promise<void>) {
  const { officeRouteReader, officeRouteDocument } = await import('../backend/__tests__/officeInventoryRouteFixtures');
  const { NativeOfficeRenderer } = await import('../office/NativeOfficeRenderer');
  const { OfficeRenderPureHost } = await import('../office/OfficeRenderPureHost');
  const { OfficeReader } = await import('../office/OfficeReader');
  const { build } = await import('esbuild');
  const { PDFDocument } = await import('pdf-lib');
  const reader = await officeRouteReader();
  const readerWorker = (reader as any).worker as string;
  const pureWorker = path.join(path.dirname(readerWorker), 'OfficeRenderPureWorker.cjs');
  await build({ entryPoints: ['src/office/OfficeRenderPureWorker.ts'], outfile: pureWorker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const pdfDocument = await PDFDocument.create(); pdfDocument.addPage();
  const pdfBytes = Buffer.from(await pdfDocument.save());
  const catalog = { candidate: async (id: 'word' | 'powerpoint' | 'libreoffice') => ({ id, path: path.join(workspace, `inert-${id}.exe`), sha256: 'a'.repeat(64), bytes: 1 }) };
  const nativeJobs: any[] = [];
  const renderer = new NativeOfficeRenderer({ platform: 'win32', pure: new OfficeRenderPureHost(pureWorker), catalog,
    execute: async (request: any) => {
      const job = JSON.parse(Buffer.from(request.input, 'base64').toString()); nativeJobs.push(job);
      await during();
      fs.writeFileSync(job.pdf, pdfBytes);
      return { status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId,
        status: 'passed', page_count: 0, completed_pages: 0, document_closed: true, app_version: 'fixture', native_app: 'quit-by-helper', stage_released: true }) };
    } });
  native.fixtures = (ports) => ({ ...ports, nativeOfficeRenderer: renderer, officeApplicationCatalog: catalog, officeReader: new OfficeReader(readerWorker) });
  let progress: Promise<unknown> | undefined;
  host.overrides['vscode.window.withProgress'] = (_options: unknown, work: any) => {
    progress = work({}, { onCancellationRequested: () => ({ dispose() {} }) }); return progress;
  };
  return { source: await officeRouteDocument(), pdfBytes, nativeJobs, progress: () => progress,
    done: async () => { native.fixtures = undefined; delete host.overrides['vscode.window.withProgress']; await reader.dispose(); } };
}

/** The person chooses an autonomy for Dev in the chat (Full access asks once; the person enables it). */
async function chooseAutonomy(choice: 'full-access' | 'workspace') {
  const warningMethod = host.overrides['vscode.window.showWarningMessage'] as (...args: unknown[]) => Promise<unknown>;
  // Only the Full access confirmation is answered; any other warning (an export's outcome) is recorded as usual.
  host.overrides['vscode.window.showWarningMessage'] = async (...args: unknown[]) =>
    args.includes('Enable full access') ? 'Enable full access' : warningMethod(...args);
  screen.page().postedMessages.push({ command: 'setAutonomy', agentId: 'dev', choice });
  await screen.pump();
  host.overrides['vscode.window.showWarningMessage'] = warningMethod;
}

/** Dev, in Act with Full access, links a DOCX outside the workspace; the person presses Export PDF on the link's id. */
async function exportOutsideLink(name: string, fixtures: Awaited<ReturnType<typeof outsideExportFixtures>>) {
  const { elsewhere } = await import('./support/activatedHarness');
  const sourcePath = path.join(elsewhere, `${name}.docx`);
  fs.writeFileSync(sourcePath, fixtures.source);
  host.overrides['vscode.env.remoteName'] = undefined;
  await screen.select('dev');
  screen.page().dispatchElementEvent(screen.page().elements.get('actMode') as never, 'click');
  await screen.pump();
  await chooseAutonomy('full-access');
  const reply = `The ${name} is ready: [${name}](<${sourcePath.split(path.sep).join('/')}>)`;
  scripts.set('dev-model', () => ({ text: reply }));
  await screen.send(`Link the ${name}.`);
  await pumpWhile(() => !replies('dev').includes(reply), screen.pump);
  const link = descendants(screen.page().elements.get('transcript')).find((node) => node.className === 'md-file-link' && node.textContent === name);
  expect(link, 'the reply links the outside file').toBeDefined();
  return { sourcePath, pdfPath: path.join(elsewhere, `${name}.pdf`), press: async () => {
    screen.page().postedMessages.push({ command: 'exportFileReferencePdf', agentId: 'dev', referenceId: link.dataset.fileRef });
    await pumpWhile(() => !fixtures.progress(), screen.pump);
    await fixtures.progress();
  } };
}

/*
 * v0.9.108 (L1, installed check of 1f5a3203; Codex's bounded follow-up of f7fe0b9a): after Reload Window a member's
 * export is built only when it first starts in that window. This window opened with Writer's earlier reply, linking a
 * DOCX, kept from the window before (seeded above, before activate()), and Writer has not started since. Its Export PDF
 * names its state and the Team view's Start, never a permission it has, and starts nothing. Started from the Team view
 * only, the same link exports with Writer's own authority. A Team Stop afterwards changes nothing: the export Writer has
 * in this window still runs, as before this fix. Windows only: Export PDF exists only where the native export runs.
 */
it.runIf(process.platform === 'win32')('after a reload, Export PDF of a member not started since names its state and starts nothing; once started from the Team view the same link exports', async () => {
  const fixtures = await outsideExportFixtures(async () => {});
  const teamSessions = (host.views.get('unode.teamPanel') as any).sessionManager;
  const sourcePath = path.join(workspace, `${RELOADED_LINK}.docx`);
  const pdfPath = path.join(workspace, `${RELOADED_LINK}.pdf`);
  const link = () => descendants(screen.page().elements.get('transcript')).find((node) => node.className === 'md-file-link' && node.textContent === RELOADED_LINK);
  const press = async () => {
    screen.page().postedMessages.push({ command: 'exportFileReferencePdf', agentId: 'writer', referenceId: link().dataset.fileRef });
    await screen.pump();
  };
  try {
    fs.writeFileSync(sourcePath, fixtures.source);
    // A local window: chat file links open only there.
    host.overrides['vscode.env.remoteName'] = undefined;
    await screen.select('writer');
    screen.page().dispatchElementEvent(screen.page().elements.get('actMode') as never, 'click');
    await screen.pump();
    expect(link(), 'the kept reply links the DOCX').toBeDefined();
    expect(teamSessions.get('writer').status).toBe('stopped');
    const before = native.runs.length; const warnings = host.warnings.length; const infos = host.infos.length;

    const said = 'Writer is stopped, so it cannot export reloaded-brief.docx. Start Writer with Start in the Team view, then click Export PDF again. Its permissions stay as they are.';
    await press();
    // Said beside the link, or (where the page cannot show it there, as this stub page) as a notification.
    await pumpWhile(() => host.warnings.length === warnings, screen.pump);
    expect(host.warnings.slice(warnings)).toEqual([said]);
    expect(host.infos.slice(infos)).toEqual([]);
    expect(fixtures.progress()).toBeUndefined();
    expect(native.runs).toHaveLength(before);
    expect(fixtures.nativeJobs).toHaveLength(0);
    expect(teamSessions.get('writer').status).toBe('stopped');
    expect(fs.existsSync(pdfPath)).toBe(false);

    // Team Start only: no setting is edited and no model prompt is sent. The same link now exports.
    await host.commands.get('unode.agentStart')!('writer');
    await pumpWhile(() => teamSessions.get('writer').status !== 'idle', screen.pump);
    await press();
    await pumpWhile(() => !fixtures.progress(), screen.pump);
    await fixtures.progress();
    expect(native.runs).toHaveLength(before + 1);
    // The authority it exports with is its own, unchanged: Read, Write and Run commands, as Writer's role grants.
    expect(native.runs.at(-1).allowed).toEqual(['read', 'write', 'execute']);
    expect(host.infos.slice(infos).join('\n')).toContain(`The PDF of ${RELOADED_LINK}.docx saved to ${RELOADED_LINK}.pdf: 1 page, exported by Word.`);
    expect(fs.readFileSync(pdfPath)).toEqual(fixtures.pdfBytes);
    expect(fs.readFileSync(sourcePath)).toEqual(fixtures.source);
    expect(fixtures.nativeJobs).toHaveLength(1);

    // Team Stop: Writer's export in this window is used as before this fix, not refused by its state; the export path's
    // own check of the member's live restrictions answers, as it did, and runs no native export.
    await host.commands.get('unode.agentStop')!('writer');
    await screen.pump();
    expect(teamSessions.get('writer').status).toBe('stopped');
    const exported = fs.readFileSync(pdfPath);
    const stoppedFrom = host.warnings.length; const stoppedInfos = host.infos.length;
    await press();
    await pumpWhile(() => host.warnings.length === stoppedFrom, screen.pump);
    await fixtures.progress();
    expect(native.runs).toHaveLength(before + 2);
    expect(host.warnings.slice(stoppedFrom)).toEqual([`PDF export of ${RELOADED_LINK}.docx did not run. Writer is not running in this window, so its `
      + 'current restrictions cannot be read. Only this native export is not run.']);
    expect(host.infos.slice(stoppedInfos)).toEqual([]);
    expect(fixtures.nativeJobs).toHaveLength(1);
    expect(fs.readFileSync(pdfPath)).toEqual(exported);
    expect(teamSessions.get('writer').status).toBe('stopped');
  } finally {
    await fixtures.done();
  }
});

it.runIf(process.platform === 'win32')('an outside-workspace Full access export completes when an unrelated request of the member ends during it', async () => {
  let release!: () => void; let entered = false;
  const revisions: string[] = [];
  const fixtures = await outsideExportFixtures(async () => {
    // While the native stage runs, the member's other request ends normally. The person's authority revision, read
    // from the very ports the extension built for this export, is the same before and after.
    revisions.push(native.runs.at(-1).fullFileAccessRevision());
    release();
    await pumpWhile(() => !replies('dev').includes('The unrelated work is done.'), screen.pump);
    revisions.push(native.runs.at(-1).fullFileAccessRevision());
  });
  try {
    const outside = await exportOutsideLink('outside-brief', fixtures);
    const held = new Promise<void>((resolve) => { release = resolve; });
    scripts.set('dev-model', async () => { entered = true; await held; return { text: 'The unrelated work is done.' }; });
    await screen.send('Do the unrelated work.');
    await pumpWhile(() => !entered, screen.pump);
    const warnings = host.warnings.length; const infos = host.infos.length;
    await outside.press();
    expect(fixtures.nativeJobs).toHaveLength(1);
    expect(replies('dev')).toContain('The unrelated work is done.');
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toBe(revisions[0]);
    expect(host.warnings.slice(warnings)).toEqual([]);
    expect(host.infos.slice(infos).join('\n')).toContain('The PDF of outside-brief.docx saved to');
    expect(fs.readFileSync(outside.pdfPath)).toEqual(fixtures.pdfBytes);
    expect(fs.readFileSync(outside.sourcePath)).toEqual(fixtures.source);
  } finally {
    await fixtures.done();
  }
});

it.runIf(process.platform === 'win32')('an outside-workspace Full access export is cancelled when the person revokes Full access or chooses Plan during it', async () => {
  for (const change of ['revoke', 'plan'] as const) {
    const seen: Array<{ revision: string; full: boolean }> = [];
    const fixtures = await outsideExportFixtures(async () => {
      const ports = native.runs.at(-1);
      seen.push({ revision: ports.fullFileAccessRevision(), full: ports.fullFileAccess() });
      if (change === 'revoke') await chooseAutonomy('workspace');
      else { screen.page().dispatchElementEvent(screen.page().elements.get('planMode') as never, 'click'); await screen.pump(); }
      seen.push({ revision: ports.fullFileAccessRevision(), full: ports.fullFileAccess() });
    });
    try {
      const outside = await exportOutsideLink(`outside-${change}`, fixtures);
      const warnings = host.warnings.length;
      await outside.press();
      expect(fixtures.nativeJobs).toHaveLength(1);
      // The export may end as soon as the change is read; the helper's own step finishes after it.
      await pumpWhile(() => seen.length < 2, screen.pump);
      // The person's own authority changed: its revision says so, and revoked Full access is read as revoked.
      expect(seen[1].revision, change).not.toBe(seen[0].revision);
      expect(seen.map((state) => state.full), change).toEqual(change === 'revoke' ? [true, false] : [true, true]);
      expect(host.warnings.slice(warnings).join('\n'), change).toContain(`PDF export of outside-${change}.docx`);
      expect(fs.existsSync(outside.pdfPath), change).toBe(false);
      expect(fs.readFileSync(outside.sourcePath)).toEqual(fixtures.source);
    } finally {
      await fixtures.done();
    }
  }
});