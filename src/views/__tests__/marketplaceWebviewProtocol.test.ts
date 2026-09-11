import { describe, expect, it } from 'vitest';
import { parseMarketplaceWebviewInboundMessage } from '../marketplaceWebviewProtocol';

describe('Marketplace webview protocol', () => {
  it('accepts only the three declared host requests', () => {
    expect(parseMarketplaceWebviewInboundMessage({ command: 'openAgentBuilder' }))
      .toEqual({ ok: true, message: { command: 'openAgentBuilder' } });
    expect(parseMarketplaceWebviewInboundMessage({ command: 'addMcpServer' }))
      .toEqual({ ok: true, message: { command: 'addMcpServer' } });
    expect(parseMarketplaceWebviewInboundMessage({ command: 'install', action: { kind: 'agent', entryId: 'dev', target: 'current-team' } }))
      .toEqual({ ok: true, message: { command: 'install', action: { kind: 'agent', entryId: 'dev', target: 'current-team' } } });
  });

  it('fails closed for malformed, widened, or incomplete requests', () => {
    expect(parseMarketplaceWebviewInboundMessage(undefined).ok).toBe(false);
    expect(parseMarketplaceWebviewInboundMessage({ command: 'install' }).ok).toBe(false);
    expect(parseMarketplaceWebviewInboundMessage({ command: 'openAgentBuilder', action: {} }).ok).toBe(false);
    expect(parseMarketplaceWebviewInboundMessage({ command: 'deleteCatalog' }).ok).toBe(false);
  });
});
