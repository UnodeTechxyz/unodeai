import { effectivePolicyView, type EffectivePolicyObservations } from '../EffectivePolicyView';
export const policyObservations = (changes: Partial<EffectivePolicyObservations> = {}): EffectivePolicyObservations => ({
  agentId: 'dev', connection: 'Chosen connection / model', hostCommands: 'none', commandExplicit: true,
  commandSource: 'Live command policy', hostWrite: 'ask', writeExplicit: true, writeSource: 'Live write policy',
  network: 'Host web choice Off; existing model consent retained', networkExplicit: true,
  reviewMode: 'strict-different-reported-model', reviewExplicit: true, ...changes,
});
export const policyFixture = (changes: Partial<EffectivePolicyObservations> = {}) => effectivePolicyView(policyObservations(changes));
