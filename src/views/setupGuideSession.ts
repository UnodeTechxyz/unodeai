/*
 * v0.9.106 (setup guide, design §3 and §4.4): the host side of the setup guide. It shows what is set now and opens the
 * one place where each thing is changed. Its only state of its own is the step on screen, what the last action did,
 * the last readiness check and the guide's creation choice: the connection and, for a custom gateway, the model a team
 * created here uses. That choice is not the global default and is never written into the first-use record; first use
 * keeps its own (FirstUseController). Nothing here sends a task, records a completion, or changes a permission: a
 * permission is shown as it is in effect and opens its own editor.
 *
 * Opening, Next, Back, a step click and a refresh read only what is known without starting a program or making a
 * request. A program or a request starts only from a button whose words say so.
 *
 * VS Code is reached only through the host, so the guide does what the extension does.
 */
import type { CommandApprovalMode } from '../backend/CommandPolicy';
import { effectivePolicyLines, type EffectivePolicyView } from '../settings/EffectivePolicyView';
import type { TeamRoleConnectionChoice } from '../roles/TeamConnectionPlan';
import type { FirstUseCli, FirstUseReadiness } from '../firstUse/firstUseReadiness';
import type { ReadinessService } from '../firstUse/readinessService';
import {
  SETUP_GUIDE_SETTINGS, SETUP_GUIDE_STEPS, setupGuideReceiver, type SetupGuideAction, type SetupGuideBlock,
  type SetupGuideButton, type SetupGuideMark, type SetupGuideStep, type SetupGuideView,
} from './setupGuideProtocol';

export type SetupGuideConnectionKind = 'api-key' | 'custom-gateway' | 'claude-cli' | 'codex-cli';

export interface SetupGuideConnection {
  id: string;
  name: string;
  kind: SetupGuideConnectionKind;
  /** Usable for a new team: a stored key, a CLI program UnodeAi finds, or a custom gateway that exists. */
  configured: boolean;
  /** Whether SecretStorage holds a key; never the key. */
  hasKey: boolean;
  /** A built-in key connection: the native key prompt. A custom gateway's key is changed in Settings → Providers. */
  canSetKey: boolean;
  /** What is known without starting anything. */
  status: string;
  /** A CLI connection's program, when UnodeAi finds one. */
  program?: string;
}

export interface SetupGuideAgent {
  id: string;
  name: string;
  role: string;
  connection: string;
  model: string;
  autonomy: string;
  autonomyLimits: string[];
  effectivePolicy?: EffectivePolicyView;
  folders: Array<{ path: string; permission: 'read' | 'readwrite' }>;
  mcp: string[];
  skills: number;
  playbooks: number;
}

export interface SetupGuidePermissions {
  /** `unode.commandApproval` as read now, and whether the person set it. */
  commandSetting: CommandApprovalMode;
  commandExplicit: boolean;
  /** This project's own command enablement. */
  projectEnabled: boolean;
  /** The mode in effect here (a setting of Off with this project's enablement is Ask each). */
  commandEffective: CommandApprovalMode;
  writeApproval: string;
  autonomyDefault: string;
  webAccess: string;
  trusted: boolean;
}

export interface SetupGuideSnapshot {
  connections: SetupGuideConnection[];
  /** The connection new agents get now. */
  defaultConnectionId: string;
  /** True when the person set the default themselves. */
  defaultExplicit: boolean;
  agents: SetupGuideAgent[];
  selectedAgentId?: string;
  permissions: SetupGuidePermissions;
  mcpServers: Array<{ id: string; name: string; ready: boolean; toolCount: number }>;
}

export interface SetupGuideCreationChoice {
  connectionId: string;
  model?: string;
  roleConnections?: TeamRoleConnectionChoice[];
}

export interface SetupGuideHost {
  /** What holds now, read without starting a program or making a request. */
  snapshot: () => Promise<SetupGuideSnapshot>;
  readiness: ReadinessService;
  /** The secret a built-in key connection uses, resolved from the current registry. */
  secretNameFor: (connectionId: string) => string | undefined;
  loginCommandFor: (cli: FirstUseCli) => string;
  /** The existing model picker of a custom gateway; undefined when cancelled. */
  chooseModel: (connectionId: string) => Promise<string | undefined>;
  /** The existing Add custom gateway flow; the new connection id, or undefined when cancelled. */
  addGateway: () => Promise<string | undefined>;
  testConnection: (connectionId: string) => Promise<void>;
  setDefault: (connectionId: string) => Promise<void>;
  /** Creates the roster only: no task, no default change, no first-use write. Returns what was created. */
  createTeam: (preset: 'starter' | 'solo', choice: SetupGuideCreationChoice) => Promise<Array<{ name: string; role: string }>>;
  /** Offline shared role-row editor; this stages choices only and does not create or start agents. */
  configureRoles?: (choice: SetupGuideCreationChoice) => Promise<SetupGuideCreationChoice | undefined>;
  /** Runs one of the commands this file names. */
  run: (command: string, ...args: unknown[]) => Promise<unknown>;
  log: (line: string) => void;
}

const STEP_LABEL: Record<SetupGuideStep, string> = {
  connections: 'Connections',
  team: 'Team',
  permissions: 'Permissions and safety',
  folders: 'Folders',
  skills: 'Skills and MCP (optional)',
  continue: 'Continue in Workbench',
};

const KIND_LABEL: Record<SetupGuideConnectionKind, string> = {
  'api-key': 'API key',
  'custom-gateway': 'Custom gateway',
  'claude-cli': 'Claude CLI',
  'codex-cli': 'Codex CLI',
};

const COMMAND_LABEL: Record<CommandApprovalMode, string> = { none: 'Off', ask: 'Ask each', allowlist: 'Allowlist', all: 'Automatic' };
const AUTONOMY_LABEL: Record<string, string> = { workspace: 'Workspace', review: 'Review', 'full-access': 'Full access' };
const WEB_LABEL: Record<string, string> = {
  allow: 'Allowed: agents can search the web and fetch public pages. Each search or fetch shows as a tool card.',
  ask: 'Ask: the first search or fetch of a session asks you first.',
  off: 'Off: agents cannot search the web or fetch public pages.',
};

/** Design §3 step 1: the numbered steps beside a login terminal. */
const LOGIN_STEPS = [
  'Press Open a terminal to sign in. The sign-in command is typed in it and has not run; press Enter there.',
  'Finish signing in.',
  'Come back here and press Check readiness.',
];

const CHECK_EXPLAINED = 'Check readiness checks the connection chosen below for a new team. For a CLI it runs the program to '
  + 'check its version and sign-in. For an API key it only looks for the stored key; nothing is sent to a model.';

/** A role id as words: `pm` is the project manager, `custom` a role of its own; others read as written. */
function roleLabel(role: string): string {
  if (role === 'pm') return 'Project manager';
  if (role === 'custom') return 'Own role';
  const words = role.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : role;
}

const NAVIGATION: ReadonlySet<SetupGuideAction> = new Set<SetupGuideAction>(['step', 'next', 'back']);

class Refused extends Error {}

export class SetupGuideSession {
  private step: SetupGuideStep = 'connections';
  /** The guide's creation choice, when the person made one here. Without it a team uses the default connection. */
  private choice?: SetupGuideCreationChoice;
  /** `program`: the CLI program the snapshot named when the check ran, so its version is never shown for another. */
  private check?: SetupGuideCreationChoice & { result: FirstUseReadiness; outside: boolean; program?: string };
  private note?: { text: string; tone: 'info' | 'warning' };
  private loginOpened = new Set<FirstUseCli>();
  private running = false;

  constructor(private readonly host: SetupGuideHost, private readonly changed: () => void) {}

  /** Test seam and diagnostics: the guide's own creation choice, if it made one. */
  creationChoice(): SetupGuideCreationChoice | undefined {
    return this.choice ? structuredClone(this.choice) : undefined;
  }

  async view(): Promise<SetupGuideView> {
    const snapshot = await this.host.snapshot();
    const choice = this.effectiveChoice(snapshot);
    const index = SETUP_GUIDE_STEPS.indexOf(this.step);
    return {
      steps: SETUP_GUIDE_STEPS.map((id) => ({ id, label: STEP_LABEL[id], mark: this.mark(id, snapshot, choice), current: id === this.step })),
      step: this.step,
      title: STEP_LABEL[this.step],
      blocks: this.blocks(snapshot, choice),
      ...(this.note ? { note: this.note } : {}),
      busy: this.running,
      back: index > 0,
      next: index < SETUP_GUIDE_STEPS.length - 1,
    };
  }

  /** One action from the page, already parsed. Navigation is always taken; any other action waits for the last one. */
  async action(action: SetupGuideAction, id?: string): Promise<void> {
    if (NAVIGATION.has(action)) {
      this.navigate(action, id);
      this.changed();
      return;
    }
    if (this.running) {
      this.host.log(`[setup guide] "${action}" was ignored: another action is still running.`);
      return;
    }
    this.running = true;
    this.note = undefined;
    this.changed();
    try {
      await this.perform(action, id);
    } catch (error) {
      if (error instanceof Refused) {
        this.host.log(`[setup guide] refused "${action}": ${error.message}`);
        this.note = { text: 'That action does not apply to what is shown now. The page shows the current state.', tone: 'warning' };
      } else {
        this.note = { text: error instanceof Error ? error.message : String(error), tone: 'warning' };
      }
    } finally {
      this.running = false;
      this.changed();
    }
  }

  private navigate(action: SetupGuideAction, id: string | undefined): void {
    const index = SETUP_GUIDE_STEPS.indexOf(this.step);
    if (action === 'next') this.step = SETUP_GUIDE_STEPS[Math.min(index + 1, SETUP_GUIDE_STEPS.length - 1)];
    else if (action === 'back') this.step = SETUP_GUIDE_STEPS[Math.max(index - 1, 0)];
    else {
      const step = SETUP_GUIDE_STEPS.find((candidate) => candidate === id);
      if (!step) {
        this.host.log('[setup guide] refused a step that does not exist.');
        return;
      }
      this.step = step;
    }
    this.note = undefined;
  }

  /** The connections a team created here can use: every configured one, the default, and the guide's own choice. */
  private selectable(snapshot: SetupGuideSnapshot): SetupGuideConnection[] {
    return snapshot.connections.filter((connection) => connection.configured
      || connection.id === snapshot.defaultConnectionId || connection.id === this.choice?.connectionId);
  }

  private effectiveChoice(snapshot: SetupGuideSnapshot): SetupGuideCreationChoice {
    if (this.choice && snapshot.connections.some((connection) => connection.id === this.choice!.connectionId)) return structuredClone(this.choice);
    return { connectionId: snapshot.defaultConnectionId };
  }

  private connection(snapshot: SetupGuideSnapshot, id: string | undefined, accept: (connection: SetupGuideConnection) => boolean): SetupGuideConnection {
    const found = snapshot.connections.find((connection) => connection.id === id);
    if (!found || !accept(found)) throw new Refused(`no current connection "${id ?? ''}" for this action`);
    return found;
  }

  private agent(snapshot: SetupGuideSnapshot, id: string | undefined): SetupGuideAgent {
    const found = snapshot.agents.find((agent) => agent.id === id);
    if (!found) throw new Refused(`no current agent "${id ?? ''}"`);
    return found;
  }

  private async perform(action: SetupGuideAction, id: string | undefined): Promise<void> {
    const snapshot = await this.host.snapshot();
    const cli = (connection: SetupGuideConnection) => connection.kind === 'claude-cli' || connection.kind === 'codex-cli';
    switch (action) {
      case 'set-key': {
        const connection = this.connection(snapshot, id, (candidate) => candidate.canSetKey);
        const secretName = this.host.secretNameFor(connection.id);
        if (!secretName) throw new Refused(`${connection.id} has no key of its own`);
        const outcome = await this.host.readiness.setApiKey(secretName);
        this.note = outcome === 'stored'
          ? { text: `The API key for ${connection.name} is stored.`, tone: 'info' }
          : { text: 'Cancelled. No key was stored.', tone: 'info' };
        return;
      }
      case 'choose-cli': {
        const connection = this.connection(snapshot, id, cli);
        const outcome = await this.host.readiness.chooseCli(connection.kind as FirstUseCli);
        this.note = outcome === 'changed'
          ? { text: `The ${connection.name} program UnodeAi starts was changed.`, tone: 'info' }
          : { text: `Not changed. The ${connection.name} program UnodeAi starts stays as it was.`, tone: 'info' };
        return;
      }
      case 'open-login': {
        const connection = this.connection(snapshot, id, cli);
        const which = connection.kind as FirstUseCli;
        this.host.readiness.openLogin(which, this.host.loginCommandFor(which));
        this.loginOpened.add(which);
        this.note = { text: `A terminal opened with the ${connection.name} sign-in command typed in. It has not run.`, tone: 'info' };
        return;
      }
      case 'add-gateway': {
        const added = await this.host.addGateway();
        if (!added) {
          this.note = { text: 'Cancelled. No gateway was added.', tone: 'info' };
          return;
        }
        const name = (await this.host.snapshot()).connections.find((connection) => connection.id === added)?.name ?? 'The gateway';
        this.note = { text: `${name} was added. Choose it below for a new team, or set it as the default.`, tone: 'info' };
        return;
      }
      case 'test-connection': {
        const connection = this.connection(snapshot, id, (candidate) => (candidate.kind === 'api-key' || candidate.kind === 'custom-gateway') && candidate.hasKey);
        await this.host.testConnection(connection.id);
        this.note = { text: `${connection.name} answered a model list request.`, tone: 'info' };
        return;
      }
      case 'set-default': {
        const connection = this.connection(snapshot, id, (candidate) => candidate.id !== snapshot.defaultConnectionId);
        await this.host.setDefault(connection.id);
        this.note = { text: `${connection.name} is now the default connection for new agents.`, tone: 'info' };
        return;
      }
      case 'select-connection': {
        const connection = this.selectable(snapshot).find((candidate) => candidate.id === id);
        if (!connection) throw new Refused(`"${id ?? ''}" cannot be chosen for a new team`);
        const current = this.effectiveChoice(snapshot);
        this.choice = { connectionId: connection.id, ...(current.connectionId === connection.id && current.model ? { model: current.model } : {}),
          ...(current.roleConnections ? { roleConnections: current.roleConnections } : {}) };
        return;
      }
      case 'choose-model': {
        const choice = this.effectiveChoice(snapshot);
        const connection = this.connection(snapshot, choice.connectionId, (candidate) => candidate.kind === 'custom-gateway');
        const model = await this.host.chooseModel(connection.id);
        if (!model) {
          this.note = { text: 'Cancelled. The model was not changed.', tone: 'info' };
          return;
        }
        this.choice = { connectionId: connection.id, model, ...(choice.roleConnections ? { roleConnections: choice.roleConnections } : {}) };
        this.note = { text: `${model} will be used on ${connection.name} for a new team.`, tone: 'info' };
        return;
      }
      case 'check':
        return this.runCheck(snapshot);
      case 'repair':
        return this.repair(snapshot);
      case 'configure-roles': {
        if (snapshot.agents.length > 0) throw new Refused('Use Edit on the existing team members to change their connections.');
        const configured = await this.host.configureRoles?.(this.effectiveChoice(snapshot));
        if (configured) { this.choice = structuredClone(configured); this.note = { text: 'Role choices are staged. Create the team when they are ready; no agent was created or started.', tone: 'info' }; }
        return;
      }
      case 'create-team':
      case 'create-solo': {
        if (snapshot.agents.length > 0) throw new Refused('agents exist already');
        const choice = this.effectiveChoice(snapshot);
        const connection = this.connection(snapshot, choice.connectionId, () => true);
        const creation = action === 'create-solo' && choice.roleConnections ? { ...choice,
          roleConnections: choice.roleConnections.filter(row => row.roleKey === 'solo').map(row => ({ ...row, roleIndex: 0 })) } : choice;
        const members = await this.host.createTeam(action === 'create-team' ? 'starter' : 'solo', creation);
        if (members.length > 0) {
          this.note = { text: choice.roleConnections?.length
            ? `Created: ${members.map((member) => member.name).join(', ')}. Each role keeps its chosen connection and model. No task was sent.`
            : `Created on ${connection.name}: ${members.map((member) => member.name).join(', ')}. No task was sent.`, tone: 'info' };
        } else {
          this.note = connection.kind === 'custom-gateway' && !choice.model
            ? { text: 'Cancelled: no model was chosen, so no agents were created.', tone: 'info' }
            : { text: 'No agents were created.', tone: 'warning' };
        }
        return;
      }
      case 'custom-team': await this.host.run('unode.createTeamPreset'); return;
      case 'open-saved-team': await this.host.run('unode.openSavedTeam'); return;
      case 'add-agent': await this.host.run('unode.addAgent'); return;
      case 'edit-agent': await this.host.run('unode.openAgentBuilder', this.agent(snapshot, id).id); return;
      case 'open-agent-chat': await this.host.run('unode.chatWithAgent', this.agent(snapshot, id).id); return;
      case 'manage-trust': await this.host.run('workbench.action.manageTrust'); return;
      case 'open-security': await this.host.run('unode.showSecurity'); return;
      case 'open-setting': {
        const key = id !== undefined && Object.prototype.hasOwnProperty.call(SETUP_GUIDE_SETTINGS, id) ? SETUP_GUIDE_SETTINGS[id] : undefined;
        if (!key) throw new Refused(`"${id ?? ''}" is not a setting this page opens`);
        await this.host.run('workbench.action.openSettings', key);
        return;
      }
      case 'enable-commands': {
        if (snapshot.permissions.commandEffective !== 'none') throw new Refused('commands are not Off here');
        await this.host.run('unode.enableCommands');
        const after = (await this.host.snapshot()).permissions.commandEffective;
        this.note = after === 'none'
          ? { text: 'Not changed. Commands stay Off.', tone: 'info' }
          : { text: `Commands for this project: ${COMMAND_LABEL[after]}.`, tone: 'info' };
        return;
      }
      case 'browse-mcp': await this.host.run('unode.openMarketplace', 'mcp'); return;
      case 'add-mcp': await this.host.run('unode.addMcpServer'); return;
      case 'open-providers': await this.host.readiness.openProviders(); return;
      case 'continue': {
        const receiver = setupGuideReceiver(snapshot.agents, snapshot.selectedAgentId);
        if (!receiver) {
          await this.host.run('unode.onboarding');
          this.note = { text: 'The Workbench opened on the first-task screen. Nothing was sent.', tone: 'info' };
          return;
        }
        await this.host.run('unode.openAgentWorkbench', receiver);
        this.note = { text: `The Workbench opened on the conversation of ${this.agent(snapshot, receiver).name}. Nothing was sent.`, tone: 'info' };
        return;
      }
      default:
        throw new Refused('not an action of this page');
    }
  }

  /** Check readiness: the guide's creation choice, through the shared readiness service. Only from a click. */
  private async runCheck(snapshot: SetupGuideSnapshot): Promise<void> {
    const choice = this.effectiveChoice(snapshot);
    let result: FirstUseReadiness;
    try {
      result = await this.host.readiness.check({
        connectionId: choice.connectionId,
        ...(choice.model ? { model: choice.model } : {}),
        implicitDefault: !this.choice && !snapshot.defaultExplicit,
      });
    } catch (error) {
      result = { ready: false, repair: {
        title: 'UnodeAi could not check this connection',
        detail: error instanceof Error ? error.message : String(error),
        action: { kind: 'open-providers', label: 'Open Settings → Providers' },
      } };
    }
    const program = snapshot.connections.find((connection) => connection.id === choice.connectionId)?.program;
    this.check = { ...choice, result, outside: false, ...(program ? { program } : {}) };
  }

  /** The card's action (design §3 step 1 table). A recheck follows only a repair that finished here. */
  private async repair(snapshot: SetupGuideSnapshot): Promise<void> {
    const check = this.check;
    if (!check || check.result.ready) throw new Refused('no repair is shown');
    const choice = this.effectiveChoice(snapshot);
    if (check.connectionId !== choice.connectionId || check.model !== choice.model) {
      this.check = undefined;
      this.note = { text: 'The connection for a new team changed. Press Check readiness again.', tone: 'info' };
      return;
    }
    if (check.outside) return this.runCheck(snapshot);
    const action = check.result.repair.action;
    switch (action.kind) {
      case 'set-api-key':
        if (await this.host.readiness.setApiKey(action.secretName) === 'stored') return this.runCheck(await this.host.snapshot());
        this.note = { text: 'Cancelled. No key was stored.', tone: 'info' };
        return;
      case 'choose-cli':
        if (await this.host.readiness.chooseCli(action.cli) === 'changed') return this.runCheck(await this.host.snapshot());
        this.note = { text: 'Not changed. The program UnodeAi starts stays as it was.', tone: 'info' };
        return;
      case 'cli-login':
        this.host.readiness.openLogin(action.cli, action.command);
        this.loginOpened.add(action.cli);
        check.outside = true;
        return;
      case 'choose-model': {
        const model = await this.host.chooseModel(choice.connectionId);
        if (!model) {
          this.note = { text: 'Cancelled. The model was not changed.', tone: 'info' };
          return;
        }
        this.choice = { connectionId: choice.connectionId, model };
        return this.runCheck(await this.host.snapshot());
      }
      case 'use-connection': {
        // The guide's choice only: the default connection and first use are not touched.
        this.connection(snapshot, action.connectionId, () => true);
        this.choice = { connectionId: action.connectionId };
        return this.runCheck(await this.host.snapshot());
      }
      case 'open-providers':
        await this.host.readiness.openProviders();
        check.outside = true;
        return;
    }
  }

  /* -------------------------------------------------------------------------------------------------------------------
   * The view.
   * ----------------------------------------------------------------------------------------------------------------- */

  /**
   * v0.9.106 (retest 3, T2): a CLI's row read "version not checked yet" beside this guide's own "is ready". A ready
   * check of this guide that reported a version says so in its row. It is shown only here, and nothing is stored.
   */
  private statusOf(connection: SetupGuideConnection): string {
    const check = this.check;
    if (!connection.program || !check || check.connectionId !== connection.id || check.program !== connection.program
      || !check.result.ready || !check.result.version) {
      return connection.status;
    }
    return `${connection.program} (version ${check.result.version}, checked by Check readiness here)`;
  }

  private checkFor(choice: SetupGuideCreationChoice) {
    const check = this.check;
    return check && check.connectionId === choice.connectionId && check.model === choice.model ? check : undefined;
  }

  private mark(step: SetupGuideStep, snapshot: SetupGuideSnapshot, choice: SetupGuideCreationChoice): SetupGuideMark {
    const agents = snapshot.agents.length > 0;
    switch (step) {
      case 'connections': {
        const connection = snapshot.connections.find((candidate) => candidate.id === choice.connectionId);
        const check = this.checkFor(choice);
        return connection?.configured && (!check || check.result.ready) ? 'ready' : 'attention';
      }
      case 'team': return agents ? 'ready' : 'attention';
      case 'folders': return agents ? 'ready' : 'optional';
      case 'continue': return agents ? 'ready' : 'optional';
      default: return 'optional';
    }
  }

  private blocks(snapshot: SetupGuideSnapshot, choice: SetupGuideCreationChoice): SetupGuideBlock[] {
    switch (this.step) {
      case 'connections': return [...this.connectionBlocks(snapshot), ...this.choiceBlocks(snapshot, choice), ...this.checkBlocks(snapshot, choice)];
      case 'team': return this.teamBlocks(snapshot, choice);
      case 'permissions': return this.permissionBlocks(snapshot);
      case 'folders': return this.folderBlocks(snapshot);
      case 'skills': return this.skillBlocks(snapshot);
      case 'continue': return this.continueBlocks(snapshot);
    }
  }

  private connectionBlocks(snapshot: SetupGuideSnapshot): SetupGuideBlock[] {
    const choice = this.effectiveChoice(snapshot);
    const rows = snapshot.connections.map((connection): SetupGuideBlock => {
      const isDefault = connection.id === snapshot.defaultConnectionId;
      const buttons: SetupGuideButton[] = [];
      let steps: string[] | undefined;
      if (connection.canSetKey) buttons.push({ label: connection.hasKey ? 'Replace API key' : 'Set API key', action: 'set-key', id: connection.id });
      if (connection.kind === 'claude-cli' || connection.kind === 'codex-cli') {
        buttons.push({ label: 'Check / choose CLI', action: 'choose-cli', id: connection.id });
        buttons.push({ label: 'Open a terminal to sign in', action: 'open-login', id: connection.id });
        if (this.loginOpened.has(connection.kind)) steps = LOGIN_STEPS;
      }
      if ((connection.kind === 'api-key' || connection.kind === 'custom-gateway') && connection.hasKey) {
        buttons.push({ label: 'Test connection', action: 'test-connection', id: connection.id });
      }
      if (!isDefault) buttons.push({ label: 'Set as default', action: 'set-default', id: connection.id, link: true });
      return {
        kind: 'row',
        title: `${connection.name}${isDefault ? ' (default for new agents)' : ''}`,
        detail: [
          `${KIND_LABEL[connection.kind]} · ${this.statusOf(connection)}`,
          ...(connection.kind === 'custom-gateway'
            ? [choice.connectionId === connection.id && choice.model ? `Model for a new team: ${choice.model}` : 'No model chosen in this guide']
            : []),
        ],
        buttons,
        ...(steps ? { steps } : {}),
      };
    });
    return [
      { kind: 'text', text: 'Each connection with what is known now. Nothing here starts a program or makes a request until you press a button that says so.' },
      ...rows,
      { kind: 'text', text: 'Set as default changes the connection new agents and teams get by default. Test connection asks the provider for its model list; it may ask your consent first.', tone: 'note' },
      { kind: 'buttons', buttons: [
        { label: 'Add custom gateway', action: 'add-gateway' },
        { label: 'Open Settings → Providers', action: 'open-providers', link: true },
      ] },
    ];
  }

  /** The guide's own creation choice: the connection, and the model of a custom gateway. */
  private choiceBlocks(snapshot: SetupGuideSnapshot, choice: SetupGuideCreationChoice): SetupGuideBlock[] {
    const options = this.selectable(snapshot).map((connection) => ({
      id: connection.id,
      label: `${connection.name} · ${KIND_LABEL[connection.kind]}${connection.id === snapshot.defaultConnectionId ? ' · default' : ''}`,
    }));
    const blocks: SetupGuideBlock[] = [
      { kind: 'heading', text: 'Connection for a new team' },
      { kind: 'select', label: 'Connection', action: 'select-connection', options, selected: choice.connectionId },
    ];
    const connection = snapshot.connections.find((candidate) => candidate.id === choice.connectionId);
    if (connection) blocks.push({ kind: 'text', text: `${connection.name}: ${this.statusOf(connection)}.`, tone: 'note' });
    if (connection?.kind === 'custom-gateway') {
      blocks.push({
        kind: 'row',
        title: choice.model ? `Model: ${choice.model}` : 'Model: not chosen yet',
        detail: [choice.model ? 'Every member of a team created here uses this model.' : 'You can choose it now, or when you create the team.'],
        buttons: [{ label: 'Choose a model…', action: 'choose-model' }],
      });
    }
    blocks.push({ kind: 'text', text: 'This choice is only for a team created in this guide. It does not change your default connection.', tone: 'note' });
    return blocks;
  }

  private checkBlocks(snapshot: SetupGuideSnapshot, choice: SetupGuideCreationChoice): SetupGuideBlock[] {
    const name = snapshot.connections.find((candidate) => candidate.id === choice.connectionId)?.name ?? choice.connectionId;
    const check = this.checkFor(choice);
    const blocks: SetupGuideBlock[] = [{ kind: 'text', text: CHECK_EXPLAINED, tone: 'note' }];
    if (!check) {
      blocks.push({ kind: 'buttons', buttons: [{ label: 'Check readiness', action: 'check', disabled: this.running }] });
      return blocks;
    }
    if (check.result.ready) {
      blocks.push({
        kind: 'card', tone: 'ready', title: `${name} is ready`,
        detail: check.result.note ?? 'Nothing was sent to a model.',
        buttons: [{ label: 'Check readiness', action: 'check', link: true }],
      });
      return blocks;
    }
    const repair = check.result.repair;
    const login = repair.action.kind === 'cli-login';
    const buttons: SetupGuideButton[] = check.outside
      ? [{ label: 'Check readiness', action: 'check', primary: true }]
      : [{ label: repair.action.label, action: 'repair', primary: true }, { label: 'Check readiness', action: 'check', link: true }];
    blocks.push({
      kind: 'card', tone: 'attention', title: repair.title, detail: repair.detail,
      ...(login ? { steps: LOGIN_STEPS } : repair.steps ? { steps: repair.steps } : {}),
      buttons,
    });
    return blocks;
  }

  private teamBlocks(snapshot: SetupGuideSnapshot, choice: SetupGuideCreationChoice): SetupGuideBlock[] {
    if (snapshot.agents.length > 0) {
      return [
        { kind: 'text', text: 'Your team. Edit opens the Agent Builder, where each member\'s connection, model, tools and folders are changed.' },
        ...snapshot.agents.map((agent): SetupGuideBlock => ({
          kind: 'row', title: agent.name, detail: [`${roleLabel(agent.role)} · ${agent.connection} · ${agent.model}`],
          buttons: [{ label: 'Edit', action: 'edit-agent', id: agent.id }],
        })),
        { kind: 'buttons', buttons: [
          { label: 'Add agent', action: 'add-agent' },
          { label: 'Save or open a team…', action: 'open-saved-team', link: true },
        ] },
      ];
    }
    return [
      { kind: 'text', text: 'No agents yet. Create a team here: it adds the agents only, sends no task and does not change your default connection.' },
      {
        kind: 'card', title: 'Starter team (three people)',
        detail: 'A project manager organises the work, a generalist does it and a reviewer checks it independently. A Solo agent is added too, for small everyday tasks.',
        buttons: [{ label: 'Create the starter team', action: 'create-team', primary: true, disabled: this.running }],
      },
      {
        kind: 'card', title: 'Solo',
        detail: 'One agent that does the work directly. Checking its own work is not an independent review.',
        buttons: [{ label: 'Create Solo', action: 'create-solo', disabled: this.running }],
      },
      { kind: 'buttons', buttons: [
        { label: 'Custom team…', action: 'custom-team', link: true },
        { label: 'Open a saved team…', action: 'open-saved-team', link: true },
      ] },
      ...this.choiceBlocks(snapshot, choice),
      ...(this.host.configureRoles ? [{ kind: 'buttons' as const, buttons: [{ label: 'Edit role connections & models', action: 'configure-roles' as const }] }] : []),
      ...(choice.roleConnections ?? []).map((row): SetupGuideBlock => ({ kind: 'row', title: roleLabel(row.roleKey),
        detail: [`${snapshot.connections.find(connection => connection.id === row.connectionId)?.name ?? row.connectionId} · ${row.model ?? 'role default model'}`] })),
      { kind: 'text', text: 'Unchanged role rows inherit the default connection and model choices. After creation, Edit opens each member’s Agent Builder.', tone: 'note' },
    ];
  }

  private permissionBlocks(snapshot: SetupGuideSnapshot): SetupGuideBlock[] {
    const p = snapshot.permissions;
    const commandsDetail = [
      `In effect here: ${COMMAND_LABEL[p.commandEffective]}.`
        + (p.commandSetting === 'none' && p.projectEnabled ? ' Your setting is Off; this project enabled commands, so each one asks first.' : ''),
      `Default: Automatic. ${p.commandExplicit ? `Your setting: ${COMMAND_LABEL[p.commandSetting]}.` : 'You have not changed it.'}`,
      ...(p.commandEffective === 'none' ? ['Agents cannot run shell commands.'] : []),
    ];
    const commandButtons: SetupGuideButton[] = [{ label: 'Open in Settings', action: 'open-setting', id: 'commands', link: true }];
    if (p.commandEffective === 'none') {
      commandButtons.push({ label: 'Enable commands for this project', action: 'enable-commands', title: 'Asks you to confirm first. Your setting stays as it is.' });
    }
    const agentRows = snapshot.agents.map((agent): SetupGuideBlock => ({
      kind: 'row', title: `${agent.name}: ${agent.autonomy}`,
      detail: [...(agent.autonomyLimits.length ? [`Limited by: ${agent.autonomyLimits.join('; ')}.`] : []),
        ...(agent.effectivePolicy ? effectivePolicyLines(agent.effectivePolicy) : [])],
      buttons: [{ label: 'Change in Chat', action: 'open-agent-chat', id: agent.id, link: true, title: 'The Autonomy menu in the Chat is where this is changed.' }],
    }));
    return [
      { kind: 'text', text: 'What applies now, and where each is changed. This page changes no permission.' },
      { kind: 'row', title: 'Commands', detail: commandsDetail, buttons: commandButtons },
      {
        kind: 'row', title: 'File writes',
        detail: [
          p.writeApproval === 'ask' ? 'Ask before each write, with a diff.' : 'No review for each write. Every mediated write is checkpointed and can be restored.',
          'Default: no review for each write. This is not the same as commands Off.',
        ],
        buttons: [{ label: 'Open in Settings', action: 'open-setting', id: 'writes', link: true }],
      },
      {
        kind: 'row', title: 'Autonomy',
        detail: [
          `Default for agents you have not changed: ${AUTONOMY_LABEL[p.autonomyDefault] ?? p.autonomyDefault}.`,
          'An agent\'s own limits, Workspace Trust and the native Codex permissions can make an agent differ; each agent is listed below with what applies to it.',
        ],
        buttons: [{ label: 'Open in Settings', action: 'open-setting', id: 'autonomy', link: true }],
      },
      ...agentRows,
      { kind: 'row', title: 'Web access', detail: [WEB_LABEL[p.webAccess] ?? p.webAccess], buttons: [{ label: 'Open in Settings', action: 'open-setting', id: 'web', link: true }] },
      { kind: 'row', title: 'MCP', detail: ['A mounted MCP server gives no agent a tool until you grant it to that agent in the Agent Builder.'] },
      {
        kind: 'row', title: 'Workspace Trust',
        detail: [p.trusted ? 'This workspace is trusted.' : 'This workspace is not trusted: agents can read and chat, but commands, file writes and MCP servers are off.'],
        buttons: [{ label: 'Manage trust', action: 'manage-trust', link: true }],
      },
      {
        kind: 'row', title: 'Keys and granted access',
        detail: ['API keys are kept in VS Code\'s SecretStorage; this page never shows them. File access granted in a session, Codex network for this session and stored keys are listed in Security, where each can be revoked.'],
        buttons: [{ label: 'Open Security', action: 'open-security', link: true }],
      },
    ];
  }

  private folderBlocks(snapshot: SetupGuideSnapshot): SetupGuideBlock[] {
    if (snapshot.agents.length === 0) return [{ kind: 'text', text: 'No agents yet. Create a team in step 2; each agent then works in this workspace unless you give it Folder Access.' }];
    return [
      { kind: 'text', text: 'The folders each agent works in. Edit opens the Agent Builder, where Folder Access is set.' },
      ...snapshot.agents.map((agent): SetupGuideBlock => ({
        kind: 'row', title: agent.name,
        detail: agent.folders.length
          ? agent.folders.map((folder) => `${folder.path} (${folder.permission === 'readwrite' ? 'read and write' : 'read only'})`)
          : ['This workspace (no Folder Access set).'],
        buttons: [{ label: 'Edit', action: 'edit-agent', id: agent.id }],
      })),
      { kind: 'text', text: 'File access granted during a session is shown in Security, where it can be revoked.', tone: 'note' },
      { kind: 'buttons', buttons: [{ label: 'Open Security', action: 'open-security', link: true }] },
    ];
  }

  private skillBlocks(snapshot: SetupGuideSnapshot): SetupGuideBlock[] {
    const servers = snapshot.mcpServers.length
      ? snapshot.mcpServers.map((server): SetupGuideBlock => ({
        kind: 'row', title: server.name, detail: [`${server.ready ? 'Ready' : 'Not ready'} · ${server.toolCount} ${server.toolCount === 1 ? 'tool' : 'tools'}`],
      }))
      : [{ kind: 'text', text: 'No MCP server is mounted.' } as SetupGuideBlock];
    return [
      { kind: 'text', text: 'Optional. MCP servers add tools; an agent gets a server\'s tools only when you grant it in the Agent Builder.' },
      { kind: 'heading', text: 'Mounted MCP servers' },
      ...servers,
      { kind: 'buttons', buttons: [{ label: 'Browse MCP Marketplace', action: 'browse-mcp' }, { label: 'Add MCP server', action: 'add-mcp' }] },
      { kind: 'heading', text: 'Agents' },
      ...(snapshot.agents.length
        ? snapshot.agents.map((agent): SetupGuideBlock => ({
          kind: 'row', title: agent.name,
          detail: [`MCP: ${agent.mcp.length ? agent.mcp.join(', ') : 'none'} · Skills: ${agent.skills} · Playbooks: ${agent.playbooks}`],
          buttons: [{ label: 'Edit', action: 'edit-agent', id: agent.id, title: 'Grant MCP servers or choose skills and playbooks in the Agent Builder.' }],
        }))
        : [{ kind: 'text', text: 'No agents yet.' } as SetupGuideBlock]),
      { kind: 'text', text: 'Skills cannot be installed from the Marketplace yet. Built-in playbooks are chosen in the Agent Builder.', tone: 'note' },
    ];
  }

  private continueBlocks(snapshot: SetupGuideSnapshot): SetupGuideBlock[] {
    const receiver = setupGuideReceiver(snapshot.agents, snapshot.selectedAgentId);
    const agent = snapshot.agents.find((candidate) => candidate.id === receiver);
    if (!agent) {
      return [
        { kind: 'text', text: 'No agents yet. The Workbench opens on the first-task screen, where you write your goal and choose how to start.' },
        { kind: 'buttons', buttons: [{ label: 'Open the Workbench', action: 'continue', primary: true }] },
      ];
    }
    return [
      { kind: 'text', text: `This opens the conversation of ${agent.name} in the Workbench. Nothing is sent: you write the task there.` },
      { kind: 'buttons', buttons: [{ label: 'Continue in Workbench', action: 'continue', primary: true }] },
    ];
  }
}
