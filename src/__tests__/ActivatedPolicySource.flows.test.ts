import { afterEach, expect, it, vi } from 'vitest';

/** Real activate() and the chat view's agent list; only VS Code and transport are stood in. */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());
vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));
import { agent, installActivatedExtension, repositorySettingLayers } from './support/activatedHarness';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let chatProvider: any;
const narrowed = agent('senior-dev', 'narrowed', 'Narrowed', 'narrowed-model');
narrowed.commandNarrowing = { approvalMode: 'ask', allowedCommands: [] };
narrowed.autonomyMode = 'review';
installActivatedExtension(host, (chat) => { chatProvider = chat.chatProvider; },
  { agents: [agent('senior-dev', 'dev', 'Dev', 'dev-model'), narrowed] });

const unode = () => (host.overrides['vscode.workspace.getConfiguration'] as (section: string) => any)('unode');
/** What the chat view shows for an agent: its effective-policy facts and the lines in its selected Autonomy item. */
function shown(agentId: string) {
  const agents = chatProvider.syncAgents() as Array<{ id: string; effectivePolicy: any; autonomyMenu: any }>;
  const item = agents.find(a => a.id === agentId)!;
  const selected = item.autonomyMenu.items.find((entry: { mode: string }) => entry.mode === item.autonomyMenu.selected);
  return { policy: item.effectivePolicy, text: selected.description as string };
}

afterEach(async () => {
  repositorySettingLayers.workspace.clear(); repositorySettingLayers.workspaceFolder.clear();
  for (const key of ['commandApproval', 'writeApproval', 'webAccess', 'imageGenerationConnection']) await unode().update(key, undefined);
});

it('labels a workspace-only or workspace-folder-only permission value as not the person\'s choice', () => {
  repositorySettingLayers.workspace.set('unode.commandApproval', 'none');
  repositorySettingLayers.workspaceFolder.set('unode.writeApproval', 'ask');
  repositorySettingLayers.workspace.set('unode.webAccess', 'off');
  const { policy, text } = shown('dev');
  expect(policy.runCommands.explicit).toBe(false);
  expect(policy.write.explicit).toBe(false);
  expect(policy.network.explicit).toBe('unknown');
  expect(text).toMatch(/Commands: [^.]*\. Source: [^;]*; choice inherited\/default\./);
  expect(text).toMatch(/Network: [^]*?; choice provenance unknown\. Settings > Team > Permissions > Network access\./);
  expect(text).not.toMatch(/Commands: [^.]*\. Source: [^;]*; choice explicit\./);
});

it('labels a User Settings value as explicit, also when it equals the default', async () => {
  const defaults = { commandApproval: unode().inspect('commandApproval').defaultValue, webAccess: unode().inspect('webAccess').defaultValue };
  expect(defaults).toEqual({ commandApproval: 'all', webAccess: 'allow' });
  await unode().update('commandApproval', 'all');
  await unode().update('webAccess', 'allow');
  const { policy, text } = shown('dev');
  expect(policy.runCommands.explicit).toBe(true);
  expect(policy.network.explicit).toBe(true);
  expect(text).toMatch(/Commands: [^.]*\. Source: [^;]*; choice explicit\./);
  expect(text).toMatch(/Network: [^]*?; choice explicit\. Settings > Team > Permissions > Network access\./);
  // A default-only value is not a choice.
  expect(shown('dev').policy.write.explicit).toBe(false);
});

it('keeps an agent\'s own command narrowing and Autonomy choice as explicit sources', () => {
  repositorySettingLayers.workspace.set('unode.commandApproval', 'all');
  const { policy } = shown('narrowed');
  expect(policy.runCommands.explicit).toBe(true);
  expect(policy.write.explicit).toBe(true);
});

it('shows only a User Settings image connection; empty, absent or repository-only is None', async () => {
  expect(shown('dev').policy.imageConnection.value).toBe('No image connection selected');
  repositorySettingLayers.workspace.set('unode.imageGenerationConnection', 'repo-images');
  repositorySettingLayers.workspaceFolder.set('unode.imageGenerationConnection', 'folder-images');
  expect(shown('dev').policy.imageConnection.value).toBe('No image connection selected');
  await unode().update('imageGenerationConnection', '');
  expect(shown('dev').policy.imageConnection.value).toBe('No image connection selected');
  await unode().update('imageGenerationConnection', 'user-images');
  expect(shown('dev').policy.imageConnection.value).toMatch(/^user-images \/ gpt-image-2\.6-flare: /);
  expect(shown('dev').text).toContain('Image connection: user-images / gpt-image-2.6-flare: ');
});
