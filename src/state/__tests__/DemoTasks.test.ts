import { describe, expect, it } from 'vitest';
import { DEMO_TASKS } from '../DemoTasks';

describe('DEMO_TASKS', () => {
  it('ships the five onboarding presets', () => {
    expect(DEMO_TASKS).toHaveLength(5);
  });

  it('uses unique stable ids', () => {
    const ids = DEMO_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has complete user-facing content for every task', () => {
    for (const task of DEMO_TASKS) {
      expect(task.title.trim()).not.toBe('');
      expect(task.description.trim()).not.toBe('');
      expect(task.prompt.trim()).not.toBe('');
      expect(task.expectedOutcome.trim()).not.toBe('');
    }
  });
});
