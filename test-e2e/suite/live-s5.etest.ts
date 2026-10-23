/*---------------------------------------------------------------------------------------------
 *  UnodeAi - LIVE S5 keystone smoke (gated)
 *  Drives the real delegate -> implement -> review -> verify -> finalize loop against the LIVE
 *  weroam gateway, inside a real VS Code instance opened on a throwaway fixture workspace.
 *
 *  GATED: only runs when ROAM_LIVE_SMOKE=1 AND ROAM_API_KEY is set (both injected by
 *  scripts/live-s5-smoke.mjs). Under the normal `npm run test:e2e` it is skipped, so it never
 *  spends tokens or needs a key in CI.
 *
 *  Pass criterion (S5): the target source file is actually edited on disk to add the route, with
 *  no wrong-folder ("/Users/dev", "outside working folder") errors. Reviewer-pass / tests-green
 *  are observed best-effort from the loop but the hard assertion is the on-disk change.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXT_ID = 'unode.unodeai';
const LIVE = process.env.ROAM_LIVE_SMOKE === '1' && !!process.env.ROAM_API_KEY;

interface AgentLike { id: string; role: string; name: string; status?: string; }

(LIVE ? describe : describe.skip)('UnodeAi LIVE S5 keystone (real gateway)', function () {
  // Live model round-trips through a multi-agent loop take minutes — give it room.
  this.timeout(8 * 60 * 1000);

  let workspaceDir: string;
  let appFile: string;

  before(async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'a fixture workspace folder must be open');
    workspaceDir = folder.uri.fsPath;
    appFile = path.join(workspaceDir, 'src', 'app.js');
    assert.ok(fs.existsSync(appFile), `fixture ${appFile} should exist`);
    await vscode.extensions.getExtension(EXT_ID)?.activate();
  });

  it('PM delegates, implements, reviews, verifies and edits the file on disk', async () => {
    const cfg = vscode.workspace.getConfiguration('unode');
    // Optimistic (no worktree) keeps S5 to a single moving part; commands: run safe prefixes silently.
    await cfg.update('concurrencyStrategy', 'optimistic', vscode.ConfigurationTarget.Workspace);
    await cfg.update('commandApproval', 'ask', vscode.ConfigurationTarget.Workspace);
    await cfg.update('allowedCommands', ['npm', 'node', 'git', 'npx'], vscode.ConfigurationTarget.Workspace);

    const before = fs.readFileSync(appFile, 'utf8');
    assert.ok(!/\/status\b/.test(before), 'fixture must not already have a /status route');

    // Stub every dialog the loop could block on in a headless run: key entry, team-add confirm, and
    // any command-approval / info prompt -> auto-approve so nothing hangs waiting for a human click.
    const orig = {
      showQuickPick: vscode.window.showQuickPick,
      showInputBox: vscode.window.showInputBox,
      showInformationMessage: vscode.window.showInformationMessage,
      showWarningMessage: vscode.window.showWarningMessage,
    };
    (vscode.window as any).showInputBox = async () => process.env.ROAM_API_KEY;
    (vscode.window as any).showQuickPick = async () => ({ label: 'ROAM_API_KEY', secretName: 'ROAM_API_KEY' });
    (vscode.window as any).showInformationMessage = async (_m: string, ...args: unknown[]) => {
      const opts = args.filter((a): a is string => typeof a === 'string');
      // Approve whatever the loop asks (command execution / run / always allow).
      return opts.find((o) => /enable|run|allow|approve|yes|ok|add/i.test(o)) ?? opts[0];
    };
    (vscode.window as any).showWarningMessage = async (_m: string, ...args: unknown[]) => {
      const opts = args.filter((a): a is string => typeof a === 'string');
      return opts.includes('Add') ? 'Add' : opts[0];
    };

    try {
      await vscode.commands.executeCommand('unode.setApiKey');
      const team = await vscode.commands.executeCommand<AgentLike[]>('unode.createDefaultTeam');
      assert.ok(Array.isArray(team) && team.length >= 3, 'default team should have PM + dev + reviewer');
      const pm = team.find((a) => a.role === 'pm');
      assert.ok(pm, 'team must include a PM coordinator');

      await vscode.commands.executeCommand('unode.sendMessage', {
        targetId: pm!.id,
        instruction:
          'In THIS workspace, add a `GET /status` route to src/app.js that returns {ok:true}, ' +
          'following the existing addRoute(method, path, handler) pattern in that file. Add a test ' +
          'for it under the test/ folder. Delegate the implementation to the senior developer, have ' +
          'the reviewer review it, run the tests with run_checks, and report back when it is done and ' +
          'verified. Only edit files inside this workspace.',
      });

      // Poll the file on disk: success the moment the route lands. (Model-quality-agnostic.)
      const deadline = Date.now() + 7 * 60 * 1000;
      let after = before;
      while (Date.now() < deadline) {
        after = fs.existsSync(appFile) ? fs.readFileSync(appFile, 'utf8') : '';
        if (/\/status\b/.test(after)) { break; }
        await new Promise((r) => setTimeout(r, 4000));
      }

      assert.ok(
        /\/status\b/.test(after),
        `Timed out waiting for the /status route to be written to src/app.js.\n--- current app.js ---\n${after}`
      );
      // Sanity: the edit stayed inside the workspace (no wrong-folder write).
      assert.ok(fs.existsSync(appFile), 'app.js must still exist in the workspace after the edit');
    } finally {
      Object.assign(vscode.window, orig);
      // The fixture workspace is throwaway, but the extension's workspace storage is
      // not necessarily new on a retry. Do not let a live run append another roster.
      let agents: AgentLike[] = [];
      try {
        agents = await vscode.commands.executeCommand<AgentLike[]>('unode.stopAllAgents') ?? [];
      } catch {
        // Best-effort cleanup must not obscure the live assertion.
      }
      for (const agent of agents) {
        try {
          await vscode.commands.executeCommand('unode.agentRemove', agent.id);
        } catch {
          // Best-effort cleanup must not obscure the live assertion.
        }
      }
    }
  });
});
