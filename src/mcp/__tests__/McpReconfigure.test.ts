import { describe, expect, it, vi } from 'vitest';
import { MCPHub } from '../MCPHub';
import { sameMcpMountConfig } from '../McpReconfigure';
import { approvalKey } from '../McpApproval';
import { MCPServerConfig } from '../../types';

const config = (url: string): MCPServerConfig => ({
  id: 'time', name: 'Time', transport: 'streamable-http', url,
});

describe('managed integration launch changes', () => {
  it('rename of mounted bare uvx keeps its client and approval', async () => {
    const saved = { id: 'time', transport: 'stdio' as const, command: 'uvx', args: ['time-server'], name: 'Time' };
    const renamed = { ...saved, name: 'Local time' };
    const close = vi.fn(async () => {});
    const hub = new MCPHub(async () => ({ listTools: async () => [], callTool: async () => '', close }));
    await hub.register({ ...saved, command: process.execPath });
    expect(sameMcpMountConfig(saved, renamed)).toBe(true);
    expect(sameMcpMountConfig(hub.registeredConfig('time')!, renamed)).toBe(false);
    expect(approvalKey(saved, 'workspace')).toBe(approvalKey(renamed, 'workspace'));
    hub.renameRegisteredServer('time', renamed.name);
    expect(hub.listServers()[0]).toMatchObject({ id: 'time', name: 'Local time' });
    expect(close).not.toHaveBeenCalled();
    await hub.stopAll();
  });

  it('late obsolete mount never publishes or unregisters the replacement', async () => {
    let entered!: () => void;
    let finish!: (tools: Array<{ name: string; inputSchema: object }>) => void;
    const listing = new Promise<void>(resolve => { entered = resolve; });
    const closeOld = vi.fn(async () => {});
    const closeNew = vi.fn(async () => {});
    const first = config('https://one.example/mcp');
    const next = config('https://two.example/mcp');
    const hub = new MCPHub(async cfg => ({
      listTools: () => cfg === first
        ? new Promise(resolve => { finish = resolve; entered(); })
        : Promise.resolve([{ name: 'replacement', inputSchema: {} }]),
      callTool: async () => '',
      close: cfg === first ? closeOld : closeNew,
    }));
    const abort = new AbortController();
    const owner = Symbol('previous mount');
    const older = hub.register(first, { current: () => true, owner, signal: abort.signal });
    const rejected = expect(older).rejects.toThrow('changed before it could mount');
    await listing;
    abort.abort();
    await hub.register(next);
    finish([{ name: 'outdated', inputSchema: {} }]);
    await rejected;
    await hub.unregister(first.id, owner);
    expect(hub.getToolSpecs([{ serverId: first.id, toolFilter: 'all' }]).map(tool => tool.function.name))
      .toEqual(['time__replacement']);
    expect(closeOld).toHaveBeenCalledOnce();
    expect(closeNew).not.toHaveBeenCalled();
  });

});
