/*---------------------------------------------------------------------------------------------
 *  UnodeAi - trustedExecution (v0.9.96)
 *  Workspace Trust at the moment a command would start. A command may be prepared, gated and approved while the
 *  workspace is trusted and start after trust was withdrawn; it is then reported as not run. This holds for a
 *  foreground command and for a background one alike. vscode-free: the caller says how trust is read.
 *--------------------------------------------------------------------------------------------*/

import {
  ALREADY_USED_MESSAGE,
  type CommandExecutionProvider,
  type CommandPreparationFailure,
  guardDirectCommand,
  notStartedBy,
} from './CommandExecution';

export const UNTRUSTED_COMMAND_MESSAGE = 'Blocked: this workspace is not trusted, so shell commands are disabled. Trust '
  + 'the workspace (Workspace Trust) to enable them.';

/**
 * The provider with Workspace Trust checked again when each prepared command would start: the trust check is handed
 * to the provider as a start refusal, which it checks at every side-effect boundary (creating a terminal, probing
 * it, running the command), and it is checked once more when the command is executed. A refused execution consumes
 * the lease: the command can run only through a new preparation and approval.
 */
export function trustedExecutionProvider(provider: CommandExecutionProvider, isTrusted: () => boolean): CommandExecutionProvider {
  const untrusted = (): CommandPreparationFailure | undefined => (isTrusted()
    ? undefined
    : { ok: false, reason: 'shell-compatibility', message: UNTRUSTED_COMMAND_MESSAGE });
  const prepareDirect = provider.prepareDirect;
  return {
    ...(prepareDirect ? {
      prepareDirect: () => {
        const prepared = prepareDirect();
        return prepared.ok ? guardDirectCommand(prepared, untrusted) : prepared;
      },
    } : {}),
    ...(provider.reportUnconfirmedStops ? { reportUnconfirmedStops: provider.reportUnconfirmedStops.bind(provider) } : {}),
    async acquire(opts) {
      const outer = opts.startRefusal;
      const startRefusal = () => untrusted() ?? outer?.();
      const lease = await provider.acquire({ ...opts, startRefusal });
      if (!lease.ok) return lease;
      let used = false;
      return {
        ...lease,
        execute: async (command, timeoutMs) => {
          if (used) return notStartedBy({ ok: false, reason: 'disposed', message: ALREADY_USED_MESSAGE });
          used = true;
          const refused = startRefusal();
          return refused ? notStartedBy(refused) : lease.execute(command, timeoutMs);
        },
        release: () => lease.release(),
      };
    },
  };
}
