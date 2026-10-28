/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the person's managed Codex actions on the Codex CLI card (v0.9.97)
 *  The card shows the state read from the shared store, with the actions that state offers. An action reaches the
 *  store only when it is one this window rendered, for the version it rendered it for, and only after the person
 *  confirmed it in a modal that names its effects. Every dialog line comes from the records and the policy.
 *--------------------------------------------------------------------------------------------*/

import { CODEX_ARTIFACT_HOSTS, CODEX_REDIRECT_HOSTS, type PolicyEntry } from '../backend/cliCompatibilityPolicy';
import type { ManagedCodexHost } from './cliRuntimeHost';
import type { InstanceRef } from './managedCli/contracts';
import { clickOffer, decideActivation, ACTIVATION_ALLOW, ACTIVATION_NOT_NOW } from './managedCli/qualify/activation';
import { managedCodexCard, type CardTask } from './managedCli/qualify/cardState';
import { checkAgain, checkAgainWarning } from './managedCli/qualify/checkAgain';
import { keyVersion } from './managedCli/qualify/keyFacts';
import { launchableKey } from './managedCli/qualify/policyReconcile';
import { activateVersion, type QualificationOutcome } from './managedCli/qualify/qualification';
import { tryAgain } from './managedCli/qualify/tryAgain';
import type { UpdaterTaskEvent } from './managedCli/updater/updater';
import type { ManagedCodexAction, ManagedCodexCardView } from '../views/SettingsPanel';

export interface ManagedCodexActionsPort {
  /** A modal question; resolves the chosen button, or undefined when dismissed. */
  ask(title: string, lines: readonly string[], buttons: readonly string[]): Promise<string | undefined>;
  inform(kind: 'information' | 'warning', text: string): void;
  /** Re-renders every view that shows the card. */
  refresh(): void;
  /** Forget adoptions of external programs; returns how many records were removed. */
  forgetAdoptions(): number;
  /** The store's folder, for Details and the set-up question. */
  storeFolder: string;
  formatTime(iso: string): string;
}

/** The host a download starts from, as the card names it. */
function downloadHost(entry: PolicyEntry): string {
  const url = entry.managed?.artifact.urls[0];
  try {
    return url ? new URL(url).host : 'its download host';
  } catch {
    return 'its download host';
  }
}

/**
 * What the card shows for a step of a download task: the local steps before the download as looking for a version,
 * the download with its percentage, the hash, layout and signature steps as checking. A task that ended shows its
 * outcome when the records do not: a manual task's failure, a cancelled task, another window's download. An
 * automatic task's failure is in the records, with its next try.
 */
export function cardTaskFor(event: UpdaterTaskEvent, now: string): CardTask | undefined {
  const version = event.entry.version;
  switch (event.type) {
    case 'phase':
      if (event.phase === 'V1') return { phase: 'downloading', version, host: downloadHost(event.entry), percent: 0 };
      if (event.phase === 'V2' || event.phase === 'V3' || event.phase === 'V4' || event.phase === 'promote') return { phase: 'verifying', version };
      return { phase: 'checking' };
    case 'progress': {
      const percent = event.size > 0 ? Math.floor((event.receivedBytes * 100) / event.size) : 0;
      return { phase: 'downloading', version, host: downloadHost(event.entry), percent: Math.max(0, Math.min(100, percent)) };
    }
    case 'ended': {
      const result = event.result;
      if (result.outcome === 'skipped') return { phase: 'elsewhere', since: now };
      if (result.outcome === 'aborted') return { phase: 'cancelled', version };
      if (result.outcome === 'failed' && event.kind === 'manual') return { phase: 'failed', version, failureClass: result.failure, detail: result.detail };
      return undefined;
    }
  }
}

/** The cap of one instance, as the set-up question states it. */
const STORE_CAP = '3 GiB';
const MIB = 1024 * 1024;

const STATE_TITLE: Readonly<Record<string, string>> = Object.freeze({
  unsupported: 'Not available on this computer',
  suspended: 'Paused in every window',
  'not-enrolled': 'Not set up',
  'control-unusable': 'Paused: its record cannot be used',
  'behind-floor': 'Paused until you confirm your settings',
  'store-unavailable': 'Paused: its store cannot be read',
  'external-selected': 'Set up, not used for new sessions',
});

export class ManagedCodexActions {
  /** `action|key` of each action the last card offered. */
  private rendered = new Set<string>();
  private task: CardTask | undefined;
  /** Try again runs its check right after its download: the download's end shows the check. */
  private checkAfterDownload: string | undefined;
  private readonly abort = new AbortController();

  constructor(private readonly managed: ManagedCodexHost, private readonly port: ManagedCodexActionsPort) {}

  /** What a running task of this window shows on the card. Nothing changes once the window is closing. */
  setTask(task: CardTask | undefined): void {
    if (this.abort.signal.aborted) return;
    this.task = task;
    this.port.refresh();
  }

  /**
   * A step of this window's download task, from the updater or from Try again. The card is drawn again only when
   * what it shows changes, so the bytes of a download redraw it once per percent.
   */
  taskEvent(event: UpdaterTaskEvent): void {
    if (this.abort.signal.aborted) return;
    const next = event.type === 'ended' && event.result.outcome === 'verified' && this.checkAfterDownload === event.entry.version
      ? { phase: 'qualifying' as const, version: event.entry.version }
      : cardTaskFor(event, new Date().toISOString());
    if (JSON.stringify(next) === JSON.stringify(this.task)) return;
    this.setTask(next);
  }

  dispose(): void {
    this.abort.abort();
  }

  card(): ManagedCodexCardView {
    const status = this.managed.store.status();
    const instanceView = status.instance?.view;
    const card = managedCodexCard({
      host: { os: 'win32', arch: 'x64' },
      suspension: status.suspension,
      control: status.control,
      ...(instanceView ? { instance: instanceView } : {}),
      ...(status.instance && !status.instance.open.ok ? { instanceProblem: status.instance.open.detail } : {}),
      policy: this.managed.policy,
      ...(this.task ? { task: this.task } : {}),
      formatTime: (iso) => this.port.formatTime(iso),
    });
    const actions: ManagedCodexCardView['actions'] = card.actions.map((item) => ({
      action: item.id as ManagedCodexAction,
      label: item.label,
      ...(item.key ? { key: item.key } : {}),
      ...(item.id === 'review' || item.id === 'set-up' || item.id === 'use-managed-again' ? { primary: true } : {}),
    }));
    const lines = [...card.lines];
    const refusal = this.managed.storeRefusal();
    if (refusal) lines.unshift(refusal);
    const control = status.control;
    if (!status.suspension.present && control.kind === 'readable' && control.authority === 'ok' && control.snapshot.record.enrolledStoreId) {
      const record = control.snapshot.record;
      actions.push(record.scheduler.autoMode
        ? { action: 'auto-off', label: 'Stop updating automatically' }
        : { action: 'auto-on', label: 'Keep updated automatically' });
      if (instanceView && record.selection === 'managed' && record.lastKnownGood && record.active?.key !== record.lastKnownGood.key) {
        actions.push({ action: 'roll-back', label: `Go back to ${keyVersion(record.lastKnownGood.key) ?? 'the earlier version'}…` });
      }
      // Only an instance this window can open can be reset: its gate is closed first.
      if (status.instance?.open.ok && !actions.some((item) => item.action === 'reset')) actions.push({ action: 'reset', label: 'Reset managed Codex…' });
    }
    actions.push({ action: 'forget-adoptions', label: 'Forget chosen external programs…' });
    this.rendered = new Set(actions.map((item) => `${item.action}|${item.key ?? ''}`));
    return { title: STATE_TITLE[card.state] ?? 'Set up', lines, actions };
  }

  /** One of the person's actions; refused unless the last card offered exactly it. */
  async act(action: ManagedCodexAction, key: string | undefined): Promise<void> {
    await this.managed.ready;
    if (!this.rendered.has(`${action}|${key ?? ''}`)) {
      this.port.inform('warning', 'This managed Codex action is no longer offered. The card was updated; choose again.');
      this.port.refresh();
      return;
    }
    try {
      await this.run(action, key);
    } finally {
      this.port.refresh();
    }
  }

  private async run(action: ManagedCodexAction, key: string | undefined): Promise<void> {
    const store = this.managed.store;
    switch (action) {
      case 'set-up': return this.setUp();
      case 'use-external': {
        const answer = await this.port.ask('Use the external Codex CLI for new sessions?', [
          'New sessions use the Codex CLI you chose with Check / choose CLI.',
          'Managed Codex stays set up, with its downloaded versions and your approvals. Choose Use managed Codex to use it again; nothing is downloaded or asked again.',
          'Agents running managed Codex now keep running. UnodeAi does not start managed Codex again for them; start them again to use the external CLI.',
        ], ['Use external CLI']);
        if (answer !== 'Use external CLI') return;
        return this.report(await store.useExternal());
      }
      case 'use-external-suspend': {
        const answer = await this.port.ask('Pause managed Codex in every window?', [
          'UnodeAi cannot use its record of managed Codex now, so it records your choice in a separate file instead.',
          'While that file exists, no managed Codex program starts, downloads or is checked in any window, and new sessions use the external Codex CLI.',
          'When the record can be read again, Use managed Codex again removes the pause.',
        ], ['Use external CLI']);
        if (answer !== 'Use external CLI') return;
        const result = await store.suspend('the person chose the external CLI while managed Codex control could not be used');
        if (!result.ok) this.port.inform('warning', result.reason);
        return;
      }
      case 'use-managed': return this.report(await store.useManaged());
      case 'use-managed-again': {
        const result = await store.clearSuspension();
        if (!result.ok) this.port.inform('warning', result.reason);
        return;
      }
      case 'reset': {
        const answer = await this.port.ask('Reset managed Codex?', [
          'Managed Codex\'s downloaded versions, settings and approvals on this computer will be retired.',
          'Agents running managed Codex keep running until they stop. UnodeAi then does not start them again by itself, even if you set up managed Codex again; start them again yourself.',
          'New agents use the external CLI. Downloaded files are removed later.',
        ], ['Reset managed Codex']);
        if (answer !== 'Reset managed Codex') return;
        this.managed.updater.refresh();
        return this.report(await store.reset());
      }
      case 'update-now': {
        const outcome = await this.managed.updater.updateNow();
        if (!outcome.ran) {
          this.port.inform('information', outcome.reason === 'nothing-newer' ? 'No newer supported Codex version.' : `Nothing was downloaded (${outcome.reason}).`);
        } else if (outcome.result.outcome !== 'verified') {
          this.port.inform('warning', `The download did not finish: ${'detail' in outcome.result ? String(outcome.result.detail) : outcome.result.outcome}.`);
        }
        return;
      }
      case 'auto-on':
      case 'auto-off': {
        const result = await store.setAutoMode(action === 'auto-on');
        this.report(result);
        if (result.ok) { this.managed.updater.start(); this.managed.updater.refresh(); }
        return;
      }
      case 'roll-back': return this.rollBack();
      case 'review': return this.review(key);
      case 'check-again': return this.checkAgain(key);
      case 'try-again': return this.tryAgain(key);
      case 'use-for-new-sessions': {
        const ref = this.enrolledRef();
        if (!ref || !key) return;
        const result = await activateVersion(this.managed.qualification, ref, key);
        if (!result.activated) this.port.inform('warning', `This version is not used for new sessions: ${result.reason}.`);
        return;
      }
      case 'review-settings': return this.reviewSettings();
      case 'repair-store': {
        const ref = this.enrolledRef();
        if (!ref) return;
        const repaired = this.managed.instances.repairManifest(ref);
        if (!repaired.ok) this.port.inform('warning', `UnodeAi could not repair the managed Codex store (${repaired.reason}).`);
        return;
      }
      case 'details': return this.details();
      case 'forget-adoptions': {
        const answer = await this.port.ask('Forget the external CLI programs you chose?', [
          'UnodeAi asks again before it uses each of them for an agent. Programs UnodeAi qualified are not affected.',
        ], ['Forget them']);
        if (answer !== 'Forget them') return;
        this.port.inform('information', `UnodeAi forgot ${this.port.forgetAdoptions()} chosen program(s).`);
        return;
      }
    }
  }

  private async setUp(): Promise<void> {
    const supported = this.managed.policy.entries.filter((entry) => entry.provider === 'codex-cli' && entry.status === 'qualified' && entry.os === 'win32' && entry.arch === 'x64' && entry.managed);
    const hosts = [...new Set([...CODEX_ARTIFACT_HOSTS, ...CODEX_REDIRECT_HOSTS, ...supported.flatMap(entryHosts)])].sort();
    const newest = supported[supported.length - 1];
    const sizes = newest?.managed
      ? `Each version downloads ${Math.round(newest.managed.artifact.size / MIB)} MiB and uses about ${Math.round(newest.managed.layout.unpackedBytes / MIB)} MiB; UnodeAi keeps the newest three versions and at most ${STORE_CAP}.`
      : 'This UnodeAi supports no Codex version for managed use yet, so nothing is downloaded until one that does is installed.';
    const answer = await this.port.ask('Set up managed Codex?', [
      `UnodeAi downloads supported Codex CLI versions into ${this.port.storeFolder}, from ${hosts.join(', ')}.`,
      sizes,
      'Each new version runs only after your OK once. Then UnodeAi starts it once in its own folder to check it, with no model request. Windows PowerShell checks the publisher signatures.',
      'With automatic updates on, UnodeAi looks for a newer supported version at most once a day. New versions are used by new sessions only; running agents keep theirs. You can go back to the earlier version.',
    ], ['Set up and keep it updated', 'Set up, update only when I ask']);
    if (answer !== 'Set up and keep it updated' && answer !== 'Set up, update only when I ask') return;
    const result = await this.managed.store.enrol({ consentedHosts: hosts, autoMode: answer === 'Set up and keep it updated' });
    this.report(result);
    // A window that was not set up at its start has no schedule yet: it begins now.
    if (result.ok) { this.managed.updater.start(); this.managed.updater.refresh(); }
  }

  private async review(key: string | undefined): Promise<void> {
    const ref = this.enrolledRef();
    if (!ref || !key) return;
    const status = this.managed.store.status();
    if (!status.instance?.view) return;
    const offer = clickOffer({ suspension: status.suspension, control: status.control, instance: status.instance.view, policy: this.managed.policy, host: { os: 'win32', arch: 'x64' }, key });
    if (!offer.offered) {
      this.port.inform('information', offer.detail);
      return;
    }
    const dialog = offer.dialog;
    const answer = await this.port.ask(dialog.title, [dialog.intro, ...dialog.facts, dialog.closing], [ACTIVATION_ALLOW]);
    const decision = await this.whileChecking(keyVersion(key) ?? key, answer === ACTIVATION_ALLOW,
      () => decideActivation(this.managed.qualification, ref, key, answer === ACTIVATION_ALLOW ? ACTIVATION_ALLOW : ACTIVATION_NOT_NOW));
    this.reportOutcome(decision);
  }

  private async checkAgain(key: string | undefined): Promise<void> {
    const ref = this.enrolledRef();
    if (!ref || !key) return;
    const view = this.managed.control.read();
    const entry = view.kind === 'readable' ? view.snapshot.record.disabled.find((item) => item.storeId === ref.storeId && item.key === key && item.reason === 'probe-stop-unconfirmed') : undefined;
    const answer = await this.port.ask('Check this Codex version again?', [checkAgainWarning(keyVersion(key) ?? key, entry?.detail)], ['Check again']);
    if (answer !== 'Check again') return;
    this.reportOutcome(await this.whileChecking(keyVersion(key) ?? key, true, () => checkAgain(this.managed.qualification, { ref, key, warningShown: true })));
  }

  private async tryAgain(key: string | undefined): Promise<void> {
    const ref = this.enrolledRef();
    if (!ref || !key) return;
    const answer = await this.port.ask(`Try Codex ${keyVersion(key) ?? key} again?`, [
      'UnodeAi marked this version bad on this computer. Trying again removes its local copy, downloads it again, checks every file and its publisher signatures, and starts it once in UnodeAi\'s folder to check it, with no model request.',
      'It is used again only if all of that passes. Nothing is retried by itself.',
    ], ['Try again']);
    if (answer !== 'Try again') return;
    const version = keyVersion(key) ?? key;
    this.checkAfterDownload = version;
    let outcome: Awaited<ReturnType<typeof tryAgain>>;
    try {
      outcome = await tryAgain(this.managed.qualification, {
        ref, key, userChoice: 'try-again', signal: this.abort.signal,
        askForNewClick: async (dialog) => (await this.port.ask(dialog.title, [dialog.intro, ...dialog.facts, dialog.closing], [ACTIVATION_ALLOW])) === ACTIVATION_ALLOW,
      });
    } finally {
      this.checkAfterDownload = undefined;
      if (this.task?.phase === 'qualifying' && this.task.version === version) this.setTask(undefined);
    }
    if (outcome.outcome === 'in-use' || outcome.outcome === 'retire-failed' || outcome.outcome === 'download-failed' || outcome.outcome === 'consent-not-recorded') {
      this.port.inform('warning', outcome.detail);
      return;
    }
    if (outcome.outcome === 'not-now') return;
    this.reportOutcome(outcome);
  }

  private async rollBack(): Promise<void> {
    const view = this.managed.control.read();
    if (view.kind !== 'readable' || !view.snapshot.record.active || !view.snapshot.record.lastKnownGood) return;
    const from = keyVersion(view.snapshot.record.active.key) ?? 'the current version';
    const to = keyVersion(view.snapshot.record.lastKnownGood.key) ?? 'the earlier version';
    const answer = await this.port.ask(`Go back from Codex ${from} to ${to}?`, [
      `New sessions use Codex ${to}. Running agents keep their version; restart an agent to move it.`,
    ], ['Go back']);
    if (answer !== 'Go back') return;
    this.report(await this.managed.store.rollBack());
  }

  private async reviewSettings(): Promise<void> {
    const view = this.managed.control.read();
    if (view.kind !== 'readable' || view.authority !== 'behind-floor') return;
    const record = view.snapshot.record;
    const hosts = record.enrollment?.consentedHosts ?? [];
    const answer = await this.port.ask('Confirm your managed Codex settings', [
      'UnodeAi could not confirm your last change to managed Codex after an unexpected shutdown. These are the settings it could read; a change you made just before the shutdown may be missing.',
      `Set up: ${record.enrolledStoreId ? 'yes' : 'no'}. New sessions use: ${record.selection === 'managed' ? 'managed Codex' : 'the external CLI'}. Automatic updates: ${record.scheduler.autoMode ? 'on' : 'off'}. Download hosts: ${hosts.join(', ') || 'none'}. Approved versions: ${record.activationConsents.length}.`,
    ], ['Confirm these settings', 'Use external CLI']);
    if (answer === 'Confirm these settings') {
      this.report(await this.managed.store.confirmAfterUncertainShutdown(
        { generation: view.snapshot.generation, digest: view.snapshot.digest },
        { selection: record.selection, autoMode: record.scheduler.autoMode, consentedHosts: hosts },
      ));
    } else if (answer === 'Use external CLI') {
      this.report(await this.managed.store.useExternal());
    }
  }

  private details(): void {
    const status = this.managed.store.status();
    const control = status.control;
    const lines = [`Store: ${this.port.storeFolder}`];
    if (control.kind === 'unusable') lines.push(`Record: ${control.reason} (${control.detail})`);
    else if (control.kind === 'readable') lines.push(`Record: generation ${control.snapshot.generation}, ${control.authority}, protected changes ${control.floor}`);
    if (status.suspension.present) lines.push(`Paused: ${status.suspension.readable ? status.suspension.reason ?? 'yes' : 'the pause file cannot be read'}`);
    if (status.instance) lines.push(`Instance ${status.instance.storeId}: ${status.instance.open.ok ? status.instance.view?.kind ?? 'unknown' : status.instance.open.detail}, admission ${status.instance.admission ?? 'unknown'}`);
    const launchable = status.instance?.view && launchableKey({ suspension: status.suspension, control, instance: status.instance.view, policy: this.managed.policy, host: { os: 'win32', arch: 'x64' } });
    if (launchable) lines.push(launchable.launchable ? `New sessions start Codex ${launchable.versionName}.` : `No version starts: ${launchable.reason}`);
    void this.port.ask('Managed Codex details', lines, []);
  }

  /** The card says the version is being checked while `run` runs, when it runs a check at all. */
  private async whileChecking<T>(version: string, checks: boolean, run: () => Promise<T>): Promise<T> {
    if (!checks) return run();
    this.setTask({ phase: 'qualifying', version });
    try {
      return await run();
    } finally {
      if (this.task?.phase === 'qualifying' && this.task.version === version) this.setTask(undefined);
    }
  }

  private enrolledRef(): InstanceRef | undefined {
    const view = this.managed.control.read();
    const storeId = view.kind === 'readable' ? view.snapshot.record.enrolledStoreId : null;
    if (!storeId) return undefined;
    const open = this.managed.instances.open(storeId);
    return open.ok ? open.ref : undefined;
  }

  private report(result: { ok: true } | { ok: false; reason: string }): void {
    if (!result.ok) this.port.inform('warning', result.reason);
  }

  private reportOutcome(outcome: QualificationOutcome | { outcome: 'not-now' } | { outcome: 'consent-not-recorded'; detail: string }): void {
    switch (outcome.outcome) {
      case 'not-now': return;
      case 'ready':
        this.port.inform('information', outcome.activation.activated ? 'The check passed. New sessions use this Codex version.' : `The check passed. ${outcome.activation.reason}.`);
        return;
      case 'refused': case 'failed': case 'stop-unconfirmed': case 'not-recorded': case 'consent-not-recorded':
        this.port.inform('warning', `The check did not finish: ${outcome.detail}.`);
        return;
    }
  }
}

function entryHosts(entry: PolicyEntry): string[] {
  const artifact = entry.managed?.artifact;
  if (!artifact) return [];
  return [...artifact.urls.map((url) => new URL(url).hostname), ...artifact.redirectHosts];
}
