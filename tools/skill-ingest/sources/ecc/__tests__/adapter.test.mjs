import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  classifyCompatibility,
  parseEccFrontmatter,
  pathSafetyFindings,
  runEccAdapter,
  sourceIdentityViolations,
} from '../adapter.mjs';

const here = path.resolve(process.cwd(), 'tools/skill-ingest/sources/ecc');
const fixtureRoot = path.join(here, 'fixtures/source');
const fixtureDescriptor = JSON.parse(await readFile(path.join(here, 'fixtures/source.json'), 'utf8'));
const fixtureOptions = {
  sourceRoot: fixtureRoot,
  descriptor: fixtureDescriptor,
  fixtureIdentity: { kind: 'synthetic-fixture', commit: fixtureDescriptor.pinnedCommit },
  bundledSkillsRoot: false,
};

describe('ECC source adapter', () => {
  it('produces deterministic metadata-only rows and keeps ingestion distinct from compatibility', async () => {
    const first = await runEccAdapter(fixtureOptions);
    const second = await runEccAdapter(fixtureOptions);
    expect(second).toEqual(first);
    expect(first.summary.discovered).toBe(5);
    expect(first.measurement).toMatchObject({
      kind: 'ingestion',
      compatibilityIsBehaviouralEffectiveness: false,
      candidateContentExecuted: false,
      candidateContentInstalled: false,
      candidateContentBundled: false,
      candidateContentEnabled: false,
    });
    expect(first.candidates.every((candidate) => candidate.citation.measurement === 'ingestion')).toBe(true);

    const serialized = JSON.stringify(first);
    expect(first.candidates.every((candidate) => !Object.hasOwn(candidate, 'description'))).toBe(true);
    expect(first.candidates.every((candidate) => !Object.hasOwn(candidate, 'body'))).toBe(true);
    expect(first.candidates.every((candidate) => !Object.hasOwn(candidate, 'excerpt'))).toBe(true);
    expect(serialized).not.toContain('This inert fixture');
    expect(serialized).not.toContain('hostile note');
  });

  it('refuses duplicate source ids and resolves a candidate-local license before the root license', async () => {
    const report = await runEccAdapter(fixtureOptions);
    const duplicates = report.candidates.filter((candidate) => candidate.ingestion.reasonCodes.includes('duplicate_source_name'));
    expect(duplicates).toHaveLength(2);
    expect(duplicates.every((candidate) => candidate.ingestion.status === 'REJECT')).toBe(true);
    expect(new Set(duplicates.map((candidate) => candidate.id)).size).toBe(2);

    const hostSpecific = report.candidates.find((candidate) => candidate.sourcePath.includes('host-specific'));
    expect(hostSpecific.license).toMatchObject({ status: 'PASS', spdxLicenseId: 'Apache-2.0', scope: 'candidate-frontmatter' });
    expect(hostSpecific.ingestion.status).toBe('FLAG');
    expect(hostSpecific.ingestion.reasonCodes).toContain('prompt_injection');
    expect(hostSpecific.compatibility.status).toBe('needs-dependency');
    expect(hostSpecific.compatibility.dependencyClasses).toEqual(expect.arrayContaining(['claude-code', 'mcp', 'hook', 'cli', 'package-install', 'network']));
    expect(hostSpecific.compatibility.roleTeamFit).toMatchObject({
      basis: 'domain-only-static-candidate',
      roleIds: ['architect', 'senior-dev', 'reviewer', 'tester'],
      requiresCustomRole: false,
    });

    const thirdParty = report.candidates.find((candidate) => candidate.sourcePath.includes('third-party-origin'));
    expect(thirdParty.license.status).toBe('REJECT');
    expect(thirdParty.ingestion.reasonCodes).toEqual(expect.arrayContaining(['ambiguous_third_party_origin', 'no_license']));

    const conflict = report.candidates.find((candidate) => candidate.sourcePath.includes('license-conflict'));
    expect(conflict.license.status).toBe('REJECT');
    expect(conflict.ingestion.reasonCodes).toContain('license_conflict');
  });

  it('parses block scalars as untrusted data and records unknown metadata without exposing it in public rows', () => {
    const parsed = parseEccFrontmatter([
      '---',
      'name: fixture-block-scalar',
      'description: >-',
      '  Use this fixture when a source uses folded YAML.',
      'metadata:',
      '  reviewer: do-not-trust',
      '---',
      'Safe fixture body.',
    ].join('\n'));
    expect(parsed.description).toBe('Use this fixture when a source uses folded YAML.');
    expect(parsed.fields.metadata).toBe('');
    expect(parsed.sourceMetadata.unknownKeys).toEqual(['metadata']);
    expect(parsed.sourceMetadata.unknownFieldHashes.metadata).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.nestedScalars['metadata.reviewer']).toBe('do-not-trust');
    expect(parsed.sourceMetadata.nestedKeys).toEqual(['metadata.reviewer']);
  });

  it('covers path escape, symlink, executable, attachment and oversized-body classifications', () => {
    expect(pathSafetyFindings([
      { path: '../escape', type: 'file' },
      { path: 'reference', type: 'symlink' },
      { path: 'scripts', type: 'directory' },
      { path: 'scripts/helper.sh', type: 'file' },
      { path: 'assets/reference.pdf', type: 'file' },
    ]).map((finding) => finding.code)).toEqual([
      'attachment_companion',
      'executable_directory',
      'executable_payload',
      'path_escape',
      'symbolic_link',
    ]);

    const parsed = {
      name: 'fixture-oversize',
      description: 'Use this fixture when testing the disclosure size boundary.',
      body: 'x'.repeat(24001),
      fields: {},
      sourceMetadata: { keys: [], unknownKeys: [], unknownFieldHashes: {}, frontmatterSha256: '0'.repeat(64) },
    };
    expect(classifyCompatibility({ parsed, bodyLimit: 24000 })).toMatchObject({
      status: 'needs-transform',
      dependencyClasses: ['oversize'],
      progressiveDisclosure: 'requires-split',
    });
  });

  it('fails closed on a moving or dirty source identity', () => {
    expect(sourceIdentityViolations({ expectedCommit: 'a', observedCommit: 'b', dirtyPaths: '' })).toEqual(['source_commit_mismatch']);
    expect(sourceIdentityViolations({ expectedCommit: 'a', observedCommit: 'a', dirtyPaths: '?? skills/new' })).toEqual(['source_checkout_dirty']);
  });
});
