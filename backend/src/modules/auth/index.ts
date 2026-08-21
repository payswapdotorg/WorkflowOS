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
  AuthorizationService,
  ApiKeyCredentialRef,
} from './internal/auth.types.js';
export type {
  ProvisionApiKeyInput,
  ProvisionedApiKey,
} from './internal/authorization-service.js';

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
