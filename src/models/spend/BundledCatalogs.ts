/*---------------------------------------------------------------------------------------------
 *  UnodeAi - bundled reference price catalogs (v0.9.89, design §5.1, §13.5)
 *
 *  Two separate, anonymous, dated captures shipped with the release. Each is validated (schema and content
 *  digest) when loaded; a catalog that does not validate is simply absent, never repaired or borrowed.
 *--------------------------------------------------------------------------------------------*/

import unodeCatalog from '../pricingCatalogs/unode.json';
import roamCatalog from '../pricingCatalogs/roam.json';
import { validatePriceCatalog, type PriceCatalogV1, type ReferenceProvider } from './PriceCatalog';

function load(raw: unknown, provider: ReferenceProvider): PriceCatalogV1 | undefined {
  const result = validatePriceCatalog(raw);
  return result.ok && result.catalog.provider === provider ? result.catalog : undefined;
}

const bundled: Record<ReferenceProvider, PriceCatalogV1 | undefined> = {
  unode: load(unodeCatalog, 'unode'),
  roam: load(roamCatalog, 'roam'),
};

export function bundledReferenceCatalog(provider: ReferenceProvider): PriceCatalogV1 | undefined {
  return bundled[provider];
}
