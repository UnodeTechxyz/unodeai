/**
 * Marketplace is an untrusted renderer. Transport parsing is deliberately separate from catalog
 * validation: only the host's current catalog can decide whether an install target still exists.
 */
export type MarketplaceWebviewInboundMessage =
  | { command: 'openAgentBuilder' }
  | { command: 'addMcpServer' }
  | { command: 'install'; action: unknown };

export type MarketplaceWebviewOutboundMessage = {
  command: 'installResult';
  kind: 'agent' | 'mcp';
  entryId: string;
  ok: boolean;
};

export type MarketplaceWebviewInboundParse =
  | { ok: true; message: MarketplaceWebviewInboundMessage }
  | { ok: false; reason: string };

const FIELDS: Record<MarketplaceWebviewInboundMessage['command'], readonly string[]> = {
  openAgentBuilder: ['command'],
  addMcpServer: ['command'],
  install: ['command', 'action'],
};

/** Parse exactly the small message surface this panel accepts; unknown fields never acquire authority. */
export function parseMarketplaceWebviewInboundMessage(value: unknown): MarketplaceWebviewInboundParse {
  if (!isRecord(value) || typeof value.command !== 'string') return reject('message is not an object with a command');
  const command = value.command;
  if (command !== 'openAgentBuilder' && command !== 'addMcpServer' && command !== 'install') {
    return reject('command is not supported');
  }
  if (Object.keys(value).some((key) => !FIELDS[command].includes(key))) return reject('message contains an unexpected field');
  if (command === 'install') {
    return value.action === undefined ? reject('install action is missing') : { ok: true, message: { command: 'install', action: value.action } };
  }
  return { ok: true, message: { command } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function reject(reason: string): MarketplaceWebviewInboundParse {
  return { ok: false, reason };
}
