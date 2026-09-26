import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  AUTHORITY_SETTING_KEYS,
  ignoredWorkspaceAuthorityKeys,
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

  it('audits the complete manifest class', () => {
    expect(AUTHORITY_SETTING_KEYS).toHaveLength(40);
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
      contributes: { configuration: { properties: Record<string, { scope?: string }> } };
    };
    const expected = AUTHORITY_SETTING_KEYS.map((key) => `unode.${key}`).sort();
    expect([...manifest.capabilities.untrustedWorkspaces.restrictedConfigurations].sort()).toEqual(expected);
    expect(expected.filter((key) => manifest.contributes.configuration.properties[key]?.scope !== 'application')).toEqual([]);
  });
});
