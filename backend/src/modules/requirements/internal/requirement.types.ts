/**
 * Requirements domain types (REQ-001, REQ-002, REQ-AC-01..03, AC-AC-01..04).
 *
 * The /requirements module owns Requirement + AcceptanceCriterion domain
 * authority. It does NOT own verification semantics (later /verification) or
 * work-item state (later /work-items).
 *
 * Traceability chain (architecture §10):
 *   Requirement → ArchitectureVersion → Architecture → Project → Organization
 *
 * Tenant scoping is inherited through the ArchitectureVersion's project
 * ownership (reused WORK-002 AuthorizationService).
 */

// --- Requirement ---

export type RequirementStatus = 'pending' | 'satisfied' | 'blocked';

export interface Requirement {
  readonly id: string;
  readonly architectureVersionId: string;
  readonly requirementId: string;
  readonly title: string;
  readonly description: string | null;
  readonly verificationRequirement: string | null;
  readonly status: RequirementStatus;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateRequirementInput {
  architectureVersionId: string;
  requirementId: string;
  title: string;
  description?: string;
  verificationRequirement?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateRequirementInput {
  title?: string;
  description?: string;
  verificationRequirement?: string;
  status?: RequirementStatus;
  metadata?: Record<string, unknown>;
}

export interface RequirementRepository {
  create(input: CreateRequirementInput): Promise<Requirement>;
  findById(id: string): Promise<Requirement | null>;
  findByArchitectureVersion(architectureVersionId: string): Promise<Requirement[]>;
  update(id: string, input: UpdateRequirementInput): Promise<Requirement | null>;
}

// --- Requirement Dependencies ---

export interface RequirementDependency {
  readonly id: string;
  readonly requirementId: string;
  readonly dependsOnId: string;
  readonly createdAt: Date;
}

export interface RequirementDependencyRepository {
  add(requirementId: string, dependsOnId: string): Promise<RequirementDependency>;
  listForRequirement(requirementId: string): Promise<RequirementDependency[]>;
  remove(id: string): Promise<void>;
}

// --- Acceptance Criteria ---

export type CriterionStatus = 'pending' | 'pass' | 'fail' | 'blocked';

export interface AcceptanceCriterion {
  readonly id: string;
  readonly requirementId: string;
  readonly criterionId: string;
  readonly description: string;
  readonly verificationExpectation: string | null;
  readonly status: CriterionStatus;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateCriterionInput {
  requirementId: string;
  criterionId: string;
  description: string;
  verificationExpectation?: string;
  status?: CriterionStatus;
  metadata?: Record<string, unknown>;
}

export interface UpdateCriterionInput {
  description?: string;
  verificationExpectation?: string;
  status?: CriterionStatus;
  metadata?: Record<string, unknown>;
}

export interface AcceptanceCriterionRepository {
  create(input: CreateCriterionInput): Promise<AcceptanceCriterion>;
  findById(id: string): Promise<AcceptanceCriterion | null>;
  listForRequirement(requirementId: string): Promise<AcceptanceCriterion[]>;
  update(id: string, input: UpdateCriterionInput): Promise<AcceptanceCriterion | null>;
}

// --- Evidence References ---

export interface EvidenceReference {
  readonly id: string;
  readonly criterionId: string;
  readonly evidenceType: string;
  readonly evidenceRef: string;
  readonly source: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface AddEvidenceReferenceInput {
  criterionId: string;
  evidenceType: string;
  evidenceRef: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface EvidenceReferenceRepository {
  add(input: AddEvidenceReferenceInput): Promise<EvidenceReference>;
  listForCriterion(criterionId: string): Promise<EvidenceReference[]>;
  remove(id: string): Promise<void>;
}
