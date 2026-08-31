import type { SecretRef, SecretStore } from './secret-store.js';

/**
 * Environment-backed {@link SecretStore} (SEC-001).
 *
 * Local/test default. Reads raw secret values from `process.env`. Production
 * substitutes a real secret backend (vault / SSM / etc.) without changing
 * domain code — both satisfy {@link SecretStore}.
 *
 * Raw values are returned ONLY via {@link EnvSecretStore.getSecret}; they are
 * never persisted into domain records by this module.
 */
export class EnvSecretStore implements SecretStore {
  getSecret(ref: SecretRef): Promise<string | null> {
    const value = process.env[ref.key];
    if (value === undefined || value === '') return Promise.resolve(null);
    return Promise.resolve(value);
  }

  ref(key: string): SecretRef {
    return { key };
  }

  /**
   * WORK-074: runtime secret writes for dynamically issued credentials. The
   * env store writes into `process.env` of the running process (local dev /
   * tests). Production substitutes a real secret backend without changing
   * domain code.
   */
  putSecret(ref: SecretRef, value: string): Promise<void> {
    process.env[ref.key] = value;
    return Promise.resolve();
  }
}
