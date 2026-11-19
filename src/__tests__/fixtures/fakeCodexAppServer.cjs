'use strict';
// A fake `codex` program for the activation-level Codex flows: `node fakeCodexAppServer.cjs <control.json> <codex args...>`.
// It answers `--version`, `login status` and a whole App Server JSON-RPC session the way the measured 0.165 App Server
// does, and plays the control file's scenario after `turn/start`: one or more sandbox escapes
// (`item/commandExecution/requestApproval`), each answered by the extension before the next step, with a failed sandbox
// attempt between them when the scenario says so. Every message it receives and every answer it gets is appended to the
// control file's log, one JSON object per line, written synchronously.
// v0.9.105 (D5-1): a scenario with `computerUse: { app, persist }` instead plays Codex's per-app Computer Use card, as
// the probe of 2026-11-16 recorded it on 0.169: one `mcpServer/elicitation/request`, then the tool call's result.
// v0.9.105 (field smoke F8.3): a scenario with `readFile: { path }` instead calls the host's `read_file` dynamic tool
// (`item/tool/call`) once, logs the host's answer and ends the turn.
const fs = require('node:fs');
const path = require('node:path');

const [controlFile, ...args] = process.argv.slice(2);
const readControl = () => JSON.parse(fs.readFileSync(controlFile, 'utf8'));
const log = (event) => fs.appendFileSync(readControl().log, `${JSON.stringify({ pid: process.pid, t: Date.now(), ...event })}\n`);
log({ event: 'start', argv: args });

if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.165.0\n');
} else if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\n');
} else if (args[0] === 'app-server') {
  const setting = (key) => {
    const at = args.findIndex((arg, index) => args[index - 1] === '-c' && arg.startsWith(`${key}=`));
    if (at < 0) return undefined;
    const raw = args[at].slice(key.length + 1);
    try { return JSON.parse(raw); } catch { return raw; }
  };
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
  const THREAD = 'thread-fake';
  const TURN = 'turn-1';
  let serverSeq = 0;
  const pendingAnswers = new Map();
  let escapeIndex = 0;
  let extraSkillRoots = [];

  /** A sandbox escape as App Server 0.165 sends it, with its item first. */
  const sendEscape = () => {
    const scenario = readControl().scenario;
    const escape = scenario.escapes[escapeIndex];
    const itemId = `item-escape-${escapeIndex + 1}`;
    const id = `escape-${escapeIndex + 1}`;
    notify('item/started', { threadId: THREAD, turnId: TURN, item: { id: itemId, type: 'commandExecution', command: escape, status: 'inProgress' } });
    pendingAnswers.set(id, { itemId, command: escape });
    send({ jsonrpc: '2.0', id, method: 'item/commandExecution/requestApproval', params: {
      threadId: THREAD, turnId: TURN, itemId, startedAtMs: Date.now(), environmentId: 'local',
      command: escape, cwd: process.cwd(), reason: 'The folder is outside the writable workspace.',
      commandActions: [{ type: 'unknown', command: escape }],
      // A blocked-network escape carries the host it would reach (App Server 0.165 `networkApprovalContext`).
      ...(scenario.networkContext ? { networkApprovalContext: { host: 'example.com', protocol: 'https' } } : {}),
    } });
  };

  /** Codex's per-app Computer Use card, in the shape the 2026-11-16 probe recorded on 0.169. */
  const sendComputerUse = () => {
    const { app, persist } = readControl().scenario.computerUse;
    const id = 'computer-use-1';
    pendingAnswers.set(id, { computerUse: app, itemId: 'item-computer-use-1' });
    notify('item/started', { threadId: THREAD, turnId: TURN, item: { id: 'item-computer-use-1', type: 'mcpToolCall', server: 'node_repl', tool: 'js', status: 'inProgress', arguments: { code: 'await sky.launch_app({ app })', title: `Opening ${app}` } } });
    send({ jsonrpc: '2.0', id, method: 'mcpServer/elicitation/request', params: {
      threadId: THREAD, turnId: TURN, serverName: 'node_repl', mode: 'form', message: `Allow Codex to use ${app}?`,
      requestedSchema: { type: 'object', properties: {} },
      _meta: { callId: 'item-computer-use-1', codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', connector_name: 'Computer Use',
        persist, riskLevel: 'low', tool_params: { app: `Fixture.${app}!App` },
        tool_params_display: [{ display_name: 'App', name: 'app', value: app }] },
    } });
  };

  /** The host's own read_file, called the way App Server calls a dynamic tool. */
  const sendReadFile = () => {
    const target = readControl().scenario.readFile.path;
    const id = 'read-file-1';
    pendingAnswers.set(id, { readFile: target });
    send({ jsonrpc: '2.0', id, method: 'item/tool/call', params: {
      threadId: THREAD, turnId: TURN, callId: 'call-read-file-1', namespace: null, tool: 'read_file', arguments: { path: target } } });
  };

  const finishTurn = () => {
    const scenario = readControl().scenario;
    notify('item/completed', { threadId: THREAD, turnId: TURN, item: { id: 'item-reply', type: 'agentMessage', text: scenario.reply } });
    notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed' } });
  };

  const answered = (id, result) => {
    const escape = pendingAnswers.get(id);
    if (!escape) return;
    pendingAnswers.delete(id);
    if (escape.readFile) {
      log({ event: 'answer', id, readFile: escape.readFile, result });
      finishTurn();
      return;
    }
    if (escape.computerUse) {
      const action = result && result.action;
      const persist = result && result._meta ? result._meta.persist : undefined;
      log({ event: 'answer', id, decision: action, persist, result });
      const allowed = action === 'accept';
      notify('item/completed', { threadId: THREAD, turnId: TURN, item: { id: escape.itemId, type: 'mcpToolCall', server: 'node_repl', tool: 'js',
        status: allowed ? 'completed' : 'failed',
        result: { content: [{ type: 'text', text: allowed ? `Opened ${escape.computerUse}.` : `Computer Use was not approved to use ${escape.computerUse}` }] } } });
      finishTurn();
      return;
    }
    const decision = result && result.decision;
    log({ event: 'answer', id, decision });
    const ran = decision === 'accept';
    notify('item/completed', { threadId: THREAD, turnId: TURN, item: {
      id: escape.itemId, type: 'commandExecution', command: escape.command,
      status: ran ? 'completed' : 'declined', exitCode: ran ? 0 : null, aggregatedOutput: '' } });
    const scenario = readControl().scenario;
    escapeIndex += 1;
    if (escapeIndex >= scenario.escapes.length) { finishTurn(); return; }
    // Measured: after the sandbox-first note Codex retries inside the sandbox, the write is refused there, and Codex asks
    // to leave the sandbox again.
    const delay = scenario.sandboxAttemptBetween ? 50 : 0;
    setTimeout(() => {
      if (scenario.sandboxAttemptBetween) {
        const attempt = `item-sandbox-${escapeIndex}`;
        // The scenario may name the attempt's own command and output (a network failure, or a different command).
        const attemptCommand = scenario.sandboxAttemptCommand || scenario.escapes[escapeIndex];
        const attemptOutput = scenario.sandboxAttemptOutput || 'Access to the path is denied.';
        notify('item/started', { threadId: THREAD, turnId: TURN, item: { id: attempt, type: 'commandExecution', command: attemptCommand, status: 'inProgress' } });
        notify('item/completed', { threadId: THREAD, turnId: TURN, item: { id: attempt, type: 'commandExecution',
          command: attemptCommand, status: 'failed', exitCode: 1, aggregatedOutput: attemptOutput } });
      }
      sendEscape();
    }, delay);
  };

  const config = () => ({
    model_provider: 'openai', openai_base_url: 'https://api.openai.com/v1',
    notify: [], model_providers: {}, mcp_servers: {},
    analytics: { enabled: setting('analytics.enabled') },
    otel: { exporter: setting('otel.exporter') },
    approval_policy: setting('approval_policy'),
    approvals_reviewer: setting('approvals_reviewer'),
    sandbox_mode: setting('sandbox_mode'),
    sandbox_workspace_write: { network_access: setting('sandbox_workspace_write.network_access') === true },
    apps: { _default: {
      default_tools_approval_mode: setting('apps._default.default_tools_approval_mode'),
      approvals_reviewer: setting('apps._default.approvals_reviewer'),
    } },
  });

  // Measured on App Server: a process holds the sandbox of its first thread request. A thread/start reports no extra
  // writable roots (its working folder covers the workspace); a thread/resume in a new process applies the requested
  // workspace roots. Network is what the process was started with.
  let held;
  const threadResponse = (method, params) => {
    if (!held) {
      held = {
        sandbox: params.sandbox,
        writableRoots: method === 'thread/resume' ? [...(params.runtimeWorkspaceRoots || [])] : [],
      };
    }
    return {
      thread: { id: THREAD },
      cwd: params.cwd,
      approvalPolicy: params.approvalPolicy,
      approvalsReviewer: params.approvalsReviewer,
      modelProvider: params.modelProvider,
      runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
      model: params.model || 'gpt-test',
      sandbox: held.sandbox === 'read-only'
        ? { type: 'readOnly', networkAccess: false }
        : held.sandbox === 'danger-full-access'
          ? { type: 'dangerFullAccess' }
          : { type: 'workspaceWrite', writableRoots: held.writableRoots,
            networkAccess: setting('sandbox_workspace_write.network_access') === true, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    };
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      log({ event: 'received', message });
      if (message.method === undefined) {
        if (message.id !== undefined) answered(message.id, message.result);
        continue;
      }
      const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
      switch (message.method) {
        case 'initialize': reply({ userAgent: 'fake/0.165.0', codexHome: process.env.CODEX_HOME || null }); break;
        case 'initialized': break;
        case 'config/read': reply({ config: config(), origins: {}, layers: [] }); break;
        case 'hooks/list': reply({ data: [{ cwd: process.cwd(), hooks: [], warnings: [], errors: [] }] }); break;
        case 'model/list': reply({ data: [{ id: 'gpt-test', displayName: 'GPT Test', isDefault: true, hidden: false, inputModalities: ['text'] }] }); break;
        case 'skills/extraRoots/set':
          extraSkillRoots = [...((message.params && message.params.extraRoots) || [])];
          reply({});
          break;
        case 'skills/list':
          // As App Server lists them: every skill folder under the extra roots the extension set, by its SKILL.md name.
          reply({ data: extraSkillRoots.length === 0 ? [] : [{
            cwd: process.cwd(),
            skills: extraSkillRoots.flatMap((root) => fs.readdirSync(root, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
              .map((entry) => {
                const skillPath = fs.realpathSync(path.join(root, entry.name, 'SKILL.md'));
                const name = (/^name:\s*(.+)$/m.exec(fs.readFileSync(skillPath, 'utf8')) || [])[1];
                return { name: name ? name.trim() : entry.name, description: 'fixture', path: skillPath, scope: 'user', enabled: true, pluginId: null };
              })),
            errors: [],
          }] });
          break;
        case 'thread/start':
        case 'thread/resume': reply(threadResponse(message.method, message.params || {})); break;
        case 'turn/start':
          // Each turn plays the scenario from its start; a scenario with no escape only replies.
          escapeIndex = 0;
          // `escapeBeforeTurnReply`: the first escape reaches the host before the answer that carries the turn's id.
          if (readControl().scenario.escapeBeforeTurnReply && readControl().scenario.escapes.length > 0) {
            notify('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } });
            sendEscape();
            reply({ turn: { id: TURN, status: 'inProgress' } });
            break;
          }
          reply({ turn: { id: TURN, status: 'inProgress' } });
          notify('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } });
          setTimeout(() => (readControl().scenario.computerUse ? sendComputerUse()
            : readControl().scenario.readFile ? sendReadFile()
              : readControl().scenario.escapes.length > 0 ? sendEscape() : finishTurn()), 20);
          break;
        case 'turn/steer': reply({ turnId: message.params && message.params.expectedTurnId }); break;
        case 'turn/interrupt': reply({}); break;
        default:
          if (message.id !== undefined) reply({});
      }
      void serverSeq;
    }
  });
  process.stdin.on('end', () => { log({ event: 'stdin-end' }); process.exit(0); });
  setInterval(() => undefined, 1000);
} else {
  process.stderr.write(`fake codex: unexpected arguments ${JSON.stringify(args)}\n`);
  process.exitCode = 2;
}
