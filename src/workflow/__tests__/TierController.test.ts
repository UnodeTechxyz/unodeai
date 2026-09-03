import { describe, it, expect } from 'vitest';
import { TierController, TierTarget } from '../TierController';

function setup(agents: TierTarget[]) {
  const models = new Map(agents.map((a) => [a.id, 'initial']));
  const ctrl = new TierController({
    listAgents: () => agents,
    setModel: (id, m) => {
      if (models.get(id) === m) { return false; }
      models.set(id, m);
      return true;
    },
  });
  return { ctrl, models };
}

describe('TierController (P2 cost-arbitrage hot-swap)', () => {
  it('switches a role to a tier model using the agent provider', () => {
    const { ctrl, models } = setup([
      { id: 'dev1', role: 'senior-dev', providerId: 'roam' },
      { id: 'pm1', role: 'pm', providerId: 'roam' },
    ]);
    const changes = ctrl.applyTiers({ 'senior-dev': 'premium' });
    expect(changes).toEqual([{ agentId: 'dev1', role: 'senior-dev', tier: 'premium', model: 'claude-opus-5' }]);
    expect(models.get('dev1')).toBe('claude-opus-5');
    expect(models.get('pm1')).toBe('initial'); // untouched
  });

  it('resolves per-provider tier models (openai vs roam)', () => {
    const { ctrl } = setup([
      { id: 'a', role: 'tester', providerId: 'openai' },
      { id: 'b', role: 'tester', providerId: 'roam' },
    ]);
    const changes = ctrl.applyTiers({ tester: 'economy' });
    const byId = Object.fromEntries(changes.map((c) => [c.agentId, c.model]));
    expect(byId).toEqual({ a: 'gpt-5.6-luna', b: 'deepseek-v4-flash' });
  });

  it('matches by exact id as well as role', () => {
    const { ctrl, models } = setup([{ id: 'dev1', role: 'senior-dev', providerId: 'roam' }]);
    ctrl.applyTiers({ dev1: 'economy' });
    expect(models.get('dev1')).toBe('deepseek-v4-flash');
  });

  it('falls back to the roam tier model for an unknown provider', () => {
    const { ctrl } = setup([{ id: 'x', role: 'dev', providerId: 'mystery' }]);
    expect(ctrl.modelFor('standard', 'mystery')).toBe('deepseek-v4-pro');
  });

  it('reports no change when the model is already at that tier', () => {
    const agents: TierTarget[] = [{ id: 'a', role: 'tester', providerId: 'roam' }];
    const models = new Map([['a', 'deepseek-v4-flash']]);
    const ctrl = new TierController({
      listAgents: () => agents,
      setModel: (id, m) => { if (models.get(id) === m) { return false; } models.set(id, m); return true; },
    });
    expect(ctrl.applyTiers({ tester: 'economy' })).toEqual([]);
  });
});
