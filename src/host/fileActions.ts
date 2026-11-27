import * as path from 'node:path';
import type { HostToolOutcome } from '../backend/toolSummary';
import type { SessionStatus } from '../types';
import { nativeOfficeRenderingPlatform } from '../office/OfficeRendererSelection';

/*---------------------------------------------------------------------------------------------
 *  v0.9.108 L1: what the person can do with a file the crew delivered, from its card or its link in a reply.
 *  These are the person's own actions, never model tools: Open (Office and PDF files in their default app), Reveal in
 *  the system's file manager, and Export PDF of a DOCX/PPTX. Which buttons are offered follows the file's type and the
 *  platform; every click is checked again by the host before anything runs.
 *--------------------------------------------------------------------------------------------*/

/** Word, Excel, PowerPoint and PDF files open in their default app; every other file opens in the editor. */
export const DOCUMENT_FILE_EXTENSIONS: readonly string[] = ['.docx', '.xlsx', '.pptx', '.pdf'];
/** The files Export PDF takes: the inputs of the native PDF export (export_pdf). */
export const PDF_EXPORT_SOURCE_EXTENSIONS: readonly string[] = ['.docx', '.pptx'];

const extensionOf = (filePath: string) => path.extname(filePath).toLowerCase();

export function isDocumentFile(filePath: string): boolean {
  return DOCUMENT_FILE_EXTENSIONS.includes(extensionOf(filePath));
}

/** VS Code's own words for its revealFileInOS command on each platform. */
export function revealInOsLabel(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'Reveal in File Explorer';
  if (platform === 'darwin') return 'Reveal in Finder';
  return 'Open Containing Folder';
}

/** Whether Export PDF exists for this platform at all: the native export runs only where its helper does. */
export function pdfExportPlatform(platform: NodeJS.Platform): boolean {
  return nativeOfficeRenderingPlatform(platform);
}

/** Export PDF is offered for a DOCX or PPTX, and only on a platform with the native export. */
export function offersPdfExport(filePath: string, platform: NodeJS.Platform): boolean {
  return pdfExportPlatform(platform) && PDF_EXPORT_SOURCE_EXTENSIONS.includes(extensionOf(filePath));
}

/** The PDF beside its source, with the source's name: report.docx gives report.pdf in the same folder. */
export function pdfExportDestination(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  return path.join(parsed.dir, `${parsed.name}.pdf`);
}

export interface PersonPdfExportState {
  platform: NodeJS.Platform;
  sourcePath: string;
  agentName: string;
  /** The chat of the agent is in Plan mode, which makes no changes. */
  plan: boolean;
}

/** Why Export PDF does not start for this click, in the person's words, or undefined when it may start. */
export function personPdfExportRefusal(state: PersonPdfExportState): string | undefined {
  const name = path.basename(state.sourcePath);
  if (!pdfExportPlatform(state.platform)) {
    return `Export PDF uses Word, PowerPoint or LibreOffice through Windows, so it is not available on this platform. Open ${name} in its app and save it as PDF there.`;
  }
  if (!PDF_EXPORT_SOURCE_EXTENSIONS.includes(extensionOf(state.sourcePath))) {
    return `Export PDF takes a .docx or .pptx file; ${name} is neither, so nothing was exported.`;
  }
  if (state.plan) {
    return `Export PDF saves a file, and this chat is in Plan mode, which makes no changes. Choose Act at the top of the chat, then click Export PDF again.`;
  }
  // A request the agent is working on is no reason: the export is an operation of its own (personOfficeExport).
  return undefined;
}

/**
 * v0.9.108 (L1, installed check of 1f5a3203): what the person is told when the member has no export in this window. Its
 * export is built when it first starts here, so after a reload a member not started since has none; that is not a
 * permission. The person is told the state the Team view shows and the Team view's own step, never to change a
 * permission. Used only where no export exists: it decides nothing, and a member that has one exports as before.
 * Nothing is started here.
 */
export function personPdfExportNotReady(status: SessionStatus | undefined, agentName: string, sourcePath: string): string {
  const name = path.basename(sourcePath);
  switch (status) {
    case 'idle':
    case 'running':
      return `${agentName} cannot export ${name}: its export is not ready in this window. Restart ${agentName} with Restart in the Team view, then click Export PDF again.`;
    case undefined:
      return `${agentName} is no longer on this team, so it cannot export ${name}. Open ${name} in its app and save it as PDF there.`;
    case 'stopped':
      return `${agentName} is stopped, so it cannot export ${name}. Start ${agentName} with Start in the Team view, then click Export PDF again. Its permissions stay as they are.`;
    case 'error':
      return `${agentName} is blocked, so it cannot export ${name}. Start ${agentName} again with Start in the Team view, then click Export PDF again. Its permissions stay as they are.`;
    case 'stopping':
      return `${agentName} is stopping, so it cannot export ${name}. When it shows Stopped, start it with Start in the Team view, then click Export PDF again.`;
    case 'consent_required':
      return `${agentName} is waiting for your answer to its network consent before it starts, so it cannot export ${name} yet. Answer it, then click Export PDF again when ${agentName} shows Idle.`;
    case 'starting':
      return `${agentName} is still starting, so it cannot export ${name} yet. Click Export PDF again when ${agentName} shows Idle in the Team view.`;
  }
  // A state not named above (none today) is told only what the Team view shows next, never a permission.
  return `${agentName} is not running, so it cannot export ${name}. Click Export PDF again when ${agentName} shows Idle in the Team view.`;
}

export type PersonPdfExportResult =
  | { saved: true; message: string }
  | { saved: false; message: string };

const ENGINE_NAMES: Readonly<Record<string, string>> = { word: 'Word', powerpoint: 'PowerPoint', libreoffice: 'LibreOffice' };

function parsedObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What one export came to, for the person. Only the receipt's facts are repeated: the saved file, its pages, the
 * application, and whether it was made from a filtered copy (part names only, never a link that may carry a secret).
 */
export function personPdfExportResult(outcome: HostToolOutcome, sourceName: string, agentName: string): PersonPdfExportResult {
  const notRun = `PDF export of ${sourceName} did not run.`;
  if (outcome.status === 'refused') {
    // The person's own No on the command or file-write approval; the tool's text for it is addressed to a model.
    if (outcome.reason === 'consent') return { saved: false, message: `PDF export of ${sourceName} stopped: it was not approved, so nothing was saved.` };
    if (outcome.detail) return { saved: false, message: `${notRun} ${outcome.detail}` };
    if (outcome.reason === 'trust') {
      return { saved: false, message: `${notRun} This workspace is not trusted. Run Manage Workspace Trust from the Command Palette to trust it, then export again.` };
    }
    return { saved: false, message: `${notRun} ${agentName} needs Read, Write and Run commands, and access to this file and its folder, to export it. Change them in ${agentName}'s Agent Builder, or open ${sourceName} in its app and save it as PDF there.` };
  }
  const fields = parsedObject(outcome.output);
  if (outcome.status === 'success' && fields?.kind === 'pdf-exported') {
    const pages = Number(fields.pages);
    const engine = ENGINE_NAMES[String(fields.engine)] ?? String(fields.engine);
    const where = String(fields.path);
    const verb = fields.effect === 'unchanged' ? 'is already up to date at' : fields.effect === 'replaced' ? 'replaced' : 'saved to';
    const removed = fields.removed && typeof fields.removed === 'object' ? (fields.removed as { part_names?: unknown }).part_names : undefined;
    const names = Array.isArray(removed) ? removed.filter((name): name is string => typeof name === 'string').slice(0, 5) : [];
    const filtered = fields.copy_partial === true
      ? ` It was exported from a filtered copy: active or external content was removed${names.length ? ` (${names.join(', ')})` : ''} and is not in the PDF.`
      : '';
    const restore = typeof fields.restore_point_id === 'string' ? ' The PDF it replaced can be restored from its restore point.' : '';
    return { saved: true, message: `The PDF of ${sourceName} ${verb} ${where}: ${pages} page${pages === 1 ? '' : 's'}, exported by ${engine}.${filtered}${restore} ${sourceName} is unchanged.` };
  }
  if (outcome.status === 'success' && fields?.state === 'not-run') {
    return { saved: false, message: fields.reason === 'automatic-renderer-unavailable'
      ? `${notRun} No installed Word, PowerPoint or LibreOffice was found to export it. Install one of them, or open ${sourceName} in its app and save it as PDF there.`
      : `${notRun} ${String(fields.reason)}` };
  }
  if (fields?.kind === 'pdf-export-not-saved') {
    const engine = ENGINE_NAMES[String(fields.engine)] ?? String(fields.engine);
    return { saved: false, message: `PDF export of ${sourceName} by ${engine} did not succeed (${String(fields.state)}${typeof fields.error === 'string' ? `: ${fields.error}` : ''}), so nothing was saved. Try again, or open ${sourceName} in its app and save it as PDF there.` };
  }
  return { saved: false, message: `PDF export of ${sourceName} did not finish. Nothing is confirmed saved: look in its folder before exporting again, or open ${sourceName} in its app and save it as PDF there.` };
}
