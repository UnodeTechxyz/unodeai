import { bundledReferenceCatalog } from '../models/spend/BundledCatalogs';
import { scaleNano } from '../models/spend/Money';

export function unodeTranscriptionCost(model: string, seconds: number | undefined) {
  const catalog = bundledReferenceCatalog('unode');
  const rate = catalog?.audioTranscription;
  if (!catalog || !rate || rate.modelId !== model || seconds === undefined) return undefined;
  const nanoUsd = scaleNano(BigInt(rate.nanoUsdPerSecond), seconds);
  if (nanoUsd === undefined) return undefined;
  return { nanoUsd, sourceId: catalog.catalogId, sourceDate: rate.observedAt, sourceName: rate.source };
}
