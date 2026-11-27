/** Human-facing memory provenance: never replace a known name with an opaque id, or invent an origin. */
export function memoryWriterLabel(agentId: string, agentName?: string): string {
  return agentName ? `${agentName} (${agentId})` : `${agentId} (removed)`;
}
