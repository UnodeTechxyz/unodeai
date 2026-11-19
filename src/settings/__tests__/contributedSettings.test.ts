import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contributedSettingProperties } from '../contributedSettings';

const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  contributes: { configuration: Array<{ title: string; properties: Record<string, { type?: unknown; scope?: string; default?: unknown }> }> };
};

/**
 * Every setting the manifest declared before v0.9.106 split it into two sections: key, type, scope and default, as
 * they were at main ab7ec806. The split moves keys between sections only; none is renamed, removed or changed.
 */
const DECLARED_BEFORE_SPLIT: ReadonlyArray<readonly [string, unknown, string | null, unknown]> = [
  ["unode.maxConcurrentAgents", "number", "application", 10],
  ["unode.logLevel", "string", null, "info"],
  ["unode.messageRetentionDays", "number", null, 7],
  ["unode.autoSaveInterval", "number", null, 60],
  ["unode.modelDefaults.temperature", "number", null, 0.7],
  ["unode.modelDefaults.topP", "number", null, 1],
  ["unode.modelDefaults.maxTokens", "integer", null, 32768],
  ["unode.modelDefaults.reasoningEffort", "string", null, "medium"],
  ["unode.modelDefaults.stream", "boolean", null, true],
  ["unode.modelDefaults.responseFormat", "string", null, ""],
  ["unode.smartMode.enabled", "boolean", "application", false],
  ["unode.smartMode.defaultTier", "string", "application", "standard"],
  ["unode.smartMode.roleTiers", "object", "application", {}],
  ["unode.smartMode.taskTierHints", "object", "application", {}],
  ["unode.modelTiers", "object", "application", {}],
  ["unode.modelTierParams", "object", "application", {}],
  ["unode.defaultProvider", "string", "application", "unode"],
  ["unode.customBaseUrl", "string", "application", ""],
  ["unode.baseUrl", "string", "application", ""],
  ["unode.unodeBaseUrl", "string", "application", "https://www.unodetech.xyz/v1"],
  ["unode.modelCatalogUrl", "string", "application", ""],
  ["unode.extraModels", "object", null, {}],
  ["unode.modelPrices", "object", "application", {}],
  ["unode.pricingSources", "array", "application", []],
  ["unode.priceGroup", null, "application", ""],
  ["unode.lowBalanceThresholdUsd", "number", null, 5],
  ["unode.additionalRoots", "array", "application", []],
  ["unode.localReadScope", "string", "application", "parent"],
  ["unode.claudeCliPath", "string", "application", ""],
  ["unode.codexCliPath", "string", "application", ""],
  ["unode.concurrencyStrategy", "string", "application", "optimistic"],
  ["unode.verifyCommand", "string", "application", ""],
  ["unode.gate.enabled", "boolean", "application", true],
  ["unode.allowCrossProviderDispatchWithoutApproval", "boolean", "application", true],
  ["unode.gate.maxSelfRetries", "number", "application", 2],
  ["unode.gate.maxRedelegations", "number", "application", 1],
  ["unode.autonomy", "string", "application", "workspace"],
  ["unode.commandApproval", "string", "application", "all"],
  ["unode.debug.promptedCommandLog", "boolean", "application", false],
  ["unode.allowedCommands", "array", "application", []],
  ["unode.writeApproval", "string", "application", "none"],
  ["unode.notifications.resultStyle", "string", "application", "quiet"],
  ["unode.spend.targets", "object", "application", {"schemaVersion":1}],
  ["unode.spend.referencePriceMode", "string", "application", "unselected"],
  ["unode.requestLimits.providerTurns", ["integer","null"], "application", null],
  ["unode.requestLimits.tokens", ["integer","null"], "application", null],
  ["unode.attentionSound", "boolean", "application", true],
  ["unode.webAccess", "string", "application", "allow"],
  ["unode.engine.postWriteDiagnostics", "boolean", "application", true],
  ["unode.executionHooks", "array", null, []],
  ["unode.engine.verifyObligation", "boolean", "application", true],
  ["unode.engine.workspaceContext", "boolean", "application", false],
  ["unode.marketplace.fetchCatalog", "boolean", "application", false],
  ["unode.worktree.autoMerge", "boolean", "application", false],
  ["unode.worktree.maxParallel", "number", "application", 4],
  ["unode.worktree.verifyBeforeMerge", "boolean", "application", true],
  ["unode.worktree.verifyTimeoutSeconds", "number", "application", 300],
  ["unode.marketplace.catalogUrl", "string", "application", "https://raw.githubusercontent.com/UnodeTechxyz/unode-skills/main/catalog.json"],
  ["unode.marketplace.skillLibraryUrl", "string", "application", "https://github.com/UnodeTechxyz/unode-skills"],
  ["unode.chatParticipant.enabled", "boolean", null, true],
  ["unode.chat.smoothStreaming", "boolean", null, true],
  ["unode.workbench.autoOpen", "boolean", null, true],
  ["unode.priceMultiplier", null, "application", {}],
];

/** The design's twelve main keys (v0.9.106 consolidated design §8.2). */
const MAIN_KEYS = [
  'unode.defaultProvider', 'unode.maxConcurrentAgents', 'unode.verifyCommand', 'unode.gate.enabled', 'unode.autonomy',
  'unode.commandApproval', 'unode.writeApproval', 'unode.webAccess', 'unode.notifications.resultStyle',
  'unode.attentionSound', 'unode.requestLimits.providerTurns', 'unode.requestLimits.tokens',
];

describe('contributedSettingProperties', () => {
  it('reads one section given as an object, the form before v0.9.106', () => {
    expect(contributedSettingProperties({ configuration: { title: 'T', properties: { 'unode.a': { default: 1 } } } }))
      .toEqual({ 'unode.a': { default: 1 } });
  });

  it('reads every section given as an array', () => {
    expect(contributedSettingProperties({ configuration: [
      { title: 'A', properties: { 'unode.a': { default: 1 } } },
      { title: 'B', properties: { 'unode.b': { default: 2 } } },
    ] })).toEqual({ 'unode.a': { default: 1 }, 'unode.b': { default: 2 } });
  });

  it('answers no keys for a manifest without settings', () => {
    expect(contributedSettingProperties(undefined)).toEqual({});
    expect(contributedSettingProperties({})).toEqual({});
    expect(contributedSettingProperties({ configuration: [{ title: 'A' }] })).toEqual({});
  });
});

describe('readers of the declared settings', () => {
  it('the roam.* → unode.* migration reads every section', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    const migration = source.slice(source.indexOf('async function migrateRoamSettingsToUnode('), source.indexOf("const oldCfg = vscode.workspace.getConfiguration('roam');"));
    expect(migration).toContain('const props = contributedSettingProperties(context.extension?.packageJSON?.contributes);');
  });

  it('no source, script or end-to-end test reads one section\'s properties directly (an array has none)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (statSync(file).isDirectory()) { if (name !== 'node_modules') walk(file); continue; }
        if (!/\.(ts|mjs|cjs|js)$/.test(name)) continue;
        if (/configuration\??\.properties/.test(readFileSync(file, 'utf8'))) offenders.push(file);
      }
    };
    for (const dir of ['src', 'scripts', 'test-e2e']) walk(join(process.cwd(), dir));
    // This test names the pattern in its own regular expression.
    expect(offenders.filter((file) => !file.endsWith('contributedSettings.test.ts'))).toEqual([]);
  });
});

describe('v0.9.106 native settings: UnodeAi and UnodeAi › Advanced', () => {
  it('has exactly two sections, the twelve main keys first and every other key in Advanced', () => {
    const sections = manifest.contributes.configuration;
    expect(sections.map((section) => section.title)).toEqual(['UnodeAi', 'UnodeAi › Advanced']);
    expect(Object.keys(sections[0].properties).sort()).toEqual([...MAIN_KEYS].sort());
    const advanced = Object.keys(sections[1].properties);
    expect(advanced).toHaveLength(DECLARED_BEFORE_SPLIT.length - MAIN_KEYS.length);
    expect(advanced.filter((key) => MAIN_KEYS.includes(key))).toEqual([]);
  });

  it('keeps every key, with its type, scope and default, and adds none', () => {
    const declared = contributedSettingProperties(manifest.contributes) as Record<string, { type?: unknown; scope?: string; default?: unknown }>;
    expect(Object.keys(declared)).toHaveLength(63);
    expect(Object.keys(declared).sort()).toEqual(DECLARED_BEFORE_SPLIT.map(([key]) => key).sort());
    for (const [key, type, scope, defaultValue] of DECLARED_BEFORE_SPLIT) {
      const property = declared[key];
      expect(property.type ?? null, `${key} type`).toEqual(type);
      expect(property.scope ?? null, `${key} scope`).toBe(scope);
      expect(property.default === undefined ? '<none>' : property.default, `${key} default`).toEqual(defaultValue);
    }
  });

  it('declares each key in exactly one section', () => {
    const all = manifest.contributes.configuration.flatMap((section) => Object.keys(section.properties));
    expect(new Set(all).size).toBe(all.length);
  });
});
