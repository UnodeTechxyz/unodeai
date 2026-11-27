import { WorkspaceTools, type CheckpointRecorder, type CommandApprover, type WriteApprover } from '../backend/WorkspaceTools';
import { NoopFileCoordinator } from '../backend/FileCoordinator';
import type { CommandPolicy } from '../backend/CommandPolicy';
import type { HostToolOutcome } from '../backend/toolSummary';
import type { AgentFileWrites } from '../backend/fileWritePolicy';
import { OfficeReader } from '../office/OfficeReader';
import { ContentAssetStore } from '../content/ContentAssetStore';
import type { OfficeAssetHistorySink } from '../office/OfficeVisualContracts';

/*---------------------------------------------------------------------------------------------
 *  v0.9.108 (L1): the person's Export PDF, as an operation of its own.
 *
 *  It runs on host tools made for this one export, not on the agent's model tools. So it shares none of a running
 *  request's per-call state, document context, task attempt, request-limit boundary, changed-file evidence or turn
 *  clock, and that request's work goes on while it runs. What it does share is the agent's authority as it is now:
 *  Read/Write/Commands, the folder scopes and grants, Workspace Trust, the command policy, the agent's live native
 *  restrictions read for the mode the chat shows now, and the ordinary command and file-write approvals, asked
 *  with no turn to pause. The export path itself (inspect_office, then export_pdf) is the model's, unchanged.
 *  It also shares the Office file history the model tools read (13.13): the PDF it saves keeps the DOCX's
 *  conversion ancestry, so a page image of a PDF derived from a signed PDF is still never made for a model.
 *--------------------------------------------------------------------------------------------*/

type ToolsSetting<K extends keyof WorkspaceTools> = WorkspaceTools[K] extends (...args: infer A) => unknown ? A : never;

export interface PersonPdfExportPorts {
  /** The agent's own folder: relative paths and the write boundary start here. */
  root: string;
  agentId: string;
  /** The agent's capabilities now: read, write and execute. */
  allowed: readonly string[];
  commandPolicy: CommandPolicy;
  /** The ordinary command approval, asked for the person's action: no agent turn is paused or charged. */
  approveCommand: CommandApprover;
  /** The ordinary file-write approval, asked the same way. */
  approveWrite: WriteApprover;
  writeApprovalAsk: () => boolean;
  /** The restore point of a replaced PDF, kept without naming any request or turn. */
  recordCheckpoint: CheckpointRecorder;
  readRoots: string[];
  writeRoots: string[];
  fileGrants?: ConstructorParameters<typeof WorkspaceTools>[24];
  isTrusted: () => boolean;
  localScopeReadRoots?: ToolsSetting<'setLocalReadScopeAccess'>[0];
  localReadScopeConsent?: ToolsSetting<'setLocalReadScopeAccess'>[1];
  livePathAccess?: ToolsSetting<'setLivePathAccess'>[0];
  fullFileAccess?: ToolsSetting<'setFullFileAccess'>[0];
  fullFileAccessRevision?: ToolsSetting<'setFullFileAccess'>[1];
  /** The write policy seen from this action: no request, so the change is no request's evidence. */
  fileWrites?: AgentFileWrites;
  nativeOfficeRenderer?: ToolsSetting<'useNativeOfficeRenderer'>[0];
  officeRenderPreferences?: ToolsSetting<'setOfficeRenderPreferences'>[0];
  officeApplicationCatalog?: ToolsSetting<'setOfficeApplicationCatalog'>[0];
  /** Why the native stage may not run now (Plan, a read-only or restricted execution policy), read at every check. */
  nativePolicy: () => string | undefined;
  /**
   * The Office file history the model tools read and write: the export's DOCX/PPTX -> PDF edge is recorded there.
   * Required, so no caller can leave the saved PDF without its ancestry; undefined only where no history is kept.
   */
  officeHistory: OfficeAssetHistorySink | undefined;
  /** The reader of the source; one of this operation's own when absent. */
  officeReader?: OfficeReader;
}

/** Host tools for one person export, with the agent's authority and no state of any model turn. */
export function createPersonExportTools(ports: PersonPdfExportPorts, assets: ContentAssetStore): WorkspaceTools {
  const tools = new WorkspaceTools(
    ports.root, new Set(ports.allowed), ports.agentId, new NoopFileCoordinator(), ports.commandPolicy, undefined,
    ports.approveCommand, undefined, undefined, undefined, ports.recordCheckpoint, ports.writeApprovalAsk, ports.approveWrite,
    undefined, undefined, undefined, [...ports.readRoots], ports.isTrusted, [...ports.writeRoots],
    undefined, undefined, undefined, assets, undefined, ports.fileGrants,
  );
  tools.setLocalReadScopeAccess(ports.localScopeReadRoots, ports.localReadScopeConsent);
  tools.setLivePathAccess(ports.livePathAccess);
  tools.setFullFileAccess(ports.fullFileAccess, ports.fullFileAccessRevision);
  tools.setFileWrites(ports.fileWrites);
  if (ports.nativeOfficeRenderer) tools.useNativeOfficeRenderer(ports.nativeOfficeRenderer);
  tools.setOfficeRenderPreferences(ports.officeRenderPreferences);
  tools.setOfficeApplicationCatalog(ports.officeApplicationCatalog);
  tools.setNativeRenderPolicy(ports.nativePolicy);
  return tools;
}

/**
 * One person export: its own tools for its own operation, released when it ends. `signal` is the person's Cancel.
 * The agent's model tools and the request they serve are never touched.
 */
export async function runPersonPdfExport(ports: PersonPdfExportPorts, sourcePath: string, destination: string, signal?: AbortSignal): Promise<HostToolOutcome> {
  // This operation's own asset store: no model turn's assets, only the shared file history.
  const assets = new ContentAssetStore({ officeHistory: ports.officeHistory });
  const tools = createPersonExportTools(ports, assets);
  const reader = ports.officeReader ?? new OfficeReader();
  tools.setOfficeReader(reader);
  try {
    return await tools.exportPdfForPerson(sourcePath, destination, signal);
  } finally {
    tools.retire();
    await tools.disposeBackground().catch(() => undefined);
    if (!ports.officeReader) await reader.dispose().catch(() => undefined);
    await assets.dispose().catch(() => undefined);
  }
}
