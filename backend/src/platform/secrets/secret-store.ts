/**
 * Secret-management abstraction (SEC-001).
 *
 * Provider credentials and sensitive tokens must NOT be stored as ordinary
 * application data (architecture §33). Application code accesses secrets
 * through this abstraction; provider-specific storage stays behind it.
 *
 * Invariants enforced by the abstraction + static checks (SEC-AC-01/02):
 * - Raw secret values are returned ONLY via {@link SecretStore.getSecret} to
 *   authorized infrastructure code. They must never be persisted into domain
 *   records, written to logs, or emitted in audit events.
 * - Ordinary domain persistence cannot be used as the secret store: the
 *   `SecretRef` type is the only shape domain code is allowed to hold; it
 *   carries an opaque `key`, never the value.
 * - Concrete implementations (EnvSecretStore, future cloud adapters) live
 *   under `platform/secrets/` and are forbidden imports for domain modules
 *   (enforced by tests/architecture/static-architecture.test.ts).
 */

/**
 * Opaque reference to a stored secret. Domain records may persist this
 * reference (e.g. an env var name or a key id); they MUST NOT hold the
 * resolved secret value. Resolving a `SecretRef` to a value requires calling
 * {@link SecretStore.getSecret} — a capability only authorized infrastructure
 * code invokes.
 */
export interface SecretRef {
  /** Opaque key identifying the secret in the backing store (e.g. env var name). */
  readonly key: string;
}

/**
 * Provider-independent secret store. The only sanctioned way to retrieve raw
 * secret values.
 *
 * Production uses an adapter backed by the configured secret backend (vault,
 * SSM, etc. — added by a later work item when a provider is selected). Local
 * dev/tests use {@link EnvSecretStore} which reads from `process.env`.
 */
export interface SecretStore {
  /**
   * Resolve a {@link SecretRef} to its raw value. Returns `null` when the
   * referenced secret does not exist.
   *
   * Callers MUST treat the returned value as sensitive: never persist it,
   * never log it, never include it in audit records.
   */
  getSecret(ref: SecretRef): Promise<string | null>;

  /**
   * Build a {@link SecretRef} for a known key. Domain code uses this to
   * persist a *reference* (not the value) to a secret it will later need.
   */
  ref(key: string): SecretRef;

  /**
   * WORK-074: persist a raw secret value under `ref.key`. OPTIONAL capability:
   * only stores that support runtime writes implement it (the env-backed dev
   * store does; a vault-backed store may not). Used by /auth's machine
   * identity runtime so a dynamically issued API key's raw value is retrievable
   * through the SAME SecretStore boundary it is verified through (SEC-AC-01) —
   * the value itself still never enters domain records (SEC-AC-02).
   */
  putSecret?(ref: SecretRef, value: string): Promise<void>;
}
