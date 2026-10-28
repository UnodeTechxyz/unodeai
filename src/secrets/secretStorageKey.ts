/** Private namespace for all SecretStorage values owned by this extension. */
export const SECRET_STORAGE_PREFIX = 'roam.secret.';

export function secretStorageKey(secretName: string): string {
  return SECRET_STORAGE_PREFIX + secretName;
}
