import { PresentationDraftStore } from './PresentationDraftStore';
import { validatePresentationRequest, PresentationInputFailure, type PresentationRequest, type PresentationWriteFact } from './PresentationContracts';
import { DocumentFailure } from '../content/document/DocumentContracts';
import { samePath } from '../backend/folderAccess';
import type { DraftAdoption, DraftSaveRefusal, DraftStanding, HeldDocumentDraft, SourceCheck } from '../backend/DocumentDraftCustody';
import { hostToolFailed, hostToolSucceeded, hostToolRefusalDetail, type HostToolOutcome } from '../backend/toolSummary';
import { sourceBindingRefusalPath } from '../backend/SourceBindingRefusal';

type Result = HostToolOutcome & { presentationWrite?: PresentationWriteFact };
interface Saved { path: string; target: string; output: string }
interface Fact { attemptId: string | null; name: string; target: string; adoption?: DraftAdoption;
  refusedFor?: DraftSaveRefusal; uncertain?: boolean; stoppedSource?: string }
export interface PresentationDraftSource { check?: () => Promise<SourceCheck>; found?: SourceCheck }
interface DraftAssets { canRead(ref: string): boolean; hold(key: string, refs: readonly string[]): void; release(key: string): void }

/** Per-agent, per-attempt on-disk draft custody. Appending a part is never a workspace effect. */
export class PresentationDraftController {
  private readonly store = new PresentationDraftStore();
  private readonly saved = new Map<string, Saved>();
  private readonly facts = new Map<string, Fact>();
  private readonly imageRefs = new Map<string, Set<string>>();
  private activeKey?: string;
  private readonly stops = new Map<string, Set<() => void>>();
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly assets?: DraftAssets) {}

  run(args: Record<string, unknown>, key: string, signal: AbortSignal | undefined, isCurrent: () => boolean,
    write: (request: PresentationRequest, source: PresentationDraftSource) => Promise<Result>,
    owner: { attemptId: string | null; target: string }): Promise<Result> {
    // Serialize part/final calls in arrival order, including the final save. A duplicate waits and observes its result.
    let captured: Record<string, unknown>;
    try { captured = structuredClone(args); }
    catch { return Promise.resolve(hostToolFailed('Presentation not written: invalid input.')); }
    const work = this.serial.then(async () => {
      this.activeKey = key;
      try { return await this.execute(captured, key, signal, isCurrent, write, owner); }
      finally { this.activeKey = undefined; }
    });
    this.serial = work.then(() => undefined, () => undefined);
    return work;
  }

  private async execute(args: Record<string, unknown>, key: string, signal: AbortSignal | undefined,
    isCurrent: () => boolean, write: (request: PresentationRequest, source: PresentationDraftSource) => Promise<Result>,
    owner: { attemptId: string | null; target: string }): Promise<Result> {
    const fail = (code: string, message: string): Result => ({ ...hostToolFailed(message),
      presentationWrite: { code, targetEffect: 'none' } });
    if (!isCurrent() || signal?.aborted) {
      await this.discard(key); return fail('cancelled', 'Presentation not written: cancelled.');
    }
    const { draft, final, ...fields } = args;
    if (typeof draft !== 'string' || !draft.trim() || (final !== undefined && typeof final !== 'boolean')) {
      return fail('invalid-input', 'Presentation not written: invalid draft name or final flag. '
        + 'draft must be a nonempty string when supplied; final must be boolean. '
        + 'For one complete deck omit draft (final may be omitted, true or false). '
        + 'For parts supply the same draft name and set final: true only when saving all parts.');
    }
    let part: PresentationRequest;
    try { part = validatePresentationRequest(fields, { part: true }); }
    catch (error) { return fail(error instanceof DocumentFailure ? error.code : 'invalid-input',
      error instanceof PresentationInputFailure ? `Presentation not written: invalid-input${error.location ? ` at ${error.location}` : ''}. ${error.issue}` : 'Presentation not written: invalid draft input.'); }
    const before = this.facts.get(key);
    const refs = part.deck.slides.flatMap(slide => slide.objects.flatMap(object => object.type === 'image' ? [object.asset_ref] : []));
    if (refs.some(ref => !this.assets?.canRead(ref))) return fail('image-unavailable', 'An image asset is not available to this agent’s current task. Use an image asset supplied to this task or attached by the user.');
    const heldRefs = new Set([...(this.imageRefs.get(key) ?? []), ...refs]);
    if (heldRefs.size) { this.assets?.hold(key, [...heldRefs]); this.imageRefs.set(key, heldRefs); }
    const fact: Fact = { ...owner, name: draft, ...(before?.adoption ? { adoption: before.adoption } : {}), ...(before?.uncertain ? { uncertain: true } : {}) };
    this.facts.set(key, fact);
    if (final !== true) {
      this.saved.delete(key);
      try {
        const size = await this.store.append(key, part.deck.slides);
        if (!isCurrent() || signal?.aborted) { await this.discard(key); return fail('cancelled', 'Presentation draft cancelled.'); }
        this.keepStop(key, signal);
        return hostToolSucceeded(`Presentation draft ${JSON.stringify(draft)} kept on this machine: ${size.parts} parts, ${size.slides} slides. `
          + 'Nothing was written. Continue with the same draft name; final: true writes one PPTX using the final call’s path, title and layout.');
      } catch { await this.discard(key); return fail('draft-storage-failed', 'The presentation draft temporary file could not be written. Send the deck again in parts or one call.'); }
    }
    const saved = this.saved.get(key);
    if (saved && !part.deck.slides.length && samePath(saved.target, owner.target)) {
      this.facts.delete(key);
      return hostToolSucceeded(`This presentation draft was already saved; nothing was written again.\n${saved.output}`);
    }
    let stored: Awaited<ReturnType<PresentationDraftStore['read']>>;
    try { stored = await this.store.read(key); }
    catch { await this.discard(key); return fail('draft-storage-failed', 'The presentation draft temporary file could not be read. Send the deck again in parts or one call.'); }
    if (!stored) { this.facts.delete(key); return fail('draft-not-found', 'No presentation draft is held for this agent and task attempt. Send the deck again in parts or one call.'); }
    // Keep the final call's slides before writing, so a failure retry with no new slides retains the whole deck.
    if (part.deck.slides.length) {
      try { await this.store.append(key, part.deck.slides); }
      catch { await this.discard(key); return fail('draft-storage-failed', 'The presentation draft temporary file could not be written. Send the deck again in parts or one call.'); }
    }
    const request = validatePresentationRequest({ ...part, deck: { ...part.deck, slides: [...stored.slides, ...part.deck.slides] } });
    if (!isCurrent() || signal?.aborted) { await this.discard(key); return fail('cancelled', 'Presentation not written: cancelled.'); }
    this.keepStop(key, signal);
    const source: PresentationDraftSource = fact.adoption ? { check: fact.adoption.check } : {};
    const result = await write(request, source);
    if (result.presentationWrite?.code === 'written') {
      this.saved.delete(key); this.saved.set(key, { path: part.path, target: owner.target, output: result.output });
      while (this.saved.size > 128) this.saved.delete(this.saved.keys().next().value!);
      await this.discard(key);
      return result;
    }
    if (signal?.aborted) { await this.discard(key); return result; }
    if (source.found?.state === 'changed') { await this.discard(key); return result; }
    if (result.presentationWrite?.targetEffect === 'uncertain') fact.uncertain = true;
    if (source.found?.state === 'grantable') { fact.refusedFor = 'source-access'; fact.stoppedSource = source.found.physical; }
    else if (source.found?.state === 'limit') { fact.refusedFor = 'source-limit'; fact.stoppedSource = source.found.physical; }
    else if (result.presentationWrite?.code === 'source-needs-access') { fact.refusedFor = 'source-access'; fact.stoppedSource = sourceBindingRefusalPath(result); }
    else if (result.presentationWrite?.code === 'source-limit') { fact.refusedFor = 'source-limit'; fact.stoppedSource = sourceBindingRefusalPath(result); }
    else if (result.status === 'refused' && ['needs-access', 'workspace-escape', 'scope'].includes(result.reason)) fact.refusedFor = 'access';
    if (result.status === 'refused') return { ...result, detail: result.presentationWrite?.code.startsWith('source-') && result.detail
      ? result.detail : presentationDraftRefusalDetail(result.reason) };
    if ((result.presentationWrite?.code === 'invalid-input' && result.output.includes('data_from'))
      || (result.presentationWrite?.code === 'source-unreadable' && result.output.includes('This transformation is unavailable'))) {
      return { ...result, output: result.output + '\nThe whole presentation draft is kept. Its stored slides cannot be edited in place. '
        + 'Prepare corrected slides under a new draft name, or send the corrected whole deck without draft. Retrying this draft with no new slides repeats its invalid data_from.' };
    }
    return { ...result, output: result.output + '\nThe whole presentation draft is kept, including this call’s slides. '
      + 'To retry after correcting the stated issue, use the same draft name, final: true and no new slides. '
      + 'For effect-uncertain inspect the destination first; do not blindly rewrite it.' };
  }

  private keepStop(key: string, signal?: AbortSignal): void {
    if (!signal) return;
    const stop = () => { void this.discard(key); this.saved.delete(key); };
    signal.addEventListener('abort', stop, { once: true });
    const cleanup = () => signal.removeEventListener('abort', stop);
    const stops = this.stops.get(key) ?? new Set(); stops.add(cleanup); this.stops.set(key, stops);
    if (signal.aborted) stop();
  }

  async discard(key: string): Promise<void> {
    for (const cleanup of this.stops.get(key) ?? []) cleanup();
    this.stops.delete(key);
    this.facts.delete(key);
    this.assets?.release(key); this.imageRefs.delete(key);
    await this.store.discard(key);
  }

  async discardAll(): Promise<void> {
    for (const key of this.stops.keys()) { for (const cleanup of this.stops.get(key)!) cleanup(); }
    for (const key of this.imageRefs.keys()) this.assets?.release(key);
    this.imageRefs.clear(); this.stops.clear(); this.saved.clear(); this.facts.clear(); await this.store.discardAll();
  }

  awaitingSave(attemptId: string): HeldDocumentDraft[] {
    return [...this.facts].flatMap(([key, fact]) => {
      const size = this.store.size(key);
      return fact.attemptId === attemptId && fact.refusedFor && !fact.uncertain && size ? [this.held(fact, size)] : [];
    });
  }

  private held(fact: Fact, size: { parts: number; slides: number }): HeldDocumentDraft {
    return { tool: 'write_presentation', name: fact.name, target: fact.target, format: 'pptx', parts: size.parts, blocks: size.slides,
      ...(fact.refusedFor ? { refusedFor: fact.refusedFor } : {}), ...(fact.stoppedSource ? { stoppedSource: fact.stoppedSource } : {}),
      ...(fact.adoption ? { adoptedDigests: fact.adoption.digests.map(digest => ({ ...digest })) } : {}) };
  }

  standing(attemptId: string, name: string): DraftStanding {
    const key = JSON.stringify([attemptId, name]); const fact = this.facts.get(key); const size = this.store.size(key);
    if (size && fact?.uncertain) return { state: 'uncertain', target: fact.target };
    if (size && fact) return { state: 'held', draft: this.held(fact, size) };
    const saved = this.saved.get(key);
    return saved ? { state: 'saved', target: saved.target, receipt: saved.output } : { state: 'gone' };
  }

  adopt(fromAttemptId: string, name: string, toAttemptId: string, adoption: DraftAdoption): boolean {
    const from = JSON.stringify([fromAttemptId, name]); const to = JSON.stringify([toAttemptId, name]);
    const fact = this.facts.get(from);
    if (!fact || fact.uncertain || this.activeKey === from || from === to || !this.store.rekey(from, to)) return false;
    for (const cleanup of this.stops.get(from) ?? []) cleanup(); this.stops.delete(from);
    this.facts.delete(from); this.facts.set(to, { attemptId: toAttemptId, name, target: fact.target, adoption });
    const refs = this.imageRefs.get(from);
    if (refs) { this.assets?.hold(to, [...refs]); this.assets?.release(from); this.imageRefs.delete(from); this.imageRefs.set(to, refs); }
    this.saved.delete(to); return true;
  }
}
/** Fixed host text only. No model text or runtime concatenation crosses the refusal-detail boundary. */
function presentationDraftRefusalDetail(reason: string) {
  if (reason === 'needs-access') return hostToolRefusalDetail('The access it lacks is Read + Write. The whole presentation draft is kept, including this call’s slides. Nothing was written. Once Read + Write access is granted, use the same draft name, final: true and no new slides.');
  if (reason === 'workspace-escape') return hostToolRefusalDetail('Saving the draft requires Read + Write at its destination. The whole presentation draft is kept, including this call’s slides. Nothing was written. Once the destination can be written, use the same draft name, final: true and no new slides.');
  if (reason === 'consent') return hostToolRefusalDetail('This save was not approved: the user denied it, or nobody could be asked. Nothing was saved; do not retry it unchanged, and ask what they want instead. The whole presentation draft is kept, including this call’s slides. If the user later requests saving that draft, use the same draft name, final: true and no new slides.');
  return hostToolRefusalDetail('The whole presentation draft is kept, including this call’s slides. Nothing was written. After the stated permission or destination issue is corrected, use the same draft name, final: true and no new slides.');
}
