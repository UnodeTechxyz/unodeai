import { describe, expect, it } from 'vitest';
import { parseWorkflowSteps, serializeWorkflowSteps, validateWorkflowGotos } from '../workflowSerialize';
import { WorkflowConfig } from '../../types';

const workflow: WorkflowConfig = {
  id: 'custom',
  name: 'Custom',
  steps: [
    { id: 'code', from: 'pm', to: 'senior-dev', action: 'Code', autoTransition: true },
    {
      id: 'review',
      from: 'senior-dev',
      to: 'reviewer',
      action: 'Review',
      autoTransition: true,
      branches: [{ label: 'fail', goto: 'code' }, { label: 'pass', goto: 'done' }],
    },
    { id: 'done', from: 'reviewer', to: 'tester', action: 'Done', autoTransition: true },
  ],
};

describe('workflowSerialize', () => {
  it('round-trips workflow steps without sharing branch objects', () => {
    const rows = parseWorkflowSteps(workflow.steps);
    const serialized = serializeWorkflowSteps(rows);

    expect(serialized).toEqual(workflow.steps);
    rows[1].branches![0].goto = 'done';
    expect(workflow.steps[1].branches![0].goto).toBe('code');
  });

  it('reports invalid branch goto targets', () => {
    expect(validateWorkflowGotos({
      ...workflow,
      steps: [
        { id: 'a', from: 'pm', to: 'dev', action: 'A', autoTransition: true, branches: [{ label: 'missing', goto: 'missing' }] },
      ],
    })).toContain('unknown step "missing"');
  });

  it('accepts valid labelled loop branches', () => {
    expect(validateWorkflowGotos(workflow)).toBeNull();
  });
});
