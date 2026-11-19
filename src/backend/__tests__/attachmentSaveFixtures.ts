/*
 * v0.9.97 P4: exact attachment bytes and a host for `save_attachment` tests. Every fixture is a fixed byte string, so
 * a formatted, re-encoded or substituted copy cannot pass for it: PNG, JPEG, PDF, GIF, and text with and without a
 * byte-order mark, with CRLF and LF line endings, and in Latin-1 (not UTF-8, which the attachment entry admits).
 */
import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import { validateUserAttachments } from '../../attachments';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { admitDelegationContentSources } from '../../host/orchestration/OrchestrationHostAdapter';
import type { DelegationContentSource } from '../../session/TurnContextManifest';
import type { UserAttachment } from '../../types';
import { CheckpointStore } from '../Checkpoints';
import type { FileCoordinator } from '../FileCoordinator';
import { FileWritePolicy, type HostObservedFileEffect, type ObservedTarget, type OverwriteDecisionRequest } from '../fileWritePolicy';
import { PreChangeCheckpoints, rawCheckpointLocation } from '../PreChangeCheckpoints';
import { RawCheckpointStore, type RawCheckpointLimits } from '../RawCheckpointStore';
import { WorkspaceTools, type WriteApprover } from '../WorkspaceTools';
import { temporaryFolder } from './pathSafetyFixtures';

export const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** A real 1x1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** A JPEG's start-of-image and APP0 header, some data and its end-of-image marker. */
export const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0x00, 0x7f, 0x80, 0xfe, 0x0d, 0x0a, 0x1a, 0xff, 0xd9,
]);
export const PDF = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
export const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'latin1');
/** UTF-8 with a byte-order mark and CRLF line endings: a decoded and re-encoded copy loses both. */
export const CSV_BOM_CRLF = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('name,city\r\nZoë,Zürich\r\n', 'utf8')]);
/** UTF-8 without a byte-order mark, LF line endings. */
export const MARKDOWN_LF = Buffer.from('# Notes\n\n- one\n- two\n', 'utf8');
/** Latin-1 bytes that are not UTF-8: the attachment entry admits the file; it is never shown to the model as text. */
export const LATIN1 = Buffer.from('caf\xe9 cr\xe8me\r\n', 'latin1');

export function attachment(name: string, mime: string, kind: UserAttachment['kind'], bytes: Buffer): UserAttachment {
  // Through the real admission of the chat composer's entry, so a fixture the entry would refuse cannot be used.
  const admitted = validateUserAttachments([{ name, mime, kind, dataBase64: bytes.toString('base64'), size: bytes.length }]);
  if (admitted.errors.length > 0 || admitted.attachments.length !== 1) {
    throw new Error(`fixture not admitted: ${admitted.errors.join('; ')}`);
  }
  return admitted.attachments[0];
}

/** The descriptors the chat composer's entry makes for a user's turn: the grant the turn carries. */
export async function admitUserTurn(store: ContentAssetStore, attachments: readonly UserAttachment[]): Promise<DelegationContentSource[]> {
  return admitDelegationContentSources(
    store,
    [{ kind: 'user-request', label: 'Current task', location: 'chat composer', text: 'save it', reason: 'user-entered task' }],
    attachments.filter((item) => item.kind === 'file'),
    attachments.filter((item) => item.kind === 'pdf'),
    attachments.filter((item) => item.kind === 'image'),
  );
}

/** The id of the one descriptor for a user attachment, in the order the files were attached. */
export function attachmentIds(sources: readonly DelegationContentSource[]): string[] {
  return sources.filter((source) => source.kind === 'user-attachment').map((source) => source.assetId);
}

export async function folder(prefix: string): Promise<string> {
  return realpathSync.native(await temporaryFolder(prefix));
}

/**
 * One extension host of one workspace: the attachment store, this workspace's raw-byte restore points under the
 * extension storage, the text records made after each change (as the extension's recorder makes them), a request
 * the test starts and ends, and a person who answers the decisions and approvals.
 */
export async function saveHost(options: {
  now?: () => number;
  limits?: Partial<RawCheckpointLimits>;
  trusted?: () => boolean;
  readState?: (physical: string) => Promise<ObservedTarget>;
  decide?: (request: OverwriteDecisionRequest) => Promise<'once' | 'deny'>;
  ask?: boolean;
  approve?: WriteApprover;
  unhosted?: boolean;
  /** The team's read-before-write check; none by default, as for a solo agent. */
  coordinator?: FileCoordinator;
  /** Runs each time the raw store commits its index: while a restore point is kept, and when what a change left is recorded. */
  duringCapture?: () => void | Promise<void>;
  /** v0.9.97: told each file effect the host observed, as the request effect ledger is. */
  onEffect?: (effect: HostObservedFileEffect) => void;
  /** v0.9.97: the agent's own folder, relative to which a closeout lists its files; the workspace by default. */
  base?: (root: string) => string;
} = {}) {
  const root = await folder('unode-p4-ws-');
  const storage = await folder('unode-p4-storage-');
  const location = rawCheckpointLocation(storage, root);
  const assets = new ContentAssetStore(options.now ? { now: options.now } : {});
  const text = new CheckpointStore();
  const state = {
    request: 'r1' as string | undefined,
    running: new Set(['r1']),
    decisions: [] as OverwriteDecisionRequest[],
    approvals: [] as Array<Parameters<WriteApprover>[0]>,
    notices: [] as string[],
    store: undefined as RawCheckpointStore | undefined,
  };
  const checkpoints = new PreChangeCheckpoints({
    open: async () => {
      const { store } = await RawCheckpointStore.open({
        ...location,
        ...(options.limits ? { limits: options.limits } : {}),
        onRemoved: (ids) => { text.dropRaw(ids); },
        beforeIndexCommit: async () => { await options.duringCapture?.(); },
      });
      store.attachPeer(text);
      text.attachPeer(store);
      state.store = store;
      return store;
    },
    isRequestRunning: (id) => state.running.has(id),
  });
  const policy = options.unhosted ? FileWritePolicy.unhosted() : new FileWritePolicy({
    workspaceId: () => 'workspace',
    isRequestRunning: (id) => state.running.has(id),
    checkpoints,
    ...(options.readState ? { readState: options.readState } : {}),
    ...(options.onEffect ? { onEffect: options.onEffect } : {}),
  });
  const approve: WriteApprover | undefined = options.approve || options.ask
    ? async (request) => {
      state.approvals.push(request);
      return options.approve ? options.approve(request) : 'once';
    }
    : undefined;
  const fileWrites = (agentId: string) => policy.forAgent({
    agentId, base: options.base ? options.base(root) : root, requestId: () => state.request,
    notice: message => state.notices.push(message),
    decide: async request => { state.decisions.push(request); return options.decide ? options.decide(request) : 'once'; },
  });
  const tools = (agentId = 'dev', sources?: readonly DelegationContentSource[]) => {
    const t = new WorkspaceTools(
      root, new Set(['read', 'write']), agentId, options.coordinator, undefined, undefined, undefined, undefined, undefined, undefined,
      (entry) => { text.record({ ...entry, agentName: agentId, operation: entry.operation ?? 'write' }); },
      () => options.ask ?? false, approve, undefined, undefined, undefined, [], options.trusted ?? (() => true), [root],
      undefined, undefined, undefined, assets,
    );
    t.setFileWrites(fileWrites(agentId));
    t.setDelegationContentSources(sources);
    return t;
  };
  const rawStore = async () => {
    const opened = await checkpoints.store();
    if ('unavailable' in opened) throw new Error(opened.unavailable);
    return opened.store;
  };
  return { root, storage, location, assets, text, state, tools, rawStore, fileWrites };
}
