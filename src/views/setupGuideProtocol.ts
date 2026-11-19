/*
 * v0.9.106 (setup guide, design §1.7 and §4.2): what the setup guide page may ask of the host. The page is an untrusted
 * renderer: it names one fixed action and, where the action needs one, one opaque id. It never supplies a command, a
 * key, a secret name, a role list, a setting key or an execution target. The host resolves each id against its current
 * registry and roster and checks that the action applies now, before it runs anything.
 */

/** The six steps, in order. Any step can be opened directly; there is no skip and no completion. */
export const SETUP_GUIDE_STEPS = ['connections', 'team', 'permissions', 'folders', 'skills', 'continue'] as const;
export type SetupGuideStep = typeof SETUP_GUIDE_STEPS[number];

/** Actions that name nothing. */
const PLAIN_ACTIONS = [
  'next', 'back',
  'add-gateway', 'open-providers',
  'choose-model', 'check', 'repair',
  'create-team', 'create-solo', 'custom-team', 'open-saved-team', 'add-agent',
  'manage-trust', 'enable-commands', 'open-security',
  'browse-mcp', 'add-mcp',
  'continue',
] as const;

/** Actions that name one thing by an opaque id: a step, a connection, an agent or a setting from a fixed list. */
const ID_ACTIONS = [
  'step',
  'set-key', 'choose-cli', 'open-login', 'test-connection', 'set-default', 'select-connection',
  'edit-agent', 'open-agent-chat',
  'open-setting',
] as const;

export type SetupGuidePlainAction = typeof PLAIN_ACTIONS[number];
export type SetupGuideIdAction = typeof ID_ACTIONS[number];
export type SetupGuideAction = SetupGuidePlainAction | SetupGuideIdAction;

/** The settings step 3 can open in VS Code Settings. The page names one of these tokens, never a setting key. */
export const SETUP_GUIDE_SETTINGS: Readonly<Record<string, string>> = Object.freeze({
  commands: 'unode.commandApproval',
  writes: 'unode.writeApproval',
  autonomy: 'unode.autonomy',
  web: 'unode.webAccess',
});

export type SetupGuideInbound =
  | { command: 'ready' }
  | { command: 'action'; action: SetupGuidePlainAction }
  | { command: 'action'; action: SetupGuideIdAction; id: string };

export type SetupGuideInboundParse = { ok: true; message: SetupGuideInbound } | { ok: false; reason: string };

/** An id is opaque and bounded; whether it names anything is the host's decision. */
const ID_LIMIT = 512;

export function parseSetupGuideMessage(value: unknown): SetupGuideInboundParse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('message is not an object');
  const record = value as Record<string, unknown>;
  if (record.command === 'ready') {
    return Object.keys(record).length === 1 ? { ok: true, message: { command: 'ready' } } : reject('message contains an unexpected field');
  }
  if (record.command !== 'action') return reject('command is not supported');
  const plain = PLAIN_ACTIONS.find((action) => action === record.action);
  if (plain) {
    return Object.keys(record).every((key) => key === 'command' || key === 'action')
      ? { ok: true, message: { command: 'action', action: plain } }
      : reject('message contains an unexpected field');
  }
  const withId = ID_ACTIONS.find((action) => action === record.action);
  if (!withId) return reject('action is not a setup guide action');
  if (!Object.keys(record).every((key) => key === 'command' || key === 'action' || key === 'id')) return reject('message contains an unexpected field');
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > ID_LIMIT) return reject('id is missing or too long');
  return { ok: true, message: { command: 'action', action: withId, id: record.id } };
}

function reject(reason: string): SetupGuideInboundParse {
  return { ok: false, reason };
}

/**
 * Step 6 (design §3, F3): who "Continue in Workbench" opens. The project manager when there is one; otherwise Solo;
 * otherwise the agent selected in the Chat while it still exists; otherwise the first agent of the roster. Undefined
 * with no agent: the Workbench then opens on its first-task screen.
 */
export function setupGuideReceiver(agents: ReadonlyArray<{ id: string; role: string }>, selectedAgentId: string | undefined): string | undefined {
  return agents.find((agent) => agent.role === 'pm')?.id
    ?? agents.find((agent) => agent.role === 'solo')?.id
    ?? (selectedAgentId && agents.some((agent) => agent.id === selectedAgentId) ? selectedAgentId : undefined)
    ?? agents[0]?.id;
}

/* ---------------------------------------------------------------------------------------------------------------------
 * What the host posts: a read-only view, rendered by the page with textContent only.
 * ------------------------------------------------------------------------------------------------------------------- */

export interface SetupGuideButton {
  label: string;
  action: SetupGuideAction;
  id?: string;
  primary?: boolean;
  /** Shown as a text link rather than a button. */
  link?: boolean;
  disabled?: boolean;
  title?: string;
}

export type SetupGuideBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string; tone?: 'note' | 'warning' }
  | { kind: 'row'; title: string; detail?: string[]; buttons?: SetupGuideButton[]; steps?: string[] }
  | { kind: 'card'; title: string; detail: string; steps?: string[]; buttons: SetupGuideButton[]; tone?: 'ready' | 'attention' }
  | { kind: 'select'; label: string; action: 'select-connection'; options: Array<{ id: string; label: string }>; selected: string }
  | { kind: 'buttons'; buttons: SetupGuideButton[] };

export type SetupGuideMark = 'ready' | 'attention' | 'optional';

export interface SetupGuideView {
  steps: Array<{ id: SetupGuideStep; label: string; mark: SetupGuideMark; current: boolean }>;
  step: SetupGuideStep;
  title: string;
  blocks: SetupGuideBlock[];
  /** What the last action did, as the host found it afterwards. */
  note?: { text: string; tone: 'info' | 'warning' };
  busy: boolean;
  back: boolean;
  next: boolean;
}

export type SetupGuideOutbound = { command: 'view'; view: SetupGuideView };
