// @vscode/test-cli configuration for UnodeAi end-to-end tests (P1#7).
// Runs the compiled E2E suite inside a real VS Code instance.
//
// Usage:
//   npm i            # installs the e2e devDependencies (@vscode/test-cli, mocha, …)
//   npm run test:e2e # compiles test-e2e/ -> out-e2e/ and launches VS Code
import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaceFolder = mkdtempSync(join(tmpdir(), 'unode-e2e-workspace-'));
process.once('exit', () => {
  rmSync(workspaceFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const mocha = {
  ui: 'bdd',
  timeout: 60000,
};

const selectedFiles = process.env.UNODE_E2E_FILES?.trim();
const workspaceRun = {
  label: 'workspace',
  // A0's opt-in benchmark must launch a fresh extension host without also running every behavioural
  // suite. The default remains the full E2E glob; this is a test-runner selection, never product code.
  files: selectedFiles || 'out-e2e/**/*.etest.js',
  version: 'stable',
  workspaceFolder,
  mocha,
};

export default defineConfig(selectedFiles
  ? workspaceRun
  : [
      workspaceRun,
      {
        label: 'folderless-workspace-refusal',
        files: 'out-e2e/suite/extension.etest.js',
        version: 'stable',
        mocha: {
          ...mocha,
          grep: 'refuses the workspace-bound PDF attachment action when no folder is open',
        },
      },
    ]);
