import { describe, expect, it } from 'vitest';
import {
  chooseCliRuntime,
  type CliGateProbeOutcome,
  type CliPickItem,
  type CliProgramFacts,
  type CliRuntimeCheck,
  type CliRuntimeChooserPort,
  type CliRuntimeConfirmation,
  type CurrentCliRuntime,
  type PreparedCliRuntime,
} from '../CliRuntimeChooser';

// The design these tests realise (v0.9.97): Check / choose CLI is pick → prepare → static facts → confirm (the
// dialog) → probe → record. The pick in the file dialog is not consent to run the program: nothing of it starts
// before the confirmation, "Not now" starts nothing, the compatibility check runs only after the OK, and the adoption
// record is written only after it passed. `verifyCodexCli` (the port's `check`) runs only for a qualified or adopted
// program, and only after the OK.

const DIALOG = { title: 'Use Claude CLI with UnodeAi?', lines: ['Program: …'], buttons: ['Check and use this program', 'Not now'] as const };

/** An editor whose answers the test gives, recording every effect. `check` and `probe` are the only starts. */
function editor(options: {
  current?: CurrentCliRuntime;
  pick?: (items: CliPickItem[]) => CliPickItem | undefined;
  browse?: string;
  prepare?: (path: string) => PreparedCliRuntime;
  facts?: (prepared: PreparedCliRuntime, call: number) => CliProgramFacts | Error;
  version?: string | Error;
  probe?: CliGateProbeOutcome;
  adopt?: Error;
  confirm?: boolean;
  running?: number;
  checks?: CliRuntimeCheck[];
  latest?: { version?: string; note: string };
} = {}) {
  /** The identity each program file has now; the test changes it to model a launcher pointed elsewhere. */
  const stamps = new Map<string, string>();
  const stampOf = (program: string) => stamps.get(program) ?? `stamp of ${program}`;
  const did: string[] = [];
  const reports: Array<[string, string]> = [];
  let factCalls = 0;
  const state = {
    current: options.current ?? { program: 'C:\\old\\claude.cmd', origin: 'legacy' as const, source: 'npm global install' as const, settingValue: '' },
    blocked: false,
    listed: [] as CliPickItem[],
    placeHolder: '',
    onFacts: undefined as (() => void) | undefined,
    onStart: undefined as (() => void) | undefined,
    confirmed: undefined as undefined | CliRuntimeConfirmation,
  };
  const port: CliRuntimeChooserPort = {
    current: () => state.current,
    latest: async () => options.latest ?? { note: 'The latest Claude CLI version was not looked up.' },
    candidates: () => {
      did.push('list');
      return [
        { path: 'C:\\old\\claude.cmd', source: 'npm global install', route: 'npm-cmd' },
        { path: 'C:\\new\\claude.exe', source: 'native installer', route: 'native' },
      ];
    },
    lastCheck: (program) => (options.checks ?? []).find((check) => check.program === program),
    pick: async (items, placeHolder) => {
      state.listed = items;
      state.placeHolder = placeHolder;
      return options.pick ? options.pick(items) : items.find((item) => item.kind === 'candidate' && !item.current);
    },
    browse: async () => options.browse,
    prepare: (chosen) => {
      did.push(`prepare ${chosen}`);
      return options.prepare ? options.prepare(chosen) : { settingValue: chosen, program: chosen, route: 'native', source: 'native installer', stamp: stampOf(chosen) };
    },
    facts: async (prepared) => {
      factCalls += 1;
      did.push(`facts ${prepared.program}`);
      state.onFacts?.();
      const facts = options.facts?.(prepared, factCalls) ?? { verdict: 'qualified', closureDigest: 'digest-1', version: '2.1.301', compatibilityPolicyId: '0.9.97-0#claude-2.1.301' };
      if (facts instanceof Error) throw facts;
      return facts;
    },
    check: async (prepared) => {
      did.push(`START check ${prepared.program}`);
      state.onStart?.();
      if (options.version instanceof Error) throw options.version;
      return options.version ?? '2.1.301';
    },
    probe: async (prepared) => {
      did.push(`START probe ${prepared.program}`);
      state.onStart?.();
      return options.probe ?? { result: 'pass', version: '2.1.305', versionOutput: '2.1.305 (Claude Code)', startedAt: '2026-10-21T10:00:00.000Z', durationMs: 1600 };
    },
    adopt: async (prepared, facts, outcome) => {
      did.push(`adopt ${prepared.program} ${facts.closureDigest} ${outcome.version}`);
      if (options.adopt) throw options.adopt;
    },
    confirm: async (question) => {
      state.confirmed = question;
      did.push(`confirm ${question.kind} ${question.next.program}`);
      return options.confirm ?? true;
    },
    persist: async (value) => { did.push(`persist ${value}`); },
    record: async (check) => { did.push(`record ${check.program} ${check.version}`); },
    blocked: () => state.blocked,
    runningAgents: () => options.running ?? 0,
    report: (kind, message) => { reports.push([kind, message]); },
    now: () => new Date('2026-10-18T12:00:00Z'),
    samePath: (a, b) => a.toLowerCase() === b.toLowerCase(),
  };
  const starts = () => did.filter((step) => step.startsWith('START'));
  /** Every start came after the confirmation (and there was one). */
  const startedOnlyAfterConfirm = () => {
    const confirm = did.findIndex((step) => step.startsWith('confirm'));
    return confirm >= 0 && did.every((step, index) => !step.startsWith('START') || index > confirm);
  };
  return { port, did, reports, state, stamps, starts, startedOnlyAfterConfirm };
}

const adoptFacts = (digest = 'digest-1'): CliProgramFacts => ({ verdict: 'needs-adoption', closureDigest: digest, dialog: DIALOG });

describe('Check / choose CLI: nothing starts before the confirmation (v0.9.97)', () => {
  it('lists the current program first and the others without starting any of them', async () => {
    const e = editor({ pick: () => undefined });
    expect(await chooseCliRuntime('claude-cli', e.port)).toBeUndefined();
    expect(e.did).toEqual(['list']);
    expect(e.state.listed.map((item) => item.kind === 'candidate' ? [item.path, item.current] : ['browse'])).toEqual([
      ['C:\\old\\claude.cmd', true],
      ['C:\\new\\claude.exe', false],
      ['browse'],
    ]);
  });

  it('asks with the adoption dialog before any start, then checks, records the adoption after the pass, and saves', async () => {
    const e = editor({ facts: () => adoptFacts(), running: 2 });
    expect(await chooseCliRuntime('claude-cli', e.port)).toEqual({
      program: 'C:\\new\\claude.exe', version: '2.1.305', changed: true, settingValue: 'C:\\new\\claude.exe', stamp: 'stamp of C:\\new\\claude.exe',
    });
    expect(e.did).toEqual([
      'list', 'prepare C:\\new\\claude.exe', 'facts C:\\new\\claude.exe', 'confirm adopt C:\\new\\claude.exe',
      'prepare C:\\new\\claude.exe', 'facts C:\\new\\claude.exe', 'START probe C:\\new\\claude.exe',
      'adopt C:\\new\\claude.exe digest-1 2.1.305', 'record C:\\new\\claude.exe 2.1.305', 'persist C:\\new\\claude.exe',
    ]);
    expect(e.startedOnlyAfterConfirm()).toBe(true);
    expect(e.state.confirmed).toMatchObject({ kind: 'adopt', next: { facts: { verdict: 'needs-adoption', dialog: DIALOG } } });
    expect(e.state.confirmed?.next.version).toBeUndefined();
    expect(e.reports.at(-1)?.[1]).toMatch(/still use the previous program.*nothing is resent/);
  });

  it('starts nothing, records nothing and saves nothing on "Not now"', async () => {
    for (const facts of [adoptFacts(), undefined]) {
      const e = editor({ confirm: false, ...(facts ? { facts: () => facts } : {}) });
      expect(await chooseCliRuntime('claude-cli', e.port)).toBeUndefined();
      expect(e.starts()).toEqual([]);
      expect(e.did.at(-1)).toMatch(/^confirm /);
      expect(e.did.some((step) => /^(adopt|record|persist)/.test(step))).toBe(false);
    }
  });

  it('starts nothing for the current program when it is qualified or adopted, and reports its version', async () => {
    for (const verdict of ['qualified', 'adopted'] as const) {
      const facts: CliProgramFacts = verdict === 'qualified'
        ? { verdict, closureDigest: 'd', version: '2.1.301', compatibilityPolicyId: 'p#e' }
        : { verdict, closureDigest: 'd', version: '2.1.303', adoptionId: 'a'.repeat(64) };
      const e = editor({ facts: () => facts, pick: (items) => items.find((item) => item.kind === 'candidate' && item.current) });
      expect(await chooseCliRuntime('claude-cli', e.port)).toMatchObject({ program: 'C:\\old\\claude.cmd', version: facts.version, changed: false });
      expect(e.did).toEqual(['list', 'prepare C:\\old\\claude.cmd', 'facts C:\\old\\claude.cmd']);
      expect(e.reports.at(-1)?.[1]).toMatch(new RegExp(`${facts.version.replace(/\./g, '\\.')} \\(${verdict === 'qualified' ? 'qualified by this UnodeAi' : 'adopted by you'}\\).*nothing was started`));
    }
  });

  it('asks before checking the current program when it needs adoption, and saves nothing new', async () => {
    const e = editor({ facts: () => adoptFacts(), pick: (items) => items.find((item) => item.kind === 'candidate' && item.current) });
    expect(await chooseCliRuntime('claude-cli', e.port)).toMatchObject({ program: 'C:\\old\\claude.cmd', version: '2.1.305', changed: false });
    expect(e.startedOnlyAfterConfirm()).toBe(true);
    expect(e.did).toContain('adopt C:\\old\\claude.cmd digest-1 2.1.305');
    expect(e.did.some((step) => step.startsWith('persist'))).toBe(false);
  });

  it('runs the existing check of a qualified or adopted program only after the OK, then saves', async () => {
    const e = editor({ facts: () => ({ verdict: 'adopted', closureDigest: 'd', version: '0.163.0', adoptionId: 'a'.repeat(64) }), version: '0.163.0' });
    expect(await chooseCliRuntime('codex-cli', e.port)).toMatchObject({ version: '0.163.0', changed: true });
    expect(e.did).toEqual([
      'list', 'prepare C:\\new\\claude.exe', 'facts C:\\new\\claude.exe', 'confirm use C:\\new\\claude.exe',
      'prepare C:\\new\\claude.exe', 'facts C:\\new\\claude.exe', 'START check C:\\new\\claude.exe',
      'record C:\\new\\claude.exe 0.163.0', 'persist C:\\new\\claude.exe',
    ]);
    expect(e.state.confirmed).toMatchObject({ kind: 'use', startsAfterOk: 'twice, with --version and then login status', next: { version: '0.163.0' } });
    // A program to adopt never gets the existing check, and a qualified one never the compatibility check.
    expect(e.did.some((step) => step.includes('probe') || step.startsWith('adopt'))).toBe(false);
  });

  it('writes no adoption record and saves nothing when the check fails or its stop is unconfirmed', async () => {
    for (const probe of [
      { result: 'fail', detail: 'its SessionStart hook did not reach UnodeAi within 20 seconds' },
      { result: 'stop-unconfirmed', detail: 'UnodeAi could not confirm that the check\'s process stopped (process 7 was still running)' },
    ] as const) {
      const e = editor({ facts: () => adoptFacts(), probe });
      expect(await chooseCliRuntime('claude-cli', e.port)).toBeUndefined();
      expect(e.did.some((step) => /^(adopt|record|persist)/.test(step))).toBe(false);
      expect(e.reports.at(-1)).toEqual(['warning', expect.stringContaining(probe.detail)]);
    }
  });

  it('saves nothing when the adoption record cannot be written', async () => {
    const e = editor({ facts: () => adoptFacts(), adopt: new Error('an agent could write into the CLI store.') });
    expect(await chooseCliRuntime('claude-cli', e.port)).toBeUndefined();
    expect(e.did.some((step) => /^(record|persist)/.test(step))).toBe(false);
    expect(e.reports.at(-1)?.[1]).toMatch(/could not record that you chose that Claude CLI: an agent could write into the CLI store\. Nothing was saved\./);
  });

  it('starts nothing when the program\'s files changed while the user decided', async () => {
    const e = editor({ facts: (_prepared, call) => adoptFacts(call === 1 ? 'digest-1' : 'digest-2') });
    expect(await chooseCliRuntime('claude-cli', e.port)).toBeUndefined();
    expect(e.starts()).toEqual([]);
    expect(e.reports.at(-1)).toEqual(['warning', 'The files of the Claude CLI program at C:\\new\\claude.exe changed while you decided. Nothing was started; check it again.']);
    const qualifiedNow = editor({ facts: (_prepared, call) => (call === 1 ? adoptFacts() : { verdict: 'qualified', closureDigest: 'digest-1', version: '1', compatibilityPolicyId: 'x' }) });
    expect(await chooseCliRuntime('claude-cli', qualifiedNow.port)).toBeUndefined();
    expect(qualifiedNow.starts()).toEqual([]);
  });

  it('starts nothing and asks nothing for a program a release marked bad where Run anyway cannot be recorded, or one it refuses to read', async () => {
    const bad = editor({ facts: () => ({ verdict: 'blocked-bad', closureDigest: 'd', reason: 'it skips the approval gate' }) });
    expect(await chooseCliRuntime('codex-cli', bad.port)).toBeUndefined();
    expect(bad.did.some((step) => step.startsWith('confirm') || step.startsWith('START'))).toBe(false);
    expect(bad.reports.at(-1)?.[1]).toMatch(/marked this version bad \(it skips the approval gate\)\. Nothing was started\./);

    const inStore = editor({ facts: () => new Error('The program is inside UnodeAi\'s CLI store, where only managed Codex runs.') });
    expect(await chooseCliRuntime('codex-cli', inStore.port)).toBeUndefined();
    expect(inStore.did.some((step) => step.startsWith('confirm') || step.startsWith('START'))).toBe(false);
    expect(inStore.reports.at(-1)?.[1]).toMatch(/inside UnodeAi's CLI store.*Nothing was started\./);
  });

  it('changes nothing when the program cannot be used or its check fails', async () => {
    const refused = editor({ prepare: () => { throw new Error('inside workspace-owned path'); } });
    expect(await chooseCliRuntime('claude-cli', refused.port)).toBeUndefined();
    expect(refused.did).toEqual(['list', 'prepare C:\\new\\claude.exe']);
    expect(refused.reports[0]).toEqual(['warning', expect.stringContaining('workspace-owned')]);

    const failed = editor({ version: new Error('exit 1; not a Claude CLI') });
    expect(await chooseCliRuntime('claude-cli', failed.port)).toBeUndefined();
    expect(failed.did.at(-1)).toBe('START check C:\\new\\claude.exe');
    expect(failed.reports[0]).toEqual(['warning', expect.stringMatching(/not a Claude CLI.*Nothing was changed/)]);
  });

  it('asks nothing when the setting changed while the program was read, and saves nothing when it changed during the check', async () => {
    const reading = editor();
    reading.state.onFacts = () => { reading.state.current = { ...reading.state.current, settingValue: 'C:\\other\\claude.exe' }; };
    expect(await chooseCliRuntime('claude-cli', reading.port)).toBeUndefined();
    expect(reading.did.some((step) => step.startsWith('confirm') || step.startsWith('START'))).toBe(false);
    expect(reading.reports.at(-1)?.[1]).toMatch(/changed while UnodeAi read the program/);

    const checking = editor();
    checking.state.onStart = () => { checking.state.current = { ...checking.state.current, settingValue: 'C:\\other\\claude.exe' }; };
    expect(await chooseCliRuntime('claude-cli', checking.port)).toBeUndefined();
    expect(checking.did.some((step) => step.startsWith('persist'))).toBe(false);
    expect(checking.reports.at(-1)?.[1]).toMatch(/changed while UnodeAi checked the program\. Nothing was saved/);
  });

  it('does nothing more once the window is closing or the workspace changed', async () => {
    const reading = editor();
    reading.state.onFacts = () => { reading.state.blocked = true; };
    expect(await chooseCliRuntime('codex-cli', reading.port)).toBeUndefined();
    expect(reading.did.some((step) => /^(confirm|START|record|persist)/.test(step))).toBe(false);

    const probing = editor({ facts: () => adoptFacts() });
    probing.state.onStart = () => { probing.state.blocked = true; };
    expect(await chooseCliRuntime('codex-cli', probing.port)).toBeUndefined();
    expect(probing.did.some((step) => /^(adopt|record|persist)/.test(step))).toBe(false);
  });

  it('shows the latest published version, marks older programs, and says when a checked one is older', async () => {
    const latest = { version: '2.1.302', note: 'Latest published on npm: Claude CLI 2.1.302.' };
    const checks = [{ provider: 'claude-cli' as const, program: 'C:\\old\\claude.cmd', version: '2.1.209', checkedAt: '2026-10-18T09:30:00.000Z', stamp: 's' }];
    const current = editor({
      latest, checks, pick: (items) => items.find((item) => item.kind === 'candidate' && item.current),
      facts: () => ({ verdict: 'qualified', closureDigest: 'd', version: '2.1.209', compatibilityPolicyId: 'p' }),
    });
    expect(await chooseCliRuntime('claude-cli', current.port)).toMatchObject({ program: 'C:\\old\\claude.cmd', version: '2.1.209', changed: false, latest: '2.1.302' });
    expect(current.state.placeHolder).toMatch(/^Latest published on npm: Claude CLI 2\.1\.302\. Choose a Claude CLI to check\./);
    expect(current.state.listed[0]).toMatchObject({ description: '2.1.209 · checked 2026-10-18 · older than 2.1.302' });
    expect(current.reports.at(-1)).toEqual(['warning', expect.stringMatching(/already starts this program; nothing was started\. It is older than the latest published Claude CLI, 2\.1\.302\./)]);

    const newer = editor({ latest });
    expect(await chooseCliRuntime('claude-cli', newer.port)).toMatchObject({ program: 'C:\\new\\claude.exe', version: '2.1.301', changed: true, latest: '2.1.302' });
    expect(newer.state.confirmed?.latest).toBe('2.1.302');
    expect(newer.reports.at(-1)).toEqual(['warning', expect.stringMatching(/saved: C:\\new\\claude\.exe\. It is older than the latest published Claude CLI, 2\.1\.302\./)]);

    const current_ = editor({ latest, version: '2.1.302', facts: () => ({ verdict: 'qualified', closureDigest: 'd', version: '2.1.302', compatibilityPolicyId: 'p' }) });
    await chooseCliRuntime('claude-cli', current_.port);
    expect(current_.reports.at(-1)).toEqual(['information', expect.not.stringMatching(/older/)]);
  });

  it('says why no latest version is shown, and still lists and checks as before', async () => {
    const e = editor({ latest: { note: 'The latest Claude CLI version was not looked up, because registry.npmjs.org is not allowed.' } });
    const choice = await chooseCliRuntime('claude-cli', e.port);
    expect(choice).toMatchObject({ program: 'C:\\new\\claude.exe', version: '2.1.301', changed: true });
    expect(choice).not.toHaveProperty('latest');
    expect(e.state.placeHolder).toMatch(/^The latest Claude CLI version was not looked up, because registry\.npmjs\.org is not allowed\. Choose/);
    expect(e.state.confirmed?.latest).toBeUndefined();
  });

  it('does nothing when the window closes during the lookup', async () => {
    const e = editor();
    e.port.latest = async () => { e.state.blocked = true; return { note: 'n' }; };
    expect(await chooseCliRuntime('claude-cli', e.port)).toBeUndefined();
    expect(e.did).toEqual([]);
  });

  it('saves a stable launcher only if it still starts the program that was read and confirmed', async () => {
    // A launcher (a link, or the native installer's claude.exe) that resolves to a versioned program.
    const launcher = 'C:\\bin\\claude.exe';
    let target = 'C:\\versions\\A\\claude.exe';
    let refuse = false;
    const resolving = (onConfirm: () => void) => {
      const e = editor({
        pick: (items) => items.find((item) => item.kind === 'browse'),
        browse: launcher,
        prepare: (chosen) => {
          if (refuse) throw new Error('inside workspace-owned path');
          return { settingValue: chosen, program: target, route: 'native', source: 'native installer', stamp: e.stamps.get(target) ?? `stamp of ${target}` };
        },
      });
      e.port.confirm = async (question) => { e.did.push(`confirm ${question.next.program}`); onConfirm(); return true; };
      return e;
    };

    const unchanged = resolving(() => undefined);
    expect(await chooseCliRuntime('claude-cli', unchanged.port)).toMatchObject({ program: 'C:\\versions\\A\\claude.exe', changed: true });
    expect(unchanged.did.at(-1)).toBe(`persist ${launcher}`);

    const retargeted = resolving(() => { target = 'C:\\versions\\B\\claude.exe'; });
    expect(await chooseCliRuntime('claude-cli', retargeted.port)).toBeUndefined();
    expect(retargeted.did.some((step) => step.startsWith('persist') || step.startsWith('START'))).toBe(false);
    expect(retargeted.reports.at(-1)).toEqual(['warning',
      `The Claude CLI program at ${launcher} changed while you decided. It now starts C:\\versions\\B\\claude.exe. Nothing was saved; check it again.`]);

    target = 'C:\\versions\\A\\claude.exe';
    const replaced = resolving(() => { replaced.stamps.set(target, 'another file at the same path'); });
    expect(await chooseCliRuntime('claude-cli', replaced.port)).toBeUndefined();
    expect(replaced.did.some((step) => step.startsWith('persist') || step.startsWith('START'))).toBe(false);
    expect(replaced.reports.at(-1)).toEqual(['warning',
      `The Claude CLI program at ${launcher} changed while you decided. Nothing was saved; check it again.`]);

    const refused = resolving(() => { refuse = true; });
    expect(await chooseCliRuntime('claude-cli', refused.port)).toBeUndefined();
    expect(refused.did.some((step) => step.startsWith('persist') || step.startsWith('START'))).toBe(false);
    expect(refused.reports.at(-1)).toEqual(['warning', 'UnodeAi will not use that Claude CLI now: inside workspace-owned path Nothing was saved.']);
  });

  it('compares the program itself too, not only the identity the port reports', async () => {
    let target = 'C:\\versions\\A\\claude.exe';
    const e = editor({
      pick: (items) => items.find((item) => item.kind === 'browse'),
      browse: 'C:\\bin\\claude.exe',
      // An identity that names no path: two programs can share it.
      prepare: (chosen) => ({ settingValue: chosen, program: target, route: 'native', source: 'native installer', stamp: 'same identity' }),
    });
    e.port.confirm = async () => { target = 'C:\\versions\\B\\claude.exe'; return true; };
    expect(await chooseCliRuntime('claude-cli', e.port)).toBeUndefined();
    expect(e.did.some((step) => step.startsWith('persist') || step.startsWith('START'))).toBe(false);
    expect(e.reports.at(-1)?.[1]).toMatch(/It now starts C:\\versions\\B\\claude\.exe\. Nothing was saved/);
  });

  it('records a check with the identity of the file that was checked', async () => {
    const e = editor();
    const recorded: unknown[] = [];
    e.port.record = async (check) => { recorded.push(check); };
    await chooseCliRuntime('codex-cli', e.port);
    expect(recorded).toEqual([{ provider: 'codex-cli', program: 'C:\\new\\claude.exe', version: '2.1.301', checkedAt: '2026-10-18T12:00:00.000Z', stamp: 'stamp of C:\\new\\claude.exe' }]);
  });

  it('says that it reads the program first and starts it only after the user confirms', async () => {
    for (const provider of ['claude-cli', 'codex-cli'] as const) {
      const e = editor({ pick: () => undefined });
      await chooseCliRuntime(provider, e.port);
      expect(e.state.placeHolder).toMatch(new RegExp(`Choose a ${provider === 'claude-cli' ? 'Claude' : 'Codex'} CLI to check\\. UnodeAi reads that program's files first and starts it only after you confirm; nothing else is started\\.$`));
    }
    const claude = editor();
    await chooseCliRuntime('claude-cli', claude.port);
    expect(claude.state.confirmed?.startsAfterOk).toBe('once, with --version');
  });

  it('checks a browsed file the same way, and nothing when browsing is cancelled', async () => {
    const browsed = editor({ pick: (items) => items.find((item) => item.kind === 'browse'), browse: 'D:\\portable\\claude.exe', facts: () => adoptFacts() });
    await chooseCliRuntime('claude-cli', browsed.port);
    expect(browsed.did).toContain('START probe D:\\portable\\claude.exe');
    expect(browsed.startedOnlyAfterConfirm()).toBe(true);
    const cancelled = editor({ pick: (items) => items.find((item) => item.kind === 'browse') });
    expect(await chooseCliRuntime('claude-cli', cancelled.port)).toBeUndefined();
    expect(cancelled.did).toEqual(['list']);
  });

  it('saves the stable launcher, not the resolved target', async () => {
    const e = editor({ prepare: (chosen) => ({ settingValue: chosen, program: 'C:\\versions\\2.1.301\\claude.exe', route: 'native', source: 'native installer', stamp: 's' }) });
    await chooseCliRuntime('claude-cli', e.port);
    expect(e.did).toContain('persist C:\\new\\claude.exe');
  });

  it('shows a measured version beside a program, and says when none was measured', async () => {
    const e = editor({
      pick: () => undefined,
      checks: [{ provider: 'claude-cli', program: 'C:\\old\\claude.cmd', version: '2.1.209', checkedAt: '2026-10-17T08:00:00Z', stamp: 's' }],
    });
    await chooseCliRuntime('claude-cli', e.port);
    const described = e.state.listed.flatMap((item) => (item.kind === 'candidate' ? [item.description] : []));
    expect(described).toEqual(['2.1.209 · checked 2026-10-17', 'version not checked yet']);
  });
});

describe('v0.9.99 B17: a version a release marked bad gets a warning and Run anyway', () => {
  const badFacts = (runAnyway = false): CliProgramFacts => ({
    verdict: 'blocked-bad', closureDigest: 'bad-digest', reason: 'its tool gate does not load', version: '2.1.300',
    compatibilityPolicyId: '0.9.99-0#claude-cli/2.1.300/win32-x64', runAnyway,
  });
  function withRunAnyway(options: Parameters<typeof editor>[0]) {
    const e = editor(options);
    e.port.recordRunAnyway = async (prepared, facts) => { e.did.push(`run anyway ${prepared.program} ${facts.closureDigest} ${facts.compatibilityPolicyId}`); };
    return e;
  }

  it('warns, and after Run anyway runs the compatibility check, records the choice and saves the program', async () => {
    const e = withRunAnyway({ facts: () => badFacts() });
    expect(await chooseCliRuntime('claude-cli', e.port)).toMatchObject({ program: 'C:\\new\\claude.exe', version: '2.1.305', changed: true });
    expect(e.state.confirmed).toMatchObject({ kind: 'run-anyway', next: { facts: { verdict: 'blocked-bad', reason: 'its tool gate does not load' } } });
    expect(e.startedOnlyAfterConfirm()).toBe(true);
    expect(e.did).toEqual(expect.arrayContaining([
      'START probe C:\\new\\claude.exe',
      'run anyway C:\\new\\claude.exe bad-digest 0.9.99-0#claude-cli/2.1.300/win32-x64',
      'persist C:\\new\\claude.exe',
    ]));
    expect(e.did.some((step) => step.startsWith('adopt'))).toBe(false);
  });

  it('"Not now" starts and records nothing; a failed compatibility check records nothing', async () => {
    const declined = withRunAnyway({ facts: () => badFacts(), confirm: false });
    expect(await chooseCliRuntime('claude-cli', declined.port)).toBeUndefined();
    expect(declined.starts()).toEqual([]);
    expect(declined.did.some((step) => step.startsWith('run anyway') || step.startsWith('persist'))).toBe(false);

    const failed = withRunAnyway({ facts: () => badFacts(), probe: { result: 'fail', detail: 'the tool gate did not answer' } });
    expect(await chooseCliRuntime('claude-cli', failed.port)).toBeUndefined();
    expect(failed.did.some((step) => step.startsWith('run anyway') || step.startsWith('persist'))).toBe(false);
    expect(failed.reports.at(-1)?.[1]).toMatch(/its check failed \(the tool gate did not answer\)/);
  });

  it('a program already run anyway and in use is reported with its warning, and nothing is started', async () => {
    const e = withRunAnyway({ facts: () => badFacts(true), pick: (items) => items.find((item) => item.kind === 'candidate' && item.current), current: { program: 'C:\\new\\claude.exe', origin: 'configured', source: 'native installer', settingValue: 'C:\\new\\claude.exe' } });
    expect(await chooseCliRuntime('claude-cli', e.port)).toMatchObject({ changed: false, version: '2.1.300' });
    expect(e.starts()).toEqual([]);
    expect(e.reports.at(-1)?.[1]).toContain('run anyway by you, though a UnodeAi release marked it bad (its tool gate does not load)');
  });
});
