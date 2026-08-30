/**
 * WORK-064 Task 4 — TestIdentity binding: an ADAPTER over the EXISTING
 * identity authority, never a second identity authority
 * (spec/work-orders/WORK-064.md invariants 3 + 9;
 * spec/architecture/v1.1/validation-model.md §4).
 *
 * Repository truth (docs/superpowers/notes/2026-08-30-work-064-repository-mapping.md):
 * the ONE identity authority result type is `/auth`'s `AuthenticatedPrincipal`
 * — the output of `AuthProvider.authenticate`. The ONLY existing
 * non-interactive machine-credential mechanism is the API key
 * (`ApiKeyAuthProvider` → `provider: 'apikey'`); WORK-063's runtime
 * scoped-service-account layer is future architect-gated work that will
 * EXTEND the machine-credential provider set below — never bypass it.
 *
 * THE BOUNDARY:
 *   - this function VALIDATES and BINDS an already-issued principal;
 *   - it NEVER issues tokens, NEVER creates users, NEVER persists
 *     principals, NEVER authenticates, NEVER impersonates a human;
 *   - a human interactive principal (any provider outside the closed
 *     machine-credential set) is REJECTED as a TestIdentity —
 *     discrimination-proven (a real production user can never act as a
 *     synthetic test principal);
 *   - capabilities are preserved EXACTLY as declared — the binding never
 *     expands scope;
 *   - ISOLATED_MUTATION requires the test-tenant binding, and the identity's
 *     tenant must match the environment's isolated tenant (cross-tenant
 *     isolation is rejected).
 */
import type {
  EffectPolicy,
  Environment,
  TestIdentityBinding,
  TestIdentitySource,
} from '../types.js';
import {
  SYNTHETIC_PRINCIPAL_CLASSES,
  ValidationDomainError,
  type TestPrincipalClass,
} from '../types.js';
import type { AuthenticatedPrincipal } from '@modules/auth/index.js';

/**
 * The closed set of MACHINE-CREDENTIAL providers whose principals may bind as
 * synthetic test identities. Repository truth: `apikey` is the only existing
 * machine mechanism (WORK-002). WORK-063's future runtime (scoped service
 * accounts) extends THIS constant — the extension is a deliberate,
 * reviewable change, not a bypass.
 */
export const SYNTHETIC_IDENTITY_PROVIDERS: readonly string[] = ['apikey'];

function isSyntheticPrincipalClass(value: unknown): value is Exclude<TestPrincipalClass, 'unauthenticated'> {
  return (
    typeof value === 'string' &&
    (SYNTHETIC_PRINCIPAL_CLASSES as readonly string[]).includes(value)
  );
}

function assertValidPrincipal(principal: AuthenticatedPrincipal): void {
  if (!principal || typeof principal !== 'object') {
    throw new ValidationDomainError('TEST_IDENTITY_INVALID', 'a synthetic binding requires the authenticated principal');
  }
  if (typeof principal.externalId !== 'string' || principal.externalId.trim() === '') {
    throw new ValidationDomainError(
      'TEST_IDENTITY_INVALID',
      'the principal carries no externalId — it was not authenticated by the identity authority',
    );
  }
}

/**
 * Bind the test identity for a validation run. Throws a typed
 * {@link ValidationDomainError} on every violation:
 *
 *   - an unauthenticated source supports READ_ONLY ONLY (an anonymous
 *     visitor owns no state and must never trigger mutations);
 *   - a synthetic source requires: a valid authenticated principal from a
 *     machine-credential provider (human principals are rejected with
 *     TEST_IDENTITY_HUMAN_PRINCIPAL_REJECTED), a synthetic principal class,
 *     and a non-empty issuance reason;
 *   - ISOLATED_MUTATION requires the test-tenant binding, matching the
 *     environment's isolated tenant when the environment declares one.
 */
export function bindTestIdentity(
  source: TestIdentitySource,
  environment: Environment,
  policy: EffectPolicy,
): TestIdentityBinding {
  if (!source || typeof source !== 'object') {
    throw new ValidationDomainError('TEST_IDENTITY_INVALID', 'a test identity source is required');
  }

  if (source.kind === 'unauthenticated') {
    if (policy !== 'READ_ONLY') {
      throw new ValidationDomainError(
        'TEST_IDENTITY_INVALID',
        `an unauthenticated (null) identity supports READ_ONLY only — ${policy} requires a synthetic principal that owns state`,
      );
    }
    return Object.freeze({
      principalId: null,
      principalClass: 'unauthenticated',
      capabilities: Object.freeze([]),
      tenantId: null,
      issuer: 'WORK-063',
      issuanceReason: null,
    });
  }

  if (source.kind !== 'synthetic') {
    throw new ValidationDomainError(
      'TEST_IDENTITY_INVALID',
      `unknown test identity source kind ${JSON.stringify((source as { kind?: unknown }).kind)}`,
    );
  }

  assertValidPrincipal(source.principal);

  // The load-bearing discrimination: only MACHINE-CREDENTIAL principals may
  // bind as synthetic test identities. A principal authenticated by any
  // human interactive provider is a real production user — rejected.
  if (!SYNTHETIC_IDENTITY_PROVIDERS.includes(source.principal.provider)) {
    throw new ValidationDomainError(
      'TEST_IDENTITY_HUMAN_PRINCIPAL_REJECTED',
      `principal ${source.principal.externalId} authenticated via '${source.principal.provider}' is not a machine-credential principal — a human production principal can never act as a synthetic test identity`,
    );
  }

  if (!isSyntheticPrincipalClass(source.principalClass)) {
    throw new ValidationDomainError(
      'TEST_IDENTITY_INVALID',
      `principal class must be one of ${SYNTHETIC_PRINCIPAL_CLASSES.join(' | ')} (got ${JSON.stringify(source.principalClass)})`,
    );
  }

  if (typeof source.issuanceReason !== 'string' || source.issuanceReason.trim() === '') {
    throw new ValidationDomainError(
      'TEST_IDENTITY_INVALID',
      'a synthetic binding requires a non-empty issuance reason (every test identity is attributed)',
    );
  }

  const capabilities = Array.isArray(source.capabilities)
    ? source.capabilities.map((capability) => {
        if (typeof capability !== 'string' || capability.trim() === '') {
          throw new ValidationDomainError(
            'TEST_IDENTITY_INVALID',
            'capabilities are non-empty strings',
          );
        }
        return capability;
      })
    : [];
  // Capabilities are preserved EXACTLY — same values, same order, no expansion.

  let tenantId: string | null = null;
  if (source.tenantId !== undefined) {
    if (typeof source.tenantId !== 'string' || source.tenantId.trim() === '') {
      throw new ValidationDomainError(
        'TEST_IDENTITY_INVALID',
        'the test-tenant binding is a non-empty string when present',
      );
    }
    tenantId = source.tenantId;
  }

  if (policy === 'ISOLATED_MUTATION') {
    if (tenantId === null) {
      throw new ValidationDomainError(
        'TEST_IDENTITY_TENANT_REQUIRED',
        'ISOLATED_MUTATION requires the synthetic identity to carry the test-tenant binding',
      );
    }
    if (
      environment.isolatedTenantId !== null &&
      tenantId !== environment.isolatedTenantId
    ) {
      throw new ValidationDomainError(
        'TEST_IDENTITY_TENANT_REQUIRED',
        `the identity's test tenant '${tenantId}' does not match the environment's isolated tenant '${environment.isolatedTenantId}' (cross-tenant isolation)`,
      );
    }
  }

  return Object.freeze({
    principalId: source.principal.externalId,
    principalClass: source.principalClass,
    capabilities: Object.freeze(capabilities),
    tenantId,
    issuer: 'WORK-063',
    issuanceReason: source.issuanceReason,
  });
}
