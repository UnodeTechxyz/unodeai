import { BUILTIN_CONNECTION_REGISTRY, ConnectionResolver, EffectiveConnectionRegistry } from '../routes/ConnectionRegistry';
import { CustomGatewayRegistrySnapshot } from './CustomGatewayProfile';

/** The small part of the profile store needed while activating or refreshing the host registry. */
export interface CustomGatewayRegistryReader {
  load(): Promise<CustomGatewayRegistrySnapshot>;
}

/**
 * Preserve built-in routes when the machine-local custom registry cannot be read. Callers retain
 * the original error solely to report it; the fallback itself intentionally has no custom profile
 * and therefore cannot authorize custom-gateway egress.
 */
export interface ContainedCustomGatewayRegistryLoad {
  resolver: ConnectionResolver;
  snapshot?: CustomGatewayRegistrySnapshot;
  error?: unknown;
}

export async function loadCustomGatewayRegistryFailClosed(
  reader: CustomGatewayRegistryReader,
): Promise<ContainedCustomGatewayRegistryLoad> {
  try {
    const snapshot = await reader.load();
    return { snapshot, resolver: new EffectiveConnectionRegistry(snapshot) };
  } catch (error) {
    return { resolver: BUILTIN_CONNECTION_REGISTRY, error };
  }
}
