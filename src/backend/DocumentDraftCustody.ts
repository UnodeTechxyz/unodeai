/*---------------------------------------------------------------------------------------------
 *  UnodeAi - A prepared document draft across a re-dispatch (v0.9.101, H2b)
 *
 *  A draft belongs to the agent and to the task attempt it was started in. When that attempt settles with a draft whose
 *  final save waits for access, the host may hand the draft to the attempt that resumes the same task, for the same
 *  agent, once: the draft is re-keyed in that agent's own file tools, never read or saved by another attempt or agent
 *  naming it. Whether the draft still fits is decided by host facts only: who holds it, whether it was saved, where it
 *  saves, and the SHA-256 of the exact source bytes the first attempt read, compared with the source as it is now under
 *  the owner's live authority. No grant is made or widened to take that comparison.
 *--------------------------------------------------------------------------------------------*/

/** The SHA-256 of the exact bytes the host read of a required input's physical file, the first time in an attempt. */
export interface SourceDigest {
  inputId: string;
  /** The physical file, as the host resolved it when it read. */
  physical: string;
  sha256: string;
}

/**
 * What a source comparison found, under the draft owner's live authority, in one of five classes:
 * - `unchanged`: every digested source reads the same bytes;
 * - `changed`: one was read and holds other bytes, or its path now leads to another file: the draft no longer matches
 *   its source. Only a read that succeeded can say so;
 * - `grantable`: one cannot be read for a grant that is missing, ended or revoked; nothing about its content is known;
 * - `limit`: one is outside a limit a grant cannot change, such as the owner's own Folder Access;
 * - `unreadable`: one could not be compared now: it is missing or not a regular file, its status could not be read, or it
 *   could not be read (locked, an input/output error, larger than this window can hold). Nothing about its content is
 *   known, the draft is kept, and no grant would help.
 */
export type SourceCheck =
  | { state: 'unchanged' }
  | { state: 'changed'; inputId: string }
  | { state: 'grantable'; physical: string; inputId: string }
  | { state: 'limit'; physical: string; inputId: string; text: string }
  | { state: 'unreadable'; physical: string; inputId: string };

/** The last final save of a draft, as its owner saw it. */
export type DraftSaveRefusal =
  /** The destination could not be written for access a grant could open. */
  | 'access'
  /** The source of an adopted draft could not be read for access a grant could open. */
  | 'source-access'
  /** The source of an adopted draft is outside a limit a grant cannot change. */
  | 'source-limit';

/** A draft its owner holds, by host facts. Nothing of its content. */
export interface HeldDocumentDraft {
  name: string;
  /** The destination of its last final call, resolved against the owner's base. */
  target: string;
  format: string;
  parts: number;
  blocks: number;
  /** Why its last final save was refused, when it was refused for access. */
  refusedFor?: DraftSaveRefusal;
  /** The source digests it was prepared from, when it was adopted from an earlier attempt. */
  adoptedDigests?: SourceDigest[];
  /** The source the save's comparison could not read, when it was refused for it. */
  stoppedSource?: string;
}

/** What the owner holds under one attempt and name now, apart from the draft itself. */
export type DraftStanding =
  | { state: 'held'; draft: HeldDocumentDraft }
  /** Written: the receipt and destination, and nothing is written again. */
  | { state: 'saved'; target: string; receipt: string }
  /** Its save's effect is not known: the destination may have been written. */
  | { state: 'uncertain'; target: string }
  /** The owner was stopped or retired, which discards its drafts. */
  | { state: 'retired' }
  | { state: 'gone' };

/**
 * The file tools of one agent that hold its drafts, as the host's attempt registry knows them. Only the host calls
 * this; a model reaches none of it.
 */
export interface DocumentDraftCustodian {
  readonly agentId: string;
  /** The drafts held under this attempt whose last final save was refused for access. */
  awaitingSave(attemptId: string): HeldDocumentDraft[];
  standing(attemptId: string, name: string): DraftStanding;
  /**
   * Re-key the held draft from one attempt to the next, in one synchronous step: afterwards only `toAttemptId` holds it.
   * `check` is the source comparison its final save repeats at the write boundary. False: nothing was moved.
   */
  adopt(fromAttemptId: string, name: string, toAttemptId: string, adoption: DraftAdoption): boolean;
  discard(attemptId: string, name: string): Promise<void>;
}

/** What an adopted draft carries into its owner's next attempt. */
export interface DraftAdoption {
  digests: SourceDigest[];
  /** The source comparison, under the owner's then-live authority. */
  check(): Promise<SourceCheck>;
}

/** The host's record of the draft a waiting save is for. A ref resumes it; nothing in it is authority. */
export interface DraftRef {
  agentId: string;
  attemptId: string;
  draftName: string;
  /** The destination, as the owner resolved it. */
  target: string;
  /** Where the filesystem placed the destination when the save began to wait: the real path of what holds it. */
  targetIdentity: string;
  parts: number;
  blocks: number;
  /** One per required input with a recorded digest. */
  inputDigests: SourceDigest[];
  /** Required file inputs of the contract for which no digest was recorded: the draft cannot be confirmed. */
  undigested: string[];
}
