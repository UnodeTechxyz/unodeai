/**
 * check:internal-doc-refs — every `SOMETHING.md` an internal document cites must exist.
 *
 * Why this exists: on 2026-08-02 a release plan that calls itself "the current authority" was left
 * pointing at a document that was never committed, so a clean clone got a roadmap citing a file that did
 * not exist. Sweeping for the same shape afterwards found FIVE MORE — all of them cited as if
 * authoritative and NONE of them ever written (`git log --diff-filter=D` finds no deletion; they simply
 * never existed). A plan that cites a document nobody wrote reads exactly like a plan that cites one
 * somebody did.
 *
 * The existing checks do not cover this: `check:public-doc-links` and `check:package-doc-links` guard
 * links in SHIPPED docs, outward. This one guards internal `docs/` cross-references.
 *
 * It deliberately matches BACKTICKED filenames as well as markdown links, because this project cites
 * documents as `` `FOO.md` `` far more often than it links them, and the dangling reference that started
 * this was a backtick.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = process.cwd();

/**
 * Filenames that name a CONVENTION rather than a file in this repo. `AGENTS.md` and `CLAUDE.md` are the
 * ecosystem's instruction-file names, discussed constantly in the harness documents; `SKILL.md` is the
 * per-skill format; the others are third-party or product concepts. Citing them is description, not a
 * link, so they are not resolvable and must not be.
 */
const CONVENTIONAL_NAMES = new Set([
  'AGENTS.md', 'CLAUDE.md', 'SKILL.md', 'CODEEP.md', 'REASONIX.md', 'README.md',
]);

/** Placeholder/template spellings — a pattern, not a path. */
const TEMPLATE_PATTERNS = [/v09xx/i, /<[^>]+>/, /\{[^}]+\}/, /\bexample\b/i, /\bNAME\b/];

/**
 * The private checkout carries a ratchet of pre-existing citations that were never written. It stays in
 * a source-only companion because public drops omit the internal documents it describes. The shipped
 * checker remains executable without it: a public drop has no internal-plan corpus to exempt.
 */
const KNOWN_DANGLING = new Map();
const knownDanglingSource = new URL('./internal-doc-ref-known-dangling.mjs', import.meta.url);
if (existsSync(fileURLToPath(knownDanglingSource))) {
  const { KNOWN_DANGLING: privateKnownDangling } = await import(knownDanglingSource.href);
  for (const [name, reason] of privateKnownDangling) {
    KNOWN_DANGLING.set(name, reason);
  }
}

function lineForOffset(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

/** Every `NAME.md` cited in backticks or as a markdown link target. */
export function citedDocs(text) {
  const cites = [];
  const backticked = /`([A-Za-z0-9_.\-/]+\.md)`/g;
  const linked = /\[[^\]]*\]\(([^\s)]+\.md)(?:[?#][^\s)]*)?\)/g;
  for (const pattern of [backticked, linked]) {
    let match;
    while ((match = pattern.exec(text))) {
      cites.push({ target: match[1], offset: match.index });
    }
  }
  return cites;
}

function isExempt(name) {
  return CONVENTIONAL_NAMES.has(name) || TEMPLATE_PATTERNS.some((re) => re.test(name));
}

/**
 * Decide whether a citation is even ABOUT a document in this repository. Getting this wrong in the
 * permissive direction was the first version's mistake: it flagged ~95 "violations", nearly all of them
 * correct prose.
 *
 * Two things a `.md` path in our documents is usually NOT:
 *  - a RUNTIME artifact in the user's own workspace — `.unode/rules.md`, `.roam/memory/notes.md`. Those
 *    are supposed to be absent here; their presence would be the bug.
 *  - a file a PROCEDURE asks someone to create, or a hypothetical one a design doc is proposing —
 *    `notes-a.md`, `facts.md`, `decisions.md`.
 *
 * So: a path counts only when it is explicitly under `docs/`, and a bare name counts only when it follows
 * this repo's document convention of starting with a capital (`STATUS.md`, `PRD_v0.1.1_Product_Brief.md`).
 * Lower-case bare names are prose about some other file, every time we checked.
 */
export function repoDocTarget(target) {
  const bare = target.replace(/^<|>$/g, '').split(/[?#]/, 1)[0].replaceAll('\\', '/');
  if (bare.includes('/')) {
    return bare.startsWith('docs/') ? bare.slice('docs/'.length) : undefined;
  }
  return /^[A-Z]/.test(bare) ? bare : undefined;
}

export function internalDocRefViolations({ docTexts, existing, knownDangling = KNOWN_DANGLING }) {
  const violations = new Set();
  for (const [file, text] of docTexts) {
    for (const { target, offset } of citedDocs(text)) {
      const rel = repoDocTarget(target);
      if (!rel) { continue; }
      const bare = rel.split('/').pop();
      if (isExempt(bare) || knownDangling.has(bare)) { continue; }
      if (!existing.has(bare)) {
        violations.add(`${file}:${lineForOffset(text, offset)} cites ${target}, which does not exist`);
      }
    }
  }
  return [...violations];
}

function currentInputs() {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch {
    // A public source drop has no .git directory and ships no internal-doc corpus. Its public-link
    // gate owns those files; this check still runs its parser self-test below.
    return { docTexts: [], existing: new Set(), hasInternalCorpus: false };
  }
  const docs = tracked.filter((file) => file.startsWith('docs/') && file.endsWith('.md'));
  const hasInternalCorpus = docs.some((file) => !file.startsWith('docs/wiki/'));
  // The public source drop intentionally ships docs/wiki only. Root release notes can name private
  // historical documents, but those are not a public internal-doc corpus and are covered by public-link
  // checks instead. Do not turn their historical prose into impossible public-drop dependencies.
  const files = hasInternalCorpus
    ? [...docs, ...tracked.filter((file) => !file.includes('/') && file.endsWith('.md'))]
    : [];
  const existing = new Set(files.map((file) => file.split('/').pop()));
  // Read the INDEX -- what the next commit will contain -- not the working tree and not HEAD. Untracked
  // files are absent from the index, so an Owner-held document still cannot satisfy a citation; and in CI
  // the index equals HEAD, so local and CI parity holds. Reading HEAD was the earlier choice and it made
  // this gate check the PREVIOUS commit: a newly added document was invisible until the commit that
  // added it, so the gate passed locally and failed in CI on the same content, and a corrected citation
  // could not be verified before pushing. v0.9.76's team card was the case.
  const docTexts = trackedTexts(files);
  return { docTexts, existing, hasInternalCorpus };
}

/** Read all staged document blobs (index, stage 0) in one Git process. Starting `git show` once per document made the
 * gate slow enough to invite people to skip it, which would undermine the same local/CI parity change. */
function trackedTexts(files) {
  if (files.length === 0) {
    return [];
  }
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: `${files.map((file) => `:${file}`).join('\n')}\n`,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  let offset = 0;
  return files.map((file) => {
    const end = output.indexOf(0x0A, offset);
    const header = output.toString('utf8', offset, end);
    const match = /\bblob (\d+)$/.exec(header);
    if (end < 0 || !match) {
      throw new Error(`check:internal-doc-refs could not read tracked content for ${file}: ${header}`);
    }
    const size = Number(match[1]);
    const start = end + 1;
    const text = output.toString('utf8', start, start + size);
    offset = start + size + 1; // cat-file --batch adds one newline delimiter after every blob
    return [file, text];
  });
}

function runSelfTest() {
  const existing = new Set(['REAL.md']);
  const planted = internalDocRefViolations({
    docTexts: [['docs/PLAN.md', 'See `REAL.md`.\nThen see `GHOST_PLAN.md` for the rest.']],
    existing,
  });
  if (planted.length !== 1 || !planted[0].includes('docs/PLAN.md:2 cites GHOST_PLAN.md')) {
    throw new Error('self-test failed: a planted dangling citation was not reported with file and line');
  }
  // A conventional name must NOT be reported — otherwise every harness document fails on `AGENTS.md`.
  const conventional = internalDocRefViolations({
    docTexts: [['docs/H.md', 'We do not read `AGENTS.md` or `CLAUDE.md` yet.']],
    existing,
  });
  if (conventional.length !== 0) {
    throw new Error('self-test failed: a conventional instruction-file name was wrongly reported');
  }
  // Runtime and procedural paths must stay silent — this was the first version's failure mode, and it
  // produced ~95 reports that were all correct prose.
  const notRepoDocs = internalDocRefViolations({
    docTexts: [['docs/H.md', 'Edit `.unode/rules.md`, create `notes-a.md`, see `../bench/RUNBOOK.md`.']],
    existing,
  });
  if (notRepoDocs.length !== 0) {
    throw new Error(`self-test failed: non-repo paths were reported (${notRepoDocs.join(', ')})`);
  }
  // A docs/-prefixed miss IS in scope, even when lower-case.
  const prefixed = internalDocRefViolations({
    docTexts: [['docs/H.md', 'See [x](docs/comparisons/ghost.md).']],
    existing,
  });
  if (prefixed.length !== 1) {
    throw new Error('self-test failed: a dangling docs/-prefixed link was not reported');
  }
  // A known-dangling entry must be silent, so the ratchet holds without failing the build today.
  const known = internalDocRefViolations({
    docTexts: [['docs/H.md', 'See `PREEXISTING.md`.']],
    existing,
    knownDangling: new Map([['PREEXISTING.md', 'self-test baseline']]),
  });
  if (known.length !== 0) {
    throw new Error('self-test failed: a known-dangling citation was reported');
  }
  // This is rule 19's concrete counterexample. The file exists on disk, so the old working-tree set
  // would pass it; it is absent from the tracked set, so the runner-visible resolver must reject it.
  const diskRoot = mkdtempSync(join(tmpdir(), 'unode-doc-ref-untracked-'));
  const diskOnly = 'ON_DISK_UNTRACKED.md';
  try {
    writeFileSync(join(diskRoot, diskOnly), 'This file is deliberately not tracked.\n', 'utf8');
    if (!existsSync(join(diskRoot, diskOnly))) {
      throw new Error('self-test failed: could not create the on-disk untracked citation target');
    }
    const citation = [['docs/PLAN.md', `See \`${diskOnly}\`.`]];
    const oldWorkingTreeResolution = internalDocRefViolations({
      docTexts: citation,
      existing: new Set(['REAL.md', diskOnly]),
    });
    const trackedResolution = internalDocRefViolations({
      docTexts: citation,
      existing: new Set(['REAL.md']),
    });
    if (oldWorkingTreeResolution.length !== 0 || trackedResolution.length !== 1) {
      throw new Error('self-test failed: an on-disk untracked citation did not distinguish old and tracked resolution');
    }
  } finally {
    rmSync(diskRoot, { recursive: true, force: true });
  }
  console.log('check:internal-doc-refs self-test passed (planted dangling and on-disk untracked citations fail; conventions and known entries do not).');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  runSelfTest();
  const inputs = currentInputs();
  const violations = internalDocRefViolations(inputs);
  if (violations.length > 0) {
    throw new Error(
      `check:internal-doc-refs failed:\n- ${violations.join('\n- ')}\n\n` +
      'Write the document, or correct the citation. Do NOT add it to KNOWN_DANGLING — that list may only shrink.'
    );
  }
  console.log(`check:internal-doc-refs passed (${KNOWN_DANGLING.size} known-dangling citations carried, none new).`);
  if (!inputs.hasInternalCorpus) {
    console.log('check:internal-doc-refs public-drop mode: no internal docs corpus shipped; self-test passed.');
  }
}
