import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Workspace: 2 },
  workspace: {
    getConfiguration: () => ({ get: () => '', update: vi.fn() }),
    workspaceFolders: [{ uri: { fsPath: '/some/workspace' } }],
  },
  window: {
    showQuickPick: vi.fn().mockResolvedValue(undefined),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
  },
}));
// The command-approval nudge is interactive; stub it so team/solo creation runs headless.
vi.mock('./backend/CommandApprovalPrompter', () => ({ promptCommandApproval: vi.fn().mockResolvedValue(false) }));

import {
  addAgentRoleItems,
  teamActionHasDeleteControl,
  teamActionItems,
  teamPresetItems,
  createDefaultTeam,
  createTeamFromPreset,
  createSoloAgent,
  instantiateTeam,
} from './dialogs';
import * as vscode from 'vscode';
import { ROLE_TEMPLATES } from './roles/RoleConfig';
import { byDisplayName } from './views/displayOrder';

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

  it('sorts each group A-Z while keeping the recommended Software Team first', () => {
    const items = teamPresetItems();
    const separators = items
      .map((item, index) => item.kind === -1 ? index : -1)
      .filter((index) => index >= 0);
    const labelsBetween = (start: number, end: number) => items
      .slice(start + 1, end)
      .map((item) => (item as { teamLabel: string }).teamLabel);
    const software = labelsBetween(separators[0], separators[1]);
    const packs = labelsBetween(separators[1], separators[2]);
    const knowledge = labelsBetween(separators[2], items.length);

    expect(software[0]).toBe('Software Team (PM + Architect + Developer + Reviewer)');
    expect(software.slice(1)).toEqual([...software.slice(1)].sort(byDisplayName));
    expect(packs).toEqual([...packs].sort(byDisplayName));
    expect(knowledge).toEqual([...knowledge].sort(byDisplayName));
  });

  it('shows system defaults and saved teams in one picker without listing automatic snapshots', () => {
    const actions = teamActionItems(3, [
      { scope: 'global', slug: 'shared', label: 'Review Crew', savedAt: '2026-09-25T09:00:00Z', memberCount: 4 },
      { scope: 'workspace', slug: 'local', label: 'Review Crew', savedAt: '2026-09-25T10:00:00Z', memberCount: 3 },
      { scope: 'workspace', slug: '_autosave-1', label: 'Before switching', savedAt: '2026-09-25T11:00:00Z', memberCount: 2, automatic: true },
    ]);
    expect(actions.filter((item) => item.kind === -1).map((item) => item.label)).toEqual([
      'System defaults',
      'Saved teams',
    ]);
    const presets = actions.filter((item): item is Extract<typeof item, { action: 'preset' }> =>
      'action' in item && item.action === 'preset');
    expect(presets.map((item) => item.preset.teamLabel)).toEqual(
      [...presets.map((item) => item.preset.teamLabel)].sort(byDisplayName),
    );
    const saved = actions.filter((item) => 'action' in item && item.action === 'saved');
    expect(saved).toHaveLength(2);
    expect(saved.map((item) => item.description)).toEqual([
      'All projects',
      'This project (in the repository)',
    ]);
    const save = actions.find((item) => 'action' in item && item.action === 'save');
    expect(save).toMatchObject({ label: '$(save) Save current team...' });
    expect(teamActionHasDeleteControl(save! as any)).toBe(false);
    for (const item of saved) {
      expect(teamActionHasDeleteControl(item)).toBe(true);
    }
    for (const item of actions.filter((item) => 'action' in item && item.action === 'preset')) {
      expect(teamActionHasDeleteControl(item)).toBe(false);
    }
    expect(actions.filter((item) => 'action' in item && item.action === 'restore')).toHaveLength(1);
    expect(actions.some((item) => item.label.includes('Before switching'))).toBe(false);
  });

  it('keeps Save current team as the saved-team entrance even before the first save', () => {
    const actions = teamActionItems(0, []);
    const save = actions.find((item) => 'action' in item && item.action === 'save');
    expect(save).toMatchObject({ label: '$(save) Save current team...' });
    expect(teamActionHasDeleteControl(save! as any)).toBe(false);
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

describe('preset application', () => {
  it('keeps the explicit Add to current team path', async () => {
    const created: any[] = [];
    const removed: string[] = [];
    const deps = makeDeps(created) as any;
    deps.sessionManager.getAll = () => [{ id: 'existing', config: { name: 'Existing' } }];
    deps.sessionManager.remove = async (id: string) => { removed.push(id); };
    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (items: any) =>
      items.find((item: any) => item.action === 'preset'));
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Add to current team' as any);

    const added = await createTeamFromPreset(deps);

    expect(added.length).toBeGreaterThan(0);
    expect(created).toHaveLength(added.length);
    expect(removed).toEqual([]);
  });
});

describe('add-agent role picker items', () => {
  it('lists every role A-Z by its displayed name', () => {
    const items = addAgentRoleItems();
    const names = items.map((item) => ROLE_TEMPLATES[item.roleKey].name);
    expect(items).toHaveLength(52);
    expect(names).toEqual([...names].sort(byDisplayName));
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
    expect(solo?.provider.providerId).toBe('codex');
    expect(solo?.backend).toBe('codex');
    expect(seen.find((item) => item.label.includes('Codex CLI'))).toBeDefined();
    expect(seen.find((item) => item.label.includes('Claude CLI'))).toBeDefined();
    expect(seen.find((item) => item.label.includes('OpenRouter'))).toBeDefined();
  });

  it('uses a persisted Codex default for both Solo and a coordinating team without an API key', async () => {
    const soloCreated: any[] = [];
    const secretChecks: string[] = [];
    const solo = await createSoloAgent(makeDeps(soloCreated, 'codex', secretChecks));
    expect(solo?.provider.providerId).toBe('codex');
    expect(solo?.backend).toBe('codex');
    expect(solo?.model).toBe('codex-cli-default');

    const teamCreated: any[] = [];
    const team = await createDefaultTeam(makeDeps(teamCreated, 'codex', secretChecks));
    expect(team).toHaveLength(5);
    expect(teamCreated).toEqual(team);
    expect(team.every((agent) => agent.provider.providerId === 'codex' && agent.backend === 'codex')).toBe(true);
    expect(team.find((agent) => agent.role === 'pm')?.allowedTools).toContain('delegate');
    expect(secretChecks).toEqual([]);
  });
});
