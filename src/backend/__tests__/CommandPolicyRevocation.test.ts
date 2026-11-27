import { expect, it } from 'vitest';
import { CommandPolicy } from '../CommandPolicy';
import { AgentCommandPolicy } from '../AgentCommandPolicy';

it('turning Commands Off retires older uses across reenable without retiring them for new project grants', () => {
  const policy = new CommandPolicy('all');
  const agent = new AgentCommandPolicy(policy, undefined, 'Developer');
  const revision = agent.revocationRevision;
  policy.reload('none', []);
  policy.reload('all', []);
  expect(agent.revocationRevision).toBeGreaterThan(revision);
  const enabled = agent.revocationRevision;
  policy.reload('ask', { configured: [], project: [{ grammar: 'cmd', template: 'npm test' }] });
  expect(agent.revocationRevision).toBe(enabled);
  policy.reload('none', []);
  const off = agent.revocationRevision;
  policy.reload('none', []);
  expect(agent.revocationRevision).toBe(off);
});
