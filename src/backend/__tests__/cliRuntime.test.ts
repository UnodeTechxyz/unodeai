import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyCliRuntimeFailure,
  classifyCliSource,
  cliLatestVersionUrl,
  cliProgramStamp,
  cliTerminalShell,
  cliUpdateInstructions,
  compareCliVersions,
  discoverClaudeCliCandidates,
  discoverCodexExtensionCandidates,
  parseClaudeCliVersion,
  parseNpmLatestVersion,
  prepareNeutralFolder,
  readBoundedText,
  renderCliUpdateCommand,
  resolveClaudeCliLaunch,
  type CliRuntimeFs,
} from '../cliRuntime';

/** A file system of exactly these files; every folder that contains one exists and can be listed. */
function fakeFs(files: string[], separator = '\\'): CliRuntimeFs & { listed: string[] } {
  const norm = (value: string) => value.toLowerCase();
  const set = new Set(files.map(norm));
  const listed: string[] = [];
  return {
    listed,
    exists: (candidate) => set.has(norm(candidate)),
    readDir: (dir) => {
      listed.push(dir);
      const prefix = norm(dir.endsWith(separator) ? dir : dir + separator);
      const children = new Set<string>();
      for (const file of files) {
        if (norm(file).startsWith(prefix)) children.add(file.slice(prefix.length).split(separator)[0]);
      }
      if (children.size === 0) throw new Error(`ENOENT ${dir}`);
      return [...children];
    },
  };
}

const WIN_ENV = {
  APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\Ada',
  PATH: 'C:\\Tools;relative\\bin;C:\\Users\\Ada\\AppData\\Roaming\\npm',
};
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const NPM_EXE = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const NPM_CMD = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\claude.cmd';
const NATIVE = 'C:\\Users\\Ada\\.local\\bin\\claude.exe';
const EXT_OLD = 'C:\\Users\\Ada\\.vscode\\extensions\\anthropic.claude-code-2.1.99-win32-x64\\resources\\native-binary\\claude.exe';
const EXT_NEW = 'C:\\Users\\Ada\\.vscode\\extensions\\anthropic.claude-code-2.1.301-win32-x64\\resources\\native-binary\\claude.exe';

describe('Claude CLI discovery (v0.9.96)', () => {
  it('finds Windows installations from the file system, the program behind npm\'s launcher first, PATH last', () => {
    const fs = fakeFs([NPM_EXE, NPM_CMD, NATIVE, EXT_OLD, EXT_NEW, 'C:\\Tools\\claude.exe', 'relative\\bin\\claude.exe']);
    const found = discoverClaudeCliCandidates(WIN_ENV, 'win32', fs, NODE);
    expect(found.map((candidate) => [candidate.source, candidate.path, candidate.route])).toEqual([
      ['npm global install', NPM_EXE, 'native'],
      ['npm global install', NPM_CMD, 'npm-cmd'],
      ['native installer', NATIVE, 'native'],
      ['VS Code extension', EXT_NEW, 'native'],
      ['VS Code extension', EXT_OLD, 'native'],
      ['PATH', 'C:\\Tools\\claude.exe', 'native'],
    ]);
    expect(found.find((candidate) => candidate.path === EXT_NEW)?.note).toMatch(/moves to a new folder/);
  });

  it('lists a program reachable two ways once, and nothing that does not exist', () => {
    const fs = fakeFs([NPM_CMD]);
    const found = discoverClaudeCliCandidates(WIN_ENV, 'win32', fs, NODE);
    expect(found.map((candidate) => candidate.path)).toEqual([NPM_CMD]);
  });

  it('finds POSIX installations', () => {
    const env = { HOME: '/home/ada', PATH: '/usr/bin:/home/ada/.local/bin' };
    const fs = fakeFs([
      '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude', '/usr/bin/claude', '/home/ada/.local/bin/claude',
      '/home/ada/.claude/local/claude',
    ], '/');
    const found = discoverClaudeCliCandidates(env, 'linux', fs, '/usr/bin/node');
    expect(found.map((candidate) => [candidate.source, candidate.path])).toEqual([
      ['npm global install', '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude'],
      ['npm global install', '/usr/bin/claude'],
      ['native installer', '/home/ada/.local/bin/claude'],
      ['standard install location', '/home/ada/.claude/local/claude'],
    ]);
    expect(found.every((candidate) => candidate.route === 'native')).toBe(true);
  });

  it('finds a Codex program bundled with the ChatGPT extension', () => {
    const exe = 'C:\\Users\\Ada\\.vscode\\extensions\\openai.chatgpt-26.1007.1-win32-x64\\bin\\windows-x86_64\\codex.exe';
    const found = discoverCodexExtensionCandidates(WIN_ENV, 'win32', fakeFs([exe, 'C:\\Users\\Ada\\.vscode\\extensions\\other.thing-1\\bin\\x\\codex.exe']));
    expect(found).toEqual([{ path: exe, source: 'VS Code extension', route: 'native', note: expect.stringMatching(/moves/) }]);
  });

  it('starts nothing: the module imports no process API', () => {
    const source = readFileSync(join(process.cwd(), 'src/backend/cliRuntime.ts'), 'utf8');
    expect(source).not.toMatch(/child_process/);
  });
});

describe('which installation a program comes from', () => {
  it('names npm, the native installer and an extension from the path alone', () => {
    expect(classifyCliSource('claude-cli', NPM_EXE, WIN_ENV, 'win32', NODE)).toBe('npm global install');
    expect(classifyCliSource('claude-cli', NPM_CMD, WIN_ENV, 'win32', NODE)).toBe('npm global install');
    expect(classifyCliSource('claude-cli', NATIVE, WIN_ENV, 'win32', NODE)).toBe('native installer');
    expect(classifyCliSource('claude-cli', EXT_NEW, WIN_ENV, 'win32', NODE)).toBe('VS Code extension');
    expect(classifyCliSource('claude-cli', 'D:\\portable\\claude.exe', WIN_ENV, 'win32', NODE)).toBe('chosen file');
    const codexNpm = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x\\bin\\codex.exe';
    expect(classifyCliSource('codex-cli', codexNpm, WIN_ENV, 'win32', NODE)).toBe('npm global install');
    expect(classifyCliSource('codex-cli', NPM_EXE, WIN_ENV, 'win32', NODE)).toBe('chosen file');
  });
});

describe('the Claude program a start uses', () => {
  const resolver = (map: Record<string, string>) => (command: string) => {
    const hit = map[command];
    if (!hit) throw new Error(`not found: ${command}`);
    return hit;
  };

  it('keeps the lookup used before 0.9.96 when nothing is configured: claude.cmd through cmd.exe', () => {
    expect(resolveClaudeCliLaunch('', resolver({ 'claude.cmd': NPM_CMD }), 'win32'))
      .toEqual({ executable: NPM_CMD, shell: true, route: 'npm-cmd', origin: 'legacy' });
    expect(() => resolveClaudeCliLaunch('', resolver({ 'claude.exe': NATIVE }), 'win32')).toThrow(/not found: claude\.cmd/);
    expect(resolveClaudeCliLaunch('', resolver({ claude: '/usr/bin/claude' }), 'linux'))
      .toEqual({ executable: '/usr/bin/claude', shell: false, route: 'native', origin: 'legacy' });
  });

  it('starts a configured native program without a shell, and npm\'s launcher only through its validated route', () => {
    expect(resolveClaudeCliLaunch(NATIVE, resolver({ [NATIVE]: NATIVE }), 'win32'))
      .toEqual({ executable: NATIVE, shell: false, route: 'native', origin: 'configured' });
    expect(resolveClaudeCliLaunch(NPM_CMD, resolver({ [NPM_CMD]: NPM_CMD }), 'win32'))
      .toEqual({ executable: NPM_CMD, shell: true, route: 'npm-cmd', origin: 'configured' });
    const spaced = 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\claude.cmd';
    expect(resolveClaudeCliLaunch(spaced, resolver({ [spaced]: spaced }), 'win32').shell).toBe(true);
  });

  // v0.9.97 (the Owner's O4 decision): npm's claude.cmd only starts the program inside its package, so that program is
  // started directly, the same single file the native installer ships, and qualified by its bytes.
  it('starts the program npm\'s claude.cmd names directly when it is there, configured or looked up', () => {
    const PROGRAM = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const present = { exists: (file: string) => file === PROGRAM };
    const both = resolver({ [NPM_CMD]: NPM_CMD, 'claude.cmd': NPM_CMD, [PROGRAM]: PROGRAM });
    expect(resolveClaudeCliLaunch(NPM_CMD, both, 'win32', present)).toEqual({ executable: PROGRAM, shell: false, route: 'native', origin: 'configured' });
    expect(resolveClaudeCliLaunch('', both, 'win32', present)).toEqual({ executable: PROGRAM, shell: false, route: 'native', origin: 'legacy' });
    // The program goes through the same resolver: its refusal (for example inside a workspace) refuses the start.
    const refused = (command: string) => { if (command === PROGRAM) throw new Error('inside a workspace'); return NPM_CMD; };
    expect(() => resolveClaudeCliLaunch(NPM_CMD, refused, 'win32', present)).toThrow(/inside a workspace/);
    // A launcher whose program is missing keeps the cmd.exe route.
    expect(resolveClaudeCliLaunch(NPM_CMD, both, 'win32', { exists: () => false })).toEqual({ executable: NPM_CMD, shell: true, route: 'npm-cmd', origin: 'configured' });
    // An unsafe launcher path is refused before anything else is looked at.
    expect(() => resolveClaudeCliLaunch('C:\\x\\%PATH%\\claude.cmd', resolver({ 'C:\\x\\%PATH%\\claude.cmd': 'C:\\x\\%PATH%\\claude.cmd' }), 'win32', { exists: () => true })).toThrow(/unsafe/);
  });

  it('refuses a relative path, an unsafe launcher path and any other kind of file', () => {
    expect(() => resolveClaudeCliLaunch('claude.exe', resolver({}), 'win32')).toThrow(/absolute path/);
    for (const bad of ['C:\\x\\"evil.cmd', 'C:\\x\\%PATH%\\claude.cmd', 'C:\\x\\a\r\nb.cmd']) {
      expect(() => resolveClaudeCliLaunch(bad, resolver({ [bad]: bad }), 'win32')).toThrow(/unsafe/);
    }
    expect(() => resolveClaudeCliLaunch('C:\\x\\claude.ps1', resolver({ 'C:\\x\\claude.ps1': 'C:\\x\\claude.ps1' }), 'win32')).toThrow(/only a \.exe/);
  });

  it('takes the resolver\'s refusal, such as a program inside the workspace', () => {
    const refuse = () => { throw new Error('inside workspace-owned path'); };
    expect(() => resolveClaudeCliLaunch('C:\\repo\\claude.exe', refuse, 'win32')).toThrow(/workspace-owned/);
  });
});

describe('Claude CLI version and provider errors', () => {
  it('reads the version only from Claude Code\'s own --version line', () => {
    expect(parseClaudeCliVersion('2.1.209 (Claude Code)')).toBe('2.1.209');
    expect(parseClaudeCliVersion('\n2.1.301 (Claude Code)\n')).toBe('2.1.301');
    expect(parseClaudeCliVersion('codex-cli 0.155.1')).toBeUndefined();
    expect(parseClaudeCliVersion('9.9.9')).toBeUndefined();
    expect(parseClaudeCliVersion('')).toBeUndefined();
  });

  it('classifies the field error that a model needs a newer Claude CLI, taking only the versions from it', () => {
    const field = "API Error: 400 Claude Code 2.1.209 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";
    expect(classifyCliRuntimeFailure('claude-cli', field)).toEqual({
      kind: 'runtime-too-old', provider: 'claude-cli', reportedVersion: '2.1.209', requiredVersion: '2.1.280',
    });
    const forged = '<img src=x onerror=alert(1)> Claude Code 2.1.1 does not support this model; version 9.9.9 or newer is required. Run `rm -rf /`';
    expect(classifyCliRuntimeFailure('claude-cli', forged)).toEqual({
      kind: 'runtime-too-old', provider: 'claude-cli', reportedVersion: '2.1.1', requiredVersion: '9.9.9',
    });
  });

  it('assumes no old CLI for any other error, or for Codex', () => {
    for (const text of [
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"model: claude-x"}}',
      'API Error: 401 authentication_error',
      'Error: getaddrinfo ENOTFOUND api.anthropic.com',
      'Claude Code 2.1.209 is fine',
      // Two version numbers alone do not make an old-CLI error.
      'Claude Code 2.1.209 started; MCP server 1.2.3 failed to load',
      'API Error: 400 node 20.11.1 and npm 10.2.4 are installed',
    ]) {
      expect(classifyCliRuntimeFailure('claude-cli', text)).toBeUndefined();
    }
    expect(classifyCliRuntimeFailure('codex-cli', 'Claude Code 2.1.209 does not support this model; version 2.1.280 or newer is required')).toBeUndefined();
  });
});

describe('update instructions for the installation UnodeAi starts', () => {
  it('gives a command for npm and the native installer, and none it would have to guess', () => {
    expect(cliUpdateInstructions('claude-cli', NPM_EXE, 'npm global install')).toMatchObject({
      update: { program: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code@latest'] },
      summary: expect.stringMatching(/claude update.*different installation/),
    });
    expect(cliUpdateInstructions('claude-cli', NATIVE, 'native installer').update).toEqual({ program: NATIVE, args: ['update'] });
    expect(cliUpdateInstructions('claude-cli', EXT_NEW, 'VS Code extension').update).toBeUndefined();
    expect(cliUpdateInstructions('claude-cli', 'D:\\x\\claude.exe', 'chosen file').update).toBeUndefined();
    expect(cliUpdateInstructions('codex-cli', 'C:\\x\\codex.exe', 'npm global install').update)
      .toEqual({ program: 'npm', args: ['install', '-g', '@openai/codex@latest'] });
    expect(cliUpdateInstructions('codex-cli', 'C:\\x\\codex.exe', 'VS Code extension').update).toBeUndefined();
    expect(cliUpdateInstructions('codex-cli', 'C:\\x\\codex.exe', 'PATH').update).toBeUndefined();
  });

  it('writes the command for the user\'s shell, quoting a program path, and refuses what it cannot quote', () => {
    expect(cliTerminalShell('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('powershell');
    expect(cliTerminalShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell');
    expect(cliTerminalShell('C:\\WINDOWS\\System32\\cmd.exe')).toBe('cmd');
    expect(cliTerminalShell('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('posix');
    expect(cliTerminalShell('/bin/zsh')).toBe('posix');
    expect(cliTerminalShell('/usr/bin/nu')).toBeUndefined();
    expect(cliTerminalShell('')).toBeUndefined();

    const npm = { program: 'npm', args: ['install', '-g', '@openai/codex@latest'] };
    for (const shell of ['powershell', 'cmd', 'posix'] as const) {
      expect(renderCliUpdateCommand(npm, shell)).toBe('npm install -g @openai/codex@latest');
    }
    const native = { program: 'C:\\Users\\Ada Lovelace\\.local\\bin\\claude.exe', args: ['update'] };
    expect(renderCliUpdateCommand(native, 'powershell')).toBe("& 'C:\\Users\\Ada Lovelace\\.local\\bin\\claude.exe' update");
    expect(renderCliUpdateCommand(native, 'cmd')).toBe('"C:\\Users\\Ada Lovelace\\.local\\bin\\claude.exe" update');
    expect(renderCliUpdateCommand(native, 'posix')).toBe("'C:\\Users\\Ada Lovelace\\.local\\bin\\claude.exe' update");

    // A quote inside the path is doubled for PowerShell, including the typographic ones it also ends a string at.
    const apostrophes = { program: 'C:\\Users\\O\u2019Brien\\it\'s\\claude.exe', args: ['update'] };
    expect(renderCliUpdateCommand(apostrophes, 'powershell')).toBe("& 'C:\\Users\\O\u2019\u2019Brien\\it''s\\claude.exe' update");
    expect(renderCliUpdateCommand(apostrophes, 'posix')).toBe("'C:\\Users\\O\u2019Brien\\it'\\''s\\claude.exe' update");
    // cmd.exe expands % even inside quotes, and a quote would end the token.
    expect(renderCliUpdateCommand({ program: 'C:\\x\\%PATH%\\claude.exe', args: ['update'] }, 'cmd')).toBeUndefined();
    expect(renderCliUpdateCommand({ program: 'C:\\x\\a"b\\claude.exe', args: ['update'] }, 'cmd')).toBeUndefined();
    expect(renderCliUpdateCommand({ program: 'C:\\x\\a\nb\\claude.exe', args: ['update'] }, 'powershell')).toBeUndefined();
    // Arguments are fixed words; anything else is never written into a command line.
    expect(renderCliUpdateCommand({ program: 'npm', args: ['install', '-g', 'x; rm -rf ~'] }, 'posix')).toBeUndefined();
  });
});

describe('the identity of a program file (v0.9.96)', () => {
  it('changes when a link is pointed elsewhere or the file is replaced in place, and is undefined for no file', () => {
    const files = new Map<string, { dev: number; ino: number; size: number; mtimeMs: number }>([
      ['C:\\versions\\A\\claude.exe', { dev: 1, ino: 10, size: 100, mtimeMs: 499_000_000_000.4 }],
      ['C:\\versions\\B\\claude.exe', { dev: 1, ino: 11, size: 100, mtimeMs: 499_000_000_000.4 }],
    ]);
    const links = new Map([['C:\\bin\\claude.exe', 'C:\\versions\\A\\claude.exe']]);
    const fs = {
      realpath: (candidate: string) => links.get(candidate) ?? candidate,
      stat: (candidate: string) => { const stat = files.get(candidate); if (!stat) throw new Error('ENOENT'); return stat; },
    };
    const first = cliProgramStamp('C:\\bin\\claude.exe', fs);
    expect(first).toBe('C:\\versions\\A\\claude.exe|1|10|100|499000000000');
    expect(cliProgramStamp('C:\\bin\\claude.exe', fs)).toBe(first);
    links.set('C:\\bin\\claude.exe', 'C:\\versions\\B\\claude.exe');
    expect(cliProgramStamp('C:\\bin\\claude.exe', fs)).not.toBe(first);
    links.set('C:\\bin\\claude.exe', 'C:\\versions\\A\\claude.exe');
    // npm publishes files with one fixed modification time, so a replaced file is told apart by its file number.
    files.set('C:\\versions\\A\\claude.exe', { dev: 1, ino: 12, size: 100, mtimeMs: 499_000_000_000.4 });
    expect(cliProgramStamp('C:\\bin\\claude.exe', fs)).not.toBe(first);
    expect(cliProgramStamp('C:\\missing\\claude.exe', fs)).toBeUndefined();
  });
});

describe('the folder a CLI program starts in (v0.9.96)', () => {
  const folder = 'C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\globalStorage\\unode\\cli-runtime-check';
  const fsWith = (links: Record<string, string> = {}, mkdir: () => void = () => undefined) => {
    const made: string[] = [];
    return {
      made,
      fs: { mkdir: (candidate: string) => { mkdir(); made.push(candidate); }, realpath: (candidate: string) => links[candidate] ?? candidate },
    };
  };

  it('prepares the host-owned folder and returns its physical path', () => {
    const { fs, made } = fsWith({ [folder]: 'D:\\profile\\cli-runtime-check' });
    expect(prepareNeutralFolder(folder, ['C:\\repo'], fs, 'win32')).toBe('D:\\profile\\cli-runtime-check');
    expect(made).toEqual([folder]);
  });

  it('refuses no storage, a relative folder, and a folder that cannot be made, so nothing starts elsewhere', () => {
    expect(() => prepareNeutralFolder(undefined, [], fsWith().fs, 'win32')).toThrow('UnodeAi has no storage folder of its own to start a CLI program in. Nothing was started.');
    expect(() => prepareNeutralFolder('cli-runtime-check', [], fsWith().fs, 'win32')).toThrow(/no storage folder/);
    const denied = fsWith({}, () => { throw new Error('EPERM: operation not permitted'); });
    expect(() => prepareNeutralFolder(folder, [], denied.fs, 'win32'))
      .toThrow('UnodeAi could not prepare its folder for CLI programs (EPERM: operation not permitted). Nothing was started.');
  });

  it('refuses a folder inside a workspace, as written or after its links are resolved, in either case', () => {
    expect(() => prepareNeutralFolder('C:\\Repo\\.storage\\check', ['c:\\repo'], fsWith().fs, 'win32')).toThrow(/is inside a workspace folder/);
    const redirected = fsWith({ [folder]: 'C:\\repo\\.vscode\\check' });
    expect(() => prepareNeutralFolder(folder, ['C:\\repo'], redirected.fs, 'win32')).toThrow(/leads into a workspace folder/);
    // The workspace itself reached through a link.
    const linkedRoot = fsWith({ [folder]: 'D:\\real\\repo\\check', 'C:\\repo': 'D:\\real\\repo' });
    expect(() => prepareNeutralFolder(folder, ['C:\\repo'], linkedRoot.fs, 'win32')).toThrow(/leads into a workspace folder/);
    expect(prepareNeutralFolder('/home/ada/.config/Code/check', ['/home/ada/repo'], fsWith().fs, 'linux')).toBe('/home/ada/.config/Code/check');
    expect(() => prepareNeutralFolder('/home/ada/repo/check', ['/home/ada/repo'], fsWith().fs, 'linux')).toThrow(/inside a workspace folder/);
  });

  it('treats a child named ..storage as inside, by whole path segments, as written and through a link', () => {
    const cases = [
      { platform: 'win32' as const, root: 'C:\\repo', child: 'C:\\repo\\..storage\\check', outside: 'C:\\host\\check',
        parent: 'C:\\repo\\..\\storage\\check', sibling: 'C:\\repo-storage\\check' },
      { platform: 'linux' as const, root: '/repo', child: '/repo/..storage/check', outside: '/host/check',
        parent: '/repo/../storage/check', sibling: '/repo-storage/check' },
    ];
    for (const { platform, root, child, outside, parent, sibling } of cases) {
      const made: string[] = [];
      const plain = { mkdir: (candidate: string) => { made.push(candidate); }, realpath: (candidate: string) => candidate };
      expect(() => prepareNeutralFolder(child, [root], plain, platform), platform).toThrow(/is inside a workspace folder/);
      expect(made, platform).toEqual([]);
      expect(() => prepareNeutralFolder(root, [root], plain, platform), platform).toThrow(/is inside a workspace folder/);
      const redirected = { mkdir: () => undefined, realpath: (candidate: string) => (candidate === outside ? child : candidate) };
      expect(() => prepareNeutralFolder(outside, [root], redirected, platform), platform).toThrow(/leads into a workspace folder/);
      // A real parent segment and a sibling whose name starts like the root are outside.
      expect(prepareNeutralFolder(parent, [root], plain, platform), platform).toBe(parent);
      expect(prepareNeutralFolder(sibling, [root], plain, platform), platform).toBe(sibling);
    }
  });
});

describe('the latest published version (v0.9.96)', () => {
  it('asks npm only for the package\'s public latest document', () => {
    expect(cliLatestVersionUrl('claude-cli')).toBe('https://registry.npmjs.org/@anthropic-ai/claude-code/latest');
    expect(cliLatestVersionUrl('codex-cli')).toBe('https://registry.npmjs.org/@openai/codex/latest');
  });

  it('takes only a release version of that package from the answer', () => {
    expect(parseNpmLatestVersion('codex-cli', JSON.stringify({ name: '@openai/codex', version: '0.163.0', bin: {} }))).toBe('0.163.0');
    expect(parseNpmLatestVersion('claude-cli', JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.302' }))).toBe('2.1.302');
    expect(() => parseNpmLatestVersion('codex-cli', JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.302' }))).toThrow(/another package/);
    expect(() => parseNpmLatestVersion('codex-cli', JSON.stringify({ name: '@openai/codex', version: '0.164.0-alpha.1' }))).toThrow(/no release version/);
    expect(() => parseNpmLatestVersion('codex-cli', JSON.stringify({ name: '@openai/codex', version: 163 }))).toThrow(/no release version/);
    expect(() => parseNpmLatestVersion('codex-cli', '<html>')).toThrow(/package document/);
    expect(() => parseNpmLatestVersion('codex-cli', 'null')).toThrow(/another package/);
  });

  it('compares release numbers, a prerelease below its release, and claims nothing about a non-version', () => {
    expect(compareCliVersions('0.155.1', '0.163.0')).toBe(-1);
    expect(compareCliVersions('2.1.209', '2.1.302')).toBe(-1);
    expect(compareCliVersions('2.1.302', '2.1.302')).toBe(0);
    expect(compareCliVersions('2.1.310', '2.1.302')).toBe(1);
    expect(compareCliVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareCliVersions('0.163.0-alpha.2', '0.163.0')).toBe(-1);
    expect(compareCliVersions('0.162.0-alpha.17.2', '0.163.0')).toBe(-1);
    expect(compareCliVersions('unknown', '0.163.0')).toBeUndefined();
  });

  it('reads an answer only up to its limit, and cancels a longer one', async () => {
    const stream = (chunks: string[]) => {
      let index = 0;
      let cancelled = false;
      return {
        get cancelled() { return cancelled; },
        body: {
          getReader: () => ({
            read: async () => index < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[index++]) } : { done: true },
            cancel: async () => { cancelled = true; },
          }),
        },
        text: async () => { throw new Error('the stream is read, not text()'); },
      };
    };
    expect(await readBoundedText(stream(['{"a":', '1}']), 16)).toBe('{"a":1}');
    const long = stream(['12345678', '12345678', '1']);
    await expect(readBoundedText(long, 16)).rejects.toThrow(/more than UnodeAi reads/);
    expect(long.cancelled).toBe(true);
    await expect(readBoundedText({ text: async () => 'x'.repeat(17) }, 16)).rejects.toThrow(/more than UnodeAi reads/);
    expect(await readBoundedText({ text: async () => 'x'.repeat(16) }, 16)).toBe('x'.repeat(16));
  });
});
