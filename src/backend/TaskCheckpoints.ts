/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Saved task batches (durable work-product checkpoints)
 *
 *  A task dispatched for delivery in batches saves each completed section through one host tool. The host writes
 *  the batch to this machine's workspace storage and flushes it before it confirms anything, so a stop, a timeout
 *  or a lost final reply does not lose what the host already confirmed. A saved batch is reviewable partial work:
 *  it is never the task's result, it makes nothing artifact-ready and it grants no file, command or network
 *  authority. Only the text and the section metadata come from the model; identity, sequence checks, digests and
 *  receipts are the host's. This module is deliberately vscode-free.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'crypto';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { hostToolFailed, hostToolRefusalDetail, hostToolRefused, hostToolSucceeded, type HostToolOutcome } from './toolSummary';
import type { TaskAttemptCard, TaskInputResolver } from './TaskContract';

/** One batch: at most this many bytes of UTF-8 text. */
export const CHECKPOINT_BATCH_MAX_BYTES = 256 * 1024;
/** Every batch one attempt saves, revisions included. */
export const CHECKPOINT_ATTEMPT_MAX_BYTES = 2 * 1024 * 1024;
/** Every batch kept for this workspace on this machine, as this window counts it. */
export const CHECKPOINT_WORKSPACE_MAX_BYTES = 16 * 1024 * 1024;
/** How long saved batches are kept after their attempt ended. A running attempt's batches are never removed. */
export const CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const DELIVERY_MAX_SECTIONS = 32;
export const SAVE_TASK_CHECKPOINT_TOOL = 'save_task_checkpoint';

/** The save tool by any name a route reports for it: bare, or qualified by Claude's files bridge. */
export function isSaveTaskCheckpointToolName(name: string): boolean {
  return name === SAVE_TASK_CHECKPOINT_TOOL || /^mcp__unode_files_[a-f0-9]+__save_task_checkpoint$/.test(name);
}

const SECTION_KEY = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const ATTEMPT_ID = /^attempt-[0-9a-f-]{36}$/;
const RECORD_FILE = /^(\d{6})\.json$/;
const MANIFEST_FILE = 'attempt.json';
const TEMP_MARKER = '.tmp-';
/** The arguments a model may send. Anything else, such as an attempt, a digest or a receipt, is the host's. */
const REQUEST_FIELDS = new Set(['sequence', 'section', 'text', 'revision', 'supersedes', 'final_candidate']);

export interface DeliverySection {
  key: string;
  title?: string;
}

/**
 * How a task delivers. Only `incremental` is stored: a single final reply needs no plan. It is part of the task
 * contract, chosen by whoever dispatched the task, and like the rest of the contract it is a claim about the work,
 * never authority: it adds no tool permission, no budget and no time.
 */
export interface IncrementalDeliveryPlan {
  mode: 'incremental';
  sections: DeliverySection[];
  batchTarget?: string;
  finalAcceptance?: string;
  /** The dispatcher's stated time budget. It is shown; the host neither enforces nor extends it. */
  timeBudgetMinutes?: number;
}

/** Parse `contract.delivery`. Absent, or `mode: "single"`, means one final reply, as before. */
export function parseDeliveryPlan(value: unknown): { plan?: IncrementalDeliveryPlan; error?: string } {
  if (value === undefined) return {};
  if (!isRecord(value)) return { error: 'contract.delivery must be an object.' };
  const allowed = new Set(['mode', 'sections', 'batch_target', 'final_acceptance', 'time_budget_minutes']);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) return { error: `contract.delivery contains unsupported field "${extra}".` };
  if (value.mode === 'single') {
    return Object.keys(value).length === 1
      ? {}
      : { error: 'contract.delivery with mode "single" takes no other field.' };
  }
  if (value.mode !== 'incremental') return { error: 'contract.delivery.mode must be "single" or "incremental".' };
  if (!Array.isArray(value.sections) || value.sections.length === 0 || value.sections.length > DELIVERY_MAX_SECTIONS) {
    return { error: `contract.delivery.sections must list 1 to ${DELIVERY_MAX_SECTIONS} expected sections, in order.` };
  }
  const sections: DeliverySection[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of value.sections.entries()) {
    if (!isRecord(raw) || Object.keys(raw).some((key) => key !== 'key' && key !== 'title')) {
      return { error: `contract.delivery.sections[${index}] must contain only key and title.` };
    }
    if (typeof raw.key !== 'string' || !SECTION_KEY.test(raw.key)) {
      return { error: `contract.delivery.sections[${index}].key must be 1-48 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.` };
    }
    if (keys.has(raw.key)) return { error: `contract.delivery.sections repeats key "${raw.key}".` };
    keys.add(raw.key);
    if (raw.title !== undefined && (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 200)) {
      return { error: `contract.delivery.sections[${index}].title must be 1-200 characters.` };
    }
    sections.push({ key: raw.key, ...(typeof raw.title === 'string' ? { title: raw.title.trim() } : {}) });
  }
  const batchTarget = optionalText(value.batch_target, 'contract.delivery.batch_target', 300);
  if (batchTarget.error) return { error: batchTarget.error };
  const finalAcceptance = optionalText(value.final_acceptance, 'contract.delivery.final_acceptance', 600);
  if (finalAcceptance.error) return { error: finalAcceptance.error };
  const minutes = value.time_budget_minutes;
  if (minutes !== undefined && (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 240)) {
    return { error: 'contract.delivery.time_budget_minutes must be a whole number of minutes from 1 to 240.' };
  }
  return {
    plan: {
      mode: 'incremental',
      sections,
      ...(batchTarget.value ? { batchTarget: batchTarget.value } : {}),
      ...(finalAcceptance.value ? { finalAcceptance: finalAcceptance.value } : {}),
      ...(typeof minutes === 'number' ? { timeBudgetMinutes: minutes } : {}),
    },
  };
}

/** The plan in the contract's own field names, for a stored record re-read through the same parser. */
export function deliveryPlanProposal(plan: unknown): Record<string, unknown> | undefined {
  if (!isRecord(plan)) return undefined;
  return {
    mode: plan.mode,
    sections: plan.sections,
    ...(plan.batchTarget !== undefined ? { batch_target: plan.batchTarget } : {}),
    ...(plan.finalAcceptance !== undefined ? { final_acceptance: plan.finalAcceptance } : {}),
    ...(plan.timeBudgetMinutes !== undefined ? { time_budget_minutes: plan.timeBudgetMinutes } : {}),
  };
}

/**
 * What the executor is told about delivering in batches. Every route that offers the save tool shows this same
 * text, so the rule reads the same on each connection.
 */
export function formatDeliveryPlan(plan: IncrementalDeliveryPlan): string {
  const sections = plan.sections.map((section) => section.title ? `${section.key} (${section.title})` : section.key).join(', ');
  return [
    `Delivery: in batches. Save each completed section with ${SAVE_TASK_CHECKPOINT_TOOL} as soon as it is ready; do not hold the whole deliverable for one final reply.`,
    `Expected sections, in order: ${sections}`,
    `Per batch: ${plan.batchTarget ?? 'one complete section'}; at most ${CHECKPOINT_BATCH_MAX_BYTES / 1024} KiB of UTF-8 text per batch.`,
    `Final acceptance: ${plan.finalAcceptance ?? 'every expected section saved; the host then runs its final check'}.`,
    ...(plan.timeBudgetMinutes ? [`Stated time budget: ${plan.timeBudgetMinutes} minutes (a target; the host does not extend it).`] : []),
    'Number batches 1, 2, 3 ... in the order you save them. To revise a saved section, save it again with revision set to its '
      + 'current revision + 1 and supersedes set to the checkpointId you received for it. Resending the same batch is safe.',
    'A saved batch is reviewable partial work, not the task result. Saving extends no wait, budget or deadline and grants no '
      + 'file, command or network authority.',
  ].join('\n');
}

export const SAVE_TASK_CHECKPOINT_DESCRIPTION = 'Save one completed section of this task\'s work product durably on this '
  + 'machine, for a task dispatched for delivery in batches. The host stores it before it confirms, and returns the '
  + 'checkpointId, digest, size and revision. A saved batch is partial work, not the task result; it grants no file, '
  + 'command or network authority and extends no wait, budget or deadline.';

/** The tool's parameters, shared by every route that offers it. */
export function saveTaskCheckpointParameters(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      sequence: { type: 'integer', description: 'This batch\'s number in this task attempt: 1 for the first batch, then one more than the last batch the host confirmed. Resending a confirmed batch with the same number and content returns the same receipt.' },
      section: { type: 'string', description: 'The expected section key from the host task card.' },
      text: { type: 'string', description: 'The complete text of this section.' },
      revision: { type: 'integer', description: 'Omit, or 1, for a section\'s first save. To replace a saved section: its current revision + 1, with supersedes.' },
      supersedes: { type: 'string', description: 'Only with a revision above 1: the checkpointId of the section revision this one replaces.' },
      final_candidate: { type: 'boolean', description: 'true when you believe every expected section is now saved. The host then reports its final check.' },
    },
    required: ['sequence', 'section', 'text'],
  };
}

export interface CheckpointRequest {
  sequence: number;
  sectionKey: string;
  text: string;
  revision: number;
  supersedes?: string;
  finalCandidate: boolean;
}

/** Read the model's arguments. Fields the host makes are refused by name rather than ignored. */
export function parseCheckpointRequest(args: Record<string, unknown>): { request?: CheckpointRequest; error?: string } {
  const extra = Object.keys(args).find((key) => !REQUEST_FIELDS.has(key));
  if (extra) {
    return { error: `"${extra}" is not an argument of ${SAVE_TASK_CHECKPOINT_TOOL}. Send only sequence, section, text, revision, supersedes and final_candidate; the host makes the attempt, the digest and the receipt.` };
  }
  const sequence = args.sequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999) {
    return { error: 'sequence must be a whole number from 1: 1 for the first batch, then one more than the last confirmed batch.' };
  }
  if (typeof args.section !== 'string' || !args.section) return { error: 'section must name an expected section key from the task card.' };
  if (typeof args.text !== 'string' || !args.text.trim()) return { error: 'text must be the section\'s complete, non-empty text.' };
  const revision = args.revision === undefined ? 1 : args.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    return { error: 'revision must be a whole number from 1.' };
  }
  if (args.supersedes !== undefined && (typeof args.supersedes !== 'string' || !args.supersedes)) {
    return { error: 'supersedes must be the checkpointId the host returned for the revision being replaced.' };
  }
  if (args.final_candidate !== undefined && typeof args.final_candidate !== 'boolean') {
    return { error: 'final_candidate must be true or false.' };
  }
  return {
    request: {
      sequence,
      sectionKey: args.section,
      text: args.text,
      revision,
      ...(typeof args.supersedes === 'string' ? { supersedes: args.supersedes } : {}),
      finalCandidate: args.final_candidate === true,
    },
  };
}

/**
 * Where a saved attempt stands. `window-closed`: its result windows closed while it may still have been running;
 * from then on it saves nothing. `not-running-here`: the record says running, but no attempt of this window has
 * that id, so it ran in a window that has ended, or in another window.
 */
export type CheckpointAttemptState = 'running' | 'settled' | 'cancelled' | 'interrupted' | 'window-closed';
export type CheckpointAttemptView = CheckpointAttemptState | 'not-running-here';

export interface TaskCheckpointRecord {
  schemaVersion: 1;
  checkpointId: string;
  attemptId: string;
  sequence: number;
  sectionKey: string;
  revision: number;
  supersedes?: string;
  finalCandidate: boolean;
  /** SHA-256 of the UTF-8 text. */
  contentSha256: string;
  /** SHA-256 over the section, revision, supersedes, final flag and content digest: the retry identity. */
  requestDigest: string;
  bytes: number;
  savedAt: string;
  text: string;
}

export interface CheckpointAttemptManifest {
  schemaVersion: 1;
  attemptId: string;
  agentId: string;
  coordinatorId: string;
  contractId: string;
  handle?: string;
  objective: string;
  plan: IncrementalDeliveryPlan;
  requiredInputCount: number;
  state: CheckpointAttemptState;
  /** The window that ran the attempt. A record another window wrote is never marked ended by this one. */
  hostInstance: string;
  startedAt: string;
  endedAt?: string;
  /** Recorded at the attempt's end: how many required inputs had no observed read. */
  requiredInputReadNotObservedCount?: number;
  /** The batches were deleted by the person, or removed after the retention period. The record says which. */
  removed?: { reason: 'deleted' | 'expired'; at: string };
}

/** The host facts of an attempt that its first saved batch records. */
export interface CheckpointAttemptContext {
  attemptId: string;
  agentId: string;
  coordinatorId: string;
  contractId: string;
  handle?: string;
  objective: string;
  plan: IncrementalDeliveryPlan;
  requiredInputCount: number;
  startedAt: string;
  /** The live fact at this save: required inputs whose read the host has not observed. */
  requiredInputsNotRead?: number;
}

export interface TaskCheckpointReceipt {
  checkpointId: string;
  sequence: number;
  sectionKey: string;
  revision: number;
  contentSha256: string;
  bytes: number;
  savedAt: string;
  coveredSections: string[];
  remainingSections: string[];
  batchesSaved: number;
  attemptBytes: number;
  /** The same batch had been confirmed before; nothing new was written. */
  replay: boolean;
  finalCheck?: CheckpointFinalCheck;
}

export type CheckpointRefusalReason =
  | 'unavailable' | 'invalid' | 'unknown-section' | 'too-large' | 'sequence-conflict' | 'sequence-out-of-order'
  | 'revision-conflict' | 'attempt-quota' | 'workspace-quota' | 'persist-failed' | 'removed' | 'attempt-ended';

export type CheckpointSaveResult =
  | { status: 'saved'; receipt: TaskCheckpointReceipt }
  | { status: 'refused'; reason: CheckpointRefusalReason; message: string };

/**
 * The host's final check over the saved batches: for each expected section, the one latest revision. Complete only
 * when every expected section is saved, no two batches claim the same section revision, and every required input
 * of the attempt was observed read. Complete means the set is whole, never that its content was checked.
 */
export interface CheckpointFinalCheck {
  status: 'complete' | 'incomplete';
  selection: Array<{ sectionKey: string; revision: number; checkpointId: string; contentSha256: string; bytes: number }>;
  missingSections: string[];
  conflicts: string[];
  /** Required inputs whose read the host did not observe; `unknown` when the attempt's record does not say. */
  requiredInputsNotRead: number | 'unknown';
  /** The batch that claimed to complete the set, if one did. */
  finalCandidateSequence?: number;
}

export interface CheckpointAttemptSummary {
  attemptId: string;
  agentId: string;
  coordinatorId: string;
  handle?: string;
  objective: string;
  plan: IncrementalDeliveryPlan;
  state: CheckpointAttemptView;
  startedAt: string;
  endedAt?: string;
  batches: number;
  bytes: number;
  lastSavedAt?: string;
  coveredSections: string[];
  remainingSections: string[];
  finalCheck: CheckpointFinalCheck;
  removed?: { reason: 'deleted' | 'expired'; at: string };
  /** When an ended attempt's batches will be removed. Absent while they are pinned. */
  expiresAt?: string;
  pinned: boolean;
}

export interface CheckpointLoadReport {
  attempts: number;
  batches: number;
  /** Partial writes of batches the host never confirmed. They are removed and never listed. */
  discardedUnconfirmed: number;
  /** Entries that could not be read or whose digest does not match. They are left on disk and never listed. */
  damaged: number;
}

/** The file operations the store uses; replaced in tests to make a write fail. */
export interface CheckpointFileSystem {
  mkdir(dir: string): Promise<void>;
  /** Create the file (it must not exist), write the text and flush it to disk before resolving. */
  writeDurable(file: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  readFile(file: string): Promise<string>;
  rm(target: string): Promise<void>;
  /** Flush a directory entry change where the platform allows it. Best effort. */
  syncDir(dir: string): Promise<void>;
}

export const nodeCheckpointFileSystem: CheckpointFileSystem = {
  mkdir: async (dir) => { await fsp.mkdir(dir, { recursive: true }); },
  writeDurable: async (file, text) => {
    const handle = await fsp.open(file, 'wx');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => fsp.rename(from, to),
  readdir: (dir) => fsp.readdir(dir),
  readFile: (file) => fsp.readFile(file, 'utf8'),
  rm: (target) => fsp.rm(target, { recursive: true, force: true }),
  syncDir: async (dir) => {
    // Windows cannot open a directory for flushing; a rename there is as durable as the file system makes it.
    if (process.platform === 'win32') return;
    const handle = await fsp.open(dir, 'r');
    try { await handle.sync(); } catch { /* best effort */ } finally { await handle.close(); }
  },
};

interface StoredAttempt {
  manifest: CheckpointAttemptManifest;
  /** Confirmed batches, by sequence. */
  records: TaskCheckpointRecord[];
  bytes: number;
}

/**
 * The durable store of saved batches for one workspace. One directory per attempt, one file per batch, each written
 * to a temporary name, flushed and renamed into place before the host confirms it. A batch is in the store exactly
 * when the host confirmed it: a crash before the rename leaves a temporary file that the next load removes.
 */
export class TaskCheckpointStore {
  /** This window's identity, written on every attempt record it creates. */
  readonly hostInstance = randomUUID();
  private readonly attempts = new Map<string, StoredAttempt>();
  /** Attempts that saved a batch in this window and have not been seen to end. Their batches are pinned. */
  private readonly running = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private loading: Promise<CheckpointLoadReport> | undefined;
  private readonly fs: CheckpointFileSystem;
  private readonly now: () => number;

  constructor(private readonly options: {
    /** The workspace's own storage folder on this machine; undefined when no folder is open. */
    root?: string;
    fs?: CheckpointFileSystem;
    now?: () => number;
  }) {
    this.fs = options.fs ?? nodeCheckpointFileSystem;
    this.now = options.now ?? Date.now;
  }

  get available(): boolean {
    return !!this.options.root;
  }

  /** Read what earlier windows saved. Partial writes are removed; damaged entries are counted and left alone. */
  load(): Promise<CheckpointLoadReport> {
    this.loading ??= this.readAll();
    return this.loading;
  }

  /**
   * Save one batch. `stillLive` is the attempt's authority, asked again after the batch is flushed and before it is
   * renamed into place: an attempt that ended meanwhile (a stop, its result windows closing) saves nothing.
   */
  async save(
    context: CheckpointAttemptContext,
    request: CheckpointRequest,
    stillLive: () => boolean = () => true,
  ): Promise<CheckpointSaveResult> {
    if (!this.options.root) {
      return refusedSave('unavailable', 'batches cannot be saved here: this window has no workspace storage (open a folder or workspace). Nothing was saved.');
    }
    await this.load().catch(() => undefined);
    return this.locked(context.attemptId, () => this.saveLocked(context, request, stillLive));
  }

  /** Record how the attempt ended. Its batches stay, and their retention period starts now. */
  async attemptEnded(attemptId: string, state: Exclude<CheckpointAttemptState, 'running'>, requiredInputReadNotObservedCount?: number): Promise<void> {
    this.running.delete(attemptId);
    await this.locked(attemptId, async () => {
      const stored = this.attempts.get(attemptId);
      if (!stored || stored.manifest.state !== 'running') return;
      const manifest: CheckpointAttemptManifest = {
        ...stored.manifest,
        state,
        endedAt: new Date(this.now()).toISOString(),
        ...(typeof requiredInputReadNotObservedCount === 'number' ? { requiredInputReadNotObservedCount } : {}),
      };
      stored.manifest = manifest;
      // The in-memory record is already ended. A failed write leaves the file saying running, which a later window
      // shows as not running there and keeps for the retention period from its last batch.
      await this.writeManifest(manifest).catch(() => undefined);
    });
  }

  /** Remove a confirmed batch whose attempt ended while it was being written, so the end comes first. */
  async withdraw(attemptId: string, checkpointId: string): Promise<void> {
    await this.locked(attemptId, async () => {
      const stored = this.attempts.get(attemptId);
      const index = stored?.records.findIndex((record) => record.checkpointId === checkpointId) ?? -1;
      if (!stored || index < 0) return;
      const [record] = stored.records.splice(index, 1);
      stored.bytes -= record.bytes;
      await this.fs.rm(this.recordPath(attemptId, record.sequence)).catch(() => undefined);
    });
  }

  /**
   * `requiredInputsNotRead` is the live fact of an attempt this window still holds; without it the record's own,
   * which is written when the attempt ends.
   */
  summary(attemptId: string, requiredInputsNotRead?: number): CheckpointAttemptSummary | undefined {
    const stored = this.attempts.get(attemptId);
    return stored ? this.summarize(stored, requiredInputsNotRead) : undefined;
  }

  summaryForHandle(handle: string, requiredInputsNotRead?: (attemptId: string) => number | undefined): CheckpointAttemptSummary | undefined {
    const stored = [...this.attempts.values()].find((entry) => entry.manifest.handle === handle);
    return stored ? this.summarize(stored, requiredInputsNotRead?.(stored.manifest.attemptId)) : undefined;
  }

  /** Newest first: every attempt that holds batches, and those whose batches were removed. */
  list(): CheckpointAttemptSummary[] {
    return [...this.attempts.values()]
      .filter((stored) => stored.records.length > 0 || !!stored.manifest.removed)
      .map((stored) => this.summarize(stored))
      .sort((left, right) => (right.lastSavedAt ?? right.startedAt).localeCompare(left.lastSavedAt ?? left.startedAt));
  }

  /** The confirmed batches the final check selected, in the plan's order, with their text. */
  selectedBatches(attemptId: string, sectionKeys?: readonly string[]): TaskCheckpointRecord[] {
    const stored = this.attempts.get(attemptId);
    if (!stored || stored.manifest.removed) return [];
    // Which revision of each section is selected does not depend on the input facts.
    const check = checkpointFinalCheck(stored.manifest.plan, stored.records, 0);
    const wanted = sectionKeys?.length ? new Set(sectionKeys) : undefined;
    return check.selection
      .filter((entry) => !wanted || wanted.has(entry.sectionKey))
      .map((entry) => stored.records.find((record) => record.checkpointId === entry.checkpointId)!)
      .map((record) => ({ ...record }));
  }

  /**
   * The person deletes an attempt's batches. A running attempt's batches are pinned and are not deleted: stop the
   * task first. The attempt keeps a small record that says its batches were deleted.
   */
  async deleteAttempt(attemptId: string): Promise<'deleted' | 'running' | 'unknown' | 'failed'> {
    // Answered at once for an attempt already pinned. The decision itself is taken under the attempt's lock, after
    // every save and end queued before it: a first save under way when the person asked pins its attempt only once
    // its batch is confirmed.
    if (this.running.has(attemptId)) return 'running';
    return this.locked(attemptId, async () => {
      if (this.running.has(attemptId)) return 'running';
      const stored = this.attempts.get(attemptId);
      if (!stored) return 'unknown';
      return await this.removeContent(stored, 'deleted') ? 'deleted' : 'failed';
    });
  }

  /** Remove the batches of attempts whose retention period ended. Running attempts are never touched. */
  async pruneExpired(): Promise<number> {
    let removed = 0;
    for (const stored of [...this.attempts.values()]) {
      const attemptId = stored.manifest.attemptId;
      if (this.running.has(attemptId)) continue;
      if (stored.manifest.removed) {
        if (Date.parse(stored.manifest.removed.at) + CHECKPOINT_RETENTION_MS <= this.now()) {
          await this.locked(attemptId, async () => {
            await this.fs.rm(this.attemptDir(attemptId)).catch(() => undefined);
            this.attempts.delete(attemptId);
          });
        }
        continue;
      }
      const expiresAt = this.expiresAt(stored);
      if (expiresAt === undefined || expiresAt > this.now()) continue;
      if (await this.locked(attemptId, () => this.removeContent(stored, 'expired'))) removed++;
    }
    return removed;
  }

  private async saveLocked(
    context: CheckpointAttemptContext,
    request: CheckpointRequest,
    stillLive: () => boolean,
  ): Promise<CheckpointSaveResult> {
    const stored = this.attempts.get(context.attemptId);
    if (stored?.manifest.removed) {
      return refusedSave('removed', `the saved batches of this task were ${stored.manifest.removed.reason}; nothing was saved.`);
    }
    if (stored && stored.manifest.state !== 'running') return attemptEndedRefusal();
    const plan = context.plan;
    const records = stored?.records ?? [];
    const contentSha256 = sha256(request.text);
    const bytes = Buffer.byteLength(request.text, 'utf8');
    const requestDigest = sha256(JSON.stringify([request.sectionKey, request.revision, request.supersedes ?? null, request.finalCandidate, contentSha256]));

    // A batch the host already confirmed: the same one again is a retry; anything else under its number is refused.
    const prior = records.find((record) => record.sequence === request.sequence);
    if (prior) {
      if (prior.requestDigest === requestDigest) {
        return { status: 'saved', receipt: this.receipt(stored!, prior, true, context.requiredInputsNotRead) };
      }
      return refusedSave('sequence-conflict', `batch ${request.sequence} is already saved with different content (checkpoint ${prior.checkpointId}, section ${prior.sectionKey} revision ${prior.revision}). Nothing was saved. Send a new batch as sequence ${nextSequence(records)}; to replace a section, raise its revision and name supersedes.`);
    }
    const expected = nextSequence(records);
    if (request.sequence !== expected) {
      return refusedSave('sequence-out-of-order', `the next batch of this task is sequence ${expected}, not ${request.sequence}. Nothing was saved.`);
    }
    if (!plan.sections.some((section) => section.key === request.sectionKey)) {
      return refusedSave('unknown-section', `"${request.sectionKey}" is not an expected section of this task. Expected: ${plan.sections.map((section) => section.key).join(', ')}. Nothing was saved.`);
    }
    if (bytes > CHECKPOINT_BATCH_MAX_BYTES) {
      return refusedSave('too-large', `this batch is ${bytes} bytes; one batch holds at most ${CHECKPOINT_BATCH_MAX_BYTES} bytes of UTF-8 text. Split the section and save smaller batches. Nothing was saved.`);
    }
    const current = latestRevision(records, request.sectionKey);
    if (!current) {
      if (request.revision !== 1 || request.supersedes !== undefined) {
        return refusedSave('revision-conflict', `section ${request.sectionKey} has no saved revision yet; save it as revision 1 without supersedes. Nothing was saved.`);
      }
    } else if (request.revision !== current.revision + 1 || request.supersedes !== current.checkpointId) {
      return refusedSave('revision-conflict', `section ${request.sectionKey} is saved at revision ${current.revision} (checkpoint ${current.checkpointId}). To replace it, send revision ${current.revision + 1} with supersedes "${current.checkpointId}". Nothing was saved.`);
    }
    const attemptBytes = stored?.bytes ?? 0;
    if (attemptBytes + bytes > CHECKPOINT_ATTEMPT_MAX_BYTES) {
      return refusedSave('attempt-quota', `this task's saved batches would exceed ${CHECKPOINT_ATTEMPT_MAX_BYTES / (1024 * 1024)} MiB. The ${records.length} batch(es) already saved (${attemptBytes} bytes) are kept; nothing new was saved.`);
    }
    if (this.workspaceBytes() + bytes > CHECKPOINT_WORKSPACE_MAX_BYTES) {
      await this.pruneExpiredUnlocked(context.attemptId);
      if (this.workspaceBytes() + bytes > CHECKPOINT_WORKSPACE_MAX_BYTES) {
        return refusedSave('workspace-quota', `saved batches for this workspace would exceed ${CHECKPOINT_WORKSPACE_MAX_BYTES / (1024 * 1024)} MiB. Every batch already saved is kept, including this task's ${records.length}; nothing new was saved. The person can delete old saved batches.`);
      }
    }

    const record: TaskCheckpointRecord = {
      schemaVersion: 1,
      checkpointId: `ckpt-${randomUUID()}`,
      attemptId: context.attemptId,
      sequence: request.sequence,
      sectionKey: request.sectionKey,
      revision: request.revision,
      ...(request.supersedes ? { supersedes: request.supersedes } : {}),
      finalCandidate: request.finalCandidate,
      contentSha256,
      requestDigest,
      bytes,
      savedAt: new Date(this.now()).toISOString(),
      text: request.text,
    };
    const manifest = stored?.manifest ?? this.newManifest(context);
    const file = this.recordPath(context.attemptId, record.sequence);
    let ended = false;
    try {
      await this.fs.mkdir(this.attemptDir(context.attemptId));
      if (!stored) await this.writeManifest(manifest);
      ended = !await this.writeAtomic(file, JSON.stringify(record), stillLive);
    } catch (error) {
      return refusedSave('persist-failed', `the batch could not be written to disk (${errorCode(error)}). It was NOT saved; batches saved before are unchanged.`);
    }
    // The end came first: nothing of this batch was renamed into place, or what was is taken back before any answer.
    if (ended || !stillLive()) {
      if (!ended) await this.fs.rm(file).catch(() => undefined);
      return attemptEndedRefusal();
    }
    // Confirmed: on disk first, then in the index, then the receipt.
    const entry = stored ?? { manifest, records: [], bytes: 0 };
    entry.records.push(record);
    entry.bytes += bytes;
    this.attempts.set(context.attemptId, entry);
    this.running.add(context.attemptId);
    return { status: 'saved', receipt: this.receipt(entry, record, false, context.requiredInputsNotRead) };
  }

  private newManifest(context: CheckpointAttemptContext): CheckpointAttemptManifest {
    return {
      schemaVersion: 1,
      attemptId: context.attemptId,
      agentId: context.agentId,
      coordinatorId: context.coordinatorId,
      contractId: context.contractId,
      ...(context.handle ? { handle: context.handle } : {}),
      objective: context.objective.slice(0, 500),
      plan: context.plan,
      requiredInputCount: context.requiredInputCount,
      state: 'running',
      hostInstance: this.hostInstance,
      startedAt: context.startedAt,
    };
  }

  private receipt(stored: StoredAttempt, record: TaskCheckpointRecord, replay: boolean, requiredInputsNotRead?: number): TaskCheckpointReceipt {
    const summary = this.summarize(stored, requiredInputsNotRead);
    return {
      checkpointId: record.checkpointId,
      sequence: record.sequence,
      sectionKey: record.sectionKey,
      revision: record.revision,
      contentSha256: record.contentSha256,
      bytes: record.bytes,
      savedAt: record.savedAt,
      coveredSections: summary.coveredSections,
      remainingSections: summary.remainingSections,
      batchesSaved: summary.batches,
      attemptBytes: summary.bytes,
      replay,
      ...(record.finalCandidate ? { finalCheck: summary.finalCheck } : {}),
    };
  }

  private summarize(stored: StoredAttempt, requiredInputsNotRead?: number): CheckpointAttemptSummary {
    const { manifest } = stored;
    const check = checkpointFinalCheck(manifest.plan, stored.records, requiredInputsNotRead ?? this.requiredInputsNotRead(stored));
    const covered = new Set(stored.records.map((record) => record.sectionKey));
    const lastSavedAt = stored.records.reduce<string | undefined>((latest, record) =>
      !latest || record.savedAt > latest ? record.savedAt : latest, undefined);
    const pinned = this.running.has(manifest.attemptId);
    const expiresAt = manifest.removed ? undefined : this.expiresAt(stored);
    return {
      attemptId: manifest.attemptId,
      agentId: manifest.agentId,
      coordinatorId: manifest.coordinatorId,
      ...(manifest.handle ? { handle: manifest.handle } : {}),
      objective: manifest.objective,
      plan: manifest.plan,
      state: manifest.state === 'running' && !pinned ? 'not-running-here' : manifest.state,
      startedAt: manifest.startedAt,
      ...(manifest.endedAt ? { endedAt: manifest.endedAt } : {}),
      batches: stored.records.length,
      bytes: stored.bytes,
      ...(lastSavedAt ? { lastSavedAt } : {}),
      coveredSections: manifest.plan.sections.map((section) => section.key).filter((key) => covered.has(key)),
      remainingSections: manifest.plan.sections.map((section) => section.key).filter((key) => !covered.has(key)),
      finalCheck: check,
      ...(manifest.removed ? { removed: { ...manifest.removed } } : {}),
      ...(expiresAt !== undefined && !pinned ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      pinned,
    };
  }

  private requiredInputsNotRead(stored: StoredAttempt): number | 'unknown' {
    if (stored.manifest.requiredInputCount === 0) return 0;
    return typeof stored.manifest.requiredInputReadNotObservedCount === 'number'
      ? stored.manifest.requiredInputReadNotObservedCount
      : 'unknown';
  }

  /** When an ended attempt's batches go. One that never recorded its end is kept from its last activity. */
  private expiresAt(stored: StoredAttempt): number | undefined {
    if (this.running.has(stored.manifest.attemptId)) return undefined;
    const lastActivity = stored.records.reduce((latest, record) => Math.max(latest, Date.parse(record.savedAt)), Date.parse(stored.manifest.startedAt));
    const ended = stored.manifest.endedAt ? Date.parse(stored.manifest.endedAt) : lastActivity;
    const from = Number.isFinite(ended) ? ended : lastActivity;
    return Number.isFinite(from) ? from + CHECKPOINT_RETENTION_MS : undefined;
  }

  private workspaceBytes(): number {
    let total = 0;
    for (const stored of this.attempts.values()) total += stored.bytes;
    return total;
  }

  /** Inside a save that holds its own attempt's lock: prune every other attempt that expired. */
  private async pruneExpiredUnlocked(currentAttemptId: string): Promise<void> {
    for (const stored of [...this.attempts.values()]) {
      if (stored.manifest.attemptId === currentAttemptId || stored.manifest.removed) continue;
      const expiresAt = this.expiresAt(stored);
      if (expiresAt !== undefined && expiresAt <= this.now()) await this.removeContent(stored, 'expired');
    }
  }

  private async removeContent(stored: StoredAttempt, reason: 'deleted' | 'expired'): Promise<boolean> {
    const attemptId = stored.manifest.attemptId;
    const manifest: CheckpointAttemptManifest = { ...stored.manifest, removed: { reason, at: new Date(this.now()).toISOString() } };
    try {
      // The record says removed before any batch goes: a failure in between leaves batches no listing offers.
      await this.writeManifest(manifest);
      for (const record of stored.records) await this.fs.rm(this.recordPath(attemptId, record.sequence));
    } catch {
      return false;
    }
    stored.manifest = manifest;
    stored.records = [];
    stored.bytes = 0;
    return true;
  }

  private async readAll(): Promise<CheckpointLoadReport> {
    const report: CheckpointLoadReport = { attempts: 0, batches: 0, discardedUnconfirmed: 0, damaged: 0 };
    const root = this.options.root;
    if (!root) return report;
    let names: string[];
    try {
      names = await this.fs.readdir(root);
    } catch {
      return report;
    }
    for (const name of names) {
      if (!ATTEMPT_ID.test(name) || this.attempts.has(name)) continue;
      const dir = path.join(root, name);
      let files: string[];
      try { files = await this.fs.readdir(dir); } catch { continue; }
      for (const file of files.filter((candidate) => candidate.includes(TEMP_MARKER))) {
        // A batch written but never renamed into place was never confirmed. It is not the person's saved work.
        await this.fs.rm(path.join(dir, file)).catch(() => undefined);
        report.discardedUnconfirmed++;
      }
      const manifest = restoreManifest(await this.readJson(path.join(dir, MANIFEST_FILE)), name);
      if (!manifest) {
        report.damaged++;
        continue;
      }
      const records: TaskCheckpointRecord[] = [];
      for (const file of files.filter((candidate) => RECORD_FILE.test(candidate)).sort()) {
        const record = await this.readJson(path.join(dir, file));
        if (isRecordOf(record, name, Number(RECORD_FILE.exec(file)![1]))) records.push(record);
        else report.damaged++;
      }
      records.sort((left, right) => left.sequence - right.sequence);
      this.attempts.set(name, {
        manifest,
        records: manifest.removed ? [] : records,
        bytes: manifest.removed ? 0 : records.reduce((sum, record) => sum + record.bytes, 0),
      });
      report.attempts++;
      report.batches += manifest.removed ? 0 : records.length;
    }
    return report;
  }

  private async readJson(file: string): Promise<unknown> {
    try { return JSON.parse(await this.fs.readFile(file)); } catch { return undefined; }
  }

  private async writeManifest(manifest: CheckpointAttemptManifest): Promise<void> {
    await this.fs.mkdir(this.attemptDir(manifest.attemptId));
    await this.writeAtomic(path.join(this.attemptDir(manifest.attemptId), MANIFEST_FILE), JSON.stringify(manifest));
  }

  /**
   * Write to a temporary name, flush, then rename into place. Nothing is ever confirmed before the rename. Returns
   * false, having written nothing in place, when `proceed` says no once the text is flushed.
   */
  private async writeAtomic(file: string, text: string, proceed: () => boolean = () => true): Promise<boolean> {
    const temp = `${file}${TEMP_MARKER}${randomUUID()}`;
    try {
      await this.fs.writeDurable(temp, text);
      if (!proceed()) {
        await this.fs.rm(temp).catch(() => undefined);
        return false;
      }
      await this.fs.rename(temp, file);
    } catch (error) {
      await this.fs.rm(temp).catch(() => undefined);
      throw error;
    }
    await this.fs.syncDir(path.dirname(file)).catch(() => undefined);
    return true;
  }

  private attemptDir(attemptId: string): string {
    if (!ATTEMPT_ID.test(attemptId)) throw new Error('not a host attempt id');
    return path.join(this.options.root!, attemptId);
  }

  private recordPath(attemptId: string, sequence: number): string {
    return path.join(this.attemptDir(attemptId), `${String(sequence).padStart(6, '0')}.json`);
  }

  /** One attempt's saves, ends, withdrawals and removals run one at a time. */
  private locked<T>(attemptId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(attemptId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => undefined);
    this.locks.set(attemptId, tail);
    void tail.then(() => { if (this.locks.get(attemptId) === tail) this.locks.delete(attemptId); });
    return next;
  }
}

/** The final check of a plan over confirmed batches. Pure: the same batches always give the same answer. */
export function checkpointFinalCheck(
  plan: IncrementalDeliveryPlan,
  records: readonly TaskCheckpointRecord[],
  requiredInputsNotRead: number | 'unknown',
): CheckpointFinalCheck {
  const selection: CheckpointFinalCheck['selection'] = [];
  const missingSections: string[] = [];
  const conflicts: string[] = [];
  for (const section of plan.sections) {
    const latest = latestRevision(records, section.key);
    if (!latest) {
      missingSections.push(section.key);
      continue;
    }
    const rivals = records.filter((record) => record.sectionKey === section.key && record.revision === latest.revision);
    if (rivals.length > 1) conflicts.push(`${section.key} revision ${latest.revision} is claimed by ${rivals.length} batches`);
    selection.push({
      sectionKey: latest.sectionKey,
      revision: latest.revision,
      checkpointId: latest.checkpointId,
      contentSha256: latest.contentSha256,
      bytes: latest.bytes,
    });
  }
  const finalCandidate = [...records].reverse().find((record) => record.finalCandidate);
  const complete = missingSections.length === 0 && conflicts.length === 0 && requiredInputsNotRead === 0;
  return {
    status: complete ? 'complete' : 'incomplete',
    selection,
    missingSections,
    conflicts,
    requiredInputsNotRead,
    ...(finalCandidate ? { finalCandidateSequence: finalCandidate.sequence } : {}),
  };
}

/** One line a person or a coordinator reads: what the final check found, never more than it found. */
export function describeFinalCheck(check: CheckpointFinalCheck): string {
  if (check.status === 'complete') {
    return `complete: every expected section saved (${check.selection.map((entry) => `${entry.sectionKey}@${entry.revision}`).join(', ')}); `
      + 'this checks that the set is whole, not its content';
  }
  const problems = [
    ...(check.missingSections.length ? [`missing ${check.missingSections.join(', ')}`] : []),
    ...check.conflicts,
    ...(check.requiredInputsNotRead === 'unknown'
      ? ['required-input reads not known']
      : check.requiredInputsNotRead > 0 ? [`${check.requiredInputsNotRead} required input(s) not observed read`] : []),
  ];
  return `INCOMPLETE: ${problems.join('; ')}`;
}

/**
 * One line for the coordinator about a handle's saved batches. A stopped task's batches are named as its draft, the
 * person's alone to recover; every other state points at the tool that reads them.
 */
export function describeSavedBatches(summary: CheckpointAttemptSummary | undefined, handle: string, stopped = false): string {
  if (summary?.removed) return `saved batches: unavailable; they were ${summary.removed.reason} at ${summary.removed.at}`;
  if (!summary || summary.batches === 0) {
    return stopped ? 'saved batches: none; nothing of this task was saved before it stopped' : 'saved batches: none yet';
  }
  const covered = summary.finalCheck.selection.map((entry) => `${entry.sectionKey}@${entry.revision}`).join(', ');
  const line = `saved batches: ${summary.batches} · covered ${summary.coveredSections.length} of ${summary.plan.sections.length}`
    + ` (${covered}) · remaining: ${summary.remainingSections.join(', ') || 'none'} · last saved at ${summary.lastSavedAt}`;
  if (stopped || summary.state === 'cancelled') {
    return `${line} · kept as a stopped task's draft: only the person can open or recover it (UnodeAi: Saved Task Batches); nothing of it was delivered`;
  }
  return `${line} · final check: ${describeFinalCheck(summary.finalCheck)} · read them with read_saved_batches handle "${handle}"`;
}

/**
 * The selected batches as one text: a host header with the attempt's state and final check, then each section
 * under a host line naming its exact revision. It is the explicit section set, never the batches strung together.
 * `maxChars` bounds what one read returns; sections past it are named and not shown.
 */
export function formatSavedBatches(
  handle: string | undefined,
  summary: CheckpointAttemptSummary,
  batches: readonly TaskCheckpointRecord[],
  maxChars = Number.POSITIVE_INFINITY,
): string {
  const header = `[host: saved batches${handle ? ` of handle ${handle}` : ''} · attempt state ${summary.state} · `
    + `${summary.batches} batch(es) saved · final check ${describeFinalCheck(summary.finalCheck)}. `
    + 'Partial work: it is not the task result and was not checked for content.]';
  const parts = [header];
  let used = header.length;
  const omitted: string[] = [];
  for (const batch of batches) {
    const block = `[section ${batch.sectionKey} · revision ${batch.revision} · checkpoint ${batch.checkpointId} · sha256 ${batch.contentSha256}]\n${batch.text}`;
    if (used + block.length > maxChars) {
      if (parts.length > 1) {
        omitted.push(batch.sectionKey);
        continue;
      }
      // One section larger than the whole read: its start is shown, and the cut is said where it is.
      const shown = Math.max(0, maxChars - used);
      parts.push(`${block.slice(0, shown)}\n[host: section ${batch.sectionKey} cut after ${shown} characters of ${block.length}; the person can open the whole draft.]`);
      used = maxChars;
      continue;
    }
    parts.push(block);
    used += block.length + 2;
  }
  if (omitted.length) parts.push(`[host: not shown to stay within this read's size: ${omitted.join(', ')}. Ask for them by section.]`);
  return parts.join('\n\n');
}

/** The model-facing confirmation. It names only host-made facts. */
export function describeCheckpointReceipt(receipt: TaskCheckpointReceipt): string {
  return [
    `${receipt.replay ? 'Already saved' : 'Saved'} batch ${receipt.sequence} durably: checkpointId ${receipt.checkpointId}, `
      + `section ${receipt.sectionKey} revision ${receipt.revision}, ${receipt.bytes} bytes, sha256 ${receipt.contentSha256}.`,
    `Covered ${receipt.coveredSections.length} of ${receipt.coveredSections.length + receipt.remainingSections.length} expected sections`
      + `${receipt.coveredSections.length ? ` (${receipt.coveredSections.join(', ')})` : ''}; `
      + `remaining: ${receipt.remainingSections.length ? receipt.remainingSections.join(', ') : 'none'}.`,
    ...(receipt.finalCheck ? [`Final check: ${describeFinalCheck(receipt.finalCheck)}.`] : []),
    'This is saved partial work, not the task result; continue with the next section, or finish the task as the card says.',
  ].join('\n');
}

/**
 * The one handler every route calls: the in-process tools, Claude's files bridge and Codex's dynamic tool. The
 * attempt is the one the host bound to the current turn. A refusal of authority is a refusal; anything the model can
 * correct, and a write that failed, is a failed call whose text says what to do.
 */
export async function runSaveTaskCheckpoint(
  resolver: TaskInputResolver | undefined,
  attempt: TaskAttemptCard | undefined,
  agentId: string,
  args: Record<string, unknown>,
): Promise<HostToolOutcome> {
  if (!resolver || !attempt) {
    return hostToolRefused(
      'Error: no live contracted task attempt can save a batch.',
      'capability',
      hostToolRefusalDetail('This tool is available only while executing a live task that was dispatched for delivery in batches.'),
    );
  }
  const result = await resolver.saveCheckpoint(attempt.attemptId, agentId, args);
  if (result.status === 'saved') return hostToolSucceeded(describeCheckpointReceipt(result.receipt));
  switch (result.reason) {
    case 'no-attempt':
      return hostToolRefused(
        'Error: no live contracted task attempt can save a batch.',
        'capability',
        hostToolRefusalDetail('This tool is available only while executing a live task that was dispatched for delivery in batches.'),
      );
    case 'not-incremental':
      return hostToolRefused(
        'Error: this task was not dispatched for delivery in batches.',
        'capability',
        hostToolRefusalDetail('This task was not dispatched for delivery in batches; return the work as the task card says.'),
      );
    case 'attempt-ended':
      return hostToolRefused(
        `Error: ${CHECKPOINT_ATTEMPT_ENDED}`,
        'capability',
        hostToolRefusalDetail('This task attempt has ended (it was stopped, it finished, or its result windows closed), so this batch was not saved. Batches the host confirmed before that are kept for the person.'),
      );
    default:
      return hostToolFailed(`Error: ${result.message}`);
  }
}

function latestRevision(records: readonly TaskCheckpointRecord[], sectionKey: string): TaskCheckpointRecord | undefined {
  let latest: TaskCheckpointRecord | undefined;
  for (const record of records) {
    if (record.sectionKey !== sectionKey) continue;
    if (!latest || record.revision > latest.revision) latest = record;
  }
  return latest;
}

function nextSequence(records: readonly TaskCheckpointRecord[]): number {
  return records.reduce((max, record) => Math.max(max, record.sequence), 0) + 1;
}

function refusedSave(reason: CheckpointRefusalReason, message: string): CheckpointSaveResult {
  return { status: 'refused', reason, message };
}

/** The one answer for a batch that arrives after its attempt ended: the end wins, and nothing is saved. */
export const CHECKPOINT_ATTEMPT_ENDED = 'this task attempt has ended (it was stopped, it finished, or its result windows '
  + 'closed), so this batch was not saved. Batches the host confirmed before that are kept for the person.';

function attemptEndedRefusal(): CheckpointSaveResult {
  return refusedSave('attempt-ended', CHECKPOINT_ATTEMPT_ENDED);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,32}$/.test(code) ? code : 'write failed';
}

function optionalText(value: unknown, label: string, max: number): { value?: string; error?: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string' || !value.trim() || value.length > max) return { error: `${label} must be 1-${max} characters.` };
  return { value: value.trim() };
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A stored attempt record, with its plan validated by the same parser as a dispatched contract's. */
function restoreManifest(value: unknown, attemptId: string): CheckpointAttemptManifest | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.attemptId !== attemptId || !isRecord(value.plan)) return undefined;
  const { plan } = parseDeliveryPlan(deliveryPlanProposal(value.plan));
  const valid = !!plan
    && typeof value.agentId === 'string' && typeof value.coordinatorId === 'string' && typeof value.contractId === 'string'
    && typeof value.objective === 'string' && typeof value.startedAt === 'string' && typeof value.hostInstance === 'string'
    && typeof value.requiredInputCount === 'number'
    && ['running', 'settled', 'cancelled', 'interrupted', 'window-closed'].includes(value.state)
    && (value.removed === undefined || (isRecord(value.removed)
      && (value.removed.reason === 'deleted' || value.removed.reason === 'expired') && typeof value.removed.at === 'string'));
  return valid ? { ...(value as CheckpointAttemptManifest), plan: plan! } : undefined;
}

function isRecordOf(value: unknown, attemptId: string, sequence: number): value is TaskCheckpointRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.attemptId !== attemptId || value.sequence !== sequence) return false;
  if (typeof value.text !== 'string' || typeof value.checkpointId !== 'string' || typeof value.sectionKey !== 'string'
    || typeof value.revision !== 'number' || typeof value.savedAt !== 'string' || typeof value.requestDigest !== 'string') return false;
  // A batch whose text does not match its digest is not the batch the host confirmed.
  return value.contentSha256 === sha256(value.text) && value.bytes === Buffer.byteLength(value.text, 'utf8');
}
