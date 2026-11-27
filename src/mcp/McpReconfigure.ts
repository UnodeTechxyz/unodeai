/*---------------------------------------------------------------------------------------------
 *  UnodeAi - MCP reconfiguration
 *  Compares saved launch configurations without treating a display-name change as a new launch.
 *--------------------------------------------------------------------------------------------*/

import { MCPServerConfig } from '../types';
import { approvalKey, shouldRequireApproval } from './McpApproval';

/** Compare the effective launch identity plus its approval classification. Display names are not runtime config. */
export function sameMcpMountConfig(left: MCPServerConfig, right: MCPServerConfig): boolean {
  return approvalKey(left, 'comparison') === approvalKey(right, 'comparison')
    && shouldRequireApproval(left) === shouldRequireApproval(right);
}
