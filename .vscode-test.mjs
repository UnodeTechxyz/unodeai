// @vscode/test-cli configuration for UnodeAi end-to-end tests (P1#7).
// Runs the compiled E2E suite inside a real VS Code instance.
//
// Usage:
//   npm i            # installs the e2e devDependencies (@vscode/test-cli, mocha, …)
//   npm run test:e2e # compiles test-e2e/ -> out-e2e/ and launches VS Code
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  // A0's opt-in benchmark must launch a fresh extension host without also running every behavioural
  // suite. The default remains the full E2E glob; this is a test-runner selection, never product code.
  files: process.env.UNODE_E2E_FILES ?? 'out-e2e/**/*.etest.js',
  version: 'stable',
  mocha: {
    ui: 'bdd',
    timeout: 60000,
  },
});
