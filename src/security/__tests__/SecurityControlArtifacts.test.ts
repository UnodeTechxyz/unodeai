import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile, link, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AUTHORITY_SETTING_KEYS } from '../../settings/AuthoritySettings';
import { ProjectCommandApprovals, PROJECT_COMMAND_APPROVALS_V2_KEY } from '../../settings/ProjectCommandApprovals';
import { classifySecurityControlFileChange, SECURITY_CONTROL_ARTIFACTS, securityControlValueChanged,
  type SecurityControlArtifactLocation } from '../SecurityControlArtifacts';

function classifyReplacement(target: string, before: string | undefined, after: string | undefined,
  locations: readonly SecurityControlArtifactLocation[]) {
  return classifySecurityControlFileChange(target, before, after, locations, after === undefined ? 'remove' : 'replace');
}

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'unode-security-classification-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('finite security control artifacts', () => {
  it('includes the new User default, saved enable decision and host-only agent Autonomy as authority', () => {
    expect(securityControlValueChanged('user-settings', {}, { 'unode.autonomy': 'full-access' })).toBe(true);
    expect(securityControlValueChanged('global-state', { history: 'newer' },
      { history: 'newer', 'unode.autonomy.fullAccessDefault.v1': true })).toBe(true);
    expect(securityControlValueChanged('workspace-state', { 'roam.agents': [{ id: 'dev' }] },
      { 'roam.agents': [{ id: 'dev', autonomyMode: 'full-access' }] })).toBe(true);
  });
  it('lists security settings explicitly without inheriting pricing or presentation authority settings', () => {
    const keys = SECURITY_CONTROL_ARTIFACTS['user-settings'].keys;
    for (const key of keys) expect(AUTHORITY_SETTING_KEYS).toContain(key.slice('unode.'.length));
    expect(keys).not.toContain('unode.priceMultiplier');
    expect(keys).not.toContain('unode.attentionSound');
    expect(keys).not.toContain('unode.notifications.resultStyle');
    expect(keys).not.toContain('unode.modelPrices');
  });

  it('ignores ordinary User settings JSONC edits, including removal of a file with no security keys', async () => {
    const settings = path.join(directory, 'settings.json');
    const locations: SecurityControlArtifactLocation[] = [{ kind: 'user-settings', path: settings }];
    const before = '{ // person preferences\n "workbench.colorTheme": "dark", "unode.priceMultiplier": 1, "unode.commandApproval": "all", }';
    const after = '{ "unode.commandApproval": "all", "workbench.colorTheme": "light", "unode.priceMultiplier": 2 }';
    expect(await classifyReplacement(settings, before, after, locations)).toMatchObject({ changed: false, comparison: 'fields' });
    expect(await classifyReplacement(settings, before, after.replace('"all"', '"none"'), locations))
      .toMatchObject({ changed: true, comparison: 'fields' });
    expect(await classifyReplacement(settings, '{"workbench.colorTheme":"light"}', undefined, locations))
      .toMatchObject({ changed: false });
    expect(await classifyReplacement(settings, before, undefined, locations)).toMatchObject({ changed: true });
  });

  it('finds an exact physical file after irrelevant locations, without matching its sibling or whole directory', async () => {
    const actual = path.join(directory, 'actual');
    const alias = path.join(directory, 'alias');
    await mkdir(actual);
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const settings = path.join(actual, 'settings.json');
    await writeFile(settings, '{}');
    const locations: SecurityControlArtifactLocation[] = [
      ...['old.json', 'history.json', 'newest.json'].map((name) => ({ kind: 'claude-gate-settings' as const, path: path.join(actual, name) })),
      { kind: 'user-settings', path: settings },
    ];
    expect(await classifyReplacement(path.join(alias, 'settings.json'), '{}', '{"unode.commandApproval":"all"}', locations))
      .toMatchObject({ kind: 'user-settings', changed: true, physicalPath: await realpath(settings) });
    expect(await classifyReplacement(path.join(actual, 'settings.json.bak'), '{}', 'new', locations)).toBeUndefined();
    expect(await classifyReplacement(path.join(alias, 'sessions', 'output.json'), undefined, 'new', locations)).toBeUndefined();
  });

  it('classifies source removal and destination replacement for move/rename without changing disk', async () => {
    const gate = path.join(directory, 'claude-tool-gate.json');
    const before = '{"hooks":{"PreToolUse":[]}}';
    await writeFile(gate, before);
    const locations: SecurityControlArtifactLocation[] = [{ kind: 'claude-gate-settings', path: gate }];
    expect(await classifyReplacement(gate, before, undefined, locations)).toMatchObject({ changed: true, comparison: 'raw' });
    expect(await classifyReplacement(gate, before, '{}', locations)).toMatchObject({ changed: true });
    expect(await classifyReplacement(gate, before, before, locations)).toMatchObject({ changed: false });
  });

  it('keeps raw malformed/binary mixed replacements visible rather than pretending to separate authority', async () => {
    const settings = path.join(directory, 'settings.json');
    expect(await classifyReplacement(settings, 'broken', 'different', [{ kind: 'user-settings', path: settings }]))
      .toMatchObject({ changed: true, comparison: 'raw' });
    expect(await classifyReplacement(settings, 'same-broken', 'same-broken', [{ kind: 'user-settings', path: settings }]))
      .toMatchObject({ changed: false, comparison: 'raw' });
    expect(await classifyReplacement(settings, '{}', '{"roam.messages":[]}',
      [{ kind: 'workspace-state', path: settings, binaryState: true }])).toMatchObject({ changed: true, comparison: 'raw' });
  });

  it('matches hard-link writes by file identity, but only the changed name for replacement or removal', async () => {
    const original = path.join(directory, 'original.json');
    const configured = path.join(directory, 'configured.json');
    const unrelated = path.join(directory, 'unrelated.json');
    await writeFile(original, '{}');
    await link(original, configured);
    await link(original, unrelated);
    const locations: SecurityControlArtifactLocation[] = [{ kind: 'user-settings', path: configured }];
    expect(await classifySecurityControlFileChange(unrelated, '{}', '{"unode.commandApproval":"all"}', locations, 'write'))
      .toMatchObject({ changed: true });
    expect(await classifySecurityControlFileChange(unrelated, '{}', undefined, locations, 'remove')).toBeUndefined();
    expect(await classifySecurityControlFileChange(unrelated, '{}', '{"unode.commandApproval":"all"}', locations, 'replace')).toBeUndefined();
    expect(await classifySecurityControlFileChange(configured, '{}', undefined, locations, 'remove'))
      .toMatchObject({ changed: false }); // Empty control projection remains empty.
    expect(await classifySecurityControlFileChange(configured, '{"unode.commandApproval":"none"}', undefined, locations, 'remove'))
      .toMatchObject({ changed: true });
  });

  it('compares real approval-store writes with newer irrelevant rows first', async () => {
    const values = new Map<string, unknown>([['roam.messages', ['newest']], ['roam.runs', []], ['roam.workflows', []]]);
    const memento = {
      get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { values.set(key, value); },
    };
    const store = new ProjectCommandApprovals(memento, () => directory);
    const before = Object.fromEntries(values);
    await store.enableExecution([{ grammar: 'posix', template: 'git status' }]);
    const after = Object.fromEntries(values);
    expect(values.get(PROJECT_COMMAND_APPROVALS_V2_KEY)).toMatchObject({ version: 2, executionEnabled: true,
      approvals: [{ grammar: 'posix', template: 'git status' }] });
    expect(securityControlValueChanged('workspace-state', before, after)).toBe(true);
    values.set('roam.messages', ['ordinary next message']);
    expect(securityControlValueChanged('workspace-state', after, Object.fromEntries(values))).toBe(false);
    await store.disableExecution();
    expect(securityControlValueChanged('workspace-state', after, Object.fromEntries(values))).toBe(true);
  });

  it('detects roster authority changes while ignoring prose, names, model and history updates', () => {
    const agent = { id: 'one', name: 'Old name', model: 'old-model', autoApprove: false, allowedTools: ['read'],
      route: { routeVersion: 1, kind: 'openai-compatible', connectionId: 'roam', modelId: 'old-model' },
      skills: [{ name: 'Old skill', description: 'prose', implementation: { type: 'builtin', tools: ['read'] } }] };
    const before = { 'roam.agents': [agent], 'roam.messages': ['one'] };
    const after = { 'roam.agents': [{ ...agent, name: 'New name', model: 'new-model',
      route: { ...agent.route, modelId: 'new-model' }, systemPrompt: 'new prose',
      skills: [{ ...agent.skills[0], name: 'New skill' }] }], 'roam.messages': ['two'] };
    expect(securityControlValueChanged('workspace-state', before, after)).toBe(false);
    expect(securityControlValueChanged('workspace-state', before, { 'roam.agents': [{ ...agent, autoApprove: true }] })).toBe(true);
    expect(securityControlValueChanged('workspace-state', before, { 'roam.agents': [{ ...agent, allowedTools: ['read', 'execute'] }] })).toBe(true);
    expect(securityControlValueChanged('workspace-state', before, { 'roam.agents': [{ ...agent, folderAccess: [{ path: directory, mode: 'write' }] }] })).toBe(true);
  });

  it('treats gateway names/revisions as presentation while detecting endpoint, key and lifecycle effects', () => {
    const profile = { connectionId: 'custom:fixture', state: 'active', endpointBase: 'https://old.example', secretRef: 'fake-ref', displayName: 'Name', revision: 1 };
    const before = { profiles: [profile], registryRevision: 1 };
    expect(securityControlValueChanged('gateway-profiles', before, { profiles: [{ ...profile, displayName: 'New name', revision: 2 }], registryRevision: 2 })).toBe(false);
    expect(securityControlValueChanged('gateway-profiles', before, { profiles: [{ ...profile, endpointBase: 'https://new.example' }] })).toBe(true);
    expect(securityControlValueChanged('gateway-profiles', before, { profiles: [{ ...profile, secretRef: 'different-fake-ref' }] })).toBe(true);
    expect(securityControlValueChanged('gateway-profiles', before, { profiles: [] })).toBe(true);
  });

  it('projects saved global team authority while leaving its label and prompt prose ordinary', () => {
    const team = { label: 'Original', members: [{ id: 'one', name: 'Name', autoApprove: false, systemPrompt: 'old' }] };
    expect(securityControlValueChanged('saved-global-team', team,
      { ...team, label: 'Renamed', members: [{ ...team.members[0], systemPrompt: 'new' }] })).toBe(false);
    expect(securityControlValueChanged('saved-global-team', team,
      { ...team, members: [{ ...team.members[0], autoApprove: true }] })).toBe(true);
  });

  it('keeps presentation-only agent/profile permutations ordinary while preserving real per-id changes', () => {
    const one = { id: 'one', autoApprove: false, allowedTools: ['read'] };
    const two = { id: 'two', autoApprove: true, allowedTools: ['read', 'write'] };
    expect(securityControlValueChanged('workspace-state', { 'roam.agents': [one, two] }, { 'roam.agents': [two, one] })).toBe(false);
    expect(securityControlValueChanged('workspace-state', { 'roam.agents': [one, two] },
      { 'roam.agents': [{ ...two, autoApprove: false }, one] })).toBe(true);
    const a = { connectionId: 'custom:a', endpointBase: 'https://a.example', state: 'active' };
    const b = { connectionId: 'custom:b', endpointBase: 'https://b.example', state: 'active' };
    expect(securityControlValueChanged('gateway-profiles', { profiles: [a, b] }, { profiles: [b, a] })).toBe(false);
    expect(securityControlValueChanged('gateway-profiles', { profiles: [a, b] },
      { profiles: [{ ...b, endpointBase: 'https://changed.example' }, a] })).toBe(true);
  });
});
