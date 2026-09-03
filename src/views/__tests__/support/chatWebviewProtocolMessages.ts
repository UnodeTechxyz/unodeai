export const validWebviewMessages: Record<string, Record<string, unknown>> = {
  send: { command: 'send', agentId: 'agent-1', text: 'hello', mode: 'act', attachments: [] },
  interrupt: { command: 'interrupt', agentId: 'agent-1' },
  selectAgent: { command: 'selectAgent', agentId: 'agent-1' },
  setMode: { command: 'setMode', agentId: 'agent-1', mode: 'plan' },
  approvalDecision: { command: 'approvalDecision', id: 'approval-1', action: 'once', note: 'okay' },
  setApproval: { command: 'setApproval', kind: 'command', value: 'ask' },
  compactContext: { command: 'compactContext' },
  focusEditor: { command: 'focusEditor' },
  openCheckpointDiff: { command: 'openCheckpointDiff', checkpointId: 1 },
  restoreCheckpoint: { command: 'restoreCheckpoint', checkpointId: 1 },
  openToolFile: { command: 'openToolFile', agentId: 'agent-1', toolId: 'tool-1' },
  repairAction: { command: 'repairAction', kind: 'no-team' },
  chatCommand: { command: 'chatCommand', target: 'unode.openWorkbench' },
  handoffToSolo: { command: 'handoffToSolo', id: 'handoff-1' },
  composerInsertionApplied: { command: 'composerInsertionApplied', revision: 1 },
  accessibilityFocus: { command: 'accessibilityFocus', focused: true },
  renderedTranscriptItemsMissing: {
    command: 'renderedTranscriptItemsMissing', agentId: 'agent-1', cause: 'unexplained',
    previousItemCount: 2, nextItemCount: 1, missing: [{ id: 'item-1', delivery: 'committed' }], epochChanged: false,
  },
};

const tooLong = (length: number) => 'x'.repeat(length + 1);

/** One malformed payload for every declared inbound command. */
export const malformedWebviewMessages: Record<string, Record<string, unknown>> = {
  send: { ...validWebviewMessages.send, agentId: tooLong(160) },
  interrupt: { ...validWebviewMessages.interrupt, agentId: tooLong(160) },
  selectAgent: { ...validWebviewMessages.selectAgent, agentId: tooLong(160) },
  setMode: { ...validWebviewMessages.setMode, agentId: tooLong(160) },
  approvalDecision: { ...validWebviewMessages.approvalDecision, id: tooLong(240) },
  setApproval: { ...validWebviewMessages.setApproval, kind: 'other' },
  compactContext: { command: 'compactContext', unexpected: { cannot: 'authorize' } },
  focusEditor: { command: 'focusEditor', unexpected: [] },
  openCheckpointDiff: { ...validWebviewMessages.openCheckpointDiff, checkpointId: '' },
  restoreCheckpoint: { ...validWebviewMessages.restoreCheckpoint, checkpointId: -1 },
  openToolFile: { ...validWebviewMessages.openToolFile, toolId: tooLong(240) },
  repairAction: { ...validWebviewMessages.repairAction, kind: 'anything' },
  chatCommand: { ...validWebviewMessages.chatCommand, target: tooLong(240) },
  handoffToSolo: { ...validWebviewMessages.handoffToSolo, id: tooLong(240) },
  composerInsertionApplied: { ...validWebviewMessages.composerInsertionApplied, revision: 1.5 },
  accessibilityFocus: { ...validWebviewMessages.accessibilityFocus, focused: 'true' },
  renderedTranscriptItemsMissing: { ...validWebviewMessages.renderedTranscriptItemsMissing, agentId: tooLong(160) },
};

/** Every bounded identity field, including nested IDs, one byte over its public cap. */
export const overlongWebviewIdentityMessages: Array<[string, Record<string, unknown>]> = [
  ['send.agentId', { ...validWebviewMessages.send, agentId: tooLong(160) }],
  ['send.requestId', { ...validWebviewMessages.send, requestId: tooLong(120) }],
  ['interrupt.agentId', { ...validWebviewMessages.interrupt, agentId: tooLong(160) }],
  ['selectAgent.agentId', { ...validWebviewMessages.selectAgent, agentId: tooLong(160) }],
  ['setMode.agentId', { ...validWebviewMessages.setMode, agentId: tooLong(160) }],
  ['approvalDecision.id', { ...validWebviewMessages.approvalDecision, id: tooLong(240) }],
  ['openToolFile.agentId', { ...validWebviewMessages.openToolFile, agentId: tooLong(160) }],
  ['openToolFile.toolId', { ...validWebviewMessages.openToolFile, toolId: tooLong(240) }],
  ['chatCommand.target', { ...validWebviewMessages.chatCommand, target: tooLong(240) }],
  ['handoffToSolo.id', { ...validWebviewMessages.handoffToSolo, id: tooLong(240) }],
  ['renderedTranscriptItemsMissing.agentId', { ...validWebviewMessages.renderedTranscriptItemsMissing, agentId: tooLong(160) }],
  ['renderedTranscriptItemsMissing.missing.id', {
    ...validWebviewMessages.renderedTranscriptItemsMissing,
    missing: [{ id: tooLong(240), delivery: 'committed' }],
  }],
];
