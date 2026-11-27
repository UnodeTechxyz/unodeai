import { describe, expect, it, vi } from 'vitest';
import { FirstUseController, type FirstUseControllerDeps } from '../FirstUseController';
import {
  FIRST_USE_RECORD_KEY, parseFirstUseRecord, recoverFirstUseStart, type FirstUseRecord,
} from '../firstUseRecord';
import {
  ClaudeCliCheckError, firstUseReadiness, hasInheritedCredential, parseClaudeAuthStatus, type FirstUseReadinessProbes,
} from '../firstUseReadiness';
import { classifyInstall, isReturningUser, revealDecision } from '../installCohort';
import { returningTeamChoice } from '../returningTeam';
import { CodexPreflightError } from '../../backend/CodexCliPreflight';
import { BUILTIN_CONNECTION_REGISTRY, connectionProfile } from '../../routes/ConnectionRegistry';
import type { ConnectionProfile } from '../../routes/RouteContracts';

/*
 * v0.9.106 (first use, design §3.2–§3.8): the first goal's record, its connection check, the install cohort and the
 * returning team, and the controller that ties them together. The controller runs here with every VS Code effect stood
 * in; ActivatedFirstUse.flows.test.ts runs the same class through activate().
 */

function memento(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: <T>(key: string) => (values.has(key) ? structuredClone(values.get(key)) as T : undefined),
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); },
  };
}

type Agent = { id: string; role: string };

type HistoryRow = { text: string; requestId?: string };

function harness(options: { state?: ReturnType<typeof memento>; agents?: Agent[]; ready?: boolean; history?: Map<string, HistoryRow[]> } = {}) {
  const state = options.state ?? memento();
  const agents: Agent[] = options.agents ?? [];
  const admittedGoals: Array<{ agentId: string; text: string; requestId: string }> = [];
  // The receiver's conversation as the Chat keeps it: an admitted start's message carries its request identity.
  const history = options.history ?? new Map<string, HistoryRow[]>();
  let created = 0;
  let release: (() => void) | undefined;
  const deps: FirstUseControllerDeps = {
    state,
    listAgents: () => agents,
    defaultConnectionId: () => 'unode',
    defaultExplicit: () => false,
    connectionLabel: (id) => connectionProfile(id, BUILTIN_CONNECTION_REGISTRY)?.presentation.displayName,
    readiness: vi.fn(async () => (options.ready === false
      ? { ready: false as const, repair: { title: 'Unode needs an API key', detail: 'd', action: { kind: 'set-api-key' as const, label: 'Set the API key', secretName: 'UNODE_API_KEY' } } }
      : { ready: true as const })),
    chooseConnection: vi.fn(async () => 'openai'),
    chooseModel: vi.fn(async () => undefined),
    runRepair: vi.fn(async () => 'done' as const),
    createTeam: vi.fn(async () => {
      created++;
      await new Promise<void>((resolve) => { release = resolve; });
      agents.push({ id: 'pm', role: 'pm' }, { id: 'generalist', role: 'custom' }, { id: 'reviewer', role: 'reviewer' }, { id: 'solo', role: 'solo' });
      return 'pm';
    }),
    createSolo: vi.fn(async () => { created++; agents.push({ id: 'solo', role: 'solo' }); return 'solo'; }),
    admit: vi.fn((agentId: string, text: string, requestId: string) => {
      admittedGoals.push({ agentId, text, requestId });
      history.set(agentId, [...(history.get(agentId) ?? []), { text: text.trim(), requestId }]);
      return true as const;
    }),
    admitted: (agentId, requestId) => (history.get(agentId) ?? []).some((message) => message.requestId === requestId),
    selectAgent: vi.fn(),
    insertIntoComposer: vi.fn(),
    openCustomTeam: vi.fn(async () => {}),
    returningOffer: vi.fn(async () => undefined),
    loadReturningTeam: vi.fn(async () => {}),
    openOtherSavedTeams: vi.fn(async () => {}),
    handoverContainer: () => 'sidebar',
    changed: vi.fn(),
    newId: (() => { let n = 0; return () => `start-${++n}`; })(),
    now: () => new Date(),
  };
  const controller = new FirstUseController(deps);
  return { controller, deps, state, agents, admittedGoals, history, created: () => created, release: () => release?.() };
}

const stored = (state: ReturnType<typeof memento>) => parseFirstUseRecord(state.get(FIRST_USE_RECORD_KEY));
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('the first goal record', () => {
  it('reads only well-formed parts of a stored record', () => {
    expect(parseFirstUseRecord(undefined)).toEqual({ text: '', revision: 0 });
    expect(parseFirstUseRecord({ text: 'goal', revision: 3, connectionId: 'openai', start: { startId: 'x' } }))
      .toEqual({ text: 'goal', revision: 3, connectionId: 'openai' });
  });

  it('a reload never resends: admitted means accepted; a receiver without the request takes the goal into its box; no receiver keeps the draft', () => {
    const base: FirstUseRecord = { text: 'Ship it', revision: 4,
      start: { startId: 's', kind: 'team', phase: 'sending', connectionId: 'unode', textRevision: 4, startedAt: '2026-11-17T00:00:00.000Z', receiverAgentId: 'pm' } };
    const accepted = recoverFirstUseStart(base, { agentExists: () => true, admitted: () => true });
    expect(accepted.start?.phase).toBe('accepted');
    expect(accepted.text).toBe('');
    const resume = recoverFirstUseStart(base, { agentExists: () => true, admitted: () => false });
    expect(resume.start).toBeUndefined();
    expect(resume.handover).toEqual({ agentId: 'pm', revision: 4 });
    expect(resume.text).toBe('Ship it');
    const draft = recoverFirstUseStart({ ...base, start: { ...base.start!, phase: 'creating' } }, { agentExists: () => false, admitted: () => false });
    expect(draft).toEqual({ text: 'Ship it', revision: 4 });
  });
});

describe('firstUseReadiness: the chosen connection, checked before any agent exists', () => {
  const probes = (overrides: Partial<FirstUseReadinessProbes> = {}): FirstUseReadinessProbes => ({
    profile: (id) => connectionProfile(id, BUILTIN_CONNECTION_REGISTRY),
    hasSecret: async () => false,
    codexPreflight: async () => {},
    claudeCheck: async () => ({ loggedIn: true, loginCommand: 'claude auth login' }),
    detectedClis: () => [],
    ...overrides,
  });

  it('an API-key connection without its key: the secure key input, or a detected CLI when nobody chose a connection', async () => {
    const explicit = await firstUseReadiness({ connectionId: 'unode', implicitDefault: false }, probes({ detectedClis: () => ['claude-cli'] }));
    expect(explicit).toMatchObject({ ready: false, repair: { action: { kind: 'set-api-key', secretName: 'UNODE_API_KEY' } } });
    const implicit = await firstUseReadiness({ connectionId: 'unode', implicitDefault: true }, probes({ detectedClis: () => ['claude-cli'] }));
    expect(implicit).toMatchObject({ ready: false, repair: { action: { kind: 'use-connection', connectionId: 'claude-cli' } } });
    const configured = await firstUseReadiness({ connectionId: 'unode', implicitDefault: true }, probes({ hasSecret: async () => true }));
    expect(configured).toEqual({ ready: true, note: 'API key configured.' });
  });

  it('a custom gateway needs its chosen model', async () => {
    const custom = { ...connectionProfile('openai', BUILTIN_CONNECTION_REGISTRY)!, id: 'custom:abc' } as ConnectionProfile;
    const p = probes({ profile: () => custom, hasSecret: async () => true });
    expect(await firstUseReadiness({ connectionId: 'custom:abc', implicitDefault: false }, p))
      .toMatchObject({ ready: false, repair: { action: { kind: 'choose-model' } } });
    expect(await firstUseReadiness({ connectionId: 'custom:abc', model: 'm-1', implicitDefault: false }, p)).toMatchObject({ ready: true });
  });

  it('the Codex CLI: each preflight failure names its own repair; a login is typed into a terminal, never run', async () => {
    const failing = (kind: 'not-configured' | 'version' | 'login') => probes({ codexPreflight: async () => { throw new CodexPreflightError(kind, `${kind} message`); } });
    expect(await firstUseReadiness({ connectionId: 'codex-cli', implicitDefault: false }, failing('not-configured')))
      .toMatchObject({ ready: false, repair: { action: { kind: 'choose-cli', cli: 'codex-cli' } } });
    expect(await firstUseReadiness({ connectionId: 'codex-cli', implicitDefault: false }, failing('version')))
      .toMatchObject({ ready: false, repair: { detail: 'version message', action: { kind: 'choose-cli' } } });
    const login = await firstUseReadiness({ connectionId: 'codex-cli', implicitDefault: false }, failing('login'));
    expect(login).toMatchObject({ ready: false, repair: { action: { kind: 'cli-login', command: 'codex login' } } });
    expect(login.ready === false && login.repair.detail).toContain('does not sign you in');
    expect(login.ready === false && login.repair.steps?.length).toBe(3);
  });

  it('the Claude CLI: not found, signed out, or a sign-in confirmed only by the first task', async () => {
    expect(await firstUseReadiness({ connectionId: 'claude-cli', implicitDefault: false },
      probes({ claudeCheck: async () => { throw new ClaudeCliCheckError('not-found', 'no claude'); } })))
      .toMatchObject({ ready: false, repair: { action: { kind: 'choose-cli', cli: 'claude-cli' } } });
    expect(await firstUseReadiness({ connectionId: 'claude-cli', implicitDefault: false },
      probes({ claudeCheck: async () => ({ loggedIn: false, loginCommand: 'claude auth login' }) })))
      .toMatchObject({ ready: false, repair: { action: { kind: 'cli-login', command: 'claude auth login' } } });
    expect(await firstUseReadiness({ connectionId: 'claude-cli', implicitDefault: false },
      probes({ claudeCheck: async () => ({ loggedIn: undefined, loginCommand: 'claude auth login' }) })))
      .toEqual({ ready: true, note: 'Your Claude sign-in is confirmed when the first task starts.' });
  });

  // v0.9.106 retest 3, T2: a ready CLI check carries the version the CLI reported, for the setup guide to show.
  it('a ready CLI check carries the reported version, and none when the CLI reported none', async () => {
    const claude = (loggedIn: boolean | undefined, inheritedCredential?: true) => firstUseReadiness({ connectionId: 'claude-cli', implicitDefault: false },
      probes({ claudeCheck: async () => ({ loggedIn, loginCommand: 'claude auth login', version: '2.1.326', ...(inheritedCredential ? { inheritedCredential } : {}) }) }));
    expect(await claude(true)).toEqual({ ready: true, version: '2.1.326' });
    expect(await claude(undefined)).toEqual({ ready: true, version: '2.1.326', note: 'Your Claude sign-in is confirmed when the first task starts.' });
    expect(await claude(undefined, true)).toMatchObject({ ready: true, version: '2.1.326' });
    expect(await claude(false)).toMatchObject({ ready: false });
    expect(await firstUseReadiness({ connectionId: 'codex-cli', implicitDefault: false }, probes({ codexPreflight: async () => '0.169.0' })))
      .toEqual({ ready: true, version: '0.169.0' });
    expect(await firstUseReadiness({ connectionId: 'codex-cli', implicitDefault: false }, probes())).toEqual({ ready: true });
  });

  it('an inherited credential variable makes the Claude CLI ready, confirmed by the first task; presence only', async () => {
    expect(await firstUseReadiness({ connectionId: 'claude-cli', implicitDefault: false },
      probes({ claudeCheck: async () => ({ loggedIn: undefined, inheritedCredential: true, loginCommand: 'claude auth login' }) })))
      .toEqual({ ready: true, note: 'The Claude CLI uses the credential set in your environment; it is confirmed when the first task starts.' });
    const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
    expect(hasInheritedCredential({ anthropic_api_key: 'x' }, keys)).toBe(true);
    expect(hasInheritedCredential({ ANTHROPIC_API_KEY: '  ' }, keys)).toBe(false);
    expect(hasInheritedCredential({ OPENAI_API_KEY: 'x' }, keys)).toBe(false);
  });

  it('reads only the loggedIn answer of claude auth status', () => {
    expect(parseClaudeAuthStatus('{"loggedIn":true,"email":"x"}')).toBe(true);
    expect(parseClaudeAuthStatus('warning\n{"loggedIn":false}\n')).toBe(false);
    expect(parseClaudeAuthStatus('Usage: claude [options]')).toBeUndefined();
  });
});

describe('the install cohort and the one fresh-install reveal', () => {
  const none = { globalStateKeys: [], globalStorageNonEmpty: false, explicitUserSettings: false, storedSecret: false };
  it('any earlier installation evidence is an upgrade; an unreadable store is unknown', () => {
    expect(classifyInstall(none)).toBe('fresh');
    expect(classifyInstall({ ...none, globalStateKeys: ['unode.migration.namespace.v1'] })).toBe('upgrade');
    expect(classifyInstall({ ...none, storedSecret: true })).toBe('upgrade');
    expect(classifyInstall({ ...none, explicitUserSettings: true })).toBe('upgrade');
    expect(classifyInstall({ ...none, globalStorageNonEmpty: undefined })).toBe('unknown');
  });

  it('reveals only a fresh install with no agent and no returning evidence, once', () => {
    expect(revealDecision({ cohort: 'fresh', handled: false, rosterEmpty: true, returning: false })).toBe('reveal');
    expect(revealDecision({ cohort: 'fresh', handled: true, rosterEmpty: true, returning: false })).toBe('none');
    expect(revealDecision({ cohort: 'upgrade', handled: false, rosterEmpty: true, returning: true })).toBe('mark-handled');
    expect(revealDecision({ cohort: 'unknown', handled: false, rosterEmpty: true, returning: false })).toBe('mark-handled');
    expect(revealDecision({ cohort: 'fresh', handled: false, rosterEmpty: false, returning: false })).toBe('mark-handled');
    expect(revealDecision({ cohort: 'fresh', handled: false, rosterEmpty: true, returning: true })).toBe('mark-handled');
    const files = { savedTeams: false, automaticSnapshots: false, projectTeamFile: false };
    expect(isReturningUser('unknown', files)).toBe(false);
    expect(isReturningUser('fresh', { ...files, projectTeamFile: true })).toBe(true);
  });
});

describe('the returning team offered in one click', () => {
  const entry = (slug: string, savedAt: string, automatic = false) => ({ scope: 'global' as const, slug, label: slug.toUpperCase(), savedAt, memberCount: 3, ...(automatic ? { automatic } : {}) });
  it('prefers the team opened last, then says when it is only the most recently saved one', () => {
    const entries = [entry('old', '2026-11-01T00:00:00Z'), entry('new', '2026-11-10T00:00:00Z'), entry('snap', '2026-11-12T00:00:00Z', true)];
    expect(returningTeamChoice(entries, [{ scope: 'global', slug: 'old', at: '2026-11-11T00:00:00Z' }]))
      .toEqual({ ref: { scope: 'global', slug: 'old' }, label: 'Load your team: OLD', detail: 'The saved team you opened last.' });
    expect(returningTeamChoice(entries, [undefined])).toMatchObject({ ref: { slug: 'new' }, detail: 'Your most recently saved team.' });
    expect(returningTeamChoice([entries[2]], [])).toMatchObject({ ref: { slug: 'snap' }, label: 'Restore your previous team' });
    expect(returningTeamChoice([], [])).toBeUndefined();
  });
});

describe('FirstUseController', () => {
  async function ready(h: ReturnType<typeof harness>, text = 'Fix the login bug') {
    await h.controller.rosterLoaded();
    await h.controller.draft(text);
    await h.controller.action('continue');
  }

  it('Send checks the connection and shows the start buttons; it creates and sends nothing', async () => {
    const h = harness();
    await ready(h);
    expect(h.controller.view()).toMatchObject({ active: true, phase: 'choose', text: 'Fix the login bug', connection: { label: 'Unode' } });
    expect(h.created()).toBe(0);
    expect(h.admittedGoals).toEqual([]);
  });

  it('a missing connection shows one repair and no start buttons; the repair does not start the task', async () => {
    const h = harness({ ready: false });
    await ready(h);
    expect(h.controller.view()).toMatchObject({ phase: 'repair', repair: { actionLabel: 'Set the API key' } });
    (h.deps.readiness as ReturnType<typeof vi.fn>).mockResolvedValue({ ready: true });
    await h.controller.action('repair');
    expect(h.deps.runRepair).toHaveBeenCalledWith(expect.objectContaining({ kind: 'set-api-key' }));
    expect(h.controller.view()?.phase).toBe('choose');
    expect(h.created()).toBe(0);
  });

  it('a repeated click is the same start: one team created, one task admitted, then the accepted text is retired', async () => {
    const h = harness();
    await ready(h);
    const first = h.controller.action('start-team');
    const second = h.controller.action('start-team');
    const solo = h.controller.action('start-solo');
    await flush();
    expect(stored(h.state).start?.phase).toBe('creating');
    expect(h.controller.view()?.phase).toBe('starting');
    h.release();
    await Promise.all([first, second, solo]);
    expect(h.created()).toBe(1);
    expect(h.deps.createSolo).not.toHaveBeenCalled();
    expect(h.admittedGoals).toEqual([{ agentId: 'pm', text: 'Fix the login bug', requestId: 'first-use:start-1' }]);
    const record = stored(h.state);
    expect(record.start).toMatchObject({ phase: 'accepted', receiverAgentId: 'pm', requestId: 'first-use:start-1', connectionId: 'unode' });
    expect(record.text).toBe('');
  });

  it('the chosen connection goes to creation explicitly and is never written as the default', async () => {
    const h = harness();
    await ready(h);
    await h.controller.action('change-connection');
    expect(h.controller.view()?.connection?.label).toBe('OpenAI Compatible API');
    await h.controller.action('start-solo');
    expect(h.deps.createSolo).toHaveBeenCalledWith({ connectionId: 'openai' });
    expect(stored(h.state).start?.connectionId).toBe('openai');
  });

  it('a cancelled model choice keeps the goal and starts nothing', async () => {
    const h = harness();
    (h.deps.readiness as ReturnType<typeof vi.fn>).mockResolvedValue({ ready: false, repair: { title: 't', detail: 'd', action: { kind: 'choose-model', label: 'Choose a model' } } });
    await ready(h);
    await h.controller.action('repair');
    expect(h.deps.chooseModel).toHaveBeenCalled();
    expect(h.controller.view()).toMatchObject({ phase: 'repair', text: 'Fix the login bug' });
    expect(h.created()).toBe(0);
  });

  it('nothing created: the draft stays, with the real reason', async () => {
    const h = harness();
    (h.deps.createSolo as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('The selected connection cannot run a Project Manager.'));
    await ready(h);
    await h.controller.action('start-solo');
    expect(h.controller.view()).toMatchObject({ phase: 'choose', text: 'Fix the login bug', error: 'The selected connection cannot run a Project Manager.' });
    expect(stored(h.state).start).toBeUndefined();
  });

  it('a reload during creation or sending recovers without creating or sending again', async () => {
    const state = memento();
    const h = harness({ state });
    await ready(h);
    const start = h.controller.action('start-team');
    await flush();
    // The window reloads while the team is being created: a new controller over the same state, no agents.
    const reloaded = harness({ state });
    await reloaded.controller.rosterLoaded();
    expect(reloaded.controller.view()).toMatchObject({ active: true, phase: 'compose', text: 'Fix the login bug' });
    expect(stored(state).start).toBeUndefined();
    expect(reloaded.created()).toBe(0);
    h.release();
    await start;
    // A start that reached `sending` with its receiver: the receiver takes the goal into its box; nothing is sent.
    const sendingState = memento({ [FIRST_USE_RECORD_KEY]: { text: 'Ship it', revision: 2,
      start: { startId: 's', kind: 'team', phase: 'sending', connectionId: 'unode', textRevision: 2, startedAt: new Date().toISOString(), receiverAgentId: 'pm' } } });
    const resumed = harness({ state: sendingState, agents: [{ id: 'pm', role: 'pm' }] });
    await resumed.controller.rosterLoaded();
    expect(resumed.admittedGoals).toEqual([]);
    expect(resumed.controller.view()).toMatchObject({ active: false, handover: { agentId: 'pm', text: 'Ship it', container: 'sidebar' } });
    expect(resumed.deps.selectAgent).toHaveBeenCalledWith('pm');
  });

  it('a custom team or a single agent takes the unsent goal into its box (PM first), never sending it; a newer draft keeps it as unsent', async () => {
    const h = harness();
    await h.controller.rosterLoaded();
    await h.controller.draft('Write the release notes');
    h.agents.push({ id: 'writer', role: 'custom' }, { id: 'lead', role: 'pm' });
    await h.controller.rosterChanged();
    expect(h.controller.view()).toMatchObject({ active: false, handover: { agentId: 'lead', text: 'Write the release notes' } });
    const revision = h.controller.view()!.handover!.revision;
    await h.controller.handoverResult(revision, false);
    expect(h.controller.view()).toMatchObject({ unsent: { agentId: 'lead', text: 'Write the release notes' } });
    await h.controller.action('move-unsent');
    expect(h.deps.insertIntoComposer).toHaveBeenCalledWith('lead', 'Write the release notes');
    expect(stored(h.state).text).toBe('');
    expect(h.admittedGoals).toEqual([]);
  });

  it('an applied hand-over retires that goal revision only', async () => {
    const h = harness();
    await h.controller.rosterLoaded();
    await h.controller.draft('Explain the build');
    h.agents.push({ id: 'solo', role: 'solo' });
    await h.controller.rosterChanged();
    const revision = h.controller.view()!.handover!.revision;
    await h.controller.handoverResult(revision + 1, true);
    expect(stored(h.state).text).toBe('Explain the build');
    await h.controller.handoverResult(revision, true);
    expect(stored(h.state).text).toBe('');
    expect(h.controller.view()).toBeUndefined();
  });

  const sendingRecord = (requestId = 'first-use:s') => ({ [FIRST_USE_RECORD_KEY]: { text: 'Ship it', revision: 2,
    start: { startId: 's', kind: 'team', phase: 'sending', connectionId: 'unode', textRevision: 2, startedAt: '2026-11-17T00:00:00.000Z',
      receiverAgentId: 'pm', requestId } } });

  it('a reload between the admission and the record update finds the admission by its request identity: accepted, not sent again', async () => {
    const state = memento(sendingRecord());
    const history = new Map([['pm', [{ text: 'Ship it', requestId: 'first-use:s' }]]]);
    const h = harness({ state, agents: [{ id: 'pm', role: 'pm' }], history });
    await h.controller.rosterLoaded();
    expect(stored(state)).toMatchObject({ text: '', start: { phase: 'accepted', requestId: 'first-use:s' } });
    expect(h.admittedGoals).toEqual([]);
    expect(h.controller.view()).toBeUndefined();
  });

  it('the same text typed by the person is not taken for the start: the goal goes back to the box unsent', async () => {
    const state = memento(sendingRecord());
    // The person sent the same words themselves, and an unrelated first-use start's message is there too.
    const history = new Map([['pm', [{ text: 'Ship it' }, { text: 'Ship it', requestId: 'first-use:other' }]]]);
    const h = harness({ state, agents: [{ id: 'pm', role: 'pm' }], history });
    await h.controller.rosterLoaded();
    expect(stored(state).start).toBeUndefined();
    expect(stored(state).text).toBe('Ship it');
    expect(h.controller.view()).toMatchObject({ handover: { agentId: 'pm', text: 'Ship it' } });
    expect(h.admittedGoals).toEqual([]);
  });

  it('a start whose durable write fails creates and sends nothing, keeps the goal and says why; later writes work', async () => {
    const state = memento();
    const h = harness({ state });
    await ready(h);
    const update = state.update;
    let failNext = true;
    state.update = async (key: string, value: unknown) => {
      if (failNext && (value as FirstUseRecord | undefined)?.start) { failNext = false; throw new Error('disk full'); }
      return update(key, value);
    };
    await h.controller.action('start-team');
    expect(h.deps.createTeam).not.toHaveBeenCalled();
    expect(h.admittedGoals).toEqual([]);
    expect(h.controller.view()).toMatchObject({ phase: 'choose', text: 'Fix the login bug',
      error: expect.stringContaining('The task was not started: UnodeAi could not save its start (disk full)') });
    expect(stored(state)).toMatchObject({ text: 'Fix the login bug' });
    expect(stored(state).start).toBeUndefined();
    await h.controller.draft('Fix the logout bug');
    expect(stored(state)).toMatchObject({ text: 'Fix the logout bug' });
    expect(h.controller.view()?.error).toBeUndefined();
    // And the next start goes through, once.
    const start = h.controller.action('start-solo');
    await start;
    expect(h.deps.createSolo).toHaveBeenCalledTimes(1);
    expect(h.admittedGoals.map((goal) => goal.text)).toEqual(['Fix the logout bug']);
  });
});
