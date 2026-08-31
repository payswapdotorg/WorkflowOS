/**
 * auth module — public interface.
 *
 * Canonical name: /auth
 * Responsibility (spec/architecture.md): Authentication, WorkflowOS user identity boundary (paired with /users).
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-002: exposes the provider-independent authentication + authorization
 * contracts ({@link AuthProvider}, {@link AuthorizationService}) consumed by
 * the API layer and future modules.
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  AuthenticatedPrincipal,
  AuthenticationResult,
  AuthProvider,
  ProtectedResource,
  AuthorizationDecision,
  OrganizationAuthorizationDecision,
  AuthorizationService,
  ApiKeyCredentialRef,
  MachinePrincipalContext,
  SessionContext,
} from './internal/auth.types.js';
export type {
  ProvisionApiKeyInput,
  ProvisionedApiKey,
} from './internal/authorization-service.js';
// WORK-074 identity runtime contracts (types only — concrete implementations
// are wired by the composition root, never imported across module boundaries).
export type {
  SessionRecord,
  SessionVerification,
  SessionRefreshResult,
  CreateSessionInput,
  CreateSessionResult,
  SessionService,
} from './internal/session-service.js';
export type {
  PasswordCredentialService,
  PasswordRegisterInput,
  PasswordVerifyResult,
  PasswordCredentialError,
} from './internal/password-credential-service.js';
export type {
  ProviderIdentityAssertion,
  IdentityResolution,
  IdentityResolutionService,
  IdentityResolutionError,
} from './internal/identity-resolution-service.js';
export type {
  ServiceAccount,
  ServiceAccountKeyView,
  IssuedKeyMaterial,
  MachineIdentityService,
  MachineIdentityError,
  CreateServiceAccountInput,
  IssueKeyInput,
} from './internal/machine-identity-service.js';
export type {
  OAuthProviderAdapter,
  OAuthProviderAssertion,
} from './internal/oauth-provider.js';
export type { OAuthStateStore, OAuthStateRecord } from './internal/oauth-state-store.js';

/**
 * Public capabilities exposed by the /auth module to other modules.
 */
export interface AuthModuleApi {
  // future: additional auth-domain methods consumed by other modules
}

/**
 * Frozen module contract for /auth.
 */
export const authModule: ModuleContract & AuthModuleApi = {
  name: '/auth',
};

export default authModule;
