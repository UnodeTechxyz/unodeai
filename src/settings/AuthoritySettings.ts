import { parseMediaModel, type MediaModel } from '../models/MediaModelSelection';

/*---------------------------------------------------------------------------------------------
 *  UnodeAi - authority-bearing VS Code settings
 *
 *  Cursor currently treats every opened folder as trusted, so VS Code's restrictedConfigurations
 *  filter is not an authority boundary there. These settings may choose executable code, filesystem
 *  reach, approval posture, or an egress destination. Their effective value therefore comes only
 *  from the user/global layer (then the manifest default), never from repository settings.
 *--------------------------------------------------------------------------------------------*/

export const AUTHORITY_SETTING_KEYS = [
  'autonomy',
  'allowedCommands',
  'commandApproval',
  'allowCrossProviderDispatchWithoutApproval',
  'verifyCommand',
  'concurrencyStrategy',
  'additionalRoots',
  'localReadScope',
  'baseUrl',
  'unodeBaseUrl',
  'pricingSources',
  'modelCatalogUrl',
  'customBaseUrl',
  'defaultProvider',
  'webAccess',
  'claudeCliPath',
  'codexCliPath',
  'marketplace.catalogUrl',
  'marketplace.fetchCatalog',
  'marketplace.skillLibraryUrl',
  'smartMode.enabled',
  'smartMode.defaultTier',
  'smartMode.roleTiers',
  'smartMode.taskTierHints',
  'modelTiers',
  'modelTierParams',
  'modelPrices',
  'priceGroup',
  'priceMultiplier',
  'maxConcurrentAgents',
  'gate.enabled',
  'gate.maxSelfRetries',
  'gate.maxRedelegations',
  'writeApproval',
  'notifications.resultStyle',
  'attentionSound',
  'engine.postWriteDiagnostics',
  'engine.verifyObligation',
  'engine.workspaceContext',
  'worktree.autoMerge',
  'worktree.maxParallel',
  'worktree.verifyBeforeMerge',
  'worktree.verifyTimeoutSeconds',
  // v0.9.108: which connection may generate images (and is billed for it) is the person's choice, never a repository's.
  'imageGenerationConnection',
  'imageGenerationModel',
  'transcriptionDefault',
  // v0.9.110: where reply suggestions are sent, and billed, is the person's own choice; a repository can neither set nor redirect it.
  'replySuggestions.model',
  // v0.9.108: whether Word edits leave tracked changes, and the name they are signed with, are the person's own.
  'office.trackChangesDefault',
  'office.authorName',
  // v0.9.94: a request limit is the person's own. A repository can neither raise nor remove it.
  'requestLimits.providerTurns',
  'requestLimits.tokens',
  // v0.9.89: spend reminders are user-owned. A repository may only propose lower targets for review.
  'spend.targets',
  'spend.referencePriceMode',
] as const;

export type AuthoritySettingKey = typeof AUTHORITY_SETTING_KEYS[number];

const AUTHORITY_SETTINGS = new Set<string>(AUTHORITY_SETTING_KEYS);

export interface InspectedSetting<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

export interface InspectableConfiguration {
  get<T>(key: string, fallback: T): T;
  inspect<T>(key: string): InspectedSetting<T> | undefined;
}

export function isAuthoritySettingKey(key: string): key is AuthoritySettingKey {
  return AUTHORITY_SETTINGS.has(key);
}

/** Resolve an authority-bearing setting without consulting workspace or workspace-folder values. */
export function readUserAuthoritySetting<T>(
  configuration: InspectableConfiguration,
  key: AuthoritySettingKey,
  fallback: T,
): T {
  const inspected = configuration.inspect<T>(key);
  if (inspected?.globalValue !== undefined) return inspected.globalValue;
  if (inspected?.defaultValue !== undefined) return inspected.defaultValue;
  return fallback;
}

/** Normal settings retain normal VS Code precedence; authority settings are user/global only. */
export function readUnodeSetting<T>(configuration: InspectableConfiguration, key: string, fallback: T): T {
  return isAuthoritySettingKey(key)
    ? readUserAuthoritySetting(configuration, key, fallback)
    : configuration.get<T>(key, fallback);
}

/**
 * Source query, not a value comparison: true when the person set this setting in User Settings, even to a value equal
 * to the default. A default-only value is not explicit, and neither is a workspace or workspace-folder value, because
 * those layers never take effect for an authority-bearing setting. Display only; execution reads the live policy.
 */
export function isUserExplicitAuthoritySetting(
  configuration: Pick<InspectableConfiguration, 'inspect'>,
  key: AuthoritySettingKey,
): boolean {
  return configuration.inspect<unknown>(key)?.globalValue !== undefined;
}

/** The image-generation connection chosen in User Settings; empty, blank or absent means None (image generation Off). */
export function readImageGenerationConnection(configuration: InspectableConfiguration): string | undefined {
  const value = readUserAuthoritySetting<unknown>(configuration, 'imageGenerationConnection', '');
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function readImageGenerationModel(configuration: InspectableConfiguration): string | undefined {
  const value = readUserAuthoritySetting<unknown>(configuration, 'imageGenerationModel', 'gpt-image-2.6-flare');
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readTranscriptionDefault(configuration: InspectableConfiguration): MediaModel | undefined {
  return parseMediaModel(readUserAuthoritySetting<unknown>(configuration, 'transcriptionDefault', null));
}

/**
 * v0.9.110: the reply suggestion model chosen in User Settings. Null, absent or any malformed value is None: no
 * suggestion, and nothing is sent. The value names a connection and an exact model, never a URL, key or parameter.
 */
export function readReplySuggestionModel(configuration: InspectableConfiguration): MediaModel | undefined {
  return parseMediaModel(readUserAuthoritySetting<unknown>(configuration, 'replySuggestions.model', null));
}

/** Repository values that are present but deliberately ignored for authority-bearing settings. */
export function ignoredWorkspaceAuthorityKeys(configuration: InspectableConfiguration): AuthoritySettingKey[] {
  return AUTHORITY_SETTING_KEYS.filter((key) => {
    const inspected = configuration.inspect<unknown>(key);
    return inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
  });
}
