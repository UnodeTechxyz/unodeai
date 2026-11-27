import type { CommandApprovalMode } from '../backend/CommandPolicy';
import type { ReviewPolicyMode } from '../policy/TeamPolicy';
import type { LocalApplicationSnapshot } from '../office/LocalApplicationCatalog';

export interface PolicyDisplayFact {
  readonly value: string; readonly source: string; readonly explicit: boolean | 'unknown'; readonly navigation: string;
}
export interface EffectivePolicyView {
  readonly agentId: string;
  readonly connection: PolicyDisplayFact;
  readonly runCommands: PolicyDisplayFact;
  readonly write: PolicyDisplayFact;
  readonly network: PolicyDisplayFact;
  readonly reviewRule: PolicyDisplayFact;
  readonly imageConnection: PolicyDisplayFact;
  readonly rendererAvailability: PolicyDisplayFact;
}
/** Display inputs are observations of existing owners, never a grant, validator, resolver or execution handle. */
export interface EffectivePolicyObservations {
  agentId: string; connection: string;
  hostCommands: CommandApprovalMode; commandExplicit: boolean; commandSource: string;
  hostWrite: 'off' | 'ask' | 'automatic'; writeExplicit: boolean; writeSource: string;
  nativeExecution?: string;
  taskScoped?: boolean;
  network: string; networkExplicit: boolean | 'unknown';
  reviewMode: ReviewPolicyMode; reviewExplicit: boolean;
  imageConnection?: { id: string; supported: boolean; modelId?: string; selection?: 'inherit' | 'specific' };
  imageOff?: boolean;
  rendererSnapshot?: LocalApplicationSnapshot;
}
const COMMAND: Record<CommandApprovalMode, string> = { none: 'Off', ask: 'Ask each', allowlist: 'Allowlist', all: 'Automatic' };
/** Re-derived for display/request only. Its readonly strings are intentionally unusable as execution authority. */
export function effectivePolicyView(input: EffectivePolicyObservations): EffectivePolicyView {
  const fact = (value: string, source: string, explicit: boolean | 'unknown', navigation: string): PolicyDisplayFact => Object.freeze({ value, source, explicit, navigation });
  const native = input.nativeExecution ? `; native Codex: ${input.nativeExecution}` : '';
  const snapshot = input.rendererSnapshot;
  const applications = snapshot?.applications.filter(app => app.candidate_operations.length > 0 && app.id !== 'windows-pdf');
  return Object.freeze({ agentId: input.agentId,
    connection: fact(input.connection, 'Saved agent connection; inherited-choice provenance not retained', 'unknown', 'Agent Builder'),
    runCommands: fact(`Host tools: ${input.taskScoped && input.hostCommands !== 'none' ? 'Task-scoped; configured ceiling ' : ''}${COMMAND[input.hostCommands]}${native}`, input.commandSource, input.commandExplicit, 'Settings > Team > Permissions > Commands'),
    write: fact(`Host tools: ${input.taskScoped && input.hostWrite !== 'off' ? 'Task-scoped; configured ceiling ' : ''}${input.hostWrite === 'off' ? 'Off' : input.hostWrite === 'ask' ? 'Ask before write' : 'Automatic'}${native}`, input.writeSource, input.writeExplicit, 'Settings > Team > Permissions > File writes'),
    network: fact(input.network, 'Existing web/model/native network choices', input.networkExplicit, 'Settings > Team > Permissions > Network access'),
    reviewRule: fact(input.reviewMode, 'Team Rules', input.reviewExplicit, 'Team Rules'),
    imageConnection: fact(input.imageOff ? 'Off for this member'
      : input.imageConnection ? `${input.imageConnection.id}${input.imageConnection.modelId ? ' / ' + input.imageConnection.modelId : ''}: ${input.imageConnection.supported ? 'supported image adapter' : 'image adapter unavailable'}`
        : 'No image connection selected',
      input.imageOff || input.imageConnection?.selection === 'specific' ? 'Agent Builder media model choice'
        : input.imageConnection?.selection === 'inherit' ? 'Inherited from Settings > Providers > Media defaults' : 'Providers image connection choice',
      input.imageOff || (input.imageConnection ? input.imageConnection.selection !== 'inherit' : false), 'Agent Builder > Media models'),
    rendererAvailability: fact(snapshot ? `${applications?.filter(app => app.installed).map(app => app.name).join(', ') || 'No renderer detected'}; snapshot ${snapshot.detected_at}; operation qualification not run` : 'Application detection not yet run',
      'Read-only local application snapshot; availability is not permission', false, 'Settings > More > Documents & images'),
  });
}
export function effectivePolicyLines(view: EffectivePolicyView): string[] {
  return ([['Connection', view.connection], ['Commands', view.runCommands], ['File writes', view.write], ['Network', view.network],
    ['Review rule', view.reviewRule], ['Image connection', view.imageConnection], ['Renderer availability', view.rendererAvailability]] as const)
    .map(([label, fact]) => `${label}: ${fact.value}. Source: ${fact.source}; choice ${fact.explicit === 'unknown' ? 'provenance unknown' : fact.explicit ? 'explicit' : 'inherited/default'}. ${fact.navigation}.`);
}
