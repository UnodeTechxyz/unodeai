import { classifyTurnInterruption } from './TurnInterruption';

/** One host-owned response, never turn-wide evidence. No CLI may assume this proof. */
export class ResponseReplay {
  private safety: 'host-proven-no-tool-start' | 'tool-started' | 'native-unknown';
  constructor(proof: 'host-proven-no-tool-start' | 'native-unknown') { this.safety = proof; }
  /** Call before approval/executor handoff, including reads and refusals; irrevocable for this response. */
  toolStarted(): void { this.safety = 'tool-started'; }
  transient(error: unknown): 'connection-lost' | 'provider-timeout' | undefined {
    if (this.safety !== 'host-proven-no-tool-start') return undefined;
    const kind = classifyTurnInterruption(error, { phase: 'unknown', retry: 'not-available' })?.kind;
    return kind === 'connection-lost' || kind === 'provider-timeout' ? kind : undefined;
  }
}
