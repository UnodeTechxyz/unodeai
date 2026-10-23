import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLI_COMPATIBILITY_POLICY,
  CLI_POLICY_LIMITS,
  CLI_REQUIRED_CANARIES,
  CLI_STORE_PATH_LAYOUT,
  CODEX_POLICY_VERSION_FLOOR,
  cliStoreVersionKey,
  loadCliCompatibilityPolicy,
  longestCliStorePathChars,
  qualifyCliClosure,
  validateCliCompatibilityPolicy,
  type CliClosureFile,
  type CliCompatibilityPolicy,
  type PolicyEntry,
  type QualifiableCliClosure,
  type ValidatedCliCompatibilityPolicy,
} from '../cliCompatibilityPolicy';
import { CODEX_MINIMUM_VERSION } from '../CodexBackend';

// The design these tests realise: the P6 effective specification, §3.3 (qualification), §3.5 (policy schema v1 and
// its nine validator invariants) and §11 items 1 and 3; the policy location rules (compiled in, validated once, a
// failing policy disables qualification, no fs/fetch/vscode import).

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const HOST = { os: 'win32', arch: 'x64' };

function canaries(provider: 'claude-cli' | 'codex-cli') {
  return CLI_REQUIRED_CANARIES[provider].map((id) => ({ id, result: 'pass' as const, evidenceRef: `record#${id}`, ranAt: '2026-10-21T00:00:00Z', model: 'test-model' }));
}

const CODEX_FILES = [
  { path: 'codex-package.json', size: 215, sha256: sha('codex-package.json'), pe: false, signer: 'none' as const },
  { path: 'bin/codex.exe', size: 1000, sha256: sha('codex.exe'), pe: true, signer: 'openai' as const },
  { path: 'codex-path/rg.exe', size: 400, sha256: sha('rg.exe'), pe: true, signer: 'unsigned' as const },
  { path: 'codex-resources/voice/bin/vcruntime140.dll', size: 120, sha256: sha('vcruntime140.dll'), pe: true, signer: 'microsoft-crt' as const },
];

function codexEntry(overrides: Partial<PolicyEntry> = {}): PolicyEntry {
  return {
    id: 'codex-cli/0.163.0/win32-x64/codex-package',
    provider: 'codex-cli',
    version: '0.163.0',
    versionOutput: 'codex-cli 0.163.0',
    os: 'win32',
    arch: 'x64',
    status: 'qualified',
    managed: {
      artifact: {
        kind: 'tar.gz',
        name: 'codex-package-x86_64-pc-windows-msvc.tar.gz',
        size: 162_230_206,
        sha256: sha('artifact'),
        urls: [
          'https://releases.openai.com/codex/releases/0.163.0/codex-package-x86_64-pc-windows-msvc.tar.gz',
          'https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-package-x86_64-pc-windows-msvc.tar.gz',
        ],
        redirectHosts: ['release-assets.githubusercontent.com'],
      },
      layout: {
        entrypoint: 'bin/codex.exe',
        unpackedBytes: 1735,
        dirs: ['bin', 'codex-path', 'codex-resources', 'codex-resources/voice', 'codex-resources/voice/bin'],
        ignoredEntries: [],
        files: CODEX_FILES.map((file) => ({ ...file })),
      },
    },
    gates: { fileChangeApproval: true },
    canaries: canaries('codex-cli'),
    selfUpdateReview: { sourceRef: 'rust-v0.163.0', finding: 'app-server has no update path' },
    qualifiedAt: '2026-10-21',
    qualificationRecord: 'docs/release-record#codex-0.163.0',
    leafThumbprints: ['0123456789ABCDEF0123456789ABCDEF01234567'],
    ...overrides,
  };
}

function claudeEntry(overrides: Partial<PolicyEntry> = {}): PolicyEntry {
  return {
    id: 'claude-cli/2.1.304/win32-x64/native',
    provider: 'claude-cli',
    version: '2.1.304',
    versionOutput: '2.1.304 (Claude Code)',
    os: 'win32',
    arch: 'x64',
    status: 'qualified',
    external: { executableDigests: [sha('claude.exe 2.1.304')] },
    gates: { settingsGate: true },
    canaries: canaries('claude-cli'),
    selfUpdateReview: { sourceRef: 'vendor updater', finding: 'vendor-managed' },
    qualifiedAt: '2026-10-21',
    qualificationRecord: 'docs/release-record#claude-2.1.304',
    leafThumbprints: [],
    ...overrides,
  };
}

function validPolicy(entries: PolicyEntry[] = [codexEntry(), claudeEntry()]): CliCompatibilityPolicy {
  const policy = structuredClone(CLI_COMPATIBILITY_POLICY) as CliCompatibilityPolicy;
  policy.policyVersion = '0.9.97-test';
  policy.entries = entries;
  return policy;
}

function problemsAfter(mutate: (policy: CliCompatibilityPolicy) => void, entries?: PolicyEntry[]): string[] {
  const policy = validPolicy(entries);
  mutate(policy);
  return validateCliCompatibilityPolicy(policy);
}

/** Every problem names this invariant, and there is at least one. */
function expectOnlyInvariant(problems: string[], number: number): void {
  expect(problems.length, 'the change is refused').toBeGreaterThan(0);
  expect(problems.filter((problem) => !problem.startsWith(`invariant ${number}:`)), 'and only by this invariant').toEqual([]);
}

function loaded(policy: CliCompatibilityPolicy): ValidatedCliCompatibilityPolicy {
  const result = loadCliCompatibilityPolicy(policy);
  if (!result.ok) throw new Error(`fixture policy refused: ${result.problems.join('; ')}`);
  return result.policy;
}

const codexClosure = (files: CliClosureFile[] = CODEX_FILES.map(({ path, size, sha256 }) => ({ path, size, sha256 })), overrides: Partial<QualifiableCliClosure> = {}): QualifiableCliClosure => ({
  provider: 'codex-cli',
  kind: 'package',
  files,
  executablePath: 'bin/codex.exe',
  ...overrides,
});

describe('the bundled CLI compatibility policy (P6 §3.5, policy location)', () => {
  // v0.9.97 (O4, the Owner's decision): only the latest Codex and Claude releases, qualified from verified downloads
  // and the release canaries.
  it('ships policy 0.9.97-1 with the two O4 entries, and loads', () => {
    expect(CLI_COMPATIBILITY_POLICY.schema).toBe('unodeai.cli-compatibility/1');
    expect(CLI_COMPATIBILITY_POLICY.policyVersion).toBe('0.9.97-1');
    expect(CLI_COMPATIBILITY_POLICY.entries.map((entry) => [entry.id, entry.status, entry.version, entry.versionOutput])).toEqual([
      ['codex-cli/0.163.0/win32-x64/codex-package', 'qualified', '0.163.0', 'codex-cli 0.163.0'],
      ['claude-cli/2.1.306/win32-x64/native', 'qualified', '2.1.306', '2.1.306 (Claude Code)'],
    ]);
    expect(validateCliCompatibilityPolicy(CLI_COMPATIBILITY_POLICY)).toEqual([]);
    const result = loadCliCompatibilityPolicy();
    expect(result.ok).toBe(true);
  });

  it('pins the verified Codex 0.163.0 package: the archive digest, its two hosts, 45 files and the signer of each program file', () => {
    const codex = CLI_COMPATIBILITY_POLICY.entries[0]!;
    const managed = codex.managed!;
    expect(managed.artifact).toEqual({
      kind: 'tar.gz', name: 'codex-package-x86_64-pc-windows-msvc.tar.gz', size: 162_230_206,
      sha256: '901028b285614a9974f431f9d9f6534b3e5ed8d62eba4ba64f4762c00f040522',
      urls: [
        'https://releases.openai.com/codex/releases/0.163.0/codex-package-x86_64-pc-windows-msvc.tar.gz',
        'https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-package-x86_64-pc-windows-msvc.tar.gz',
      ],
      redirectHosts: ['release-assets.githubusercontent.com'],
    });
    expect(managed.layout.entrypoint).toBe('bin/codex.exe');
    expect(managed.layout.files).toHaveLength(45);
    expect(managed.layout.unpackedBytes).toBe(managed.layout.files.reduce((sum, file) => sum + file.size, 0));
    const signers = (signer: string) => managed.layout.files.filter((file) => file.signer === signer).map((file) => file.path);
    expect(signers('unsigned')).toEqual(['codex-path/rg.exe']);
    expect(signers('microsoft-crt')).toEqual(['codex-resources/voice/bin/vcruntime140.dll']);
    expect(signers('openai')).toHaveLength(30);
    expect(managed.layout.files.every((file) => file.pe === (file.signer !== 'none'))).toBe(true);
    // The C runtime's bytes are the ones the package's own windows-crt.json names.
    expect(managed.layout.files.find((file) => file.signer === 'microsoft-crt')!.sha256).toBe('184146852727a9db4eea06178716bec3cdbb1015c911f6b0f915b184ad7775b2');
    expect(new Set(codex.canaries.map((canary) => canary.id))).toEqual(new Set(CLI_REQUIRED_CANARIES['codex-cli']));
  });

  it('qualifies exactly the bytes it lists: the Codex package listing and the one Claude program file, on Windows x64 only', () => {
    const policy = loaded(CLI_COMPATIBILITY_POLICY);
    const [codex, claude] = CLI_COMPATIBILITY_POLICY.entries;
    const listing = codex!.managed!.layout.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    expect(qualifyCliClosure(policy, codexClosure(listing), HOST)).toMatchObject({ verdict: 'qualified', version: '0.163.0' });
    const changed = listing.map((file, index) => (index === 0 ? { ...file, sha256: '0'.repeat(64) } : file));
    expect(qualifyCliClosure(policy, codexClosure(changed), HOST).verdict).toBe('needs-adoption');
    // The GPG-verified native release and the npm package's program are the same bytes.
    expect(claude!.external).toEqual({ executableDigests: ['f6bc9de38f507c36c9a3bb0085a59a27e32156e2208252bf1707c4e3ef309114'] });
    const program = { path: 'claude.exe', size: 295_628_960, sha256: claude!.external!.executableDigests[0]! };
    const single = { provider: 'claude-cli' as const, kind: 'single-file' as const, files: [program], executablePath: 'claude.exe' };
    expect(qualifyCliClosure(policy, single, HOST)).toMatchObject({ verdict: 'qualified', version: '2.1.306' });
    expect(qualifyCliClosure(policy, single, { os: 'linux', arch: 'x64' }).verdict).toBe('needs-adoption');
    expect(new Set(claude!.canaries.map((canary) => canary.id))).toEqual(new Set(CLI_REQUIRED_CANARIES['claude-cli']));
  });

  it('pins exactly the publisher identities read from the signed files', () => {
    expect(CLI_COMPATIBILITY_POLICY.signers).toEqual({
      openai: {
        accepted: [{
          signatureType: 'Authenticode',
          subjectRdns: [['2.5.4.6', 'US'], ['2.5.4.8', 'California'], ['2.5.4.7', 'San Francisco'], ['2.5.4.10', 'OpenAI OpCo, LLC'], ['2.5.4.3', 'OpenAI OpCo, LLC']],
          rootThumbprint: 'F40042E2E5F7E8EF8189FED15519AECE42C3BFA2',
        }],
      },
      'microsoft-crt': {
        accepted: [
          {
            signatureType: 'Catalog',
            subjectRdns: [['2.5.4.6', 'US'], ['2.5.4.8', 'Washington'], ['2.5.4.7', 'Redmond'], ['2.5.4.10', 'Microsoft Corporation'], ['2.5.4.3', 'Microsoft Windows']],
            rootThumbprint: '3B1EFD3A66EA28B16697394703A72CA340A05BD5',
          },
          {
            signatureType: 'Authenticode',
            subjectRdns: [['2.5.4.6', 'US'], ['2.5.4.8', 'Washington'], ['2.5.4.7', 'Redmond'], ['2.5.4.10', 'Microsoft Corporation'], ['2.5.4.3', 'Microsoft Windows Software Compatibility Publisher']],
            rootThumbprint: '8F43288AD272F3103B6FB1428485EA3014C0BCFE',
          },
        ],
      },
    });
  });

  it('is frozen all the way down, so no code can add or edit an entry at run time', () => {
    const unfrozen: string[] = [];
    const walk = (value: unknown, where: string) => {
      if (typeof value !== 'object' || value === null) return;
      if (!Object.isFrozen(value)) unfrozen.push(where);
      for (const [key, child] of Object.entries(value)) walk(child, `${where}.${key}`);
    };
    walk(CLI_COMPATIBILITY_POLICY, 'policy');
    expect(unfrozen).toEqual([]);
    expect(() => { (CLI_COMPATIBILITY_POLICY.entries as PolicyEntry[]).push(codexEntry()); }).toThrow();
  });

  it('imports nothing: no fs, no fetch, no vscode, no module at all', () => {
    const source = readFileSync(join(__dirname, '..', 'cliCompatibilityPolicy.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\bfetch\b/);
    expect(source).not.toMatch(/['"](?:node:)?fs(?:\/promises)?['"]/);
    expect(source).not.toMatch(/['"]vscode['"]/);
  });

  it('keeps the Codex version floor equal to the Codex backend\'s', () => {
    expect(CODEX_POLICY_VERSION_FLOOR).toBe(CODEX_MINIMUM_VERSION);
  });

  it('requires the release-time canaries per provider, with no Claude-managed variant', () => {
    const both = ['deny-approval-no-write', 'outside-root-write-refused', 'revoke-mid-session', 'shutdown-tree-stops', 'child-process-stop', 'native-tool-gate-coverage', 'side-effect-inventory'];
    expect([...CLI_REQUIRED_CANARIES['codex-cli']].sort()).toEqual([...both, 'sandbox-network-denied', 'effective-config-wins', 'no-self-update-side-effects'].sort());
    expect([...CLI_REQUIRED_CANARIES['claude-cli']].sort()).toEqual([...both, 'subagent-inherits-gate', 'settings-gate-loaded'].sort());
  });
});

describe('policy loading (a failing policy disables qualification)', () => {
  it('accepts the valid fixture and returns a frozen copy that later edits of the input cannot reach', () => {
    const input = validPolicy();
    const result = loadCliCompatibilityPolicy(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy).not.toBe(input);
    expect(Object.isFrozen(result.policy.entries[0].managed!.layout.files[0])).toBe(true);
    input.entries[0].managed!.layout.files[1].sha256 = sha('replaced');
    expect(qualifyCliClosure(result.policy, codexClosure(), HOST).verdict).toBe('qualified');
  });

  it('returns the problems and no policy when a check fails', () => {
    const input = validPolicy();
    input.entries[0].managed!.artifact.kind = 'zip' as 'tar.gz';
    const result = loadCliCompatibilityPolicy(input);
    expect(result).toEqual({ ok: false, problems: [expect.stringMatching(/^invariant 3:/)] });
  });

  it('refuses to qualify against a policy that loading did not accept, even a valid one', () => {
    const unchecked = validPolicy() as ValidatedCliCompatibilityPolicy;
    expect(() => qualifyCliClosure(unchecked, codexClosure(), HOST)).toThrow(/passed its checks/);
  });

  it('refuses data that is not plain (it cannot be copied before the check)', () => {
    const input = { ...validPolicy(), hook: () => undefined };
    expect(loadCliCompatibilityPolicy(input)).toEqual({ ok: false, problems: ['schema: the policy is not plain data.'] });
  });
});

describe('validator: schema', () => {
  it('accepts the fixture with no problem', () => {
    expect(validateCliCompatibilityPolicy(validPolicy())).toEqual([]);
  });

  it('refuses a removed field of an older schema, an unknown entry field and a wrong schema name', () => {
    expect(problemsAfter((policy) => { (policy as unknown as Record<string, unknown>).codexUnsignedComponentRule = 'blocked'; }))
      .toEqual(['schema: the policy has the unknown field "codexUnsignedComponentRule".']);
    expect(problemsAfter((policy) => { (policy.entries[0] as unknown as Record<string, unknown>).provenance = {}; }))
      .toEqual([expect.stringMatching(/^schema: .*unknown field "provenance"/)]);
    expect(problemsAfter((policy) => { (policy as unknown as Record<string, unknown>).schema = 'unodeai.cli-compatibility/2'; }))
      .toEqual(['schema: `schema` is not "unodeai.cli-compatibility/1".']);
  });

  it('refuses an entry listed twice, a malformed digest and an entrypoint that is not a listed file', () => {
    expect(problemsAfter(() => undefined, [codexEntry(), codexEntry()])).toEqual([expect.stringMatching(/^schema: .*listed twice/)]);
    expect(problemsAfter((policy) => { policy.entries[0].managed!.layout.files[1].sha256 = 'ABC'; }))
      .toEqual([expect.stringMatching(/^schema: .*SHA-256 that is not lower-case hex/)]);
    expect(problemsAfter((policy) => { policy.entries[0].managed!.layout.entrypoint = 'bin/other.exe'; }))
      .toEqual([expect.stringMatching(/^schema: .*entrypoint that is not one of its files/)]);
  });

  it('refuses a qualified Codex version below the floor or a prerelease, and allows a bad one', () => {
    expect(problemsAfter(() => undefined, [codexEntry({ version: '0.154.9' })])).toEqual([expect.stringMatching(/^schema: .*below 0\.155\.0/)]);
    expect(problemsAfter(() => undefined, [codexEntry({ version: '0.163.0-alpha.1' })])).toEqual([expect.stringMatching(/^schema: .*below 0\.155\.0/)]);
    expect(problemsAfter(() => undefined, [codexEntry({ version: '0.154.9', status: 'bad', statusReason: 'refused writes' })])).toEqual([]);
  });
});

describe('validator: invariant 1 (the evidence a status needs)', () => {
  for (const provider of ['codex-cli', 'claude-cli'] as const) {
    for (const id of CLI_REQUIRED_CANARIES[provider]) {
      it(`refuses a qualified ${provider} entry without a passed "${id}" canary`, () => {
        const problems = problemsAfter((policy) => {
          const entry = policy.entries.find((candidate) => candidate.provider === provider)!;
          entry.canaries = entry.canaries.filter((canary) => canary.id !== id);
        });
        expectOnlyInvariant(problems, 1);
        expect(problems).toEqual([expect.stringContaining(`"${id}"`)]);
      });
    }
  }

  it('refuses a bad or revoked entry without a statusReason, and accepts one with it', () => {
    expectOnlyInvariant(problemsAfter(() => undefined, [codexEntry({ status: 'bad' })]), 1);
    expectOnlyInvariant(problemsAfter(() => undefined, [claudeEntry({ status: 'revoked', statusReason: '  ' })]), 1);
    expect(problemsAfter(() => undefined, [codexEntry({ status: 'bad', statusReason: 'approval bypass', canaries: [] })])).toEqual([]);
  });
});

describe('validator: invariant 2 (each provider qualifies through its own field only)', () => {
  it('refuses `external` on a codex-cli entry', () => {
    expectOnlyInvariant(problemsAfter((policy) => { policy.entries[0].external = { executableDigests: [sha('x')] }; }), 2);
  });

  it('refuses `managed` on a claude-cli entry, which is also how a Claude file marked unsigned is refused', () => {
    const problems = problemsAfter((policy) => {
      const managed = structuredClone(codexEntry().managed!);
      managed.layout.files = managed.layout.files.filter((file) => file.signer === 'unsigned' || file.path === 'bin/codex.exe');
      policy.entries[1].managed = managed;
    });
    expectOnlyInvariant(problems, 2);
  });

  it('refuses a codex-cli entry without `managed` and a claude-cli entry without `external`', () => {
    expectOnlyInvariant(problemsAfter((policy) => { delete policy.entries[0].managed; }), 2);
    expectOnlyInvariant(problemsAfter((policy) => { delete policy.entries[1].external; }), 2);
  });
});

describe('validator: invariant 3 (the artifact is a tar.gz)', () => {
  for (const kind of ['npm-tgz', 'raw-exe', 'zip']) {
    it(`refuses an artifact of kind ${kind}`, () => {
      expectOnlyInvariant(problemsAfter((policy) => { policy.entries[0].managed!.artifact.kind = kind as 'tar.gz'; }), 3);
    });
  }
});

describe('validator: invariant 4 (layout paths)', () => {
  const badPaths = [
    'bin/../codex.exe', './codex.exe', 'bin/./codex.exe', 'bin//codex.exe', '/bin/codex.exe', 'bin/codex.exe/',
    'C:/bin/codex.exe', 'bin\\codex.exe', 'bin/co dex.exe', 'bin/codex\u00e9.exe',
    'bin/CON', 'bin/con.txt', 'bin/NUL.tar.gz', 'bin/aux.json', 'bin/COM1.dll', 'bin/lpt9', 'PRN',
    'bin/codex.', 'bin/codex..',
  ];
  for (const badPath of badPaths) {
    it(`refuses the file path ${JSON.stringify(badPath)}`, () => {
      const problems = problemsAfter((policy) => {
        const layout = policy.entries[0].managed!.layout;
        layout.files.push({ path: badPath, size: 1, sha256: sha(badPath), pe: false, signer: 'none' });
        layout.unpackedBytes += 1;
      });
      expectOnlyInvariant(problems, 4);
    });
  }

  it('names the "." or ".." segment rule itself, not only the trailing-dot rule', () => {
    for (const badPath of ['bin/../codex.exe', './codex.exe']) {
      const problems = problemsAfter((policy) => {
        policy.entries[0].managed!.layout.files.push({ path: badPath, size: 0, sha256: sha(badPath), pe: false, signer: 'none' });
      });
      expect(problems).toContain(`invariant 4: entry "codex-cli/0.163.0/win32-x64/codex-package" file "${badPath}" has a "." or ".." segment.`);
    }
  });

  it('accepts names that only look reserved', () => {
    const problems = problemsAfter((policy) => {
      const layout = policy.entries[0].managed!.layout;
      for (const name of ['bin/console.txt', 'bin/COM10.dll', 'bin/nul_', 'bin/LPT0', 'bin/.hidden', 'bin/a..b']) {
        layout.files.push({ path: name, size: 0, sha256: sha(name), pe: false, signer: 'none' });
      }
    });
    expect(problems).toEqual([]);
  });

  it('refuses two paths equal without case, between files and between a file and a folder', () => {
    expectOnlyInvariant(problemsAfter((policy) => {
      policy.entries[0].managed!.layout.files.push({ path: 'BIN/Codex.EXE', size: 0, sha256: sha('dup'), pe: true, signer: 'openai' });
    }), 4);
    expectOnlyInvariant(problemsAfter((policy) => {
      policy.entries[0].managed!.layout.files.push({ path: 'Codex-Path', size: 0, sha256: sha('dup'), pe: false, signer: 'none' });
    }), 4);
  });

  it('refuses a file or folder whose parent `dirs` does not list', () => {
    expectOnlyInvariant(problemsAfter((policy) => {
      const layout = policy.entries[0].managed!.layout;
      layout.dirs = layout.dirs.filter((dir) => dir !== 'codex-resources/voice');
    }), 4);
    expectOnlyInvariant(problemsAfter((policy) => {
      policy.entries[0].managed!.layout.files.push({ path: 'extra/tool.exe', size: 0, sha256: sha('tool'), pe: true, signer: 'openai' });
    }), 4);
  });
});

describe('validator: invariant 5 (bounds)', () => {
  it('accepts an artifact of exactly 512 MiB and refuses one byte more', () => {
    expect(problemsAfter((policy) => { policy.entries[0].managed!.artifact.size = 512 * 1024 * 1024; })).toEqual([]);
    expectOnlyInvariant(problemsAfter((policy) => { policy.entries[0].managed!.artifact.size = 512 * 1024 * 1024 + 1; }), 5);
  });

  it('accepts exactly 1 GiB unpacked and refuses one byte more', () => {
    expect(problemsAfter((policy) => { policy.entries[0].managed!.layout.unpackedBytes = 1024 ** 3; })).toEqual([]);
    expectOnlyInvariant(problemsAfter((policy) => { policy.entries[0].managed!.layout.unpackedBytes = 1024 ** 3 + 1; }), 5);
  });

  it('refuses files that total more than unpackedBytes', () => {
    expectOnlyInvariant(problemsAfter((policy) => { policy.entries[0].managed!.layout.unpackedBytes = 1734; }), 5);
  });

  it('accepts exactly 20,000 entries and refuses 20,001', () => {
    const withEntries = (total: number) => (policy: CliCompatibilityPolicy) => {
      const layout = policy.entries[0].managed!.layout;
      layout.dirs.push('many');
      const existing = layout.files.length + layout.dirs.length;
      for (let index = 0; index < total - existing; index++) {
        layout.files.push({ path: `many/f${index}`, size: 0, sha256: CODEX_FILES[0].sha256, pe: false, signer: 'none' });
      }
    };
    expect(problemsAfter(withEntries(20_000))).toEqual([]);
    expectOnlyInvariant(problemsAfter(withEntries(20_001)), 5);
    expect(CLI_POLICY_LIMITS.maxEntries).toBe(20_000);
  });
});

describe('validator: invariant 6 (artifact URLs)', () => {
  const badUrls = [
    'http://releases.openai.com/codex/a.tar.gz',
    'HTTPS://github.com/openai/codex/a.tar.gz',
    'https://example.com/a.tar.gz',
    'https://releases.openai.com.evil.example/a.tar.gz',
    'https://evil.example/github.com/a.tar.gz',
    'https://user@github.com/a.tar.gz',
    'https://user:secret@github.com/a.tar.gz',
    'https://github.com:443/a.tar.gz',
    'https://github.com:8443/a.tar.gz',
    'https://140.82.112.3/a.tar.gz',
    'https://[::1]/a.tar.gz',
    'https://github.com./a.tar.gz',
    'ftp://github.com/a.tar.gz',
  ];
  for (const url of badUrls) {
    it(`refuses ${url}`, () => {
      expectOnlyInvariant(problemsAfter((policy) => { policy.entries[0].managed!.artifact.urls.push(url); }), 6);
    });
  }

  it('refuses a redirect host outside the Codex redirect hosts, even an artifact host', () => {
    expectOnlyInvariant(problemsAfter((policy) => { policy.entries[0].managed!.artifact.redirectHosts.push('objects.githubusercontent.com'); }), 6);
    expectOnlyInvariant(problemsAfter((policy) => { policy.entries[0].managed!.artifact.redirectHosts.push('RELEASE-ASSETS.githubusercontent.com'); }), 6);
  });
});

describe('validator: invariant 7 (signer tokens follow the PE flag)', () => {
  it('refuses a PE file whose signer is none or unknown', () => {
    expectOnlyInvariant(problemsAfter((policy) => { policy.entries[0].managed!.layout.files[1].signer = 'none'; }), 7);
    expectOnlyInvariant(problemsAfter((policy) => { (policy.entries[0].managed!.layout.files[1] as { signer: string }).signer = 'anthropic'; }), 7);
    expectOnlyInvariant(problemsAfter((policy) => { (policy.entries[0].managed!.layout.files[1] as { signer: string }).signer = 'unsigned-pinned'; }), 7);
  });

  it('refuses a file that is not a PE but names a signer', () => {
    expectOnlyInvariant(problemsAfter((policy) => { policy.entries[0].managed!.layout.files[0].signer = 'openai'; }), 7);
    expectOnlyInvariant(problemsAfter((policy) => { policy.entries[0].managed!.layout.files[0].signer = 'unsigned'; }), 7);
  });
});

describe('validator: invariant 8 (store paths fit 240 characters for a 64-character profile)', () => {
  it('counts the layout of the managed store', () => {
    expect(CLI_STORE_PATH_LAYOUT).toEqual({
      profileChars: 64,
      storeBelowProfile: '\\AppData\\Local\\UnodeAi\\cli-store\\instances\\',
      storeIdChars: 32,
      versionsSegment: '\\versions\\',
      stagingSegment: '\\staging\\',
      stagingTokenChars: 32,
      payloadSegment: '\\payload\\',
      keyDigestChars: 16,
    });
    expect(cliStoreVersionKey(codexEntry())).toBe(`0.163.0-win32-x64-${sha('artifact').slice(0, 16)}`);
    // The real 0.163.0 package's longest member path is 48 characters; its staging path is 237 characters.
    const real = codexEntry();
    const longestMember = 'codex-resources/voice/licenses/proxy-libintl.txt';
    expect(longestMember.length).toBe(48);
    real.managed!.layout.dirs.push('codex-resources/voice/licenses');
    real.managed!.layout.files.push({ path: longestMember, size: 0, sha256: sha(longestMember), pe: false, signer: 'none' });
    expect(validateCliCompatibilityPolicy(validPolicy([real]))).toEqual([]);
    expect(longestCliStorePathChars(real)).toBe(64 + 43 + 32 + 9 + 32 + 9 + 48);
    expect(longestCliStorePathChars(real)).toBe(237);
  });

  it('accepts a path that needs exactly 240 characters and refuses one more', () => {
    const withName = (length: number) => (policy: CliCompatibilityPolicy) => {
      const name = `bin/${'a'.repeat(length - 4)}`;
      policy.entries[0].managed!.layout.files.push({ path: name, size: 0, sha256: sha(name), pe: false, signer: 'none' });
    };
    expect(problemsAfter(withName(51))).toEqual([]);
    expectOnlyInvariant(problemsAfter(withName(52)), 8);
  });

  it('counts the version folder\'s own name, which grows with the version', () => {
    const long = codexEntry({ status: 'bad', statusReason: 'test', version: `1234.1234.123456-${'r'.repeat(40)}` });
    long.managed!.layout.files[0].path = 'codex-package.json';
    expect(cliStoreVersionKey(long).length).toBe(57 + 27);
    expectOnlyInvariant(problemsAfter(() => undefined, [long]), 8);
  });
});

describe('validator: invariant 9 (exactly the two signers, each pinned)', () => {
  it('refuses a missing signer and an extra one', () => {
    expectOnlyInvariant(problemsAfter((policy) => { delete (policy.signers as Partial<CliCompatibilityPolicy['signers']>)['microsoft-crt']; }), 9);
    expectOnlyInvariant(problemsAfter((policy) => { (policy.signers as Record<string, unknown>).anthropic = structuredClone(policy.signers.openai); }), 9);
  });

  it('refuses a signer with no accepted signature, no subject RDNs, or a root that is not 40 hex digits', () => {
    expectOnlyInvariant(problemsAfter((policy) => { policy.signers.openai.accepted = []; }), 9);
    expectOnlyInvariant(problemsAfter((policy) => { policy.signers.openai.accepted[0].subjectRdns = []; }), 9);
    expectOnlyInvariant(problemsAfter((policy) => { policy.signers['microsoft-crt'].accepted[1].rootThumbprint = 'F40042E2E5F7E8EF8189FED15519AECE42C3BFA'; }), 9);
    expectOnlyInvariant(problemsAfter((policy) => { policy.signers.openai.accepted[0].rootThumbprint = 'G40042E2E5F7E8EF8189FED15519AECE42C3BFA2'; }), 9);
  });
});

describe('qualification (P6 §3.3)', () => {
  const policy = loaded(validPolicy());

  it('qualifies a Codex package whose listing equals the entry, and takes the version from the entry', () => {
    const files = codexClosure().files.slice().reverse();
    expect(qualifyCliClosure(policy, codexClosure([...files]), HOST)).toEqual({
      verdict: 'qualified',
      entry: policy.entries[0],
      version: '0.163.0',
      compatibilityPolicyId: '0.9.97-test#codex-cli/0.163.0/win32-x64/codex-package',
    });
  });

  it('does not qualify an extra, missing, resized or changed file', () => {
    const base = codexClosure().files;
    const extra = [...base, { path: 'bin/version.dll', size: 10, sha256: sha('planted') }];
    const missing = base.filter((file) => file.path !== 'codex-path/rg.exe');
    const resized = base.map((file) => (file.path === 'codex-path/rg.exe' ? { ...file, size: file.size + 1 } : file));
    const changed = base.map((file) => (file.path === 'codex-path/rg.exe' ? { ...file, sha256: sha('other rg.exe') } : file));
    for (const files of [extra, missing, resized, changed]) {
      expect(qualifyCliClosure(policy, codexClosure(files), HOST)).toEqual({ verdict: 'needs-adoption', hostHasEntries: true });
    }
  });

  it('compares paths without case on Windows only', () => {
    const upper = codexClosure().files.map((file) => ({ ...file, path: file.path.toUpperCase() }));
    expect(qualifyCliClosure(policy, codexClosure(upper, { executablePath: 'BIN/CODEX.EXE' }), HOST).verdict).toBe('qualified');
    // The entries are for Windows; another host never qualifies them, and the dialog says why.
    expect(qualifyCliClosure(policy, codexClosure(), { os: 'linux', arch: 'x64' })).toEqual({ verdict: 'needs-adoption', hostHasEntries: false });
    expect(qualifyCliClosure(policy, codexClosure(), { os: 'win32', arch: 'arm64' })).toEqual({ verdict: 'needs-adoption', hostHasEntries: false });
  });

  it('does not qualify a package started through another of its programs', () => {
    expect(qualifyCliClosure(policy, codexClosure(undefined, { executablePath: 'codex-path/rg.exe' }), HOST).verdict).toBe('needs-adoption');
  });

  it('never qualifies an unbounded closure, even one whose listing equals a qualified entry', () => {
    const single = codexEntry({ id: 'codex-cli/single' });
    single.managed!.layout = { entrypoint: 'codex.exe', unpackedBytes: 1000, dirs: [], ignoredEntries: [], files: [{ path: 'codex.exe', size: 1000, sha256: sha('codex.exe'), pe: true, signer: 'openai' }] };
    const onePolicy = loaded(validPolicy([single]));
    const files = [{ path: 'codex.exe', size: 1000, sha256: sha('codex.exe') }];
    expect(qualifyCliClosure(onePolicy, codexClosure(files, { executablePath: 'codex.exe' }), HOST).verdict).toBe('qualified');
    expect(qualifyCliClosure(onePolicy, codexClosure(files, { kind: 'unbounded', executablePath: 'codex.exe' }), HOST))
      .toEqual({ verdict: 'needs-adoption', hostHasEntries: true });
  });

  it('blocks a bad or revoked Codex package by its listing, before any qualified entry is considered', () => {
    const bad = codexEntry({ id: 'codex-cli/0.163.0/bad', status: 'bad', statusReason: 'approval bypass' });
    const blocking = loaded(validPolicy([codexEntry(), bad]));
    expect(qualifyCliClosure(blocking, codexClosure(), HOST)).toEqual({
      verdict: 'blocked-bad', entry: blocking.entries[1], reason: 'approval bypass', compatibilityPolicyId: '0.9.97-test#codex-cli/0.163.0/bad',
    });
    const revoked = loaded(validPolicy([codexEntry({ status: 'revoked', statusReason: 'withdrawn' })]));
    expect(qualifyCliClosure(revoked, codexClosure(), HOST)).toMatchObject({ verdict: 'blocked-bad', reason: 'withdrawn' });
  });

  it('blocks any closure whose program is a bad entry\'s entrypoint, an unbounded one on any host included', () => {
    const bad = loaded(validPolicy([codexEntry({ status: 'bad', statusReason: 'approval bypass' })]));
    const program = [{ path: 'codex.exe', size: 1000, sha256: sha('codex.exe') }];
    expect(qualifyCliClosure(bad, codexClosure(program, { kind: 'unbounded', executablePath: 'codex.exe' }), { os: 'linux', arch: 'arm64' }))
      .toMatchObject({ verdict: 'blocked-bad', reason: 'approval bypass' });
  });

  it('qualifies a Claude single file by its SHA-256, never a launcher pair', () => {
    const claude = (kind: QualifiableCliClosure['kind'], files: CliClosureFile[]): QualifiableCliClosure => ({ provider: 'claude-cli', kind, files, executablePath: files[0].path });
    const program = { path: 'claude.exe', size: 290_000_000, sha256: sha('claude.exe 2.1.304') };
    expect(qualifyCliClosure(policy, claude('single-file', [program]), HOST)).toMatchObject({ verdict: 'qualified', version: '2.1.304' });
    expect(qualifyCliClosure(policy, claude('single-file', [{ ...program, sha256: sha('claude.exe 2.1.305') }]), HOST))
      .toEqual({ verdict: 'needs-adoption', hostHasEntries: true });
    const pair = claude('launcher-pair', [{ path: 'claude.cmd', size: 300, sha256: sha('claude.cmd') }, { ...program, path: 'node_modules/@anthropic-ai/claude-code/bin/claude.exe' }]);
    expect(qualifyCliClosure(policy, pair, HOST)).toEqual({ verdict: 'needs-adoption', hostHasEntries: true });
    // Whatever its bytes: even a launcher whose own digest a qualified entry lists does not qualify the pair.
    const listedLauncher = claude('launcher-pair', [{ path: 'claude.cmd', size: 300, sha256: sha('claude.exe 2.1.304') }, { ...program, path: 'node_modules/@anthropic-ai/claude-code/bin/claude.exe' }]);
    expect(qualifyCliClosure(policy, listedLauncher, HOST)).toEqual({ verdict: 'needs-adoption', hostHasEntries: true });
  });

  it('blocks a bad Claude version, also behind npm\'s launcher', () => {
    const bad = loaded(validPolicy([claudeEntry({ status: 'bad', statusReason: 'settings gate ignored' })]));
    const program = { path: 'claude.exe', size: 290_000_000, sha256: sha('claude.exe 2.1.304') };
    expect(qualifyCliClosure(bad, { provider: 'claude-cli', kind: 'single-file', files: [program], executablePath: 'claude.exe' }, HOST))
      .toMatchObject({ verdict: 'blocked-bad', reason: 'settings gate ignored' });
    const pair: QualifiableCliClosure = {
      provider: 'claude-cli', kind: 'launcher-pair', executablePath: 'claude.cmd',
      files: [{ path: 'claude.cmd', size: 300, sha256: sha('claude.cmd') }, { ...program, path: 'node_modules/@anthropic-ai/claude-code/bin/claude.exe' }],
    };
    expect(qualifyCliClosure(bad, pair, HOST)).toMatchObject({ verdict: 'blocked-bad' });
  });

  it('does not compare one provider\'s closure with another provider\'s entries', () => {
    const program = { path: 'codex.exe', size: 290_000_000, sha256: sha('claude.exe 2.1.304') };
    expect(qualifyCliClosure(policy, { provider: 'codex-cli', kind: 'unbounded', files: [program], executablePath: 'codex.exe' }, HOST).verdict).toBe('needs-adoption');
  });

  it('says whether this provider has any entry on this host, for the "Windows x64 only" sentence', () => {
    const empty = loaded(validPolicy([]));
    expect(qualifyCliClosure(empty, codexClosure(), HOST)).toEqual({ verdict: 'needs-adoption', hostHasEntries: false });
    const claudeOnly = loaded(validPolicy([claudeEntry()]));
    expect(qualifyCliClosure(claudeOnly, codexClosure(), HOST)).toEqual({ verdict: 'needs-adoption', hostHasEntries: false });
  });

  it('refuses a closure whose listing does not contain its own program', () => {
    expect(() => qualifyCliClosure(policy, codexClosure(undefined, { executablePath: 'bin/missing.exe' }), HOST)).toThrow(/does not contain/);
  });
});
