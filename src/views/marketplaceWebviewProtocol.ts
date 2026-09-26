/**
 * Marketplace is an untrusted renderer. Transport parsing is deliberately separate from catalog
 * validation: only the host's current catalog can decide whether an install target still exists.
 */
export type MarketplaceWebviewInboundMessage =
  | { command: 'openAgentBuilder' }
  | { command: 'editAgent'; agentId: string }
  | { command: 'addMcpServer' }
  | { command: 'removeIntegration'; serverId: string }
  | { command: 'checkIntegration'; entryId: string }
  | { command: 'install'; action: unknown };

export type MarketplaceWebviewOutboundMessage =
  | {
      command: 'installResult';
      kind: 'agent' | 'mcp';
      entryId: string;
      ok: boolean;
    }
  | {
      command: 'viewState';
      /** Host-rendered from escaped roster fields; the webview supplies no markup. */
      agentsHtml: string;
      ownedIntegrationsHtml: string;
      integrations: Record<string, {
        listed: boolean;
        configured: boolean;
        approved: boolean;
        mounted: boolean;
        exercised: boolean;
        succeeded: boolean;
      }>;
    };

export type MarketplaceWebviewInboundParse =
  | { ok: true; message: MarketplaceWebviewInboundMessage }
  | { ok: false; reason: string };

const FIELDS: Record<MarketplaceWebviewInboundMessage['command'], readonly string[]> = {
  openAgentBuilder: ['command'],
  editAgent: ['command', 'agentId'],
  addMcpServer: ['command'],
  removeIntegration: ['command', 'serverId'],
  checkIntegration: ['command', 'entryId'],
  install: ['command', 'action'],
};

/** Parse exactly the small message surface this panel accepts; unknown fields never acquire authority. */
export function parseMarketplaceWebviewInboundMessage(value: unknown): MarketplaceWebviewInboundParse {
  if (!isRecord(value) || typeof value.command !== 'string') return reject('message is not an object with a command');
  const command = value.command;
  if (command !== 'openAgentBuilder' && command !== 'editAgent' && command !== 'addMcpServer'
      && command !== 'removeIntegration' && command !== 'checkIntegration' && command !== 'install') {
    return reject('command is not supported');
  }
  if (Object.keys(value).some((key) => !FIELDS[command].includes(key))) return reject('message contains an unexpected field');
  if (command === 'install') {
    return value.action === undefined ? reject('install action is missing') : { ok: true, message: { command: 'install', action: value.action } };
  }
  if (command === 'editAgent' || command === 'checkIntegration' || command === 'removeIntegration') {
    const field = command === 'editAgent' ? 'agentId' : command === 'checkIntegration' ? 'entryId' : 'serverId';
    return typeof value[field] === 'string' && value[field] !== ''
      ? { ok: true, message: { command, [field]: value[field] } as MarketplaceWebviewInboundMessage }
      : reject(`${field} is missing`);
  }
  return { ok: true, message: { command } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function reject(reason: string): MarketplaceWebviewInboundParse {
  return { ok: false, reason };
}
