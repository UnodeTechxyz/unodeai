'use strict';
// A fake `claude` program for the activation-level Claude flows: `node fakeClaudeRelay.cjs <port> <claude args...>`.
// It prints a version for `--version`, and ends at once for the CLI check's own session (a `--settings` file under
// `.unode/claude-probe`), so that background check fails as it does for a program that does not answer it. An agent's
// `-p` session is relayed to the test over a loopback socket: the first line says which process it is, every stdin line
// the extension writes follows unchanged, and every line the test sends back is written to stdout, as the CLI's
// stream-json events. The test plays the CLI. The process ends when its socket closes or it is stopped.
const net = require('node:net');

const [port, ...args] = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('2.1.318 (Claude Code)\n');
  process.exit(0);
}
if (!args.includes('-p') || args.some((arg) => arg.includes('claude-probe'))) {
  process.exit(0);
}
const socket = net.connect(Number(port), '127.0.0.1');
socket.setNoDelay(true);
socket.write(`${JSON.stringify({ hello: { pid: process.pid, argv: args, cwd: process.cwd() } })}\n`);
process.stdin.on('data', (chunk) => socket.write(chunk));
socket.on('data', (chunk) => process.stdout.write(chunk));
socket.on('close', () => process.exit(0));
socket.on('error', () => process.exit(1));
