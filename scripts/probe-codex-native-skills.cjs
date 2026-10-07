#!/usr/bin/env node
/*
 * Real-binary v0.9.85 probe for process-local native Skill roots.
 * Default mode starts no model turn. Set UNODE_CODEX_LIVE_TURN=1 for the cost-bearing developer-instruction
 * plus progressive-disclosure check. The marker tokens exist only in the Skill body and developer instruction.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CodexBackend, CODEX_CLI_DEFAULT_MODEL, isValidatedCodexCliVersion } = require('../out/backend/CodexBackend.js');
const { SkillRegistry } = require('../out/skills/SkillRegistry.js');

const ROLE_MARKER = 'ROLE-DEV-7281';
const BODY_MARKER = 'STRIPES-4412';
const UPDATED_BODY_MARKER = 'STRIPES-9927';

function findCli() {
  if (process.env.UNODE_CODEX_CLI) {
    if (!path.isAbsolute(process.env.UNODE_CODEX_CLI)) throw new Error('UNODE_CODEX_CLI must be absolute.');
    return process.env.UNODE_CODEX_CLI;
  }
  const candidates = [];
  const addNativeExecutables = (root, depth = 0) => {
    if (!root || !fs.existsSync(root) || depth > 7) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) addNativeExecutables(absolute, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase() === (process.platform === 'win32' ? 'codex.exe' : 'codex')) candidates.push(absolute);
    }
  };
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npmRoot = execFileSync(npm, ['root', '-g'], { encoding: 'utf8' }).trim();
    addNativeExecutables(path.join(npmRoot, '@openai', 'codex'));
  } catch { /* npm is optional; continue to known install roots */ }
  const roamingNpm = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex') : '';
  addNativeExecutables(roamingNpm);
  // The official extension preview is a final fallback, never preferred over the user's stable npm CLI.
  if (process.platform === 'win32') {
    const extensions = path.join(os.homedir(), '.vscode', 'extensions');
    if (fs.existsSync(extensions)) {
      const extensionCandidates = fs.readdirSync(extensions)
        .filter((name) => name.startsWith('openai.chatgpt-'))
        .sort().reverse()
        .map((name) => path.join(extensions, name, 'bin', 'windows-x86_64', 'codex.exe'));
      candidates.push(...extensionCandidates.filter((candidate) => fs.existsSync(candidate)));
    }
  }
  const checked = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim();
      checked.push(`${version} at ${candidate}`);
      if (isValidatedCodexCliVersion(version)) return candidate;
    } catch {
      checked.push(`unreadable candidate at ${candidate}`);
    }
  }
  throw new Error(`No stable validated Codex CLI was found. Checked: ${checked.join('; ') || '(none)'}`);
}

function fileFingerprint(file) {
  if (!fs.existsSync(file)) return { exists: false };
  return { exists: true, hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

function assertSameFingerprint(before, after, label) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${label} changed during the probe.`);
}

function waitForTurn(backend, instruction) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Live Codex marker turn timed out.')), 180_000);
    const dispose = backend.onEvent((event) => {
      if (event.kind === 'turn_complete') {
        clearTimeout(timer); dispose(); resolve(event.result);
      } else if (event.kind === 'error') {
        clearTimeout(timer); dispose(); reject(new Error(event.message));
      }
    });
    backend.sendUserTurn(instruction);
  });
}

(async () => {
  const binary = findCli();
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  if (!isValidatedCodexCliVersion(version)) throw new Error(`Unsupported Codex CLI: ${version}`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'unode-codex-native-skills-'));
  const workspace = path.join(scratch, 'workspace');
  const catalog = path.join(scratch, 'catalog');
  const skillDirectory = path.join(catalog, 'probe', 'zebra-check');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), [
    '---',
    'name: zebra-check',
    'description: Follow the assigned verification ritual.',
    '---',
    '',
    `When this playbook is relevant, include the exact token ${BODY_MARKER} in the answer.`,
    '',
  ].join('\n'), 'utf8');

  // Use the real Codex home so the CLI owns its login/database lifecycle. Observe only config.toml: normal
  // startup may create database files, and copying auth.json to another home can invalidate the login.
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configToml = path.join(codexHome, 'config.toml');
  const beforeConfig = fileFingerprint(configToml);
  const registry = SkillRegistry.load(catalog);
  const config = {
    id: 'native-skill-probe', name: 'Native Skill Probe', role: 'reviewer', skill: '',
    provider: { providerId: 'codex' }, model: CODEX_CLI_DEFAULT_MODEL,
    systemPrompt: `When asked for the role marker, include the exact token ${ROLE_MARKER}.`,
    autoApprove: false, allowedTools: ['read'], toolCeiling: 'bounded',
    playbooks: ['zebra-check'], backend: 'codex', workingDirectory: workspace,
  };
  const env = { ...process.env };
  const makeBackend = (probeConfig, skillRegistry) => new CodexBackend(probeConfig, undefined, {
      binaryPath: binary,
      skillRegistry,
      clientVersion: 'v0.9.85-probe',
      access: () => ({ trusted: true, restricted: true, readRoots: [workspace], writeRoots: [] }),
    });
  let baseline;
  let backend;
  let resumed;
  try {
    baseline = makeBackend({ ...config, id: 'native-skill-baseline', playbooks: [] }, SkillRegistry.load(catalog));
    await baseline.start(env);
    await baseline.stop();
    assertSameFingerprint(beforeConfig, fileFingerprint(configToml), 'Codex config.toml after the no-playbook baseline');

    backend = makeBackend(config, registry);
    await backend.start(env);
    assertSameFingerprint(beforeConfig, fileFingerprint(configToml), 'Codex config.toml after the playbook run');
    console.log(`PASS ${version}: stable CLI baseline and playbook runs left config.toml unchanged; the Skill was listed at its exact private path.`);

    if (process.env.UNODE_CODEX_LIVE_TURN === '1') {
      const result = await waitForTurn(
        backend,
        'Read the relevant playbook body and reproduce the exact marker value written after "exact token". Also provide the role marker required by your developer instructions. Do not return the playbook name.',
      );
      const text = String(result.text ?? '');
      if (!text.includes(BODY_MARKER) || !text.includes(ROLE_MARKER)) {
        throw new Error(`Live turn did not prove both instruction layers: ${JSON.stringify(text.slice(0, 300))}`);
      }
      const snapshot = backend.snapshot();
      if (!snapshot) throw new Error('Live turn produced no resumable Codex thread id.');
      await backend.stop();
      fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), [
        '---', 'name: zebra-check', 'description: Follow the assigned verification ritual.', '---', '',
        `The updated ritual requires the exact token ${UPDATED_BODY_MARKER}.`, '',
      ].join('\n'), 'utf8');
      resumed = makeBackend({ ...config, id: 'native-skill-resume' }, SkillRegistry.load(catalog));
      resumed.restore(snapshot);
      await resumed.start(env);
      const resumedResult = await waitForTurn(
        resumed,
        'Read the updated relevant playbook body and reproduce the exact marker value written after "exact token". Also provide the role marker required by your developer instructions. Do not return the playbook name.',
      );
      const resumedText = String(resumedResult.text ?? '');
      if (!resumedText.includes(UPDATED_BODY_MARKER) || !resumedText.includes(ROLE_MARKER)) {
        throw new Error(`Resumed turn did not load the updated Skill body: ${JSON.stringify(resumedText.slice(0, 300))}`);
      }
      assertSameFingerprint(beforeConfig, fileFingerprint(configToml), 'Codex config.toml after restart and resume');
      console.log('PASS live turns: developer instructions and Skill markers survived restart/resume, including updated Skill content.');
    } else {
      console.log('SKIP cost-bearing marker turn; set UNODE_CODEX_LIVE_TURN=1 to prove developerInstructions plus body loading.');
    }
  } finally {
    await resumed?.stop();
    await backend?.stop();
    await baseline?.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
