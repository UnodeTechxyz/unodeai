import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isDocumentFile, offersPdfExport, pdfExportDestination, pdfExportPlatform, personPdfExportRefusal, personPdfExportResult, personPdfExportNotReady, revealInOsLabel,
} from '../fileActions';
import { hostToolFailed, hostToolRefused, hostToolRefusalDetail, hostToolSucceeded } from '../../backend/toolSummary';

/*
 * v0.9.108 (L1): which of the person's file actions a file offers on a platform, where Export PDF puts the PDF, when it
 * does not start, and how one export's outcome is said to the person.
 */
const folder = path.join(os.tmpdir(), 'unode-l1-actions');

describe('v0.9.108 L1 file actions', () => {
  it('uses VS Code\'s words for Reveal on each platform', () => {
    expect(revealInOsLabel('win32')).toBe('Reveal in File Explorer');
    expect(revealInOsLabel('darwin')).toBe('Reveal in Finder');
    expect(revealInOsLabel('linux')).toBe('Open Containing Folder');
  });

  it('offers Export PDF for a DOCX or PPTX only where the native export runs', () => {
    expect(pdfExportPlatform('win32')).toBe(true);
    expect(pdfExportPlatform('darwin')).toBe(false);
    expect(pdfExportPlatform('linux')).toBe(false);
    expect(offersPdfExport(path.join(folder, 'Report.DOCX'), 'win32')).toBe(true);
    expect(offersPdfExport(path.join(folder, 'deck.pptx'), 'win32')).toBe(true);
    for (const name of ['sheet.xlsx', 'report.pdf', 'notes.md', 'report.doc']) expect(offersPdfExport(path.join(folder, name), 'win32')).toBe(false);
    expect(offersPdfExport(path.join(folder, 'report.docx'), 'darwin')).toBe(false);
    expect(offersPdfExport(path.join(folder, 'report.docx'), 'linux')).toBe(false);
    expect(['a.docx', 'a.XLSX', 'a.pptx', 'a.pdf'].every(isDocumentFile)).toBe(true);
    expect(['a.md', 'a.doc', 'a.txt'].some(isDocumentFile)).toBe(false);
  });

  it('puts the PDF beside its source with the source\'s name', () => {
    expect(pdfExportDestination(path.join(folder, '合同 v2.docx'))).toBe(path.join(folder, '合同 v2.pdf'));
    expect(pdfExportDestination(path.join(folder, 'deck.final.PPTX'))).toBe(path.join(folder, 'deck.final.pdf'));
  });

  it('does not start off Windows, for another file type or in Plan mode, saying where to go next', () => {
    const state = { platform: 'win32' as NodeJS.Platform, sourcePath: path.join(folder, 'report.docx'), agentName: 'Writer', plan: false };
    expect(personPdfExportRefusal(state)).toBeUndefined();
    expect(personPdfExportRefusal({ ...state, platform: 'darwin' })).toBe('Export PDF uses Word, PowerPoint or LibreOffice through Windows, so it is not available on this platform. Open report.docx in its app and save it as PDF there.');
    expect(personPdfExportRefusal({ ...state, sourcePath: path.join(folder, 'sheet.xlsx') })).toBe('Export PDF takes a .docx or .pptx file; sheet.xlsx is neither, so nothing was exported.');
    expect(personPdfExportRefusal({ ...state, plan: true })).toBe('Export PDF saves a file, and this chat is in Plan mode, which makes no changes. Choose Act at the top of the chat, then click Export PDF again.');
  });

  it('a member with no export in this window is told its state and the Team view\'s step, never a permission', () => {
    const source = path.join(folder, 'contract.docx');
    const said = {
      idle: 'Writer cannot export contract.docx: its export is not ready in this window. Restart Writer with Restart in the Team view, then click Export PDF again.',
      running: 'Writer cannot export contract.docx: its export is not ready in this window. Restart Writer with Restart in the Team view, then click Export PDF again.',
      stopped: 'Writer is stopped, so it cannot export contract.docx. Start Writer with Start in the Team view, then click Export PDF again. Its permissions stay as they are.',
      error: 'Writer is blocked, so it cannot export contract.docx. Start Writer again with Start in the Team view, then click Export PDF again. Its permissions stay as they are.',
      stopping: 'Writer is stopping, so it cannot export contract.docx. When it shows Stopped, start it with Start in the Team view, then click Export PDF again.',
      starting: 'Writer is still starting, so it cannot export contract.docx yet. Click Export PDF again when Writer shows Idle in the Team view.',
      consent_required: 'Writer is waiting for your answer to its network consent before it starts, so it cannot export contract.docx yet. Answer it, then click Export PDF again when Writer shows Idle.',
    } as const;
    for (const [status, text] of Object.entries(said)) {
      expect(personPdfExportNotReady(status as keyof typeof said, 'Writer', source), status).toBe(text);
      expect(text, status).not.toMatch(/Read, Write|Run commands|Agent Builder/);
    }
    expect(personPdfExportNotReady('paused' as never, 'Writer', source)).toBe('Writer is not running, so it cannot export contract.docx. Click Export PDF again when Writer shows Idle in the Team view.');
    expect(personPdfExportNotReady(undefined, 'This agent', source)).toBe('This agent is no longer on this team, so it cannot export contract.docx. Open contract.docx in its app and save it as PDF there.');
  });

  it('says what a saved export holds, a filtered copy by its part names only, and a replaced PDF\'s restore point', () => {
    const receipt = (fields: object) => hostToolSucceeded(JSON.stringify({ kind: 'pdf-exported', version: 1, path: 'out/report.pdf', pages: 1, engine: 'word',
      copy_partial: false, removed: { parts: 0, part_names: [], relationships: 0, elements: 0 }, effect: 'created', ...fields }));
    expect(personPdfExportResult(receipt({}), 'report.docx', 'Writer')).toEqual({ saved: true,
      message: 'The PDF of report.docx saved to out/report.pdf: 1 page, exported by Word. report.docx is unchanged.' });
    const filtered = personPdfExportResult(receipt({ copy_partial: true, pages: 3, engine: 'libreoffice', effect: 'replaced', restore_point_id: 'rp-1',
      removed: { parts: 2, part_names: ['/word/vbaProject.bin', '/word/embeddings/oleObject1.bin'], relationships: 1, elements: 0 } }), 'report.docx', 'Writer');
    expect(filtered).toEqual({ saved: true, message: 'The PDF of report.docx replaced out/report.pdf: 3 pages, exported by LibreOffice. '
      + 'It was exported from a filtered copy: active or external content was removed (/word/vbaProject.bin, /word/embeddings/oleObject1.bin) and is not in the PDF. '
      + 'The PDF it replaced can be restored from its restore point. report.docx is unchanged.' });
    expect(personPdfExportResult(receipt({ effect: 'unchanged' }), 'report.docx', 'Writer').message).toContain('is already up to date at out/report.pdf');
  });

  it('says why nothing was saved, in the person\'s words', () => {
    expect(personPdfExportResult(hostToolRefused('export_pdf refused: consent.', 'consent'), 'report.docx', 'Writer').message)
      .toBe('PDF export of report.docx stopped: it was not approved, so nothing was saved.');
    expect(personPdfExportResult(hostToolRefused('x', 'trust'), 'report.docx', 'Writer').message)
      .toBe('PDF export of report.docx did not run. This workspace is not trusted. Run Manage Workspace Trust from the Command Palette to trust it, then export again.');
    expect(personPdfExportResult({ ...hostToolRefused('x', 'capability'), detail: hostToolRefusalDetail('Native PDF export requires Commands.') }, 'report.docx', 'Writer').message)
      .toBe('PDF export of report.docx did not run. Native PDF export requires Commands.');
    expect(personPdfExportResult(hostToolSucceeded(JSON.stringify({ state: 'not-run', reason: 'automatic-renderer-unavailable', scope: 'call export_pdf again' })), 'report.docx', 'Writer').message)
      .toBe('PDF export of report.docx did not run. No installed Word, PowerPoint or LibreOffice was found to export it. Install one of them, or open report.docx in its app and save it as PDF there.');
    expect(personPdfExportResult(hostToolFailed(JSON.stringify({ kind: 'pdf-export-not-saved', engine: 'powerpoint', state: 'failed', error: 'native-export-failed', next: 'adapter_id' })), 'deck.pptx', 'Writer'))
      .toEqual({ saved: false, message: 'PDF export of deck.pptx by PowerPoint did not succeed (failed: native-export-failed), so nothing was saved. Try again, or open deck.pptx in its app and save it as PDF there.' });
    expect(personPdfExportResult(hostToolFailed('The PDF export operation could not be observed to its end.'), 'deck.pptx', 'Writer'))
      .toEqual({ saved: false, message: 'PDF export of deck.pptx did not finish. Nothing is confirmed saved: look in its folder before exporting again, or open deck.pptx in its app and save it as PDF there.' });
  });
});
