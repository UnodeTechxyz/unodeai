import type { MCPServerConfig } from '../types';
import { redactDiagnosticText } from '../security/diagnosticRedaction';
import { resolveMcpSecretEnvironment } from './McpSecretEnvironment';
import { BoundedStderrTail, createRealMcpClient } from './RealMcpClient';
import type { McpClient, SecretResolver } from './MCPHub';

/** Deliberately has no Hub or evidence-store parameter. A test lists tools on a private connection. */
export async function testMcpConnection(
  config: MCPServerConfig, resolveSecret: SecretResolver, signal: AbortSignal,
): Promise<number> {
  let client: McpClient | undefined;
  let secretValues: readonly string[] = [];
  let stage = 'Starting the test connection';
  try {
    signal.throwIfAborted();
    const resolved = await resolveMcpSecretEnvironment(config.env, resolveSecret);
    secretValues = resolved.secretValues;
    signal.throwIfAborted();
    client = await createRealMcpClient(config, resolved.env, secretValues, signal);
    stage = 'Listing tools';
    const tools = await client.listTools();
    signal.throwIfAborted();
    return tools.length;
  } catch (error) {
    signal.throwIfAborted();
    const tail = new BoundedStderrTail(secretValues);
    tail.append(error instanceof Error ? error.message : String(error));
    throw new Error(`${stage} failed. ${redactDiagnosticText(tail.text()).slice(0, 500)}`);
  } finally {
    await client?.close().catch(() => undefined);
  }
}
