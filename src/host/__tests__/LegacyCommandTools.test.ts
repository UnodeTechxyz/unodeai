import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { migrateLegacyCommandTools, legacyCommandMigrationNotice } from '../LegacyCommandTools';
import { AgentConfigBuilder } from '../../roles/RoleConfig';
import { codexWriteCapable } from '../../backend/CodexPermissionProfile';
import { ClaudeHeadlessBackend } from '../../backend/ClaudeHeadlessBackend';

function legacy() {
  const config = new AgentConfigBuilder().fromTemplate('contract-analyst').build();
  delete config.executePreference; delete config.builtinToolDefaultsRevision;
  config.allowedTools = ['read', 'message']; return config;
}
describe('silent old built-in command migration', () => {
  it('keeps absent tools unrestricted on Claude and writable on Codex, without counting an addition', () => {
    const absent = legacy(); delete absent.allowedTools;
    const existing = legacy(); existing.allowedTools = ['read', 'write', 'execute'];
    const result = migrateLegacyCommandTools([absent, existing, legacy()]);
    expect(result.added).toBe(1); expect(legacyCommandMigrationNotice(result.added)).toMatch(/^1 agents/);
    expect(result.members[0].allowedTools).toBeUndefined(); expect(result.members[0].executePreference).toBe('template');
    const backend = new ClaudeHeadlessBackend({ ...result.members[0], workingDirectory: process.cwd() });
    expect((backend as any).disallowedNativeTools()).not.toContain('Write');
    expect(codexWriteCapable(result.members[0].allowedTools, result.members[0].toolCeiling)).toBe(true);
    expect(result.members[1].allowedTools).toEqual(['execute', 'read', 'write']);
  });
  it('adds only template execute without changing the supplied record, and is idempotent', () => {
    const before = legacy(); const migrated = migrateLegacyCommandTools([before]);
    expect(migrated).toMatchObject({ changed: true, added: 1 });
    expect(migrated.members[0]).toEqual({ ...before, executePreference: 'template', builtinToolDefaultsRevision: 1,
      allowedTools: ['execute', 'message', 'read'] });
    expect(before.allowedTools).toEqual(['read', 'message']);
    expect(migrateLegacyCommandTools(migrated.members)).toEqual({ members: migrated.members, changed: false, added: 0 });
    expect(legacyCommandMigrationNotice(1)).toContain('Turn it off per agent in Agent Builder.');
  });
  it.each(['template', 'allow', 'deny'] as const)('preserves explicit %s exactly', preference => {
    const config = { ...legacy(), executePreference: preference };
    expect(migrateLegacyCommandTools([config])).toEqual({ members: [config], changed: false, added: 0 });
  });
  it('never alters custom or unknown roles', () => {
    const custom = legacy(); delete custom.roleTemplateKey;
    const unknown = { ...legacy(), roleTemplateKey: '__proto__' };
    expect(migrateLegacyCommandTools([custom, unknown])).toEqual({ members: [custom, unknown], changed: false, added: 0 });
  });
  it('both actual load paths migrate, while the old prompt, lifecycle triggers and settings action are gone', () => {
    const source = readFileSync('src/extension.ts', 'utf8');
    expect(source).toContain('migrateLegacyCommandTools(agents)');
    expect(source.includes('migrateLegacyCommandTools(agentRosterEdits.overlayUnsavedOff(document.members))')).toBe(true);
    expect(source).not.toContain('reviewLegacyCommandTools');
    expect(source).not.toContain('chooseLegacyCommandTools');
    expect(readFileSync('src/views/SettingsPanel.ts', 'utf8')).not.toContain('reviewLegacyCommandTools');
  });
});
