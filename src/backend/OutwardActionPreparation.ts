import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandShellIdentity } from './CommandShell';
import { literalCommandSegments } from './CommandPolicy';
import { classifyOutwardCommand, type ClassifiedOutwardCommand, type OutwardOperationKind } from './OutwardActionClassification';
import { resolveHostExecutable } from '../security/HostExecutableResolver';
import { sanitizedCommandEnv } from './commandEnv';
import { isPathInsideOrEqual } from './pathContainment';
import { captureCwdIdentity, comparableRealpath, sameCwdIdentity, type CwdIdentityResult } from './commandStartCheck';

export interface OutwardPreparationInput {
  command: string;
  cwd: string;
  shell: CommandShellIdentity;
  /** The host-owned environment for this prepared execution, never a model-provided metadata program. */
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface PreparedOutwardEffect {
  readonly kind: OutwardOperationKind;
  readonly executable: string;
  readonly segmentIndex: number;
  /** Human-facing destination, with URL credentials/query/fragment removed. Not a log/ledger field. */
  readonly destination: string;
  readonly content: string;
}

export interface PreparedOutwardCommand {
  readonly status: 'none' | 'preview' | 'ready' | 'unresolved';
  readonly effects: readonly PreparedOutwardEffect[];
  /** Host-private binding, never a log, model or durable-history field. */
  readonly fingerprint: string;
  readonly reason?: string;
  /** Compare the same action's current local proposal; this does not execute, authorize or replay it. */
  revalidate(): Promise<boolean>;
}

/** Invocation identity only: no package/Git metadata, environment resolution or effect permission. */
export interface PreparedOutwardBinding {
  readonly fingerprint: string;
  revalidate(): Promise<boolean>;
}

interface Snapshot {
  status: PreparedOutwardCommand['status'];
  effects: PreparedOutwardEffect[];
  fingerprint: string;
  reason?: string;
}

class Unresolved extends Error {}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const snapshot = (status: Snapshot['status'], facts: unknown, effects: PreparedOutwardEffect[] = [], reason?: string): Snapshot =>
  ({ status, effects, fingerprint: digest(JSON.stringify([status, facts, effects, reason])), ...(reason ? { reason } : {}) });

/**
 * Prepare only the closed direct-command vocabulary. No shell, package manager, script, build or network
 * operation runs here. Local Git queries use the host-selected executable and read-only argument arrays.
 * This is effect preparation for the existing execution/approval owner, not a new permission service.
 */
export async function prepareOutwardCommand(input: OutwardPreparationInput): Promise<PreparedOutwardCommand> {
  // Capture caller-owned objects: a pending proposal cannot silently become a different command/environment.
  const captured = { ...input, shell: { ...input.shell }, environment: { ...(input.environment ?? process.env) } };
  const inspected = await inspect(captured);
  const binding = inspected.status === 'unresolved' ? await prepareOutwardBinding(captured) : undefined;
  const prepared = binding ? { ...inspected, fingerprint: digest(JSON.stringify([inspected.fingerprint, binding.fingerprint])) } : inspected;
  return { ...prepared, effects: Object.freeze(prepared.effects.map(effect => Object.freeze({ ...effect }))),
    revalidate: async () => {
      if (captured.signal?.aborted) return false;
      // No destination/content was shown. The approval covers this captured command/cwd/shell,
      // with uncertainty disclosed, rather than a proposal invented later from changing metadata.
      if (prepared.status === 'unresolved') return binding?.revalidate() ?? true;
      const current = await inspect(captured);
      return current.status === prepared.status && current.fingerprint === prepared.fingerprint;
    } };
}

/** Unknown effects still belong to the folder the person approved; do not turn later metadata into a new proposal. */
export async function prepareOutwardBinding(input: Pick<OutwardPreparationInput, 'command' | 'cwd' | 'shell' | 'signal'>): Promise<PreparedOutwardBinding> {
  const captured = { ...input, shell: { ...input.shell } };
  const cwdIdentity: CwdIdentityResult = captured.signal?.aborted ? { kind: 'unavailable', cwd: captured.cwd } : await captureCwdIdentity(captured.cwd);
  const identityFacts = cwdIdentity.kind === 'physical' ? [comparableRealpath(cwdIdentity.realpath), cwdIdentity.dev, cwdIdentity.ino] : undefined;
  return { fingerprint: digest(JSON.stringify([captured.command, captured.cwd, captured.shell.fingerprint, identityFacts])),
    revalidate: async () => {
      if (captured.signal?.aborted) return false;
      // S4.2: an identity that could not be observed is captured again, never approved on the old path binding. A
      // folder that resolves now appeared after the approval (changed); one that still does not lets the shell fail.
      return await sameCwdIdentity(cwdIdentity) !== 'changed';
    } };
}

async function inspect(input: OutwardPreparationInput): Promise<Snapshot> {
  const classification = classifyOutwardCommand(input.command, input.shell);
  if (!classification.operations.length) return snapshot('none', [input.command, input.shell.fingerprint]);
  let cwdIdentity: readonly string[] | undefined;
  try {
    checkCancelled(input.signal);
    const segments = literalCommandSegments(input.command, input.shell)!;
    // Earlier commands may cd, rewrite config/refs/content, or publish a different proposal before the final
    // command runs. One shell invocation is not a transaction; do not resolve every segment against old state.
    if (segments.length !== 1) throw new Unresolved('This command chains operations that may change the working folder, destination, refs or content before publication.');
    const operation = classification.operations[0];
    const assignments = prefixAssignments(operation.argv);
    if (assignments.some(([key]) => !/^(?:CI|NO_COLOR|FORCE_COLOR|GIT_TRACE(?:_[A-Z0-9_]+)?)$/.test(key))) {
      throw new Unresolved('Use explicit destination options instead of an environment prefix that can change command resolution or configuration.');
    }
    if (isOutwardPreview(operation)) return snapshot('preview', [input.command, input.shell.fingerprint]);
    const cwd = await fs.realpath(input.cwd);
    const cwdStat = await fs.stat(cwd, { bigint: true });
    if (!cwdStat.isDirectory()) throw new Unresolved('Choose an existing command working directory.');
    cwdIdentity = [cwd, String(cwdStat.dev), String(cwdStat.ino)];
    const reader = new ProposalReader(cwd, input.environment ?? process.env, input.signal);
    const effects = operation.executable === 'git'
      ? await prepareGit(operation, reader)
      : ['npm', 'pnpm', 'yarn', 'vsce', 'ovsx'].includes(operation.executable)
        ? await preparePackage(operation, reader)
        : await prepareExplicitArtifact(operation, reader);
    checkCancelled(input.signal);
    return snapshot('ready', [input.command, input.shell.fingerprint, cwd, String(cwdStat.dev), String(cwdStat.ino), reader.facts], effects);
  } catch (error) {
    return snapshot('unresolved', [input.command, input.cwd, input.shell.fingerprint, cwdIdentity], [],
      error instanceof Unresolved ? error.message : input.signal?.aborted
        ? 'The prepared command is no longer active.' : 'The local destination or proposed content could not be read. Nothing was run.');
  }
}

function prefixAssignments(argv: readonly string[]): [string, string][] {
  const result: [string, string][] = [];
  let index = 0;
  const take = () => {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index] ?? '')) {
      const at = argv[index].indexOf('=');
      result.push([argv[index].slice(0, at), argv[index].slice(at + 1)]); index++;
    }
  };
  take();
  if (argv[index] === 'env') { index++; if (argv[index] === '--') index++; take(); }
  return result;
}

export function isOutwardPreview(operation: ClassifiedOutwardCommand): boolean {
  // These flags are operation-specific. A value, a literal ref after `--`, or a later negation is not a preview.
  if (!['git', 'npm', 'pnpm'].includes(operation.executable)) return false;
  const valued = operation.executable === 'git'
    ? new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o', '--recurse-submodules'])
    : new Set(['--tag', '--registry', '--access', '--otp', '--workspace', '-w', '--userconfig']);
  let preview = false;
  for (let index = 0; index < operation.arguments.length; index++) {
    const arg = operation.arguments[index];
    if (arg === '--') break;
    const at = arg.indexOf('='); const key = at > 0 ? arg.slice(0, at) : arg;
    if (valued.has(key)) { if (at < 0) index++; continue; }
    if (arg === '--no-dry-run' || arg === '--dry-run=false') preview = false;
    else if (arg === '--dry-run' || operation.executable === 'git' && arg === '-n'
      || operation.executable !== 'git' && arg === '--dry-run=true') preview = true;
    else if (arg.startsWith('-') && !/^(?:--(?:force(?:-with-lease(?:=.*)?|-if-includes)?|atomic|porcelain|progress|quiet|verbose|no-verify|verify|ipv[46]|no-follow-tags|all|tags|delete|prune|set-upstream|ignore-scripts(?:=(?:true|false))?|no-ignore-scripts|provenance|no-provenance|json)|-[fqv46du])$/.test(arg)) return false;
  }
  return preview;
}

class ProposalReader {
  readonly facts: unknown[] = [];
  constructor(readonly cwd: string, readonly env: NodeJS.ProcessEnv, readonly signal?: AbortSignal) {}
  async text(file: string, optional = false): Promise<string | undefined> {
    checkCancelled(this.signal);
    const target = path.resolve(this.cwd, file);
    try {
      const physical = await fs.realpath(target);
      const data = await fs.readFile(physical);
      this.facts.push(['file', target, physical, digest(data)]);
      return data.toString('utf8');
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') { this.facts.push(['absent', target]); return undefined; }
      throw error;
    }
  }
  async artifact(file: string): Promise<string> {
    const target = await fs.realpath(path.resolve(this.cwd, file));
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Unresolved('Name an existing regular artifact file to publish.');
    const hash = createHash('sha256');
    const handle = await fs.open(target, 'r');
    try { for await (const chunk of handle.createReadStream({ autoClose: false })) { checkCancelled(this.signal); hash.update(chunk); } }
    finally { await handle.close(); }
    const sha = hash.digest('hex');
    this.facts.push(['artifact', path.resolve(this.cwd, file), target, stat.size, sha]);
    return `${path.basename(target)} (${stat.size} bytes; SHA-256 ${sha})`;
  }
  async sourceTree(directory: string): Promise<string> {
    const root = await fs.realpath(directory);
    const hash = createHash('sha256');
    const visited = new Set<string>();
    const key = (target: string) => process.platform === 'win32' ? target.toLowerCase() : target;
    const resolveSource = async (target: string) => {
      const physical = await fs.realpath(target);
      if (!isPathInsideOrEqual(root, physical)) throw new Unresolved('Replace source links that lead outside this package with regular source files, or publish a prepared VSIX for an extension.');
      return physical;
    };
    const walk = async (current: string, logical = '', ancestors = new Set<string>()) => {
      const physical = await resolveSource(current); const canonical = key(physical);
      if (ancestors.has(canonical)) throw new Unresolved('Replace cyclic source links with regular source files before publishing this source package.');
      const mode = (await fs.stat(physical)).mode & 0o777;
      hash.update(JSON.stringify(['directory', logical, physical, mode]));
      if (visited.has(canonical)) return;
      visited.add(canonical); const nested = new Set(ancestors).add(canonical);
      for (const entry of (await fs.readdir(physical, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        checkCancelled(this.signal);
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const target = path.join(physical, entry.name); const relative = [logical, entry.name].filter(Boolean).join('/');
        const resolved = await resolveSource(target);
        const stat = await fs.stat(resolved);
        if (entry.isSymbolicLink()) hash.update(JSON.stringify(['link', relative, await fs.readlink(target), resolved]));
        if (stat.isDirectory()) await walk(resolved, relative, nested);
        else if (stat.isFile()) { const contents = createHash('sha256'); const handle = await fs.open(resolved, 'r');
          try { for await (const chunk of handle.createReadStream({ autoClose: false })) { checkCancelled(this.signal); contents.update(chunk); } }
          finally { await handle.close(); } hash.update(JSON.stringify(['file', relative, stat.mode & 0o777, contents.digest('hex')])); }
        else throw new Unresolved('Prepare a regular package or artifact before publishing this special-file source tree.');
      }
    };
    await walk(root);
    const sha = hash.digest('hex'); this.facts.push(['source-tree', root, sha]);
    return `source tree ${root} (excluding .git and node_modules; source inputs, not a prebuilt package archive)`;
  }
  async git(globalOptions: readonly string[], args: readonly string[], optional = false): Promise<string> {
    checkCancelled(this.signal);
    const git = resolveHostExecutable('git', { workspaceRoots: [this.cwd], env: this.env });
    const env = sanitizedCommandEnv(this.env);
    // Trace variables may write files. They do not change the proposal and must not write before approval.
    for (const key of Object.keys(env)) if (/^GIT_TRACE/i.test(key)) delete env[key];
    env.GIT_OPTIONAL_LOCKS = '0'; env.GIT_TERMINAL_PROMPT = '0';
    const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
      execFile(git, ['--no-optional-locks', '--no-pager', ...globalOptions,
        '-c', 'core.fsmonitor=false', ...args], { cwd: this.cwd, env, windowsHide: true,
        encoding: 'utf8', signal: this.signal, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (!error) resolve({ code: 0, output: stdout });
        else if (typeof error.code === 'number') resolve({ code: error.code, output: stdout }); else reject(error);
      });
    });
    this.facts.push(['git', globalOptions, args, result.code, digest(result.output)]);
    if (result.code !== 0 && !optional) throw new Unresolved('Git could not resolve the local push destination and refs. Specify a remote and explicit refspec.');
    return result.code === 0 ? result.output.replace(/\r?\n$/, '') : '';
  }
}

async function prepareGit(operation: ClassifiedOutwardCommand, reader: ProposalReader): Promise<PreparedOutwardEffect[]> {
  const configText = await reader.git(operation.globalOptions, ['config', '--null', '--list']);
  const config = new Map<string, string[]>();
  for (const line of configText.split('\0').filter(Boolean)) {
    const at = line.indexOf('\n'); if (at < 0) continue;
    const key = configKey(line.slice(0, at)); const value = line.slice(at + 1);
    config.set(key, [...(config.get(key) ?? []), value]);
  }
  const value = (key: string) => config.get(configKey(key))?.at(-1);
  const head = await reader.git(operation.globalOptions, ['symbolic-ref', '--quiet', 'HEAD'], true);
  const branch = head.startsWith('refs/heads/') ? head.slice(11) : undefined;
  const refsText = await reader.git(operation.globalOptions, ['for-each-ref', '--format=%(refname)%00%(objectname)']);
  const refs = new Map(refsText.split('\n').filter(Boolean).map(line => line.split('\0') as [string, string]));
  const operands: string[] = []; const flags: string[] = [];
  const supportedFlags = new Set(['--force', '-f', '--force-with-lease', '--force-if-includes', '--atomic', '--porcelain',
    '--progress', '--quiet', '-q', '--verbose', '-v', '--no-verify', '--verify', '--ipv4', '-4', '--ipv6', '-6', '--no-follow-tags',
    '--all', '--tags', '--delete', '-d', '--prune', '--no-dry-run', '-u', '--set-upstream']);
  for (let index = 0; index < operation.arguments.length; index++) {
    const arg = operation.arguments[index];
    if (arg === '--') { operands.push(...operation.arguments.slice(index + 1)); break; }
    if (arg.startsWith('--force-with-lease=')) flags.push(arg);
    else if (supportedFlags.has(arg)) flags.push(arg);
    else if (arg.startsWith('-')) throw new Unresolved('This push option needs a separate exact-effect preparation. Use an explicit remote and refspec without that option.');
    else operands.push(arg);
  }
  if (flags.includes('--prune')) throw new Unresolved('List the remote refs to delete explicitly instead of relying on prune.');
  if ((flags.includes('--delete') || flags.includes('-d')) && operands.length < 2) {
    throw new Unresolved('Name the remote and each remote ref to delete explicitly.');
  }
  const remotes = [...new Set([...config.keys()].flatMap(key => /^remote\.(.+)\.(?:url|pushurl)$/.exec(key)?.slice(1, 2) ?? []))];
  const fallbackRemote = remotes.length === 1 ? remotes[0] : 'origin';
  const fetchRemote = branch && value(`branch.${branch}.remote`) || fallbackRemote;
  const remote = operands.shift() ?? (branch && value(`branch.${branch}.pushremote`)) ?? value('remote.pushdefault') ?? fetchRemote;
  const truthy = (setting: string | undefined) => setting !== undefined && !/^(?:false|no|off|0)$/i.test(setting);
  if (truthy(value('push.followtags')) && !flags.includes('--no-follow-tags')) throw new Unresolved('Use --no-follow-tags or publish explicit tag refs as a separate action.');
  if (truthy(value(`remote.${remote}.mirror`)) || value(`remote.${remote}.vcs`)
    || truthy(value('push.recursesubmodules'))) throw new Unresolved('Disable implicit mirror, foreign-helper or submodule pushes, or prepare their exact effects separately.');
  const configured = config.has(`remote.${remote}.url`) || config.has(`remote.${remote}.pushurl`);
  const rawTargets = config.get(`remote.${remote}.pushurl`) ?? config.get(`remote.${remote}.url`);
  if (remote.includes('\n') || rawTargets?.some(target => /[\r\n]/.test(target))) {
    throw new Unresolved('Use a literal push URL without line breaks.');
  }
  const urls = configured ? await reader.git(operation.globalOptions, ['remote', 'get-url', '--push', '--all', remote])
    : rewriteGitUrl(remote, config);
  const destinations = urls.split('\n');
  if (destinations.length !== (configured ? rawTargets!.length : 1) || destinations.some(target => !target || target.includes('\r'))) {
    throw new Unresolved('The push URL configuration does not identify unambiguous destinations.');
  }
  if (!destinations.length || !configured && remote === 'origin') throw new Unresolved('Configure a push remote or name its destination explicitly.');
  if (destinations.some(destination => /^[a-z][a-z0-9+.-]*::/i.test(destination))) {
    throw new Unresolved('A remote-helper command does not identify a fixed push destination. Use an explicit repository URL.');
  }
  const proposals: string[] = [];
  const add = async (spec: string, deletion = false) => {
    const forced = spec.startsWith('+'); if (forced) spec = spec.slice(1);
    const at = spec.indexOf(':'); const source = at < 0 ? spec : spec.slice(0, at); let destination = at < 0 ? '' : spec.slice(at + 1);
    if (deletion || !source && destination) { proposals.push(`delete ${destination || source}`); return; }
    if (!source || source.includes('*') || destination.includes('*')) throw new Unresolved('Use explicit source and destination refs instead of matching or wildcard refspecs.');
    const full = source === 'HEAD' && head ? head : refs.has(source) ? source
      : refs.has(`refs/heads/${source}`) && !refs.has(`refs/tags/${source}`) ? `refs/heads/${source}`
        : refs.has(`refs/tags/${source}`) && !refs.has(`refs/heads/${source}`) ? `refs/tags/${source}` : undefined;
    const sha = full ? refs.get(full) : await reader.git(operation.globalOptions, ['rev-parse', '--verify', '--end-of-options', `${source}^{object}`], true);
    if (!sha || !/^[0-9a-f]{40,64}$/i.test(sha)) throw new Unresolved('Resolve the local source ref before requesting this push.');
    if (!destination) destination = full ?? '';
    else if (!destination.startsWith('refs/') && full?.startsWith('refs/heads/')) destination = `refs/heads/${destination}`;
    else if (!destination.startsWith('refs/') && full?.startsWith('refs/tags/')) destination = `refs/tags/${destination}`;
    if (!destination.startsWith('refs/')) throw new Unresolved('Name the full destination ref, such as refs/heads/main.');
    proposals.push(`${forced ? 'force ' : ''}${source} (${sha}) → ${destination}`);
  };
  if (flags.includes('--all')) for (const [ref] of refs) if (ref.startsWith('refs/heads/')) await add(ref);
  if (flags.includes('--tags')) for (const [ref] of refs) if (ref.startsWith('refs/tags/')) await add(ref);
  if (operands.length) {
    for (let index = 0; index < operands.length; index++) {
      const spec = operands[index] === 'tag' ? `refs/tags/${operands[++index] ?? ''}` : operands[index];
      await add(spec, flags.includes('--delete') || flags.includes('-d'));
    }
  } else if (!flags.includes('--all') && !flags.includes('--tags')) {
    const refspecs = config.get(`remote.${remote}.push`);
    if (refspecs?.length) for (const spec of refspecs) await add(spec);
    else {
      if (!branch) throw new Unresolved('Name an explicit refspec when pushing from detached HEAD.');
      const mode = value('push.default') ?? 'simple';
      const upstreamRemote = value(`branch.${branch}.remote`); const upstream = value(`branch.${branch}.merge`);
      if (mode === 'current' || mode === 'simple' && fetchRemote !== remote) await add(head);
      else if (mode === 'upstream' || mode === 'simple') {
        if (!upstream || upstreamRemote !== remote || mode === 'simple' && upstream !== head) {
          throw new Unresolved('Name an explicit refspec or configure a matching upstream before pushing.');
        }
        await add(`${head}:${upstream}`);
      } else throw new Unresolved('Name explicit refs instead of relying on matching or disabled default push behavior.');
    }
  }
  if (!proposals.length) throw new Unresolved('Name an existing local ref to push.');
  const content = `${proposals.join('\n')}${flags.length ? `\nOptions: ${flags.join(' ')}` : ''}`;
  const effects: PreparedOutwardEffect[] = [];
  for (const destination of destinations) {
    reader.facts.push(['push-destination', destination]);
    effects.push(effect(operation, await gitDestination(destination, reader), content));
  }
  return effects;
}

function rewriteGitUrl(raw: string, config: Map<string, string[]>): string {
  // Git's remote.c add_url_alias uses the longest pushInsteadOf prefix, or otherwise insteadOf.
  for (const kind of ['pushinsteadof', 'insteadof']) {
    let match: { prefix: string; replacement: string } | undefined;
    for (const [key, values] of config) {
      if (!key.startsWith('url.')) continue;
      const parsed = /^url\.(.+)\.(pushinsteadof|insteadof)$/.exec(key);
      if (!parsed || values.some(value => /[\r\n]/.test(value))) throw new Unresolved('The Git URL rewrite needs an unambiguous literal push destination.');
      if (parsed[2] !== kind) continue;
      for (const prefix of values) if (raw.startsWith(prefix) && (!match || prefix.length > match.prefix.length)) match = { prefix, replacement: parsed[1] };
    }
    if (match) return match.replacement + raw.slice(match.prefix.length);
  }
  return raw;
}

async function gitDestination(destination: string, reader: ProposalReader): Promise<string> {
  const local = destination.startsWith('file://') ? fileURLToPath(destination) : path.isAbsolute(destination) ? destination : undefined;
  if (local) {
    const physical = await fs.realpath(local); const stat = await fs.stat(physical, { bigint: true });
    reader.facts.push(['local-push-target', physical, String(stat.dev), String(stat.ino)]);
    return physical;
  }
  if (/^[A-Za-z]:/.test(destination) && process.platform === 'win32'
    || !/^(?:https?|ssh|git):\/\//i.test(destination) && !/^(?:[^@/\s]+@)?[^:/\s]+:.+/.test(destination)) {
    throw new Unresolved('Use an absolute local repository path or an explicit supported Git URL as the push destination.');
  }
  return cleanDestination(destination);
}

function configKey(key: string): string {
  const first = key.indexOf('.'); const last = key.lastIndexOf('.');
  return first < 0 ? key.toLowerCase() : first === last ? key.toLowerCase()
    : key.slice(0, first).toLowerCase() + key.slice(first, last + 1) + key.slice(last + 1).toLowerCase();
}

async function preparePackage(operation: ClassifiedOutwardCommand, reader: ProposalReader): Promise<PreparedOutwardEffect[]> {
  const args = parseOptions(operation.arguments,
    new Set(['--registry', '--registryUrl', '-r', '--packagePath', '-i', '--tag', '--access', '--target', '--baseContentUrl', '--baseImagesUrl', '--packageVersion', '--otp', '--pat', '-p']),
    new Set(['--ignore-scripts', '--ignore-scripts=true', '--ignore-scripts=false', '--no-ignore-scripts', '--provenance', '--no-provenance', '--json', '--pre-release', '--no-dependencies', '--skip-duplicate', '--yarn', '--no-git-tag-version', '--no-dry-run']));
  if (operation.executable === 'yarn') throw new Unresolved('Yarn publish registry configuration needs an explicit supported preparation; use a prepared artifact with an explicit registry command.');
  const extension = operation.executable === 'vsce' || operation.executable === 'ovsx';
  const candidate = args.options.get('--packagePath') ?? args.options.get('-i') ?? args.operands[0];
  const artifact = candidate && /\.(?:vsix|tgz)$/i.test(candidate) ? candidate : undefined;
  if (artifact && !extension) throw new Unresolved('The npm archive namespace is not resolved by this preparation. Publish from its source directory with an explicit registry instead.');
  if (args.operands.length > 1 || !artifact && operation.executable === 'vsce' && args.operands.length) {
    throw new Unresolved('Publish one prepared package at a time without a positional version change.');
  }
  const directory = candidate && !artifact ? path.resolve(reader.cwd, candidate) : reader.cwd;
  const manifestText = artifact ? undefined : await reader.text(path.join(directory, 'package.json'));
  const manifest = manifestText ? JSON.parse(manifestText) as Record<string, unknown> : undefined;
  if (manifest) {
    const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts as Record<string, unknown> : {};
    const hasScript = (name: string) => typeof scripts[name] === 'string' && scripts[name].trim().length > 0;
    const ignoresScripts = (args.flags.has('--ignore-scripts') || args.flags.has('--ignore-scripts=true'))
      && !args.flags.has('--ignore-scripts=false') && !args.flags.has('--no-ignore-scripts');
    if (!extension && ['prepublishOnly', 'prepack', 'prepare', 'postpack', 'publish', 'postpublish'].some(hasScript) && !ignoresScripts) {
      throw new Unresolved('Publishing lifecycle scripts may change the destination or built package after preparation. A build in a separate ordinary command followed by --ignore-scripts makes the source proposal inspectable.');
    }
    if (extension && hasScript('vscode:prepublish')) {
      throw new Unresolved('The vscode:prepublish script may rebuild this extension during publication; a prepared VSIX has inspectable upload bytes.');
    }
    const publishConfig = manifest.publishConfig && typeof manifest.publishConfig === 'object' ? manifest.publishConfig as Record<string, unknown> : {};
    if (operation.executable === 'pnpm' && typeof publishConfig.directory === 'string' && publishConfig.directory.length > 0) {
      throw new Unresolved('The publishConfig.directory redirect leaves the actual publication folder unresolved.');
    }
    if (extension && manifest.vsce && typeof manifest.vsce === 'object' && Object.keys(manifest.vsce).length > 0) {
      throw new Unresolved('Manifest VSCE packaging options may change the packaged inputs; a prepared VSIX has inspectable upload bytes.');
    }
  }
  let destination: string;
  if (extension) destination = operation.executable === 'vsce'
    ? reader.env.VSCE_MARKETPLACE_URL ?? 'https://marketplace.visualstudio.com'
    : args.options.get('--registryUrl') ?? args.options.get('-r') ?? reader.env.OVSX_REGISTRY_URL ?? 'https://open-vsx.org';
  else destination = npmRegistry(manifest, args.options, operation.executable);
  if (!/^https?:\/\//i.test(destination)) throw new Unresolved('Name an HTTP or HTTPS publishing registry explicitly.');
  const description = artifact ? await reader.artifact(artifact) : await packageSource(manifest, directory, reader, extension);
  reader.facts.push(['package-destination', destination]);
  return [effect(operation, cleanDestination(destination), description + (args.options.has('--tag') ? `\nTag: ${args.options.get('--tag')}` : ''))];
}

async function packageSource(manifest: Record<string, unknown> | undefined, directory: string, reader: ProposalReader, extension: boolean): Promise<string> {
  if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string'
    || extension && typeof manifest.publisher !== 'string') throw new Unresolved('Prepare a package manifest with its name, version and publishing namespace.');
  if (manifest.bundleDependencies || manifest.bundledDependencies) throw new Unresolved('Bundled-dependency package content needs a supported artifact preparation before publication.');
  return `${extension ? `${manifest.publisher}.` : ''}${manifest.name}@${manifest.version}\n${await reader.sourceTree(directory)}`;
}

function npmRegistry(manifest: Record<string, unknown> | undefined, options: Map<string, string>, executable: string): string {
  const publishConfig = manifest?.publishConfig && typeof manifest.publishConfig === 'object' ? manifest.publishConfig as Record<string, unknown> : {};
  const scope = typeof manifest?.name === 'string' && manifest.name.startsWith('@') ? manifest.name.split('/')[0] : undefined;
  // npm's effective configuration includes installation-specific global config. Reading a few guessed .npmrc
  // files is not proof of its registry. Scoped registries also outrank a plain --registry option.
  const selected = scope ? options.get(`--${scope}:registry`) : options.get('--registry')
    ?? (executable === 'npm' && typeof publishConfig.registry === 'string' ? publishConfig.registry : undefined);
  if (!selected) throw new Unresolved(scope
    ? `The scoped registry from configuration is unresolved; --${scope}:registry=https://your-registry/ identifies it explicitly.`
    : 'The publishing registry from configuration is unresolved; --registry=https://your-registry/ identifies it explicitly.');
  if (selected.includes('${')) throw new Unresolved('Use an explicit literal registry instead of an unresolved configuration variable.');
  return selected;
}

async function prepareExplicitArtifact(operation: ClassifiedOutwardCommand, reader: ProposalReader): Promise<PreparedOutwardEffect[]> {
  if (operation.executable === 'twine') {
    const args = parseOptions(operation.arguments, new Set(['--repository-url', '--repository', '-r', '--username', '-u', '--password', '-p', '--cert', '--client-cert', '--config-file']),
      new Set(['--skip-existing', '--non-interactive', '--disable-progress-bar', '--verbose']));
    const target = args.options.get('--repository-url') ?? reader.env.TWINE_REPOSITORY_URL;
    if (!target || args.options.has('--repository') || args.options.has('-r') || args.options.has('--config-file')) {
      throw new Unresolved('Name the publishing endpoint with --repository-url and literal artifact paths.');
    }
    if (!args.operands.length) throw new Unresolved('Name the artifact files to upload.');
    const content: string[] = []; for (const file of args.operands) content.push(await reader.artifact(file));
    reader.facts.push(['artifact-destination', target]);
    return [effect(operation, cleanDestination(target), content.join('\n'))];
  }
  if (operation.executable === 'dotnet') {
    const args = parseOptions(operation.arguments, new Set(['--source', '-s', '--api-key', '-k', '--symbol-source', '--symbol-api-key', '--timeout']),
      new Set(['--skip-duplicate', '--no-symbols', '--disable-buffering', '--no-service-endpoint', '--interactive']));
    const target = args.options.get('--source') ?? args.options.get('-s');
    if (!target || !/^https?:\/\//i.test(target) || args.options.has('--symbol-source') || !args.flags.has('--no-symbols')) {
      throw new Unresolved('Name an explicit HTTP(S) --source and --no-symbols, or prepare the symbol upload as a separate action.');
    }
    if (args.operands.length !== 1) throw new Unresolved('Name one literal NuGet artifact.');
    reader.facts.push(['artifact-destination', target]);
    return [effect(operation, cleanDestination(target), await reader.artifact(args.operands[0]))];
  }
  throw new Unresolved(`The ${operation.executable} action has no local adapter to determine its destination and content before running.`);
}

function parseOptions(args: readonly string[], valued: Set<string>, boolean: Set<string>) {
  const options = new Map<string, string>(); const flags = new Set<string>(); const operands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { operands.push(...args.slice(index + 1)); break; }
    const at = arg.indexOf('='); const key = at > 0 ? arg.slice(0, at) : arg;
    if (valued.has(key) || /^--@[A-Za-z0-9._-]+:registry$/.test(key)) { const value = at > 0 ? arg.slice(at + 1) : args[++index];
      if (!value || options.has(key)) throw new Unresolved('Use one literal value for each publishing option.'); options.set(key, value); }
    else if (boolean.has(arg)) flags.add(arg);
    else if (arg.startsWith('-')) throw new Unresolved('This publishing option needs an exact-effect preparation before it can run.');
    else operands.push(arg);
  }
  return { options, flags, operands };
}

function cleanDestination(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value.replace(/^(?:[^@\s]+@)(?=[^:\s]+:)/, '');
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
  catch { throw new Unresolved('Name a valid publishing destination without embedding credentials in it.'); }
}
function effect(operation: ClassifiedOutwardCommand, destination: string, content: string): PreparedOutwardEffect {
  return { kind: operation.kind, executable: operation.executable, segmentIndex: operation.segmentIndex, destination, content };
}
function checkCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Unresolved('The prepared command is no longer active.'); }
