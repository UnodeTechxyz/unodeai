import type { GrantNoticeReport } from '../session/GrantNotices';

/** Why an agent was not told, in the person's words. */
const NOT_TOLD: Record<Exclude<Extract<GrantNoticeReport, { kind: 'not-told' }>['reason'], 'worker' | 'stopped'>, string> = {
  'other-request': 'it is working on another request',
  'turn-failed': 'its turn ended in an error',
  'queued-message': 'your next message goes first',
  held: 'it is stopped',
  'no-turn': 'that request has ended',
};

/**
 * The chat line for what became of telling an agent about a file-access grant. Undefined writes none: the person who
 * pressed Stop knows. A line never says more than is settled: until a turn ends, no outcome of it is promised.
 * `continueOffered` (v0.9.101, §4.2): the request's item offers Continue for this grant, so nothing needs sending again.
 */
export function grantNoticeLine(report: GrantNoticeReport, lifetime: 'request' | 'session', continueOffered = false): string | undefined {
  switch (report.kind) {
    case 'waiting':
      return 'Access is granted. The agent has not been told yet. At the end of this turn, UnodeAi will check whether it can notify the agent and continue this request.';
    case 'told':
      return 'The agent was told. The next matching file call can use it.';
    case 'continues':
      return 'The agent will be told and will continue this request.';
    case 'not-told':
      if (report.reason === 'stopped') return undefined;
      if (report.reason === 'worker') {
        return 'The access works now, but this agent was not told: its work is a delegated task. Its coordinator can use the access the next time it assigns this work.';
      }
      return `The agent was not told: ${NOT_TOLD[report.reason]}. `
        + (continueOffered
          ? 'The access stays for this session. To go on with your request, choose Continue on its file access item in this conversation.'
          : lifetime === 'session'
          ? 'The access stays for this session. If the agent still needs this file, send your request again.'
          : 'For this request access lasts only while the original request runs. If the agent still needs this file, send your request again and grant it then.');
  }
}

/**
 * v0.9.101 (H2a): the chat line for a grant on an item a waiting task of this agent needs. The agent is not told now: it
 * is woken in that request once the task can run, so a grant that leaves the task waiting costs no turn.
 */
export function grantWaitingTaskLine(): string {
  return 'The access works now. The task waiting for it continues in its request once everything it needs is granted; '
    + 'nothing needs to be sent again.';
}
