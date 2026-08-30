import { describe, it, expect } from 'vitest';

/**
 * WORK-064 Task 4 — TestIdentity binding WITHOUT creating an identity
 * authority (spec/work-orders/WORK-064.md invariants 3 + 9;
 * spec/architecture/v1.1/validation-model.md §4).
 *
 * The binding is an ADAPTER over the EXISTING /auth authority's
 * `AuthenticatedPrincipal`. It validates and records; it never issues
 * tokens, never creates users, never impersonates humans.
 */
import {
  describeEnvironment,
  bindTestIdentity,
  ValidationDomainError,
  SYNTHETIC_IDENTITY_PROVIDERS,
  type TestIdentitySource,
} from '../../src/continuous-validation/index.js';
import type { AuthenticatedPrincipal } from '@modules/auth/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A principal authenticated by the EXISTING authority via a machine credential. */
const syntheticPrincipal: AuthenticatedPrincipal = {
  externalId: 'svc-validation-runner-01',
  label: 'validation runner (test service account)',
  provider: 'apikey',
};

/** A principal authenticated through a HUMAN interactive provider. */
const humanPrincipal: AuthenticatedPrincipal = {
  externalId: 'user-alice@example.com',
  label: 'Alice (human sign-in)',
  provider: 'oidc',
};

const previewEnv = describeEnvironment({
  id: 'env-preview',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-preview',
});

const productionEnv = describeEnvironment({
  id: 'env-production',
  kind: 'production',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION'],
});

const unauthenticatedSource: TestIdentitySource = { kind: 'unauthenticated' };

const syntheticSource: TestIdentitySource = {
  kind: 'synthetic',
  principal: syntheticPrincipal,
  principalClass: 'test_service_account',
  capabilities: ['project.read', 'project.write'],
  tenantId: 'tenant-preview',
  issuanceReason: 'PR #42 preview validation run',
};

// ---------------------------------------------------------------------------
// §1 Binding validity
// ---------------------------------------------------------------------------

describe('WORK-064 test identity — binding validity', () => {
  it('binds a synthetic principal with full WORK-063 provenance', () => {
    const binding = bindTestIdentity(syntheticSource, previewEnv, 'SAFE_MUTATION');
    expect(binding.principalId).toBe('svc-validation-runner-01');
    expect(binding.principalClass).toBe('test_service_account');
    expect(binding.issuer).toBe('WORK-063');
    expect(binding.issuanceReason).toBe('PR #42 preview validation run');
    expect(binding.tenantId).toBe('tenant-preview');
  });

  it('null identity is valid ONLY for unauthenticated (READ_ONLY) journeys', () => {
    // The null binding itself:
    const binding = bindTestIdentity(unauthenticatedSource, previewEnv, 'READ_ONLY');
    expect(binding.principalId).toBeNull();
    expect(binding.principalClass).toBe('unauthenticated');
    expect(binding.capabilities).toEqual([]);
    expect(binding.issuanceReason).toBeNull();
    // An anonymous visitor owns no state: any mutating policy is rejected.
    expect(() => bindTestIdentity(unauthenticatedSource, previewEnv, 'SAFE_MUTATION')).toThrow(
      ValidationDomainError,
    );
    expect(() => bindTestIdentity(unauthenticatedSource, previewEnv, 'ISOLATED_MUTATION')).toThrow(
      ValidationDomainError,
    );
    expect(() => bindTestIdentity(unauthenticatedSource, previewEnv, 'FORBIDDEN')).toThrow(
      ValidationDomainError,
    );
  });

  it('authenticated validation requires a synthetic principal (a bare human principal is rejected)', () => {
    expect(() =>
      bindTestIdentity(
        {
          kind: 'synthetic',
          principal: humanPrincipal,
          principalClass: 'test_user',
          capabilities: ['project.read'],
          issuanceReason: 'attempting to bind a human sign-in principal',
        },
        previewEnv,
        'READ_ONLY',
      ),
    ).toThrow(ValidationDomainError);
  });

  it('rejects a synthetic source with an empty issuance reason (no unattributed test identity)', () => {
    expect(() =>
      bindTestIdentity(
        { ...syntheticSource, issuanceReason: '' },
        previewEnv,
        'READ_ONLY',
      ),
    ).toThrow(ValidationDomainError);
  });

  it('rejects a synthetic source with an invalid principal class', () => {
    expect(() =>
      bindTestIdentity(
        {
          ...syntheticSource,
          // @ts-expect-error — invalid class at runtime
          principalClass: 'real_production_admin',
        },
        previewEnv,
        'READ_ONLY',
      ),
    ).toThrow(ValidationDomainError);
  });

  it('rejects a principal without an externalId (not authenticated by any authority)', () => {
    expect(() =>
      bindTestIdentity(
        {
          kind: 'synthetic',
          // An empty externalId is a valid-typed principal shape — the
          // runtime guard must reject it (not authenticated by any authority).
          principal: { externalId: '', label: 'ghost', provider: 'apikey' },
          principalClass: 'test_service_account',
          capabilities: [],
          issuanceReason: 'ghost binding attempt',
        },
        previewEnv,
        'READ_ONLY',
      ),
    ).toThrow(ValidationDomainError);
  });
});

// ---------------------------------------------------------------------------
// §2 The machine-credential provider discrimination
// ---------------------------------------------------------------------------

describe('WORK-064 test identity — the provider discrimination', () => {
  it('the machine-credential provider set is the closed existing set (apikey today)', () => {
    // Repository truth: the API key is the ONLY existing machine-credential
    // mechanism. WORK-063's future scoped-service-account runtime EXTENDS
    // this set — it does not bypass it.
    expect([...SYNTHETIC_IDENTITY_PROVIDERS]).toEqual(['apikey']);
  });

  it('a human production principal is rejected regardless of declared class or reason', () => {
    for (const provider of ['oidc', 'google', 'github', 'email', 'saml']) {
      expect(() =>
        bindTestIdentity(
          {
            kind: 'synthetic',
            principal: { externalId: 'x', label: 'x', provider },
            principalClass: 'test_user',
            capabilities: ['project.read'],
            issuanceReason: 'human principal smuggling attempt',
          },
          previewEnv,
          'READ_ONLY',
        ),
      ).toThrow(ValidationDomainError);
    }
  });

  it('a human principal in PRODUCTION is rejected (never act as a real production user)', () => {
    expect(() =>
      bindTestIdentity(
        {
          kind: 'synthetic',
          principal: humanPrincipal,
          principalClass: 'test_user',
          capabilities: ['project.read'],
          issuanceReason: 'production impersonation attempt',
        },
        productionEnv,
        'READ_ONLY',
      ),
    ).toThrow(ValidationDomainError);
  });
});

// ---------------------------------------------------------------------------
// §3 Capability scope preservation + tenant binding
// ---------------------------------------------------------------------------

describe('WORK-064 test identity — capabilities and tenant binding', () => {
  it('capability scope is preserved EXACTLY (no expansion, no reordering)', () => {
    const capabilities = ['project.read', 'project.write', 'repo.read'];
    const binding = bindTestIdentity(
      { ...syntheticSource, capabilities },
      previewEnv,
      'READ_ONLY',
    );
    expect(binding.capabilities).toEqual(capabilities);
    expect(binding.capabilities).toHaveLength(3);
  });

  it('tenant binding is mandatory for ISOLATED_MUTATION', () => {
    expect(() =>
      bindTestIdentity({ ...syntheticSource, tenantId: undefined }, previewEnv, 'ISOLATED_MUTATION'),
    ).toThrow(ValidationDomainError);

    const bound = bindTestIdentity(syntheticSource, previewEnv, 'ISOLATED_MUTATION');
    expect(bound.tenantId).toBe('tenant-preview');
  });

  it('a tenant mismatch between identity and environment is rejected (cross-tenant isolation)', () => {
    expect(() =>
      bindTestIdentity(
        { ...syntheticSource, tenantId: 'tenant-someone-elses' },
        previewEnv,
        'ISOLATED_MUTATION',
      ),
    ).toThrow(ValidationDomainError);
  });

  it('READ_ONLY and SAFE_MUTATION bind without a tenant requirement', () => {
    const readOnly = bindTestIdentity(
      { ...syntheticSource, tenantId: undefined },
      previewEnv,
      'READ_ONLY',
    );
    expect(readOnly.tenantId).toBeNull();
    const safeMutation = bindTestIdentity(
      { ...syntheticSource, tenantId: undefined },
      previewEnv,
      'SAFE_MUTATION',
    );
    expect(safeMutation.principalId).toBe('svc-validation-runner-01');
  });
});

// ---------------------------------------------------------------------------
// §4 No self-minting (the structural no-second-identity-authority proofs)
// ---------------------------------------------------------------------------

describe('WORK-064 test identity — no minting surface', () => {
  it('the binding carries NO credential material (no token/secret/key/password fields)', () => {
    const binding = bindTestIdentity(syntheticSource, previewEnv, 'SAFE_MUTATION');
    const forbiddenKeyPattern = /token|secret|password|credential|cookie|apikey|api_key/i;
    const scan = (value: unknown, path: string): string[] => {
      if (typeof value !== 'object' || value === null) return [];
      const findings: string[] = [];
      for (const [key, child] of Object.entries(value)) {
        if (forbiddenKeyPattern.test(key)) findings.push(`${path}.${key}`);
        findings.push(...scan(child, `${path}.${key}`));
      }
      return findings;
    };
    expect(scan(binding, 'binding')).toEqual([]);
  });

  it('the binding result never contains the raw principal provider credential surface (metadata only)', () => {
    // The AuthenticatedPrincipal itself is metadata-only by contract
    // (externalId/label/provider — the /auth module guarantees NO secrets);
    // the binding stores exactly the principalId (externalId) and nothing more.
    const binding = bindTestIdentity(syntheticSource, previewEnv, 'READ_ONLY');
    expect(Object.keys(binding).sort()).toEqual([
      'capabilities',
      'issuanceReason',
      'issuer',
      'principalClass',
      'principalId',
      'tenantId',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §5 The environment-shape discrimination (lifecycle §4 scheduling rule)
// ---------------------------------------------------------------------------

describe('WORK-064 test identity — environment validity', () => {
  it('a synthetic identity binds in production (that is what production validation requires)', () => {
    const binding = bindTestIdentity(
      { ...syntheticSource, tenantId: undefined },
      productionEnv,
      'READ_ONLY',
    );
    expect(binding.principalClass).toBe('test_service_account');
  });

  it('an unauthenticated identity binds for public READ_ONLY production paths', () => {
    const binding = bindTestIdentity(unauthenticatedSource, productionEnv, 'READ_ONLY');
    expect(binding.principalClass).toBe('unauthenticated');
  });
});
