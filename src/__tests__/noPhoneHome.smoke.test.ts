/*---------------------------------------------------------------------------------------------
 *  No-phone-home smoke test.
 *
 *  A previous release of this extension was pulled from a registry as malware. We were never told why,
 *  but there is one behaviour in the code that fits: v0.9.29 called `refreshPrices()` unconditionally from
 *  `activate()`, so installing the extension — with no API key, no configured provider, and no approved
 *  host — produced an immediate outbound request to two vendor gateways the moment VS Code finished
 *  starting. Install → unsolicited vendor beacon is the behavioural signature of unwanted software, and it
 *  contradicted this extension's own published promise ("no telemetry, no other network destinations").
 *
 *  The rule is now a pure function, `consentedSources` (a convenience fetch may RIDE ON a host the user
 *  already approved; it may never INITIATE one), and its behaviour is unit-tested in LivePriceService.test.
 *  This file guards the thing a unit test cannot: that no FUTURE caller quietly skips it.
 *
 *  This is a lint, not a proof. It cannot see a phone-home written some entirely new way — it only ensures
 *  the two network conveniences we have keep going through the gate. Its real job is to make the omission
 *  loud at the moment someone adds the third.
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

/** All production .ts source (excludes tests, compiled output, deps). */
function productionSources(): Array<{ f: string; text: string }> {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (['__tests__', 'node_modules'].includes(e.name)) { continue; }
        walk(p);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        out.push(p);
      }
    }
  })(join(ROOT, 'src'));
  return out.map((f) => ({ f: f.replace(ROOT, '.'), text: readFileSync(f, 'utf8') }));
}
const SRC = productionSources();
const DENYLIST_DECLARATION = 'src/backend/CodexBackend.ts';

function codexBannedFlagOffenders(sources: Array<{ f: string; text: string }>, forbidden: string): string[] {
  return sources
    .filter(({ f, text }) => f.replace(/\\/g, '/').endsWith(DENYLIST_DECLARATION) === false && text.includes(forbidden))
    .map(({ f }) => f);
}

describe('legacy Codex implementation source guard', () => {
  // Three distinct layers protect this invariant. The runtime argv assertion is the boundary; behaviour
  // tests cover the supported configuration space; this grep is only a lint that makes wild literals loud.
  // Do not delete the boundary merely because this source-level check is green.
  it('contains no escape hatch from the read-only Codex sandbox', () => {
    for (const forbidden of ['danger-full-access', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust']) {
      const offenders = codexBannedFlagOffenders(SRC, forbidden);
      expect(offenders, `${forbidden} must not appear in production source`).toEqual([]);
    }
  });

  it('flags a banned literal outside the CodexBackend declaration', () => {
    const offenders = codexBannedFlagOffenders([
      { f: 'src/backend/CodexBackend.ts', text: 'danger-full-access' },
      { f: 'src/futurePath.ts', text: 'danger-full-access' },
    ], 'danger-full-access');
    expect(offenders).toEqual(['src/futurePath.ts']);
  });
});

/**
 * A setting that names something we EXECUTE, or a host we CONNECT to, must never be settable by the
 * repository you just opened.
 *
 * `restrictedConfigurations` is the mechanism VS Code gives us for exactly this, and our own manifest says so:
 * *"prevents workspace-supplied config … from executing code … without your consent."*
 *
 * v0.9.30 added `unode.codexCliPath` — the absolute path of a binary we SPAWN — and did not restrict it.
 * `verifyCodexCli` runs `<binary> --version` **before** it validates the version, so the binary executes
 * first and is judged second: a repo shipping `.vscode/settings.json` (naming any absolute path) plus a
 * `.unode/team.json` agent with `backend: "codex"` (which the schema now accepts) would have that binary run
 * on preflight. `unode.verifyCommand` — which names only a *command* — was already restricted; a setting that
 * names a *binary* is strictly more dangerous.
 *
 * This test asserts the RULE, not the instance: every setting whose value is a path we execute or a host we
 * contact must be in the list. Fixing the one we found and not the class is how the next one gets in.
 */
describe('workspace-supplied settings cannot choose what we execute or where we connect', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const restricted: string[] = pkg.capabilities.untrustedWorkspaces.restrictedConfigurations;

  it.each([
    ['unode.codexCliPath', 'names a binary we spawn'],
    ['unode.verifyCommand', 'names a command we run'],
    ['unode.allowedCommands', 'widens what may be run'],
    ['unode.commandApproval', 'can disable the approval prompt'],
    ['unode.additionalRoots', 'widens what we may read'],
    ['unode.baseUrl', 'names a host we send prompts to'],
    ['unode.unodeBaseUrl', 'names a host we send prompts to'],
    ['unode.defaultProvider', 'chooses which connection new agents route prompts through'],
    ['unode.pricingSources', 'names hosts we contact'],
    ['unode.modelCatalogUrl', 'names a host we contact'],
    ['unode.marketplace.catalogUrl', 'names a host we contact'],
    ['unode.marketplace.skillLibraryUrl', 'names a URL we hand to openExternal'],
  ])('%s is restricted in an untrusted workspace (%s)', (setting) => {
    expect(restricted, `${setting} must be in capabilities.untrustedWorkspaces.restrictedConfigurations`)
      .toContain(setting);
  });
});

/**
 * Every service that reaches the network for METADATA — prices, balance, the model catalog. Each is
 * constructed with an injected fetch, and each must be given the CONSENT-GATED one.
 *
 * The gate is on the fetch rather than on the callers, so this test checks CONSTRUCTION, not call sites.
 * That distinction is the whole lesson of the second review round: the first fix guarded the price call
 * site, and ModelCatalog — a service nobody thought about — fetched `{base}/models` and a configurable
 * catalog URL straight past it. Guard construction and a service is gated by default; guard call sites and
 * the next service someone adds is ungated by default.
 */
const METADATA_SERVICES = ['LivePriceService', 'BalanceService', 'ModelCatalog'];

describe('no phone-home: the extension performs no network request on a fresh install', () => {
  it('a forged Coming soon Codex model-picker request stops before consent, pricing, or catalog work', () => {
    const ext = SRC.find(({ f }) => f.endsWith('extension.ts'))!;
    const body = /async function agentBuilderListModels[\s\S]*?\n}/.exec(ext.text)?.[0] ?? '';
    expect(body, 'agentBuilderListModels must exist').not.toBe('');
    const unavailableGuard = body.indexOf("profile.availability !== 'available'");
    const firstMetadataStep = Math.min(
      ...['ensureModelPickerConsent', 'refreshPrices', 'modelCatalog.list']
        .map((needle) => body.indexOf(needle))
        .filter((index) => index >= 0)
    );
    expect(unavailableGuard, 'Coming soon routes must be rejected before metadata egress work begins').toBeGreaterThanOrEqual(0);
    expect(unavailableGuard).toBeLessThan(firstMetadataStep);
  });

  it('the generalized Test connection contacts the network only through consent + the gated fetch', () => {
    // Test connection is a direct egress site for every registered API-key/OpenAI-models connection. The
    // extension must inject its registry-scoped consent function and metadataFetch (consentGatedFetch), while
    // the runner must seek consent before invoking that fetch. Pin both halves so extracting the testable
    // runner cannot accidentally turn dependency injection into a way to supply the raw global fetch.
    const ext = SRC.find(({ f }) => f.endsWith('extension.ts'))!;
    const body = /async function testConnection[\s\S]*?\n}/.exec(ext.text)?.[0] ?? '';
    expect(body, 'testConnection must exist').not.toBe('');
    expect(body).toMatch(/testApiKeyConnection\(connectionId/);
    expect(body).toMatch(/ensureConsent: ensureModelPickerConsent/);
    expect(body).toMatch(/\n    metadataFetch,/);
    expect(body, 'Test connection must not call a raw fetch')
      .not.toMatch(/[^\w.]fetch\(|globalThis[\s\S]*?\.fetch/);

    const runnerSource = SRC.find(({ f }) => f.replace(/\\/g, '/').endsWith('/connections/ConnectionTest.ts'))!;
    const runner = /export async function testApiKeyConnection[\s\S]*?\n}/.exec(runnerSource.text)?.[0] ?? '';
    expect(runner, 'testApiKeyConnection must exist').not.toBe('');
    const consent = runner.indexOf('await deps.ensureConsent');
    const gatedFetch = runner.indexOf('await deps.metadataFetch');
    expect(consent, 'Test connection must gate on ensureModelPickerConsent before contacting the gateway').toBeGreaterThanOrEqual(0);
    expect(gatedFetch, 'Test connection must reach the gateway through metadataFetch, after consent').toBeGreaterThan(consent);
    expect(runner, 'Test connection must not call a raw fetch (metadataFetch is the only permitted egress)')
      .not.toMatch(/[^\w.]fetch\(|globalThis[\s\S]*?\.fetch/);
  });

  it('every metadata service is constructed with the consent-gated fetch, never the raw one', () => {
    const ext = SRC.find(({ f }) => f.endsWith('extension.ts'))!;

    for (const service of METADATA_SERVICES) {
      // The constructor call, from `new Service(` to the line that closes it.
      const ctor = new RegExp(`new ${service}\\([\\s\\S]*?\\n {2}\\);`).exec(ext.text)?.[0];
      expect(ctor, `${service} should be constructed in extension.ts`).toBeTruthy();
      expect(ctor,
        `${service} is constructed with a raw fetch. Every metadata request must go through metadataFetch `
        + '(consentGatedFetch), which refuses any host the user has not approved. A service handed the raw '
        + 'global fetch can reach the network on a fresh install — the behaviour that got a previous release '
        + 'delisted, and the exact way ModelCatalog slipped past the first version of this fix.'
      ).not.toMatch(/globalThis as any\)\.fetch|globalThis\.fetch/);
      expect(ctor).toMatch(/metadataFetch/);
    }
  });

  it('metadataFetch is the consent-gated fetch, and nothing else re-wraps the raw fetch for metadata', () => {
    const ext = SRC.find(({ f }) => f.endsWith('extension.ts'))!;
    const transport = SRC.find(({ f }) => f.replace(/\\/g, '/').endsWith('/host/MetadataTransport.ts'))!;
    expect(ext.text).toMatch(/const metadataFetch = createMetadataTransport\(hasMetadataConsent\)/);
    expect(transport.text).toMatch(/return consentGatedFetch\(/);
    expect(transport.text).toMatch(/globalThis as any\)\.fetch/);
  });

  it('the consent predicate is READ-ONLY — it can never turn into a nag at launch', () => {
    const ext = SRC.find(({ f }) => f.endsWith('extension.ts'))!;
    // hasMetadataConsent answers; ensureMetadataConsent asks. If the predicate were ever implemented in
    // terms of the prompt, "skip silently in the background" would quietly become "modal on every startup".
    const body = /function hasMetadataConsent[\s\S]*?\n}/.exec(ext.text)?.[0] ?? '';
    expect(body, 'hasMetadataConsent must exist and must not prompt').not.toBe('');
    expect(body).not.toMatch(/ensureMetadataConsent|ensureEgressConsent|showWarningMessage|showInformationMessage/);
  });

  it('a model picker asks about ITS OWN provider, never every configured gateway', () => {
    const ext = SRC.find(({ f }) => f.endsWith('extension.ts'))!;
    const body = /async function ensureModelPickerConsent[\s\S]*?\n}/.exec(ext.text)?.[0] ?? '';
    expect(body, 'ensureModelPickerConsent must exist').not.toBe('');
    // It must derive its hosts from the provider-scoped plan, and it must not hand the whole pricingSources()
    // list to the prompt — that is what made opening the OpenAI picker prompt for weroam and unodetech.
    expect(body).toMatch(/planModelPicker\(/);
    expect(body,
      'the model picker must not ask about every configured price source — only the selected provider\'s own'
    ).not.toMatch(/planPriceRefresh|\(await pricingSources\(\)\)\.map/);
  });

  it('reads context-window metadata only from the already consented, user-triggered model-picker response', () => {
    const ext = SRC.find(({ f }) => f.endsWith('extension.ts'))!;
    const picker = /async function agentBuilderListModels[\s\S]*?\n}/.exec(ext.text)?.[0] ?? '';
    expect(picker, 'agentBuilderListModels must remain the user-triggered discovery path').not.toBe('');
    const consent = picker.indexOf('await ensureModelPickerConsent');
    const list = picker.indexOf('await getModelCatalog().list');
    const remember = picker.indexOf('discoveredContextWindows.set');
    expect(consent, 'context discovery must not occur before metadata consent').toBeGreaterThanOrEqual(0);
    expect(list, 'context discovery must read the existing /models response, not create a second probe').toBeGreaterThan(consent);
    expect(remember, 'only a completed model-list action may retain a context-window report').toBeGreaterThan(list);

    const parser = SRC.find(({ f }) => f.replace(/\\/g, '/').endsWith('/models/ContextWindowDiscovery.ts'))!;
    expect(parser.text, 'the parser is metadata-only and can never initiate a request itself')
      .not.toMatch(/fetch\(|https?:\/\//);
  });

  it('every picker path passes a provider scope to refreshPrices — standing consent is not an action-wide licence', () => {
    // Consent says which hosts may EVER be contacted; scope says which of those THIS action contacts.
    // Narrowing only the prompt left the fetch walking every configured gateway: a user who approved Roam
    // and Unode last week opened the OpenAI picker and silently sent both a price request. Each picker path
    // must therefore refresh with { scope: <its provider> }; only activation, the daily timer, and the
    // explicit Refresh command may run unscoped.
    const ext = SRC.find(({ f }) => f.endsWith('extension.ts'))!;
    // Count CODE, not commentary — the audit-log comments legitimately narrate the old unscoped call.
    const code = ext.text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const unscoped = [...code.matchAll(/refreshPrices\((?!\{|opts)/g)];
    // Allowed unscoped call sites: activation and the daily timer (deliberately all-source refreshes).
    expect(unscoped.length,
      'a new refreshPrices() call without a scope was added — picker/provider-specific paths must pass '
      + '{ scope: providerId }; only activation, the timer, and the explicit Refresh command run unscoped'
    ).toBeLessThanOrEqual(2);

    const dialogs = SRC.find(({ f }) => f.endsWith('dialogs.ts'))!;
    expect(dialogs.text,
      'the Add-Agent dialog picker must offer the same provider-scoped metadata consent as the main picker'
    ).toMatch(/await d\.ensureModelPickerConsent\(providerKey, resolvedBaseUrl\)/);
    expect(dialogs.text, 'the Add-Agent dialog picker must scope its price refresh to the selected provider')
      .toMatch(/refreshPrices\(\{ scope: providerKey \}\)/);
    // The legacy extension-local picker was removed; the active Agent Builder path resolves the
    // selected immutable connection id and scopes its refresh to that exact profile.
    expect(ext.text).toMatch(/refreshPrices\(\{ scope: connectionId \}\)/);  // agentBuilderListModels
  });

  it('activation does not refresh prices; the later background timer cannot open a modal', () => {
    const ext = SRC.find(({ f }) => f.endsWith('extension.ts'))!;
    const activationStart = ext.text.indexOf('export async function activate(');
    const activationEnd = ext.text.indexOf('\nexport function deactivate()', activationStart);
    const activation = ext.text.slice(activationStart, activationEnd);
    const timer = /setInterval\(\(\) => void refreshPrices\([^)]*\)/.exec(ext.text)?.[0] ?? '';
    expect(timer, 'the daily refreshPrices() timer should still exist').not.toBe('');
    expect(activation.replace(timer, ''), 'activation must not warm price metadata or prompt for it')
      .not.toMatch(/void refreshPrices\(/);
    expect(timer).not.toMatch(/interactive/);
  });

  it('metadata and media grants are never displayed as model-egress grants, and each is revoked on its own', () => {
    // The Security panel is where a user audits what they approved. Rendering a prices-only host inside the
    // "prompts + workspace files" list would tell them their code goes somewhere it does not — and a single
    // revoke button that silently deletes BOTH grants breaks the promise that they are separate.
    const panel = SRC.find(({ f }) => f.endsWith('SecurityPanel.ts'))!;
    expect(panel.text).toMatch(/metadataGrants/);
    expect(panel.text).toMatch(/no code is sent/i);
    expect(panel.text).toMatch(/data-kind=/);           // the row carries WHICH grant it is
    // The message parser must preserve every distinct grant kind. In particular, media must not fall
    // through to `model`, which would make revoking a vision/transcription approval over-broad.
    expect(panel.text).toMatch(/kind === 'metadata'.*kind === 'media'.*'model'/s);
  });

  it('the hosted skill catalog cannot merge unverified content — and verification is not opt-out', () => {
    // The one place remote content can influence what RUNS on the machine (an entry carries an MCP server's
    // stdio command + args). No signing key configured must mean the feature is off, not the check is off.
    const src = SRC.find(({ f }) => f.endsWith('catalogSource.ts'))!;
    expect(src.text).toMatch(/REJECTED/);   // unsigned → rejected, not merged-with-a-warning
    expect(src.text).toMatch(/disabled/);   // blank key → not even fetched
    expect(src.text).not.toMatch(/merging anyway/);

    // `verify` must stay REQUIRED. While it was optional the behaviour was still correct — both production
    // call sites passed a key — but the invariant rested on every future caller remembering an optional
    // field, and a caller who omitted it would silently re-accept unverified remote MCP command/args. An
    // invariant you can opt out of by omission is a convention, not an invariant.
    expect(src.text, '`verify` must not be optional on HostedCatalogOptions').not.toMatch(/verify\?:/);
    expect(src.text).toMatch(/verify: \{ publicKeyPem: string/);
    // ...and no branch may guard the verification block, which is how "optional" became "skippable".
    expect(src.text, 'signature verification must be unconditional, never inside `if (o.verify)`')
      .not.toMatch(/if \(o\.verify\) \{/);
  });
});
