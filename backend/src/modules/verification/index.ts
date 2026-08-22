/**
 * verification module — public interface.
 *
 * Canonical name: /verification
 * Responsibility (spec/architecture.md §24, §25): Verification Runs, Evidence,
 * evidence→criterion mapping, criterion/requirement evaluation.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-015: implements the authoritative /verification domain (VERIFY-001..003).
 * Owns VerificationRun, Evidence, CriterionEvidenceMapping, and the
 * deterministic VerificationService evaluation engine. Does NOT own:
 * - CI provider integration (that's /github — GITHUB-006);
 * - AcceptanceCriterion persistence (that's /requirements — REQ-002);
 * - canonical workflow state (that's /workflows);
 * - Architect Reviews (that's /reviews).
 *
 * Authority hierarchy (frozen architecture §2.2, §15, §25):
 *   authoritative evidence (CI results ingested via /github, manual
 *   verification by an authorized reviewer) → MAY produce criterion PASS.
 *   claim evidence (agent-reported tests, LLM/Architect output, GitHub
 *   labels/comments) → NEVER sufficient alone for criterion PASS.
 *
 * Traceability chain (frozen architecture §25):
 *   VerificationRun → Work Item → ArchitectureVersion → Architecture → Project
 */
import type { ModuleContract } from '@platform/module-contract.js';

// Re-export the criterion/requirement status enums from /requirements so
// /verification consumers use the SAME types (no duplicate authority — the
// enums are owned by /requirements per REQ-001/002 + AC-AC-03).
export type {
  CriterionStatus,
  RequirementStatus,
} from '@modules/requirements/index.js';

export type {
  VerificationRunStatus,
  EvidenceAuthority,
  EvidenceResult,
  Evidence,
  CreateEvidenceInput,
  EvidenceRepository,
  VerificationRun,
  CreateVerificationRunInput,
  UpdateVerificationRunInput,
  VerificationRunRepository,
  MappingRelevance,
  MappingStatus,
  CriterionEvidenceMapping,
  CreateMapInput,
  CriterionEvidenceMappingRepository,
  CriterionEvaluation,
  RequirementDerivation,
  VerificationService,
} from './internal/verification.types.js';

/**
 * Public capabilities exposed by the /verification module to other modules.
 */
export interface VerificationModuleApi {
  // future: additional verification-domain methods consumed by other modules
}

/**
 * Frozen module contract for /verification.
 */
export const verificationModule: ModuleContract & VerificationModuleApi = {
  name: '/verification',
};

export default verificationModule;
