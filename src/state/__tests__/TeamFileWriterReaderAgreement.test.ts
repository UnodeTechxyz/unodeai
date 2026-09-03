import { describe, expect, it, vi } from 'vitest';

// PersistenceManager reaches vscode at module scope; only its pure serializer is exercised here.
vi.mock('vscode', () => ({
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
  FileType: { File: 1, Directory: 2 },
  workspace: { workspaceFolders: undefined, fs: {} },
  window: { showWarningMessage: vi.fn() },
}));

import { AGENT_CONFIG_FIELDS, validateTeamFile } from '../TeamFileSchema';
import { serializeVersionedTeamFile } from '../PersistenceManager';
import { AgentConfigBuilder, ROLE_TEMPLATES } from '../../roles/RoleConfig';
import type { AgentConfig } from '../../types';

/**
 * The writer and the reader must agree about the same format.
 *
 * They did not. `AgentConfigBuilder.fromTemplate` spread whole `RoleTemplate` objects into agent configs,
 * so every agent built from a shipped template carried `modelRationale` and `modelOverride` — neither of
 * which is an `AgentConfig` field. `serializeVersionedTeamFile` wrote them out, and `validateTeamFile`
 * rejected the result as containing unsupported fields. The roster survived only because it also lives in
 * workspace state, so nothing visibly broke until saved teams needed to read a team file back and the
 * picker reported that none existed.
 *
 * This test is against every shipped template rather than a fixture, because the defect was in the ones
 * that ship. A fixture built by hand would have passed the whole time.
 */

function agentFromTemplate(key: string): AgentConfig {
  return new AgentConfigBuilder()
    .fromTemplate(key as keyof typeof ROLE_TEMPLATES)
    .setId(`agent-${key}`)
    .build();
}

describe('a team file this code writes is a team file this code can read', () => {
  const keys = Object.keys(ROLE_TEMPLATES);

  it('has role templates to check', () => {
    expect(keys.length).toBeGreaterThan(20);
  });

  it.each(keys)('round-trips an agent built from the %s template', (key) => {
    const serialized = serializeVersionedTeamFile({
      version: '1.0', members: [agentFromTemplate(key)], mcpServers: [], workflows: [],
    });

    // The assertion that matters: the reader accepts it. Before the fix this threw
    // "contains unsupported fields: modelOverride, modelRationale" for every shipped template.
    const document = validateTeamFile(JSON.parse(serialized));
    expect(document.members).toHaveLength(1);
    expect(document.members[0].id).toBe(`agent-${key}`);
  });

  // The rule stated once, so a future field that leaks in from anywhere fails here rather than in a picker.
  it('writes no field its own reader would refuse, for any shipped template', () => {
    const written = new Set<string>();
    for (const key of keys) {
      const serialized = JSON.parse(serializeVersionedTeamFile({
        version: '1.0', members: [agentFromTemplate(key)], mcpServers: [], workflows: [],
      })) as { members: Record<string, unknown>[] };
      for (const field of Object.keys(serialized.members[0])) {
        written.add(field);
      }
    }
    expect([...written].filter((field) => !AGENT_CONFIG_FIELDS.has(field))).toEqual([]);
  });

  /**
   * A runtime object can still gain a key from somewhere this test does not reach. The writer drops it at
   * the boundary rather than trusting that nothing ever will — one layer fixes today's leak, two fix the
   * class of leak.
   */
  it('drops a stray runtime field instead of writing a file it cannot read back', () => {
    const polluted = { ...agentFromTemplate(keys[0]), somethingAddedLater: 'x' } as AgentConfig;

    const serialized = serializeVersionedTeamFile({
      version: '1.0', members: [polluted], mcpServers: [], workflows: [],
    });

    expect(serialized).not.toContain('somethingAddedLater');
    expect(() => validateTeamFile(JSON.parse(serialized))).not.toThrow();
  });

  // Two fields are deliberately answered `false`. `routeRepair` is host-authored, so a workspace file
  // asserting one would claim a repair state the host did not decide. `workingDirectory` is refused by every
  // creation path already (`dialogs.presets.test.ts`) because a directory pinned at save time goes stale —
  // persisting it here would let a legacy or hand-written file put the pin back.
  it('never persists a host-authored repair note or a pinned working directory', () => {
    expect(AGENT_CONFIG_FIELDS.has('routeRepair')).toBe(false);
    expect(AGENT_CONFIG_FIELDS.has('workingDirectory')).toBe(false);
  });

  it('drops a working directory a hand-written file tried to pin, and says it dropped it', () => {
    const pinned = { ...agentFromTemplate(keys[0]), workingDirectory: 'C:/somebody-elses/checkout' } as AgentConfig;

    const serialized = serializeVersionedTeamFile({
      version: '1.0', members: [pinned], mcpServers: [], workflows: [],
    });
    expect(serialized).not.toContain('somebody-elses');

    const read = validateTeamFile({ members: [{ ...JSON.parse(serialized).members[0], workingDirectory: 'C:/stale' }] });
    expect(read.members[0]).not.toHaveProperty('workingDirectory');
    expect(read.validationWarnings?.join(' ')).toMatch(/dropped unsupported field.*workingDirectory/);
  });
});
