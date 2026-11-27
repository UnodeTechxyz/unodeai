import { createHash } from 'node:crypto';

export const DISMISSED_NOTICE_LIMIT = 500;
export const dismissedNoticesKey = (agentId: string): string => `roam.chat.dismissedNotices.${agentId}`;

/** Presentation only. No field here is written into history or supplied to a model. */
export interface NoticePresentation {
  key: string;
  keys: string[];
  count: number;
  hidden: boolean;
}

export function readDismissedNotices(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((key): key is string => typeof key === 'string' && /^notice:[0-9a-f]{64}$/.test(key)))].slice(-DISMISSED_NOTICE_LIMIT)
    : [];
}

type NoticeItem = {
  role?: string; live?: boolean; runtimeNotice?: boolean; fromName?: string;
  noticeKey?: string; seq?: number; ts?: string; text?: string; turnFinal?: boolean;
  noticeViewKey?: string;
  outcomeCard?: { title: string; detail: string; state?: string; action?: unknown; actions?: unknown[] };
};

/** Includes old host lines written before postRuntimeNotice stamped runtimeNotice. */
function isNotice(item: NoticeItem): boolean {
  return item.role === 'agent' && !item.live
    && (item.runtimeNotice === true || (item.fromName === 'UnodeAi' && !item.turnFinal));
}

/** Compute before assigning transient render sequences to old, unsequenced history rows. */
export function noticeKeyFor(item: NoticeItem, legacyOccurrence = 0): string | undefined {
  if (!isNotice(item)) return undefined;
  // Rendering may assign or normalize seq on old rows. It is not part of a keyless notice's identity.
  const identity = item.noticeKey ? ['key', item.noticeKey] : ['row', item.ts, item.text, legacyOccurrence];
  return `notice:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

/** Keep every original item: the disappearance sensor and all non-view consumers still see the full transcript. */
export function presentNotices<T extends object>(items: T[], dismissed: readonly string[]): Array<T & { notice?: NoticePresentation }> {
  const hidden = new Set(dismissed);
  const result: Array<T & { notice?: NoticePresentation }> = [];
  let run: Array<T & { notice?: NoticePresentation }> = [];
  let signature = '';
  const occurrences = new Map<string, number>();
  const flush = () => {
    if (!run.length) return;
    const keys = run.map(item => item.notice!.key);
    // A newly arriving repetition remains visible even if the earlier occurrences were closed.
    const closed = keys.every(key => hidden.has(key));
    run.forEach((item, index) => { item.notice = { key: keys[0], keys, count: run.length, hidden: closed || index > 0 }; });
    run = [];
  };
  for (const original of items) {
    const item = original as T & NoticeItem;
    if (!isNotice(item)) {
      flush(); signature = ''; result.push(original); continue;
    }
    const next = JSON.stringify([item.outcomeCard?.title ?? '', item.outcomeCard?.detail ?? item.text ?? '',
      item.outcomeCard?.state, item.outcomeCard?.action, item.outcomeCard?.actions]);
    if (next !== signature) flush();
    signature = next;
    const identity = JSON.stringify([item.ts, item.text]);
    const occurrence = occurrences.get(identity) ?? 0; occurrences.set(identity, occurrence + 1);
    const key = item.noticeViewKey ?? noticeKeyFor(item, occurrence)!;
    const projected = { ...original, notice: { key, keys: [key], count: 1, hidden: false } };
    result.push(projected); run.push(projected);
  }
  flush();
  return result;
}
