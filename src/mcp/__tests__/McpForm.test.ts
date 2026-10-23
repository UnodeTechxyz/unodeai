import { describe, expect, it } from 'vitest';
import { isValidMcpUrl, parseMcpArgs, parseMcpEnvInput, validateMcpEnvValue } from '../McpForm';

describe('MCP guided form validation', () => {
  it('accepts only http and https URLs', () => {
    expect(isValidMcpUrl('https://example.com/mcp')).toBe(true);
    expect(isValidMcpUrl('http://localhost:3000/sse')).toBe(true);
    expect(isValidMcpUrl('ftp://example.com/mcp')).toBe(false);
    expect(isValidMcpUrl('not a url')).toBe(false);
  });

  it('requires env values to be SecretStorage placeholders', () => {
    expect(validateMcpEnvValue('${GITHUB_TOKEN}')).toBeNull();
    expect(validateMcpEnvValue('ghp_literal_secret')).toContain('placeholder');
    expect(validateMcpEnvValue('')).toContain('placeholder');
  });

  it('parses placeholder env pairs and rejects literals', () => {
    expect(parseMcpEnvInput('GITHUB_TOKEN=${GITHUB_TOKEN}; API_KEY=${API_KEY}')).toEqual({
      ok: true,
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', API_KEY: '${API_KEY}' },
    });
    expect(parseMcpEnvInput('GITHUB_TOKEN=ghp_literal_secret')).toEqual({
      ok: false,
      error: 'GITHUB_TOKEN: Use a placeholder like ${MY_SECRET}; do not enter a literal secret.',
    });
  });

  it('space-splits stdio args', () => {
    expect(parseMcpArgs('-y @modelcontextprotocol/server-filesystem ${WORKDIR}')).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '${WORKDIR}',
    ]);
    expect(parseMcpArgs('   ')).toBeUndefined();
  });
});
