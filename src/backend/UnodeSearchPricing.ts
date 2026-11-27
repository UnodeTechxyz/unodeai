import { bundledReferenceCatalog } from '../models/spend/BundledCatalogs';
import { costNano, formatUsd } from '../models/spend/Money';
import { lookupCatalogModel } from '../models/spend/PriceCatalog';
import type { DisplayCost } from '../models/spend/SpendTypes';
import type { SearchUsage } from './UnodeSearchResponse';

export const UNODE_SEARCH_MODEL = 'claude-haiku-5-5';
export const UNODE_SEARCH_USES_PER_CALL = 5;
export const UNODE_SEARCH_CALLS_PER_TURN = 10;
export const UNODE_SEARCH_DEADLINE_MS = 120_000;

function searchPrice() {
  const catalog = bundledReferenceCatalog('unode');
  if (!catalog) return undefined;
  const row = catalog.models.find(model => model.modelId === UNODE_SEARCH_MODEL)?.webSearch;
  const model = lookupCatalogModel(catalog, UNODE_SEARCH_MODEL);
  if (!row || !model) return undefined;
  return {
    sourceId: catalog.catalogId, sourceDate: row.observedAt, sourceName: row.source,
    discountPercent: row.observedDiscountPercent,
    nanoUsdPerThousand: BigInt(row.nanoUsdPerThousand), tokenRates: model.rates,
  };
}

export function unodeSearchDiscountNote(): string | undefined {
  const price = searchPrice();
  if (price?.discountPercent === undefined) return undefined;
  return `Unode gateway discount observed on ${price.sourceDate}: ${price.discountPercent}%. It can change.`;
}

export function unodeSearchUnitPrice(): string {
  const price = searchPrice();
  if (!price) return 'Unode search price unavailable';
  return `USD ${formatUsd(price.nanoUsdPerThousand / 1_000n)}/search at list (${price.sourceName}, ${price.sourceDate})`;
}

export function unodeSearchCost(usage: SearchUsage, estimatedSearchCount?: number): { searchFeeNanoUsd?: string; estimatedSearchFee?: string; total: DisplayCost } {
  const price = searchPrice();
  const { web_search_requests, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } = usage;
  const searchCount = web_search_requests ?? estimatedSearchCount;
  if (!price || searchCount === undefined) return { total: { basis: 'unavailable' } };
  const searchFee = BigInt(searchCount) * price.nanoUsdPerThousand / 1_000n;
  const searchFeeNanoUsd = searchFee.toString();
  const discount = unodeSearchDiscountNote();
  const atList = `USD ${formatUsd(searchFee)} at list (${price.sourceName}, ${price.sourceDate}).`;
  const estimatedSearchFee = web_search_requests === undefined
    ? `${atList} Upper-bound estimate at the dated list price from the response. The gateway did not report a search count. The Unode bill is final.`
    : atList + (discount ? ' ' + discount : '');
  // Unode's observation prices uncached input and output. Unknown cache classes cannot be priced at that rate.
  if (input_tokens === undefined || output_tokens === undefined || cache_creation_input_tokens !== 0 || cache_read_input_tokens !== 0) {
    return { searchFeeNanoUsd, estimatedSearchFee, total: { basis: 'unavailable' } };
  }
  const tokens = costNano({ input: input_tokens, output: output_tokens }, price.tokenRates);
  return {
    searchFeeNanoUsd,
    estimatedSearchFee,
    total: { nanoUsd: (searchFee + tokens).toString(), basis: 'unode-reference', sourceId: price.sourceId, sourceDate: price.sourceDate },
  };
}
