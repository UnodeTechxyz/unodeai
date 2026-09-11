/*
 * E3 vocabulary guard. This is deliberately a source-level lint, not evidence that a user drove
 * the installed UI. Its job is to make an old local-Codex claim loud when release copy changes.
 */
import { readdirSync, readFileSync } from 'fs';
import { join, posix } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const PRODUCT_DOCS = [
  'README.md',
  'USAGE.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'docs/wiki/README.md',
  'docs/wiki/index.html',
] as const;
const INTERNAL_DOC_PATH = /^docs\/(?:TASK|DESIGN|ADR|RESEARCH|ROADMAP|DECISION|AUDIT|FINDINGS|PLAN|PRD)_/i;
const EXTERNAL_LINK = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function lineForOffset(text: string, offset: number): number {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function linkTargets(text: string): Array<{ target: string; offset: number }> {
  const links: Array<{ target: string; offset: number }> = [];
  const markdown = /!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g;
  const href = /\bhref\s*=\s*["']([^"']+)["']/gi;
  for (const pattern of [markdown, href]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      links.push({ target: match[1], offset: match.index });
    }
  }
  return links;
}

function repoRelativeTarget(file: string, target: string): string | undefined {
  const bare = target.trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0];
  if (!bare || EXTERNAL_LINK.test(bare)) { return undefined; }
  return posix.normalize(posix.join(posix.dirname(file.replaceAll('\\', '/')), bare.replaceAll('\\', '/')));
}

export function internalDocLinkViolations(file: string, text: string): string[] {
  return linkTargets(text).flatMap(({ target, offset }) => {
    const resolved = repoRelativeTarget(file, target);
    return resolved && INTERNAL_DOC_PATH.test(resolved)
      ? [`${file}:${lineForOffset(text, offset)} -> ${target}`]
      : [];
  });
}

function sourceCommentInternalDocViolations(file: string, text: string): string[] {
  const violations: string[] = [];
  const internalReference = /docs[\\/](?:TASK|DESIGN|ADR|RESEARCH|ROADMAP|DECISION|AUDIT|FINDINGS|PLAN|PRD)_[^\s*)`]+/ig;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!/^\s*(?:\/\/|\/\*|\*|\*\/)/.test(line)) { continue; }
    let match: RegExpExecArray | null;
    while ((match = internalReference.exec(line))) {
      violations.push(`${file}:${index + 1} -> ${match[0]}`);
    }
  }
  return violations;
}

function sourceFiles(directory: string, prefix = 'src'): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}/${entry.name}`;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) { return sourceFiles(absolute, relative); }
    return /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/i.test(entry.name) ? [relative] : [];
  });
}

function wikiFiles(directory: string, prefix = 'docs/wiki'): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}/${entry.name}`;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) { return wikiFiles(absolute, relative); }
    return [relative];
  });
}

const PUBLIC_WEB_DOCS = [
  'SECURITY.md',
  'USAGE.md',
  'docs/wiki/index.html',
] as const;

function currentCodexCopyViolations(text: string): string[] {
  const staleRoute = /Codex Headless[^\n.]*(?:can be selected|is selectable|read-only specialist|exact local Codex CLI)/i;
  const staleSetup = /(?:Set up|configure|install) Codex (?:CLI|Headless)[^\n.]*(?:in|for) (?:this |v0\.9\.30)/i;
  const capabilityVerb = /\b(?:write|edit|run|execute|command(?:s)?|shell|coordinate|PM|delegate|delegation|worktree(?:s)?|mediated Act)\b/i;
  const codexHeadless = /\bCodex Headless\b/i;
  const affirmativeCodexSubject = /\bCodex(?: Headless| CLI)?\s+(?:can|may|will|does|is able to|has|supports?|allows?|runs?|writes?|edits?|executes?)\b/i;
  const claims: string[] = [];
  if (staleRoute.test(text)) { claims.push('a runnable local Codex route'); }
  if (staleSetup.test(text)) { claims.push('a local Codex setup action'); }

  // A capability verb is only allowed in a local-Codex sentence when it is explicitly negated or
  // marked unavailable.  This is intentionally broader than the phrases removed in E3: copy such
  // as "Codex can edit files" must become loud before it reaches a release artifact.
  const clauses = text.split(/[\r\n.!?]+/).map((clause) => clause.trim()).filter(Boolean);
  for (const clause of clauses) {
    // "Codex review" in an historical changelog is not a product capability claim. A Headless
    // mention is always in scope; otherwise require Codex to be the grammatical subject of a
    // current capability sentence (for example, "Codex can edit files").
    if ((!codexHeadless.test(clause) && !affirmativeCodexSubject.test(clause)) || !capabilityVerb.test(clause)) { continue; }
    const unavailable = /\b(?:coming soon|not available|not runnable|cannot|can't|does not|doesn't|no local)\b/i.test(clause);
    if (!unavailable) {
      claims.push(`an affirmative local Codex capability: "${clause.slice(0, 120)}"`);
    }
  }
  return claims;
}

/** A user-controlled public-web tool means these absolute claims are no longer truthful. */
function absolutePublicWebClaims(text: string): string[] {
  const claims: string[] = [];
  const patterns = [
    /\b(?:no|zero)\s+(?:public[- ]web|web|internet)\s+(?:access|egress|requests?)\b/i,
    /\b(?:agents?|the extension)\s+(?:never|cannot|can't|does not|doesn't)\s+(?:access|reach|use)\s+(?:the )?(?:public )?(?:web|internet)\b/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      claims.push(pattern.source);
    }
  }
  return claims;
}

describe('E3 product documentation vocabulary', () => {
  it.each(PRODUCT_DOCS)('%s describes Codex Headless as Coming soon, not a current local capability', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(text, `${file} must name the unavailable connection family`).toMatch(/Codex Headless/i);
    expect(text, `${file} must make the v0.9.30 availability truthful`).toMatch(/Coming soon|not runnable|not active|does not offer setup\/default\/start/i);
    expect(currentCodexCopyViolations(text), `${file} contains a stale local-Codex product claim`).toEqual([]);
  });

  it('would flag the stale phrases this release removed', () => {
    expect(currentCodexCopyViolations('Codex Headless can be selected as a read-only specialist.'))
      .toContain('a runnable local Codex route');
    expect(currentCodexCopyViolations('Codex Headless is an exact local Codex CLI using your subscription.'))
      .toContain('a runnable local Codex route');
    expect(currentCodexCopyViolations('Codex can edit files.'))
      .toContainEqual(expect.stringContaining('affirmative local Codex capability'));
    expect(currentCodexCopyViolations('Codex Headless can write files and run commands.'))
      .toContainEqual(expect.stringContaining('affirmative local Codex capability'));
    expect(currentCodexCopyViolations('Codex Headless is coming soon and cannot write or run commands.'))
      .toEqual([]);
  });

  it('keeps SECURITY.md explicit about the route boundary and the evidence that establishes it', () => {
    const security = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');
    expect(security).toMatch(/assertResolvedRoute/);
    expect(security).toMatch(/RouteContracts\.test\.ts/);
  });

  it.each(PUBLIC_WEB_DOCS)('%s states the public-web policy and carries no absolute non-egress claim', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(text).toMatch(/unode\.webAccess/);
    expect(text).toMatch(/fetch_url/);
    expect(text).toMatch(/WebSearch|WebFetch/);
    expect(absolutePublicWebClaims(text), `${file} contains an obsolete absolute public-web claim`).toEqual([]);
  });

  it('would flag the absolute public-web phrases this release must not reintroduce', () => {
    expect(absolutePublicWebClaims('Agents never access the public web.')).not.toEqual([]);
    expect(absolutePublicWebClaims('There is zero web egress.')).not.toEqual([]);
    expect(absolutePublicWebClaims('Public-web access defaults to ask and can be turned off.')).toEqual([]);
  });

  it('keeps public docs and source comments free of internal-only documentation links', () => {
    const publicDocs = [...PRODUCT_DOCS, ...wikiFiles(join(ROOT, 'docs', 'wiki'))];
    const docViolations = publicDocs.flatMap((file) => internalDocLinkViolations(file, readFileSync(join(ROOT, file), 'utf8')));
    const sourceViolations = sourceFiles(join(ROOT, 'src')).flatMap((file) =>
      sourceCommentInternalDocViolations(file, readFileSync(join(ROOT, file), 'utf8')),
    );
    expect([...docViolations, ...sourceViolations]).toEqual([]);
  });

  it('reports a planted internal-doc link with its file, line, and target', () => {
    const planted = 'One safe line.\n[internal evidence](docs/' + 'TASK_example.md)';
    expect(internalDocLinkViolations('SECURITY.md', planted)).toEqual([
      'SECURITY.md:2 -> docs/TASK_example.md',
    ]);
  });
});
