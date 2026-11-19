'use strict';
// A fake Claude CLI for the CP1 tests: `node fakeClaudeCli.cjs <control.json> <claude args...>`. `--version` prints a
// version. Otherwise it reads the `--settings` file it was given (relative to its folder, as Claude does) and, unless
// the control file says to ignore it, runs each SessionStart hook command through the shell with the hook input on
// stdin, the way Claude does in `-p` stream-json mode before any message. Then it waits until it is stopped. Every
// fact the tests check is appended to the control file's log, one JSON object per line.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [controlFile, ...args] = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
const log = (event) => fs.appendFileSync(control.log, `${JSON.stringify(event)}\n`);
log({ event: 'start', pid: process.pid, argv: args, env: process.env, cwd: process.cwd() });

if (args[0] === '--version') {
  process.stdout.write(`${control.version ?? '2.1.304 (Claude Code)'}\n`);
} else {
  const settingsPath = path.resolve(process.cwd(), args[args.indexOf('--settings') + 1]);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  log({ event: 'settings', settings });
  if (!control.ignoreHooks) {
    for (const group of settings.hooks?.SessionStart ?? []) {
      for (const hook of group.hooks ?? []) {
        const child = spawn(hook.command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('close', (code) => log({ event: 'hook-exit', code, out }));
        child.stdin.end(JSON.stringify({ session_id: 'fake', transcript_path: 'x', cwd: process.cwd(), hook_event_name: 'SessionStart', source: 'startup' }));
      }
    }
  }
  if (control.exitAt !== undefined) setTimeout(() => process.exit(0), control.exitAt);
  process.stdin.on('end', () => log({ event: 'stdin-end' }));
  process.stdin.resume();
  setInterval(() => undefined, 1000);
}
