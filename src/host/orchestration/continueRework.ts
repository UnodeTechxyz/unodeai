import type { ReworkContinueOutcome } from '../../backend/TeamTools';

/** The host surfaces the offer uses; the extension supplies the VS Code ones. */
export interface ContinueReworkPorts {
  /** A non-modal notification with one button; resolves to the button's label, or undefined when dismissed. */
  show(text: string, button: string): Thenable<string | undefined>;
  /** Calls `listener` when the person stops this PM; returns the unsubscribe. */
  onUserStop(listener: () => void): () => void;
  /** One plain line in the PM's chat. */
  post(text: string): void;
}

export const CONTINUE_REWORK = 'Continue rework';

/**
 * v0.9.99 (B14): automatic rework stopped at its cap. The offer is non-modal and owes no answer: the result stands
 * unless the person clicks Continue rework, which sends the held request. A Stop of the PM after the hold ends it,
 * as do a later decision, a newer result and a rework that is already running.
 */
export function offerContinueRework(
  ports: ContinueReworkPorts,
  pmName: string,
  held: { agentName: string; rounds: number },
  continueRework: () => ReworkContinueOutcome,
): void {
  let stoppedByUser = false;
  const unsubscribe = ports.onUserStop(() => { stoppedByUser = true; });
  void Promise.resolve(ports.show(
    `${pmName} has asked ${held.agentName} to rework a task ${held.rounds} times. Automatic rework stopped after `
      + 'two rounds; the result stands unless you continue.',
    CONTINUE_REWORK,
  )).then((choice) => {
    unsubscribe();
    if (choice !== CONTINUE_REWORK) return;
    ports.post(reworkContinueNotice(stoppedByUser ? 'stopped' : continueRework(), held.agentName));
  }, () => { unsubscribe(); });
}

/** The one sentence the PM's chat shows after Continue rework is clicked. */
export function reworkContinueNotice(outcome: ReworkContinueOutcome | 'stopped', agentName: string): string {
  switch (outcome) {
    case 'sent': return `You continued the rework: the request was sent to ${agentName}.`;
    case 'stopped': return 'Nothing was sent: you stopped the PM after automatic rework stopped.';
    case 'running': return `Nothing more was sent: ${agentName} is still working on an earlier rework of this task.`;
    case 'stale': return `Nothing was sent: ${agentName} has delivered a newer result since. The PM reviews that one.`;
    case 'decided': return 'Nothing was sent: the PM has since recorded another decision on this result, or you wrote to it.';
  }
}
