import { describe, expect, it, vi } from 'vitest';
import { MCPHub, McpClientFactory } from '../MCPHub';
import { reconfigureRegisteredMcp } from '../McpReconfigure';
import { MCPServerConfig } from '../../types';

const config = (url: string): MCPServerConfig => ({
  id: 'time', name: 'Time', transport: 'streamable-http', url,
});

describe('reconfigureRegisteredMcp', () => {
  it('leaves an identical registered server running and skips the mount callback', async () => {
    const close = vi.fn();
    const factory: McpClientFactory = async () => ({ listTools: async () => [], callTool: async () => '', close });
    const hub = new MCPHub(factory);
    await hub.register(config('https://one.example/mcp'));
    const mount = vi.fn(async () => 'mounted' as const);

    await expect(reconfigureRegisteredMcp(hub, config('https://one.example/mcp'), mount))
      .resolves.toEqual({ kind: 'unchanged' });
    expect(mount).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(hub.isRegistered('time')).toBe(true);
  });

  it('unregisters a changed server before mounting the replacement', async () => {
    const close = vi.fn();
    const seenUrls: Array<string | undefined> = [];
    const factory: McpClientFactory = async (cfg) => {
      seenUrls.push(cfg.url);
      return { listTools: async () => [], callTool: async () => '', close };
    };
    const hub = new MCPHub(factory);
    const replacement = config('https://two.example/mcp');
    await hub.register(config('https://one.example/mcp'));

    const result = await reconfigureRegisteredMcp(hub, replacement, async () => {
      expect(hub.isRegistered('time'), 'the old process must be gone before approval/remount').toBe(false);
      await hub.register(replacement);
      return 'mounted' as const;
    });

    expect(result).toEqual({ kind: 'remounted', outcome: 'mounted' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(seenUrls).toEqual(['https://one.example/mcp', 'https://two.example/mcp']);
    expect(hub.registeredConfig('time')?.url).toBe('https://two.example/mcp');
  });
});
