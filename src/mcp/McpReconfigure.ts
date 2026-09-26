/*---------------------------------------------------------------------------------------------
 *  UnodeAi - MCP reconfiguration
 *  Keeps an already-mounted server truthful: identical launch specs are a no-op; changed specs
 *  close the old client before the caller runs the normal approval-and-mount path again.
 *--------------------------------------------------------------------------------------------*/

import { MCPServerConfig } from '../types';
import { MCPHub } from './MCPHub';
import { approvalKey, shouldRequireApproval } from './McpApproval';

export type McpReconfigureResult<T> =
  | { kind: 'unchanged' }
  | { kind: 'mounted' | 'remounted'; outcome: T };

/** Compare the effective launch identity plus its approval classification. Display names are not runtime config. */
export function sameMcpMountConfig(left: MCPServerConfig, right: MCPServerConfig): boolean {
  return approvalKey(left, 'comparison') === approvalKey(right, 'comparison')
    && shouldRequireApproval(left) === shouldRequireApproval(right);
}

export async function reconfigureRegisteredMcp<T>(
  hub: Pick<MCPHub, 'registeredConfig' | 'unregister'>,
  resolvedConfig: MCPServerConfig,
  mount: () => Promise<T>,
): Promise<McpReconfigureResult<T>> {
  const mounted = hub.registeredConfig(resolvedConfig.id);
  if (!mounted) {
    return { kind: 'mounted', outcome: await mount() };
  }
  if (sameMcpMountConfig(mounted, resolvedConfig)) {
    return { kind: 'unchanged' };
  }
  await hub.unregister(resolvedConfig.id);
  return { kind: 'remounted', outcome: await mount() };
}
