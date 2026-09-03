import { spawn } from 'child_process';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

describe('claudeToolGate fail-closed hook process', () => {
  it('emits a Claude PreToolUse allow/deny decision for a valid authenticated endpoint response', async () => {
    const server = await serve((_req, res) => respond(res, 200, { allow: false, reason: 'user denied' }));
    const result = await runHook(server.port);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'user denied',
      },
    });
  });

  it.each([
    ['endpoint down', undefined],
    ['malformed response', async (_req: http.IncomingMessage, res: http.ServerResponse) => respond(res, 200, { nope: true })],
    ['non-200 response', async (_req: http.IncomingMessage, res: http.ServerResponse) => respond(res, 503, { error: 'down' })],
  ])('exits 2 rather than fail-open when %s', async (_name, handler) => {
    const port = handler ? (await serve(handler)).port : 9;
    const result = await runHook(port);

    expect(result.code).toBe(2);
  });

  it('self-times out and exits 2 when the gate never responds', async () => {
    const server = await serve(() => undefined);
    const result = await runHook(server.port, { UNODE_CLAUDE_TOOL_GATE_TIMEOUT_MS: '50' });

    expect(result.code).toBe(2);
  });

  it('uses a global watchdog and exits 2 when Claude never closes stdin', async () => {
    const result = await runHook(9, { UNODE_CLAUDE_TOOL_GATE_TIMEOUT_MS: '50' }, false);

    expect(result.code).toBe(2);
  });

  it('keeps a human decision alive when the authenticated gate ACKs and heartbeats', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"type":"ack"}\n');
      const heartbeat = setInterval(() => res.write('{"type":"heartbeat"}\n'), 25);
      setTimeout(() => {
        clearInterval(heartbeat);
        res.end('{"allow":false,"reason":"nobody approved"}\n');
      }, 500);
      res.once('close', () => clearInterval(heartbeat));
    });
    const result = await runHook(server.port, {
      UNODE_CLAUDE_TOOL_GATE_TIMEOUT_MS: '800',
      UNODE_CLAUDE_TOOL_GATE_LIVENESS_MS: '100',
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('fails closed quickly when an ACK is not followed by a liveness heartbeat', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"type":"ack"}\n');
    });
    const result = await runHook(server.port, {
      UNODE_CLAUDE_TOOL_GATE_TIMEOUT_MS: '600',
      UNODE_CLAUDE_TOOL_GATE_LIVENESS_MS: '100',
    });

    expect(result.code).toBe(2);
  });
});

async function serve(handler: http.RequestListener): Promise<{ port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return { port: (server.address() as AddressInfo).port };
}

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function runHook(
  port: number,
  env: Record<string, string> = {},
  closeStdin = true
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.resolve(process.cwd(), 'src', 'claudeToolGate.cjs')], {
      env: {
        ...process.env,
        UNODE_CLAUDE_TOOL_GATE_URL: `http://127.0.0.1:${port}/gate`,
        UNODE_CLAUDE_TOOL_GATE_TOKEN: 'test-token',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.once('error', reject);
    proc.once('exit', (code) => {
      if (code === null && stderr) {
        reject(new Error(stderr));
        return;
      }
      resolve({ code, stdout });
    });
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } });
    if (closeStdin) {
      proc.stdin.end(input);
    } else {
      proc.stdin.write(input);
    }
  });
}
