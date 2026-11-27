// Author of tracked changes and comments the host writes into Word documents. Starts no process: the Word user name
// comes only from the cache filled by the host's fixed application detection.
export type WordAuthorSource = 'setting' | 'word-user-name' | 'member-name';
export interface WordAuthor { name: string; initials: string; source: WordAuthorSource }
export interface OfficeAuthoring { trackChangesDefault: boolean; authorName: string; memberName: string; wordUserName?: string }

const clean = (value: string | undefined) => (value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF￾￿]/gu, '').trim();
const limit = (value: string) => [...value].slice(0, 255).join('');

export function resolveWordAuthor(authoring: Pick<OfficeAuthoring, 'authorName' | 'memberName' | 'wordUserName'>): WordAuthor {
  const member = clean(authoring.memberName) || 'Agent';
  const setting = clean(authoring.authorName); const word = clean(authoring.wordUserName);
  const user = setting || word; const source: WordAuthorSource = setting ? 'setting' : word ? 'word-user-name' : 'member-name';
  const initials = user ? user.split(/\s+/).filter(Boolean).slice(0, 3).map(part => [...part][0].toUpperCase()).join('') : 'UA';
  return { name: limit(user ? `${user} (via ${member})` : `${member} (UnodeAi)`), initials, source };
}

/** UTC write time, whole seconds, the same for every revision of one request. */
export const wordRevisionDate = (now: Date) => now.toISOString().replace(/\.\d{3}Z$/, 'Z');
