/*---------------------------------------------------------------------------------------------
 *  UnodeAi - RealMcpClient (段2)
 *  Adapts @modelcontextprotocol/sdk to the Hub's McpClient interface.
 *
 *  The SDK is loaded LAZILY via dynamic import, so the extension type-checks, builds, and unit-tests
 *  WITHOUT the dependency installed — it's only pulled in at runtime when an agent actually mounts an
 *  MCP server. If it's missing, we fail with a clear "run npm i" message instead of a cryptic
 *  module-resolution crash. Specifiers are STRING LITERALS (one per entrypoint) on purpose: esbuild
 *  can only follow literal dynamic imports, so this lets the SDK bundle into out/extension.js (E5b).
 *--------------------------------------------------------------------------------------------*/

import { MCPServerConfig } from '../types';
import { McpClient } from './MCPHub';

type SdkModule = 'client' | 'stdio' | 'streamable-http' | 'sse';

async function loadSdk(module: SdkModule): Promise<any> {
  try {
    switch (module) {
      case 'client':
        return await import('@modelcontextprotocol/sdk/client/index.js');
      case 'stdio':
        return await import('@modelcontextprotocol/sdk/client/stdio.js');
      case 'streamable-http':
        return await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      case 'sse':
        return await import('@modelcontextprotocol/sdk/client/sse.js');
    }
  } catch (err) {
    throw new Error(
      `MCP support needs the SDK. Install it with: npm i @modelcontextprotocol/sdk  (${String(err)})`
    );
  }
}

/** Connect to a real MCP server and adapt it to McpClient. Used as MCPHub's clientFactory in prod. */
export async function createRealMcpClient(
  config: MCPServerConfig,
  env: Record<string, string>
): Promise<McpClient> {
  const { Client } = await loadSdk('client');

  let transport: any;
  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new Error(`MCP server "${config.id}" is stdio but has no command.`);
    }
    const { StdioClientTransport } = await loadSdk('stdio');
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...minimalInheritedEnv(), ...env },
    });
  } else if (config.transport === 'streamable-http') {
    if (!config.url) {
      throw new Error(`MCP server "${config.id}" is streamable-http but has no url.`);
    }
    const { StreamableHTTPClientTransport } = await loadSdk('streamable-http');
    transport = new StreamableHTTPClientTransport(new URL(config.url));
  } else {
    if (!config.url) {
      throw new Error(`MCP server "${config.id}" is sse but has no url.`);
    }
    const { SSEClientTransport } = await loadSdk('sse');
    transport = new SSEClientTransport(new URL(config.url));
  }

  const client = new Client({ name: 'unodeai', version: '1.0.0' });
  await client.connect(transport);

  return {
    async listTools() {
      const res = await client.listTools();
      return (res.tools ?? []).map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
    async callTool(name: string, args: Record<string, unknown>) {
      const res = await client.callTool({ name, arguments: args });
      return typeof res === 'string' ? res : JSON.stringify(res);
    },
    async close() {
      await client.close();
    },
  };
}

/**
 * MCP subprocesses need a small OS baseline so commands such as `npx` can resolve, but they should
 * not inherit arbitrary API keys or tokens from the VS Code extension process.
 */
export function minimalInheritedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'ComSpec',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
  ]) {
    const val = source[key];
    if (typeof val === 'string' && val.length > 0) {
      out[key] = val;
    }
  }
  return out;
}
