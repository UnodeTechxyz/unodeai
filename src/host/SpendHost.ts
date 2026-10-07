/*---------------------------------------------------------------------------------------------
 *  UnodeAi - spend reminders in VS Code (v0.9.89, design §5.4, §5.6, §6, §7, §13.2)
 *
 *  Composition and presentation for the SpendCoordinator: where the ledger lives, how a threshold is shown
 *  (Chat line, warning, status bar, Team badge, chime and a detached modal), the first-run reference choice,
 *  the stale-catalog reminder, the repository proposal and the spend commands.
 *
 *  Nothing here is on the model path. The over-target modal is started from a detached host task and no turn
 *  awaits it; the reference-price modal appears only after a turn has already finished.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { SpendCoordinator, type SpendAlert, type SpendResetRequest, type SpendRoute, type SpendViewModel } from './SpendCoordinator';
import { AccountPriceSnapshots, ReferenceCatalogStore, routeCandidatesFor } from './SpendPriceSources';
import { FileSpendLedger, MemorySpendLedger, type SpendLedger } from '../state/SpendStore';
import { workspaceRootIdentity } from '../state/WorkspaceRootIdentity';
import { catalogIsStale, type ReferenceProvider } from '../models/spend/PriceCatalog';
import { isStoredReferencePriceMode, type StoredReferencePriceMode } from '../models/spend/PriceResolver';
import {
  MAX_BUDGET_FILE_BYTES,
  parseRepositoryBudget,
  parseUserTargets,
  type RepositoryBudget,
} from '../models/spend/SpendTargets';
import { formatUsd } from '../models/spend/Money';
import type { PriceFetch } from '../models/LivePriceService';
import { readPriceGroupSetting, readPriceMultiplierSetting } from '../models/LivePriceService';
import type { TeamSpendSummary } from '../views/TeamViewProvider';
import { requireAttention } from '../views/attentionSignal';
import { showResultNotice } from '../resultNotice';

export interface SpendHostDeps {
  context: vscode.ExtensionContext;
  /** The activation-bound primary workspace root; undefined in a folderless window. */
  primaryRoot: string | undefined;
  log(message: string): void;
  resolveRoute(agentId: string, modelId: string): SpendRoute | undefined;
  agentName(agentId: string): string | undefined;
  stopRequest(requestId: string): number;
  /** Application-scoped User Settings only. */
  readUserSetting<T>(key: 'spend.targets' | 'spend.referencePriceMode' | 'modelPrices' | 'priceMultiplier' | 'priceGroup', fallback: T): T;
  writeUserSetting(key: 'spend.targets' | 'spend.referencePriceMode', value: unknown): Promise<void>;
  /** Existing consent-gated account price refresh for one connection; never prompts. */
  refreshAccountPrices(route: SpendRoute): Promise<void>;
  /** The provider's profile-pinned HTTPS pricing endpoint. */
  pricingUrl(provider: ReferenceProvider): string | undefined;
  metadataFetch: PriceFetch;
  /** Ask for (or confirm) metadata consent for a user-initiated reference refresh. */
  ensureMetadataConsent(url: string, requester: string): Promise<boolean>;
  postChatNotice(agentId: string, noticeKey: string, text: string): boolean;
  refreshViews(): void;
  openDashboard(focusSpend: boolean): Promise<void>;
  openSettingsSpend(): void;
  /** Whether any agent is in a turn right now; the Team badge says work is continuing only then. */
  workRunning?(): boolean;
  /** Whether a turn of this request is still live (the turns Stop this request would stop). */
  requestRunning?(requestId: string): boolean;
  premiumCostModel?: string;
}

const REFERENCE_CHOICE_OFFERED_KEY = 'unode.spend.referenceChoiceOfferedAt';
const REFERENCE_CHOICE_REOFFER_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_REMINDED_KEY = 'unode.spend.staleReferenceRemindedAt';
const STALE_REMINDER_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const PROPOSAL_NOTIFIED_KEY = 'unode.spend.repositoryProposalNotified';
const RECOVERY_INTERVAL_MS = 2 * 60 * 1000;

type RepositoryBudgetState =
  | { state: 'none' }
  | { state: 'invalid'; reason: string }
  | { state: 'valid'; budget: RepositoryBudget };

function scopeLabel(alert: Pick<SpendAlert, 'scope' | 'agentName' | 'periodId'>): string {
  switch (alert.scope) {
    case 'request': return 'This request';
    case 'project-period': return `This project ${alert.periodId?.length && alert.periodId.split('@')[0].length > 7 ? 'today' : 'this month'}`;
    case 'agent-period': return `${alert.agentName ?? 'This agent'}'s share of the project ${alert.periodId && alert.periodId.split('@')[0].length > 7 ? 'today' : 'this month'}`;
  }
}

/**
 * The persistent Team badge (v0.9.89 field finding F3). It stays until reset or period rollover, so it says work
 * is continuing only while an agent is actually in a turn: after Stop this request, or once work finishes, it
 * would be false. The alert-time chat line and dialog follow the same rule (field finding F9).
 */
export function spendBadgeText(highestPercent: number | undefined, workRunning: boolean): string {
  return `Over spend target (${highestPercent ?? 100}%)${workRunning ? ' — work is continuing' : ''}`;
}

/**
 * What is running when a reminder appears (field finding F9). The usage that crosses a threshold can arrive as the
 * work ends, for example the final report of a turn the user just stopped, so a reminder says work is continuing
 * only while it is.
 */
export function idleNote(alert: Pick<SpendAlert, 'scope'>): string {
  return alert.scope === 'request' ? 'Nothing in this request is running right now.' : 'No agent is working right now.';
}

export function alertChatText(alert: SpendAlert, running: boolean): string {
  const narrowed = alert.repositoryNarrowed ? ' (project-suggested target accepted by you)' : '';
  if (alert.loudness === 'quiet') {
    return `UnodeAi: ${scopeLabel(alert)} reached ${alert.threshold}% of its spend reminder target${narrowed}: `
      + `${alert.valueText} of ${alert.targetText} (${alert.basisText}). ${running ? 'Work continues.' : idleNote(alert)}`;
  }
  if (!running) {
    return `UnodeAi: Over target. ${scopeLabel(alert)} is at ${alert.threshold}% of its spend reminder target${narrowed}: `
      + `${alert.valueText} of ${alert.targetText} (${alert.basisText}). ${idleNote(alert)}`;
  }
  return `UnodeAi: Over target — work is continuing. ${scopeLabel(alert)} is at ${alert.threshold}% of its spend reminder target${narrowed}: `
    + `${alert.valueText} of ${alert.targetText} (${alert.basisText}). You decide whether to stop: use the reminder, or Dashboard → Spend.`;
}

export class SpendHost implements vscode.Disposable {
  readonly coordinator: SpendCoordinator;
  readonly accountPrices = new AccountPriceSnapshots();
  readonly references: ReferenceCatalogStore;
  private readonly ledger: SpendLedger;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private repository: RepositoryBudgetState = { state: 'none' };
  private recoveryTimer: ReturnType<typeof setInterval> | undefined;
  private viewTimer: ReturnType<typeof setTimeout> | undefined;
  private staleChecked = false;

  constructor(private readonly deps: SpendHostDeps) {
    const storage = deps.context.globalStorageUri.fsPath;
    this.ledger = deps.primaryRoot
      ? new FileSpendLedger({
        root: path.join(storage, 'spend', 'v1', workspaceRootIdentity(deps.primaryRoot)),
        log: (message) => deps.log(`[spend] ${message}`),
      })
      : new MemorySpendLedger();
    this.references = new ReferenceCatalogStore(storage);
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 40);
    this.statusBar.command = 'unode.openSpend';
    this.disposables.push(this.statusBar);
    this.coordinator = new SpendCoordinator({
      ledger: this.ledger,
      notifier: {
        threshold: (alert) => this.presentThreshold(alert),
        referencePriceChoiceNeeded: (context) => { void this.offerReferencePriceChoice(context); },
        viewChanged: () => this.scheduleViewRefresh(),
        repairNeeded: (detail) => this.notifyRepairNeeded(detail),
      },
      resolveRoute: (agentId, modelId) => deps.resolveRoute(agentId, modelId),
      routeCandidates: (route, modelId) => {
        const snapshot = this.accountPrices.snapshot(route.connectionId);
        return routeCandidatesFor({
          connectionId: route.connectionId,
          modelId,
          userModelPrices: deps.readUserSetting<unknown>('modelPrices', {}),
          snapshot,
          coefficient: readPriceMultiplierSetting(deps.readUserSetting<unknown>('priceMultiplier', {}))(route.connectionId),
          group: readPriceGroupSetting(deps.readUserSetting<unknown>('priceGroup', ''))(route.connectionId),
          hasKey: snapshot?.authenticated === true,
        });
      },
      referenceMode: () => this.referenceMode(),
      catalogs: () => this.references.catalogs(),
      userTargets: () => parseUserTargets(deps.readUserSetting<unknown>('spend.targets', { schemaVersion: 1 })),
      repositoryBudget: () => this.repository.state === 'valid' ? this.repository.budget : undefined,
      agentName: (agentId) => deps.agentName(agentId),
      postTurnPriceRefresh: (route) => deps.refreshAccountPrices(route),
      stopRequest: (requestId) => deps.stopRequest(requestId),
      premiumCostModel: deps.premiumCostModel,
      log: (message) => deps.log(`[spend] ${message}`),
    });
  }

  /** Background start: nothing on activation waits for this, and it makes no network request. */
  start(): void {
    void (async () => {
      try {
        if (this.ledger instanceof FileSpendLedger) await this.ledger.open();
        await this.references.load();
        await this.readRepositoryBudget();
        await this.coordinator.recoverAbandonedUnits();
      } catch (error) {
        this.deps.log(`[spend] start skipped a step: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.scheduleViewRefresh();
    })();
    this.recoveryTimer = setInterval(() => {
      void this.coordinator.recoverAbandonedUnits().catch(() => undefined);
    }, RECOVERY_INTERVAL_MS);
    (this.recoveryTimer as { unref?: () => void }).unref?.();
    if (this.deps.primaryRoot) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.deps.primaryRoot, '.unode/budget.json'));
      const reread = () => { void this.readRepositoryBudget(); };
      watcher.onDidChange(reread);
      watcher.onDidCreate(reread);
      watcher.onDidDelete(reread);
      this.disposables.push(watcher);
    }
  }

  referenceMode(): StoredReferencePriceMode {
    const value = this.deps.readUserSetting<unknown>('spend.referencePriceMode', 'unselected');
    return isStoredReferencePriceMode(value) ? value : 'unselected';
  }

  viewModel(): SpendViewModel {
    const view = this.coordinator.viewModel();
    const repo = this.repository;
    const decision = this.coordinator.repositoryDecision();
    const repository: NonNullable<SpendViewModel['repository']> = repo.state === 'invalid'
      ? { state: 'invalid', detail: repo.reason }
      : repo.state === 'valid'
        ? decision?.mode === 'ignore-project' ? { state: 'ignored' }
          : decision?.mode === 'accepted-digest' && decision.contentDigest === repo.budget.contentDigest ? { state: 'accepted' }
          : { state: 'proposed' }
        : { state: 'none' };
    return { ...view, repository };
  }

  repositoryState(): RepositoryBudgetState {
    return this.repository;
  }

  // ─── Presentation ──────────────────────────────────────────────────────────────

  private scheduleViewRefresh(): void {
    if (this.viewTimer) return;
    this.viewTimer = setTimeout(() => {
      this.viewTimer = undefined;
      this.updateStatusBar();
      this.checkStaleReference();
      try { this.deps.refreshViews(); } catch { /* a view refresh never affects accounting */ }
    }, 300);
    (this.viewTimer as { unref?: () => void }).unref?.();
  }

  private updateStatusBar(): void {
    let view: SpendViewModel;
    try { view = this.coordinator.viewModel(); } catch { this.statusBar.hide(); return; }
    const anyTarget = !!(view.targets.request.tokens || view.targets.request.nanoUsd || view.targets.project);
    if (!anyTarget) { this.statusBar.hide(); return; }
    const percent = view.highestPercent;
    this.statusBar.text = view.overTarget
      ? `$(warning) Over target ${percent}%`
      : `$(pulse) Spend ${percent ?? 0}%`;
    this.statusBar.tooltip = view.overTarget
      ? 'A spend reminder target is exceeded. Reminders never stop work. Click to open Spend.'
      : 'Highest spend reminder progress in the current counters. Click to open Spend.';
    this.statusBar.backgroundColor = view.overTarget ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.statusBar.show();
  }

  teamSummary(): TeamSpendSummary | undefined {
    let view: SpendViewModel;
    try { view = this.coordinator.viewModel(); } catch { return undefined; }
    const perAgent: TeamSpendSummary['perAgent'] = {};
    for (const agent of view.agents) {
      if (!agent.agentId) continue;
      if (agent.percent !== undefined) {
        perAgent[agent.agentId] = { label: `${agent.percent}% of share`, over: agent.percent >= 100 };
      } else if (agent.tokens.total > 0) {
        const total = agent.tokens.total;
        perAgent[agent.agentId] = {
          label: `${total >= 1_000_000 ? `${(total / 1_000_000).toFixed(1)}M` : total >= 1_000 ? `${(total / 1_000).toFixed(1)}k` : total} tok ${agent.periodId && agent.periodId.split('@')[0].length > 7 ? 'today' : 'this month'}`,
          over: false,
        };
      }
    }
    return {
      overTarget: view.overTarget,
      ...(view.overTarget ? { badgeText: spendBadgeText(view.highestPercent, this.deps.workRunning?.() ?? false) } : {}),
      perAgent,
    };
  }

  /** One threshold appearance: Chat line, warning or loud reminder. Never awaited by anything on the model path. */
  private presentThreshold(alert: SpendAlert): void {
    const running = this.alertWorkRunning(alert);
    const text = alertChatText(alert, running);
    const chatAgent = alert.rootAgentId ?? alert.agentId;
    if (chatAgent) {
      try { this.deps.postChatNotice(chatAgent, `spend:${alert.key}`, text); } catch { /* the chat may be gone */ }
    }
    this.scheduleViewRefresh();
    if (alert.loudness === 'quiet') {
      void vscode.window.showWarningMessage(text.replace(/^UnodeAi: /, 'UnodeAi spend reminder: '), 'Open Spend').then((choice) => {
        if (choice === 'Open Spend') void vscode.commands.executeCommand('unode.openSpend');
      });
      return;
    }
    requireAttention(`spend:${alert.key}`);
    // Detached: the provider turn does not await this; closing it is Keep going.
    void this.showOverTargetModal(alert, running);
  }

  /** A request reminder asks about that request's turns; a project or agent-share reminder about any work. */
  private alertWorkRunning(alert: SpendAlert): boolean {
    try {
      return alert.scope === 'request'
        ? this.deps.requestRunning?.(alert.requestId) ?? true
        : this.deps.workRunning?.() ?? true;
    } catch {
      return true;
    }
  }

  private async showOverTargetModal(alert: SpendAlert, running: boolean): Promise<void> {
    const detail = `${alert.valueText} of ${alert.targetText} (${alert.basisText}).`
      + `${alert.repositoryNarrowed ? ' This is a project-suggested target you accepted.' : ''}`
      + ' UnodeAi never stops work on its own; the choice is yours. Keep going changes nothing, and the next threshold will remind you again.';
    const choice = await vscode.window.showWarningMessage(
      running
        ? `Over target — work is continuing. ${scopeLabel(alert)} is at ${alert.threshold}% of its spend reminder target.`
        : `Over target. ${scopeLabel(alert)} is at ${alert.threshold}% of its spend reminder target. ${idleNote(alert)}`,
      { modal: true, detail },
      'Keep going', 'Stop this request', 'View spend', 'Change target', 'Reset counter',
    );
    switch (choice) {
      case 'Stop this request': {
        const outcome = this.coordinator.stopRequestForAlert(alert.stopToken);
        void showResultNotice('information', outcome === 'stopped'
          ? 'Stopped the request that crossed the spend target. Other work was not touched.'
          : 'Already finished: that request has no running work left, so nothing was stopped.');
        return;
      }
      case 'View spend':
        await vscode.commands.executeCommand('unode.openSpend');
        return;
      case 'Change target':
        await vscode.commands.executeCommand('unode.changeSpendTarget');
        return;
      case 'Reset counter':
        await this.resetBound(alert.reset);
        return;
    }
    return;
  }

  private async resetBound(request: SpendResetRequest): Promise<void> {
    try {
      await this.coordinator.resetCounter(request);
      void showResultNotice('information', 'Spend counter reset. History is kept; the reminder ladder starts again from zero. Work was not touched.');
    } catch (error) {
      void showResultNotice('warning', `The spend counter was not reset: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private repairNoticeShown = false;
  private notifyRepairNeeded(detail: string): void {
    if (this.repairNoticeShown) return;
    this.repairNoticeShown = true;
    void vscode.window.showWarningMessage(detail, 'Repair spend tracking…').then((choice) => {
      if (choice === 'Repair spend tracking…') void vscode.commands.executeCommand('unode.repairSpendTracking');
    });
  }

  /**
   * First gateway turn with no billed or exact price and no reference chosen (design §5.4). The turn has ended
   * and nothing waits: no chime, no host_wait. Dismissing records nothing; it is offered again at most weekly.
   */
  private async offerReferencePriceChoice(context: { connectionName: string; modelId: string }): Promise<void> {
    if (this.referenceMode() !== 'unselected') return;
    const state = this.deps.context.globalState;
    const last = Date.parse(state.get<string>(REFERENCE_CHOICE_OFFERED_KEY) ?? '');
    if (Number.isFinite(last) && Date.now() - last < REFERENCE_CHOICE_REOFFER_MS) return;
    await state.update(REFERENCE_CHOICE_OFFERED_KEY, new Date().toISOString());
    const catalogs = this.references.catalogs();
    const date = (provider: ReferenceProvider) => catalogs[provider]?.capturedAt.slice(0, 10) ?? 'unknown date';
    const choice = await vscode.window.showInformationMessage(
      `${context.connectionName} did not report a price for ${context.modelId}, and no account price is set for this key. Which dated estimate may dollar reminders use?`,
      {
        modal: true,
        detail: `Tokens are always counted. The Unode reference was captured ${date('unode')}, the Roam reference ${date('roam')}. `
          + 'A reference is an estimate, not your bill. Token reminders only still shows the dated Unode estimate but never uses it for a dollar reminder. '
          + 'If this key pays a discounted rate, set its coefficient (unode.priceMultiplier) or group (unode.priceGroup) instead; an account price always wins. Change this any time in Settings → Spend.',
      },
      'Use token reminders only', 'Use Unode estimate for dollar reminders', 'Use Roam estimate for dollar reminders',
    );
    if (choice === 'Use Unode estimate for dollar reminders' || choice === 'Use Roam estimate for dollar reminders' || choice === 'Use token reminders only') {
      const mode: StoredReferencePriceMode = choice === 'Use Unode estimate for dollar reminders' ? 'unode'
        : choice === 'Use Roam estimate for dollar reminders' ? 'roam' : 'token-only';
      await this.deps.writeUserSetting('spend.referencePriceMode', mode);
      this.scheduleViewRefresh();
    }
    return;
  }

  /** Stale reference reminder: once when the displayed catalog turns 30 days old, then at most every 30 days. */
  private checkStaleReference(): void {
    if (this.staleChecked) return;
    this.staleChecked = true;
    const provider = this.referenceMode() === 'roam' ? 'roam' : 'unode';
    const catalog = this.references.catalogs()[provider];
    if (!catalog || !catalogIsStale(catalog, Date.now())) return;
    const state = this.deps.context.globalState;
    const reminded = state.get<Record<string, string>>(STALE_REMINDED_KEY) ?? {};
    const last = Date.parse(reminded[catalog.catalogId] ?? '');
    if (Number.isFinite(last) && Date.now() - last < STALE_REMINDER_INTERVAL_MS) return;
    void state.update(STALE_REMINDED_KEY, { ...reminded, [catalog.catalogId]: new Date().toISOString() });
    const name = provider === 'unode' ? 'Unode' : 'Roam';
    const action = `Update ${name} reference prices`;
    void vscode.window.showInformationMessage(
      `The ${name} reference prices UnodeAi shows were captured ${catalog.capturedAt.slice(0, 10)} and are now stale. Update them to keep estimates current.`,
      action,
    ).then((choice) => {
      if (choice === action) void vscode.commands.executeCommand(provider === 'unode' ? 'unode.updateUnodeReferencePrices' : 'unode.updateRoamReferencePrices');
    });
  }

  // ─── Repository proposal (.unode/budget.json) ──────────────────────────────────

  private async readRepositoryBudget(): Promise<void> {
    const previous = this.repository;
    this.repository = await readBudgetFile(this.deps.primaryRoot);
    if (this.repository.state === 'valid') {
      const budget = this.repository.budget;
      if (budget.unknownKeys.length > 0) {
        this.deps.log(`[spend] .unode/budget.json: ignored unknown key(s) ${budget.unknownKeys.slice(0, 10).join(', ')}.`);
      }
      this.maybeNotifyProposal(budget);
    } else if (this.repository.state === 'invalid' && (previous.state !== 'invalid' || previous.reason !== this.repository.reason)) {
      this.deps.log(`[spend] .unode/budget.json was not used: ${this.repository.reason}.`);
    }
    this.scheduleViewRefresh();
  }

  /** At most one quiet, non-modal notification per content digest; never a chime or a modal. */
  private maybeNotifyProposal(budget: RepositoryBudget): void {
    const decision = this.coordinator.repositoryDecision();
    if (decision?.mode === 'ignore-project') return;
    if (decision?.mode === 'accepted-digest' && decision.contentDigest === budget.contentDigest) return;
    const state = this.deps.context.globalState;
    const notified = state.get<string[]>(PROPOSAL_NOTIFIED_KEY) ?? [];
    if (notified.includes(budget.contentDigest)) return;
    void state.update(PROPOSAL_NOTIFIED_KEY, [...notified, budget.contentDigest].slice(-100));
    void vscode.window.showInformationMessage(
      'This project proposes lower spend-reminder targets.',
      'Review', 'Ignore this project',
    ).then(async (choice) => {
      if (choice === 'Review') await vscode.commands.executeCommand('unode.reviewRepositorySpendTargets');
      else if (choice === 'Ignore this project') await this.coordinator.decideRepositoryTargets({ mode: 'ignore-project' });
    });
  }

  // ─── Commands ──────────────────────────────────────────────────────────────────

  registerCommands(): vscode.Disposable[] {
    const reg = (id: string, handler: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(id, handler);
    return [
      reg('unode.openSpend', () => this.deps.openDashboard(true)),
      reg('unode.changeSpendTarget', () => this.deps.openSettingsSpend()),
      reg('unode.resetSpendCounter', () => this.resetCommand()),
      reg('unode.reviewRepositorySpendTargets', () => this.reviewRepositoryTargets()),
      reg('unode.repairSpendTracking', () => this.repairCommand()),
      reg('unode.updateUnodeReferencePrices', () => this.updateReference('unode')),
      reg('unode.updateRoamReferencePrices', () => this.updateReference('roam')),
    ];
  }

  private async resetCommand(): Promise<void> {
    const view = this.coordinator.viewModel();
    const items: Array<vscode.QuickPickItem & { request: SpendResetRequest }> = [];
    const latest = view.requests[0];
    if (latest?.requestId) items.push({ label: 'Current request', description: latest.title, request: { scope: 'request', requestId: latest.requestId } });
    if (view.project?.periodId) items.push({ label: 'Current project period', description: `${view.project.title} (also rebases agent shares)`, request: { scope: 'project-period', periodId: view.project.periodId } });
    for (const agent of view.agents) {
      if (agent.agentId && agent.periodId) items.push({ label: `One agent: ${agent.title}`, description: 'in the current period', request: { scope: 'agent-period', agentId: agent.agentId, periodId: agent.periodId } });
    }
    if (!view.folderless) items.push({ label: 'All reminder counters for this project', request: { scope: 'project-all' } });
    if (items.length === 0) {
      void showResultNotice('information', 'There is no spend counter to reset yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, { title: 'Reset which spend counter?', placeHolder: 'Resetting keeps all history and never stops work.' });
    if (!picked) return;
    const confirm = await vscode.window.showWarningMessage(
      `Reset the spend counter for: ${picked.label}?`,
      { modal: true, detail: 'The counter starts again from zero and its reminders can appear again. Receipts, history and charts are kept. Running work is not touched.' },
      'Not now', 'Reset counter',
    );
    if (confirm !== 'Reset counter') return;
    await this.resetBound(picked.request);
  }

  private async repairCommand(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Repair spend tracking for this project?',
      { modal: true, detail: 'Rebuilds the reminder control file from the recorded usage and records the repair. Usage records, keys and running work are not changed.' },
      'Not now', 'Repair',
    );
    if (confirm !== 'Repair') return;
    try {
      await this.coordinator.repair();
      this.repairNoticeShown = false;
      void showResultNotice('information', 'Spend tracking repaired. Usage history is unchanged.');
    } catch (error) {
      void showResultNotice('warning', `Spend tracking was not repaired: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Review the proposal: the file's values, the user's, and what would apply. Writes only user-owned state. */
  private async reviewRepositoryTargets(): Promise<void> {
    await this.readRepositoryBudget();
    const repo = this.repository;
    if (repo.state !== 'valid') {
      void showResultNotice('information', repo.state === 'invalid'
        ? `This project's .unode/budget.json was not used: ${repo.reason}.`
        : 'This project has no .unode/budget.json proposal.');
      return;
    }
    const user = parseUserTargets(this.deps.readUserSetting<unknown>('spend.targets', { schemaVersion: 1 }));
    const describe = (amounts: { tokens?: number; nanoUsd?: bigint } | undefined) => amounts
      ? [amounts.tokens !== undefined ? `${amounts.tokens.toLocaleString('en-US')} tokens` : '', amounts.nanoUsd !== undefined ? formatUsd(amounts.nanoUsd) : ''].filter(Boolean).join(', ') || 'none'
      : 'none';
    const lines = [
      `Request — project proposes ${describe(repo.budget.request)}; yours ${describe(user.request)}`,
      `Project period — project proposes ${describe(repo.budget.project)}; yours ${describe(user.project)}`,
      ...Object.entries(repo.budget.agents).map(([agentId, amounts]) => `Agent ${this.deps.agentName(agentId) ?? agentId} — project proposes ${describe(amounts)}; yours ${describe(user.agents[agentId])}`),
    ];
    const picked = await vscode.window.showQuickPick([
      { label: 'Use this version', description: 'Applies only where you already set a reminder, and only when lower', action: 'accept' as const },
      { label: 'Ignore this project', description: 'Project proposals stay off until you re-enable review in Settings → Spend', action: 'ignore' as const },
      { label: 'Cancel', action: 'cancel' as const },
      ...lines.map((line) => ({ label: line, kind: vscode.QuickPickItemKind.Separator, action: 'cancel' as const })),
    ], { title: 'Project spend-reminder proposal (.unode/budget.json)', placeHolder: 'A project can only lower reminders you already enabled, and only after you accept this exact version.' });
    if (!picked || picked.action === 'cancel') return;
    await this.coordinator.decideRepositoryTargets(picked.action === 'accept'
      ? { mode: 'accepted-digest', contentDigest: repo.budget.contentDigest }
      : { mode: 'ignore-project' });
    this.scheduleViewRefresh();
  }

  async enableRepositoryReview(): Promise<void> {
    await this.coordinator.decideRepositoryTargets({ mode: 'review-again' });
    await this.readRepositoryBudget();
  }

  private async updateReference(provider: ReferenceProvider): Promise<void> {
    const name = provider === 'unode' ? 'Unode' : 'Roam';
    const url = this.deps.pricingUrl(provider);
    if (!url) {
      void showResultNotice('warning', `${name} has no pricing endpoint configured, so its reference cannot be updated.`);
      return;
    }
    if (!(await this.deps.ensureMetadataConsent(url, `Update ${name} reference prices`))) {
      void showResultNotice('information', `${name} reference prices were not updated: the price list host was not approved.`);
      return;
    }
    try {
      const catalog = await this.references.refresh(provider, url, this.deps.metadataFetch);
      this.staleChecked = false;
      void showResultNotice('information', `${name} reference prices updated: ${catalog.models.length} models, captured ${catalog.capturedAt.slice(0, 10)}. Earlier receipts keep their original prices.`);
      this.scheduleViewRefresh();
    } catch (error) {
      void showResultNotice('warning', `${name} reference prices were not updated; the previous capture stays in use. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A key was stored, replaced or cleared for these connections, here or in another window. */
  credentialChanged(connectionIds: string[]): void {
    for (const connectionId of connectionIds) this.accountPrices.invalidate(connectionId);
  }

  dispose(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    if (this.viewTimer) clearTimeout(this.viewTimer);
    for (const disposable of this.disposables) disposable.dispose();
    void this.coordinator.dispose();
  }
}

/**
 * Read `.unode/budget.json` as untrusted input: it must resolve (after following links) to a file inside the
 * primary root, be at most 64 KiB and be strict UTF-8.
 */
export async function readBudgetFile(primaryRoot: string | undefined): Promise<RepositoryBudgetState> {
  if (!primaryRoot) return { state: 'none' };
  const file = path.join(primaryRoot, '.unode', 'budget.json');
  let real: string;
  let rootReal: string;
  try {
    real = await fsp.realpath(file);
    rootReal = await fsp.realpath(primaryRoot);
  } catch {
    return { state: 'none' };
  }
  const relative = path.relative(rootReal, real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { state: 'invalid', reason: 'it resolves outside the project folder' };
  }
  let bytes: Buffer;
  try {
    const stat = await fsp.stat(real);
    if (!stat.isFile()) return { state: 'invalid', reason: 'it is not a file' };
    if (stat.size > MAX_BUDGET_FILE_BYTES) return { state: 'invalid', reason: 'it is larger than 64 KiB' };
    bytes = await fsp.readFile(real);
  } catch {
    return { state: 'none' };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { state: 'invalid', reason: 'it is not valid UTF-8' };
  }
  const parsed = parseRepositoryBudget(text.replace(/^﻿/, ''));
  return parsed.ok ? { state: 'valid', budget: parsed.budget } : { state: 'invalid', reason: parsed.reason };
}
