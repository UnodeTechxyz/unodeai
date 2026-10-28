import { describe, expect, it } from 'vitest';
import { activeDocumentForSavedTeam } from '../TeamRosterRestore';
import { AgentConfigBuilder } from '../../roles/RoleConfig';
import type { TeamFileDocument } from '../TeamFileSchema';

const team = (): TeamFileDocument => ({ members: [new AgentConfigBuilder().fromTemplate('business-analyst').build()],
  workflows: [], mcpServers: [] });

describe('active document for a saved team', () => {
  it('removes the outgoing explicit policy when the saved source did not contain one', () => {
    const current = { ...team(), completionVerification: { mode: 'command' as const, command: 'npm run prior' } };
    const incoming = team(); const result = activeDocumentForSavedTeam(current, incoming);
    expect(result).not.toHaveProperty('completionVerification'); expect(current.completionVerification.command).toBe('npm run prior');
    expect(result.members).toEqual(incoming.members); expect(result.members).not.toBe(incoming.members);
  });

  it('copies only incoming members and raw check policy while retaining workspace-local configuration', () => {
    const current = { ...team(), smartCompactionProfiles: { software: { windowPercent: 40 } } } as TeamFileDocument;
    const incoming = { ...team(), completionVerification: { mode: 'disabled' as const } };
    const result = activeDocumentForSavedTeam(current, incoming);
    expect(result.completionVerification).toEqual({ mode: 'disabled' });
    expect(result.smartCompactionProfiles).toEqual(current.smartCompactionProfiles);
    expect(result.workflows).toEqual(current.workflows); expect(result.mcpServers).toEqual(current.mcpServers);
  });
});
