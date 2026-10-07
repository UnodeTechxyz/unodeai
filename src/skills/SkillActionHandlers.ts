/** Closed, build-time registry for executable Skill actions. Skill content can select, never extend, it. */
export type SkillActionHandler = (input: Record<string, unknown>) => Promise<unknown> | unknown;

export const BUNDLED_SKILL_ACTION_HANDLERS: Readonly<Record<string, SkillActionHandler>> = Object.freeze({
  // Side-effect-free protocol canary. v0.9.85 bundles no Skill that declares this handler.
  'unode.echo-json.v1': (input) => input,
});

export const BUNDLED_SKILL_ACTION_HANDLER_IDS: ReadonlySet<string> = new Set(
  Object.keys(BUNDLED_SKILL_ACTION_HANDLERS),
);

export function resolveBundledSkillActionHandler(handlerId: string): SkillActionHandler | undefined {
  return Object.hasOwn(BUNDLED_SKILL_ACTION_HANDLERS, handlerId)
    ? BUNDLED_SKILL_ACTION_HANDLERS[handlerId]
    : undefined;
}
