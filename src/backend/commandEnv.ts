/*---------------------------------------------------------------------------------------------
 *  UnodeAi - commandEnv
 *  When an agent runs a shell command via run_command, the extension spawns it as a child of the
 *  VS Code EXTENSION HOST. That host's environment carries VS Code / Electron injections — most
 *  damagingly `NODE_OPTIONS` (e.g. `--require .../bootstrap`, `--inspect`) and `ELECTRON_RUN_AS_NODE`.
 *  Inherited by a child Node toolchain they break it: e.g. vitest spawns a worker pool, every worker
 *  re-applies the inspector NODE_OPTIONS, the workers die, and vitest reports "No test suite found in
 *  file" for EVERY file (the exact failure agents hit when running `npm test`).
 *
 *  This strips those host-only vars so `npm test` / build tools run as they would in a normal
 *  terminal. Pure + injectable (takes a base env) so it's unit-testable without VS Code.
 *--------------------------------------------------------------------------------------------*/

/**
 * Return a copy of `base` with VS Code / Electron host-only variables removed, so a spawned command
 * (and its child Node workers) runs in a clean, terminal-like environment.
 */
export function sanitizedCommandEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };

  // Electron-as-node flag — meaningless/confusing for a normal child Node process.
  delete env.ELECTRON_RUN_AS_NODE;

  // VS Code injects NODE_OPTIONS for the extension host (debugger `--inspect`, a vscode/electron
  // bootstrap `--require`). Inherited by child Node it can poison tooling. Drop it ONLY when it
  // looks VS Code/inspector-injected — a user's deliberate NODE_OPTIONS (e.g. `--require
  // ts-node/register`, `--max-old-space-size=4096`) is preserved.
  if (env.NODE_OPTIONS && /--inspect|vscode|electron/i.test(env.NODE_OPTIONS)) {
    delete env.NODE_OPTIONS;
  }

  // Other VS Code / Electron host vars that can leak into and confuse child processes.
  for (const key of Object.keys(env)) {
    if (/^(VSCODE_|ELECTRON_)/.test(key)) {
      delete env[key];
    }
  }

  return env;
}
