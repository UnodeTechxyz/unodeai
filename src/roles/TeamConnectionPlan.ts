/** A role position, not just a role name: two developers may deliberately use different routes. */
export interface TeamRoleConnectionChoice {
  roleIndex: number;
  roleKey: string;
  connectionId: string;
  model?: string;
}
export interface TeamConnectionPlan { connectionId: string; model?: string; roleConnections?: TeamRoleConnectionChoice[] }
export interface TeamConnectionForm {
  roles: Array<{ roleKey: string; label: string }>;
  connections: Array<{ id: string; label: string; models: string[] }>;
  initial: TeamConnectionPlan;
}

export function parseTeamConnectionPlan(value: unknown, form: TeamConnectionForm): TeamConnectionPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Review the connection and model choices.');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['connectionId', 'model', 'roleConnections'].includes(key))
    || typeof raw.connectionId !== 'string' || !form.connections.some(connection => connection.id === raw.connectionId)
    || raw.model !== undefined && (typeof raw.model !== 'string' || !raw.model.trim() || raw.model.length > 512 || /[\r\n]/.test(raw.model))) throw new Error('Choose an available default connection and model.');
  const choices = parseTeamRoleConnections(raw.roleConnections, form.roles.map(role => role.roleKey));
  for (const [index, role] of form.roles.entries()) {
    const choice = choices.get(index);
    const connection = form.connections.find(connection => connection.id === (choice?.connectionId ?? raw.connectionId));
    if (!connection) throw new Error(`Choose an available connection for ${role.label}.`);
    const model = choice?.model ?? (!choice || choice.connectionId === raw.connectionId ? raw.model : undefined) ?? connection.models[index];
    if (!model) throw new Error(`Enter a model for ${role.label}, or set a default model for its inherited connection.`);
  }
  return { connectionId: raw.connectionId, ...(typeof raw.model === 'string' ? { model: raw.model.trim() } : {}), roleConnections: [...choices.values()] };
}

/** Configuration validation only. No discovery, process, login, model request or mutation. */
export function parseTeamRoleConnections(value: unknown, roles: readonly string[]): Map<number, TeamRoleConnectionChoice> {
  if (value === undefined) return new Map();
  if (!Array.isArray(value) || value.length > roles.length) throw new Error('The role connection choices do not match this team. Review the role rows before creating it.');
  const choices = new Map<number, TeamRoleConnectionChoice>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('A role connection choice is invalid. Review the role rows before creating the team.');
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some(key => !['roleIndex', 'roleKey', 'connectionId', 'model'].includes(key))
      || !Number.isSafeInteger(row.roleIndex) || (row.roleIndex as number) < 0 || (row.roleIndex as number) >= roles.length
      || choices.has(row.roleIndex as number) || row.roleKey !== roles[row.roleIndex as number]
      || typeof row.connectionId !== 'string' || !row.connectionId.trim() || row.connectionId.length > 512 || /[\r\n]/.test(row.connectionId)
      || row.model !== undefined && (typeof row.model !== 'string' || !row.model.trim() || row.model.length > 512 || /[\r\n]/.test(row.model))) {
      throw new Error('A role connection or model no longer matches this team. Review the role rows before creating it.');
    }
    choices.set(row.roleIndex as number, { roleIndex: row.roleIndex as number, roleKey: row.roleKey as string,
      connectionId: row.connectionId, ...(typeof row.model === 'string' ? { model: row.model.trim() } : {}) });
  }
  return choices;
}
