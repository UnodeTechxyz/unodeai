/**
 * Integration test: WorktreeCoordinator driving the REAL WorktreeManager + GitMergeOrchestrator
 * against actual git in a throwaway repo. This validates the end-to-end worktree fan-out git
 * mechanics (isolate → commit → merge to integration → finalize → conflict feedback) that the
 * fakes-based unit tests don't — leaving only the VS Code extension-host wiring for a manual smoke.
 */

import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { AgentConfig } from '../../types';
import { WorktreeManager } from '../WorktreeManager';
import { GitMergeOrchestrator } from '../MergeOrchestrator';
import { WorktreeCoordinator, WorktreeCoordinatorDeps } from '../WorktreeCoordinator';
import { Verifier } from '../Verifier';

async function tempRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-wtc-'));
  const git = (args: string[]) => spawnSync('git', args, { cwd: root });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(root, 'base.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return root;
}

function show(root: string, ref: string): { code: number; out: string } {
  const r = spawnSync('git', ['show', ref], { cwd: root, encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout ?? '' };
}

function cfg(id: string): AgentConfig {
  return {
    id, name: id, role: 'developer', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'K' },
    model: 'm', systemPrompt: '', autoApprove: false, allowedTools: [],
  };
}

function coordinatorFor(root: string, over: Partial<WorktreeCoordinatorDeps> = {}) {
  const notifyAgent = vi.fn();
  const deps: WorktreeCoordinatorDeps = {
    manager: new WorktreeManager(root),
    orchestrator: new GitMergeOrchestrator(root),
    isEnabled: () => true,
    autoMerge: () => false,
    maxParallel: () => 4,
    isEligible: () => true,
    log: () => undefined,
    notifyAgent,
    ...over,
  };
  return { coord: new WorktreeCoordinator(deps), notifyAgent, deps };
}

describe('worktree fan-out — end-to-end against real git', () => {
  it('isolates an agent, merges its work to integration, and finalizes to base', async () => {
    const root = await tempRepo();
    const { coord } = coordinatorFor(root);

    // 1. Isolate the agent in its own worktree.
    const wtPath = await coord.assignWorkingDirectory(cfg('dev1'));
    expect(wtPath).toBeTruthy();
    expect((await fs.stat(wtPath!)).isDirectory()).toBe(true);

    // 2. The agent does work in its worktree.
    await fs.writeFile(path.join(wtPath!, 'feature.txt'), 'agent one work\n');

    // 3. Turn completes → commit + merge into unode/integration.
    await coord.onTurnComplete('dev1', false);
    const inIntegration = show(root, 'unode/integration:feature.txt');
    expect(inIntegration.code).toBe(0);
    expect(inIntegration.out).toContain('agent one work');
    // Base is untouched until finalize.
    expect(show(root, 'main:feature.txt').code).not.toBe(0);

    // 4. Finalize → base advances to include the work.
    const result = await coord.finalize();
    expect(result.status).toBe('merged');
    const inBase = show(root, 'main:feature.txt');
    expect(inBase.code).toBe(0);
    expect(inBase.out).toContain('agent one work');
    // Regression guard (the 0.6.9 bug): finalize must MATERIALIZE the file in the working tree,
    // not just advance the ref — no manual `git reset --hard` required.
    expect((await fs.readFile(path.join(root, 'feature.txt'), 'utf8'))).toContain('agent one work');

    await fs.rm(root, { recursive: true, force: true });
  }, 30_000); // real-git: many spawns (init/worktree add/merge) — slow on Windows under parallel load

  it('merges two agents touching different files into one integration', async () => {
    const root = await tempRepo();
    const { coord } = coordinatorFor(root);

    const p1 = await coord.assignWorkingDirectory(cfg('dev1'));
    const p2 = await coord.assignWorkingDirectory(cfg('dev2'));
    await fs.writeFile(path.join(p1!, 'a.txt'), 'from dev1\n');
    await fs.writeFile(path.join(p2!, 'b.txt'), 'from dev2\n');

    await coord.onTurnComplete('dev1', false);
    await coord.onTurnComplete('dev2', false);

    expect(show(root, 'unode/integration:a.txt').out).toContain('from dev1');
    expect(show(root, 'unode/integration:b.txt').out).toContain('from dev2');

    await fs.rm(root, { recursive: true, force: true });
  }, 30_000); // real-git: many spawns (init/worktree add/merge) — slow on Windows under parallel load

  it('surfaces a conflict to the second agent and leaves integration clean', async () => {
    const root = await tempRepo();
    const { coord, notifyAgent } = coordinatorFor(root);

    // Both agents branch from base and edit the SAME file → the second merge conflicts.
    const p1 = await coord.assignWorkingDirectory(cfg('dev1'));
    const p2 = await coord.assignWorkingDirectory(cfg('dev2'));
    await fs.writeFile(path.join(p1!, 'shared.txt'), 'dev1 version\n');
    await fs.writeFile(path.join(p2!, 'shared.txt'), 'dev2 version\n');

    await coord.onTurnComplete('dev1', false); // clean merge
    await coord.onTurnComplete('dev2', false); // conflicts with dev1's change

    expect(notifyAgent).toHaveBeenCalledWith('dev2', expect.stringContaining('shared.txt'));
    // Integration kept dev1's version and is not left in a conflicted state.
    expect(show(root, 'unode/integration:shared.txt').out).toContain('dev1 version');
    const intStatus = spawnSync('git', ['-C', path.join(root, '.unode', 'worktrees', '_integration'), 'status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    expect((intStatus.stdout ?? '').trim()).toBe(''); // clean — merge was aborted

    await fs.rm(root, { recursive: true, force: true });
  }, 30_000); // real-git: many spawns (init/worktree add/merge) — slow on Windows under parallel load

  it('tears down the worktree on release', async () => {
    const root = await tempRepo();
    const { coord } = coordinatorFor(root);
    const p = await coord.assignWorkingDirectory(cfg('dev1'));
    expect((await fs.stat(p!)).isDirectory()).toBe(true);
    await coord.release('dev1');
    await expect(fs.stat(p!)).rejects.toBeTruthy(); // worktree dir gone
    expect(coord.active()).toHaveLength(0);
    await fs.rm(root, { recursive: true, force: true });
  }, 30_000); // real-git: many spawns (init/worktree add/merge) — slow on Windows under parallel load
});

// v0.7.0 verifier-as-gate: the SAME end-to-end path the live dogfood would exercise, but with a real
// spawned verify command instead of the VS Code GUI — so the gate mechanics are covered automatically
// (only the extension's config-reading + chat feedback glue is left for a human smoke).
describe('verifier-as-gate — end-to-end against real git + a real command', () => {
  // A real, cross-platform verify command committed to base (so every worktree inherits it): exits 0
  // only when feature.txt contains "good". Stands in for `npm test` etc.
  const VERIFY_CMD = 'node verify.js';
  async function repoWithVerify(): Promise<string> {
    const root = await tempRepo();
    await fs.writeFile(
      path.join(root, 'verify.js'),
      "try { process.exit(require('fs').readFileSync('feature.txt','utf8').trim() === 'good' ? 0 : 1); } catch { process.exit(1); }\n"
    );
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-q', '-m', 'add verify'], { cwd: root });
    return root;
  }
  const realVerify = (cwd: string) =>
    new Verifier({
      command: () => VERIFY_CMD,
      run: (command, dir) => {
        const r = spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8' });
        return Promise.resolve({ code: r.status, output: (r.stdout ?? '') + (r.stderr ?? '') });
      },
    }).verify(cwd);

  it('blocks failing work from integration, then merges it once it passes', async () => {
    const root = await repoWithVerify();
    const { coord, notifyAgent } = coordinatorFor(root, { verify: realVerify });

    const wt = await coord.assignWorkingDirectory(cfg('dev1'));

    // 1. Agent writes work that FAILS verification → held off integration, handed back.
    await fs.writeFile(path.join(wt!, 'feature.txt'), 'bad\n');
    await coord.onTurnComplete('dev1', false);
    expect(show(root, 'unode/integration:feature.txt').code).not.toBe(0); // NOT on integration
    expect(coord.verification('dev1')?.status).toBe('failed');
    expect(notifyAgent).toHaveBeenCalledWith('dev1', expect.stringContaining('checks'));

    // 2. Agent fixes it → passes → merges to integration.
    await fs.writeFile(path.join(wt!, 'feature.txt'), 'good\n');
    await coord.onTurnComplete('dev1', false);
    expect(coord.verification('dev1')?.status).toBe('passed');
    expect(show(root, 'unode/integration:feature.txt').out).toContain('good');

    await fs.rm(root, { recursive: true, force: true });
  }, 30_000);

  // Reproduces the exact weak-agent cheat the live dogfood surfaced: break the code AND weaken the
  // test so `node --test` passes — the gate goes green, but the lane must be FLAGGED for review.
  it('flags a lane that passed by editing the test instead of fixing the code', async () => {
    const root = await tempRepo();
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, 'test'));
    await fs.writeFile(path.join(root, 'src', 'math.js'), 'module.exports.add = (a, b) => a + b;\n');
    await fs.writeFile(path.join(root, 'test', 'math.test.js'),
      "const t=require('node:test');const a=require('assert');const {add}=require('../src/math');t('add',()=>a.strictEqual(add(2,2),4));\n");
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-q', '-m', 'app'], { cwd: root });

    const nodeTestVerify = (cwd: string) =>
      new Verifier({
        command: () => 'node --test',
        run: (command, dir) => {
          const r = spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8' });
          return Promise.resolve({ code: r.status, output: (r.stdout ?? '') + (r.stderr ?? '') });
        },
      }).verify(cwd);
    const changedFiles = async (wt: { path: string }) => {
      const r = spawnSync('git', ['diff', '--name-only', 'main...HEAD'], { cwd: wt.path, encoding: 'utf8' });
      return (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    };
    const { coord } = coordinatorFor(root, { verify: nodeTestVerify, changedFiles });

    const wt = await coord.assignWorkingDirectory(cfg('dev1'));
    // Break the code, then weaken the test to match (expect 0) — exactly what the dogfood agent did.
    await fs.writeFile(path.join(wt!, 'src', 'math.js'), 'module.exports.add = (a, b) => a - b;\n');
    await fs.writeFile(path.join(wt!, 'test', 'math.test.js'),
      "const t=require('node:test');const a=require('assert');const {add}=require('../src/math');t('add',()=>a.strictEqual(add(2,2),0));\n");
    await coord.onTurnComplete('dev1', false);

    // The gate goes green (the weakened test passes), so it merges — but it's FLAGGED for review.
    expect(coord.verification('dev1')?.status).toBe('passed');
    expect(coord.verification('dev1')?.touchedTests).toContain('test/math.test.js');

    await fs.rm(root, { recursive: true, force: true });
  }, 30_000);
});
