import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { contributedSettingProperties } from '../contributedSettings';
import {
  AUTHORITY_SETTING_KEYS,
  ignoredWorkspaceAuthorityKeys,
  isUserExplicitAuthoritySetting,
  readImageGenerationConnection,
  readImageGenerationModel,
  readReplySuggestionModel,
  readTranscriptionDefault,
  readUnodeSetting,
  readUserAuthoritySetting,
} from '../AuthoritySettings';

function configuration(values: {
  normal?: unknown;
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}) {
  return {
    get: <T>(_key: string, fallback: T) => (values.normal === undefined ? fallback : values.normal as T),
    inspect: <T>(_key: string) => ({
      defaultValue: values.defaultValue as T | undefined,
      globalValue: values.globalValue as T | undefined,
      workspaceValue: values.workspaceValue as T | undefined,
      workspaceFolderValue: values.workspaceFolderValue as T | undefined,
    }),
  };
}

describe('authority-bearing settings', () => {
  it('uses the global value and ignores more specific repository values', () => {
    expect(readUserAuthoritySetting(configuration({
      defaultValue: 'ask',
      globalValue: 'allowlist',
      workspaceValue: 'all',
      workspaceFolderValue: 'all',
    }), 'commandApproval', 'none')).toBe('allowlist');
  });

  it('uses the manifest default when no global value exists', () => {
    expect(readUserAuthoritySetting(configuration({
      defaultValue: 'ask',
      workspaceValue: 'all',
    }), 'commandApproval', 'none')).toBe('ask');
  });

  it('preserves ordinary VS Code precedence for non-authority settings', () => {
    expect(readUnodeSetting(configuration({ normal: 'debug', workspaceValue: 'debug' }), 'logLevel', 'info')).toBe('debug');
  });

  // v0.9.89 §6.2/§13.2: a workspace or repository can neither enable a spend reminder nor pick its reference.
  it('reads spend targets and the reference mode from User Settings only', () => {
    expect(readUnodeSetting(configuration({
      defaultValue: { schemaVersion: 1 },
      workspaceValue: { schemaVersion: 1, request: { tokens: 1 } },
    }), 'spend.targets', {})).toEqual({ schemaVersion: 1 });
    expect(readUnodeSetting(configuration({
      defaultValue: 'unselected',
      workspaceFolderValue: 'roam',
    }), 'spend.referencePriceMode', 'unselected')).toBe('unselected');
  });

  // v0.9.94: a repository can neither raise nor remove a request limit the person set.
  it('reads the request limits from User Settings only', () => {
    expect(readUnodeSetting(configuration({
      globalValue: 20,
      workspaceValue: 2000,
    }), 'requestLimits.providerTurns', null)).toBe(20);
    expect(readUnodeSetting(configuration({
      defaultValue: null,
      workspaceFolderValue: 5,
    }), 'requestLimits.tokens', null)).toBeNull();
  });

  it('audits the complete manifest class', () => {
    // v0.9.100 adds the User-owned Autonomy default; repositories cannot enable it.
    // v0.9.108 adds the image-generation connection choice, the Word tracked-change default and author name.
    // v0.9.110 adds the reply suggestion model.
    expect(AUTHORITY_SETTING_KEYS).toHaveLength(53);
    expect(AUTHORITY_SETTING_KEYS).toContain('replySuggestions.model');
    expect(AUTHORITY_SETTING_KEYS).toContain('imageGenerationConnection');
    expect(AUTHORITY_SETTING_KEYS).toContain('office.trackChangesDefault');
    expect(AUTHORITY_SETTING_KEYS).toContain('office.authorName');
    expect(AUTHORITY_SETTING_KEYS).toContain('autonomy');
    expect(AUTHORITY_SETTING_KEYS).toContain('claudeCliPath');
    expect(new Set(AUTHORITY_SETTING_KEYS).size).toBe(AUTHORITY_SETTING_KEYS.length);
  });

  it('rejects a hostile repository value for every authority-bearing setting', () => {
    for (const key of AUTHORITY_SETTING_KEYS) {
      expect(readUnodeSetting(configuration({
        defaultValue: 'safe',
        globalValue: 'user',
        workspaceValue: 'hostile-workspace',
        workspaceFolderValue: 'hostile-folder',
      }), key, 'fallback')).toBe('user');
    }
  });

  it('reports repository values that will be ignored', () => {
    expect(ignoredWorkspaceAuthorityKeys(configuration({ workspaceValue: 'hostile' })))
      .toEqual(AUTHORITY_SETTING_KEYS);
    expect(ignoredWorkspaceAuthorityKeys(configuration({}))).toEqual([]);
  });

  it('keeps the runtime list, restricted configuration list, and application scopes identical', () => {
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } };
      contributes: unknown;
    };
    const expected = AUTHORITY_SETTING_KEYS.map((key) => `unode.${key}`).sort();
    expect([...manifest.capabilities.untrustedWorkspaces.restrictedConfigurations].sort()).toEqual(expected);
    // The v0.9.107 image connection keeps its approved machine scope; like application scope it has no workspace layer.
    const machineMediaSettings = ['unode.imageGenerationConnection', 'unode.imageGenerationModel', 'unode.transcriptionDefault',
      // v0.9.110: the reply suggestion destination has the same machine scope as the transcription default.
      'unode.replySuggestions.model'];
    const userOnlyScope = (key: string, scope: string | undefined) => scope === 'application'
      || (machineMediaSettings.includes(key) && scope === 'machine');
    expect(expected.filter((key) => !userOnlyScope(key, (contributedSettingProperties(manifest.contributes) as Record<string, { scope?: string } | undefined>)[key]?.scope))).toEqual([]);
  });

  // v0.9.108: "explicit" is where the value came from, not whether it differs from the default.
  it('counts only a User Settings value as the person\'s explicit choice', () => {
    expect(isUserExplicitAuthoritySetting(configuration({ defaultValue: 'all', globalValue: 'ask' }), 'commandApproval')).toBe(true);
    expect(isUserExplicitAuthoritySetting(configuration({ defaultValue: 'all', globalValue: 'all' }), 'commandApproval')).toBe(true);
    expect(isUserExplicitAuthoritySetting(configuration({ defaultValue: 'all' }), 'commandApproval')).toBe(false);
    expect(isUserExplicitAuthoritySetting(configuration({ defaultValue: 'allow', workspaceValue: 'off' }), 'webAccess')).toBe(false);
    expect(isUserExplicitAuthoritySetting(configuration({ defaultValue: 'none', workspaceFolderValue: 'ask' }), 'writeApproval')).toBe(false);
    expect(isUserExplicitAuthoritySetting({ inspect: () => undefined }, 'webAccess')).toBe(false);
  });

  it('reads the image-generation connection from User Settings only; empty or absent is None', () => {
    expect(readImageGenerationConnection(configuration({ defaultValue: '', globalValue: 'openai-images' }))).toBe('openai-images');
    expect(readImageGenerationConnection(configuration({ defaultValue: '', globalValue: 'openai-images', workspaceValue: 'repo-images' })))
      .toBe('openai-images');
    expect(readImageGenerationConnection(configuration({ defaultValue: '', workspaceValue: 'repo-images', workspaceFolderValue: 'folder-images' })))
      .toBeUndefined();
    expect(readImageGenerationConnection(configuration({ defaultValue: '', globalValue: '' }))).toBeUndefined();
    expect(readImageGenerationConnection(configuration({ defaultValue: '', globalValue: '   ' }))).toBeUndefined();
    expect(readImageGenerationConnection(configuration({ defaultValue: '' }))).toBeUndefined();
    expect(readImageGenerationConnection(configuration({}))).toBeUndefined();
    expect(readImageGenerationConnection(configuration({ globalValue: 42 }))).toBeUndefined();
  });

  it('keeps the legacy image model for a missing model choice and reads new defaults from User Settings only', () => {
    expect(readImageGenerationModel(configuration({ workspaceValue: 'repo-image' }))).toBe('gpt-image-2.6-flare');
    expect(readImageGenerationModel(configuration({ globalValue: 'gpt-image-2', workspaceValue: 'repo-image' }))).toBe('gpt-image-2');
    const chosen = { connectionId: 'unode', modelId: 'gpt-transcribe' };
    expect(readTranscriptionDefault(configuration({ workspaceValue: chosen }))).toBeUndefined();
    expect(readTranscriptionDefault(configuration({ globalValue: null, workspaceValue: chosen }))).toBeUndefined();
    expect(readTranscriptionDefault(configuration({ globalValue: chosen }))).toEqual(chosen);
    expect(readTranscriptionDefault(configuration({ globalValue: { ...chosen, endpoint: 'https://example.test' } }))).toBeUndefined();
  });

  // v0.9.110: a repository can neither choose nor redirect where reply suggestions are sent and billed.
  it('reads the reply suggestion model from User Settings only, and only as a connection and exact model', () => {
    const chosen = { connectionId: 'unode', modelId: 'gpt-5.5-mini' };
    expect(readReplySuggestionModel(configuration({ defaultValue: null }))).toBeUndefined();
    expect(readReplySuggestionModel(configuration({ defaultValue: null, workspaceValue: chosen }))).toBeUndefined();
    expect(readReplySuggestionModel(configuration({ defaultValue: null, workspaceFolderValue: chosen }))).toBeUndefined();
    expect(readReplySuggestionModel(configuration({ globalValue: null, workspaceValue: chosen }))).toBeUndefined();
    expect(readReplySuggestionModel(configuration({ globalValue: chosen }))).toEqual(chosen);
    expect(readReplySuggestionModel(configuration({ globalValue: { ...chosen, baseUrl: 'https://example.test' } }))).toBeUndefined();
    expect(readReplySuggestionModel(configuration({ globalValue: { connectionId: 'unode', modelId: '  ' } }))).toBeUndefined();
    expect(readReplySuggestionModel(configuration({ globalValue: { connectionId: '', modelId: 'm' } }))).toBeUndefined();
  });
});
