'use strict';
// A fake Codex CLI for the compatibility-check tests: `node fakeCodexCli.cjs <control.json> <codex args...>`.
// It answers `--version`, `login status` and the App Server's JSON-RPC lines as the control file says, and appends
// every fact the tests check (its argv, environment, folder, each message received, the end of its input) to the
// control file's log, one JSON object per line, written synchronously so a killed process loses nothing.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [controlFile, ...args] = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
const log = (event) => fs.appendFileSync(control.log, `${JSON.stringify(event)}\n`);
log({ event: 'start', pid: process.pid, argv: args, env: process.env, cwd: process.cwd() });

if (args[0] === '--version') {
  if (control.versionHang) setInterval(() => undefined, 1000);
  else {
    process.stdout.write(`${control.versionOutput ?? 'codex-cli 0.163.0'}\n`);
    process.exitCode = control.versionExit ?? 0;
  }
} else if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write(`${control.loginOutput ?? 'Logged in using ChatGPT'}\n`);
  process.exitCode = control.loginExit ?? 0;
} else if (args[0] === 'app-server') {
  const server = control.appServer ?? {};
  const setting = (key) => {
    const prefix = `${key}=`;
    const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
  };
  const merge = (base, over) => {
    if (!over || typeof over !== 'object' || Array.isArray(over)) return over;
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    for (const [key, value] of Object.entries(over)) out[key] = merge(out[key], value);
    return out;
  };
  const config = () => merge({
    model_provider: null,
    analytics: { enabled: setting('analytics.enabled') },
    otel: { exporter: setting('otel.exporter') },
    approval_policy: setting('approval_policy'),
    approvals_reviewer: setting('approvals_reviewer'),
    sandbox_mode: setting('sandbox_mode'),
    sandbox_workspace_write: { network_access: setting('sandbox_workspace_write.network_access') },
    apps: { _default: {
      default_tools_approval_mode: setting('apps._default.default_tools_approval_mode'),
      approvals_reviewer: setting('apps._default.approvals_reviewer'),
    } },
  }, server.config ?? {});
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  if (server.spawnChild) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    log({ event: 'child', pid: child.pid });
  }
  if (server.flood) process.stdout.write(`${'x'.repeat(server.flood)}\n`);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      log({ event: 'received', message });
      if (server.hang || message.method === undefined) continue;
      if (message.method === 'initialize') {
        if (server.serverRequest) send({ jsonrpc: '2.0', id: 'server-1', method: 'item/tool/call', params: {} });
        send({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake', codexHome: process.env.CODEX_HOME ?? null } });
      } else if (message.method === 'config/read') {
        if (server.exitOnConfigRead) process.exit(0);
        if (server.configError) send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: server.configError } });
        else send({ jsonrpc: '2.0', id: message.id, result: { config: config(), origins: {}, layers: server.layers ?? [] } });
        if (server.exitAfterConfigRead) setTimeout(() => process.exit(0), 0);
      } else if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, result: {} });
      }
    }
  });
  process.stdin.on('end', () => {
    log({ event: 'stdin-end' });
    // The real App Server exits within moments of its input ending (measured on 0.163.0).
    if (server.exitOnStdinEnd !== false) process.exit(0);
  });
  setInterval(() => undefined, 1000);
} else {
  process.stderr.write(`fake codex: unexpected arguments ${JSON.stringify(args)}\n`);
  process.exitCode = 2;
}
