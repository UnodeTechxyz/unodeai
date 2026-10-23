import { describe, expect, it } from 'vitest';
import {
  assertManagedCodexArgs,
  buildCodexAppServerArgs,
  finalCodexSpawnEnv,
  MANAGED_CODEX_BANNED_ARGS,
  mergeCodexSpawnEnv,
} from '../CodexSpawnArgs';

// The design these tests realise: the final spawn-environment filter and the managed argv guard. After every merge,
// the agent's own environment entries included, and in both modes, every variable whose upper-case name starts with
// CODEX_MANAGED_BY_ is removed, and OPENAI_API_KEY / CODEX_API_KEY as before. A managed start is `app-server --stdio`
// as the production builder makes it, and carries none of update, daemon, login, logout, install.

describe('the final Codex spawn environment', () => {
  it('removes CODEX_MANAGED_BY_* in any case, and the provider keys, and keeps everything else', () => {
    expect(finalCodexSpawnEnv({
      CODEX_MANAGED_BY_NPM: '1', codex_managed_by_bun: '1', Codex_Managed_By_Brew: '1', CODEX_MANAGED_BY_: '1',
      OPENAI_API_KEY: 'k', openai_api_key: 'k', Codex_Api_Key: 'k',
      CODEX_HOME: 'C:\\Users\\u\\.codex', CODEX_MANAGED: 'kept', MY_CODEX_MANAGED_BY_X: 'kept', PATH: 'p',
    })).toEqual({ CODEX_HOME: 'C:\\Users\\u\\.codex', CODEX_MANAGED: 'kept', MY_CODEX_MANAGED_BY_X: 'kept', PATH: 'p' });
  });

  it('filters after the merge, so an agent\'s own environment entry cannot bring the variable back', () => {
    const host = { PATH: 'p', CODEX_MANAGED_BY_NPM: '1' };
    const agent = { codex_managed_by_bun: 'yes', OPENAI_API_KEY: 'k', EXTRA: 'e' };
    expect(mergeCodexSpawnEnv(host, agent)).toEqual({ PATH: 'p', EXTRA: 'e' });
    // Later layers still win for every other variable.
    expect(mergeCodexSpawnEnv({ PATH: 'host' }, { PATH: 'agent' }, { PATH: 'route' })).toEqual({ PATH: 'route' });
  });

  it('does not change the environment it is given', () => {
    const env = { CODEX_MANAGED_BY_NPM: '1', PATH: 'p' };
    finalCodexSpawnEnv(env);
    expect(env).toEqual({ CODEX_MANAGED_BY_NPM: '1', PATH: 'p' });
  });
});

describe('the managed Codex argv guard', () => {
  it('admits the production App Server argv', () => {
    expect(() => assertManagedCodexArgs(buildCodexAppServerArgs({ projectRoot: '/probe', mode: 'user-only' }, 'ask-for-approval'))).not.toThrow();
    expect(() => assertManagedCodexArgs(buildCodexAppServerArgs(undefined, 'read-only'))).not.toThrow();
  });

  it.each(MANAGED_CODEX_BANNED_ARGS.flatMap((word) => [word, word.toUpperCase()]))('refuses the argument %s anywhere', (word) => {
    const args = buildCodexAppServerArgs(undefined, 'ask-for-approval');
    expect(() => assertManagedCodexArgs([...args, word])).toThrow(`Managed Codex refused the argument "${word}".`);
    expect(() => assertManagedCodexArgs([args[0], args[1], word, ...args.slice(2)])).toThrow(/refused the argument/);
  });

  it('names exactly the five banned words', () => {
    expect([...MANAGED_CODEX_BANNED_ARGS]).toEqual(['update', 'daemon', 'login', 'logout', 'install']);
  });

  it('refuses another subcommand, or the App Server without --stdio first', () => {
    for (const args of [['exec', '--stdio'], ['--version'], ['app-server'], ['app-server', '--listen'], ['--stdio', 'app-server'], []]) {
      expect(() => assertManagedCodexArgs(args)).toThrow('Managed Codex refused a start that is not its App Server over stdio.');
    }
  });
});
