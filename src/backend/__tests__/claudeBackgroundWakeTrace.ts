/*
 * v0.9.103 (F2): the stream of a Claude CLI process whose background task finishes after the host's turn ended, as the
 * native probe recorded it (Claude CLI 2.1.318, `--output-format stream-json --replay-user-messages`, Haiku, an empty
 * workspace). The event types and fields are the probe's own; ids, paths and costs are rewritten. Nothing here adds a
 * field the probe did not show. The shell call inside a wake and the person's packet read during a wake are not in the
 * probe: they reuse the probe's own `assistant` tool_use, `user` tool_result, `command_lifecycle` and replay shapes.
 *
 * Probe order: our packet; command_lifecycle queued, started; system/init (with user_message_uuids); status requesting;
 * the replay of our packet; assistant Bash `run_in_background: true`; background_tasks_changed; task_started; the tool
 * result; STARTED; result; command_lifecycle completed. About 14 s later, with no input: task_updated (completed);
 * task_notification (task_id, tool_use_id, status, output_file, summary); background_tasks_changed (empty); a new
 * system/init without user_message_uuids; an assistant reply; a second result with origin task-notification.
 */

/** The probe's summary of its finished background command, verbatim. */
export const PROBE_SUMMARY = 'Background command "Run sleep 15 then echo marker in background" completed (exit code 0)';
export const PROBE_DESCRIPTION = 'Run sleep 15 then echo marker in background';

export interface ProbeTask { taskId: string; toolUseId: string; runId: string; description: string; summary: string }

export function probeTask(tag: string, summary = PROBE_SUMMARY, description = PROBE_DESCRIPTION): ProbeTask {
  return { taskId: `bg${tag}`, toolUseId: `toolu_bg_${tag}`, runId: `run-${tag}`, description, summary };
}

/** One fake CLI's stream. Costs and the model usage are cumulative per process, as the CLI reports them. */
export function probeCli(sessionId = 'probe-session-1') {
  let seq = 0;
  let resultIndex = 0;
  let totalCost = 0;
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const uuid = (prefix: string) => `${prefix}-${sessionId}-${++seq}`;
  const usage = { input_tokens: 4, cache_creation_input_tokens: 388, cache_read_input_tokens: 29_539, output_tokens: 165 };
  const messageUsage = { input_tokens: 4, cache_creation_input_tokens: 388, cache_read_input_tokens: 29_539,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 388 }, output_tokens: 7, service_tier: 'standard' };

  const cli = {
    sessionId,
    /** The CLI took (`queued`), read (`started`) or finished (`completed`) one of our packets. */
    lifecycle: (commandUuid: string, state: 'queued' | 'started' | 'completed') => ({
      type: 'command_lifecycle', command_uuid: commandUuid, state, uuid: uuid('lc'), session_id: sessionId,
    }),
    /** system/init. The probe's init for our packet lists its uuid; the wake's init has no user_message_uuids. */
    init: (userMessageUuids?: string[]) => ({
      type: 'system', subtype: 'init', cwd: 'C:\\probe-ws\\bg-native', session_id: sessionId, tools: ['Task', 'Bash', 'Read', 'Write'],
      mcp_servers: [], model: 'claude-haiku-5-5', permissionMode: 'bypassPermissions', apiKeySource: 'none',
      claude_code_version: '2.1.318', output_style: 'default', uuid: uuid('init'),
      ...(userMessageUuids ? { user_message_uuids: userMessageUuids } : {}),
    }),
    requesting: (userMessageUuids?: string[]) => ({
      type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId, uuid: uuid('status'),
      ...(userMessageUuids ? { user_message_uuids: userMessageUuids } : {}),
    }),
    /** `--replay-user-messages`: the CLI's echo of a packet it read. */
    replay: (packetUuid: string, content: unknown) => ({
      type: 'user', message: { role: 'user', content }, session_id: sessionId, parent_tool_use_id: null, uuid: packetUuid,
      timestamp: '2026-11-14T23:29:31.050Z', isReplay: true,
    }),
    /** An assistant message with one Bash tool_use, in the probe's shape. */
    bash: (toolUseId: string, command: string, description: string, runInBackground = false) => {
      const input = { command, description, ...(runInBackground ? { run_in_background: true } : {}) };
      return {
        type: 'assistant',
        message: { model: 'claude-haiku-5-5', id: uuid('msg'), type: 'message', role: 'assistant',
          content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input, caller: { type: 'direct' } }],
          stop_reason: null, stop_sequence: null, usage: messageUsage },
        parent_tool_use_id: null, session_id: sessionId, uuid: uuid('asst'), timestamp: '2026-11-14T23:29:32.680Z',
      };
    },
    /** The CLI's tool result for a call (for a refused call, the denial it was given). */
    toolResult: (toolUseId: string, content: string, isError = false) => ({
      type: 'user', message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }] },
      parent_tool_use_id: null, session_id: sessionId, uuid: uuid('tr'), timestamp: '2026-11-14T23:29:34.560Z',
    }),
    thinking: () => ({
      type: 'assistant',
      message: { model: 'claude-haiku-5-5', id: uuid('msg'), type: 'message', role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'opaque-signature' }], stop_reason: null, stop_sequence: null, usage: messageUsage },
      parent_tool_use_id: null, session_id: sessionId, uuid: uuid('asst'), timestamp: '2026-11-14T23:29:51.608Z',
    }),
    text: (text: string) => ({
      type: 'assistant',
      message: { model: 'claude-haiku-5-5', id: uuid('msg'), type: 'message', role: 'assistant',
        content: [{ type: 'text', text }], stop_reason: null, stop_sequence: null, usage: messageUsage },
      parent_tool_use_id: null, session_id: sessionId, uuid: uuid('asst'), timestamp: '2026-11-14T23:29:51.905Z',
    }),
    tasksChanged: (task?: ProbeTask) => ({
      type: 'system', subtype: 'background_tasks_changed',
      tasks: task ? [{ task_id: task.taskId, run_id: task.runId, task_type: 'local_bash', description: task.description }] : [],
      uuid: uuid('btc'), session_id: sessionId,
    }),
    taskStarted: (task: ProbeTask) => ({
      type: 'system', subtype: 'task_started', task_id: task.taskId, run_id: task.runId, tool_use_id: task.toolUseId,
      description: task.description, is_backgrounded: true, task_type: 'local_bash', uuid: uuid('ts'), session_id: sessionId,
    }),
    taskUpdated: (task: ProbeTask) => ({
      type: 'system', subtype: 'task_updated', task_id: task.taskId, run_id: task.runId,
      patch: { status: 'completed', end_time: 1794698989748 }, uuid: uuid('tu'), session_id: sessionId,
    }),
    taskNotification: (task: ProbeTask) => ({
      type: 'system', subtype: 'task_notification', task_id: task.taskId, run_id: task.runId, tool_use_id: task.toolUseId,
      status: 'completed', output_file: `C:\\probe-tmp\\tasks\\${task.taskId}.output`, summary: task.summary,
      uuid: uuid('tn'), session_id: sessionId,
    }),
    /**
     * A terminal result. For our packet it names the packet's uuid; for a wake it carries the probe's
     * `origin: { kind: 'task-notification' }`. `total_cost_usd` and `modelUsage` are the process totals so far.
     */
    result: (text: string, options: { userMessageUuid?: string; wakeRunId?: string; cost?: number } = {}) => {
      totalCost += options.cost ?? 0.0005;
      totals.inputTokens += usage.input_tokens;
      totals.outputTokens += usage.output_tokens;
      totals.cacheReadInputTokens += usage.cache_read_input_tokens;
      totals.cacheCreationInputTokens += usage.cache_creation_input_tokens;
      return {
        duration_api_ms: 2665, stop_reason: 'end_turn', session_id: sessionId, total_cost_usd: totalCost,
        usage: { ...usage, service_tier: 'standard' },
        modelUsage: { 'claude-haiku-5-5': { ...totals, webSearchRequests: 0, costUSD: totalCost, contextWindow: 1_000_000, maxOutputTokens: 128_000 } },
        permission_denials: [], terminal_reason: 'completed',
        ...(options.wakeRunId ? { origin: { kind: 'task-notification', producer: 'session-task', runId: options.wakeRunId } } : {}),
        is_error: false, num_turns: 1, subtype: 'success', result: text, type: 'result', duration_ms: 2076, uuid: uuid('res'),
        ...(options.userMessageUuid ? { user_message_uuid: options.userMessageUuid, user_message_uuids: [options.userMessageUuid] } : {}),
        queued_turn_count: 0, result_index: resultIndex++,
      };
    },
  };

  return {
    ...cli,
    /** The CLI reads our packet and starts its turn: lifecycle started, init, status requesting, replay (the probe's order). */
    reads: (packetUuid: string, content: unknown) => [
      cli.lifecycle(packetUuid, 'started'), cli.init([packetUuid]), cli.requesting([packetUuid]), cli.replay(packetUuid, content),
    ],
    /** The probe's whole first turn for our packet: the background Bash call, its start, STARTED and the result. */
    backgroundTurn: (packetUuid: string, content: unknown, task: ProbeTask, startedText = 'STARTED') => [
      cli.lifecycle(packetUuid, 'queued'),
      cli.lifecycle(packetUuid, 'started'), cli.init([packetUuid]), cli.requesting([packetUuid]), cli.replay(packetUuid, content),
      cli.bash(task.toolUseId, 'sleep 15 && echo BACKGROUND-DONE', task.description, true),
      cli.tasksChanged(task), cli.taskStarted(task),
      cli.toolResult(task.toolUseId, `Command running in background with ID: ${task.taskId}. You will be notified when it completes.`),
      cli.requesting([packetUuid]), cli.text(startedText),
      cli.result(startedText, { userMessageUuid: packetUuid }),
      cli.lifecycle(packetUuid, 'completed'),
    ],
    /** The background task finished with no host turn open: task_updated, task_notification, background_tasks_changed. */
    finishes: (task: ProbeTask) => [cli.taskUpdated(task), cli.taskNotification(task), cli.tasksChanged()],
    /** The CLI starts its own turn: a new init without user_message_uuids, and its request. */
    wakeStarts: () => [cli.init(), cli.requesting()],
    /** The wake's reply as the probe recorded it: thinking, then text. */
    wakeReplies: (text: string) => [cli.thinking(), cli.text(text)],
    wakeEnds: (text: string, task: ProbeTask, cost?: number) => cli.result(text, { wakeRunId: task.runId, cost }),
  };
}

export type ProbeCli = ReturnType<typeof probeCli>;
