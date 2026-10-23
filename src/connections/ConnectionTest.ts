import { GatewayHtmlResponseError, parseGatewayJson } from '../backend/GatewayJsonResponse';
import { EgressNotConsentedError } from '../models/LivePriceService';
import { resolveModelCatalogBaseUrl } from '../models/modelCatalogBaseUrl';
import { connectionProfile, ConnectionResolver } from '../routes/ConnectionRegistry';

export type ConnectionTestFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ConnectionTestDeps {
  resolver: ConnectionResolver;
  getSecret(secretRef: string): Promise<string | undefined>;
  ensureConsent(connectionId: string, endpointBase: string): Promise<void>;
  metadataFetch: ConnectionTestFetch;
}

export interface TestedConnection {
  connectionId: string;
  displayName: string;
}

/**
 * Run one metadata-only `/models` check against an exact registered API-key connection.
 *
 * The caller supplies only the immutable connection id. Endpoint and credential ownership are resolved
 * from the same registry profile, consent precedes the consent-gated fetch, and no secret material is
 * reflected through errors or the result.
 */
export async function testApiKeyConnection(
  connectionId: string,
  deps: ConnectionTestDeps,
): Promise<TestedConnection> {
  const profile = connectionProfile(connectionId, deps.resolver);
  if (
    !profile
    || profile.availability !== 'available'
    || profile.authKind !== 'api-key'
    || profile.catalogKind !== 'openai-models'
  ) {
    throw new Error('The selected connection cannot be tested. Refresh Settings and try again.');
  }

  const displayName = profile.presentation.displayName;
  const secretRef = profile.apiKeySecretName;
  if (!secretRef) {
    throw new Error(`Set an API key for ${displayName} before testing this connection.`);
  }

  let apiKey: string | undefined;
  try {
    apiKey = await deps.getSecret(secretRef);
  } catch {
    throw new Error(`The stored API key for ${displayName} could not be read.`);
  }
  if (!apiKey) {
    throw new Error(`Set an API key for ${displayName} before testing this connection.`);
  }

  let endpointBase: string | undefined;
  try {
    endpointBase = resolveModelCatalogBaseUrl(profile.id, deps.resolver);
  } catch {
    throw new Error(`${displayName} has no usable model-catalog endpoint.`);
  }
  if (!endpointBase) {
    throw new Error(`${displayName} has no model-catalog endpoint.`);
  }
  if (!endpointBase.startsWith('https://')) {
    throw new Error(`${displayName} does not have a secure model-catalog endpoint.`);
  }

  try {
    await deps.ensureConsent(profile.id, endpointBase);
  } catch {
    throw new Error(`Network access could not be confirmed for ${displayName}.`);
  }

  let response: Awaited<ReturnType<ConnectionTestFetch>>;
  try {
    response = await deps.metadataFetch(`${endpointBase}/models`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    if (error instanceof EgressNotConsentedError) {
      throw error;
    }
    throw new Error(`The model catalog for ${displayName} could not be reached.`);
  }

  if (!response.ok) {
    throw new Error(`${displayName} returned HTTP ${response.status} while listing models.`);
  }

  try {
    parseGatewayJson(await response.text(), endpointBase);
  } catch (error) {
    if (error instanceof GatewayHtmlResponseError) {
      throw error;
    }
    throw new Error(`${displayName} returned an invalid model-catalog response.`);
  }

  return { connectionId: profile.id, displayName };
}
