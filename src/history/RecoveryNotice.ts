/*---------------------------------------------------------------------------------------------
 *  UnodeAi - what a member is told at its next request after files were restored (v0.9.110 R2, design §4.3 "F1")
 *
 *  A host-authored note, never the person's words, attached once to the member's next request of the person, in
 *  each conversation view, whatever entrance the request came through. It says which files now hold which state and
 *  which were left as they were, names the request each revert went back to, asks the member to read the files again
 *  before relying on what it remembers, and tells it not to redo reverted changes on its own. It names only files the
 *  member may read now; anything else is counted without a path. It carries no file content.
 *
 *  On the HTTP route the note is its own host entry in the conversation (a system message before the person's
 *  message); on Claude and Codex it starts the next user turn. A notice counts as received only when the backend
 *  reports the request carrying it as taken; until then it stays pending.
 *
 *  No `vscode` import.
 *--------------------------------------------------------------------------------------------*/

import type { HistoryEventBody } from './HistoryRecords';

export type RecoveryNoticeV1 = Extract<HistoryEventBody, { kind: 'recovery-notice' }> & { attached?: true };

/** Notices one request names in full; older pending ones are counted, and all of them count as told with it. */
export const RECOVERY_NOTICES_NAMED = 10;

/** The marker each named notice carries, so a conversation that already holds it is not given it twice. */
export function recoveryNoticeMarker(noticeId: string): string {
  return `(notice ${noticeId})`;
}

const STATE_LABEL: Record<RecoveryNoticeV1['targets'][number]['state'], string> = {
  'before-request': 'restored to what it held before that request',
  removed: 'removed (it did not exist before that request)',
  'after-request': 'put back to what it held before the revert',
};

function heading(notice: RecoveryNoticeV1): string {
  const request = notice.selected ? `request "${oneLine(notice.selected.goal, 120)}"` : 'a request';
  const what = notice.action === 'revert' ? `Revert to before ${request}`
    : notice.action === 'undo' ? `Undo of the revert to before ${request}`
      : notice.action === 'redo' ? `Redo of the revert to before ${request}`
        : 'Restore of one file to an earlier restore point';
  const branch = notice.branchId ? '; later requests continue on a new branch of this conversation' : '';
  return `- ${what} ${recoveryNoticeMarker(notice.noticeId)}${branch}:`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat || '(no text)';
}

/**
 * The block a member's next request carries, for the notices it has not received, oldest first. Only the newest
 * `RECOVERY_NOTICES_NAMED` are listed; the rest are counted. `readable` is asked at the moment of attaching.
 */
export function recoveryNoticeText(notices: readonly RecoveryNoticeV1[], readable: (physicalTarget: string) => boolean): string {
  if (notices.length === 0) return '';
  const named = notices.slice(-RECOVERY_NOTICES_NAMED);
  const earlier = notices.length - named.length;
  const lines: string[] = [
    '[UnodeAi host note — not from the person] Files in this workspace were restored after earlier work. Messages, '
      + 'tool results and checks before this note describe those files as they were then. Read the files listed below '
      + 'again before relying on what you remember of them. Do not redo the reverted changes on your own; continue from '
      + 'the files as they are now. Where a file is listed more than once, the last entry holds.',
  ];
  if (earlier > 0) {
    lines.push(`- ${earlier} earlier restore${earlier === 1 ? '' : 's'} not listed here also changed files; read any file you rely on again.`);
  }
  if (notices.some((notice) => notice.attached)) {
    lines.push('- Some of this may repeat a note sent with an earlier request whose delivery was not confirmed.');
  }
  for (const notice of named) {
    lines.push(heading(notice));
    const state = notice.action === 'restore'
      ? (target: RecoveryNoticeV1['targets'][number]) => (target.state === 'removed' ? 'removed (it did not exist at that restore point)' : 'restored to an earlier restore point')
      : (target: RecoveryNoticeV1['targets'][number]) => STATE_LABEL[target.state];
    let hidden = 0;
    for (const target of notice.targets) {
      if (readable(target.physicalTarget)) lines.push(`  - ${target.displayPath}: ${state(target)}`);
      else hidden++;
    }
    for (const conflict of notice.conflicts) {
      if (readable(conflict.physicalTarget)) lines.push(`  - ${conflict.displayPath}: left as it was (${conflict.reason.replace(/\.$/, '')})`);
      else hidden++;
    }
    if (hidden > 0) lines.push(`  - ${hidden} more file${hidden === 1 ? '' : 's'} outside your current file access changed or ${hidden === 1 ? 'was' : 'were'} left as ${hidden === 1 ? 'it was' : 'they were'}.`);
    const refs = notice.notReversedRefs ?? [];
    for (const ref of refs.slice(0, 20)) {
      // A path is named only where it is a full path the member may read now; a relative one is not resolved here.
      const where = ref.path && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(ref.path) && readable(ref.path) ? ` ${ref.path}` : '';
      lines.push(`  - not reversed: ${ref.effect === 'command' ? 'a command' : ref.effect === 'native-tool' ? 'a provider tool' : 'an outside effect'}${where} (${ref.reason.replace(/\.$/, '')}); it may still be in place`);
    }
    const uncounted = Math.max(notice.notReversed, refs.length) - Math.min(refs.length, 20);
    if (uncounted > 0) {
      lines.push(`  - ${uncounted} more effect${uncounted === 1 ? '' : 's'} of commands or provider tools could not be reversed and may still be in place.`);
    }
  }
  return lines.join('\n');
}

/** What the next request of a member carries: the notices it tells, and the view it tells them in. */
export interface PreparedRecoveryNotice {
  /** Every pending notice the request counts as told, the counted-only ones included. */
  noticeIds: string[];
  text: string;
  viewGeneration: string;
}

/** The history the port reads and records into. */
export interface RecoveryNoticeHistory {
  /** The member's pending notices in its current view, read again from storage first. */
  pendingRecoveryNoticesFresh(agentId: string): Promise<{ viewGeneration: string; notices: RecoveryNoticeV1[] }>;
  recoveryNoticesAttached(agentId: string, noticeIds: readonly string[], requestId: string, viewGeneration: string): void;
  recoveryNoticesDelivered(agentId: string, noticeIds: readonly string[], requestId: string, viewGeneration?: string): void;
}

/** The session manager's view of recovery notices: one per host. */
export interface RecoveryNoticePort {
  prepare(agentId: string): Promise<PreparedRecoveryNotice | undefined>;
  attached(agentId: string, notice: PreparedRecoveryNotice, requestId: string): void;
  delivered(agentId: string, notice: PreparedRecoveryNotice, requestId: string): void;
}

/**
 * The production port: the notices are read from the canonical history when a request of the person is about to be
 * sent, filtered by what the member may read at that moment, and recorded as attached and as delivered.
 */
export function recoveryNoticePort(
  history: () => RecoveryNoticeHistory | undefined,
  readable: (agentId: string, physicalTarget: string) => boolean,
  settle?: () => Promise<void>,
): RecoveryNoticePort {
  return {
    prepare: async (agentId) => {
      const source = history();
      if (!source) return undefined;
      // A restore whose notice could not be recorded earlier gets it now, before this request reads what is pending.
      await settle?.().catch(() => undefined);
      const { viewGeneration, notices } = await source.pendingRecoveryNoticesFresh(agentId);
      if (notices.length === 0) return undefined;
      const text = recoveryNoticeText(notices, (physical) => {
        try { return readable(agentId, physical); } catch { return false; }
      });
      return { noticeIds: notices.map((notice) => notice.noticeId), text, viewGeneration };
    },
    attached: (agentId, notice, requestId) => history()?.recoveryNoticesAttached(agentId, notice.noticeIds, requestId, notice.viewGeneration),
    delivered: (agentId, notice, requestId) => history()?.recoveryNoticesDelivered(agentId, notice.noticeIds, requestId, notice.viewGeneration),
  };
}
