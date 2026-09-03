import * as vscode from 'vscode';
import { WorkflowBranch, WorkflowConfig, WorkflowStep } from '../types';
import { WorkflowTemplate } from '../workflow/WorkflowEngine';
import { migrateWorkflowBranchLabel } from '../workflow/GatedWorkflow';
import { csp, nonce } from './webviewSecurity';

export interface WorkflowEditorAgent {
  id: string;
  name: string;
  role: string;
}

export interface WorkflowEditorDeps {
  listWorkflows: () => Promise<WorkflowTemplate[]>;
  listAgents: () => WorkflowEditorAgent[];
  saveWorkflow: (workflow: WorkflowConfig) => Promise<{ ok: true } | { ok: false; error: string }>;
  deleteWorkflow: (id: string) => Promise<void>;
}

type WebviewMessage =
  | { command?: 'requestWorkflows' }
  | { command?: 'saveWorkflow'; workflow?: unknown }
  | { command?: 'deleteWorkflow'; id?: unknown };

export class WorkflowEditor {
  private static current: WorkflowEditor | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(extensionUri: vscode.Uri, deps: WorkflowEditorDeps): void {
    if (WorkflowEditor.current) {
      WorkflowEditor.current.panel.reveal(vscode.ViewColumn.One);
      void WorkflowEditor.current.postWorkflowData();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'unodeWorkflowEditor',
      'UnodeAi Workflow Editor',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );
    WorkflowEditor.current = new WorkflowEditor(panel, deps);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: WorkflowEditorDeps
  ) {
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((message) => this.onMessage(message), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private dispose(): void {
    WorkflowEditor.current = undefined;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    if (!message || typeof message.command !== 'string') {
      return;
    }
    if (message.command === 'requestWorkflows') {
      await this.postWorkflowData();
      return;
    }
    if (message.command === 'saveWorkflow') {
      const workflow = parseWorkflow(message.workflow);
      if (!workflow) {
        await this.panel.webview.postMessage({ command: 'error', message: 'Workflow data is malformed.' });
        return;
      }
      const result = await this.deps.saveWorkflow(workflow);
      if (!result.ok) {
        await this.panel.webview.postMessage({ command: 'error', message: result.error });
        return;
      }
      await this.panel.webview.postMessage({ command: 'saved', id: workflow.id });
      await this.postWorkflowData();
      return;
    }
    if (message.command === 'deleteWorkflow') {
      const id = typeof message.id === 'string' ? message.id : '';
      if (id) {
        await this.deps.deleteWorkflow(id);
        await this.postWorkflowData();
      }
    }
  }

  private async postWorkflowData(): Promise<void> {
    const workflows = await this.deps.listWorkflows();
    await this.panel.webview.postMessage({
      command: 'workflowData',
      builtins: workflows.filter((workflow) => workflow.builtin !== false),
      custom: workflows.filter((workflow) => workflow.builtin === false),
      agents: this.deps.listAgents(),
    });
  }

  private html(webview: vscode.Webview): string {
    const scriptNonce = nonce();
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview, scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UnodeAi Workflow Editor</title>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 10px;
      padding: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
    }
    .top { display: grid; gap: 8px; }
    .tabs, .toolbar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    button, input, textarea, select {
      font: inherit;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 5px;
      padding: 5px 9px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.danger {
      color: var(--vscode-errorForeground);
      background: transparent;
      border-color: var(--vscode-panel-border);
    }
    button:disabled { opacity: .55; cursor: default; }
    .editor {
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(240px, 32%) 1fr;
      gap: 12px;
    }
    .pane {
      min-height: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-sideBar-background);
    }
    .pane-head {
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: grid;
      gap: 6px;
    }
    .pane-body { padding: 8px; overflow: auto; height: 100%; }
    .workflow-fields {
      display: grid;
      grid-template-columns: 160px 1fr;
      gap: 6px;
    }
    .field { display: grid; gap: 4px; margin-bottom: 8px; }
    label { color: var(--vscode-descriptionForeground); font-size: 11px; }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 5px 7px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }
    textarea { min-height: 86px; resize: vertical; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    li.step {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 8px;
      align-items: start;
      padding: 7px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      background: var(--vscode-editor-background);
      cursor: grab;
    }
    li.step.active {
      border-color: var(--vscode-charts-yellow, #f5c542);
      background: rgba(245, 197, 66, 0.16);
      color: var(--vscode-foreground);
      box-shadow: inset 3px 0 0 var(--vscode-charts-yellow, #f5c542), 0 0 0 1px var(--vscode-charts-yellow, #f5c542);
    }
    li.step.active .muted {
      color: var(--vscode-foreground);
    }
    .badge {
      border-radius: 999px;
      padding: 1px 6px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 10px;
    }
    .muted { color: var(--vscode-descriptionForeground); }
    .step-title { display: grid; gap: 2px; min-width: 0; }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .branches { display: grid; gap: 8px; }
    .branch {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) minmax(140px, 220px) auto;
      gap: 6px;
      align-items: end;
      padding: 7px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
    }
    .status { min-height: 20px; color: var(--vscode-descriptionForeground); }
    .status.error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="top">
    <div class="tabs" id="templateTabs"></div>
    <div class="workflow-fields">
      <div class="field"><label for="workflowId">Workflow ID</label><input id="workflowId"></div>
      <div class="field"><label for="workflowName">Name</label><input id="workflowName"></div>
    </div>
    <div class="field"><label for="workflowDescription">Description</label><input id="workflowDescription"></div>
  </div>
  <div class="editor">
    <section class="pane">
      <div class="pane-head">
        <strong>Steps</strong>
        <div class="toolbar"><button id="addStep" type="button">Add Step</button></div>
      </div>
      <div class="pane-body"><ul id="steps"></ul></div>
    </section>
    <section class="pane">
      <div class="pane-head"><strong>Step Detail</strong></div>
      <div class="pane-body" id="detail"></div>
    </section>
  </div>
  <div class="toolbar">
    <button id="save" type="button">Save</button>
    <button id="deleteWorkflow" type="button" class="danger">Delete Custom Workflow</button>
    <span id="status" class="status"></span>
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const state = { builtins: [], custom: [], agents: [], workflow: null, selectedStepId: '', draggedStepId: '' };
    const tabs = document.getElementById('templateTabs');
    const workflowId = document.getElementById('workflowId');
    const workflowName = document.getElementById('workflowName');
    const workflowDescription = document.getElementById('workflowDescription');
    const steps = document.getElementById('steps');
    const detail = document.getElementById('detail');
    const status = document.getElementById('status');
    const save = document.getElementById('save');
    const addStep = document.getElementById('addStep');
    const deleteWorkflow = document.getElementById('deleteWorkflow');

    function setStatus(text, error) {
      status.textContent = text || '';
      status.classList.toggle('error', !!error);
    }

    function cloneWorkflow(workflow, suffix) {
      const copy = JSON.parse(JSON.stringify(workflow));
      if (suffix) {
        copy.id = uniqueWorkflowId(copy.id + '-custom');
        copy.name = copy.name + ' Custom';
      }
      copy.description = copy.description || '';
      copy.steps = Array.isArray(copy.steps) ? copy.steps : [];
      return copy;
    }

    function uniqueWorkflowId(base) {
      const used = new Set([...state.builtins, ...state.custom].map((workflow) => workflow.id));
      let id = String(base || 'workflow').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
      let next = id;
      let n = 2;
      while (used.has(next)) {
        next = id + '-' + n++;
      }
      return next;
    }

    function renderAll() {
      renderTabs();
      renderWorkflowFields();
      renderSteps();
      renderDetail();
    }

    function renderTabs() {
      tabs.replaceChildren();
      for (const workflow of state.builtins) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = workflow.name;
        button.addEventListener('click', () => {
          state.workflow = cloneWorkflow(workflow, true);
          state.selectedStepId = state.workflow.steps[0]?.id || '';
          setStatus('Loaded built-in template as a custom draft.', false);
          renderAll();
        });
        tabs.appendChild(button);
      }
      for (const workflow of state.custom) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = workflow.name;
        button.addEventListener('click', () => {
          state.workflow = cloneWorkflow(workflow, false);
          state.selectedStepId = state.workflow.steps[0]?.id || '';
          setStatus('Loaded saved workflow.', false);
          renderAll();
        });
        tabs.appendChild(button);
      }
    }

    function renderWorkflowFields() {
      const workflow = ensureWorkflow();
      workflowId.value = workflow.id || '';
      workflowName.value = workflow.name || '';
      workflowDescription.value = workflow.description || '';
    }

    function renderSteps() {
      const workflow = ensureWorkflow();
      steps.replaceChildren();
      workflow.steps.forEach((step, index) => {
        const item = document.createElement('li');
        item.className = 'step';
        if (step.id === state.selectedStepId) item.classList.add('active');
        item.draggable = true;
        item.addEventListener('dragstart', () => { state.draggedStepId = step.id; });
        item.addEventListener('dragover', (event) => event.preventDefault());
        item.addEventListener('drop', (event) => {
          event.preventDefault();
          moveStep(state.draggedStepId, step.id);
        });
        item.addEventListener('click', () => {
          state.selectedStepId = step.id;
          renderAll();
        });
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = (step.branches && step.branches.length) ? 'gated' : 'step';
        const title = document.createElement('div');
        title.className = 'step-title';
        const top = document.createElement('strong');
        top.className = 'truncate';
        top.textContent = (index + 1) + '. ' + (step.to || 'No agent');
        const action = document.createElement('span');
        action.className = 'muted truncate';
        action.textContent = step.action || 'No action';
        title.append(top, action);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Delete';
        del.addEventListener('click', (event) => {
          event.stopPropagation();
          workflow.steps = workflow.steps.filter((candidate) => candidate.id !== step.id);
          state.selectedStepId = workflow.steps[0]?.id || '';
          renderAll();
        });
        item.append(badge, title, del);
        steps.appendChild(item);
      });
    }

    function renderDetail() {
      const workflow = ensureWorkflow();
      detail.replaceChildren();
      const step = workflow.steps.find((candidate) => candidate.id === state.selectedStepId);
      if (!step) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'Select or add a step.';
        detail.appendChild(empty);
        return;
      }
      detail.append(
        field('Step ID', input(step.id, (value) => { step.id = value; state.selectedStepId = value; renderSteps(); })),
        field('From Agent', agentSelect(step.from, (value) => { step.from = value; })),
        field('To Agent', agentSelect(step.to, (value) => { step.to = value; renderSteps(); })),
        field('Action', textarea(step.action, (value) => { step.action = value; renderSteps(); })),
        field('Auto Transition', booleanSelect(step.autoTransition !== false, (value) => { step.autoTransition = value; })),
        field('Step Type', typeSelect(step, (isGated) => {
          step.branches = isGated ? (step.branches && step.branches.length ? step.branches : [{ label: 'outcome', goto: workflow.steps[0]?.id || step.id }]) : undefined;
          renderAll();
        })),
        branchEditor(step)
      );
    }

    function field(labelText, control) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const label = document.createElement('label');
      label.textContent = labelText;
      wrap.append(label, control);
      return wrap;
    }

    function input(value, onChange) {
      const node = document.createElement('input');
      node.value = value || '';
      node.addEventListener('input', () => onChange(node.value));
      return node;
    }

    function textarea(value, onChange) {
      const node = document.createElement('textarea');
      node.value = value || '';
      node.addEventListener('input', () => onChange(node.value));
      return node;
    }

    function agentSelect(value, onChange) {
      const node = document.createElement('select');
      for (const agent of state.agents) {
        const option = document.createElement('option');
        option.value = agent.id;
        option.textContent = agent.name + ' (' + agent.role + ')';
        node.appendChild(option);
      }
      if (!state.agents.some((agent) => agent.id === value)) {
        const option = document.createElement('option');
        option.value = value || '';
        option.textContent = value || 'Select agent';
        node.appendChild(option);
      }
      node.value = value || '';
      node.addEventListener('change', () => onChange(node.value));
      return node;
    }

    function booleanSelect(value, onChange) {
      const node = document.createElement('select');
      for (const item of [{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }]) {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        node.appendChild(option);
      }
      node.value = value ? 'true' : 'false';
      node.addEventListener('change', () => onChange(node.value === 'true'));
      return node;
    }

    function typeSelect(step, onChange) {
      const node = document.createElement('select');
      for (const item of [{ label: 'Linear', value: 'linear' }, { label: 'Gated', value: 'gated' }]) {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        node.appendChild(option);
      }
      node.value = step.branches && step.branches.length ? 'gated' : 'linear';
      node.addEventListener('change', () => onChange(node.value === 'gated'));
      return node;
    }

    function branchEditor(step) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const label = document.createElement('label');
      label.textContent = 'Branches';
      wrap.appendChild(label);
      if (!step.branches) {
        const hint = document.createElement('p');
        hint.className = 'muted';
        hint.textContent = 'Set Step Type to Gated to add branches.';
        wrap.appendChild(hint);
        return wrap;
      }
      const list = document.createElement('div');
      list.className = 'branches';
      step.branches.forEach((branch, index) => {
        const row = document.createElement('div');
        row.className = 'branch';
        row.append(
          field('Outcome label', input(branch.label || '', (value) => { branch.label = value; })),
          field('Go to', gotoSelect(branch.goto, step.id, (value) => { branch.goto = value; renderAll(); }))
        );
        if (isLoopTarget(step.id, branch.goto)) {
          const hint = document.createElement('span');
          hint.className = 'badge';
          hint.textContent = 'Loop';
          row.appendChild(hint);
        }
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Delete';
        del.addEventListener('click', () => {
          step.branches.splice(index, 1);
          renderAll();
        });
        row.appendChild(del);
        list.appendChild(row);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = 'Add Branch';
      add.addEventListener('click', () => {
        step.branches.push({ label: 'outcome', goto: state.workflow.steps[0]?.id || step.id });
        renderAll();
      });
      wrap.append(list, add);
      return wrap;
    }

    function gotoSelect(value, currentStepId, onChange) {
      const node = document.createElement('select');
      const currentIndex = state.workflow.steps.findIndex((step) => step.id === currentStepId);
      for (const step of state.workflow.steps) {
        const option = document.createElement('option');
        option.value = step.id;
        const targetIndex = state.workflow.steps.findIndex((candidate) => candidate.id === step.id);
        option.textContent = (targetIndex < currentIndex ? 'Loop to ' : '') + step.id;
        node.appendChild(option);
      }
      node.value = value || '';
      node.addEventListener('change', () => onChange(node.value));
      return node;
    }

    function isLoopTarget(currentStepId, targetStepId) {
      const currentIndex = state.workflow.steps.findIndex((step) => step.id === currentStepId);
      const targetIndex = state.workflow.steps.findIndex((step) => step.id === targetStepId);
      return currentIndex >= 0 && targetIndex >= 0 && targetIndex < currentIndex;
    }

    function ensureWorkflow() {
      if (!state.workflow) {
        state.workflow = {
          id: 'custom-workflow',
          name: 'Custom Workflow',
          description: '',
          steps: [],
        };
      }
      return state.workflow;
    }

    function moveStep(fromId, toId) {
      const workflow = ensureWorkflow();
      const from = workflow.steps.findIndex((step) => step.id === fromId);
      const to = workflow.steps.findIndex((step) => step.id === toId);
      if (from < 0 || to < 0 || from === to) return;
      const item = workflow.steps.splice(from, 1)[0];
      workflow.steps.splice(to, 0, item);
      renderAll();
    }

    addStep.addEventListener('click', () => {
      const workflow = ensureWorkflow();
      const id = 'step-' + (workflow.steps.length + 1);
      const firstAgent = state.agents[0]?.id || 'pm';
      const secondAgent = state.agents[1]?.id || firstAgent;
      workflow.steps.push({ id, from: firstAgent, to: secondAgent, action: 'Describe the work for this step', autoTransition: true });
      state.selectedStepId = id;
      renderAll();
    });

    save.addEventListener('click', () => {
      const workflow = ensureWorkflow();
      workflow.id = workflowId.value.trim();
      workflow.name = workflowName.value.trim();
      workflow.description = workflowDescription.value.trim();
      vscode.postMessage({ command: 'saveWorkflow', workflow });
    });

    deleteWorkflow.addEventListener('click', () => {
      const workflow = ensureWorkflow();
      if (workflow.id) {
        vscode.postMessage({ command: 'deleteWorkflow', id: workflow.id });
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.command === 'workflowData') {
        state.builtins = Array.isArray(message.builtins) ? message.builtins : [];
        state.custom = Array.isArray(message.custom) ? message.custom : [];
        state.agents = Array.isArray(message.agents) ? message.agents : [];
        if (!state.workflow) {
          state.workflow = cloneWorkflow(state.custom[0] || state.builtins[0] || { id: 'custom-workflow', name: 'Custom Workflow', steps: [] }, !state.custom[0]);
          state.selectedStepId = state.workflow.steps[0]?.id || '';
        }
        renderAll();
      } else if (message.command === 'saved') {
        setStatus('Workflow saved.', false);
      } else if (message.command === 'error') {
        setStatus(message.message || 'Workflow save failed.', true);
      }
    });

    vscode.postMessage({ command: 'requestWorkflows' });
  </script>
</body>
</html>`;
  }
}

function parseWorkflow(value: unknown): WorkflowConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<WorkflowConfig>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || !Array.isArray(raw.steps)) {
    return undefined;
  }
  return {
    id: raw.id,
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    steps: raw.steps.map(parseStep).filter(Boolean) as WorkflowStep[],
  };
}

function parseStep(value: unknown): WorkflowStep | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<WorkflowStep>;
  if (typeof raw.id !== 'string') {
    return undefined;
  }
  const branches = Array.isArray(raw.branches)
    ? raw.branches
        .filter((branch) =>
          !!branch && typeof branch === 'object' && typeof (branch as { goto?: unknown }).goto === 'string'
        )
        .map((branch) => {
          const legacy = branch as WorkflowBranch & { whenResultContains?: string };
          // Keep a migrated fallback intact across a save: dropping the flag here would silently turn the
          // old unconditional branch into a label nobody can select.
          return { ...migrateWorkflowBranchLabel(legacy), goto: legacy.goto };
        })
    : undefined;
  return {
    id: raw.id,
    from: typeof raw.from === 'string' ? raw.from : '',
    to: typeof raw.to === 'string' ? raw.to : '',
    action: typeof raw.action === 'string' ? raw.action : '',
    condition: typeof raw.condition === 'string' ? raw.condition : undefined,
    autoTransition: raw.autoTransition !== false,
    branches,
  };
}
