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
import { McpClient, McpToolResult } from './MCPHub';

const STDERR_MAX_LINES = 20;
const STDERR_MAX_CHARS = 2_048;
const STRUCTURED_CONTENT_MAX_CHARS = 16_384;

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
  env: Record<string, string>,
  secretValues: readonly string[],
): Promise<McpClient> {
  const { Client } = await loadSdk('client');

  let transport: any;
  let stderrTail: BoundedStderrTail | undefined;
  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new Error(`MCP server "${config.id}" is stdio but has no command.`);
    }
    const { StdioClientTransport } = await loadSdk('stdio');
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...minimalInheritedEnv(), ...env },
      stderr: 'pipe',
    });
    stderrTail = new BoundedStderrTail(secretValues);
    transport.stderr?.on('data', (chunk: unknown) => stderrTail?.append(chunk));
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
  try {
    await client.connect(transport);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const tail = stderrTail?.text();
    throw new Error(tail ? `${reason}\nServer stderr (plain text):\n${tail}` : reason);
  }

  return {
    async listTools() {
      const res = await client.listTools();
      return (res.tools ?? []).map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const res = await client.callTool({ name, arguments: args }, undefined, { signal });
      return normalizeMcpToolResult(res);
    },
    async close() {
      await client.close();
    },
  };
}

/**
 * Keep untrusted child stderr bounded and redact every resolved SecretStorage value before retention.
 * The returned string is data for a plain-text UI surface; callers must never interpret it as markup.
 */
export class BoundedStderrTail {
  private value = '';
  /** At most one secret-length prefix; it has not entered the rolling display buffer. */
  private pending = '';
  private readonly secrets: string[];

  constructor(secrets: readonly string[], private readonly maxLines = STDERR_MAX_LINES, private readonly maxChars = STDERR_MAX_CHARS) {
    this.secrets = [...new Set(secrets.filter((secret) => secret.length > 0))]
      .sort((left, right) => right.length - left.length);
  }

  append(chunk: unknown): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    if (this.secrets.length === 0) {
      this.pushSanitized(text);
      return;
    }
    let safe = '';
    for (const char of text) {
      this.pending += char;
      while (this.pending) {
        if (this.secrets.includes(this.pending)) {
          safe += '[redacted]';
          this.pending = '';
          break;
        }
        if (this.secrets.some((secret) => secret.startsWith(this.pending))) break;
        safe += this.pending[0];
        this.pending = this.pending.slice(1);
      }
    }
    this.pushSanitized(safe);
  }

  private pushSanitized(text: string): void {
    const lines = `${this.value}${text}`.replace(/\r\n?/g, '\n').split('\n');
    this.value = lines.slice(-this.maxLines).join('\n').slice(-this.maxChars);
  }

  text(): string {
    // A pending suffix can only be a proper prefix of a secret. Treat that prefix as sensitive too: connect
    // may fail between chunks, and a diagnostic must not reveal even the part received so far.
    return `${this.value}${this.pending ? '[redacted]' : ''}`.trim().slice(-this.maxChars);
  }
}

/** Convert MCP content blocks to text without ever inlining binary payloads. */
export function normalizeMcpToolResult(value: unknown): McpToolResult {
  if (typeof value === 'string') {
    return { output: value, isError: false };
  }
  const result = asRecord(value);
  const content = Array.isArray(result.content) ? result.content : [];
  const rendered = content.map(renderContentBlock).filter((part): part is string => !!part);
  let output = rendered.join('\n');
  if (!content.some((part) => asRecord(part).type === 'text') && result.structuredContent !== undefined) {
    output = [output, framedStructuredContent(result.structuredContent)].filter(Boolean).join('\n');
  }
  if (!output && result.structuredContent !== undefined) {
    output = framedStructuredContent(result.structuredContent);
  }
  return { output, isError: result.isError === true };
}

function renderContentBlock(value: unknown): string | undefined {
  const block = asRecord(value);
  const type = typeof block.type === 'string' ? block.type : 'unknown';
  if (type === 'text') {
    return typeof block.text === 'string' ? block.text : '';
  }
  if (type === 'image' || type === 'audio') {
    return `[${type}: ${typeof block.mimeType === 'string' ? block.mimeType : 'unknown type'}, ${base64Bytes(block.data)} bytes]`;
  }
  if (type === 'resource') {
    const resource = asRecord(block.resource);
    const uri = typeof resource.uri === 'string' ? resource.uri : 'unnamed resource';
    const bytes = typeof resource.text === 'string'
      ? Buffer.byteLength(resource.text, 'utf8')
      : base64Bytes(resource.blob);
    return `[resource: ${uri}, ${bytes} bytes]`;
  }
  if (type === 'resource_link') {
    const uri = typeof block.uri === 'string' ? block.uri : 'unnamed resource';
    const size = typeof block.size === 'number' && Number.isFinite(block.size) ? `${block.size} bytes` : 'size unknown';
    return `[resource link: ${uri}, ${size}]`;
  }
  return `[${type} content: ${Buffer.byteLength(safeJson(block), 'utf8')} bytes]`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function base64Bytes(value: unknown): number {
  if (typeof value !== 'string') return 0;
  try { return Buffer.from(value, 'base64').byteLength; } catch { return Buffer.byteLength(value, 'utf8'); }
}

function safeJson(value: unknown): string {
  try {
    const rendered = JSON.stringify(value);
    return typeof rendered === 'string' ? rendered : '[unserializable structured content]';
  } catch {
    return '[unserializable structured content]';
  }
}

function framedStructuredContent(value: unknown): string {
  const text = safeJson(value);
  const bounded = text.length <= STRUCTURED_CONTENT_MAX_CHARS
    ? text
    : `${text.slice(0, STRUCTURED_CONTENT_MAX_CHARS)}\n[structured content truncated ${text.length - STRUCTURED_CONTENT_MAX_CHARS} chars]`;
  return `[structured content from MCP server]\n${bounded}`;
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
