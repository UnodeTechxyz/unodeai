const PLAN_ALLOWED_TOOLS = new Set(['read_file', 'read_workbook', 'transform_workbook', 'inspect_office', 'view_office_images', 'list_dir', 'list_agents', 'search_conversation_log', 'read_conversation_log']);

export function isToolAllowedInPlan(name: string): boolean {
  return PLAN_ALLOWED_TOOLS.has(name);
}

export function planModeRefusal(name: string): string {
  return `[Plan mode] '${name}' is disabled. Switch to Act mode to make changes.`;
}
