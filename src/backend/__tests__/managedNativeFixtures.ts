import { EventEmitter } from 'node:events';
import { execFile, type ChildProcess } from 'node:child_process';
import { terminateChildProcessTree } from '../processTree';

/** Deterministic protocol transport only. command/exec runs the real argv; this fake is not OS sandbox evidence. */
export function managedCodexTransport(options: { unsupportedCommand?: boolean; imageModels?: string[] } = {}) {
  const messages: any[] = []; const waiters = new Map<string, (value: any) => void>();
  const processes = new Map<string, ChildProcess>(); let proc: any;
  const emit = (message: unknown) => queueMicrotask(() => proc.stdout.emit('data', JSON.stringify(message) + '\n'));
  const spawn = (_command: string, args: string[]) => {
    const setting = (key: string) => { const text = args.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1); try { return text === undefined ? undefined : JSON.parse(text); } catch { return text; } };
    proc = managedClaudeTransport().spawn();
    proc.stdin = { writable: true, end: () => {}, write: (text: string) => {
      for (const line of text.split('\n').filter(Boolean)) {
        const message = JSON.parse(line); messages.push(message);
        const reply = (result: unknown) => emit({ jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'initialize') reply({});
        else if (message.method === 'config/read') reply({ config: { model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
          approval_policy: setting('approval_policy'), approvals_reviewer: setting('approvals_reviewer'), sandbox_mode: setting('sandbox_mode'),
          sandbox_workspace_write: { network_access: setting('sandbox_workspace_write.network_access') === true }, apps: { _default: { default_tools_approval_mode: setting('apps._default.default_tools_approval_mode'), approvals_reviewer: setting('apps._default.approvals_reviewer') } } }, origins: {}, layers: [] });
        else if (message.method === 'model/list') reply({ data: (options.imageModels ?? []).map(model => ({ id: model, model, inputModalities: ['text', 'image'] })) });
        else if (message.method === 'skills/list') reply({ data: [] });
        else if (message.method === 'skills/extraRoots/set' || message.method === 'turn/interrupt') reply({});
        else if (message.method === 'thread/start' || message.method === 'thread/resume') reply({ thread: { id: 'thread-native' }, cwd: message.params.cwd,
          approvalPolicy: message.params.approvalPolicy, approvalsReviewer: message.params.approvalsReviewer, modelProvider: message.params.modelProvider,
          runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots,
          sandbox: message.params.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
            : { type: 'workspaceWrite', writableRoots: message.params.config?.sandbox_workspace_write?.writable_roots ?? [], networkAccess: message.params.config?.sandbox_workspace_write?.network_access === true, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
        else if (message.method === 'turn/start') reply({ turn: { id: 'turn-native', status: 'inProgress' } });
        else if (message.method === 'command/exec') {
          if (options.unsupportedCommand) { emit({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); continue; }
          const argv = message.params.command;
          const child = execFile(argv[0], argv.slice(1), { cwd: message.params.cwd, env: { ...process.env, ...message.params.env }, windowsHide: true }, error => {
            processes.delete(message.params.processId); reply({ exitCode: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout: '', stderr: '' });
          }); processes.set(message.params.processId, child);
        } else if (message.method === 'command/exec/terminate') {
          const child = processes.get(message.params.processId);
          void (child ? terminateChildProcessTree(child) : Promise.resolve()).then(() => reply({}));
        } else if (message.id !== undefined && !message.method) waiters.get(String(message.id))?.(message);
      }
      return true;
    } };
    return proc;
  };
  return { spawn: spawn as any, messages,
    notify(method: string, params: Record<string, unknown>) { emit({ jsonrpc: '2.0', method, params }); },
    call(tool: string, args: Record<string, unknown>, id: string): Promise<any> {
      return new Promise(resolve => { waiters.set(id, resolve); emit({ jsonrpc: '2.0', id, method: 'item/tool/call', params: {
        threadId: 'thread-native', turnId: 'turn-native', callId: id, tool, arguments: args,
      } }); });
    },
    stop: async () => { proc.kill(); },
  };
}

export function managedClaudeTransport() {
  const calls: Array<{ args: string[] }> = [];
  const spawn = (_command?: string, args: string[] = []) => {
    calls.push({ args }); const proc: any = new EventEmitter(); proc.exitCode = null;
    // Deliberately no PID: this is transport state, never an OS process to signal.
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.stdout.setEncoding = proc.stderr.setEncoding = () => {};
    proc.stdin = { writable: true, write: () => true, end: () => {} };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    queueMicrotask(() => proc.emit('spawn')); return proc;
  };
  return { spawn: spawn as any, calls };
}
