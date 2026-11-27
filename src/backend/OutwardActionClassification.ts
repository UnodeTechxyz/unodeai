import type { CommandShellIdentity } from './CommandShell';
import { literalCommandSegments } from './CommandPolicy';

export type OutwardOperationKind = 'push' | 'publish' | 'deploy' | 'post';

/**
 * The complete recognition vocabulary. These are direct CLI spellings, not shell aliases. Callers
 * resolve destination/content where possible, or disclose uncertainty on the single-use action card.
 * This module makes no permission decision and does not execute or log any argument.
 */
export const OUTWARD_COMMAND_OPERATIONS = [
  { executable: 'git', words: ['push'], kind: 'push' },
  { executable: 'npm', words: ['publish'], kind: 'publish' },
  { executable: 'pnpm', words: ['publish'], kind: 'publish' },
  { executable: 'yarn', words: ['publish'], kind: 'publish' },
  { executable: 'yarn', words: ['npm', 'publish'], kind: 'publish' },
  { executable: 'vsce', words: ['publish'], kind: 'publish' },
  { executable: 'ovsx', words: ['publish'], kind: 'publish' },
  { executable: 'cargo', words: ['publish'], kind: 'publish' },
  { executable: 'twine', words: ['upload'], kind: 'publish' },
  { executable: 'dotnet', words: ['nuget', 'push'], kind: 'publish' },
  { executable: 'docker', words: ['push'], kind: 'push' },
  { executable: 'podman', words: ['push'], kind: 'push' },
  { executable: 'vercel', words: ['deploy'], kind: 'deploy' },
  { executable: 'netlify', words: ['deploy'], kind: 'deploy' },
  { executable: 'firebase', words: ['deploy'], kind: 'deploy' },
  { executable: 'wrangler', words: ['deploy'], kind: 'deploy' },
  { executable: 'gh', words: ['release', 'create'], kind: 'publish' },
  { executable: 'gh', words: ['release', 'upload'], kind: 'publish' },
  { executable: 'gh', words: ['pr', 'create'], kind: 'post' },
  { executable: 'gh', words: ['pr', 'comment'], kind: 'post' },
  { executable: 'gh', words: ['pr', 'review'], kind: 'post' },
  { executable: 'gh', words: ['pr', 'merge'], kind: 'publish' },
  { executable: 'gh', words: ['issue', 'create'], kind: 'post' },
  { executable: 'gh', words: ['issue', 'comment'], kind: 'post' },
] as const satisfies readonly { executable: string; words: readonly string[]; kind: OutwardOperationKind }[];

/** Published package names that differ from the listed executable. No basename or URL guessing. */
export const OUTWARD_PACKAGE_TOOL_ALIASES = {
  '@vscode/vsce': 'vsce',
  'firebase-tools': 'firebase',
  'netlify-cli': 'netlify',
  '@yarnpkg/cli-dist': 'yarn',
} as const;

/** Forms deliberately not decoded. An empty match is never a statement that a command is safe. */
export const OUTWARD_COMMAND_GAPS = [
  'shell interpreters and inline source (including cmd /c and powershell -c)',
  'scripts, npm run scripts, shell functions, aliases and renamed executables',
  'expansions, substitutions, pipes, redirects, escaped or concatenated words',
  'unlisted commands, global options and wrapper forms',
  'native Codex actions and commands that modify security-control files',
] as const;

export interface ClassifiedOutwardCommand {
  readonly kind: OutwardOperationKind;
  readonly executable: string;
  readonly operation: readonly string[];
  /** Full literal segment, including assignments and recognized wrappers, for exact-effect preparation. */
  readonly argv: readonly string[];
  /** Literal environment assignments before the executable, decoded once with the recognized wrapper. */
  readonly assignments: readonly (readonly [string, string])[];
  /** Git -C/--git-dir/--work-tree and -c values remain here; nothing is executed or resolved. */
  readonly globalOptions: readonly string[];
  readonly arguments: readonly string[];
  readonly segmentIndex: number;
}

export interface OutwardCommandClassification {
  readonly literal: boolean;
  readonly operations: readonly ClassifiedOutwardCommand[];
}

/**
 * Recognizes literal direct commands, POSIX assignment/env prefixes, and one finite package runner:
 * npx [-y|--yes], pnpm dlx, yarn dlx, bunx. Only known package names with bounded versions/tags match.
 * Git additionally accepts its listed value options and --no-pager/-p/--paginate before push.
 * No shell is recursively interpreted. Environment options such as `env -S` are not read.
 */
export function classifyOutwardCommand(
  command: string,
  shell: Pick<CommandShellIdentity, 'kind' | 'grammar'>,
  platform: NodeJS.Platform = process.platform,
): OutwardCommandClassification {
  const segments = literalCommandSegments(command, shell);
  if (!segments) return { literal: false, operations: [] };
  const operations: ClassifiedOutwardCommand[] = [];
  segments.forEach((argv, segmentIndex) => {
    let start = 0;
    if (shell.grammar === 'posix') {
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[start] ?? '')) start++;
    }
    if (executableName(argv[start], shell.grammar, platform) === 'env') {
      if (shell.grammar !== 'posix') return;
      start++;
      if (argv[start] === '--') start++;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[start] ?? '')) start++;
      if (!argv[start] || argv[start].startsWith('-')) return;
    }
    const assignments = argv.slice(0, start).filter(word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
      .map(word => { const at = word.indexOf('='); return [word.slice(0, at), word.slice(at + 1)] as const; });
    let executable = executableName(argv[start], shell.grammar, platform);
    let packageIndex: number | undefined;
    if (executable === 'npx') {
      packageIndex = start + 1;
      if (argv[packageIndex] === '-y' || argv[packageIndex] === '--yes') packageIndex++;
    } else if ((executable === 'pnpm' || executable === 'yarn') && argv[start + 1] === 'dlx') {
      packageIndex = start + 2;
    } else if (executable === 'bunx') {
      packageIndex = start + 1;
    }
    if (packageIndex !== undefined) {
      const tool = listedPackageTool(argv[packageIndex]);
      if (!tool) return;
      executable = tool;
      start = packageIndex;
    }
    const globalOptions: string[] = [];
    let operationStart = start + 1;
    if (executable === 'git') {
      while (argv[operationStart]?.startsWith('-')) {
        const option = argv[operationStart];
        if (option === '-C' || option === '-c' || option === '--git-dir' || option === '--work-tree') {
          const value = argv[operationStart + 1];
          if (!value) return;
          globalOptions.push(option, value);
          operationStart += 2;
        } else if (/^--(?:git-dir|work-tree)=.+/.test(option)
          || option === '--no-pager' || option === '-p' || option === '--paginate') {
          globalOptions.push(option);
          operationStart++;
        } else return;
      }
    }
    const match = OUTWARD_COMMAND_OPERATIONS.find((candidate) => candidate.executable === executable
      && candidate.words.every((word, index) => argv[operationStart + index] === word));
    if (!match) return;
    operations.push({ kind: match.kind, executable, operation: [...match.words], argv: [...argv],
      assignments, globalOptions, arguments: argv.slice(operationStart + match.words.length), segmentIndex });
  });
  return { literal: true, operations };
}

function listedPackageTool(specifier: string | undefined): string | undefined {
  if (!specifier) return undefined;
  const versionAt = specifier.indexOf('@', specifier.startsWith('@') ? specifier.indexOf('/') + 1 : 0);
  const name = versionAt === -1 ? specifier : specifier.slice(0, versionAt);
  if (versionAt !== -1 && !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(specifier.slice(versionAt + 1))) return undefined;
  if (Object.hasOwn(OUTWARD_PACKAGE_TOOL_ALIASES, name)) {
    return OUTWARD_PACKAGE_TOOL_ALIASES[name as keyof typeof OUTWARD_PACKAGE_TOOL_ALIASES];
  }
  return OUTWARD_COMMAND_OPERATIONS.some((candidate) => candidate.executable === name) ? name : undefined;
}

function executableName(value: string | undefined, grammar: CommandShellIdentity['grammar'], platform: NodeJS.Platform): string {
  if (!value) return '';
  const basename = value.split(/[\\/]/).at(-1)!;
  // Shell grammar and host executable lookup are separate. Git Bash on Windows and default macOS volumes
  // can run GIT as git; Linux retains case-sensitive recognition. Arguments and original argv stay untouched.
  const name = grammar !== 'posix' || platform === 'win32' || platform === 'darwin' ? basename.toLowerCase() : basename;
  return grammar === 'posix' ? name.replace(/\.exe$/i, '') : name.replace(/\.(?:exe|cmd|bat)$/i, '');
}
