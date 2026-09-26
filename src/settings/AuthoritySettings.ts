/*---------------------------------------------------------------------------------------------
 *  UnodeAi - authority-bearing VS Code settings
 *
 *  Cursor currently treats every opened folder as trusted, so VS Code's restrictedConfigurations
 *  filter is not an authority boundary there. These settings may choose executable code, filesystem
 *  reach, approval posture, or an egress destination. Their effective value therefore comes only
 *  from the user/global layer (then the manifest default), never from repository settings.
 *--------------------------------------------------------------------------------------------*/

export const AUTHORITY_SETTING_KEYS = [
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
  'engine.postWriteDiagnostics',
  'engine.verifyObligation',
  'engine.workspaceContext',
  'worktree.autoMerge',
  'worktree.maxParallel',
  'worktree.verifyBeforeMerge',
  'worktree.verifyTimeoutSeconds',
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

/** Repository values that are present but deliberately ignored for authority-bearing settings. */
export function ignoredWorkspaceAuthorityKeys(configuration: InspectableConfiguration): AuthoritySettingKey[] {
  return AUTHORITY_SETTING_KEYS.filter((key) => {
    const inspected = configuration.inspect<unknown>(key);
    return inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
  });
}
