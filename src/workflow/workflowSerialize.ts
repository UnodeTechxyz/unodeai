import { WorkflowConfig, WorkflowStep } from '../types';

export type WorkflowStepRow = WorkflowStep;

export function parseWorkflowSteps(steps: WorkflowStep[]): WorkflowStepRow[] {
  return steps.map(cloneStep);
}

export function serializeWorkflowSteps(rows: WorkflowStepRow[]): WorkflowStep[] {
  return rows.map(cloneStep);
}

export function validateWorkflowGotos(workflow: WorkflowConfig): string | null {
  const stepIds = new Set(workflow.steps.map((step) => step.id).filter(Boolean));
  for (const step of workflow.steps) {
    if (!step.id) {
      return 'Every workflow step needs an id.';
    }
    if (!step.from || !step.to) {
      return `Step "${step.id}" needs both a from and to agent.`;
    }
    for (const branch of step.branches ?? []) {
      if (!branch.goto || !stepIds.has(branch.goto)) {
        return `Branch on step "${step.id}" points to unknown step "${branch.goto || '(empty)'}".`;
      }
    }
  }
  return null;
}

function cloneStep(step: WorkflowStep): WorkflowStep {
  return {
    ...step,
    branches: step.branches?.map((branch) => ({ ...branch })),
  };
}
