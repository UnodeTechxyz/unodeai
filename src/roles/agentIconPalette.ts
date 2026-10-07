/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the agent icon palette
 *
 *  A roster is scanned, not read. The icon is the only thing that distinguishes one row from the
 *  next at a glance, so two agents wearing the same glyph costs more than it looks like it should.
 *
 *  Role templates carry a *preferred* icon and several of them legitimately want the same one (three
 *  roles are natural clipboards). Adding more glyphs alone does not fix that — the fix is to pick
 *  against what the roster is ALREADY wearing, which is what `distinctAgentIcon` does.
 *--------------------------------------------------------------------------------------------*/

/**
 * Deliberately chosen to be distinguishable at 18px, which is the size the roster actually renders:
 * no two that differ only by colour, and nothing whose silhouette collapses when it is small.
 */
export const AGENT_ICON_PALETTE: readonly string[] = [
  '🤖', '🧠', '🛠️', '💻', '🏗️', '📋', '🧪', '⚙️', '📝', '🔒',
  '📊', '🔍', '🧭', '💰', '✍️', '📈', '📇', '🤝', '🚀', '🎯',
  '🧩', '🔧', '🧰', '📦', '🗂️', '🖥️', '🕹️', '🛰️', '🔭', '🧬',
  '⚗️', '🧲', '⚡', '🔥', '🌱', '🌊', '🗺️', '🧱', '🎨', '🎬',
  '🎓', '📚', '📡', '🛡️', '⚖️', '🧾', '💡', '🔔', '🧊', '🪙',
  '🐙', '🦊', '🦉', '🐝', '🦁', '🐬', '🌟', '🍀',
];

/** The glyph used when a roster has somehow exhausted the palette. */
export const FALLBACK_AGENT_ICON = '🤖';

/**
 * The icon this agent should wear, given what its teammates already wear.
 *
 * Keeps the template's preference when it is free — a Reviewer should look like a Reviewer — and
 * otherwise takes the first unused palette glyph. Only when every glyph is spoken for does it allow
 * a repeat, because a roster of 60 agents with one duplicate beats refusing to create the agent.
 */
export function distinctAgentIcon(preferred: string | undefined, taken: Iterable<string | undefined>): string {
  const used = new Set<string>();
  for (const icon of taken) {
    if (typeof icon === 'string' && icon.length > 0) {
      used.add(icon);
    }
  }
  if (preferred && !used.has(preferred)) {
    return preferred;
  }
  const free = AGENT_ICON_PALETTE.find((icon) => !used.has(icon));
  return free ?? preferred ?? FALLBACK_AGENT_ICON;
}

/** What the Agent Builder is saving, from the icon's point of view. */
export interface SavedAgentIconInput {
  /** The value in the icon field at save time. Always present — the form is never submitted empty. */
  submitted?: string;
  /** True only when the USER set it: clicked a preset, uploaded an image, or typed in the field.
   *  False when the panel filled it in on their behalf, which is what happens on every role switch. */
  explicit: boolean;
  /** The chosen role's preferred icon. */
  templateIcon?: string;
  /** Saving an existing agent rather than creating one. */
  isEdit: boolean;
  /** Icons the rest of the roster already wears. */
  taken: Iterable<string | undefined>;
}

/**
 * The icon a Builder save should store.
 *
 * The distinction that matters is *who chose it*. The panel writes the role's default into the field on
 * every role switch, so "the field has a value" says nothing — without the explicit flag, a template
 * default is indistinguishable from a deliberate choice and de-duplication never runs at all.
 */
export function iconForSavedAgent(input: SavedAgentIconInput): string | undefined {
  const preferred = input.submitted || input.templateIcon;
  // Editing stores exactly what is in the field: an existing agent's icon is how its row is found, and
  // silently re-picking it during an unrelated edit would move the landmark.
  if (input.isEdit || input.explicit) {
    return preferred;
  }
  return distinctAgentIcon(preferred, input.taken);
}
