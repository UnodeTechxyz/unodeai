/*---------------------------------------------------------------------------------------------
 *  UnodeAi - commandNormalize  (agent robustness, structural backstop)
 *  Weak/cheap agents repeatedly run test/type/lint runners DIRECTLY (e.g. `npx vitest`) instead of
 *  the project's own scripts. That fails in two ways: bare `vitest` launches WATCH mode (never exits
 *  → run_command times out), and a direct call bypasses the flags the project script bakes in. The
 *  agent then misattributes the failure to "broken infrastructure".
 *
 *  This rewrites a direct runner invocation into the project's matching npm script (so it can't get it
 *  wrong), and — when there's no matching script — at least forces vitest out of watch mode. Pure and
 *  injectable; the project's package manager + scripts come from ProjectConventions.
 *--------------------------------------------------------------------------------------------*/

export interface ProjectCommandInfo {
  /** npm | pnpm | yarn | bun (defaults to npm). */
  packageManager: string;
  /** package.json scripts: name -> body. */
  scripts: Record<string, string>;
}

export interface NormalizedCommand {
  command: string;
  /** A short note to surface in the tool output so the agent learns to use the project's scripts. */
  note?: string;
}

/** Binaries agents tend to call directly (bypassing the project's scripts) and get wrong. */
const RUNNERS = new Set(['vitest', 'jest', 'mocha', 'tsc', 'eslint', 'playwright']);
const RUNNER_WRAPPERS = new Set(['npx', 'bunx']);      // <wrapper> <runner>
const PM_EXEC = new Set(['exec', 'dlx', 'x']);          // <pm> exec|dlx|x <runner>
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * Locate the runner program in a token list, peeling an npx/pnpm-exec style wrapper. Returns the
 * runner name and the index where its first argument would go, or undefined if this isn't a direct
 * runner invocation (e.g. `npm test`, `pnpm run build` — already going through the project scripts).
 */
function findRunner(tokens: string[]): { runner: string; argInsertIdx: number } | undefined {
  if (tokens.length === 0) {
    return undefined;
  }
  const t0 = tokens[0].toLowerCase();
  // bare: `vitest ...`
  if (RUNNERS.has(t0)) {
    return { runner: t0, argInsertIdx: 1 };
  }
  // `npx vitest`, `bunx vitest` (skip flags like -y / --yes)
  if (RUNNER_WRAPPERS.has(t0)) {
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) { i++; }
    const r = tokens[i]?.toLowerCase();
    return r && RUNNERS.has(r) ? { runner: r, argInsertIdx: i + 1 } : undefined;
  }
  // `pnpm exec vitest`, `yarn dlx vitest`, `bun x vitest`
  if (PACKAGE_MANAGERS.has(t0) && tokens[1] && PM_EXEC.has(tokens[1].toLowerCase())) {
    const r = tokens[2]?.toLowerCase();
    return r && RUNNERS.has(r) ? { runner: r, argInsertIdx: 3 } : undefined;
  }
  // `pnpm vitest`, `yarn vitest`, `bun vitest` (direct bin run). NOT `npm vitest` (invalid) and NOT
  // `<pm> test`/`<pm> run x` (those ARE the project scripts — leave them alone).
  if (PACKAGE_MANAGERS.has(t0) && t0 !== 'npm' && tokens[1] && RUNNERS.has(tokens[1].toLowerCase())) {
    return { runner: tokens[1].toLowerCase(), argInsertIdx: 2 };
  }
  return undefined;
}

type ExplicitRunnerMode = 'one-shot' | 'watch' | 'unspecified';

/**
 * One shared interpretation for both package-script bodies and direct runner invocations.
 *
 * The tokens handed in must be ONE invocation's own arguments. A whole script body is not that: in
 * `npm run lint && vitest` the word `run` belongs to npm, and reading it as vitest's one-shot
 * subcommand promotes a script that watches forever. Use `runnerInvocationModes` to split first.
 */
function explicitRunnerMode(tokens: readonly string[]): ExplicitRunnerMode {
  if (tokens.some((token) => token === '--watch' || token === '-w')) {
    return 'watch';
  }
  if (tokens.some((token) => token === 'run' || token === '--run' || token === '--no-watch')) {
    return 'one-shot';
  }
  return 'unspecified';
}

function isRunnerToken(runner: string, token: string): boolean {
  const bare = token.toLowerCase().replace(/^.*[/\\]/, '');
  return bare === runner || bare === `${runner}.cmd` || bare === `${runner}.js`;
}

/**
 * Tokenise the bounded part of shell syntax needed here: words, quotes, and command separators.
 * Separators inside quotes stay inside their argument, so `echo "&& vitest run"` cannot masquerade
 * as a test command. Command substitution and unquoted groups are deliberately unsupported: they can
 * hide another invocation, and the safe response is to ignore the script and use the direct fallback.
 */
function shellCommandSegments(body: string): string[][] | undefined {
  const text = body.trim();
  if (!text || /\$\(|`/.test(text)) {
    return undefined;
  }

  const segments: string[][] = [];
  let tokens: string[] = [];
  let word = '';
  let wordStarted = false;
  let quote: '"' | "'" | undefined;

  const finishWord = (): void => {
    if (!wordStarted) return;
    tokens.push(word);
    word = '';
    wordStarted = false;
  };
  const finishSegment = (): void => {
    finishWord();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === '\\' && quote === '"' && index + 1 < text.length) {
        word += text[index + 1];
        wordStarted = true;
        index += 1;
      } else {
        word += char;
        wordStarted = true;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      wordStarted = true;
      continue;
    }
    if ((char === '\\' || char === '^') && index + 1 < text.length && /[\s"'\\;&|()]/.test(text[index + 1])) {
      word += text[index + 1];
      wordStarted = true;
      index += 1;
      continue;
    }
    if (char === '(' || char === ')') {
      return undefined;
    }
    if (char === '\r' || char === '\n') {
      finishSegment();
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      continue;
    }
    if (char === ';' || char === '&' || char === '|') {
      finishSegment();
      if ((char === '&' || char === '|') && text[index + 1] === char) index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      finishWord();
      continue;
    }
    word += char;
    wordStarted = true;
  }

  if (quote) return undefined;
  finishSegment();
  return segments;
}

/**
 * Every mode `runner` is invoked with inside a shell body, in order.
 *
 * The LAST invocation is not the answer, and reading only it is how `vitest && vitest run` was chosen:
 * the first segment enters watch mode and the second never runs. A script is only as one-shot as its
 * most watching segment, so the caller judges the whole list.
 *
 * Returns `undefined` for a body that cannot be read at all — command substitution can hide an entire
 * invocation from this parse, and an invocation we cannot see is one we cannot classify.
 */
function runnerInvocationModes(runner: string, body: string): ExplicitRunnerMode[] | undefined {
  const segments = shellCommandSegments(body);
  if (!segments) return undefined;
  const modes: ExplicitRunnerMode[] = [];
  for (const tokens of segments) {
    const at = tokens.findIndex((token) => isRunnerToken(runner, token));
    if (at !== -1) {
      modes.push(explicitRunnerMode(tokens.slice(at + 1)));
    }
  }
  return modes;
}

/** Find the project script that invokes `runner`, preferring a one-shot (non-watch) script. */
function scriptForRunner(runner: string, scripts: Record<string, string>): string | undefined {
  // The executable command is evidence; the script's human-chosen name is not. Vitest defaults to
  // watch mode, so only an explicit one-shot form is eligible. Other runners are eligible unless their
  // body explicitly requests watching. If every matching script watches, use no script and let the
  // direct-invocation fallback below force Vitest into one-shot mode.
  const pool = Object.keys(scripts).filter((name) => {
    const modes = runnerInvocationModes(runner, scripts[name] || '');
    if (!modes || modes.length === 0) {
      return false;
    }
    // Vitest watches unless told otherwise, so EVERY invocation must be explicitly one-shot. Other
    // runners exit by default, so one explicitly watching invocation is enough to disqualify.
    return runner === 'vitest'
      ? modes.every((mode) => mode === 'one-shot')
      : !modes.some((mode) => mode === 'watch');
  });
  if (pool.length === 0) {
    return undefined;
  }
  for (const preferred of ['test', 'build', 'lint', 'typecheck', 'check']) {
    if (pool.includes(preferred)) {
      return preferred;
    }
  }
  return pool[0];
}

function scriptCommand(packageManager: string, scriptName: string): string {
  const pm = packageManager || 'npm';
  if (scriptName === 'test' && ['npm', 'pnpm', 'yarn'].includes(pm)) {
    return `${pm} test`;
  }
  return `${pm} run ${scriptName}`;
}

/**
 * Rewrite a direct runner invocation to the project's matching npm script, or (no script found) force
 * vitest out of watch mode. Returns the command unchanged when it's not a direct runner call, or when
 * it contains shell control characters (too risky to rewrite — let the command policy handle it).
 */
export function normalizeRunnerCommand(command: string, info: ProjectCommandInfo): NormalizedCommand {
  const trimmed = (command ?? '').trim();
  if (!trimmed || /[;&|<>`]|\$\(/.test(trimmed)) {
    return { command };
  }
  const tokens = trimmed.split(/\s+/);
  const found = findRunner(tokens);
  if (!found) {
    return { command };
  }
  const pm = info.packageManager || 'npm';
  const scriptName = scriptForRunner(found.runner, info.scripts);
  if (scriptName) {
    const rewritten = scriptCommand(pm, scriptName);
    if (rewritten === trimmed) {
      return { command };
    }
    return {
      command: rewritten,
      note: `[UnodeAi] Ran the project's \`${rewritten}\` instead of \`${trimmed}\`. Use the project's npm scripts — don't invoke \`${found.runner}\` directly.`,
    };
  }
  // No matching script: at least keep bare vitest from launching watch mode (it never exits → timeout).
  if (found.runner === 'vitest') {
    // Same input contract as the script-body path: the runner's own arguments, never the whole
    // command line. `findRunner` already located the runner, so use that position rather than
    // searching for the name again — one rule, one shape of input.
    if (explicitRunnerMode(tokens.slice(found.argInsertIdx)) === 'unspecified') {
      const parts = [...tokens];
      parts.splice(found.argInsertIdx, 0, 'run');
      const rewritten = parts.join(' ');
      return { command: rewritten, note: `[UnodeAi] Added \`run\` (\`${rewritten}\`) so vitest doesn't start watch mode and hang.` };
    }
  }
  return { command };
}
