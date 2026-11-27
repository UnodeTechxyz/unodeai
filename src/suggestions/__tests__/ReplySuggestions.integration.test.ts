import { describe, expect, it } from 'vitest';
import { RequestCeilingGate, type RequestCeilingDecision, type RequestLimits } from '../../host/RequestCeiling';
import { RequestLimitMeter } from '../../host/RequestLimitMeter';
import { SpendCoordinator } from '../../host/SpendCoordinator';
import { MemorySpendLedger } from '../../state/SpendStore';
import { parseUserTargets } from '../../models/spend/SpendTargets';
import type { MediaModel } from '../../models/MediaModelSelection';
import {
  CANNOT_PROVIDE_SUGGESTIONS,
  ReplySuggestionService,
  type SuggestionConnection,
} from '../ReplySuggestionService';
import { SUGGESTION_SYSTEM_PROMPT } from '../ReplySuggestionInput';
import { MAX_TRACKED_REQUESTS } from '../../host/RequestCeiling';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

/*
 * Codex audit F2: the production revoke function and SecretStorage callback of src/extension.ts, unmodified, run
 * against this service, so the regression proves the hook the window actually uses.
 */
const extensionAst = ts.createSourceFile('extension.ts', fs.readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function productionFunction(name: string, bindings: Record<string, unknown>) {
  const declaration = extensionAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const code = ts.transpileModule(declaration.getText(extensionAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${code}\n${name}`, bindings);
}
function productionSecretCallback(bindings: Record<string, unknown>) {
  let callback: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(extensionAst) === 'context.secrets.onDidChange') callback = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(extensionAst);
  const code = ts.transpileModule(`const callback = ${callback!.getText(extensionAst)}; callback`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(code, bindings);
}

/*
 * v0.9.110 S1: the suggestion service end to end through the real request-limit gate, the real meter and the real
 * Spend coordinator, with a loopback "provider" that records every request it receives. No network.
 */

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const KEY = 'sk-test-suggestion-key';

interface Sent { url: string; headers: Record<string, string>; body: { model: string; messages: Array<{ role: string; content: string }>; stream: boolean } }

function setup(options: {
  limits?: RequestLimits;
  model?: MediaModel | undefined;
  connection?: Partial<SuggestionConnection> | null;
  reply?: { status?: number; content?: unknown; usage?: unknown };
  declineEgress?: boolean;
  key?: string | undefined;
  /** Runs as the consent decision is answered, before the request may leave. */
  onConsent?: () => void;
} = {}) {
  let model: MediaModel | undefined = 'model' in options ? options.model : { connectionId: 'unode', modelId: 'sugg-1' };
  let revision = 1;
  let connection: SuggestionConnection | undefined = options.connection === null ? undefined : {
    connectionId: 'unode', revision: 3, displayName: 'Unode', textApi: true,
    endpointBase: 'https://gateway.example/v1', apiKeySecretName: 'UNODE_API_KEY', ...options.connection,
  };
  const decisions: Array<(decision: RequestCeilingDecision) => void> = [];
  const gate = new RequestCeilingGate({
    readLimits: () => options.limits ?? {},
    decide: () => new Promise<RequestCeilingDecision>((resolve) => decisions.push(resolve)),
    stopRequest: () => undefined,
    reachableRequests: () => new Set(),
    timers: { set: () => 0, clear: () => undefined },
  });
  const meter = new RequestLimitMeter(gate, () => false);
  const ledger = new MemorySpendLedger(() => NOW);
  let ids = 0;
  const spend = new SpendCoordinator({
    ledger,
    notifier: { threshold: () => undefined, referencePriceChoiceNeeded: () => undefined, viewChanged: () => undefined, repairNeeded: () => undefined },
    resolveRoute: () => ({ connectionId: 'agent-route', connectionName: 'Agent route', route: 'gateway' }),
    routeCandidates: () => [],
    referenceMode: () => 'unselected',
    catalogs: () => ({}),
    userTargets: () => parseUserTargets({ schemaVersion: 1 }),
    repositoryBudget: () => undefined,
    stopRequest: () => 0,
    now: () => NOW,
    randomId: () => `id${++ids}`,
    claimRetryMs: 1,
  });
  const sent: Sent[] = [];
  const factsAtSend: unknown[] = [];
  const egress: Array<{ url: string; scope: unknown; requester: string }> = [];
  let respond: (() => void) | undefined;
  let holdResponse = false;
  let holdKey: Promise<void> | undefined;
  let holdConsent: Promise<void> | undefined;
  let statusChanges = 0;
  const service = new ReplySuggestionService({
    readModel: () => model,
    settingsRevision: () => revision,
    connection: (id) => (connection && connection.connectionId === id ? connection : undefined),
    apiKey: async (name) => {
      if (holdKey) await holdKey;
      return name === 'UNODE_API_KEY' ? ('key' in options ? options.key : KEY) : undefined;
    },
    approveEgress: async (url, scope, requester) => {
      if (holdConsent) await holdConsent;
      options.onConsent?.();
      egress.push({ url, scope, requester });
      if (options.declineEgress) throw new Error('declined');
    },
    fetch: async (url, init) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      // What the parent's limit observed at the moment this request left.
      factsAtSend.push(structuredClone(gate.facts('r1')));
      if (holdResponse) {
        await new Promise<void>((resolve, reject) => {
          respond = resolve;
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      const reply = options.reply ?? {};
      return {
        ok: (reply.status ?? 200) < 400,
        status: reply.status ?? 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: 'content' in reply ? reply.content : 'Can you add a test for that?' } }],
          usage: 'usage' in reply ? reply.usage : { prompt_tokens: 120, completion_tokens: 9 },
        }),
      };
    },
    ceiling: gate,
    meter,
    spend,
    newId: () => `n${++ids}`,
    statusChanged: () => { statusChanges += 1; },
  });
  const conversation = [
    { role: 'user' as const, text: 'Please fix the parser bug.' },
    { role: 'agent' as const, text: 'Fixed it in parser.ts: the loop now stops at the end of input.' },
  ];
  /** As the chat does: the parent request was begun (pinning its limits), its budget is pinned when offered. */
  const ask = (requestId = 'r1', signal = new AbortController().signal, begin = true) => {
    if (begin) gate.begin(requestId);
    const budget = service.pinBudget(requestId);
    return service.suggest({ budget, agentId: 'dev', agentName: 'Developer', messages: conversation, signal }).finally(() => budget.release());
  };
  return {
    service, gate, meter, spend, ledger, sent, egress, decisions, ask,
    setModel: (next: MediaModel | undefined) => { model = next; revision += 1; },
    setConnection: (next: SuggestionConnection | undefined) => { connection = next; },
    factsAtSend,
    holdResponses: () => { holdResponse = true; },
    /** Hold the key lookup or the consent until the returned function is called. */
    holdKeyLookup: () => { let open!: () => void; holdKey = new Promise<void>((resolve) => { open = resolve; }); return open; },
    holdConsentAnswer: () => { let open!: () => void; holdConsent = new Promise<void>((resolve) => { open = resolve; }); return open; },
    statusChanges: () => statusChanges,
    release: () => respond?.(),
  };
}

async function flush(spend: SpendCoordinator): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await spend.settled();
  }
}

describe('ReplySuggestionService', () => {
  it('sends one plain text request to the exact chosen route and records it as a Reply suggestion unit', async () => {
    const h = setup();
    h.gate.begin('r1');
    h.spend.beginRequest('r1', 'dev');
    const outcome = await h.ask();
    expect(outcome).toMatchObject({ kind: 'suggestion', text: 'Can you add a test for that?' });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].url).toBe('https://gateway.example/v1/chat/completions');
    expect(h.sent[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    // One request: the exact model, no tools, no streaming, no fallback parameters.
    expect(Object.keys(h.sent[0].body).sort()).toEqual(['messages', 'model', 'stream']);
    expect(h.sent[0].body.model).toBe('sugg-1');
    expect(h.sent[0].body.messages[0]).toEqual({ role: 'system', content: SUGGESTION_SYSTEM_PROMPT });
    expect(h.sent[0].body.messages[1].content).toContain('Fixed it in parser.ts');
    expect(h.egress).toEqual([{ url: 'https://gateway.example/v1/chat/completions', scope: { profileId: 'unode', profileRevision: 3 },
      requester: 'Developer via Unode (reply suggestion)' }]);
    await flush(h.spend);
    const receipts = h.ledger.snapshot().events.map(({ event }) => event).filter((event) => event.kind === 'usage-receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ receipt: { requestId: 'r1', agentId: 'dev', connectionId: 'unode', modelId: 'sugg-1', purpose: 'reply-suggestion', tokens: { input: 120, output: 9 } } });
    const view = h.spend.viewModel();
    expect(view.requests[0].rows).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Reply suggestion (included above)', tokens: 129 })]));
  });

  it('None sends nothing and records nothing', async () => {
    const h = setup({ model: undefined });
    expect(await h.ask()).toEqual({ kind: 'none', reason: 'off' });
    expect(h.sent).toEqual([]);
    expect(h.egress).toEqual([]);
    expect(h.ledger.snapshot().events).toEqual([]);
  });

  it('a connection without a usable text API is named, and nothing is sent or switched', async () => {
    const h = setup({ connection: { textApi: false } });
    expect(h.service.settingView()).toEqual({ configured: true, label: 'Unode · sugg-1', problem: CANNOT_PROVIDE_SUGGESTIONS });
    expect(await h.ask()).toEqual({ kind: 'none', reason: 'cannot-provide' });
    expect(h.sent).toEqual([]);
  });

  it('a declined egress decision sends nothing', async () => {
    const h = setup({ declineEgress: true });
    expect(await h.ask()).toEqual({ kind: 'none', reason: 'egress-declined' });
    expect(h.sent).toEqual([]);
  });

  it('an exhausted parent tranche or a pending Continue sends nothing, asks nothing and records nothing', async () => {
    const exhausted = setup({ limits: { providerTurns: 1 } });
    exhausted.gate.begin('r1');
    exhausted.gate.noteProviderRequest('r1', 'dev', 'request');
    expect(await exhausted.ask()).toEqual({ kind: 'none', reason: 'budget-limit-reached' });
    expect(exhausted.sent).toEqual([]);
    expect(exhausted.decisions).toEqual([]);

    const pending = setup({ limits: { providerTurns: 1 } });
    pending.gate.begin('r1');
    pending.gate.noteProviderRequest('r1', 'dev', 'request');
    void pending.gate.boundary('r1', 'provider-request');
    expect(pending.decisions).toHaveLength(1);
    expect(await pending.ask()).toEqual({ kind: 'none', reason: 'budget-awaiting-decision' });
    expect(pending.sent).toEqual([]);
    expect(pending.decisions).toHaveLength(1);
    await flush(pending.spend);
    expect(pending.ledger.snapshot().events).toEqual([]);
  });

  it('the closeout written before it stays as written; the suggestion cost is appended after it', async () => {
    const h = setup({ limits: { tokens: 10_000 } });
    h.gate.begin('r1');
    h.spend.beginRequest('r1', 'dev');
    // The answer's own unit settles and its closeout snapshot is taken, as the session does at the turn's end.
    h.meter.beginUsageUnit({ usageUnitId: 'u-main', requestId: 'r1', agentId: 'dev' }, 'request');
    h.spend.beginUsageUnit({ usageUnitId: 'u-main', requestId: 'r1', agentId: 'dev', modelId: 'main-model' });
    h.meter.noteModelRequest('u-main');
    h.spend.noteModelRequest('u-main');
    h.meter.settleUsageUnit('u-main', { inputTokens: 1000, outputTokens: 200 });
    h.spend.settleUsageUnit('u-main', { inputTokens: 1000, outputTokens: 200, usageBasis: 'reported' });
    const closeout = structuredClone(h.gate.facts('r1'));
    await flush(h.spend);
    expect(await h.ask()).toMatchObject({ kind: 'suggestion' });
    await flush(h.spend);
    expect(closeout).toMatchObject({ tokens: { observed: 1200 } });
    // The meter of the root still counts it, and Spend keeps it as a separate, later unit of the same root.
    expect(h.gate.facts('r1')).toMatchObject({ tokens: { observed: 1329 } });
    const receipts = h.ledger.snapshot().events.map(({ event }) => event).filter((event) => event.kind === 'usage-receipt');
    expect(receipts.map((event) => (event as { receipt: { usageUnitId: string } }).receipt.usageUnitId)).toEqual(['u-main', expect.stringMatching(/^suggestion-/)]);
  });

  it('Stop before the answer arrives records the sent request as unknown usage, never as free', async () => {
    const h = setup();
    h.gate.begin('r1');
    h.spend.beginRequest('r1', 'dev');
    h.holdResponses();
    const controller = new AbortController();
    const pending = h.ask('r1', controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.sent).toHaveLength(1);
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'none', reason: 'cancelled' });
    await flush(h.spend);
    expect(h.spend.viewModel().coverageGaps).toBe(1);
  });

  it('a late answer after the setting changed is not shown, but its usage is still recorded', async () => {
    const h = setup();
    h.gate.begin('r1');
    h.spend.beginRequest('r1', 'dev');
    h.holdResponses();
    const pending = h.ask();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.setModel({ connectionId: 'unode', modelId: 'other' });
    h.release();
    expect(await pending).toMatchObject({ kind: 'none', reason: 'stale' });
    await flush(h.spend);
    expect(h.ledger.snapshot().events.map(({ event }) => event).filter((event) => event.kind === 'usage-receipt')).toHaveLength(1);
  });

  it('Off cancels an operation in flight', async () => {
    const h = setup();
    h.holdResponses();
    const pending = h.ask();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.setModel(undefined);
    h.service.cancelAll();
    expect(await pending).toMatchObject({ kind: 'none', reason: 'cancelled' });
  });

  it('a changed connection before sending sends nothing', async () => {
    const h = setup();
    const pending = h.ask();
    h.setConnection({ connectionId: 'unode', revision: 4, displayName: 'Unode', textApi: true, endpointBase: 'https://other.example/v1', apiKeySecretName: 'UNODE_API_KEY' });
    expect(await pending).toEqual({ kind: 'none', reason: 'stale' });
    expect(h.sent).toEqual([]);
  });

  it.each([
    ['an empty answer', { content: '' }],
    ['a non-text answer', { content: { text: 'x' } }],
    ['an answer longer than 300 code points', { content: 'a'.repeat(301) }],
    ['a failed request', { status: 500 }],
  ])('%s shows nothing', async (_name, reply) => {
    const h = setup({ reply });
    const outcome = await h.ask();
    expect(outcome.kind).toBe('none');
    expect(h.sent).toHaveLength(1);
  });
});


const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The production revoke function, with the window's grant stores stood in, acting on this service. */
function productionRevoke(h: ReturnType<typeof setup>, dismissed: string[]) {
  return productionFunction('revokeEgressConsent', {
    modelDeclineKey: () => 'decline', consentDeclines: { add: () => false },
    consentGrants: { revokeModel: () => true, revoke: () => true }, imageConnections: { invalidate() {} },
    persistConsentGrants: async () => {}, persistConsentDeclines: async () => {}, replySuggestions: h.service,
    chatViewProvider: { dismissReplySuggestions: () => dismissed.push('dismissed') },
  }) as (host: string, kind: string, mediaKind: undefined, scope: { profileId: string; destination: string; profileRevision: number }) => void;
}

function productionKeyChange(h: ReturnType<typeof setup>, dismissed: string[]) {
  return productionSecretCallback({
    effectiveConnectionRegistry: { profiles: [{ id: 'unode', apiKeySecretName: 'UNODE_API_KEY' }, { id: 'other', apiKeySecretName: 'OTHER_KEY' }] },
    spendHost: { credentialChanged() {} }, imageConnections: { invalidate() {} },
    replySuggestions: h.service, chatViewProvider: { dismissReplySuggestions: () => dismissed.push('dismissed') },
  }) as (event: { key: string }) => void;
}

const scope = { profileId: 'unode', destination: 'https://gateway.example:443', profileRevision: 3 };

describe('Codex audit F2: egress revocation and key changes end a suggestion now', () => {
  it('a revocation while consent is still being answered sends nothing, also after the answer arrives', async () => {
    const h = setup();
    const answer = h.holdConsentAnswer();
    const dismissed: string[] = [];
    const pending = h.ask();
    await tick(); await tick();
    productionRevoke(h, dismissed)('gateway.example', 'model', undefined, scope);
    answer();
    expect(await pending).toMatchObject({ kind: 'none', reason: 'cancelled' });
    expect(h.sent).toEqual([]);
    expect(dismissed).toEqual(['dismissed']);
  });

  it('a revocation of another connection leaves this one alone', async () => {
    const h = setup();
    const answer = h.holdConsentAnswer();
    const pending = h.ask();
    await tick(); await tick();
    productionRevoke(h, [])('other.example', 'model', undefined, { ...scope, profileId: 'other' });
    answer();
    expect(await pending).toMatchObject({ kind: 'suggestion' });
  });

  it('a revocation while the request is out aborts it, shows nothing, and keeps what it used as unknown usage', async () => {
    const h = setup();
    h.spend.beginRequest('r1', 'dev');
    h.holdResponses();
    const dismissed: string[] = [];
    const pending = h.ask();
    await tick(); await tick();
    expect(h.sent).toHaveLength(1);
    productionRevoke(h, dismissed)('gateway.example', 'model', undefined, scope);
    expect(await pending).toMatchObject({ kind: 'none', reason: 'cancelled' });
    expect(dismissed).toEqual(['dismissed']);
    await flush(h.spend);
    expect(h.spend.viewModel().coverageGaps).toBe(1);
  });

  it('a replaced or deleted key before sending sends nothing', async () => {
    const h = setup();
    const lookedUp = h.holdKeyLookup();
    const dismissed: string[] = [];
    const pending = h.ask();
    await tick();
    productionKeyChange(h, dismissed)({ key: 'UNODE_API_KEY' });
    lookedUp();
    expect(await pending).toMatchObject({ kind: 'none', reason: 'cancelled' });
    expect(h.sent).toEqual([]);
    expect(dismissed).toEqual(['dismissed']);
  });

  it('a key change while the request is out aborts it; a key change of another connection does not', async () => {
    const h = setup();
    h.holdResponses();
    const pending = h.ask();
    await tick(); await tick();
    productionKeyChange(h, [])({ key: 'OTHER_KEY' });
    productionKeyChange(h, [])({ key: 'UNODE_API_KEY' });
    expect(await pending).toMatchObject({ kind: 'none', reason: 'cancelled' });
    // A new suggestion afterwards is a new operation and proceeds.
    const next = setup();
    expect(await next.ask()).toMatchObject({ kind: 'suggestion' });
  });
});

describe('Codex audit F4: a parent budget that cannot be shown funds nothing', () => {
  it('an exhausted parent the gate has since forgotten sends nothing', async () => {
    const h = setup({ limits: { providerTurns: 1 } });
    h.gate.begin('r1');
    h.gate.noteProviderRequest('r1', 'dev', 'request');
    for (let n = 0; n <= MAX_TRACKED_REQUESTS; n++) h.gate.begin(`later-${n}`);
    expect(h.gate.governs('r1')).toBe(false);
    expect(await h.ask('r1', undefined, false)).toEqual({ kind: 'none', reason: 'budget-unavailable' });
    expect(h.sent).toEqual([]);
    expect(h.decisions).toEqual([]);
  });

  it('a parent never begun sends nothing; a parent begun with no limit proceeds', async () => {
    const unknown = setup();
    expect(await unknown.ask('nobody', undefined, false)).toEqual({ kind: 'none', reason: 'budget-unavailable' });
    expect(unknown.sent).toEqual([]);
    const free = setup();
    expect(await free.ask('free')).toMatchObject({ kind: 'suggestion' });
  });

  it('a budget pinned at the offer survives the cleanup while consent is answered, and is still that parent\'s budget', async () => {
    const h = setup({ limits: { providerTurns: 2 } });
    h.gate.begin('r1');
    h.gate.noteProviderRequest('r1', 'dev', 'request');
    const answer = h.holdConsentAnswer();
    const pending = h.ask('r1');
    await tick(); await tick();
    for (let n = 0; n <= MAX_TRACKED_REQUESTS; n++) h.gate.begin(`later-${n}`);
    answer();
    expect(await pending).toMatchObject({ kind: 'suggestion' });
    expect(h.gate.facts('r1')).toMatchObject({ providerTurns: { observed: 2 } });
  });
});

describe('Codex audit F6: why there was no suggestion is shown in Providers', () => {
  it('a missing stored key: no request, and the row says so with the key-setting action', async () => {
    const h = setup({ key: undefined });
    expect(await h.ask()).toEqual({ kind: 'none', reason: 'no-key' });
    expect(h.sent).toEqual([]);
    expect(h.service.settingView()).toEqual({ configured: true, label: 'Unode · sugg-1',
      problem: 'API key required: no key is stored for this connection', keyAction: { secretName: 'UNODE_API_KEY' } });
    expect(h.statusChanges()).toBe(1);
  });

  it('a provider failure is named by its status, and a later success clears it', async () => {
    const h = setup({ reply: { status: 500 } });
    expect(await h.ask()).toMatchObject({ kind: 'none', reason: 'failed' });
    expect(h.service.settingView()).toMatchObject({ problem: 'The last suggestion request failed: the provider returned HTTP 500' });
    expect(h.sent).toHaveLength(1);
    const ok = setup();
    await ok.ask();
    expect(ok.service.settingView()).toEqual({ configured: true, label: 'Unode · sugg-1' });
  });

  it('a declined destination is named; a changed setting resets the reason', async () => {
    const h = setup({ declineEgress: true });
    await h.ask();
    expect(h.service.settingView().problem).toBe('Sending to this connection is not allowed. Suggestions do not ask again until you change the model here; choose Allow when an agent of yours next uses this connection, or press Turn off and choose the model again');
    h.setModel({ connectionId: 'unode', modelId: 'sugg-2' });
    expect(h.service.settingView()).toEqual({ configured: true, label: 'Unode · sugg-2' });
  });
});

/*
 * Codex re-audit F4-R: the final budget check and the request leaving are one synchronous step. A late usage settlement
 * of the parent (a stopped backend's receipt, applied to the shared meter) that becomes runnable around the consent
 * answer either lands before that step, and nothing is sent, or after the request already left.
 */
describe('Codex re-audit F4-R: no request leaves on a parent allowance reached before it', () => {
  /** Queue the parent's settlement `depth` microtasks after the consent answer. */
  const lateSettlement = (meter: { settleUsageUnit(id: string, usage: { inputTokens: number; outputTokens: number }): void }, depth: number) => {
    const settle = () => meter.settleUsageUnit('u-parent', { inputTokens: 90, outputTokens: 10 });
    let run = settle;
    for (let i = 0; i < depth; i += 1) { const next = run; run = () => queueMicrotask(next); }
    run();
  };

  function parentAtNinety(depth: number) {
    let h!: ReturnType<typeof setup>;
    h = setup({ limits: { tokens: 100, providerTurns: 10 }, onConsent: () => lateSettlement(h.meter, depth) });
    h.gate.begin('r1');
    h.meter.beginUsageUnit({ usageUnitId: 'u-parent', requestId: 'r1', agentId: 'dev' }, 'request');
    h.meter.noteModelRequest('u-parent');
    return h;
  }

  it.each([0, 1, 2, 3, 4, 5, 6, 8, 12])('a parent settlement %i microtasks after consent: no POST ever leaves on a reached allowance', async (depth) => {
    const h = parentAtNinety(depth);
    const outcome = await h.ask('r1');
    for (const facts of h.factsAtSend) expect((facts as { tokens: { observed: number } }).tokens.observed).toBeLessThan(100);
    if (h.sent.length === 0) {
      expect(outcome).toEqual({ kind: 'none', reason: 'budget-limit-reached' });
      // The auxiliary reservation was given back: only the parent's own request is counted.
      expect(h.gate.facts('r1')).toMatchObject({ providerTurns: { observed: 1 }, tokens: { observed: 100 } });
    } else {
      expect(h.sent).toHaveLength(1);
    }
    expect(h.decisions).toEqual([]);
  });

  it('a settlement that has landed when the request would leave: zero POSTs and the reservation released', async () => {
    const h = parentAtNinety(0);
    expect(await h.ask('r1')).toEqual({ kind: 'none', reason: 'budget-limit-reached' });
    expect(h.sent).toEqual([]);
    expect(h.gate.facts('r1')).toMatchObject({ providerTurns: { observed: 1 }, tokens: { observed: 100 } });
    expect(h.decisions).toEqual([]);
  });

  it('a parent with room left sends exactly one request', async () => {
    const h = setup({ limits: { tokens: 100, providerTurns: 10 } });
    h.gate.begin('r1');
    h.meter.beginUsageUnit({ usageUnitId: 'u-parent', requestId: 'r1', agentId: 'dev' }, 'request');
    h.meter.noteModelRequest('u-parent');
    h.meter.settleUsageUnit('u-parent', { inputTokens: 40, outputTokens: 10 });
    expect(await h.ask('r1')).toMatchObject({ kind: 'suggestion' });
    expect(h.sent).toHaveLength(1);
    expect(h.factsAtSend[0]).toMatchObject({ tokens: { observed: 50 }, providerTurns: { observed: 2 } });
  });
});

