/*---------------------------------------------------------------------------------------------
 * The only metadata transport construction point.  A service gets the already-gated transport rather
 * than a global fetch, so a future catalog/price/balance caller inherits consent by construction.
 *--------------------------------------------------------------------------------------------*/

import { consentGatedFetch, type PriceFetch } from '../models/LivePriceService';

export function createMetadataTransport(hasConsent: (host: string) => boolean): PriceFetch {
  return consentGatedFetch(
    (url: string, init?: { headers?: Record<string, string> }) => (globalThis as any).fetch(url, init),
    hasConsent,
  );
}
