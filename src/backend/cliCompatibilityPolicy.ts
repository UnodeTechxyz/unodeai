/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the bundled CLI compatibility policy (v0.9.97)
 *  Which exact Claude and Codex CLI files this UnodeAi release qualified or marked bad, and which publishers sign
 *  them. The data is compiled into the extension and changes only with an extension update: no setting, command,
 *  file, workspace or network source can add, edit or override an entry. This module therefore imports nothing at
 *  all, and a test reads its source to keep it that way.
 *
 *  A policy that fails its checks disables qualification: `loadCliCompatibilityPolicy` returns the problems instead
 *  of a policy, and `qualifyCliClosure` answers only for a policy that loading accepted.
 *--------------------------------------------------------------------------------------------*/

/** The policy as it is compiled into the extension. Entries are added at release time only. */
export interface CliCompatibilityPolicy {
  schema: 'unodeai.cli-compatibility/1';
  policyVersion: string;
  signers: Record<'openai' | 'microsoft-crt', {
    accepted: Array<{ signatureType: 'Authenticode' | 'Catalog'; subjectRdns: Array<[oid: string, value: string]>; rootThumbprint: string }>;
  }>;
  entries: PolicyEntry[];
}

/** One exact CLI version on one platform, with the evidence a release recorded for it. */
export interface PolicyEntry {
  id: string; provider: 'claude-cli' | 'codex-cli'; version: string; versionOutput: string;
  os: 'win32'; arch: 'x64'; status: 'qualified' | 'bad' | 'revoked'; statusReason?: string;
  external?: { executableDigests: string[] };            // claude-cli only
  managed?: {                                             // codex-cli only
    artifact: { kind: 'tar.gz'; name: string; size: number; sha256: string; urls: string[]; redirectHosts: string[] };
    layout: { entrypoint: string; unpackedBytes: number; dirs: string[]; ignoredEntries: string[];
              files: Array<{ path: string; size: number; sha256: string; pe: boolean; signer: 'openai' | 'microsoft-crt' | 'unsigned' | 'none' }> };
  };
  gates: Record<string, true>;
  canaries: Array<{ id: string; result: 'pass'; evidenceRef: string; ranAt: string; model: string }>;
  selfUpdateReview: { sourceRef: string; finding: string };
  qualifiedAt: string; qualificationRecord: string; leafThumbprints: string[];
}

export type CliPolicyProvider = PolicyEntry['provider'];
export type CliSignerId = keyof CliCompatibilityPolicy['signers'];
/** One accepted signature of a publisher: its type, its subject RDNs in DER order, and the pinned root. */
export type CliSignerRule = CliCompatibilityPolicy['signers'][CliSignerId]['accepted'][number];
export type PolicyLayout = NonNullable<PolicyEntry['managed']>['layout'];
export type PolicyLayoutFile = PolicyLayout['files'][number];
/** The signer token of one file: a publisher, a PE that must carry no signature, or a file that is not a PE. */
export type CliFileSigner = PolicyLayoutFile['signer'];

/** How far a launch's files are known: a whole package, one file, a launcher and its program, or the program only. */
export type CliClosureKind = 'package' | 'single-file' | 'launcher-pair' | 'unbounded';

/** One line of a closure listing: a relative path with `/` separators, the byte count and the SHA-256 in hex. */
export interface CliClosureFile {
  path: string;
  size: number;
  sha256: string;
}

/** What qualification needs to know about a hashed closure. */
export interface QualifiableCliClosure {
  provider: CliPolicyProvider;
  kind: CliClosureKind;
  /** The listing, each file once. */
  files: readonly CliClosureFile[];
  /** The listing path of the program that is started. */
  executablePath: string;
}

export type CliQualification =
  /** These exact bytes were qualified; the version is the entry's, never one read from the program. */
  | { verdict: 'qualified'; entry: PolicyEntry; version: string; compatibilityPolicyId: string }
  /** These bytes belong to a version a release marked bad or revoked. No consent can override it. */
  | { verdict: 'blocked-bad'; entry: PolicyEntry; reason: string; compatibilityPolicyId: string }
  /**
   * Nothing qualifies or blocks these bytes. `hostHasEntries` says whether the policy has any entry for this
   * provider on this OS and architecture; without one, every version there needs consent.
   */
  | { verdict: 'needs-adoption'; hostHasEntries: boolean };

/** The bounds every entry is held to. */
export const CLI_POLICY_LIMITS = Object.freeze({
  maxArtifactBytes: 512 * 1024 * 1024,
  maxUnpackedBytes: 1024 * 1024 * 1024,
  maxEntries: 20_000,
  maxStorePathChars: 240,
});

/** The hosts a Codex artifact URL may name, and the hosts a download may be redirected to. */
export const CODEX_ARTIFACT_HOSTS: readonly string[] = Object.freeze(['releases.openai.com', 'github.com']);
export const CODEX_REDIRECT_HOSTS: readonly string[] = Object.freeze(['release-assets.githubusercontent.com']);

/** The lowest Codex CLI release UnodeAi starts; the same floor as the Codex backend's version check. */
export const CODEX_POLICY_VERSION_FLOOR = '0.155.0';

const CANARIES_FOR_BOTH = [
  'deny-approval-no-write',
  'outside-root-write-refused',
  'revoke-mid-session',
  'shutdown-tree-stops',
  'child-process-stop',
  'native-tool-gate-coverage',
  'side-effect-inventory',
] as const;

/**
 * The release-time canaries a `qualified` entry must record as passed, per provider. `sandbox-network-denied` proves
 * that a sandboxed command cannot connect directly to another machine, against a control run outside the sandbox; it
 * does not cover connections to this computer, which Codex's Windows sandbox does not block (measured on 0.163.0).
 */
export const CLI_REQUIRED_CANARIES: Readonly<Record<CliPolicyProvider, readonly string[]>> = Object.freeze({
  'claude-cli': Object.freeze([...CANARIES_FOR_BOTH, 'subagent-inherits-gate', 'settings-gate-loaded']),
  'codex-cli': Object.freeze([...CANARIES_FOR_BOTH, 'sandbox-network-denied', 'effective-config-wins', 'no-self-update-side-effects']),
});

/**
 * The managed store's layout, as far as path lengths go: a 64-character user profile, the store folder, an instance
 * named by its 32-hex-digit store id, and below it a version folder or a staging payload named by a 32-hex-digit
 * token. A version folder is named `<version>-<os>-<arch>-<first 16 hex digits of the artifact SHA-256>`. The
 * separators are counted as `\`.
 */
export const CLI_STORE_PATH_LAYOUT = Object.freeze({
  profileChars: 64,
  storeBelowProfile: '\\AppData\\Local\\UnodeAi\\cli-store\\instances\\',
  storeIdChars: 32,
  versionsSegment: '\\versions\\',
  stagingSegment: '\\staging\\',
  stagingTokenChars: 32,
  payloadSegment: '\\payload\\',
  keyDigestChars: 16,
});

/**
 * v0.9.97 (O4): the latest Codex and Claude releases, qualified from verified downloads and the release canaries run
 * on 2026-10-21. The evidence each canary names is kept with the release record, not in the package.
 */
const QUALIFIED_ENTRIES: PolicyEntry[] = [
  {
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
        size: 162230206,
        sha256: '901028b285614a9974f431f9d9f6534b3e5ed8d62eba4ba64f4762c00f040522',
        urls: [
          'https://releases.openai.com/codex/releases/0.163.0/codex-package-x86_64-pc-windows-msvc.tar.gz',
          'https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-package-x86_64-pc-windows-msvc.tar.gz'
        ],
        redirectHosts: [
          'release-assets.githubusercontent.com'
        ]
      },
      layout: {
        entrypoint: 'bin/codex.exe',
        unpackedBytes: 465689987,
        dirs: [
          'bin',
          'codex-path',
          'codex-resources',
          'codex-resources/voice',
          'codex-resources/voice/bin',
          'codex-resources/voice/licenses'
        ],
        ignoredEntries: [],
        files: [
          {
            path: 'bin/codex-code-mode-host.exe',
            size: 74921264,
            sha256: '07f3869f0849cd54b31cec1f86ec796f004501bd3a215135c1facc883a2b9988',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'bin/codex.exe',
            size: 341270320,
            sha256: '2692c8c7bb2cf8b0aefe638741fc90236f4b824c59578ce84994f9de58200993',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-package.json',
            size: 215,
            sha256: 'b7c94833fe9d6b9cf82fdcc202f81f5a84a1f5edb987834daa2ac0e5ef886e7b',
            pe: false,
            signer: 'none'
          },
          {
            path: 'codex-path/rg.exe',
            size: 4218880,
            sha256: '14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680',
            pe: true,
            signer: 'unsigned'
          },
          {
            path: 'codex-resources/codex-command-runner.exe',
            size: 8217904,
            sha256: 'fc89dc66c806f25675b9be1e7dafb226807d22761e9741a3bb24b667b803d46c',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/codex-windows-sandbox-setup.exe',
            size: 17700144,
            sha256: '2efc67f77de2658667c1481e00a1c4c964d3e8f6d4f39b638620d80b9d0f6d8a',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/NOTICE.md',
            size: 2439,
            sha256: '473fcf8ccb68ce726111d016d133f0555adba730d057591512f3f71fb46aeb6e',
            pe: false,
            signer: 'none'
          },
          {
            path: 'codex-resources/voice/bin/codex-voice-host.exe',
            size: 9031984,
            sha256: '26d1d04ed865dfb630a0a3b8d826f7e85d5b3d4c3de86efeaf5d02c2dd57c680',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gio-2.0-0.dll',
            size: 1695536,
            sha256: 'b6215557039e2d7d7a3493bed69918f2d2183c904e4d09fcf951524c80c41c1b',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/glib-2.0-0.dll',
            size: 1390896,
            sha256: '5c5b36add8c6bf48c269600abac05708aded2199237e854a08d376ef78f0c155',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gmodule-2.0-0.dll',
            size: 34608,
            sha256: '6e3baaf4668ca9de545bcc0cf9ae0c1b888470395e62018563540837480bfb61',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gobject-2.0-0.dll',
            size: 348464,
            sha256: '8554a5fc3fa575c67376b4baa765df0f1418aec37110231ac1cf101856d5d03b',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstapp-1.0-0.dll',
            size: 100144,
            sha256: '8573cd7e1e799d66573b6a25a62e5cd414b4e54f30351375d653b5f9778c8707',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstapp.dll',
            size: 25392,
            sha256: '9faed7dcf58ceba37afd82d30a39477b04263012114feeb0053e1b3bc40dbb05',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstaudio-1.0-0.dll',
            size: 512304,
            sha256: '9711731d80f7b41f1e1dda15d38d87672676c4b261279c9a6fdfa4f11a8bc791',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstaudioconvert.dll',
            size: 48432,
            sha256: '6693874a764125fb725e298b6c9e9e1610528ecca46d949fed2575ca2861c1e8',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstaudioresample.dll',
            size: 45360,
            sha256: '61c02606fedd20fbf74ebfa775a7358e04d7c1b01f361cbd51ee5dd683f5e6b2',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstbase-1.0-0.dll',
            size: 484144,
            sha256: '347bc9c3b8701dfffd62360a22aa62e86c82cfb1709d98bf89536d7cf2abde75',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstcoreelements.dll',
            size: 409904,
            sha256: '59790c9ab1d4c15aac484b054dbb57f8e3e456ec7e3447394f518322830cbdc3',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstnet-1.0-0.dll',
            size: 116528,
            sha256: '57251f8b01769d90b6e95f314fa237312e0a1d0befdbb527d6187af425e3fe42',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstopus.dll',
            size: 69424,
            sha256: 'f0def131359e66e761f5055d76cca25f4a8b0d28992e9318848654853167f117',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstpbutils-1.0-0.dll',
            size: 262448,
            sha256: '2feac8e3a921c7f7b313e2ab53fd578730e384ecd22ae58c2867b8630afde1d1',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstreamer-1.0-0.dll',
            size: 1257264,
            sha256: '762f19dc5d944f78d68c818aa781fbca6dbb33a51c79714fa0e3552c94d2ae42',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstrtp-1.0-0.dll',
            size: 167216,
            sha256: '35a53fcab003c74d1ac4539a1e5c218f883d8fce07ad630529faa131ba0d5ed8',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstrtp.dll',
            size: 607536,
            sha256: '0c9609cea6e80b0d10fbcb9f1223acaefc07448ff767c0482e03691c005838ea',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstrtpmanager.dll',
            size: 501040,
            sha256: 'e3e05718f906bb05ef2f02edb8dd860c2e4d36bb082497917bd5441b62652489',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gsttag-1.0-0.dll',
            size: 254256,
            sha256: '8971e047a4c4c38502f244c5944cea52e4c492fa3820b234a45cea7943b73319',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/gstvideo-1.0-0.dll',
            size: 769840,
            sha256: '85beadd972b009378b8103342573d63ad75a2110c7472be6c1126b16602ece47',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/intl-8.dll',
            size: 25392,
            sha256: '13b15da1c27da598b6d9a90cfc9177570bc42c705df64f466cc5b66eb5e9adaf',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/libffi-8.dll',
            size: 43312,
            sha256: '10e5dd36e5b6de06468f829ad15646548f1c76288d5ae87e5154f9182b652bc5',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/opus.dll',
            size: 440112,
            sha256: 'e3a5ed77837e9f17fbf2bde015d23b35b2dd0d49401d506990e660f2ed7106c0',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/pcre2-8.dll',
            size: 398128,
            sha256: '21371ba32ec71d33098fe40210e15c1f631b7fcc6bddd0c4f6abc2bd38d55603',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/bin/vcruntime140.dll',
            size: 123472,
            sha256: '184146852727a9db4eea06178716bec3cdbb1015c911f6b0f915b184ad7775b2',
            pe: true,
            signer: 'microsoft-crt'
          },
          {
            path: 'codex-resources/voice/bin/z.dll',
            size: 105264,
            sha256: '7828cdf60f48555c67878e5cb8e2048605336ad3ded22e7e60ab4ccc876bcd4b',
            pe: true,
            signer: 'openai'
          },
          {
            path: 'codex-resources/voice/licenses/LGPL-2.1.txt',
            size: 26934,
            sha256: 'c7ce1276717604c29c5469179a2f368eac42846557be671bb52f4e16e884b2ad',
            pe: false,
            signer: 'none'
          },
          {
            path: 'codex-resources/voice/licenses/Opus.txt',
            size: 1989,
            sha256: 'cbd8bd07329a234413710c02b19d22c0cf78fc451882593e817130779b5455e3',
            pe: false,
            signer: 'none'
          },
          {
            path: 'codex-resources/voice/licenses/PCRE2.md',
            size: 4115,
            sha256: '4195c519dcfe4a4ffedc4b8ccc5d49e4dd02efd5ece6b69a4fba5d20080902a9',
            pe: false,
            signer: 'none'
          },
          {
            path: 'codex-resources/voice/licenses/libffi.txt',
            size: 1153,
            sha256: 'e2a9b884b1c5d718efd6121457a1fbe7ece431352ca75c901260cef2e7d040e5',
            pe: false,
            signer: 'none'
          },
          {
            path: 'codex-resources/voice/licenses/proxy-libintl.txt',
            size: 25774,
            sha256: 'aa092600e3f475f0a55821fb9c529583d8e23e41bf0461254f02fcf94d3a32c2',
            pe: false,
            signer: 'none'
          },
          {
            path: 'codex-resources/voice/licenses/sljit.txt',
            size: 1469,
            sha256: '37c7a090fc61388430d63fc97bf8a22ffce92d3ca2249aac572cfaf411d3070f',
            pe: false,
            signer: 'none'
          },
          {
            path: 'codex-resources/voice/licenses/zlib.txt',
            size: 1024,
            sha256: '439c75ab12b340c5362b9d4b08ff05ec3a4d0eb7667a6fff49a9b16d8795c78e',
            pe: false,
            signer: 'none'
          },
          {
            path: 'codex-resources/voice/manifest.json',
            size: 4773,
            sha256: 'a14fdc65cffe82e565f9e5a44ef940fe333ebd8604fcbdbf4408f2352cd76cc5',
            pe: false,
            signer: 'none'
          },
          {
            path: 'codex-resources/voice/runtime.json',
            size: 16894,
            sha256: '78e4011ff38c6d7001c59a13614f642544e0fe42f149f831a0ea6f13d848a7cb',
            pe: false,
            signer: 'none'
          },
          {
            path: 'codex-resources/voice/sources.json',
            size: 4911,
            sha256: 'e2f6b124f6277e7c3c4f5c7cc8830c66190f671ad65e972bb2cc9507dbfcb937',
            pe: false,
            signer: 'none'
          },
          {
            path: 'codex-resources/voice/windows-crt.json',
            size: 1385,
            sha256: 'd16939bc85da395ded5411724fed84ffd36810b78d47c756cf094b0956bc3892',
            pe: false,
            signer: 'none'
          }
        ]
      }
    },
    gates: {
      escalationApproval: true,
      fileChangeApproval: true,
      sandboxNetworkDenied: true,
      hostConfigWins: true
    },
    canaries: [
      {
        id: 'deny-approval-no-write',
        result: 'pass',
        evidenceRef: 'o4/canaries/codex/evidence/deny-approval-no-write.json',
        ranAt: '2026-10-21T08:52:26.883Z',
        model: 'gpt-6-luna'
      },
      {
        id: 'outside-root-write-refused',
        result: 'pass',
        evidenceRef: 'o4/canaries/codex/evidence/outside-root-write-refused.json',
        ranAt: '2026-10-21T08:27:55.551Z',
        model: 'gpt-6-luna'
      },
      {
        id: 'revoke-mid-session',
        result: 'pass',
        evidenceRef: 'o4/canaries/codex/evidence/revoke-mid-session.json',
        ranAt: '2026-10-21T09:59:47.680Z',
        model: 'gpt-6-luna'
      },
      {
        id: 'shutdown-tree-stops',
        result: 'pass',
        evidenceRef: 'o4/canaries/codex/evidence/shutdown-tree-stops.json',
        ranAt: '2026-10-21T08:30:38.366Z',
        model: 'gpt-6-luna'
      },
      {
        id: 'child-process-stop',
        result: 'pass',
        evidenceRef: 'o4/canaries/codex/evidence/child-process-stop.json',
        ranAt: '2026-10-21T08:30:12.629Z',
        model: 'gpt-6-luna'
      },
      {
        id: 'native-tool-gate-coverage',
        result: 'pass',
        evidenceRef: 'o4/canaries/codex/evidence/native-tool-gate-coverage.json',
        ranAt: '2026-10-21T08:54:14.513Z',
        model: 'gpt-6-luna'
      },
      {
        id: 'side-effect-inventory',
        result: 'pass',
        evidenceRef: 'o4/canaries/codex/evidence/side-effect-inventory.json',
        ranAt: '2026-10-21T08:36:02.817Z',
        model: 'gpt-6-luna'
      },
      {
        id: 'sandbox-network-denied',
        result: 'pass',
        evidenceRef: 'o4/canaries/codex/evidence/sandbox-network-denied.json',
        ranAt: '2026-10-21T09:48:10.417Z',
        model: 'gpt-6-luna'
      },
      {
        id: 'effective-config-wins',
        result: 'pass',
        evidenceRef: 'o4/canaries/codex/evidence/effective-config-wins.json',
        ranAt: '2026-10-21T08:22:20.782Z',
        model: 'none (no model message)'
      },
      {
        id: 'no-self-update-side-effects',
        result: 'pass',
        evidenceRef: 'o4/canaries/codex/evidence/no-self-update-side-effects.json',
        ranAt: '2026-10-21T08:34:47.274Z',
        model: 'gpt-6-luna'
      }
    ],
    selfUpdateReview: {
      sourceRef: 'github.com/openai/codex tag rust-v0.163.0',
      finding: 'app-server --stdio runs no updater; updates live in app-server daemon and the interactive program, which UnodeAi never starts and whose subcommands the argv guard refuses'
    },
    qualifiedAt: '2026-10-21',
    qualificationRecord: 'UnodeAi v0.9.97 O4 qualification, 2026-10-21',
    leafThumbprints: [
      '4E06E67B9ED204E60B4370C084D4C36E3532BA8E',
      'BAC13DF18B37E808208A39D3A54CCE975FAC8C1D'
    ]
  },
  {
    id: 'claude-cli/2.1.306/win32-x64/native',
    provider: 'claude-cli',
    version: '2.1.306',
    versionOutput: '2.1.306 (Claude Code)',
    os: 'win32',
    arch: 'x64',
    status: 'qualified',
    external: {
      executableDigests: [
        'f6bc9de38f507c36c9a3bb0085a59a27e32156e2208252bf1707c4e3ef309114'
      ]
    },
    gates: {
      preToolUseGate: true,
      settingsHookLoaded: true,
      subagentGate: true
    },
    canaries: [
      {
        id: 'deny-approval-no-write',
        result: 'pass',
        evidenceRef: 'o4/canaries/claude/evidence/deny-approval-no-write.json',
        ranAt: '2026-10-21T08:21:27.575Z',
        model: 'claude-haiku-5-5'
      },
      {
        id: 'outside-root-write-refused',
        result: 'pass',
        evidenceRef: 'o4/canaries/claude/evidence/outside-root-write-refused.json',
        ranAt: '2026-10-21T08:21:37.589Z',
        model: 'claude-haiku-5-5'
      },
      {
        id: 'revoke-mid-session',
        result: 'pass',
        evidenceRef: 'o4/canaries/claude/evidence/revoke-mid-session.json',
        ranAt: '2026-10-21T08:22:08.803Z',
        model: 'claude-haiku-5-5'
      },
      {
        id: 'shutdown-tree-stops',
        result: 'pass',
        evidenceRef: 'o4/canaries/claude/evidence/shutdown-tree-stops.json',
        ranAt: '2026-10-21T08:27:45.966Z',
        model: 'claude-haiku-5-5'
      },
      {
        id: 'child-process-stop',
        result: 'pass',
        evidenceRef: 'o4/canaries/claude/evidence/child-process-stop.json',
        ranAt: '2026-10-21T08:22:32.597Z',
        model: 'claude-haiku-5-5'
      },
      {
        id: 'native-tool-gate-coverage',
        result: 'pass',
        evidenceRef: 'o4/canaries/claude/evidence/native-tool-gate-coverage.json',
        ranAt: '2026-10-21T08:28:04.377Z',
        model: 'claude-haiku-5-5'
      },
      {
        id: 'side-effect-inventory',
        result: 'pass',
        evidenceRef: 'o4/canaries/claude/evidence/side-effect-inventory.json',
        ranAt: '2026-10-21T08:29:44.617Z',
        model: 'claude-haiku-5-5'
      },
      {
        id: 'subagent-inherits-gate',
        result: 'pass',
        evidenceRef: 'o4/canaries/claude/evidence/subagent-inherits-gate.json',
        ranAt: '2026-10-21T08:28:58.678Z',
        model: 'claude-haiku-5-5'
      },
      {
        id: 'settings-gate-loaded',
        result: 'pass',
        evidenceRef: 'o4/canaries/claude/evidence/settings-gate-loaded.json',
        ranAt: '2026-10-21T08:20:12.602Z',
        model: 'claude-haiku-5-5'
      }
    ],
    selfUpdateReview: {
      sourceRef: 'closed source; downloads.claude.ai manifest 2.1.306, GPG fingerprint 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE',
      finding: 'Claude keeps its own updater; a self-updated program has other bytes, matches no entry and is asked about'
    },
    qualifiedAt: '2026-10-21',
    qualificationRecord: 'UnodeAi v0.9.97 O4 qualification, 2026-10-21',
    leafThumbprints: [
      '60C2D9C51F09822FFF4F194DE9EEDB67451292D1'
    ]
  }
];

/** The bundled policy. Entries are added only at release time, from qualified downloads and recorded canary runs. */
export const CLI_COMPATIBILITY_POLICY: CliCompatibilityPolicy = deepFreeze({
  schema: 'unodeai.cli-compatibility/1',
  policyVersion: '0.9.97-1',
  signers: {
    openai: {
      accepted: [
        {
          signatureType: 'Authenticode',
          subjectRdns: [['2.5.4.6', 'US'], ['2.5.4.8', 'California'], ['2.5.4.7', 'San Francisco'], ['2.5.4.10', 'OpenAI OpCo, LLC'], ['2.5.4.3', 'OpenAI OpCo, LLC']],
          rootThumbprint: 'F40042E2E5F7E8EF8189FED15519AECE42C3BFA2',
        },
      ],
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
  },
  entries: QUALIFIED_ENTRIES,
});

declare const validatedPolicyBrand: unique symbol;
/** A policy `loadCliCompatibilityPolicy` accepted: a frozen copy, checked once, that nothing can change afterwards. */
export type ValidatedCliCompatibilityPolicy = CliCompatibilityPolicy & { readonly [validatedPolicyBrand]: true };

export type CliPolicyLoad =
  | { ok: true; policy: ValidatedCliCompatibilityPolicy }
  | { ok: false; problems: string[] };

const validatedPolicies = new WeakSet<object>();

/**
 * Checks a policy and returns a frozen copy of it, or every problem found. The copy is what was checked, so a later
 * change to the object passed in cannot reach qualification.
 */
export function loadCliCompatibilityPolicy(policy: unknown = CLI_COMPATIBILITY_POLICY): CliPolicyLoad {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(policy);
  } catch {
    return { ok: false, problems: ['schema: the policy is not plain data.'] };
  }
  const problems = validateCliCompatibilityPolicy(snapshot);
  if (problems.length > 0) return { ok: false, problems };
  deepFreeze(snapshot);
  validatedPolicies.add(snapshot as object);
  return { ok: true, policy: snapshot as ValidatedCliCompatibilityPolicy };
}

/**
 * Every problem of a policy, one string per violation, each naming the rule it breaks (`schema` or `invariant <n>`).
 * Empty when the policy is valid.
 */
export function validateCliCompatibilityPolicy(policy: unknown): string[] {
  const problems: string[] = [];
  const schema = (text: string) => problems.push(`schema: ${text}`);
  const invariant = (number: number, text: string) => problems.push(`invariant ${number}: ${text}`);

  if (!isRecord(policy)) {
    schema('the policy is not an object.');
    return problems;
  }
  unknownKeys(policy, ['schema', 'policyVersion', 'signers', 'entries'], 'the policy', schema);
  if (policy.schema !== 'unodeai.cli-compatibility/1') schema('`schema` is not "unodeai.cli-compatibility/1".');
  if (!nonEmptyString(policy.policyVersion)) schema('`policyVersion` is not a non-empty string.');

  checkSigners(policy.signers, schema, invariant);

  if (!Array.isArray(policy.entries)) {
    schema('`entries` is not an array.');
    return problems;
  }
  const ids = new Set<string>();
  policy.entries.forEach((entry, index) => {
    const label = isRecord(entry) && nonEmptyString(entry.id) ? `entry "${entry.id}"` : `entry ${index}`;
    if (isRecord(entry) && nonEmptyString(entry.id)) {
      if (ids.has(entry.id)) schema(`${label} is listed twice.`);
      ids.add(entry.id);
    }
    checkEntry(entry, label, schema, invariant);
  });
  return problems;
}

/** The name of a managed version folder: `<version>-<os>-<arch>-<first 16 hex digits of the artifact SHA-256>`. */
export function cliStoreVersionKey(entry: Pick<PolicyEntry, 'version' | 'os' | 'arch'> & { managed?: { artifact: { sha256: string } } }): string {
  const digest = entry.managed?.artifact.sha256 ?? '';
  return `${entry.version}-${entry.os}-${entry.arch}-${digest.slice(0, CLI_STORE_PATH_LAYOUT.keyDigestChars)}`;
}

/** The longest path an entry's files take in the managed store, for a 64-character user profile (invariant 8). */
export function longestCliStorePathChars(entry: PolicyEntry): number {
  const layout = entry.managed?.layout;
  if (!layout) return 0;
  const store = CLI_STORE_PATH_LAYOUT;
  const instance = store.profileChars + store.storeBelowProfile.length + store.storeIdChars;
  const versionFolder = instance + store.versionsSegment.length + cliStoreVersionKey(entry).length + 1;
  const stagingPayload = instance + store.stagingSegment.length + store.stagingTokenChars + store.payloadSegment.length;
  const longestRelative = Math.max(0, ...[...layout.files.map((file) => file.path), ...layout.dirs].map((relative) => relative.length));
  return Math.max(versionFolder, stagingPayload) + longestRelative;
}

/**
 * The verdict of the bundled policy on one hashed closure, on this host. Bad or revoked bytes are blocked before
 * anything can qualify them. A Codex closure qualifies only as a whole package whose listing equals a qualified
 * entry's files exactly and whose program is the entry's entrypoint; a Claude closure only as a single file whose
 * SHA-256 a qualified entry lists. Paths are compared without case on Windows, as Windows opens them; sizes and
 * digests exactly. Everything else, including every `unbounded` and `launcher-pair` closure, needs consent.
 */
export function qualifyCliClosure(
  policy: ValidatedCliCompatibilityPolicy,
  closure: QualifiableCliClosure,
  host: { os: string; arch: string },
): CliQualification {
  if (!validatedPolicies.has(policy)) {
    throw new Error('UnodeAi qualifies a CLI program only against a compatibility policy that passed its checks.');
  }
  const executable = closure.files.find((file) => file.path === closure.executablePath);
  if (!executable) throw new Error('The closure listing does not contain the program it starts.');
  const ignoreCase = host.os === 'win32';
  const entries = policy.entries.filter((entry) => entry.provider === closure.provider);
  const policyId = (entry: PolicyEntry) => `${policy.policyVersion}#${entry.id}`;

  for (const entry of entries) {
    if (entry.status === 'qualified') continue;
    if (matchesBadEntry(entry, closure, executable, ignoreCase)) {
      return { verdict: 'blocked-bad', entry, reason: entry.statusReason ?? entry.status, compatibilityPolicyId: policyId(entry) };
    }
  }
  for (const entry of entries) {
    if (entry.status !== 'qualified' || entry.os !== host.os || entry.arch !== host.arch) continue;
    if (matchesQualifiedEntry(entry, closure, executable, ignoreCase)) {
      return { verdict: 'qualified', entry, version: entry.version, compatibilityPolicyId: policyId(entry) };
    }
  }
  return { verdict: 'needs-adoption', hostHasEntries: entries.some((entry) => entry.os === host.os && entry.arch === host.arch) };
}

function matchesQualifiedEntry(entry: PolicyEntry, closure: QualifiableCliClosure, executable: CliClosureFile, ignoreCase: boolean): boolean {
  if (closure.provider === 'codex-cli') {
    const layout = entry.managed?.layout;
    return !!layout
      && closure.kind === 'package'
      && samePath(closure.executablePath, layout.entrypoint, ignoreCase)
      && sameListing(closure.files, layout.files, ignoreCase);
  }
  return closure.kind === 'single-file' && !!entry.external && entry.external.executableDigests.includes(executable.sha256);
}

function matchesBadEntry(entry: PolicyEntry, closure: QualifiableCliClosure, executable: CliClosureFile, ignoreCase: boolean): boolean {
  if (closure.provider === 'codex-cli') {
    const layout = entry.managed?.layout;
    if (!layout) return false;
    const entrypoint = layout.files.find((file) => file.path === layout.entrypoint);
    return sameListing(closure.files, layout.files, ignoreCase) || (!!entrypoint && entrypoint.sha256 === executable.sha256);
  }
  // A launcher's program is as bad as the program itself, so every file of a Claude closure is compared.
  const digests = entry.external?.executableDigests ?? [];
  return closure.files.some((file) => digests.includes(file.sha256));
}

/** The same files: every listed path once, with the listed size and digest, and no other file. */
function sameListing(files: readonly CliClosureFile[], listed: readonly PolicyLayoutFile[], ignoreCase: boolean): boolean {
  if (files.length !== listed.length) return false;
  const key = (value: string) => (ignoreCase ? value.toLowerCase() : value);
  const byPath = new Map<string, CliClosureFile>();
  for (const file of files) {
    if (byPath.has(key(file.path))) return false;
    byPath.set(key(file.path), file);
  }
  return listed.every((expected) => {
    const actual = byPath.get(key(expected.path));
    return !!actual && actual.size === expected.size && actual.sha256 === expected.sha256;
  });
}

function samePath(a: string, b: string, ignoreCase: boolean): boolean {
  return ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
}

type Report = (text: string) => void;
type InvariantReport = (number: number, text: string) => void;

const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const THUMBPRINT_HEX = /^[0-9A-Fa-f]{40}$/;
const OID = /^[0-2](?:\.(?:0|[1-9][0-9]{0,9})){1,30}$/;
const ENTRY_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const HTTPS_AUTHORITY = /^https:\/\/([A-Za-z0-9.-]+)(?=[/?#]|$)/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function checkSigners(signers: unknown, schema: Report, invariant: InvariantReport): void {
  if (!isRecord(signers)) {
    invariant(9, '`signers` is not an object defining `openai` and `microsoft-crt`.');
    return;
  }
  const names = Object.keys(signers);
  for (const required of ['openai', 'microsoft-crt']) {
    if (!names.includes(required)) invariant(9, `\`signers\` does not define "${required}".`);
  }
  for (const name of names.filter((candidate) => candidate !== 'openai' && candidate !== 'microsoft-crt')) {
    invariant(9, `\`signers\` defines "${name}", which is not a signer of this policy.`);
  }
  for (const name of names.filter((candidate) => candidate === 'openai' || candidate === 'microsoft-crt')) {
    const signer = signers[name];
    if (!isRecord(signer) || !Array.isArray(signer.accepted) || signer.accepted.length === 0) {
      invariant(9, `signer "${name}" accepts no signature.`);
      continue;
    }
    unknownKeys(signer, ['accepted'], `signer "${name}"`, schema);
    signer.accepted.forEach((rule, index) => {
      const label = `signer "${name}" alternative ${index + 1}`;
      if (!isRecord(rule)) {
        invariant(9, `${label} is not an object.`);
        return;
      }
      unknownKeys(rule, ['signatureType', 'subjectRdns', 'rootThumbprint'], label, schema);
      if (rule.signatureType !== 'Authenticode' && rule.signatureType !== 'Catalog') schema(`${label} has a signature type other than Authenticode or Catalog.`);
      if (!Array.isArray(rule.subjectRdns) || rule.subjectRdns.length === 0) {
        invariant(9, `${label} has no subject RDNs.`);
      } else if (!rule.subjectRdns.every((rdn) => Array.isArray(rdn) && rdn.length === 2 && typeof rdn[0] === 'string' && OID.test(rdn[0]) && nonEmptyString(rdn[1]))) {
        schema(`${label} has a subject RDN that is not an [OID, value] pair.`);
      }
      if (typeof rule.rootThumbprint !== 'string' || !THUMBPRINT_HEX.test(rule.rootThumbprint)) {
        invariant(9, `${label} has a root thumbprint that is not 40 hex digits.`);
      }
    });
  }
}

function checkEntry(entry: unknown, label: string, schema: Report, invariant: InvariantReport): void {
  if (!isRecord(entry)) {
    schema(`${label} is not an object.`);
    return;
  }
  unknownKeys(entry, [
    'id', 'provider', 'version', 'versionOutput', 'os', 'arch', 'status', 'statusReason', 'external', 'managed',
    'gates', 'canaries', 'selfUpdateReview', 'qualifiedAt', 'qualificationRecord', 'leafThumbprints',
  ], label, schema);
  if (!nonEmptyString(entry.id)) schema(`${label} has no \`id\`.`);
  const provider = entry.provider;
  if (provider !== 'claude-cli' && provider !== 'codex-cli') schema(`${label} has an unknown provider.`);
  if (typeof entry.version !== 'string' || !ENTRY_VERSION.test(entry.version)) schema(`${label} has a \`version\` that is not an exact version.`);
  if (!nonEmptyString(entry.versionOutput) || /[\r\n]/.test(entry.versionOutput)) schema(`${label} has a \`versionOutput\` that is not one line.`);
  if (entry.os !== 'win32') schema(`${label} has an \`os\` other than win32.`);
  if (entry.arch !== 'x64') schema(`${label} has an \`arch\` other than x64.`);
  const status = entry.status;
  if (status !== 'qualified' && status !== 'bad' && status !== 'revoked') schema(`${label} has an unknown status.`);
  if (entry.statusReason !== undefined && typeof entry.statusReason !== 'string') schema(`${label} has a \`statusReason\` that is not a string.`);
  if (status === 'qualified' && provider === 'codex-cli' && typeof entry.version === 'string' && !meetsCodexFloor(entry.version)) {
    schema(`${label} qualifies a Codex version below ${CODEX_POLICY_VERSION_FLOOR} or a prerelease.`);
  }

  // Invariant 1: the evidence a status needs.
  const canaries = Array.isArray(entry.canaries) ? entry.canaries : undefined;
  if (!canaries) schema(`${label} has no \`canaries\` array.`);
  const known = new Set([...CLI_REQUIRED_CANARIES['claude-cli'], ...CLI_REQUIRED_CANARIES['codex-cli']]);
  const recorded = new Set<string>();
  for (const canary of canaries ?? []) {
    if (!isRecord(canary)) {
      schema(`${label} has a canary record that is not an object.`);
      continue;
    }
    unknownKeys(canary, ['id', 'result', 'evidenceRef', 'ranAt', 'model'], `${label} canary`, schema);
    if (typeof canary.id !== 'string' || !known.has(canary.id)) schema(`${label} records an unknown canary.`);
    else if (recorded.has(canary.id)) schema(`${label} records canary "${canary.id}" twice.`);
    if (!nonEmptyString(canary.evidenceRef) || !nonEmptyString(canary.ranAt) || !nonEmptyString(canary.model)) {
      schema(`${label} has a canary record without its evidence, time or model.`);
    }
    if (canary.result !== 'pass') schema(`${label} records a canary result other than pass.`);
    if (typeof canary.id === 'string' && canary.result === 'pass') recorded.add(canary.id);
  }
  if (status === 'qualified' && (provider === 'claude-cli' || provider === 'codex-cli')) {
    for (const required of CLI_REQUIRED_CANARIES[provider]) {
      if (!recorded.has(required)) invariant(1, `${label} is qualified without a passed "${required}" canary.`);
    }
  }
  if ((status === 'bad' || status === 'revoked') && !nonEmptyString(entry.statusReason)) {
    invariant(1, `${label} is ${status} without a \`statusReason\`.`);
  }

  // Invariant 2: each provider qualifies through its own field, and only through it.
  if (entry.external !== undefined && provider !== 'claude-cli') invariant(2, `${label} has \`external\`, which only a claude-cli entry may have.`);
  if (entry.managed !== undefined && provider !== 'codex-cli') invariant(2, `${label} has \`managed\`, which only a codex-cli entry may have.`);
  if (provider === 'claude-cli' && entry.external === undefined) invariant(2, `${label} is a claude-cli entry without \`external\`.`);
  if (provider === 'codex-cli' && entry.managed === undefined) invariant(2, `${label} is a codex-cli entry without \`managed\`.`);
  if (entry.external !== undefined) checkExternal(entry.external, label, schema);
  if (entry.managed !== undefined) checkManaged(entry, label, schema, invariant);

  if (!isRecord(entry.gates) || !Object.values(entry.gates).every((value) => value === true)) schema(`${label} has \`gates\` that are not all true.`);
  if (!isRecord(entry.selfUpdateReview) || !nonEmptyString(entry.selfUpdateReview.sourceRef) || !nonEmptyString(entry.selfUpdateReview.finding)) {
    schema(`${label} has no \`selfUpdateReview\` source and finding.`);
  } else {
    unknownKeys(entry.selfUpdateReview, ['sourceRef', 'finding'], `${label} selfUpdateReview`, schema);
  }
  if (typeof entry.qualifiedAt !== 'string' || typeof entry.qualificationRecord !== 'string') schema(`${label} has no \`qualifiedAt\` and \`qualificationRecord\`.`);
  if (status === 'qualified' && (!nonEmptyString(entry.qualifiedAt) || !nonEmptyString(entry.qualificationRecord))) {
    schema(`${label} is qualified without \`qualifiedAt\` and \`qualificationRecord\`.`);
  }
  if (!Array.isArray(entry.leafThumbprints) || !entry.leafThumbprints.every((value) => typeof value === 'string' && THUMBPRINT_HEX.test(value))) {
    schema(`${label} has \`leafThumbprints\` that are not 40-hex-digit thumbprints.`);
  }
}

function checkExternal(external: unknown, label: string, schema: Report): void {
  if (!isRecord(external) || !Array.isArray(external.executableDigests) || external.executableDigests.length === 0) {
    schema(`${label} has no \`external.executableDigests\`.`);
    return;
  }
  unknownKeys(external, ['executableDigests'], `${label} external`, schema);
  if (!external.executableDigests.every((digest) => typeof digest === 'string' && SHA256_HEX.test(digest))) {
    schema(`${label} has an executable digest that is not a lower-case SHA-256.`);
  }
  if (new Set(external.executableDigests).size !== external.executableDigests.length) schema(`${label} lists an executable digest twice.`);
}

function checkManaged(entry: Record<string, unknown>, label: string, schema: Report, invariant: InvariantReport): void {
  const managed = entry.managed;
  if (!isRecord(managed) || !isRecord(managed.artifact) || !isRecord(managed.layout)) {
    schema(`${label} has \`managed\` without its artifact and layout.`);
    return;
  }
  unknownKeys(managed, ['artifact', 'layout'], `${label} managed`, schema);
  const artifact = managed.artifact;
  const layout = managed.layout;
  unknownKeys(artifact, ['kind', 'name', 'size', 'sha256', 'urls', 'redirectHosts'], `${label} artifact`, schema);
  unknownKeys(layout, ['entrypoint', 'unpackedBytes', 'dirs', 'ignoredEntries', 'files'], `${label} layout`, schema);

  // Invariant 3.
  if (artifact.kind !== 'tar.gz') invariant(3, `${label} has an artifact kind other than tar.gz.`);
  if (typeof artifact.name !== 'string' || !PATH_SEGMENT.test(artifact.name) || artifact.name === '.' || artifact.name === '..') {
    schema(`${label} has an artifact name that is not one plain file name.`);
  }
  if (typeof artifact.sha256 !== 'string' || !SHA256_HEX.test(artifact.sha256)) schema(`${label} has an artifact SHA-256 that is not lower-case hex.`);
  if (!Number.isSafeInteger(artifact.size) || (artifact.size as number) <= 0) schema(`${label} has an artifact size that is not a positive whole number.`);

  // Invariant 5.
  if (Number.isSafeInteger(artifact.size) && (artifact.size as number) > CLI_POLICY_LIMITS.maxArtifactBytes) {
    invariant(5, `${label} has an artifact larger than 512 MiB.`);
  }
  if (!Number.isSafeInteger(layout.unpackedBytes) || (layout.unpackedBytes as number) < 0) {
    schema(`${label} has \`unpackedBytes\` that is not a whole number.`);
  } else if ((layout.unpackedBytes as number) > CLI_POLICY_LIMITS.maxUnpackedBytes) {
    invariant(5, `${label} unpacks to more than 1 GiB.`);
  }

  // Invariant 6.
  const urls = Array.isArray(artifact.urls) ? artifact.urls : undefined;
  if (!urls || urls.length === 0) schema(`${label} has no artifact URLs.`);
  for (const url of urls ?? []) {
    const problem = artifactUrlProblem(url);
    if (problem) invariant(6, `${label} has an artifact URL that ${problem}.`);
  }
  if (!Array.isArray(artifact.redirectHosts)) {
    schema(`${label} has no \`redirectHosts\` array.`);
  } else {
    for (const host of artifact.redirectHosts) {
      if (typeof host !== 'string' || !CODEX_REDIRECT_HOSTS.includes(host)) invariant(6, `${label} allows a redirect to a host outside the Codex redirect hosts.`);
    }
  }

  const files = Array.isArray(layout.files) ? layout.files : undefined;
  const dirs = Array.isArray(layout.dirs) ? layout.dirs : undefined;
  const ignored = Array.isArray(layout.ignoredEntries) ? layout.ignoredEntries : undefined;
  if (!files || files.length === 0) schema(`${label} has no layout files.`);
  if (!dirs) schema(`${label} has no layout \`dirs\` array.`);
  if (!ignored || !ignored.every(nonEmptyString)) schema(`${label} has \`ignoredEntries\` that are not names.`);
  if (!files || !dirs) return;

  // Invariant 5, the entry count.
  if (files.length + dirs.length + (ignored?.length ?? 0) > CLI_POLICY_LIMITS.maxEntries) {
    invariant(5, `${label} has more than 20,000 entries.`);
  }

  // Invariant 4: every path is a plain relative path that Windows stores as written, under a listed folder.
  const seen = new Set<string>();
  const dirSet = new Set<string>();
  const checkPath = (value: unknown, kind: 'file' | 'folder'): value is string => {
    if (typeof value !== 'string') {
      schema(`${label} has a layout ${kind} path that is not a string.`);
      return false;
    }
    for (const problem of layoutPathProblems(value)) invariant(4, `${label} ${kind} "${value}" ${problem}.`);
    const folded = value.toLowerCase();
    if (seen.has(folded)) invariant(4, `${label} ${kind} "${value}" equals another layout path without case.`);
    seen.add(folded);
    return true;
  };
  for (const dir of dirs) {
    if (checkPath(dir, 'folder')) dirSet.add(dir);
  }
  const unlistedParents = (value: string, kind: 'file' | 'folder') => {
    const segments = value.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = segments.slice(0, depth).join('/');
      if (!dirSet.has(parent)) invariant(4, `${label} ${kind} "${value}" is under "${parent}", which \`dirs\` does not list.`);
    }
  };
  for (const dir of dirSet) unlistedParents(dir, 'folder');

  let totalBytes = 0;
  for (const file of files) {
    if (!isRecord(file)) {
      schema(`${label} has a layout file that is not an object.`);
      continue;
    }
    unknownKeys(file, ['path', 'size', 'sha256', 'pe', 'signer'], `${label} layout file`, schema);
    if (checkPath(file.path, 'file')) unlistedParents(file.path, 'file');
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) schema(`${label} file "${String(file.path)}" has a size that is not a whole number.`);
    else totalBytes += file.size as number;
    if (typeof file.sha256 !== 'string' || !SHA256_HEX.test(file.sha256)) schema(`${label} file "${String(file.path)}" has a SHA-256 that is not lower-case hex.`);
    if (typeof file.pe !== 'boolean') schema(`${label} file "${String(file.path)}" does not say whether it is a PE file.`);
    // Invariant 7.
    if (file.pe === true && file.signer !== 'openai' && file.signer !== 'microsoft-crt' && file.signer !== 'unsigned') {
      invariant(7, `${label} file "${String(file.path)}" is a PE file whose signer is not openai, microsoft-crt or unsigned.`);
    }
    if (file.pe === false && file.signer !== 'none') invariant(7, `${label} file "${String(file.path)}" is not a PE file but has a signer other than none.`);
  }
  if (Number.isSafeInteger(layout.unpackedBytes) && totalBytes > (layout.unpackedBytes as number)) {
    invariant(5, `${label} lists files larger in total than its \`unpackedBytes\`.`);
  }
  if (typeof layout.entrypoint !== 'string' || !files.some((file) => isRecord(file) && file.path === layout.entrypoint)) {
    schema(`${label} has an entrypoint that is not one of its files.`);
  }

  // Invariant 8.
  if (typeof entry.version === 'string' && typeof artifact.sha256 === 'string' && files.every((file) => isRecord(file) && typeof file.path === 'string')
    && dirs.every((dir) => typeof dir === 'string')) {
    const longest = longestCliStorePathChars(entry as unknown as PolicyEntry);
    if (longest > CLI_POLICY_LIMITS.maxStorePathChars) {
      invariant(8, `${label} needs a store path of ${longest} characters, more than 240 for a 64-character user profile.`);
    }
  }
}

/** Why a relative layout path could not be written exactly as listed on Windows, or nothing. */
function layoutPathProblems(value: string): string[] {
  const problems: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '.' || segment === '..') problems.push('has a "." or ".." segment');
    else if (!PATH_SEGMENT.test(segment)) problems.push('has a segment outside [A-Za-z0-9._-]');
    else if (RESERVED_DEVICE_NAME.test(segment)) problems.push(`names the reserved device "${segment}"`);
    else if (/[. ]$/.test(segment)) problems.push('has a segment ending in a dot or space');
  }
  return problems;
}

function artifactUrlProblem(url: unknown): string | undefined {
  if (typeof url !== 'string') return 'is not a string';
  // Read from the text itself: URL parsing drops a default port (`:443`), and a port is refused even then.
  const authority = HTTPS_AUTHORITY.exec(url);
  if (!authority) return 'is not https: with a plain host name (no user information and no port)';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'does not parse';
  }
  const host = authority[1].toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hostname !== host || !HOSTNAME.test(host)) {
    return 'is not https: with a plain host name (no user information and no port)';
  }
  if (!CODEX_ARTIFACT_HOSTS.includes(host)) return `names the host "${host}", which is not a Codex artifact host`;
  return undefined;
}

function meetsCodexFloor(version: string): boolean {
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/.exec(version);
  if (!match) return false;
  const floor = CODEX_POLICY_VERSION_FLOOR.split('.').map(Number);
  const parts = match.slice(1, 4).map(Number);
  for (let index = 0; index < 3; index++) {
    if (parts[index] !== floor[index]) return parts[index] > floor[index];
  }
  return true;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, schema: Report): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) schema(`${label} has the unknown field "${key}".`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
