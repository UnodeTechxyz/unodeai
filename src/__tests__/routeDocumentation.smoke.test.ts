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
  // CHANGELOG is release history. The version-stamp gate forbids unreleased future copy there; the Codex
  // disclosure is added only when the standalone candidate receives an Owner-approved version/date.
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

function codexDisclosureViolations(text: string): string[] {
  const violations: string[] = [];
  if (!/\bCodex CLI\b/i.test(text)) violations.push('missing Codex CLI route');
  if (!/\bApp Server\b|codex app-server/i.test(text)) violations.push('missing App Server transport');
  if (!/(?:does not|doesn't|outside)[\s\S]{0,80}(?:control|enforce|restrict)[\s\S]{0,100}network|network[\s\S]{0,100}(?:not controlled|outside UnodeAi)/i.test(text)) {
    violations.push('missing direct-network boundary');
  }
  if (!/(?:does not|doesn't)[\s\S]{0,220}claim[\s\S]{0,100}reads?[\s\S]{0,100}confined|reads?[\s\S]{0,100}(?:not|aren't|are not)[\s\S]{0,100}(?:confined|sandbox)|not[\s\S]{0,80}read confinement/i.test(text)) {
    violations.push('missing read-confinement boundary');
  }
  if (!/Codex[\s\S]{0,240}(?:read-only|read only)|(?:read-only|read only)[\s\S]{0,240}Codex/i.test(text)) {
    violations.push('missing read-only runtime boundary');
  }
  if (!/Ask for approval/i.test(text) || !/workspace-write|workspace write/i.test(text) || !/on-request/i.test(text)) {
    violations.push('missing native Ask for approval profile');
  }
  if (!/Approve for me/i.test(text) || !/auto_review|auto-review/i.test(text)) {
    violations.push('missing native Approve for me profile');
  }
  if (!/Full access \(unsafe\)/i.test(text) || !/(?:removes|no|without)[\s\S]{0,80}(?:the )?sandbox/i.test(text)) {
    violations.push('missing unsafe Full access disclosure');
  }
  if (!/(?:routine|in-boundary|inside (?:the )?(?:granted )?workspace)[\s\S]{0,180}(?:commands?|edits?)[\s\S]{0,180}(?:without|do not)[\s\S]{0,80}(?:card|ask|approval)/i.test(text)) {
    violations.push('missing automatic in-boundary behavior');
  }
  if (!/(?:routine )?Codex[\s\S]{0,180}(?:edits?|writes?)[\s\S]{0,180}(?:not|aren't|are not|without)[\s\S]{0,100}(?:UnodeAi )?checkpoints?|(?:not|aren't|are not|without)[\s\S]{0,100}(?:UnodeAi )?checkpoints?[\s\S]{0,180}Codex/i.test(text)) {
    violations.push('missing Codex checkpoint limitation');
  }
  if (!/(?:permission|MCP)[\s\S]{0,160}(?:card|approval)|(?:card|approval)[\s\S]{0,160}(?:permission|MCP)/i.test(text)) {
    violations.push('missing separate permission-card boundary');
  }
  return violations;
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
  it.each(PRODUCT_DOCS)('%s describes the admitted Codex route and its explicit limits', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(codexDisclosureViolations(text), `${file} must carry the complete Codex boundary`).toEqual([]);
  });

  it('would flag an availability claim that omits the security boundary', () => {
    expect(codexDisclosureViolations('Codex CLI is available.')).toEqual(expect.arrayContaining([
      'missing App Server transport',
      'missing direct-network boundary',
      'missing read-confinement boundary',
      'missing read-only runtime boundary',
      'missing native Ask for approval profile',
      'missing automatic in-boundary behavior',
      'missing Codex checkpoint limitation',
      'missing separate permission-card boundary',
    ]));
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
