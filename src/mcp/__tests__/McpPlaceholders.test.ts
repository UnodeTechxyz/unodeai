import { describe, it, expect } from 'vitest';
import { resolveServerPlaceholders } from '../McpPlaceholders';
import { MCPServerConfig } from '../../types';

const base: MCPServerConfig = {
  id: 'fs', name: 'Filesystem', transport: 'stdio',
  command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${WORKDIR}'],
  env: { TOKEN: '${GITHUB_TOKEN}' },
};

describe('MCP placeholder substitution (args/url)', () => {
  it('replaces ${WORKDIR} in args with the workspace root', () => {
    const out = resolveServerPlaceholders(base, { WORKDIR: 'C:\\proj' });
    expect(out.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'C:\\proj']);
  });

  it('never touches env (those are secrets resolved elsewhere)', () => {
    const out = resolveServerPlaceholders(base, { WORKDIR: '/x' });
    expect(out.env).toEqual({ TOKEN: '${GITHUB_TOKEN}' });
  });

  it('leaves unknown placeholders untouched (so typos are visible)', () => {
    const out = resolveServerPlaceholders(base, {});
    expect(out.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '${WORKDIR}']);
  });

  it('substitutes in url for http servers', () => {
    const http: MCPServerConfig = { id: 'r', name: 'R', transport: 'streamable-http', url: 'https://h/${WORKDIR}' };
    expect(resolveServerPlaceholders(http, { WORKDIR: 'root' }).url).toBe('https://h/root');
  });

  it('does not mutate the input config', () => {
    const copy = JSON.parse(JSON.stringify(base));
    resolveServerPlaceholders(base, { WORKDIR: '/x' });
    expect(base).toEqual(copy);
  });
});
