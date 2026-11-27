/*
 * v0.9.106 (setup guide, design §3 step 1 and §4.3): the readiness check and the three host repair operations of a
 * connection, taken out of the first-use dependencies so first use and the setup guide use the same ones. First use
 * keeps its behaviour: `runFirstUseRepair` answers exactly as the dependency did ('done' after a key or a CLI choice,
 * 'outside' after the login terminal and Settings), and the controller's transitions, cancellation and recheck are
 * unchanged. The setup guide asks the same operations for what actually happened, so it never reports a cancelled
 * choice as a success.
 *
 * Nothing here caches an answer: every check reads the registry, the secrets and the configuration through the probes
 * the host builds at the moment of the call. Nothing runs at construction.
 */
import { firstUseReadiness, type FirstUseCli, type FirstUseReadiness, type FirstUseReadinessInput,
  type FirstUseReadinessProbes, type FirstUseRepairAction } from './firstUseReadiness';

/** What a CLI program choice did: a program was chosen and confirmed, or nothing changed (cancelled or kept). */
export type CliChoiceOutcome = 'changed' | 'unchanged';

export interface ReadinessServiceHost {
  /** The probes as they are now; called once per check, never kept. */
  probes: () => FirstUseReadinessProbes;
  /** The native key prompt and the one user-initiated storage boundary. True when a key was stored. */
  storeKey: (secretName: string) => Promise<boolean>;
  /** Check / choose CLI, with its own confirmations. */
  chooseCli: (cli: FirstUseCli) => Promise<CliChoiceOutcome>;
  /** A terminal of its own with the login command typed in and not run. */
  openLoginTerminal: (cli: FirstUseCli, command: string) => void;
  /** Settings → Providers. */
  openProviders: () => Promise<void>;
}

export interface ReadinessService {
  check: (input: FirstUseReadinessInput) => Promise<FirstUseReadiness>;
  setApiKey: (secretName: string) => Promise<'stored' | 'cancelled'>;
  chooseCli: (cli: FirstUseCli) => Promise<CliChoiceOutcome>;
  openLogin: (cli: FirstUseCli, command: string) => void;
  openProviders: () => Promise<void>;
  /**
   * First use's repair runner, as `firstUseDeps().runRepair` was: 'done' when the repair finished here, so first use
   * checks again at once; 'outside' when the person finishes it elsewhere and presses Check again.
   */
  runFirstUseRepair: (action: FirstUseRepairAction) => Promise<'done' | 'outside'>;
}

export function createReadinessService(host: ReadinessServiceHost): ReadinessService {
  const service: ReadinessService = {
    check: (input) => firstUseReadiness(input, host.probes()),
    setApiKey: async (secretName) => (await host.storeKey(secretName) ? 'stored' : 'cancelled'),
    chooseCli: (cli) => host.chooseCli(cli),
    openLogin: (cli, command) => { host.openLoginTerminal(cli, command); },
    openProviders: () => host.openProviders(),
    runFirstUseRepair: async (action) => {
      switch (action.kind) {
        case 'set-api-key':
          await service.setApiKey(action.secretName);
          return 'done';
        case 'choose-cli':
          await service.chooseCli(action.cli);
          return 'done';
        case 'cli-login':
          service.openLogin(action.cli, action.command);
          return 'outside';
        default:
          await service.openProviders();
          return 'outside';
      }
    },
  };
  return service;
}
