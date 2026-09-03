import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Workspace: 2 },
  workspace: {
    getConfiguration: () => ({ get: () => '', update: vi.fn() }),
    workspaceFolders: [{ uri: { fsPath: '/some/workspace' } }],
  },
  window: {
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
  },
}));
// The command-approval nudge is interactive; stub it so team/solo creation runs headless.
vi.mock('./backend/CommandApprovalPrompter', () => ({ promptCommandApproval: vi.fn().mockResolvedValue(false) }));

import { teamPresetItems, createDefaultTeam, createSoloAgent, instantiateTeam } from './dialogs';

// Runtime invariant (Codex follow-up): NO creation path may pin config.workingDirectory — the runtime
// resolves the root per session. Even with a workspace folder open, created configs must leave it unset.
function makeDeps(created: { workingDirectory?: string }[], provider = 'unode', secretChecks?: string[]) {
  return {
    sessionManager: { getAll: () => [], create: (c: any) => { created.push(c); } },
    secrets: {
      has: async (name: string) => { secretChecks?.push(name); return true; },
      promptAndStore: async () => {},
    },
    output: { info: () => {} },
    commandPolicy: { approvalMode: 'none', reload: () => {} },
    defaultBackendKind: (c: any) => c.provider?.providerId === 'anthropic'
      ? 'claude'
      : c.provider?.providerId === 'codex'
        ? 'codex'
        : 'openai-compat',
    defaultProvider: () => provider,
  } as any;
}

describe('creation paths never pin workingDirectory', () => {
  it('createDefaultTeam (the createTeamPreset path) leaves workingDirectory unset', async () => {
    const created: { workingDirectory?: string }[] = [];
    await createDefaultTeam(makeDeps(created));
    expect(created.length).toBeGreaterThan(0);
    for (const c of created) { expect(c.workingDirectory).toBeUndefined(); }
  });

  it('createSoloAgent leaves workingDirectory unset', async () => {
    const created: { workingDirectory?: string }[] = [];
    const cfg = await createSoloAgent(makeDeps(created));
    expect(cfg?.workingDirectory).toBeUndefined();
  });
});

describe('every team ships a standalone Solo agent by default', () => {
  it('createDefaultTeam includes exactly one solo agent alongside the crew', async () => {
    const created: { role?: string }[] = [];
    await createDefaultTeam(makeDeps(created));
    const roles = created.map((c) => c.role);
    expect(roles).toContain('pm');
    expect(roles.filter((r) => r === 'solo')).toHaveLength(1); // added once, not duplicated
    expect(created.length).toBeGreaterThan(1); // crew + solo
  });
});

describe('team preset picker items', () => {
  it('groups task packs and includes their descriptions', () => {
    const items = teamPresetItems();
    expect(items.filter((i) => i.kind === -1).map((i) => i.label)).toEqual([
      'Software',
      'Task Packs',
      'Knowledge Work',
    ]);

    for (const label of ['Bugfix Crew', 'Refactor Crew', 'Test Writer Crew', 'Release Crew', 'Security Review Crew']) {
      const item = items.find((i) => i.label.includes(label));
      expect(item, label).toBeDefined();
      expect(item?.description, label).toBeTruthy();
      expect(item?.detail, label).toContain('Verify:');
    }
  });

  it('renders software-kind catalog presets in the Software group, not only the hardcoded item', () => {
    // A TEAM_PRESETS entry with kind:'software' used to exist without ever being rendered: the picker
    // built only the pack and knowledge groups from the catalog. This walks the rendered order.
    const items = teamPresetItems();
    const labels = items.map((i) => i.label);
    const softwareSep = labels.indexOf('Software');
    const packSep = labels.indexOf('Task Packs');
    const engineering = labels.findIndex((l) => l.includes('Software Engineering Team'));
    expect(engineering).toBeGreaterThan(softwareSep);
    expect(engineering).toBeLessThan(packSep);

    const item = items[engineering] as { roles?: string[]; detail?: string };
    // Six crew roles; Solo is appended by instantiateTeam, so the preset itself must not list it.
    expect(item.roles).toEqual(['pm', 'architect', 'senior-dev', 'tester', 'reviewer', 'tech-writer']);
    expect(item.detail).toContain('Verify: npm test');
  });

  it('instantiates the Software Engineering Team as seven agents — six crew plus exactly one solo', async () => {
    const created: any[] = [];
    const deps = makeDeps(created);
    await instantiateTeam(deps, ['pm', 'architect', 'senior-dev', 'tester', 'reviewer', 'tech-writer'], 'Software Engineering Team');
    const roles = created.map((c) => c.role);
    expect(created).toHaveLength(7);
    expect(roles.filter((r) => r === 'solo')).toHaveLength(1);
    for (const role of ['pm', 'architect', 'senior-dev', 'tester', 'reviewer', 'tech-writer']) {
      expect(roles, role).toContain(role);
    }
  });
});

// Regression: `unode.defaultProvider` was DECLARED (package.json) and WRITTEN (setup wizard) but had ZERO
// read sites, so choosing Claude Headless silently still produced Unode agents. These tests fail if any
// creation path goes back to hardcoding a provider.
describe('creation paths honor unode.defaultProvider', () => {
  it('createDefaultTeam with anthropic gives every agent the Claude backend + a Claude model', async () => {
    const created: any[] = [];
    await createDefaultTeam(makeDeps(created, 'anthropic'));
    expect(created.length).toBeGreaterThan(0);
    for (const c of created) {
      expect(c.provider.providerId).toBe('anthropic');
      expect(c.backend).toBe('claude');
      expect(c.model).toMatch(/^claude-/); // tier-resolved Claude id (claude-sonnet-5 etc.)
    }
  });

  it('createDefaultTeam with anthropic never checks for an API key (CLI auth)', async () => {
    const created: any[] = [];
    const secretChecks: string[] = [];
    await createDefaultTeam(makeDeps(created, 'anthropic', secretChecks));
    // Prompting for ANTHROPIC_API_KEY would make the claude CLI bill per-token instead of using the plan.
    expect(secretChecks).toEqual([]);
  });

  it('createDefaultTeam with unode keeps the gateway provider + checks UNODE_API_KEY', async () => {
    const created: any[] = [];
    const secretChecks: string[] = [];
    await createDefaultTeam(makeDeps(created, 'unode', secretChecks));
    for (const c of created) {
      expect(c.provider.providerId).toBe('unode');
      expect(c.backend).toBe('openai-compat');
    }
    // The gateway also serves claude-* ids, so the provider/backend — not the model name — is the invariant.
    expect(secretChecks).toContain('UNODE_API_KEY');
  });

  it('createSoloAgent honors the default provider too', async () => {
    const created: any[] = [];
    const cfg: any = await createSoloAgent(makeDeps(created, 'anthropic'));
    expect(cfg?.provider.providerId).toBe('anthropic');
    expect(cfg?.model).toMatch(/^claude-/);
  });

  it('createSoloAgent with Claude Headless never checks an API key', async () => {
    const created: any[] = [];
    const secretChecks: string[] = [];
    const cfg: any = await createSoloAgent(makeDeps(created, 'anthropic', secretChecks));
    expect(cfg?.backend).toBe('claude');
    expect(secretChecks).toEqual([]);
  });

  it('createSoloAgent with Unode retains the gateway API-key check', async () => {
    const created: any[] = [];
    const secretChecks: string[] = [];
    await createSoloAgent(makeDeps(created, 'unode', secretChecks));
    expect(secretChecks).toEqual(['UNODE_API_KEY']);
  });

  it('uses the same registry-derived Connection / Pay through chooser for Solo and team creation', async () => {
    const created: any[] = [];
    const seen: Array<{ label: string; description?: string; detail?: string }> = [];
    const deps = makeDeps(created) as any;
    deps.chooseConnection = async (items: any[]) => {
      seen.push(...items);
      return items.find((item) => item.providerKey === 'codex');
    };

    const solo = await createSoloAgent(deps);
    // Codex remains a registered migration route but is not an item a new agent can choose.
    expect(solo?.provider.providerId).toBe('unode');
    expect(seen.find((item) => item.label.includes('Codex Headless'))).toBeUndefined();
    expect(seen.find((item) => item.label.includes('Claude Headless'))).toBeDefined();
    expect(seen.find((item) => item.label.includes('OpenRouter'))).toBeDefined();
  });

  it('rejects a persisted Codex default instead of silently falling back or creating an agent', async () => {
    const soloCreated: any[] = [];
    const solo = await createSoloAgent(makeDeps(soloCreated, 'codex'));
    expect(solo).toBeUndefined();
    expect(soloCreated).toEqual([]);

    const teamCreated: any[] = [];
    const team = await createDefaultTeam(makeDeps(teamCreated, 'codex'));
    expect(team).toEqual([]);
    expect(teamCreated).toEqual([]);
  });
});
