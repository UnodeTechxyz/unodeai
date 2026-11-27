/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Reply suggestions (v0.9.110)
 *
 *  After an answer, one text request to the reply suggestion model the person chose in User Settings, for one
 *  sentence the composer can offer. It is a single request on the host's one-request text transport: no tools, no
 *  memory, no retrieval, no retry and no fallback to another connection or model. It is its own usage unit under the
 *  root request of the answer, uses what is left of that request's allowed tranche, and never asks the person anything
 *  about a limit: when nothing is left, the request is waiting for a decision or stopped, or its budget cannot be
 *  shown, there is no suggestion and nothing is sent.
 *
 *  The answer's closeout is never delayed for it, and its usage is recorded after the closeout like any late usage.
 *  Off (None), a changed setting, a changed connection, a revoked egress grant, a changed key, Stop or anything the
 *  person does in the composer ends it. What it already used stays recorded.
 *
 *  Why the last attempt for the current setting gave nothing (no key, a declined destination, a provider failure, a
 *  connection without a text API) is kept here, content-free, for the Providers row. It never becomes a chat turn.
 *
 *  VS Code-free: settings, the connection registry, consent, the key, the transport, the limit gate and the spend
 *  records arrive as dependencies.
 *--------------------------------------------------------------------------------------------*/

import type { TurnUsage } from '../backend/AgentBackend';
import { sendOneTextRequest, TextRequestCancelledError, type TextRequestFetch } from '../backend/oneRequestTextTransport';
import { summaryCompletionUsage } from '../compaction/CompactionUsage';
import type { AuxiliaryParentPin, AuxiliaryRefusal, AuxiliaryReservation, AuxiliaryReservationResult } from '../host/RequestCeiling';
import type { MediaModel } from '../models/MediaModelSelection';
import {
  normalizeSuggestionOutput,
  selectSuggestionInput,
  suggestionRequestMessages,
  type SuggestionSourceMessage,
} from './ReplySuggestionInput';

/** Shown in Providers and returned when the chosen connection has no text API this feature can use. */
export const CANNOT_PROVIDE_SUGGESTIONS = 'This connection cannot provide reply suggestions';
/** The Spend label of a suggestion's usage unit. */
export const REPLY_SUGGESTION_SPEND_LABEL = 'Reply suggestion';

/** The connection facts the service needs; never a key value. */
export interface SuggestionConnection {
  connectionId: string;
  revision: number;
  displayName: string;
  /** Whether this connection offers a text API this feature can send one plain request to. */
  textApi: boolean;
  /** Canonical endpoint base of the text API, when it has one. */
  endpointBase?: string;
  /** SecretStorage name of its key; absent means no key slot is configured. */
  apiKeySecretName?: string;
}

/** Why there is no suggestion. Content-free: no text, path or key. */
export type SuggestionSkip =
  | 'off'
  | 'no-input'
  | 'cannot-provide'
  | 'no-key'
  | 'egress-declined'
  | `budget-${AuxiliaryRefusal}`
  | 'cancelled'
  | 'stale'
  | 'failed'
  | 'empty';

export type SuggestionOutcome =
  | { kind: 'suggestion'; text: string; usageUnitId: string }
  | { kind: 'none'; reason: SuggestionSkip; usageUnitId?: string };

export interface SuggestionSpendPort {
  /** One usage unit of the suggestion, under the root request, priced on the chosen connection and model. */
  beginUsageUnit(unit: {
    usageUnitId: string; requestId: string; agentId: string; modelId: string;
    route: { connectionId: string; connectionName: string; route: 'gateway' };
    purpose: 'reply-suggestion';
  }): void;
  noteModelRequest(usageUnitId: string): void;
  settleUsageUnit(usageUnitId: string, usage: TurnUsage | undefined): unknown;
  closeUsageUnit(usageUnitId: string): unknown;
}

export interface SuggestionMeterPort {
  beginUsageUnit(unit: { usageUnitId: string; requestId: string; agentId: string }, counted: 'request'): void;
  noteModelRequest(usageUnitId: string): void;
  settleUsageUnit(usageUnitId: string, usage: { inputTokens: number; outputTokens: number } | undefined): void;
  closeUsageUnit(usageUnitId: string): void;
}

export interface SuggestionCeilingPort {
  pinAuxiliaryParent(requestId: string): AuxiliaryParentPin;
  tryReserveAuxiliary(pin: AuxiliaryParentPin, usageUnitId: string): AuxiliaryReservationResult;
}

export interface ReplySuggestionServiceDeps {
  /** The User Settings value now; undefined is None. */
  readModel(): MediaModel | undefined;
  /** Changes whenever the reply suggestion setting changes. */
  settingsRevision(): number;
  connection(connectionId: string): SuggestionConnection | undefined;
  apiKey(secretName: string): Promise<string | undefined>;
  /** The existing model-egress decision for this connection; throws when it is declined. Nothing is sent before. */
  approveEgress(url: string, scope: { profileId: string; profileRevision: number }, requester: string): Promise<void>;
  /** The host text transport's network call. */
  fetch: TextRequestFetch;
  ceiling: SuggestionCeilingPort;
  meter: SuggestionMeterPort;
  spend: SuggestionSpendPort;
  newId(): string;
  log?(message: string): void;
  /** The local status changed: the Providers row is shown again. */
  statusChanged?(): void;
}

/** The parent budget of one suggestion, pinned when it is offered. Release it once the suggestion is over. */
export interface SuggestionBudget {
  readonly requestId: string;
  release(): void;
}

export interface SuggestionRequest {
  /** Pinned with `pinBudget` when the answer was offered a suggestion. */
  budget: SuggestionBudget;
  agentId: string;
  agentName: string;
  messages: readonly SuggestionSourceMessage[];
  signal: AbortSignal;
}

/** What the Providers row shows for the setting now. Content-free. */
export interface SuggestionSettingView {
  configured: boolean;
  label: string;
  problem?: string;
  /** When the problem is a missing stored key: the key to ask for, through the existing key-setting route. */
  keyAction?: { secretName: string };
}

/** Why the last attempt for this setting gave nothing, as the Providers row says it. */
interface LocalStatus {
  modelKey: string;
  settingsRevision: number;
  problem: string;
  keyAction?: { secretName: string };
}

class SuggestionBudgetPin implements SuggestionBudget {
  constructor(readonly pin: AuxiliaryParentPin) {}
  get requestId(): string { return this.pin.requestId; }
  release(): void { this.pin.release(); }
}

function modelKey(model: MediaModel): string {
  return `${model.connectionId}\u0000${model.modelId}`;
}

export class ReplySuggestionService {
  private readonly operations = new Set<AbortController>();
  /** Moves on every egress revocation, key change or connection change that touches the chosen connection. */
  private authorityEpoch = 0;
  private status?: LocalStatus;

  constructor(private readonly deps: ReplySuggestionServiceDeps) {}

  /** The Providers row: None, or the connection and exact model, with why it cannot be used, or why the last try gave nothing. */
  settingView(): SuggestionSettingView {
    const model = this.deps.readModel();
    if (!model) return { configured: false, label: 'None' };
    const connection = this.deps.connection(model.connectionId);
    const label = `${connection?.displayName ?? model.connectionId} · ${model.modelId}`;
    if (!connection || !connection.textApi || !connection.endpointBase) return { configured: true, label, problem: CANNOT_PROVIDE_SUGGESTIONS };
    if (!connection.apiKeySecretName) return { configured: true, label, problem: 'API key required' };
    const status = this.currentStatus(model);
    return status
      ? { configured: true, label, problem: status.problem, ...(status.keyAction ? { keyAction: status.keyAction } : {}) }
      : { configured: true, label };
  }

  /** Whether a request could be made at all now; cheap, sends nothing. */
  enabled(): boolean {
    return this.deps.readModel() !== undefined;
  }

  /**
   * Pin the parent budget of the answer being offered a suggestion, before anything else waits: the composer's answer,
   * the key, consent. A pin of an unavailable parent is kept too: the suggestion then sends nothing.
   */
  pinBudget(requestId: string): SuggestionBudget {
    return new SuggestionBudgetPin(this.deps.ceiling.pinAuxiliaryParent(requestId));
  }

  /** Off, a changed setting or a changed registry: every operation in flight ends at once. */
  cancelAll(): void {
    this.authorityEpoch += 1;
    for (const controller of [...this.operations]) controller.abort();
    this.operations.clear();
  }

  /**
   * The egress grant or the stored key of a connection changed. When it is the chosen connection (or the connection is
   * not named), every operation ends now, and one still waiting for consent or the key never sends. Returns whether
   * anything of the chosen connection was invalidated, so the chat can drop a suggestion it shows.
   */
  invalidateConnection(connectionId?: string): boolean {
    const model = this.deps.readModel();
    if (connectionId !== undefined && model?.connectionId !== connectionId) return false;
    this.cancelAll();
    // A key that was missing may now be there: the next attempt says again what it finds.
    if (this.status) {
      this.status = undefined;
      this.notifyStatus();
    }
    return true;
  }

  /** The setting changed: the status of the previous setting no longer applies. */
  resetStatus(): void {
    if (!this.status) return;
    this.status = undefined;
    this.notifyStatus();
  }

  async suggest(request: SuggestionRequest): Promise<SuggestionOutcome> {
    const model = this.deps.readModel();
    if (!model) return { kind: 'none', reason: 'off' };
    const settingsRevision = this.deps.settingsRevision();
    const epoch = this.authorityEpoch;
    const connection = this.deps.connection(model.connectionId);
    if (!connection || !connection.textApi || !connection.endpointBase) {
      return this.problem(model, settingsRevision, 'cannot-provide', CANNOT_PROVIDE_SUGGESTIONS);
    }
    if (!connection.apiKeySecretName) return this.problem(model, settingsRevision, 'no-key', 'API key required');
    const pin = request.budget instanceof SuggestionBudgetPin ? request.budget.pin : undefined;
    // A parent whose budget cannot be shown funds nothing; asked before the key or consent, so nothing waits for it.
    if (!pin || pin.state === 'unavailable') return { kind: 'none', reason: 'budget-unavailable' };
    const input = selectSuggestionInput(request.messages);
    if (input.length === 0) return { kind: 'none', reason: 'no-input' };
    if (request.signal.aborted) return { kind: 'none', reason: 'cancelled' };

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });
    this.operations.add(controller);
    const signal = controller.signal;
    /** The setting, the connection and its authority are still those the operation began with. */
    const current = (): boolean => {
      const now = this.deps.readModel();
      const nowConnection = this.deps.connection(model.connectionId);
      return this.authorityEpoch === epoch
        && !!now && now.connectionId === model.connectionId && now.modelId === model.modelId
        && this.deps.settingsRevision() === settingsRevision
        && !!nowConnection && nowConnection.revision === connection.revision
        && nowConnection.endpointBase === connection.endpointBase
        && nowConnection.apiKeySecretName === connection.apiKeySecretName;
    };
    try {
      const apiKey = await this.deps.apiKey(connection.apiKeySecretName);
      if (signal.aborted) return { kind: 'none', reason: 'cancelled' };
      if (!current()) return { kind: 'none', reason: 'stale' };
      if (!apiKey) {
        return this.problem(model, settingsRevision, 'no-key', 'API key required: no key is stored for this connection',
          { secretName: connection.apiKeySecretName });
      }
      return await this.send(request, pin, model, settingsRevision, connection, apiKey, input, signal, current);
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      this.operations.delete(controller);
    }
  }

  private async send(
    request: SuggestionRequest,
    pin: AuxiliaryParentPin,
    model: MediaModel,
    settingsRevision: number,
    connection: SuggestionConnection,
    apiKey: string,
    input: ReturnType<typeof selectSuggestionInput>,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<SuggestionOutcome> {
    const usageUnitId = `suggestion-${this.deps.newId()}`;
    const guarded = (call: () => unknown): void => {
      try { call(); } catch (error) { this.deps.log?.(`[reply-suggestion] accounting skipped: ${String(error)}`); }
    };
    let reservation: AuxiliaryReservation | undefined;
    let refusal: SuggestionSkip | undefined;
    let sent = false;
    let declined = false;
    const close = (): void => {
      if (!reservation) return;
      guarded(() => this.deps.meter.closeUsageUnit(usageUnitId));
      guarded(() => this.deps.spend.closeUsageUnit(usageUnitId));
      reservation.end();
    };
    let response: { ok: boolean; status: number; text: string } | undefined;
    try {
      response = await sendOneTextRequest({
        url: `${connection.endpointBase}/chat/completions`,
        apiKey,
        body: { model: model.modelId, messages: suggestionRequestMessages(input), stream: false },
        scope: { profileId: connection.connectionId, profileRevision: connection.revision },
        signal,
        // Counted as it leaves, once. The meter turns the reservation into the count.
        onRequestSent: () => {
          sent = true;
          guarded(() => this.deps.meter.noteModelRequest(usageUnitId));
          guarded(() => this.deps.spend.noteModelRequest(usageUnitId));
        },
      }, {
        approveEgress: async (url, scope) => {
          try {
            await this.deps.approveEgress(url, scope, `${request.agentName} via ${connection.displayName} (reply suggestion)`);
          } catch (error) {
            declined = true;
            throw error;
          }
        },
        fetch: this.deps.fetch,
        // In the same synchronous step as the send: Stop, the authority and setting, and the shared meter. A late
        // usage settlement of the parent cannot land between this check and the request leaving.
        finalCheck: () => {
          if (signal.aborted) { refusal = 'cancelled'; return false; }
          if (!current()) { refusal = 'stale'; return false; }
          const reserved = this.deps.ceiling.tryReserveAuxiliary(pin, usageUnitId);
          if (!reserved.ok) { refusal = `budget-${reserved.reason}`; return false; }
          reservation = reserved.reservation;
          guarded(() => this.deps.meter.beginUsageUnit({ usageUnitId, requestId: pin.requestId, agentId: reserved.reservation.meterAgentId }, 'request'));
          guarded(() => this.deps.spend.beginUsageUnit({
            usageUnitId, requestId: pin.requestId, agentId: request.agentId, modelId: model.modelId,
            route: { connectionId: connection.connectionId, connectionName: connection.displayName, route: 'gateway' },
            purpose: 'reply-suggestion',
          }));
          if (!reserved.reservation.confirmBeforeSend()) { refusal = 'budget-limit-reached'; return false; }
          return true;
        },
      });
    } catch (error) {
      close();
      if (declined) {
        return signal.aborted || !current()
          ? { kind: 'none', reason: signal.aborted ? 'cancelled' : 'stale' }
          : this.problem(model, settingsRevision, 'egress-declined',
            'Sending to this connection is not allowed. Suggestions do not ask again until you change the model here; choose Allow when an agent of yours next uses this connection, or press Turn off and choose the model again');
      }
      if (error instanceof TextRequestCancelledError && !sent) {
        const reason: SuggestionSkip = refusal ?? (signal.aborted ? 'cancelled' : 'stale');
        return { kind: 'none', reason, ...(reservation ? { usageUnitId } : {}) };
      }
      // The request left and did not come back: what it used is unknown, recorded as such, never as free.
      if (signal.aborted) return { kind: 'none', reason: 'cancelled', usageUnitId };
      if (!current()) return { kind: 'none', reason: 'stale', usageUnitId };
      return this.problem(model, settingsRevision, 'failed', 'The last suggestion request failed before a response arrived', undefined, usageUnitId);
    }
    let usage: TurnUsage | undefined;
    let text: string | undefined;
    if (response.ok) {
      try {
        const data = JSON.parse(response.text) as { choices?: Array<{ message?: { content?: unknown } }> };
        usage = summaryCompletionUsage(data);
        const content = data.choices?.[0]?.message?.content;
        text = typeof content === 'string' ? content : undefined;
      } catch {
        text = undefined;
      }
    }
    // Whatever became of the suggestion, the request was sent and its usage is recorded, after the closeout.
    if (usage) {
      guarded(() => this.deps.meter.settleUsageUnit(usageUnitId, usage));
      guarded(() => this.deps.spend.settleUsageUnit(usageUnitId, usage));
      reservation?.end();
    } else {
      close();
    }
    if (signal.aborted) return { kind: 'none', reason: 'cancelled', usageUnitId };
    if (!current()) return { kind: 'none', reason: 'stale', usageUnitId };
    if (!response.ok) {
      this.deps.log?.(`[reply-suggestion] HTTP ${response.status}`);
      return this.problem(model, settingsRevision, 'failed', `The last suggestion request failed: the provider returned HTTP ${response.status}`,
        undefined, usageUnitId);
    }
    this.clearStatus(model);
    const suggestion = normalizeSuggestionOutput(text);
    return suggestion ? { kind: 'suggestion', text: suggestion, usageUnitId } : { kind: 'none', reason: 'empty', usageUnitId };
  }

  private problem(
    model: MediaModel,
    settingsRevision: number,
    reason: SuggestionSkip,
    problem: string,
    keyAction?: { secretName: string },
    usageUnitId?: string,
  ): SuggestionOutcome {
    // Only for the setting that is still current: a late answer of a previous setting says nothing about this one.
    const now = this.deps.readModel();
    if (now && modelKey(now) === modelKey(model) && this.deps.settingsRevision() === settingsRevision) {
      const changed = this.status?.problem !== problem || this.status?.keyAction?.secretName !== keyAction?.secretName;
      this.status = { modelKey: modelKey(model), settingsRevision, problem, ...(keyAction ? { keyAction } : {}) };
      if (changed) this.notifyStatus();
    }
    return { kind: 'none', reason, ...(usageUnitId ? { usageUnitId } : {}) };
  }

  private clearStatus(model: MediaModel): void {
    if (this.status && this.status.modelKey === modelKey(model)) {
      this.status = undefined;
      this.notifyStatus();
    }
  }

  private currentStatus(model: MediaModel): LocalStatus | undefined {
    const status = this.status;
    return status && status.modelKey === modelKey(model) && status.settingsRevision === this.deps.settingsRevision() ? status : undefined;
  }

  private notifyStatus(): void {
    try { this.deps.statusChanged?.(); } catch { /* the row is shown again on its next refresh */ }
  }
}
