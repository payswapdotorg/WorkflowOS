/**
 * architecture module — public interface.
 *
 * Canonical name: /architecture
 * Responsibility (spec/architecture.md): Architecture Management, ADRs,
 * Architecture Change Requests, Architecture Versions.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-005: implements the runtime project-specific /architecture domain
 * (ARCH-001..004). This is distinct from the frozen repository governance
 * documents (/spec/architecture.md, /spec/architecture-lock.md) which are NOT
 * modified. The runtime model coexists with the frozen governance model.
 *
 * Lifecycle: DRAFT → FROZEN → SUPERSEDED. A frozen version is immutable
 * (persistence-enforced, not just a service check). A new immutable version is
 * created only from an approved Architecture Change Request.
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  Architecture,
  CreateArchitectureInput,
  ArchitectureVersion,
  ArchitectureVersionState,
  CreateArchitectureVersionInput,
  ArchitectureVersionRepository,
  ArchitectureRepository,
  ArchitectureDecisionRecord,
  CreateAdrInput,
  ArchitectureDecisionRepository,
  ArchitectureChangeRequest,
  ChangeRequestStatus,
  CreateChangeRequestInput,
  ArchitectureChangeRequestRepository,
  ArchitectureService,
} from './internal/architecture.types.js';

/**
 * Public capabilities exposed by the /architecture module to other modules.
 */
export interface ArchitectureModuleApi {
  // future: additional architecture-domain methods consumed by other modules
}

/**
 * Frozen module contract for /architecture.
 */
export const architectureModule: ModuleContract & ArchitectureModuleApi = {
  name: '/architecture',
};

export default architectureModule;
