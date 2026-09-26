import { describe, it, expect } from 'vitest';
import {
  buildClaudeMcpConfig, buildTeamBridgeConfig, createClaudeBridgeIds, isClaudeBridgeServerId,
  managedMcpServerIdFromToolName,
} from '../ClaudeMcpConfig';
import { MCPServerConfig } from '../../types';

describe('buildClaudeMcpConfig', () => {
  it('creates unpredictable per-session identities for all extension-owned bridges', () => {
    const ids = createClaudeBridgeIds(() => Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
    expect(ids).toEqual({
      team: 'unode_team_bridge_00112233445566778899aabbccddeeff',
      permission: 'unode_permission_00112233445566778899aabbccddeeff',
      files: 'unode_files_00112233445566778899aabbccddeeff',
      integrations: 'unode_integrations_00112233445566778899aabbccddeeff',
      skillActions: 'unode_skill_actions_00112233445566778899aabbccddeeff',
    });
    expect(isClaudeBridgeServerId(ids.integrations, 'integrations')).toBe(true);
    expect(isClaudeBridgeServerId('unode_integrations', 'integrations')).toBe(false);
    expect(isClaudeBridgeServerId('unode_integrations_00112233', 'integrations')).toBe(false);
  });

  it('attributes Claude managed calls through only an exact opaque integrations bridge', () => {
    const suffix = '00112233445566778899aabbccddeeff';
    const exactBridge = `unode_integrations_${suffix}`;
    const otherBridge = 'unode_integrations_ffeeddccbbaa99887766554433221100';
    const servers = ['github', 'docs'];
    expect(managedMcpServerIdFromToolName(
      `mcp__${exactBridge}__github__create_pr`,
      servers,
      exactBridge,
    )).toBe('github');
    expect(managedMcpServerIdFromToolName(
      `mcp__${otherBridge}__github__create_pr`,
      servers,
      exactBridge,
    )).toBeUndefined();
    expect(managedMcpServerIdFromToolName(`mcp__${exactBridge}__github__create_pr`, servers)).toBeUndefined();
    expect(managedMcpServerIdFromToolName('docs__lookup', servers, exactBridge)).toBe('docs');
    expect(managedMcpServerIdFromToolName('mcp__docs__lookup', servers, exactBridge)).toBe('docs');
    expect(managedMcpServerIdFromToolName(
      'mcp__unode_integrations__github__create_pr',
      servers,
      exactBridge,
    )).toBeUndefined();
    expect(managedMcpServerIdFromToolName(
      'mcp__unode_integrations_00112233__github__create_pr',
      servers,
      exactBridge,
    )).toBeUndefined();
  });
  it('returns undefined when there are no servers (caller omits --mcp-config)', () => {
    expect(buildClaudeMcpConfig([])).toBeUndefined();
  });

  it('builds a stdio server spec with args and env (env keeps ${VAR}, no secrets on disk)', () => {
    const servers: MCPServerConfig[] = [
      {
        id: 'github',
        name: 'GitHub',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' },
      },
    ];
    expect(buildClaudeMcpConfig(servers)).toEqual({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' },
        },
      },
    });
  });

  it('builds http/sse server specs from url', () => {
    const servers: MCPServerConfig[] = [
      { id: 'remote', name: 'Remote', transport: 'streamable-http', url: 'https://mcp.example/h' },
      { id: 'legacy', name: 'Legacy', transport: 'sse', url: 'https://mcp.example/sse' },
    ];
    expect(buildClaudeMcpConfig(servers)).toEqual({
      mcpServers: {
        remote: { type: 'http', url: 'https://mcp.example/h' },
        legacy: { type: 'sse', url: 'https://mcp.example/sse' },
      },
    });
  });

  it('builds a local team bridge http config with bearer auth', () => {
    expect(buildTeamBridgeConfig({ port: 43123, token: 'secret-token' })).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:43123/mcp',
      headers: { Authorization: 'Bearer secret-token' },
    });
  });

  it('merges the local team bridge config with user MCP servers', () => {
    const cfg = buildClaudeMcpConfig(
      [{ id: 'github', name: 'GitHub', transport: 'stdio', command: 'npx' }],
      buildTeamBridgeConfig({ port: 43123, token: 'secret-token' })
    );

    expect(cfg).toEqual({
      mcpServers: {
        unode_team_bridge: {
          type: 'http',
          url: 'http://127.0.0.1:43123/mcp',
          headers: { Authorization: 'Bearer secret-token' },
        },
        github: { command: 'npx' },
      },
    });
  });

  it('skips malformed servers (stdio without command, http without url)', () => {
    const servers: MCPServerConfig[] = [
      { id: 'bad1', name: 'bad', transport: 'stdio' },
      { id: 'bad2', name: 'bad', transport: 'streamable-http' },
      { id: 'good', name: 'good', transport: 'stdio', command: 'node' },
    ];
    const cfg = buildClaudeMcpConfig(servers);
    expect(Object.keys(cfg!.mcpServers)).toEqual(['good']);
  });
});
