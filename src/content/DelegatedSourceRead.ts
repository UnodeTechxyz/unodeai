/*---------------------------------------------------------------------------------------------
 *  Delegated sources a route carries inline
 *
 *  A coordinator forwards the user's sources to a teammate as opaque content ids. A route with the host's content
 *  reader reads them on demand through the tool surface's grant check. A route without that reader (Codex) gets
 *  each one in the turn's own input instead: only through the same grant rule, checked when the turn is sent, and
 *  only for the kinds the route can take. Anything else is named to the model as not delivered.
 *--------------------------------------------------------------------------------------------*/

import type { ContentAssetStore } from './ContentAssetStore';
import type { DelegationContentSource } from '../session/TurnContextManifest';

export type DelegatedSourceRefusal = 'not-granted' | 'expired' | 'pdf-unsupported' | 'unsupported';

export type DelegatedSourceRead =
  | { kind: 'text'; assetId: string; text: string }
  /** Ephemeral: the data URL goes into one request's input and never into history, evidence or a log. */
  | { kind: 'image'; assetId: string; dataUrl: string; mimeType: string; byteLength: number }
  | { kind: 'not-delivered'; assetId: string; reason: DelegatedSourceRefusal };

/** The grant facts of the task-input resolver this rule reads: the predicates the reader tools use. */
export interface DelegatedSourceGrants {
  isContractManagedContentAsset(assetId: string): boolean;
  canReadContentAsset(attemptId: string, agentId: string, assetId: string): boolean;
  noteReachable(attemptId: string, agentId: string, assetId: string): void;
  noteRead(attemptId: string, agentId: string, ref: string): void;
}

export type DelegatedSourceStore = Pick<ContentAssetStore, 'getReceipt' | 'isOwnedBy' | 'readExtractedContent' | 'imageForVision'>;

/**
 * Read one source handed to `agentId` with its assignment, for that turn's input. The grant rule is the reader
 * tools' own: an asset a contract manages is readable only through the live attempt's grant; with an attempt, an
 * attempt grant or the agent's own asset; without a contract, the handoff itself, as the reader tools take it.
 * The store's record decides the media kind, never the descriptor. A PDF is not delivered on such a route.
 */
export async function readDelegatedSourceInline(
  store: DelegatedSourceStore,
  grants: DelegatedSourceGrants | undefined,
  agentId: string,
  source: DelegationContentSource,
  attemptId: string | undefined,
): Promise<DelegatedSourceRead> {
  const assetId = source.assetId;
  const refused = (reason: DelegatedSourceRefusal): DelegatedSourceRead => ({ kind: 'not-delivered', assetId, reason });
  if (!mayRead(store, grants, agentId, assetId, attemptId)) return refused('not-granted');
  const receipt = store.getReceipt(assetId);
  if (!receipt) return refused('expired');
  if (receipt.mediaKind !== source.mediaKind) return refused('unsupported');
  if (receipt.mediaKind === 'pdf') return refused('pdf-unsupported');
  if (receipt.mediaKind === 'text') {
    const read = await store.readExtractedContent(assetId);
    if ('error' in read) return refused(read.error === 'expired' ? 'expired' : 'unsupported');
    return { kind: 'text', assetId, text: read.items.map((page) => page.text ?? '').join('') };
  }
  if (receipt.mediaKind === 'image') {
    const image = await store.imageForVision(assetId);
    if ('error' in image) return refused(image.error === 'expired' ? 'expired' : 'unsupported');
    return { kind: 'image', assetId, dataUrl: image.dataUrl, mimeType: image.mimeType, byteLength: image.byteLength };
  }
  return refused('unsupported');
}

/** A delivered source counts as reached and read for the attempt that granted it, as a reader tool's read does. */
export function noteDelegatedSourcesDelivered(
  grants: DelegatedSourceGrants | undefined,
  agentId: string,
  attemptId: string | undefined,
  assetIds: readonly string[],
): void {
  if (!grants || !attemptId) return;
  for (const assetId of assetIds) {
    grants.noteReachable(attemptId, agentId, assetId);
    grants.noteRead(attemptId, agentId, assetId);
  }
}

function mayRead(
  store: DelegatedSourceStore,
  grants: DelegatedSourceGrants | undefined,
  agentId: string,
  assetId: string,
  attemptId: string | undefined,
): boolean {
  if (grants?.isContractManagedContentAsset(assetId)) {
    return !!attemptId && grants.canReadContentAsset(attemptId, agentId, assetId);
  }
  if (attemptId && grants) {
    return grants.canReadContentAsset(attemptId, agentId, assetId) || store.isOwnedBy(assetId, agentId);
  }
  // No contract: the sources handed with this assignment are this turn's grant, as they are for the reader tools.
  return true;
}
