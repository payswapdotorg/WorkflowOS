/**
 * runtime module — public interface.
 *
 * Canonical name: /runtime
 * Responsibility (WORK-026): provider-independent deployment / preview
 * environment boundary. Owns the integration link between a WorkflowOS
 * project and an external deployment provider (Vercel, fake, future) and
 * the per-commit deployment records (preview URL, status, commit sha).
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * The module NEVER makes provider API calls from the domain layer —
 * concrete adapters (Vercel, fake) live in internal/ and are injected by
 * the composition root. Secrets never reach the frontend.
 */
import type { ModuleContract } from '@platform/module-contract.js';

export type {
  RuntimeIntegration,
  RuntimeIntegrationRepository,
  Deployment,
  DeploymentStatus,
  CreateProjectDeploymentInput,
  LinkRepositoryInput,
  GetDeploymentInput,
  DeploymentProvider,
  DeploymentRepository,
  DeploymentService,
  ProjectRuntimeStatus,
  RuntimeStatusService,
} from './internal/runtime.types.js';

/**
 * Public capabilities exposed by the /runtime module to other modules.
 */
export interface RuntimeModuleApi {
  // future: additional runtime-domain methods consumed by other modules
}

/**
 * Frozen module contract for /runtime.
 */
export const runtimeModule: ModuleContract & RuntimeModuleApi = {
  name: '/runtime',
};

export default runtimeModule;
