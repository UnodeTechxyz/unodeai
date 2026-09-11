import { describe, expect, it } from 'vitest';
import {
  normalizeWebAccessPolicy,
  resolveWebAccessPolicy,
  SessionWebAccessApprover,
} from '../WebAccessPolicy';

describe('route-neutral public-web policy', () => {
  it.each([
    ['ask', 'ask'],
    ['allow', 'allow'],
    ['off', 'off'],
    ['invalid', 'ask'],
    [undefined, 'ask'],
  ])('normalizes %j to %s', (input, expected) => {
    expect(normalizeWebAccessPolicy(input)).toBe(expected);
  });

  it('uses the same capability-first decision table for both routes', () => {
    for (const policy of ['ask', 'allow', 'off'] as const) {
      expect(resolveWebAccessPolicy(policy, false)).toMatchObject({ allow: false, reason: expect.stringMatching(/read capability/) });
    }
    expect(resolveWebAccessPolicy('allow', true)).toEqual({ allow: true });
    expect(resolveWebAccessPolicy('off', true)).toMatchObject({ allow: false, reason: expect.stringMatching(/turned off/) });
    expect(resolveWebAccessPolicy('ask', true)).toBeUndefined();
  });

  it('shares one explicit session allow across concurrent crew requests without persisting it', async () => {
    let prompts = 0;
    let release: ((value: { allow: boolean; remember: boolean }) => void) | undefined;
    const approver = new SessionWebAccessApprover(async () => {
      prompts++;
      return await new Promise((resolve) => { release = resolve; });
    });
    const first = approver.requestApproval({ agentName: 'Researcher', toolName: 'WebSearch' });
    const second = approver.requestApproval({ agentName: 'Developer', toolName: 'fetch_url', url: 'https://example.test' });
    expect(prompts).toBe(1);
    release!({ allow: true, remember: true });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { allow: true, remember: true },
      { allow: true, remember: true },
    ]);
    await expect(approver.requestApproval({ agentName: 'Later teammate', toolName: 'WebFetch' }))
      .resolves.toEqual({ allow: true, remember: true });
    expect(prompts).toBe(1);
  });
});
