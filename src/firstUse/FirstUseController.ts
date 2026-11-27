/*
 * v0.9.106 (first use, Owner 2026-11-17; design §3.2–§3.8): the host side of the first goal. With no agent, the Chat
 * shows a goal box; Send checks the connection chosen for the goal, and then either one repair card or the two start
 * buttons appear, never both. A start button is the one action that creates the agents and sends the goal; nothing
 * else does. The goal lives in the workspace-scoped first-use record, apart from the roster, and one start identity
 * spans creating the agents and admitting the task, so a repeated click or a reload never creates or sends twice.
 *
 * VS Code is reached only through the injected dependencies, so the whole flow runs in unit tests as it runs in the
 * extension host.
 */
import {
  FIRST_USE_RECORD_KEY, FIRST_USE_TEXT_LIMIT, type FirstUseRecord, type FirstUseStart, type FirstUseStartKind,
  firstUseRequestId, handoverReceiver, parseFirstUseRecord, recoverFirstUseStart, retireAcceptedText, startInProgress,
} from './firstUseRecord';
import type { FirstUseReadiness, FirstUseReadinessInput, FirstUseRepair, FirstUseRepairAction } from './firstUseReadiness';

/** Up to three editable suggestions. A click only fills the goal box. */
export const FIRST_USE_SUGGESTIONS: readonly string[] = Object.freeze([
  'Explain how this project is organised and where I should start.',
  'Find one bug in this project, fix it, and show me how you checked the fix.',
  'Write a short README section that explains how to run this project.',
]);

export type FirstUsePhase = 'compose' | 'checking' | 'repair' | 'choose' | 'starting';

/** The saved team a returning person can load in one click (§3.8). */
export interface FirstUseReturningOffer {
  /** The button's text, e.g. "Load your team: Release crew". */
  label: string;
  /** Why this team: used last, or saved most recently when there is no record of use. */
  detail: string;
}

/** What the Chat page shows of first use. The page renders it; every decision stays here. */
export interface FirstUseView {
  /** True while no agent exists: the Chat shows only the goal box and what the goal needs. */
  active: boolean;
  text: string;
  revision: number;
  phase: FirstUsePhase;
  connection?: { label: string; note?: string };
  repair?: { title: string; detail: string; steps?: string[]; actionLabel: string };
  error?: string;
  returning?: FirstUseReturningOffer;
  suggestions: readonly string[];
  /** An unsent goal for an agent's message box. Only the page of `container` applies it. */
  handover?: { agentId: string; text: string; revision: number; container: 'sidebar' | 'workbench' };
  /** A goal the page did not put into a message box because that agent already had a draft. */
  unsent?: { agentId: string; text: string; revision: number };
}

export type FirstUseAction =
  | 'continue' | 'start-team' | 'start-solo' | 'custom-team' | 'repair' | 'change-connection' | 'load-team'
  | 'other-teams' | 'move-unsent';

export interface FirstUseConnectionChoice {
  connectionId: string;
  model?: string;
}

export interface FirstUseControllerDeps {
  /** Workspace-scoped state (the bound-root namespace). */
  state: { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> };
  listAgents: () => ReadonlyArray<{ id: string; role: string }>;
  /** The current default connection id (`unode.defaultProvider`, resolved). */
  defaultConnectionId: () => string;
  /** True when the person set `unode.defaultProvider` themselves. */
  defaultExplicit: () => boolean;
  connectionLabel: (connectionId: string) => string | undefined;
  readiness: (input: FirstUseReadinessInput) => Promise<FirstUseReadiness>;
  /** The existing connection picker; undefined when cancelled. Never changes the global default. */
  chooseConnection: (currentConnectionId: string) => Promise<string | undefined>;
  /** The existing model picker of a custom gateway; undefined when cancelled. */
  chooseModel: (connectionId: string) => Promise<string | undefined>;
  /**
   * Runs one repair. 'done' when the repair finished here (a key stored, a CLI chosen), so the connection is checked
   * again at once; 'outside' when the person finishes it elsewhere (a terminal, Settings) and presses Check again.
   */
  runRepair: (action: FirstUseRepairAction) => Promise<'done' | 'outside'>;
  /** Create the starter team on exactly this connection; returns the PM's id, or undefined when nothing was created. */
  createTeam: (connection: FirstUseConnectionChoice) => Promise<string | undefined>;
  /** Create Solo on exactly this connection; returns its id, or undefined when nothing was created. */
  createSolo: (connection: FirstUseConnectionChoice) => Promise<string | undefined>;
  /**
   * Admit the goal as the agent's task through the Chat's own send path, under the start's request identity, which
   * is stored with the admitted message. True, or the reason it was refused.
   */
  admit: (agentId: string, text: string, requestId: string) => true | string;
  /** True when the agent's conversation holds the message admitted under this request identity. Never by text. */
  admitted: (agentId: string, requestId: string) => boolean;
  /** Show this agent's conversation in the Chat, so its message box can take the handed-over goal. */
  selectAgent: (agentId: string) => void;
  /** Append a goal to an agent's message box, on the person's own action. */
  insertIntoComposer: (agentId: string, text: string) => void;
  openCustomTeam: () => Promise<void>;
  returningOffer: () => Promise<FirstUseReturningOffer | undefined>;
  loadReturningTeam: () => Promise<void>;
  openOtherSavedTeams: () => Promise<void>;
  /** The chat page that should take a hand-over now, or undefined when none is visible. */
  handoverContainer: () => 'sidebar' | 'workbench' | undefined;
  changed: () => void;
  newId: () => string;
  now: () => Date;
  log?: (line: string) => void;
}

export class FirstUseController {
  private record: FirstUseRecord;
  private rosterReady = false;
  private phase: FirstUsePhase = 'compose';
  private repair?: FirstUseRepair;
  /** The repair's action was taken and is finished elsewhere: the card's one action is now Check again. */
  private repairOutside = false;
  private note?: string;
  private error?: string;
  private checking = 0;
  private starting?: Promise<void>;
  private offer?: FirstUseReturningOffer;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly deps: FirstUseControllerDeps) {
    this.record = parseFirstUseRecord(deps.state.get(FIRST_USE_RECORD_KEY));
  }

  /** The roster is in (or could not be loaded): recover an interrupted start, then hand over or offer a team. */
  async rosterLoaded(): Promise<void> {
    this.rosterReady = true;
    const recovered = recoverFirstUseStart(this.record, {
      agentExists: (agentId) => this.deps.listAgents().some((agent) => agent.id === agentId),
      admitted: (start) => !!start.receiverAgentId && !!start.requestId && this.deps.admitted(start.receiverAgentId, start.requestId),
    });
    if (recovered !== this.record) {
      this.deps.log?.(`[first-use] recovered an interrupted start: ${this.record.start?.phase} -> ${recovered.start?.phase ?? 'ended'}.`);
      await this.save(recovered);
      if (recovered.handover) this.deps.selectAgent(recovered.handover.agentId);
    }
    await this.rosterChanged();
  }

  /** Called on every roster change. A roster that appears without a start takes the unsent goal (never sends it). */
  async rosterChanged(): Promise<void> {
    if (!this.rosterReady || this.starting) return;
    const agents = this.deps.listAgents();
    if (agents.length > 0) {
      this.phase = 'compose';
      this.repair = undefined;
      this.error = undefined;
      const receiver = handoverReceiver(agents);
      const handover = this.record.handover;
      const stale = handover && !agents.some((agent) => agent.id === handover.agentId);
      if (receiver && this.record.text.trim() && (!handover || stale)) {
        await this.save({ ...this.record, handover: { agentId: receiver, revision: this.record.revision } });
        this.deps.selectAgent(receiver);
      }
    } else {
      if (this.record.handover) {
        const { handover: _gone, ...rest } = this.record;
        await this.save(rest);
      }
      this.offer = await this.deps.returningOffer().catch(() => undefined);
    }
    this.deps.changed();
  }

  view(): FirstUseView | undefined {
    if (!this.rosterReady) return undefined;
    const agents = this.deps.listAgents();
    const record = this.record;
    if (agents.length > 0) {
      const handover = record.handover;
      if (!handover || !record.text.trim() || handover.revision !== record.revision) return undefined;
      if (handover.kept) return { ...this.baseView(false), unsent: { agentId: handover.agentId, text: record.text, revision: record.revision } };
      const container = this.deps.handoverContainer();
      return container
        ? { ...this.baseView(false), handover: { agentId: handover.agentId, text: record.text, revision: record.revision, container } }
        : undefined;
    }
    const view = this.baseView(true);
    const connectionId = this.connectionId();
    view.connection = { label: this.deps.connectionLabel(connectionId) ?? connectionId, ...(this.note ? { note: this.note } : {}) };
    if (this.phase === 'repair' && this.repair) {
      view.repair = {
        title: this.repair.title,
        detail: this.repair.detail,
        ...(this.repair.steps ? { steps: this.repair.steps } : {}),
        actionLabel: this.repairOutside ? 'Check again' : this.repair.action.label,
      };
    }
    if (this.offer) view.returning = this.offer;
    return view;
  }

  private baseView(active: boolean): FirstUseView {
    return {
      active,
      text: this.record.text,
      revision: this.record.revision,
      phase: this.starting ? 'starting' : this.phase,
      suggestions: FIRST_USE_SUGGESTIONS,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** The goal as typed, from either Chat page. Ignored while a start runs: that start sends the revision it took. */
  async draft(text: string): Promise<void> {
    if (this.starting || startInProgress(this.record)) return;
    const next = text.slice(0, FIRST_USE_TEXT_LIMIT);
    if (next === this.record.text) return;
    this.error = undefined;
    await this.save({ ...this.record, text: next, revision: this.record.revision + 1 });
    if (!next.trim() && this.phase !== 'compose') {
      this.phase = 'compose';
      this.repair = undefined;
    }
    this.deps.changed();
  }

  async action(action: FirstUseAction, revision?: number): Promise<void> {
    switch (action) {
      case 'continue': return this.check();
      case 'start-team': return this.start('team', revision);
      case 'start-solo': return this.start('solo', revision);
      case 'repair': return this.runRepair();
      case 'change-connection': return this.changeConnection();
      case 'custom-team': if (this.idle()) await this.deps.openCustomTeam(); return;
      case 'load-team': if (this.idle()) await this.deps.loadReturningTeam(); return;
      case 'other-teams': if (this.idle()) await this.deps.openOtherSavedTeams(); return;
      case 'move-unsent': return this.moveUnsent();
    }
  }

  /** A chat page reports what it did with a hand-over: put into the message box, or kept because of a newer draft. */
  async handoverResult(revision: number, applied: boolean): Promise<void> {
    const handover = this.record.handover;
    if (!handover || handover.revision !== revision || this.record.revision !== revision) return;
    if (applied) {
      this.error = undefined;
      await this.save(retireAcceptedText(this.record, revision));
    } else if (!handover.kept) {
      await this.save({ ...this.record, handover: { ...handover, kept: true } });
    }
    this.deps.changed();
  }

  private idle(): boolean {
    return !this.starting && this.deps.listAgents().length === 0;
  }

  private connectionId(): string {
    return this.record.connectionId ?? this.deps.defaultConnectionId();
  }

  private connectionChoice(): FirstUseConnectionChoice {
    const connectionId = this.connectionId();
    return { connectionId, ...(this.record.model && this.record.connectionId === connectionId ? { model: this.record.model } : {}) };
  }

  /** Send in the goal box: check the chosen connection, then show its repair card or the start buttons. */
  private async check(): Promise<void> {
    if (!this.idle() || !this.record.text.trim()) return;
    const seq = ++this.checking;
    this.phase = 'checking';
    this.error = undefined;
    this.deps.changed();
    const choice = this.connectionChoice();
    let result: FirstUseReadiness;
    try {
      result = await this.deps.readiness({
        connectionId: choice.connectionId,
        model: choice.model,
        implicitDefault: !this.record.connectionId && !this.deps.defaultExplicit(),
      });
    } catch (error) {
      result = { ready: false, repair: {
        title: 'UnodeAi could not check this connection',
        detail: error instanceof Error ? error.message : String(error),
        action: { kind: 'open-providers', label: 'Open Settings → Providers' },
      } };
    }
    if (seq !== this.checking || this.starting) return;
    if (result.ready) {
      this.phase = 'choose';
      this.repair = undefined;
      this.note = result.note;
    } else {
      this.phase = 'repair';
      this.repair = result.repair;
      this.note = undefined;
    }
    this.repairOutside = false;
    this.deps.changed();
  }

  private async runRepair(): Promise<void> {
    const repair = this.repair;
    if (!this.idle() || this.phase !== 'repair' || !repair) return;
    if (this.repairOutside) return this.check();
    const action = repair.action;
    if (action.kind === 'use-connection') {
      await this.chooseConnection(action.connectionId);
      return this.check();
    }
    if (action.kind === 'choose-model') {
      const connectionId = this.connectionId();
      const model = await this.deps.chooseModel(connectionId);
      if (!model) return; // cancelled: the goal and the card stay
      await this.save({ ...this.record, connectionId, model });
      return this.check();
    }
    const outcome = await this.deps.runRepair(action);
    if (outcome === 'done') return this.check();
    this.repairOutside = true;
    this.deps.changed();
  }

  private async changeConnection(): Promise<void> {
    if (!this.idle()) return;
    const picked = await this.deps.chooseConnection(this.connectionId());
    if (!picked) return;
    await this.chooseConnection(picked);
    if (this.phase !== 'compose') await this.check();
    else this.deps.changed();
  }

  /** The connection of this goal only: the global default is never rewritten. */
  private async chooseConnection(connectionId: string): Promise<void> {
    const { model: _model, ...rest } = this.record;
    await this.save({ ...rest, connectionId, ...(this.record.connectionId === connectionId && this.record.model ? { model: this.record.model } : {}) });
  }

  /**
   * A start button. The one action that creates the agents and sends the goal. A second click while a start runs, or a
   * click for a revision this page no longer shows, does nothing.
   */
  private async start(kind: FirstUseStartKind, revision: number | undefined): Promise<void> {
    if (this.starting) return this.starting;
    if (!this.idle() || this.phase !== 'choose' || !this.record.text.trim()) return;
    if (revision !== undefined && revision !== this.record.revision) return;
    this.starting = this.runStart(kind).finally(() => { this.starting = undefined; this.deps.changed(); });
    return this.starting;
  }

  private async runStart(kind: FirstUseStartKind): Promise<void> {
    const choice = this.connectionChoice();
    const startId = this.deps.newId();
    const start: FirstUseStart = {
      startId, kind, phase: 'creating', connectionId: choice.connectionId, textRevision: this.record.revision,
      startedAt: this.deps.now().toISOString(), ...(choice.model ? { model: choice.model } : {}),
    };
    this.error = undefined;
    const before = this.record;
    // Written before anything is created, so a reload mid-creation finds the start and never repeats it silently. A
    // start that could not be written durably creates and sends nothing.
    try {
      await this.persist({ ...this.record, start });
    } catch (error) {
      this.record = before;
      this.phase = 'choose';
      this.error = `The task was not started: UnodeAi could not save its start (${describe(error)}). Your goal is kept here.`;
      this.deps.log?.(`[first-use] start ${startId} was not saved, so nothing was created: ${describe(error)}`);
      return;
    }
    this.deps.changed();
    let receiver: string | undefined;
    let failure: string | undefined;
    try {
      receiver = kind === 'team' ? await this.deps.createTeam(choice) : await this.deps.createSolo(choice);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (!receiver) {
      const { start: _ended, ...rest } = this.record;
      await this.save(rest);
      this.phase = 'choose';
      this.error = failure ?? 'No agents were created. Your goal is kept here.';
      this.deps.log?.(`[first-use] start ${startId} created nothing: ${this.error}`);
      return;
    }
    const sending: FirstUseStart = { ...start, phase: 'sending', receiverAgentId: receiver, requestId: firstUseRequestId(startId) };
    let admitted: true | string;
    try {
      // The request identity is durable before the task is admitted under it.
      await this.persist({ ...this.record, start: sending });
      admitted = this.deps.admit(receiver, this.record.text, sending.requestId!);
    } catch (error) {
      admitted = `Your goal was not sent: UnodeAi could not save its start (${describe(error)}). It is in the message box; send it when you want.`;
    }
    if (admitted !== true) {
      // The agents exist; the goal goes into the receiver's message box, where the person's Send starts it.
      const { start: _ended, ...rest } = this.record;
      await this.save({ ...rest, handover: { agentId: receiver, revision: this.record.revision } });
      this.deps.selectAgent(receiver);
      this.phase = 'compose';
      this.error = admitted;
      this.deps.log?.(`[first-use] start ${startId}: the task was not admitted: ${admitted}`);
      return;
    }
    await this.save({ ...retireAcceptedText(this.record, start.textRevision), start: { ...sending, phase: 'accepted' } });
    this.phase = 'compose';
    this.deps.log?.(`[first-use] start ${startId}: ${kind} created on ${choice.connectionId}; the task was admitted to ${receiver}.`);
  }

  private async moveUnsent(): Promise<void> {
    const handover = this.record.handover;
    if (!handover?.kept || !this.record.text.trim()) return;
    if (!this.deps.listAgents().some((agent) => agent.id === handover.agentId)) return;
    this.deps.insertIntoComposer(handover.agentId, this.record.text);
    await this.save(retireAcceptedText(this.record, this.record.revision));
    this.deps.changed();
  }

  /**
   * Write the record durably, in order. The caller gets the failure; the queue stays usable for later writes. The
   * record held in memory is already `next`.
   */
  private persist(next: FirstUseRecord): Promise<void> {
    this.record = next;
    const write = this.writes.then(() => this.deps.state.update(FIRST_USE_RECORD_KEY, next));
    this.writes = write.then(() => undefined, () => undefined);
    return Promise.resolve(write);
  }

  /** A write whose failure is shown and logged, and stops nothing else: the goal stays held in memory. */
  private async save(next: FirstUseRecord): Promise<void> {
    try {
      await this.persist(next);
    } catch (error) {
      this.error = `UnodeAi could not save your goal (${describe(error)}). It stays here until the window closes.`;
      this.deps.log?.(`[first-use] the record could not be saved: ${describe(error)}`);
    }
  }

  /** Test seam and diagnostics: the record as held now. */
  snapshot(): FirstUseRecord {
    return structuredClone(this.record);
  }

  /** Put text in the goal box when it is empty (Run Demo Task with no agent). Never sends. */
  async offerGoal(text: string): Promise<void> {
    if (this.record.text.trim() || this.starting) return;
    await this.draft(text);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
