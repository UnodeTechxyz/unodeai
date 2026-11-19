/**
 * v0.9.99: whether a task being dispatched looks like one the same teammate already has.
 *
 * The answer only adds one informational line to a dispatch that already succeeded. It never refuses, cancels or
 * delays anything, so a false positive costs one line and a miss costs nothing that exists today. It is pure and
 * deterministic: no model call, no I/O, and nothing it builds (text, token set, signature) is logged or persisted.
 *
 * A comparison is eligible only for the same resolved executor. It matches when either
 * 1. the normalized instruction is exactly equal; or
 * 2. the task signature matches: the same targets (one side may name fewer), file effect, edit action, occurrence
 *    count and validation intent, and at least one shared distinctive literal; or
 * 3. the overlap coefficient of the discriminative tokens is at least 0.90.
 * A hard non-match (another target, artifact or revision, a conflicting number, an opposite action, an
 * incompatible effect or write folder) wins over every branch.
 */
import type { ExpectedFileEffect } from './TaskContract';

export interface SimilarTaskSubject {
  executorId: string;
  instruction: string;
  /** Declared targets: workspace paths, artifact ids and content asset ids, as the contract names them. */
  targets?: readonly string[];
  /** Folders the task may write, as its write scope grants them. */
  writeFolders?: readonly string[];
  /** The declared file effect. Undefined when the dispatch declared none (a legacy assignment). */
  effect?: ExpectedFileEffect;
  sensors?: readonly string[];
}

export type SimilarTaskBranch = 'exact' | 'signature' | 'overlap';

export const SIMILAR_TASK_OVERLAP_THRESHOLD = 0.9;
/** The overlap branch needs this many discriminative tokens on the smaller side; fewer say too little. */
const OVERLAP_MIN_TOKENS = 5;
/** A shared literal must have at least this many code points; one character is too common to identify a task. */
const SHARED_LITERAL_MIN_CODE_POINTS = 2;

type EditAction = 'remove' | 'add' | 'replace' | 'create';
type ActionClass = EditAction | 'validate';

interface TaskFeatures {
  normalized: string;
  targets: Set<string>;
  writeFolders: Set<string>;
  effect?: ExpectedFileEffect;
  sensors: Set<string>;
  literals: Set<string>;
  identifiers: Set<string>;
  words: Set<string>;
  requirements: Map<RequirementKey, Set<string>>;
  edits: Set<EditAction>;
  affirmed: Set<ActionClass>;
  negated: Set<ActionClass>;
}

type RequirementKey = 'count' | 'documents' | 'amount' | 'version' | 'revision';

/** CRLF to LF, outer trim, whitespace collapsed. Case, digits, paths, punctuation and negation are kept. */
export function normalizeInstruction(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ');
}

export function similarTaskMatch(next: SimilarTaskSubject, existing: SimilarTaskSubject): SimilarTaskBranch | undefined {
  if (next.executorId !== existing.executorId) return undefined;
  const a = features(next);
  const b = features(existing);
  if (hardNonMatch(a, b)) return undefined;
  if (a.normalized.length > 0 && a.normalized === b.normalized) return 'exact';
  if (signatureMatches(a, b)) return 'signature';
  const left = discriminativeTokens(a);
  const right = discriminativeTokens(b);
  const smaller = Math.min(left.size, right.size);
  if (smaller < OVERLAP_MIN_TOKENS) return undefined;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / smaller >= SIMILAR_TASK_OVERLAP_THRESHOLD ? 'overlap' : undefined;
}

function hardNonMatch(a: TaskFeatures, b: TaskFeatures): boolean {
  // Different targets, artifacts or artifact revisions: both name targets and neither holds all of the other's. One
  // side may name fewer (a rework reason names the files it is about), but targets that only partly overlap are
  // different work, for every branch.
  if (a.targets.size > 0 && b.targets.size > 0 && !contains(a.targets, b.targets) && !contains(b.targets, a.targets)) return true;
  if (a.writeFolders.size > 0 && b.writeFolders.size > 0 && disjoint(a.writeFolders, b.writeFolders)) return true;
  if (a.effect && b.effect && a.effect !== b.effect && a.effect !== 'mixed' && b.effect !== 'mixed') return true;
  // A numeric conflict: both give a value for the same requirement and the values differ. A number that appears
  // on only one side is not a conflict.
  for (const [key, values] of a.requirements) {
    const other = b.requirements.get(key);
    if (other && disjoint(values, other)) return true;
  }
  // Opposite actions: one adds where the other removes, or one does what the other says not to do.
  const onlyAdds = (f: TaskFeatures) => f.edits.has('add') && !f.edits.has('remove');
  const onlyRemoves = (f: TaskFeatures) => f.edits.has('remove') && !f.edits.has('add');
  if ((onlyAdds(a) && onlyRemoves(b)) || (onlyRemoves(a) && onlyAdds(b))) return true;
  for (const action of a.affirmed) if (b.negated.has(action) && !b.affirmed.has(action)) return true;
  for (const action of b.affirmed) if (a.negated.has(action) && !a.affirmed.has(action)) return true;
  return false;
}

function signatureMatches(a: TaskFeatures, b: TaskFeatures): boolean {
  // Targets on both sides; the hard rule above has already required one side to hold all of the other's.
  if (a.targets.size === 0 || b.targets.size === 0) return false;
  if (a.effect !== b.effect) return false;
  if (a.edits.size === 0 || !sameSet(a.edits, b.edits)) return false;
  if (a.affirmed.has('validate') !== b.affirmed.has('validate')) return false;
  if (a.requirements.has('count') !== b.requirements.has('count')) return false;
  for (const literal of a.literals) {
    if (codePoints(literal) >= SHARED_LITERAL_MIN_CODE_POINTS && b.literals.has(literal)) return true;
  }
  return false;
}

function discriminativeTokens(f: TaskFeatures): Set<string> {
  const tokens = new Set<string>();
  for (const target of f.targets) tokens.add(`target:${target}`);
  for (const literal of f.literals) if (codePoints(literal) >= SHARED_LITERAL_MIN_CODE_POINTS) tokens.add(`literal:${literal}`);
  for (const identifier of f.identifiers) tokens.add(`id:${identifier}`);
  for (const word of f.words) tokens.add(`word:${word}`);
  for (const [key, values] of f.requirements) for (const value of values) tokens.add(`${key}:${value}`);
  for (const action of f.affirmed) tokens.add(`action:${action}`);
  for (const sensor of f.sensors) tokens.add(`sensor:${sensor}`);
  if (f.effect) tokens.add(`effect:${f.effect}`);
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------------------------------------------

/** ‘ ’, “ ”, 「 」, 『 』 and ". */
const QUOTED = /‘([^’]+)’|“([^”]+)”|「([^」]+)」|『([^』]+)』|"([^"]+)"/gu;
const HAN_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_RUN = /[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}._\-/\\()]*/gu;
/** A file name or path in Latin letters with an extension that has a letter: ZH-Hant.txt, docs/a.md; not v2.0 or 9.4. */
const PATH_TOKEN = /(?<![\p{Script=Latin}\p{N}_\-.])(?:[\p{Script=Latin}\p{N}_\-.]+[/\\])*[\p{Script=Latin}\p{N}_\-]{2,}(?:\.[\p{Script=Latin}\p{N}_\-]+)*\.(?=\p{N}*\p{Script=Latin})[\p{Script=Latin}\p{N}]{1,8}(?![\p{Script=Latin}\p{N}])/gu;

function features(subject: SimilarTaskSubject): TaskFeatures {
  const normalized = normalizeInstruction(subject.instruction);
  const folded = normalized.normalize('NFKC').toLowerCase();
  const literals = new Set<string>();
  const quoted: Array<{ value: string; start: number; end: number }> = [];
  for (const match of folded.matchAll(QUOTED)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (!value) continue;
    literals.add(value);
    quoted.push({ value, start: match.index!, end: match.index! + match[0].length });
  }
  const outsideQuotes = blank(folded, quoted);
  // A named file is a target, not prose: it decides neither the script, nor a word, nor a version number.
  const prose = blank(outsideQuotes, [...outsideQuotes.matchAll(PATH_TOKEN)]
    .map((match) => ({ start: match.index!, end: match.index! + match[0].length })));
  // The script most of the prose is in. A Han character carries about as much as a Latin word.
  const hanDominant = countMatches(prose, HAN_RUN) > [...prose.matchAll(/\p{Script=Latin}+/gu)].length;
  // A distinctive run is text in the other script: Han text in a Latin instruction, an identifier in a Han one.
  const distinctive: Array<{ start: number; end: number }> = [];
  const identifiers = new Set<string>();
  if (hanDominant) {
    for (const match of prose.matchAll(LATIN_RUN)) {
      const value = match[0].replace(/[._\-/\\()]+$/u, '');
      if (value) identifiers.add(value);
      distinctive.push({ start: match.index!, end: match.index! + match[0].length });
    }
  } else {
    for (const match of prose.matchAll(HAN_RUN)) {
      literals.add(match[0]);
      distinctive.push({ start: match.index!, end: match.index! + match[0].length });
    }
  }
  // Polarity and action terms are read only outside literals and distinctive runs: a "do not" or 不得 inside a
  // quoted string is text being edited, not an instruction about the edit.
  const plain = blank(prose, distinctive);
  const words = new Set<string>();
  if (!hanDominant) {
    for (const match of plain.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)) {
      const word = match[0];
      if (word.length >= 3 && !GENERIC_WORDS.has(word) && !NUMBER_WORDS.has(word)) words.add(word);
    }
  }
  const targets = taskTargets(folded, subject.targets ?? []);
  const { affirmed, negated } = actionTerms(plain);
  const derived = derivedEdits(folded, quoted);
  const edits = new Set<EditAction>(derived.size > 0
    ? derived
    : [...affirmed].filter((action): action is EditAction => action !== 'validate'));
  return {
    normalized,
    targets,
    writeFolders: new Set((subject.writeFolders ?? []).map(canonicalFolder).filter(Boolean)),
    ...(subject.effect ? { effect: subject.effect } : {}),
    sensors: new Set((subject.sensors ?? []).map((sensor) => sensor.toLowerCase())),
    literals,
    identifiers,
    words,
    requirements: requirements(prose),
    edits,
    affirmed,
    negated,
  };
}

/**
 * The edit a pair of quoted literals states: “X” 改为 “Y”, replace "X" with "Y", change "X" to "Y". When the new
 * text is the old text with a part taken out it is a removal, the other way round an addition, otherwise a
 * replacement.
 */
function derivedEdits(folded: string, quoted: ReadonlyArray<{ value: string; start: number; end: number }>): Set<EditAction> {
  const edits = new Set<EditAction>();
  for (let i = 0; i + 1 < quoted.length; i++) {
    const between = folded.slice(quoted[i].end, quoted[i + 1].start).replace(/[\s\p{P}]/gu, '');
    if (!PAIR_CONNECTIVES.has(between)) continue;
    const before = quoted[i].value;
    const after = quoted[i + 1].value;
    if (before === after) continue;
    if (before.includes(after)) edits.add('remove');
    else if (after.includes(before)) edits.add('add');
    else edits.add('replace');
  }
  return edits;
}

const PAIR_CONNECTIVES = new Set([
  '改为', '改為', '改成', '替换为', '替換為', '替换成', '替換成', '换成', '換成', '更改为', '更改為',
  'to', 'with', 'into', '->', '→', '=>',
]);

const ACTION_TERMS: ReadonlyArray<{ action: ActionClass; latin: readonly string[]; han: readonly string[] }> = [
  {
    action: 'remove',
    latin: ['remove', 'removes', 'removed', 'removing', 'delete', 'deletes', 'deleted', 'deleting', 'drop', 'strip', 'erase'],
    han: ['删除', '刪除', '删去', '刪去', '删掉', '刪掉', '去掉', '去除', '移除'],
  },
  {
    action: 'add',
    latin: ['add', 'adds', 'added', 'adding', 'insert', 'inserts', 'inserted', 'inserting', 'append', 'appends', 'appended'],
    han: ['添加', '增加', '插入', '加上', '补上', '補上', '增补', '增補', '新增'],
  },
  {
    action: 'replace',
    latin: ['replace', 'replaces', 'replaced', 'replacing', 'substitute', 'rename', 'renames', 'renamed'],
    han: ['改为', '改為', '改成', '替换', '替換', '换成', '換成', '更换', '更換'],
  },
  {
    action: 'create',
    latin: ['create', 'creates', 'created', 'creating'],
    han: ['新建', '创建', '創建'],
  },
  {
    action: 'validate',
    latin: ['validate', 'validates', 'validated', 'validating', 'verify', 'verifies', 'verified', 'verifying', 'check', 'checks', 'checked', 'confirm', 'confirms', 'confirmed'],
    han: ['验证', '驗證', '校验', '校驗', '核对', '核對', '检查', '檢查', '确认', '確認'],
  },
];

const LATIN_NEGATORS = new Set(['not', 'no', 'never', "don't", 'dont', 'without']);
const OTHER_SCOPE_LATIN = new Set(['other', 'else', 'additional', 'further', 'unrelated']);
const OTHER_SCOPE_HAN = /其他|其它|别的|別的/u;

/** Each action named, split into the ones affirmed and the ones a negation applies to. */
function actionTerms(plain: string): { affirmed: Set<ActionClass>; negated: Set<ActionClass> } {
  const affirmed = new Set<ActionClass>();
  const negated = new Set<ActionClass>();
  const latinWords = [...plain.matchAll(/[\p{Script=Latin}'][\p{Script=Latin}'-]*/gu)].map((match) => match[0]);
  for (let i = 0; i < latinWords.length; i++) {
    const term = ACTION_TERMS.find((entry) => entry.latin.includes(latinWords[i]));
    if (!term) continue;
    // A negation within the three words before it applies to it. One that the words around it scope to other work
    // ("no other edits", "do not remove anything else") neither negates nor asks for the action.
    const before = latinWords.slice(Math.max(0, i - 3), i);
    const around = [...before, ...latinWords.slice(i + 1, i + 4)];
    if (!before.some((word) => LATIN_NEGATORS.has(word))) affirmed.add(term.action);
    else if (!around.some((word) => OTHER_SCOPE_LATIN.has(word))) negated.add(term.action);
  }
  for (const term of ACTION_TERMS) {
    for (const han of term.han) {
      let from = 0;
      for (;;) {
        const at = plain.indexOf(han, from);
        if (at < 0) break;
        from = at + han.length;
        const window = plain.slice(Math.max(0, at - 5), at);
        const negator = /(不要|不得|不必|无须|無須|禁止|勿|别|別|不).{0,3}$/u.exec(window);
        if (!negator) affirmed.add(term.action);
        else if (!OTHER_SCOPE_HAN.test(window.slice(negator.index) + plain.slice(from, from + 4))) negated.add(term.action);
      }
    }
  }
  return { affirmed, negated };
}

const LATIN_NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, single: 1, both: 2,
};
const NUMBER_WORDS = new Set(Object.keys(LATIN_NUMBER_WORDS));
const HAN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** A Han numeral up to 99 (四, 十, 十二, 二十, 二十三), or undefined. */
function hanNumber(text: string): number | undefined {
  if (/^\d+$/u.test(text)) return Number(text);
  const ten = text.indexOf('十');
  if (ten < 0) return text.length === 1 ? HAN_DIGITS[text] : undefined;
  const tens = ten === 0 ? 1 : HAN_DIGITS[text.slice(0, ten)];
  const units = ten === text.length - 1 ? 0 : HAN_DIGITS[text.slice(ten + 1)];
  if (tens === undefined || units === undefined || text.length > 3) return undefined;
  return tens * 10 + units;
}

const LATIN_COUNT_NOUNS = new Set([
  'place', 'places', 'occurrence', 'occurrences', 'instance', 'instances', 'time', 'times', 'spot', 'spots',
  'location', 'locations', 'character', 'characters', 'char', 'chars',
]);
const LATIN_DOCUMENT_NOUNS = new Set(['file', 'files', 'document', 'documents', 'copy', 'copies', 'doc', 'docs']);

/**
 * The numbers an instruction gives for a requirement: an occurrence count, a number of documents, an amount, a
 * version, a revision. A number with no such requirement (a clause number, a date) is not one.
 */
function requirements(text: string): Map<RequirementKey, Set<string>> {
  const found = new Map<RequirementKey, Set<string>>();
  const add = (key: RequirementKey, value: string) => {
    const values = found.get(key) ?? new Set<string>();
    values.add(value);
    found.set(key, values);
  };
  for (const match of text.matchAll(/(第)?(\d+|[零〇一二两兩三四五六七八九十]{1,3})\s*([处處次个個字遍份])(?!理)/gu)) {
    if (match[1]) continue; // 第一次 is "the first time", not a count
    const value = hanNumber(match[2]);
    if (value === undefined) continue;
    add(match[3] === '份' ? 'documents' : 'count', String(value));
  }
  const tokens = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu)].map((match) => match[0]);
  for (let i = 0; i < tokens.length; i++) {
    const value = /^\d+$/u.test(tokens[i]) ? Number(tokens[i]) : LATIN_NUMBER_WORDS[tokens[i]];
    if (value === undefined) continue;
    for (let j = i + 1; j <= i + 3 && j < tokens.length; j++) {
      if (LATIN_COUNT_NOUNS.has(tokens[j])) { add('count', String(value)); break; }
      if (LATIN_DOCUMENT_NOUNS.has(tokens[j])) { add('documents', String(value)); break; }
      if (/^\d+$/u.test(tokens[j]) || NUMBER_WORDS.has(tokens[j])) break;
    }
  }
  for (const match of text.matchAll(/[$¥€£]\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:元|美元|港元|dollars?\b|usd\b|rmb\b|cny\b|eur\b|hkd\b)/gu)) {
    add('amount', (match[1] ?? match[2]).replace(/,/g, ''));
  }
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])(?:v|version\s+|版本\s*)(\d+(?:\.\d+)*)(?![\p{N}])/gu)) {
    add('version', match[1].replace(/(?:\.0+)+$/u, ''));
  }
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])(?:rev|revision|修订|修訂)\.?\s*(\d+)(?![\p{N}])/gu)) {
    add('revision', match[1]);
  }
  return found;
}

const GENERIC_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'these', 'those', 'are', 'its', 'into', 'than', 'then',
  'also', 'all', 'any', 'each', 'new', 'final', 'only', 'just', 'please', 'kindly', 'thanks', 'thank', 'you',
  'your', 'our', 'task', 'work', 'job', 'teammate', 'agent', 'member', 'worker', 'coordinator', 'does', 'done',
  'make', 'sure', 'should', 'must', 'will', 'can', 'could', 'would', 'need', 'needs', 'needed', 'after', 'before',
  'other', 'not', 'when', 'what', 'which', 'there', 'their', 'them', 'they', 'have', 'has', 'had', 'been', 'being',
  'was', 'were', 'use', 'using', 'it', 'is', 'be', 'to', 'of', 'in', 'on', 'at', 'by', 'or', 'an', 'as', 'so',
]);

/**
 * The targets one instruction version is about: full workspace paths, and artifact or asset ids. An instruction that
 * names files is narrower than its contract (a rework reason names the files it is about), so its named files are
 * used when they can be identified. A named path stands for the one declared path it ends with; one that matches
 * none stands for itself when it has a folder. A bare file name that matches no declared path, or several, identifies
 * nothing: two folders' report.csv are never taken for one file. Declared artifact and asset ids always stay.
 */
function taskTargets(folded: string, declared: readonly string[]): Set<string> {
  const canonical = declared.map(canonicalTarget).filter(Boolean);
  const ids = canonical.filter(isIdTarget);
  const paths = canonical.filter((target) => !isIdTarget(target));
  const named: string[] = [];
  for (const match of folded.matchAll(PATH_TOKEN)) {
    const path = canonicalTarget(match[0]);
    const declaredAs = paths.filter((candidate) => candidate === path || candidate.endsWith(`/${path}`));
    if (declaredAs.length === 1) named.push(declaredAs[0]);
    else if (declaredAs.length === 0 && path.includes('/')) named.push(path);
  }
  return new Set([...(named.length > 0 ? named : paths), ...ids]);
}

function isIdTarget(target: string): boolean {
  return /^(artifact|asset):/u.test(target);
}

/** A workspace path with forward slashes, no leading "./" and no trailing slash, case-folded; an id as given. */
function canonicalTarget(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/u, '').replace(/\/+$/u, '');
  if (!trimmed || isIdTarget(trimmed)) return trimmed;
  return trimmed.normalize('NFKC').toLowerCase();
}

function canonicalFolder(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/u, '').normalize('NFKC').toLowerCase();
}

function blank(text: string, spans: ReadonlyArray<{ start: number; end: number }>): string {
  let out = text;
  for (const span of spans) out = out.slice(0, span.start) + ' '.repeat(span.end - span.start) + out.slice(span.end);
  return out;
}

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const match of text.matchAll(pattern)) count += [...match[0]].length;
  return count;
}

function codePoints(text: string): number {
  return [...text].length;
}

function disjoint<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  for (const value of a) if (b.has(value)) return false;
  return true;
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

/** Whether every value of `inner` is in `outer`. */
function contains<T>(outer: ReadonlySet<T>, inner: ReadonlySet<T>): boolean {
  return [...inner].every((value) => outer.has(value));
}
