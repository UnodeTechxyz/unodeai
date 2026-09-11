import { v4 as createRunId } from 'uuid';
import { MessageBus } from '../bus/MessageBus';
import { SessionManager } from '../session/SessionManager';
import {
  Message,
  MessagePayload,
  WorkflowConfig,
  WorkflowInstance,
  WorkflowStep,
} from '../types';
import { TierController } from './TierController';
import { WorkflowGate, decideGate, migrateWorkflowBranchLabel, resolveBranch } from './GatedWorkflow';
import { validateWorkflowGotos } from './workflowSerialize';

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  builtin?: boolean;
  gates?: WorkflowGate[];
}

export interface WorkflowAuthoringStore {
  loadTeamConfig(): Promise<{ workflows: WorkflowConfig[] } | undefined>;
  saveCustomWorkflows(workflows: WorkflowConfig[]): Promise<void>;
}

export interface GateDeps {
  tierController?: TierController;
  runChecks?: () => Promise<{ ok: boolean; output?: string; blocked?: boolean }>;
}

type StopListening = () => void;

const transitionBudget = 100;

const standardWorkflows: readonly WorkflowTemplate[] = [
  {
    id: 'code-review',
    name: 'Code Review Pipeline',
    description: 'Senior dev writes code → Tester runs tests → Security audits',
    steps: [
      workflowStep('step1', 'architect', 'senior-dev', 'Implement the requested change with tests'),
      workflowStep('step2', 'senior-dev', 'tester', 'Run and extend the test suite for the change'),
      workflowStep('step3', 'tester', 'security', 'Security-audit the change'),
    ],
  },
  {
    id: 'feature-implement',
    name: 'Feature Implementation',
    description: 'Architect designs → Senior dev implements → QA validates',
    steps: [
      workflowStep('step1', 'pm', 'architect', 'Produce a design spec for the feature'),
      workflowStep('step2', 'architect', 'senior-dev', 'Implement the design spec'),
      workflowStep('step3', 'senior-dev', 'tester', 'Validate the implementation'),
    ],
  },
  {
    id: 'bug-fix',
    name: 'Bug Fix Pipeline',
    description: 'Tester reproduces → Senior dev fixes → Tester verifies',
    steps: [
      workflowStep('step1', 'pm', 'senior-dev', 'Diagnose and fix the reported bug'),
      workflowStep('step2', 'senior-dev', 'tester', 'Verify the fix and guard it with a regression test'),
    ],
  },
  {
    id: 'docs-generate',
    name: 'Documentation Generation',
    description: 'Senior dev explains code → Tech writer documents',
    steps: [workflowStep('step1', 'senior-dev', 'tech-writer', 'Document the code/system for developers')],
  },
  {
    id: 'feature-gated',
    name: 'Feature (Gated, cost-optimized)',
    description: 'Architect designs → Dev implements → run_checks gate → QA validates',
    steps: [
      workflowStep('design', 'pm', 'architect', 'Design the feature + public contracts'),
      workflowStep('code', 'architect', 'senior-dev', 'Implement to the contracts with tests'),
      workflowStep('qa', 'senior-dev', 'tester', 'Validate the implementation'),
    ],
    gates: [{
      after: 'code',
      objective: true,
      onPass: { 'senior-dev': 'economy' },
      onFail: { setTier: { 'senior-dev': 'premium' }, maxRetries: 2, onExhaust: 'human' },
    }],
  },
];

/**
 * Workflows are persisted as data.  This class only owns ephemeral message subscriptions and the
 * state transitions that turn one completed assignment into the next dispatch.
 */
export class WorkflowEngine {
  private readonly runs = new Map<string, WorkflowInstance>();
  private readonly listeners = new Map<string, StopListening>();
  private readonly gatesByRun = new Map<string, WorkflowGate[]>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly messageBus: MessageBus,
    private readonly changed: () => void = () => {},
    private readonly gateDeps: GateDeps = {},
    private readonly authoringStore?: WorkflowAuthoringStore,
  ) {}

  getWorkflowTemplates(): WorkflowTemplate[] {
    return standardWorkflows.map((template) => copyTemplate(template, true));
  }

  async listWorkflows(): Promise<WorkflowTemplate[]> {
    const saved = (await this.authoringStore?.loadTeamConfig())?.workflows ?? [];
    return [...this.getWorkflowTemplates(), ...saved.map(templateFromConfig)];
  }

  async saveWorkflow(raw: WorkflowConfig): Promise<{ ok: true } | { ok: false; error: string }> {
    const workflow = prepareWorkflow(raw);
    const error = this.customWorkflowError(workflow);
    if (error) {
      return { ok: false, error };
    }
    if (!this.authoringStore) {
      return { ok: false, error: 'Workflow persistence is not available.' };
    }

    const saved = (await this.authoringStore.loadTeamConfig())?.workflows ?? [];
    await this.authoringStore.saveCustomWorkflows([
      ...saved.filter((candidate) => candidate.id !== workflow.id),
      workflow,
    ]);
    return { ok: true };
  }

  async deleteWorkflow(id: string): Promise<void> {
    if (!this.authoringStore || isStandardWorkflow(id)) {
      return;
    }
    const saved = (await this.authoringStore.loadTeamConfig())?.workflows ?? [];
    await this.authoringStore.saveCustomWorkflows(saved.filter((workflow) => workflow.id !== id));
  }

  getActiveWorkflows(): WorkflowInstance[] {
    return [...this.runs.values()];
  }

  getWorkflow(workflowId: string): WorkflowInstance | undefined {
    return this.runs.get(workflowId);
  }

  async run(templateOrId: string | WorkflowTemplate, seedContext: Record<string, unknown> = {}): Promise<WorkflowInstance> {
    const template = this.resolveTemplate(templateOrId);
    if (!template) {
      throw new Error('Workflow template \'' + String(templateOrId) + '\' not found');
    }

    this.ensureRecipients(template.steps);
    const instance = this.begin(template, seedContext);
    this.runs.set(instance.id, instance);
    this.installGates(instance, template.gates);
    this.subscribe(instance.id);
    this.changed();
    this.dispatchCurrent(instance);
    return instance;
  }

  restore(instances: WorkflowInstance[]): void {
    for (const instance of instances) {
      if (!this.isRestorable(instance)) {
        continue;
      }
      this.runs.set(instance.id, instance);
      this.installGates(instance, persistedGates(instance));
      this.subscribe(instance.id);
      this.dispatchCurrent(instance);
    }
    this.changed();
  }

  exportState(): WorkflowInstance[] {
    return this.getActiveWorkflows().filter((instance) => instance.status === 'running');
  }

  cancel(workflowId: string): void {
    const instance = this.runs.get(workflowId);
    if (!instance || instance.status !== 'running') {
      return;
    }
    this.finish(instance, 'cancelled');
    this.changed();
  }

  private resolveTemplate(value: string | WorkflowTemplate): WorkflowTemplate | undefined {
    if (typeof value !== 'string') {
      return copyTemplate(value, value.builtin === true);
    }
    const found = standardWorkflows.find((template) => template.id === value);
    return found ? copyTemplate(found, true) : undefined;
  }

  private customWorkflowError(workflow: WorkflowConfig): string | undefined {
    if (!workflow.id) {
      return 'Workflow id is required.';
    }
    if (!workflow.name) {
      return 'Workflow name is required.';
    }
    if (isStandardWorkflow(workflow.id)) {
      return 'Workflow "' + workflow.id + '" is built-in and cannot be overwritten.';
    }
    return validateWorkflowGotos(workflow) ?? undefined;
  }

  private ensureRecipients(steps: WorkflowStep[]): void {
    const missing = new Set<string>();
    for (const current of steps) {
      if (!this.sessionManager.resolveByRoleOrId(current.to)) {
        missing.add(current.to);
      }
    }
    if (missing.size > 0) {
      throw new Error('Workflow needs agents for: ' + [...missing].join(', ') + '. Add them to your team first.');
    }
  }

  private begin(template: WorkflowTemplate, context: Record<string, unknown>): WorkflowInstance {
    const config: WorkflowConfig = {
      id: template.id,
      name: template.name,
      description: template.description,
      steps: template.steps.map(copyStep),
    };
    return {
      id: createRunId(),
      config,
      status: 'running',
      currentStep: config.steps[0]?.id,
      startedAt: new Date().toISOString(),
      context: { ...context },
    };
  }

  private isRestorable(instance: WorkflowInstance): boolean {
    if (instance.status !== 'running' || this.runs.has(instance.id)) {
      return false;
    }
    const current = this.currentStep(instance);
    return !!current && !!this.sessionManager.resolveByRoleOrId(current.to);
  }

  private subscribe(runId: string): void {
    const complete = this.messageBus.onType('task.complete', (message) => this.accept(runId, message, false));
    const partial = this.messageBus.onType('task.partial', (message) => this.acceptPartial(runId, message));
    const error = this.messageBus.onType('system.error', (message) => this.accept(runId, message, true));
    this.listeners.set(runId, () => {
      complete();
      partial();
      error();
    });
  }

  private acceptPartial(runId: string, message: Message<'task.partial'>): void {
    if (message.correlationId !== runId) {
      return;
    }
    const instance = this.runs.get(runId);
    if (!instance || instance.status !== 'running') {
      return;
    }
    this.retainOutput(instance, message.payload);
    const step = instance.currentStep ?? 'unknown';
    instance.context = {
      ...instance.context,
      [`${step}_unfinishedActivity`]: message.payload.metadata.unfinishedActivity.slice(0, 1_000),
    };
    instance.status = 'paused';
    instance.completedAt = message.timestamp;
    this.detach(instance.id);
    this.changed();
  }

  private accept(runId: string, message: Message, failed: boolean): void {
    if (message.correlationId !== runId) {
      return;
    }
    const instance = this.runs.get(runId);
    if (!instance || instance.status !== 'running') {
      return;
    }
    if (failed) {
      this.finish(instance, 'failed');
      this.changed();
      return;
    }

    this.retainOutput(instance, message.payload);
    this.advance(instance, message);
  }

  private retainOutput(instance: WorkflowInstance, payload: MessagePayload): void {
    const completed = instance.currentStep ?? 'unknown';
    instance.context = {
      ...instance.context,
      [completed + '_output']: payload.instruction ?? '',
    };
  }

  private advance(instance: WorkflowInstance, message: Message): void {
    const steps = instance.config.steps;
    const completedIndex = steps.findIndex((candidate) => candidate.id === instance.currentStep);
    const completed = completedIndex >= 0 ? steps[completedIndex] : undefined;
    const following = completedIndex >= 0 ? steps[completedIndex + 1] : undefined;
    const gate = completed
      ? this.gatesByRun.get(instance.id)?.find((candidate) => candidate.after === completed.id)
      : undefined;

    if (gate && completed) {
      void this.evaluateGate(instance, gate, completed, following);
      return;
    }

    const targetId = branchDestination(completed?.branches, selectedBranch(message));
    if (targetId) {
      this.takeBranch(instance, targetId);
    } else {
      this.moveForward(instance, following);
    }
    this.changed();
  }

  private takeBranch(instance: WorkflowInstance, targetId: string): void {
    const target = instance.config.steps.find((candidate) => candidate.id === targetId);
    if (!target || !this.recordTransition(instance)) {
      this.finish(instance, 'failed');
      return;
    }
    this.dispatch(instance, target);
  }

  private moveForward(instance: WorkflowInstance, following: WorkflowStep | undefined): void {
    if (!following) {
      this.finish(instance, 'completed');
    } else if (following.autoTransition) {
      this.dispatch(instance, following);
    }
  }

  private dispatchCurrent(instance: WorkflowInstance): void {
    const current = this.currentStep(instance);
    if (!current) {
      this.finish(instance, 'completed');
      this.changed();
      return;
    }
    this.dispatch(instance, current);
  }

  private dispatch(instance: WorkflowInstance, current: WorkflowStep): void {
    const recipient = this.sessionManager.resolveByRoleOrId(current.to);
    if (!recipient) {
      this.finish(instance, 'failed');
      this.changed();
      return;
    }

    instance.currentStep = current.id;
    const sender = this.sessionManager.resolveByRoleOrId(current.from)?.id ?? 'workflow';
    const payload: MessagePayload = {
      instruction: current.action,
      workflowBranchLabels: offeredBranchLabels(current.branches),
      context: instance.context,
      metadata: { workflowId: instance.id, step: current.id },
    };
    this.messageBus.send(sender, recipient.id, 'task.assign', payload, 'high', instance.id);
  }

  private async evaluateGate(
    instance: WorkflowInstance,
    gate: WorkflowGate,
    completed: WorkflowStep,
    following: WorkflowStep | undefined,
  ): Promise<void> {
    const result = await this.runGateCheck(gate);
    if (instance.status !== 'running') {
      return;
    }
    if (result.blocked) {
      instance.status = 'paused';
      instance.completedAt = new Date().toISOString();
      instance.context.__blockedReason =
        'run_checks could not run: command execution is disabled. Set unode.commandApproval to "allowlist" and configure unode.verifyCommand to enable the gate.';
      this.detach(instance.id);
      this.changed();
      return;
    }

    const decision = decideGate(gate, result.ok, this.incrementAttempt(instance, gate.after));
    if (decision.applyTiers) {
      this.gateDeps.tierController?.applyTiers(decision.applyTiers);
    }

    if (decision.proceed) {
      this.moveForward(instance, following);
    } else if (decision.retry) {
      this.dispatch(instance, decision.route ? { ...completed, to: decision.route } : completed);
    } else {
      this.finish(instance, decision.escalate === 'human' ? 'paused' : 'failed');
    }
    this.changed();
  }

  private async runGateCheck(gate: WorkflowGate): Promise<{ ok: boolean; blocked: boolean }> {
    if (!gate.objective || !this.gateDeps.runChecks) {
      return { ok: true, blocked: false };
    }
    try {
      const result = await this.gateDeps.runChecks();
      return { ok: result.ok, blocked: result.blocked === true };
    } catch {
      return { ok: false, blocked: false };
    }
  }

  private incrementAttempt(instance: WorkflowInstance, gateId: string): number {
    const history = (instance.context.__attempts as Record<string, number> | undefined) ?? {};
    const attempt = (history[gateId] ?? 0) + 1;
    instance.context.__attempts = { ...history, [gateId]: attempt };
    return attempt;
  }

  private recordTransition(instance: WorkflowInstance): boolean {
    const count = ((instance.context.__transitions as number | undefined) ?? 0) + 1;
    instance.context.__transitions = count;
    return count <= transitionBudget;
  }

  private currentStep(instance: WorkflowInstance): WorkflowStep | undefined {
    return instance.config.steps.find((candidate) => candidate.id === instance.currentStep);
  }

  private installGates(instance: WorkflowInstance, gates: WorkflowGate[] | undefined): void {
    if (!gates?.length) {
      return;
    }
    const copied = gates.map(copyGate);
    this.gatesByRun.set(instance.id, copied);
    instance.context.__gates = copied;
  }

  private finish(instance: WorkflowInstance, status: WorkflowInstance['status']): void {
    instance.status = status;
    instance.completedAt = new Date().toISOString();
    this.detach(instance.id);
  }

  private detach(runId: string): void {
    this.listeners.get(runId)?.();
    this.listeners.delete(runId);
    this.gatesByRun.delete(runId);
  }
}

function workflowStep(id: string, from: string, to: string, action: string): WorkflowStep {
  return { id, from, to, action, autoTransition: true };
}

function isStandardWorkflow(id: string): boolean {
  return standardWorkflows.some((template) => template.id === id);
}

function copyTemplate(template: WorkflowTemplate, builtin: boolean): WorkflowTemplate {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    steps: template.steps.map(copyStep),
    ...(template.gates ? { gates: template.gates.map(copyGate) } : {}),
    builtin,
  };
}

function templateFromConfig(workflow: WorkflowConfig): WorkflowTemplate {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? '',
    steps: workflow.steps.map(copyStep),
    builtin: false,
  };
}

function copyStep(current: WorkflowStep): WorkflowStep {
  return {
    ...current,
    ...(current.branches ? { branches: current.branches.map((branch) => ({ ...branch })) } : {}),
  };
}

function copyGate(gate: WorkflowGate): WorkflowGate {
  return {
    ...gate,
    ...(gate.onPass ? { onPass: { ...gate.onPass } } : {}),
    ...(gate.onFail ? {
      onFail: {
        ...gate.onFail,
        ...(gate.onFail.setTier ? { setTier: { ...gate.onFail.setTier } } : {}),
      },
    } : {}),
  };
}

function prepareWorkflow(workflow: WorkflowConfig): WorkflowConfig {
  return {
    ...workflow,
    id: String(workflow.id ?? '').trim(),
    name: String(workflow.name ?? '').trim(),
    steps: Array.isArray(workflow.steps) ? workflow.steps.map(normalizeStep) : [],
  };
}

function normalizeStep(current: WorkflowStep): WorkflowStep {
  return {
    ...current,
    id: String(current.id ?? '').trim(),
    from: String(current.from ?? '').trim(),
    to: String(current.to ?? '').trim(),
    action: String(current.action ?? ''),
    autoTransition: current.autoTransition !== false,
    ...(current.branches ? {
      branches: current.branches.map((branch) => ({
        ...migrateWorkflowBranchLabel(branch as import('../types').WorkflowBranch & { whenResultContains?: unknown }),
        goto: String(branch.goto ?? '').trim(),
      })),
    } : {}),
  };
}

function normalizedBranches(
  branches: import('../types').WorkflowBranch[] | undefined,
): import('../types').WorkflowBranch[] | undefined {
  return branches?.map((branch) => ({
    ...migrateWorkflowBranchLabel(branch as import('../types').WorkflowBranch & { whenResultContains?: unknown }),
    goto: branch.goto,
  }));
}

function offeredBranchLabels(branches: import('../types').WorkflowBranch[] | undefined): string[] | undefined {
  const labels = (normalizedBranches(branches) ?? [])
    .filter((branch) => !branch.fallback)
    .map((branch) => branch.label);
  return labels.length ? labels : undefined;
}

function branchDestination(
  branches: import('../types').WorkflowBranch[] | undefined,
  label: string | undefined,
): string | undefined {
  return resolveBranch(normalizedBranches(branches), label);
}

function selectedBranch(message: Message): string | undefined {
  const value = message.payload.metadata?.workflowBranchLabel;
  return typeof value === 'string' ? value : undefined;
}

function persistedGates(instance: WorkflowInstance): WorkflowGate[] | undefined {
  const gates = instance.context.__gates;
  return Array.isArray(gates) ? gates as WorkflowGate[] : undefined;
}
