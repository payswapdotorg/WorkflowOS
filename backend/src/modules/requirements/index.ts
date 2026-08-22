/**
 * requirements module — public interface.
 *
 * Canonical name: /requirements
 * Responsibility (spec/architecture.md): Requirements and Acceptance Criteria.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-006: implements the authoritative /requirements domain (REQ-001/002).
 * Owns Requirement + AcceptanceCriterion + dependencies + evidence references.
 * Does NOT own verification semantics (later /verification) or work-item state
 * (later /work-items).
 *
 * Traceability chain:
 *   Requirement → ArchitectureVersion → Architecture → Project → Organization
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  Requirement,
  RequirementStatus,
  CreateRequirementInput,
  UpdateRequirementInput,
  RequirementRepository,
  RequirementDependency,
  RequirementDependencyRepository,
  AcceptanceCriterion,
  CriterionStatus,
  CreateCriterionInput,
  UpdateCriterionInput,
  AcceptanceCriterionRepository,
  EvidenceReference,
  AddEvidenceReferenceInput,
  EvidenceReferenceRepository,
} from './internal/requirement.types.js';

/**
 * Public capabilities exposed by the /requirements module to other modules.
 */
export interface RequirementsModuleApi {
  // future: additional requirement-domain methods consumed by other modules
}

/**
 * Frozen module contract for /requirements.
 */
export const requirementsModule: ModuleContract & RequirementsModuleApi = {
  name: '/requirements',
};

export default requirementsModule;
