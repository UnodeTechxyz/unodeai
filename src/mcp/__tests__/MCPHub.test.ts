import { afterEach, describe, it, expect, vi } from 'vitest';
import { MCPHub, McpClient, McpClientFactory, McpToolDef, McpServerGrant } from '../MCPHub';
import { MCPServerConfig } from '../../types';

function server(over: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return { id: 'github', name: 'GitHub', transport: 'stdio', command: 'npx', ...over };
}

/** A fake client exposing fixed tools; records calls and lets tests control callTool. */
function fakeFactory(
  tools: McpToolDef[],
  opts: { onCall?: (name: string, args: any) => Promise<string>; onClose?: () => void; capture?: (env: Record<string, string>, secretValues: readonly string[]) => void } = {}
): McpClientFactory {
  return async (_config, env, secretValues): Promise<McpClient> => {
    opts.capture?.(env, secretValues);
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

afterEach(() => { vi.useRealTimers(); });

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
    const out = await hub.executeTool('github__echo', { x: 42 }, [grant()]);
    expect(out).toMatchObject({ status: 'success', output: 'ok:echo:42' });
    expect(onCall).toHaveBeenCalledWith('echo', { x: 42 });
  });

  it('refuses to execute real but ungranted MCP tools when grants are provided', async () => {
    const onCall = vi.fn(async (name: string) => `ok:${name}`);
    const hub = new MCPHub(fakeFactory([{ name: 'safe' }, { name: 'hidden' }], { onCall }));
    await hub.register(server());
    const grants = [grant({ toolFilter: 'allowlist', toolList: ['safe'] })];

    expect(hub.canExecuteTool('github__safe', grants)).toBe(true);
    expect(hub.canExecuteTool('github__hidden', grants)).toBe(false);
    await expect(hub.executeTool('github__safe', {}, grants)).resolves.toMatchObject({ status: 'success', output: 'ok:safe' });
    await expect(hub.executeTool('github__hidden', {}, grants)).resolves.toMatchObject({ status: 'refused', reason: 'consent' });
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  // v0.9.99: a deadline the person configured for the server still ends a call. The outcome is unknown and the call
  // is not repeated, but the server is not taken out of use: the next call runs on the same connection.
  it('ends a call at the server\'s configured timeout as an unknown outcome, and keeps the server in use', async () => {
    let calls = 0;
    const hub = new MCPHub(fakeFactory([{ name: 'slow' }], {
      onCall: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve('second call ran')),
    }));
    await hub.register(server({ timeoutMs: 20 }));
    const out = await hub.executeTool('github__slow', {}, [grant()]);
    expect(out).toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
    expect(out.output).toMatch(/configured time limit of 20 ms after it was sent; its outcome is unknown\. It was not run again\./);
    expect(hub.isRegistered('github')).toBe(true);
    expect(hub.getToolSpecs([grant()]).map((spec) => spec.function.name)).toEqual(['github__slow']);
    await expect(hub.executeTool('github__slow', {}, [grant()])).resolves.toMatchObject({ status: 'success', output: 'second call ran' });
    expect(calls).toBe(2);
  });

  // v0.9.99: without a configured deadline a slow call is not ended by the host. On a fake clock it completes after
  // two minutes, and the turn's Stop still ends one that never answers.
  it('lets a call without a configured deadline complete after more than 60 seconds', async () => {
    vi.useFakeTimers();
    const hub = new MCPHub(fakeFactory([{ name: 'slow' }], {
      onCall: () => new Promise<string>((resolve) => setTimeout(() => resolve('finished after 120 s'), 120_000)),
    }));
    await hub.register(server());
    let settled = false;
    const pending = hub.executeTool('github__slow', {}, [grant()]).then((out) => { settled = true; return out; });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toMatchObject({ status: 'success', output: 'finished after 120 s' });
    expect(hub.isRegistered('github')).toBe(true);
  });

  it('a call without a configured deadline still ends at once on the turn\'s Stop, as an unknown outcome', async () => {
    vi.useFakeTimers();
    const hub = new MCPHub(fakeFactory([{ name: 'slow' }], { onCall: () => new Promise(() => {}) }));
    await hub.register(server());
    const stop = new AbortController();
    const pending = hub.executeTool('github__slow', {}, [grant()], stop.signal);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    stop.abort();
    await expect(pending).resolves.toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
  });

  it('an embedder\'s explicit hub-wide deadline applies when the server names none', async () => {
    const hub = new MCPHub(fakeFactory([{ name: 'slow' }], { onCall: () => new Promise(() => {}) }), undefined, 15);
    await hub.register(server());
    const out = await hub.executeTool('github__slow', {}, [grant()]);
    expect(out).toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
    expect(out.output).toMatch(/configured time limit of 15 ms/);
    expect(hub.isRegistered('github')).toBe(true);
  });

  it('reports a pre-dispatch cancellation without calling or quarantining the server', async () => {
    const onCall = vi.fn(async () => 'too late');
    const hub = new MCPHub(fakeFactory([{ name: 'slow' }], { onCall }));
    await hub.register(server());
    const controller = new AbortController();
    controller.abort();

    await expect(hub.executeTool('github__slow', {}, [grant()], controller.signal))
      .resolves.toMatchObject({ status: 'failed', failureKind: 'cancelled' });
    expect(onCall).not.toHaveBeenCalled();
    expect(hub.isRegistered('github')).toBe(true);
  });

  it('discards a late response after post-dispatch cancellation, then remounts before the next call', async () => {
    let resolveCall!: (value: string) => void;
    let upstreamSignal!: AbortSignal;
    let connections = 0;
    const hub = new MCPHub(async () => {
      const connection = ++connections;
      return {
        async listTools() { return [{ name: 'slow' }]; },
        async callTool(_name, _args, signal) {
          if (connection > 1) return 'recovered';
          upstreamSignal = signal!;
          return await new Promise<string>((resolve) => { resolveCall = resolve; });
        },
        async close() {},
      };
    });
    await hub.register(server());
    const controller = new AbortController();
    const pending = hub.executeTool('github__slow', {}, [grant()], controller.signal);
    await Promise.resolve(); await Promise.resolve();
    controller.abort();

    await expect(pending).resolves.toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
    expect(upstreamSignal.aborted).toBe(true);
    resolveCall('late success');
    await expect(hub.executeTool('github__slow', {}, [grant()])).resolves.toMatchObject({
      status: 'success', output: 'recovered',
    });
    expect(connections).toBe(2);
    expect(hub.isRegistered('github')).toBe(true);
  });

  it('reports reconnect failure as temporary unavailability rather than revoked consent', async () => {
    let rejectCall!: (error: Error) => void;
    const hub = new MCPHub(async () => ({
      async listTools() { return [{ name: 'slow' }]; },
      async callTool() { return await new Promise<string>((_resolve, reject) => { rejectCall = reject; }); },
      async close() { rejectCall?.(new Error('closed')); },
    }), undefined, 60_000, async () => { throw new Error('server still starting'); });
    await hub.register(server());
    const controller = new AbortController();
    const pending = hub.executeTool('github__slow', {}, [grant()], controller.signal);
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });

    const retry = await hub.executeTool('github__slow', {}, [grant()]);
    expect(retry).toMatchObject({ status: 'failed', failureKind: 'not_found' });
    expect(retry.output).toMatch(/temporarily unavailable while reconnecting/i);
    expect(retry.output).not.toMatch(/not granted/i);
  });

  it('aborts upstream calls when the Hub stops', async () => {
    let upstreamSignal!: AbortSignal;
    const hub = new MCPHub(async () => ({
      async listTools() { return [{ name: 'slow' }]; },
      async callTool(_name, _args, signal) {
        upstreamSignal = signal!;
        return await new Promise<string>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(new Error('cancelled upstream')), { once: true });
        });
      },
      async close() {},
    }));
    await hub.register(server());
    const pending = hub.executeTool('github__slow', {}, [grant()]);
    await Promise.resolve(); await Promise.resolve();

    await hub.stopAll();
    expect(upstreamSignal.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
  });

  it('does not infer failure from external output that begins with Error:', async () => {
    const hub = new MCPHub(fakeFactory([{ name: 'echo' }], { onCall: async () => 'Error: this is valid data' }));
    await hub.register(server());
    await expect(hub.executeTool('github__echo', {}, [grant()]))
      .resolves.toMatchObject({ status: 'success', output: 'Error: this is valid data' });
  });

  it('maps an MCP isError result to a typed failure without quarantining the responsive server', async () => {
    const hub = new MCPHub(async () => ({
      async listTools() { return [{ name: 'create_issue' }]; },
      async callTool() { return { output: 'Repository access denied.', isError: true }; },
      async close() {},
    }));
    await hub.register(server());
    await expect(hub.executeTool('github__create_issue', {}, [grant()])).resolves.toMatchObject({
      status: 'failed', failureKind: 'integration_error', output: 'Repository access denied.',
    });
    expect(hub.isRegistered('github')).toBe(true);
  });

  it('resolves ${VAR} env placeholders via the secret resolver, not process.env', async () => {
    let capturedEnv: Record<string, string> = {};
    let capturedSecrets: readonly string[] = [];
    const hub = new MCPHub(
      fakeFactory([{ name: 't' }], { capture: (e, secrets) => { capturedEnv = e; capturedSecrets = secrets; } }),
      async (name) => (name === 'GITHUB_TOKEN' ? 'ghp_secret' : undefined)
    );
    await hub.register(server({ env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'Bearer ${GITHUB_TOKEN}', PLAIN: 'literal' } }));
    expect(capturedEnv.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('Bearer ghp_secret');
    expect(capturedEnv.PLAIN).toBe('literal');
    expect(capturedSecrets).toEqual(['ghp_secret']);
    expect(capturedSecrets).not.toContain('literal');
  });

  it.each([
    { resolved: undefined, message: /not configured/i },
    { resolved: '', message: /is empty/i },
  ])('fails before the client factory when a required secret is unavailable', async ({ resolved, message }) => {
    const factory = vi.fn(fakeFactory([{ name: 't' }]));
    const hub = new MCPHub(factory, async () => resolved);
    await expect(hub.register(server({ env: { TOKEN: '${MISSING_TOKEN}' } }))).rejects.toThrow(message);
    expect(factory).not.toHaveBeenCalled();
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
