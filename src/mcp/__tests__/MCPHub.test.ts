import { describe, it, expect, vi } from 'vitest';
import { MCPHub, McpClient, McpClientFactory, McpToolDef, McpServerGrant } from '../MCPHub';
import { MCPServerConfig } from '../../types';

function server(over: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return { id: 'github', name: 'GitHub', transport: 'stdio', command: 'npx', ...over };
}

/** A fake client exposing fixed tools; records calls and lets tests control callTool. */
function fakeFactory(
  tools: McpToolDef[],
  opts: { onCall?: (name: string, args: any) => Promise<string>; onClose?: () => void; capture?: (env: Record<string, string>) => void } = {}
): McpClientFactory {
  return async (_config, env): Promise<McpClient> => {
    opts.capture?.(env);
    return {
      async listTools() {
        return tools;
      },
      async callTool(name, args) {
        return opts.onCall ? opts.onCall(name, args) : `ran ${name}(${JSON.stringify(args)})`;
      },
      async close() {
        opts.onClose?.();
      },
    };
  };
}

const grant = (over: Partial<McpServerGrant> = {}): McpServerGrant => ({ serverId: 'github', toolFilter: 'all', ...over });

describe('MCPHub', () => {
  it('default-deny: exposes nothing without a grant, and nothing for unregistered servers', async () => {
    const hub = new MCPHub(fakeFactory([{ name: 'create_pr' }]));
    await hub.register(server());
    expect(hub.getToolSpecs([])).toEqual([]);
    expect(hub.getToolSpecs([grant({ serverId: 'unknown' })])).toEqual([]);
  });

  it('exposes a granted server\'s tools, namespaced as serverId__tool', async () => {
    const hub = new MCPHub(fakeFactory([{ name: 'create_pr', description: 'open a PR' }, { name: 'list_issues' }]));
    await hub.register(server());
    const specs = hub.getToolSpecs([grant()]);
    expect(specs.map((s) => s.function.name)).toEqual(['github__create_pr', 'github__list_issues']);
    expect(specs[0].function.description).toBe('open a PR');
  });

  it('applies allowlist and denylist tool filters', async () => {
    const hub = new MCPHub(fakeFactory([{ name: 'a' }, { name: 'b' }, { name: 'c' }]));
    await hub.register(server());
    const allow = hub.getToolSpecs([grant({ toolFilter: 'allowlist', toolList: ['a', 'c'] })]);
    expect(allow.map((s) => s.function.name)).toEqual(['github__a', 'github__c']);
    const deny = hub.getToolSpecs([grant({ toolFilter: 'denylist', toolList: ['b'] })]);
    expect(deny.map((s) => s.function.name)).toEqual(['github__a', 'github__c']);
  });

  it('routes executeTool to the underlying client by stripping the namespace', async () => {
    const onCall = vi.fn(async (name: string, args: any) => `ok:${name}:${args.x}`);
    const hub = new MCPHub(fakeFactory([{ name: 'echo' }], { onCall }));
    await hub.register(server());
    expect(hub.hasTool('github__echo')).toBe(true);
    expect(hub.hasTool('echo')).toBe(false);
    const out = await hub.executeTool('github__echo', { x: 42 });
    expect(out).toBe('ok:echo:42');
    expect(onCall).toHaveBeenCalledWith('echo', { x: 42 });
  });

  it('refuses to execute real but ungranted MCP tools when grants are provided', async () => {
    const onCall = vi.fn(async (name: string) => `ok:${name}`);
    const hub = new MCPHub(fakeFactory([{ name: 'safe' }, { name: 'hidden' }], { onCall }));
    await hub.register(server());
    const grants = [grant({ toolFilter: 'allowlist', toolList: ['safe'] })];

    expect(hub.canExecuteTool('github__safe', grants)).toBe(true);
    expect(hub.canExecuteTool('github__hidden', grants)).toBe(false);
    await expect(hub.executeTool('github__safe', {}, grants)).resolves.toBe('ok:safe');
    await expect(hub.executeTool('github__hidden', {}, grants)).resolves.toMatch(/not granted/);
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it('times out a hung tool call and returns an error string (not a throw)', async () => {
    const hub = new MCPHub(fakeFactory([{ name: 'slow' }], { onCall: () => new Promise(() => {}) }));
    await hub.register(server({ timeoutMs: 20 }));
    const out = await hub.executeTool('github__slow', {});
    expect(out).toMatch(/timed out/);
  });

  it('resolves ${VAR} env placeholders via the secret resolver, not process.env', async () => {
    let capturedEnv: Record<string, string> = {};
    const hub = new MCPHub(
      fakeFactory([{ name: 't' }], { capture: (e) => (capturedEnv = e) }),
      async (name) => (name === 'GITHUB_TOKEN' ? 'ghp_secret' : undefined)
    );
    await hub.register(server({ env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'Bearer ${GITHUB_TOKEN}', PLAIN: 'literal' } }));
    expect(capturedEnv.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('Bearer ghp_secret');
    expect(capturedEnv.PLAIN).toBe('literal');
  });

  it('closes all clients on stopAll and refuses double registration', async () => {
    const onClose = vi.fn();
    const hub = new MCPHub(fakeFactory([{ name: 't' }], { onClose }));
    await hub.register(server());
    await expect(hub.register(server())).rejects.toThrow(/already registered/);
    await hub.stopAll();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(hub.isRegistered('github')).toBe(false);
  });
});
