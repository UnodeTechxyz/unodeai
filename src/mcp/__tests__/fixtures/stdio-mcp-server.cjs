'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const logPath = process.env.UNODE_MCP_FIXTURE_LOG;
const pending = new Map();

function log(event) {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...event })}\n`, 'utf8');
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    result(id, {
      protocolVersion: params.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'unode-real-mcp-fixture', version: '1.0.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') {
    log({ method });
    return;
  }
  if (method === 'notifications/cancelled') {
    const requestId = params.requestId;
    log({ method, requestId, reason: params.reason });
    const timer = pending.get(requestId);
    if (timer) {
      clearTimeout(timer);
      pending.delete(requestId);
      error(requestId, 'cancelled by client');
    }
    return;
  }
  if (method === 'tools/list') {
    result(id, { tools: [
      { name: 'lookup_code', description: 'Return a deterministic fixture code.', inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } },
      { name: 'token_status', description: 'Report token presence and length only.', inputSchema: { type: 'object', properties: {} } },
      { name: 'slow_echo', description: 'Echo after a bounded delay.', inputSchema: { type: 'object', properties: { ms: { type: 'number' }, text: { type: 'string' } }, required: ['ms', 'text'] } },
    ] });
    return;
  }
  if (method === 'tools/call') {
    const name = String(params.name || '');
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    log({ method, requestId: id, tool: name, args: name === 'token_status' ? {} : args });
    if (name === 'lookup_code') {
      result(id, { content: [{ type: 'text', text: `code:${String(args.topic || '')}` }] });
      return;
    }
    if (name === 'token_status') {
      const token = process.env.UNODE_MCP_FIXTURE_TOKEN;
      result(id, { content: [{ type: 'text', text: JSON.stringify({ present: token !== undefined, length: token?.length || 0 }) }] });
      return;
    }
    if (name === 'slow_echo') {
      const timer = setTimeout(() => {
        pending.delete(id);
        result(id, { content: [{ type: 'text', text: String(args.text || '') }] });
      }, Math.max(0, Math.min(30_000, Number(args.ms) || 0)));
      pending.set(id, timer);
      return;
    }
    error(id, `unknown tool: ${name}`);
    return;
  }
  if (id !== undefined && id !== null) error(id, `unknown method: ${method}`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  try {
    void handle(JSON.parse(line));
  } catch (cause) {
    log({ method: 'fixture/error', message: String(cause) });
  }
});
lines.on('close', () => process.exit(0));
