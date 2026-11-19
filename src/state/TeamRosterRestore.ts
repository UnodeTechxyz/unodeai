import { completionVerificationFields, type TeamFileDocument } from './TeamFileSchema';

/** A saved library carries a roster and raw check policy, not workspace-wide workflows or MCP grants.
 * Absence in the incoming source must remove the outgoing explicit policy, not inherit it. */
export function activeDocumentForSavedTeam(current: TeamFileDocument | undefined, incoming: TeamFileDocument): TeamFileDocument {
  const { completionVerification: _outgoingPolicy, validationWarnings: _warnings, ...workspace } =
    current ?? { version: '1.0', members: [], workflows: [], mcpServers: [] };
  return { ...workspace, members: structuredClone(incoming.members), ...completionVerificationFields(incoming) };
}
