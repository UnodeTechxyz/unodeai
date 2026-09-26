import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectRepositoryCliConfig,
  repositoryCliTrustMatches,
  repositoryCliTrustRecord,
  workspaceRootForCliCwd,
} from '../RepositoryCliConfig';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'unode-repo-cli-'));
  roots.push(root);
  return root;
}

function inspect(kind: 'claude' | 'codex', workspaceRoot: string, cwd: string, ancestorBoundary = workspaceRoot) {
  return inspectRepositoryCliConfig(kind, workspaceRoot, cwd, {
    homeDirectory: path.dirname(ancestorBoundary),
    ancestorBoundary,
  });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('repository CLI configuration boundary', () => {
  it('uses exact presence checks and produces no configuration digest work for an ordinary repository', () => {
    const root = fixture();
    const nested = path.join(root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(root, 'not-.mcp.json'), '{"mcpServers":{"ignored":{}}}');

    const claude = inspect('claude', root, nested);
    const codex = inspect('codex', root, nested);
    expect(claude).toMatchObject({ present: false, configPaths: [], summary: [], blockedLinks: [] });
    expect(codex).toMatchObject({ present: false, configPaths: [], summary: [], blockedLinks: [] });
  });

  it('binds approval to the canonical workspace, actual cwd, CLI kind, and all configuration bytes', () => {
    const root = fixture();
    const nested = path.join(root, 'packages', 'app');
    mkdirSync(path.join(root, '.claude', 'skills', 'review'), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'node' } } }));
    writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [] } }));
    writeFileSync(path.join(root, '.claude', 'skills', 'review', 'SKILL.md'), 'review carefully');

    const before = inspect('claude', root, nested);
    const record = repositoryCliTrustRecord(before, 'native', new Date('2026-09-21T00:00:00Z'));
    expect(before.present).toBe(true);
    expect(before.summary).toEqual(expect.arrayContaining([
      'MCP server: docs',
      'Hook group: SessionStart',
      'Claude project skill: review',
    ]));
    expect(repositoryCliTrustMatches(record, before)).toBe(true);

    writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: ['changed'] } }));
    const after = inspect('claude', root, nested);
    expect(after.digest).not.toBe(before.digest);
    expect(repositoryCliTrustMatches(record, after)).toBe(false);
    expect(repositoryCliTrustMatches(record, inspect('claude', root, root))).toBe(false);
    expect(repositoryCliTrustMatches(record, inspect('codex', root, nested))).toBe(false);
  });

  it('names Codex automatic features without exposing their values', () => {
    const root = fixture();
    mkdirSync(path.join(root, '.codex'), { recursive: true });
    writeFileSync(path.join(root, '.codex', 'config.toml'), [
      'notify = ["secret-program", "secret-argument"]',
      '[mcp_servers.github]',
      'command = "secret-command"',
      '[hooks.SessionStart]',
    ].join('\n'));
    const inspected = inspect('codex', root, root);
    expect(inspected.summary).toEqual(expect.arrayContaining([
      'MCP server: github',
      'Notification command',
      'Hook or plugin configuration',
    ]));
    expect(inspected.summary.join('\n')).not.toContain('secret-');
  });

  it('records but never follows a linked configuration directory', () => {
    const root = fixture();
    const outside = fixture();
    writeFileSync(path.join(outside, 'config.toml'), 'notify = ["outside-secret"]');
    try {
      symlinkSync(outside, path.join(root, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const inspected = inspect('codex', root, root);
    expect(inspected.present).toBe(true);
    expect(inspected.blockedLinks).toEqual(['.codex']);
    expect(inspected.summary).toEqual([]);
  });

  it('discovers executable CLI configuration above an opened repository subfolder', () => {
    const boundary = fixture();
    const repository = path.join(boundary, 'repo');
    const openedSubfolder = path.join(repository, 'packages', 'app');
    mkdirSync(path.join(repository, '.git'), { recursive: true });
    mkdirSync(path.join(repository, '.codex'), { recursive: true });
    mkdirSync(openedSubfolder, { recursive: true });
    writeFileSync(path.join(repository, '.codex', 'config.toml'), [
      '[mcp_servers.root_codex]',
      'command = "node"',
    ].join('\n'));
    writeFileSync(path.join(repository, '.mcp.json'), JSON.stringify({
      mcpServers: { root_claude: { command: 'node' } },
    }));

    const codex = inspect('codex', openedSubfolder, openedSubfolder, boundary);
    const claude = inspect('claude', openedSubfolder, openedSubfolder, boundary);
    expect(codex.summary).toContain('MCP server: root_codex');
    expect(claude.summary).toContain('MCP server: root_claude');
    expect(codex.configPaths).toContain('../../.codex');
    expect(claude.configPaths).toContain('../../.mcp.json');
  });

  it('keeps user CLI directories out of repository inspection while covering Claude ancestor MCP files', () => {
    const boundary = fixture();
    const userHome = path.join(boundary, 'home');
    const workspace = path.join(userHome, 'projects', 'repo', 'package');
    mkdirSync(path.join(userHome, '.codex'), { recursive: true });
    mkdirSync(path.join(userHome, '.claude'), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(userHome, '.codex', 'config.toml'), 'notify = ["must-not-be-read"]');
    writeFileSync(path.join(userHome, '.claude', 'settings.json'), '{"hooks":{"SessionStart":["must-not-be-read"]}}');
    writeFileSync(path.join(userHome, '.mcp.json'), JSON.stringify({
      mcpServers: { home_ancestor: { command: 'node' } },
    }));

    const options = { homeDirectory: userHome, ancestorBoundary: boundary };
    const codex = inspectRepositoryCliConfig('codex', workspace, workspace, options);
    const claude = inspectRepositoryCliConfig('claude', workspace, workspace, options);
    expect(codex.present).toBe(false);
    expect(claude.summary).toContain('MCP server: home_ancestor');
    expect([...codex.configPaths, ...claude.configPaths]).not.toEqual(expect.arrayContaining([
      expect.stringContaining('.codex'),
      expect.stringContaining('.claude'),
    ]));
  });

  it('shows the executable basename of each declared hook without exposing arguments', () => {
    const root = fixture();
    mkdirSync(path.join(root, '.claude'), { recursive: true });
    writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '"C:\\Program Files\\nodejs\\node.exe" secret.js --token hidden' }] }],
      },
    }));
    const inspected = inspect('claude', root, root);
    expect(inspected.summary).toEqual(expect.arrayContaining([
      'Hook group: SessionStart',
      'Hook command: node.exe',
    ]));
    expect(inspected.summary.join('\n')).not.toContain('secret.js');
    expect(inspected.summary.join('\n')).not.toContain('hidden');
  });

  it('binds a multi-root CLI agent to the most specific workspace folder containing its cwd', () => {
    const root = fixture();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const nested = path.join(second, 'packages', 'app');
    mkdirSync(first, { recursive: true });
    mkdirSync(nested, { recursive: true });
    expect(workspaceRootForCliCwd([first, second], nested)).toBe(second);
    expect(workspaceRootForCliCwd([first, second, path.join(second, 'packages')], nested))
      .toBe(path.join(second, 'packages'));
    expect(workspaceRootForCliCwd([first, second], root)).toBeUndefined();
  });
});
