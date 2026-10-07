import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  parseAgentCatalog,
  parseMcpCatalog,
  parseSkillCatalog,
  loadCatalog,
  mergeCatalogs,
  CatalogValidationError,
  isCatalogVerificationOverdue,
  type CatalogSourceName,
} from '../catalog';
import { SKILL_LIBRARY } from '../../roles/RoleConfig';
import { roleTemplateCatalogEntries } from '../roleTemplateCatalog';

// The canonical builtin skill ids — agents may only reference these (structural backstop).
const KNOWN_SKILLS = new Set(Object.keys(SKILL_LIBRARY));

// repo-root/marketplace/<name>.json — proves the *authored* files parse (catches M3 mistakes in CI).
const MARKET_DIR = resolve(__dirname, '../../../marketplace');
const readBundled = (name: CatalogSourceName): unknown => name === 'agents'
  ? roleTemplateCatalogEntries()
  : JSON.parse(readFileSync(resolve(MARKET_DIR, `${name}.json`), 'utf8'));

describe('marketplace catalog — bundled files', () => {
  it('loads the in-repo catalog and every agent skill id exists in SKILL_LIBRARY', () => {
    // Enforcing knownSkillIds here is the CI backstop: a content author who invents a skill id
    // (e.g. "code-gen" instead of "code-generation") fails this test instead of shipping a broken agent.
    const cat = loadCatalog(readBundled, { knownSkillIds: KNOWN_SKILLS });
    expect(Array.isArray(cat.agents)).toBe(true);
    expect(Array.isArray(cat.mcp)).toBe(true);
    expect(Array.isArray(cat.skills)).toBe(true);
  });

  // The hosted catalog (served from GitHub raw, merged over bundled at runtime) must parse with the same
  // validators — a malformed hosted starter would silently fall back to bundled, so guard it in CI.
  it('the hosted catalog leaves legacy MCP entries quarantined and its active sections parse', () => {
    const raw = JSON.parse(readFileSync(resolve(MARKET_DIR, 'catalog.json'), 'utf8')) as Record<string, unknown>;
    expect(() => parseAgentCatalog(raw.agents, { knownSkillIds: KNOWN_SKILLS })).not.toThrow();
    expect(() => parseMcpCatalog(raw.mcp ?? [])).not.toThrow();
    expect(() => parseSkillCatalog(raw.skills)).not.toThrow();
    expect(raw.mcp).toBeUndefined();
    expect((raw.quarantinedMcpLegacy as Array<{ id: string }>).map((entry) => entry.id)).toContain('github');
  });

  // Regression: "sequential-thinking" shipped with the npm-404 name @modelcontextprotocol/server-
  // sequentialthinking (no hyphens) → npx exited → "MCP error -32000: Connection closed" on mount.
  it('sequential-thinking uses the real hyphenated npm package, and the bad name is gone', () => {
    const mcp = parseMcpCatalog(readBundled('mcp')) as Array<{ id: string; args?: string[] }>;
    const seq = mcp.find((m) => m.id === 'sequential-thinking');
    expect(seq?.args).toContain('@modelcontextprotocol/server-sequential-thinking');
    expect(JSON.stringify(mcp)).not.toContain('server-sequentialthinking'); // the 404 name must not reappear
  });
});

describe('parseAgentCatalog', () => {
  const valid = {
    id: 'dev', name: 'Developer', role: 'developer', summary: 'writes code',
    skills: ['code-generation'], model: 'claude-sonnet-4-20250514', tier: 'standard',
    systemPrompt: 'You write code.',
  };

  it('accepts a valid entry', () => {
    expect(parseAgentCatalog([valid])).toHaveLength(1);
  });
  it('rejects a non-array', () => {
    expect(() => parseAgentCatalog({})).toThrow(CatalogValidationError);
  });
  it('rejects an unknown role', () => {
    expect(() => parseAgentCatalog([{ ...valid, role: 'wizard' }])).toThrow(/role has unsupported value/);
  });
  it('rejects an unknown tier', () => {
    expect(() => parseAgentCatalog([{ ...valid, tier: 'deluxe' }])).toThrow(/tier must be one of/);
  });
  it('rejects duplicate ids', () => {
    expect(() => parseAgentCatalog([valid, valid])).toThrow(/duplicate/);
  });
  it('rejects a missing systemPrompt', () => {
    const { systemPrompt: _omit, ...rest } = valid;
    expect(() => parseAgentCatalog([rest])).toThrow(/systemPrompt/);
  });
  it('rejects an unknown skill id when knownSkillIds is supplied (the backstop)', () => {
    expect(() => parseAgentCatalog([{ ...valid, skills: ['code-gen'] }], { knownSkillIds: KNOWN_SKILLS }))
      .toThrow(/unknown id "code-gen"/);
  });
  it('rejects an agent preset with no skills because it would install without tools', () => {
    expect(() => parseAgentCatalog([{ ...valid, skills: [] }]))
      .toThrow(/skills must include at least one skill id/);
  });
  it('accepts a real skill id under the backstop', () => {
    expect(parseAgentCatalog([{ ...valid, skills: ['code-generation'] }], { knownSkillIds: KNOWN_SKILLS }))
      .toHaveLength(1);
  });
  it('accepts MCP suggestions on an agent preset without creating a grant', () => {
    const parsed = parseAgentCatalog([{ ...valid, suggestedMcpServers: ['hermes-bridge'] }]);
    expect(parsed[0].suggestedMcpServers).toEqual(['hermes-bridge']);
  });
  it('rejects MCP grants from an agent catalog even when shaped correctly', () => {
    expect(() => parseAgentCatalog([{ ...valid, mcpServers: ['ok'] }]))
      .toThrow(/mcpServers is not allowed/);
  });
});

describe('parseMcpCatalog', () => {
  const stdio = {
    id: 'fs', name: 'Filesystem', summary: 'files', transport: 'stdio', command: 'npx',
    args: ['@modelcontextprotocol/server-filesystem'],
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    maintenanceState: 'reference', lastVerified: '2026-09-11',
    installIdentity: { ecosystem: 'npm', value: '@modelcontextprotocol/server-filesystem' },
  };

  it('accepts a valid stdio entry', () => {
    expect(parseMcpCatalog([stdio])).toHaveLength(1);
  });
  it('keeps an overdue entry visible at runtime while marking it for re-verification', () => {
    const overdue = { ...stdio, lastVerified: '2020-01-01' };
    expect(parseMcpCatalog([overdue])).toHaveLength(1);
    expect(isCatalogVerificationOverdue(overdue.lastVerified, Date.parse('2026-09-11T00:00:00Z'))).toBe(true);
  });
  it('accepts a display-only prerequisite hint', () => {
    const parsed = parseMcpCatalog([{ ...stdio, prerequisite: 'uv' }]);
    expect(parsed[0].prerequisite).toBe('uv');
  });
  it('rejects malformed prerequisite hints', () => {
    expect(() => parseMcpCatalog([{ ...stdio, prerequisite: '' }]))
      .toThrow(/prerequisite must be a non-empty string/);
  });
  it('requires command for stdio', () => {
    const { command: _omit, ...rest } = stdio;
    expect(() => parseMcpCatalog([rest])).toThrow(/command is required for stdio/);
  });
  it('requires url or urlPrompt for remote transports', () => {
    expect(() => parseMcpCatalog([{ id: 'r', name: 'R', summary: 's', transport: 'sse' }]))
      .toThrow(/url or .*urlPrompt is required for remote/);
  });
  it('accepts an install-time URL prompt for remote transports', () => {
    expect(parseMcpCatalog([{
      id: 'hermes-bridge',
      name: 'Hermes Bridge',
      summary: 'Connect a local bridge.',
      transport: 'streamable-http',
      urlPrompt: {
        title: 'Hermes Bridge MCP URL',
        prompt: 'Enter the MCP endpoint exposed by your Hermes bridge.',
        placeHolder: 'http://127.0.0.1:8765/mcp',
      },
      source: 'https://example.com/hermes',
      maintenanceState: 'community',
      lastVerified: '2026-09-11',
      installIdentity: { ecosystem: 'endpoint', value: 'https://example.com/hermes' },
    }])).toHaveLength(1);
  });

  it('requires a fixed remote identity to match its configured endpoint', () => {
    const remote = {
      id: 'exa', name: 'Exa', summary: 'Search', transport: 'streamable-http',
      url: 'https://mcp.exa.ai/mcp', source: 'https://exa.ai/docs/reference/exa-mcp',
      maintenanceState: 'maintained', lastVerified: '2026-09-11',
      installIdentity: { ecosystem: 'endpoint', value: 'https://mcp.exa.ai/mcp' },
    };
    expect(parseMcpCatalog([remote])).toHaveLength(1);
    expect(() => parseMcpCatalog([{
      ...remote,
      installIdentity: { ecosystem: 'endpoint', value: remote.source },
    }])).toThrow(/configured endpoint/);
  });
  it('validates URL prompt shape', () => {
    expect(() => parseMcpCatalog([{
      id: 'bad-remote',
      name: 'Bad Remote',
      summary: 's',
      transport: 'streamable-http',
      urlPrompt: { title: 'Missing prompt' },
    }])).toThrow(/urlPrompt.prompt/);
  });

  it.each([
    ['archived source', { ...stdio, source: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/fs' }, /archived/],
    ['missing provenance', { ...stdio, source: undefined }, /authoritative URL/],
    ['missing maintenance', { ...stdio, maintenanceState: undefined }, /maintenanceState/],
    ['deprecated installable entry', { ...stdio, maintenanceState: 'deprecated' }, /maintenanceState/],
    ['unknown schema data', { ...stdio, surpriseAuthority: true }, /not supported/],
    ['mismatched identity', { ...stdio, installIdentity: { ecosystem: 'npm', value: 'different-package' } }, /exactly match/],
    ['mutable npm tag', { ...stdio, args: ['example@latest'], installIdentity: { ecosystem: 'npm', value: 'example@latest' } }, /mutable @latest/],
    ['malformed placeholder', { ...stdio, args: ['@modelcontextprotocol/server-filesystem', '${workdir}'] }, /malformed placeholder/],
  ])('kills the planted %s failure', (_name, entry, expected) => {
    expect(() => parseMcpCatalog([entry])).toThrow(expected as RegExp);
  });
});

describe('parseSkillCatalog', () => {
  const skill = { id: 'rev', name: 'Review', summary: 's', category: 'development', capabilities: ['read'] };

  it('accepts a valid entry', () => {
    expect(parseSkillCatalog([skill])).toHaveLength(1);
  });
  it('rejects an unknown category', () => {
    expect(() => parseSkillCatalog([{ ...skill, category: 'wizardry' }])).toThrow(/category/);
  });
});

describe('mergeCatalogs', () => {
  it('overrides win on id collision', () => {
    const base = { agents: [{ id: 'a', name: 'Base' }], mcp: [], skills: [] } as never;
    const over = { agents: [{ id: 'a', name: 'Over' }], mcp: [], skills: [] } as never;
    const merged = mergeCatalogs(base, over);
    expect(merged.agents).toHaveLength(1);
    expect(merged.agents[0].name).toBe('Over');
  });
});
