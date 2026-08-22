/**
 * specifications module — public interface.
 *
 * Canonical name: /specifications
 * Responsibility (spec/architecture.md): specification documents and specification lifecycle.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-004: implements specification persistence + lifecycle + versioned
 * content traceability (SPEC-001, SPEC-AC-01..03). A specification belongs
 * to exactly one project; tenant scoping is inherited through the project's
 * owning organization (AUTHZ). Large content bodies use the existing
 * ObjectStore abstraction (DATA-003).
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  Specification,
  CreateSpecificationInput,
  UpdateSpecificationInput,
  SpecificationState,
  SpecificationLifecycleTransition,
  SpecificationVersion,
  CreateSpecificationVersionInput,
  SpecificationRepository,
  SpecificationVersionRepository,
} from './internal/specification.types.js';

/**
 * Public capabilities exposed by the /specifications module to other modules.
 */
export interface SpecificationsModuleApi {
  // future: additional specification-domain methods
}

/**
 * Frozen module contract for /specifications.
 */
export const specificationsModule: ModuleContract & SpecificationsModuleApi = {
  name: '/specifications',
};

export default specificationsModule;
