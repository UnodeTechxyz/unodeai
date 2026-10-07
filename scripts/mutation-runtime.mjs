import { createHash } from 'node:crypto';
import { basename, relative, sep } from 'node:path';

const TREE_EXCLUDES = new Set([
  '.git',
  '.ovsx-pat',
  '.vscode-test',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

const LOCAL_STATE_ROOTS = new Set([
  '.agents',
  '.claude',
  '.codex',
  '.gemini',
  '.kilo',
  '.mutation-receipts',
  '.npm-cache',
  '.roam',
  '.unode',
]);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableMutationId(group, label) {
  const prefix = group.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!prefix || !label) throw new Error('Mutation ids require a non-empty group and label.');
  return `${prefix}-${digest(label).slice(0, 10)}`;
}

export function mutationCases(group, cases) {
  const identified = cases.map((mutation) => ({
    ...mutation,
    id: mutation.id ?? stableMutationId(group, mutation.name),
  }));
  const ids = identified.map((mutation) => mutation.id);
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate mutation id in ${group}.`);
  return identified;
}

/**
 * Apply a textual mutant only when its complete anchor occurs exactly once.
 * Missing and duplicated anchors are both invalid evidence: String.replace()
 * silently accepting either case is how the streaming route assertion escaped
 * the main mutation population.
 */
export function replaceExactlyOnce(text, mutation) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const from = String(mutation.from).split('\n').join(eol);
  const to = String(mutation.to).split('\n').join(eol);
  const first = text.indexOf(from);
  if (first < 0) {
    return {
      kind: 'invalid',
      reason: `anchor matches zero times in ${mutation.file ?? 'source'}`,
    };
  }
  if (first !== text.lastIndexOf(from)) {
    return {
      kind: 'invalid',
      reason: `anchor matches more than once in ${mutation.file ?? 'source'}`,
    };
  }
  return {
    kind: 'mutated',
    text: `${text.slice(0, first)}${to}${text.slice(first + from.length)}`,
  };
}

function parseValue(args, index, option) {
  const inline = args[index].startsWith(`${option}=`) ? args[index].slice(option.length + 1) : undefined;
  if (inline !== undefined) return { value: inline, consumed: 1 };
  if (args[index] === option && args[index + 1]) return { value: args[index + 1], consumed: 2 };
  throw new Error(`${option} requires a value.`);
}

export function parseMutationSelection(args) {
  let list = false;
  let shard;
  const caseIds = [];
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === '--list') {
      list = true;
      index += 1;
    } else if (arg === '--case' || arg.startsWith('--case=')) {
      const parsed = parseValue(args, index, '--case');
      const parsedIds = parsed.value.split(',').map((value) => value.trim()).filter(Boolean);
      if (parsedIds.length === 0) throw new Error('--case requires at least one case id.');
      caseIds.push(...parsedIds);
      index += parsed.consumed;
    } else if (arg === '--shard' || arg.startsWith('--shard=')) {
      if (shard) throw new Error('--shard may be specified only once.');
      const parsed = parseValue(args, index, '--shard');
      const match = /^(\d+)\/(\d+)$/.exec(parsed.value);
      if (!match) throw new Error('--shard must use the one-based form INDEX/COUNT.');
      const part = Number(match[1]);
      const count = Number(match[2]);
      if (!Number.isSafeInteger(part) || !Number.isSafeInteger(count) || count < 1 || part < 1 || part > count) {
        throw new Error('--shard must satisfy 1 <= INDEX <= COUNT.');
      }
      shard = { part, count };
      index += parsed.consumed;
    } else {
      throw new Error(`Unknown mutation-runner option: ${arg}`);
    }
  }
  if (list && (shard || caseIds.length > 0)) throw new Error('--list cannot be combined with --case or --shard.');
  if (shard && caseIds.length > 0) throw new Error('--case and --shard cannot be combined.');
  if (new Set(caseIds).size !== caseIds.length) throw new Error('--case ids must be unique.');
  return { list, shard, caseIds };
}

function shardBucket(id, count) {
  return Number.parseInt(digest(id).slice(0, 12), 16) % count;
}

export function selectMutationCases(cases, selection) {
  const known = new Set(cases.map((mutation) => mutation.id));
  const unknown = selection.caseIds.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`Unknown mutation case id(s): ${unknown.join(', ')}`);

  let selected = cases;
  if (selection.caseIds.length > 0) {
    const requested = new Set(selection.caseIds);
    selected = cases.filter((mutation) => requested.has(mutation.id));
  } else if (selection.shard) {
    selected = cases.filter((mutation) => shardBucket(mutation.id, selection.shard.count) === selection.shard.part - 1);
  }
  if (selected.length === 0 && !selection.list) throw new Error('Mutation selection is empty.');
  return {
    cases: selected,
    complete: !selection.shard && selection.caseIds.length === 0,
    label: selection.shard
      ? `shard ${selection.shard.part}/${selection.shard.count}`
      : selection.caseIds.length > 0 ? `${selection.caseIds.length} selected case(s)` : 'complete population',
  };
}

function isScratchRoot(name) {
  const lower = name.toLowerCase();
  return LOCAL_STATE_ROOTS.has(lower)
    || lower === '.impl-worktrees'
    || lower === '.audit-worktrees'
    || lower === '.worktrees'
    || lower === '.ui-repro'
    || lower === 'release-test-stress'
    || lower.startsWith('.tmp')
    || lower.startsWith('.public-drop')
    || lower.startsWith('.canonical-')
    || lower.startsWith('.docx_review')
    || /^release-v\d/.test(lower);
}

/**
 * Copy the live source tree without recursively cloning accumulated worktrees, release drops, caches or
 * agent-local state into every mutation sandbox. Source/config edits remain visible because this is deliberately
 * a working-tree copy rather than a checkout of HEAD.
 */
export function createMutationCopyFilter(root) {
  return (source) => {
    const rel = relative(root, source);
    if (!rel) return true;
    if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
    const parts = rel.split(/[\\/]/);
    if (parts.some((part) => TREE_EXCLUDES.has(part.toLowerCase()))) return false;
    if (isScratchRoot(parts[0])) return false;
    return !basename(source).toLowerCase().endsWith('.vsix');
  };
}
