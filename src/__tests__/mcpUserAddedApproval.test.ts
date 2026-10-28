import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { approvalKey, needsApproval, shouldRequireApproval } from '../mcp/McpApproval';
import type { MCPServerConfig } from '../types';

/**
 * v0.9.99 B23: the real `approveUserAddedMcpServer` of extension.ts with the real MCP approval rules. Adding a server
 * yourself is its approval; a server from a file, or a changed launch spec, still asks before it mounts.
 */
const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function declaration(name: string): ts.FunctionDeclaration {
  const found: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node); ts.forEachChild(node, visit); };
  visit(source);
  expect(found).toHaveLength(1);
  return found[0];
}
function extensionFunction(name: string, host: object) {
  const code = ts.transpileModule(declaration(name).getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('host', `with (host) { ${code}; return ${name}; }`)(host);
}

const github: MCPServerConfig = { id: 'github', name: 'GitHub', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } };

describe('v0.9.99 B23: adding an MCP server yourself is its approval', () => {
  it('records the approval for this workspace and exact spec, so the mount asks nothing more', async () => {
    const approvedMcp = new Set<string>();
    const saveApprovedMcpServers = vi.fn(async () => {});
    const approve = extensionFunction('approveUserAddedMcpServer', {
      shouldRequireApproval, approvalKey, approvedMcp, workspaceRoot: () => '/workspace', persistence: { saveApprovedMcpServers },
    }) as (cfg: MCPServerConfig) => Promise<void>;
    expect(needsApproval(github, approvedMcp, '/workspace')).toBe(true);
    await approve(github);
    expect(needsApproval(github, approvedMcp, '/workspace')).toBe(false);
    expect(saveApprovedMcpServers).toHaveBeenCalledExactlyOnceWith([approvalKey(github, '/workspace')]);
    // A file that supplies the same id with another command, or the same server in another workspace, still asks.
    expect(needsApproval({ ...github, command: 'curl' }, approvedMcp, '/workspace')).toBe(true);
    expect(needsApproval(github, approvedMcp, '/other-workspace')).toBe(true);
    await approve(github);
    expect(saveApprovedMcpServers).toHaveBeenCalledOnce();
  });

  it('both add flows record the approval before they mount; the mount question itself is unchanged for anything else', () => {
    for (const [name, mount] of [['guidedAddMcpServer', 'mountMcpServer(cfg)'], ['handleMarketplaceInstall', 'reconfigureRegisteredMcp(']] as const) {
      const body = declaration(name).getText(source);
      const approved = body.indexOf('await approveUserAddedMcpServer(cfg);');
      expect(approved, name).toBeGreaterThan(0);
      expect(body.indexOf(mount, approved), name).toBeGreaterThan(approved);
    }
    expect(declaration('performMcpMount').getText(source)).toContain('requestMcpMountApproval(cfg)');
  });
});
