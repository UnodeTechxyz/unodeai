/**
 * v0.9.106: the manifest declares its settings in two sections, "UnodeAi" and "UnodeAi › Advanced", so
 * `contributes.configuration` is an array. VS Code also accepts a single object, which is what earlier manifests had.
 * Every reader of the declared keys goes through this function, so neither form loses a key.
 */
export function contributedSettingProperties(contributes: unknown): Record<string, unknown> {
  const configuration = (contributes as { configuration?: unknown } | undefined)?.configuration;
  const sections = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
  const properties: Record<string, unknown> = {};
  for (const section of sections) {
    const declared = (section as { properties?: unknown } | undefined)?.properties;
    if (declared && typeof declared === 'object') Object.assign(properties, declared);
  }
  return properties;
}
