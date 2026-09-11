import type { CustomGatewayProfileV1 } from '../../connections/CustomGatewayProfile';
import { EffectiveConnectionRegistry } from '../ConnectionRegistry';

export const CUSTOM_GATEWAY_ID = 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
export const CUSTOM_GATEWAY_SECRET_REF = 'custom-gateway:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:11111111111111111111111111111111';

export function customGatewayResolver(options: {
  endpoint?: string;
  displayName?: string;
  secretRef?: string;
  includeSecret?: boolean;
  revision?: number;
  registryRevision?: number;
} = {}): EffectiveConnectionRegistry {
  const profile: CustomGatewayProfileV1 = {
    schemaVersion: 1,
    connectionId: CUSTOM_GATEWAY_ID,
    revision: options.revision ?? 1,
    state: 'active',
    displayName: options.displayName ?? 'Fixture Gateway',
    endpointBase: options.endpoint ?? 'https://gateway.example/v1',
    ...(options.includeSecret === false
      ? {}
      : { secretRef: options.secretRef ?? CUSTOM_GATEWAY_SECRET_REF }),
    billingKind: 'custom-account',
  };
  return new EffectiveConnectionRegistry({
    registryRevision: options.registryRevision ?? 1,
    profiles: [profile],
  });
}
