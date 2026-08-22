import type { DatabaseClient } from '@platform/index.js';
import type {
  Requirement,
  RequirementRepository,
  CreateRequirementInput,
  UpdateRequirementInput,
  RequirementStatus,
  RequirementDependency,
  RequirementDependencyRepository,
  AcceptanceCriterion,
  AcceptanceCriterionRepository,
  CreateCriterionInput,
  UpdateCriterionInput,
  CriterionStatus,
  EvidenceReference,
  EvidenceReferenceRepository,
  AddEvidenceReferenceInput,
} from './requirement.types.js';

// ===========================================================================
// Requirement repository
// ===========================================================================

export class PgRequirementRepository implements RequirementRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateRequirementInput): Promise<Requirement> {
    const result = await this.db.query<ReqRow>(
      `INSERT INTO wfos_requirements
         (architecture_version_id, requirement_id, title, description,
          verification_requirement, status, metadata)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       RETURNING id, architecture_version_id, requirement_id, title, description,
                 verification_requirement, status, metadata, created_at, updated_at`,
      [
        input.architectureVersionId,
        input.requirementId,
        input.title,
        input.description ?? null,
        input.verificationRequirement ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapReq(result.rows[0]!);
  }

  async findById(id: string): Promise<Requirement | null> {
    const result = await this.db.query<ReqRow>(
      `SELECT id, architecture_version_id, requirement_id, title, description,
              verification_requirement, status, metadata, created_at, updated_at
       FROM wfos_requirements WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapReq(result.rows[0]!);
  }

  async findByArchitectureVersion(architectureVersionId: string): Promise<Requirement[]> {
    const result = await this.db.query<ReqRow>(
      `SELECT id, architecture_version_id, requirement_id, title, description,
              verification_requirement, status, metadata, created_at, updated_at
       FROM wfos_requirements WHERE architecture_version_id = $1
       ORDER BY requirement_id`,
      [architectureVersionId],
    );
    return result.rows.map(mapReq);
  }

  async update(id: string, input: UpdateRequirementInput): Promise<Requirement | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    let pIdx = 2;
    if (input.title !== undefined) { sets.push(`title = $${pIdx++}`); params.push(input.title); }
    if (input.description !== undefined) { sets.push(`description = $${pIdx++}`); params.push(input.description); }
    if (input.verificationRequirement !== undefined) { sets.push(`verification_requirement = $${pIdx++}`); params.push(input.verificationRequirement); }
    if (input.status !== undefined) { sets.push(`status = $${pIdx++}`); params.push(input.status); }
    if (input.metadata !== undefined) { sets.push(`metadata = $${pIdx++}`); params.push(JSON.stringify(input.metadata)); }
    if (sets.length === 0) return this.findById(id);
    const result = await this.db.query<ReqRow>(
      `UPDATE wfos_requirements SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, architecture_version_id, requirement_id, title, description,
                 verification_requirement, status, metadata, created_at, updated_at`,
      params,
    );
    if (result.rows.length === 0) return null;
    return mapReq(result.rows[0]!);
  }
}

// ===========================================================================
// Requirement dependency repository
// ===========================================================================

export class PgRequirementDependencyRepository implements RequirementDependencyRepository {
  constructor(private readonly db: DatabaseClient) {}

  async add(requirementId: string, dependsOnId: string): Promise<RequirementDependency> {
    const result = await this.db.query<DepRow>(
      `INSERT INTO wfos_requirement_dependencies (requirement_id, depends_on_id)
       VALUES ($1, $2)
       ON CONFLICT (requirement_id, depends_on_id) DO NOTHING
       RETURNING id, requirement_id, depends_on_id, created_at`,
      [requirementId, dependsOnId],
    );
    if (result.rows.length === 0) {
      // Already exists; fetch it.
      const existing = await this.db.query<DepRow>(
        `SELECT id, requirement_id, depends_on_id, created_at
         FROM wfos_requirement_dependencies WHERE requirement_id = $1 AND depends_on_id = $2`,
        [requirementId, dependsOnId],
      );
      return mapDep(existing.rows[0]!);
    }
    return mapDep(result.rows[0]!);
  }

  async listForRequirement(requirementId: string): Promise<RequirementDependency[]> {
    const result = await this.db.query<DepRow>(
      `SELECT id, requirement_id, depends_on_id, created_at
       FROM wfos_requirement_dependencies WHERE requirement_id = $1`,
      [requirementId],
    );
    return result.rows.map(mapDep);
  }

  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM wfos_requirement_dependencies WHERE id = $1', [id]);
  }
}

// ===========================================================================
// Acceptance criterion repository
// ===========================================================================

export class PgAcceptanceCriterionRepository implements AcceptanceCriterionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateCriterionInput): Promise<AcceptanceCriterion> {
    const result = await this.db.query<AcRow>(
      `INSERT INTO wfos_acceptance_criteria
         (requirement_id, criterion_id, description, verification_expectation, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, requirement_id, criterion_id, description, verification_expectation,
                 status, metadata, created_at, updated_at`,
      [
        input.requirementId,
        input.criterionId,
        input.description,
        input.verificationExpectation ?? null,
        input.status ?? 'pending',
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapAc(result.rows[0]!);
  }

  async findById(id: string): Promise<AcceptanceCriterion | null> {
    const result = await this.db.query<AcRow>(
      `SELECT id, requirement_id, criterion_id, description, verification_expectation,
              status, metadata, created_at, updated_at
       FROM wfos_acceptance_criteria WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapAc(result.rows[0]!);
  }

  async listForRequirement(requirementId: string): Promise<AcceptanceCriterion[]> {
    const result = await this.db.query<AcRow>(
      `SELECT id, requirement_id, criterion_id, description, verification_expectation,
              status, metadata, created_at, updated_at
       FROM wfos_acceptance_criteria WHERE requirement_id = $1
       ORDER BY criterion_id`,
      [requirementId],
    );
    return result.rows.map(mapAc);
  }

  async update(id: string, input: UpdateCriterionInput): Promise<AcceptanceCriterion | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    let pIdx = 2;
    if (input.description !== undefined) { sets.push(`description = $${pIdx++}`); params.push(input.description); }
    if (input.verificationExpectation !== undefined) { sets.push(`verification_expectation = $${pIdx++}`); params.push(input.verificationExpectation); }
    if (input.status !== undefined) { sets.push(`status = $${pIdx++}`); params.push(input.status); }
    if (input.metadata !== undefined) { sets.push(`metadata = $${pIdx++}`); params.push(JSON.stringify(input.metadata)); }
    if (sets.length === 0) return this.findById(id);
    const result = await this.db.query<AcRow>(
      `UPDATE wfos_acceptance_criteria SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, requirement_id, criterion_id, description, verification_expectation,
                 status, metadata, created_at, updated_at`,
      params,
    );
    if (result.rows.length === 0) return null;
    return mapAc(result.rows[0]!);
  }
}

// ===========================================================================
// Evidence reference repository
// ===========================================================================

export class PgEvidenceReferenceRepository implements EvidenceReferenceRepository {
  constructor(private readonly db: DatabaseClient) {}

  async add(input: AddEvidenceReferenceInput): Promise<EvidenceReference> {
    const result = await this.db.query<EvRow>(
      `INSERT INTO wfos_criterion_evidence_references
         (criterion_id, evidence_type, evidence_ref, source, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, criterion_id, evidence_type, evidence_ref, source, metadata, created_at`,
      [
        input.criterionId,
        input.evidenceType,
        input.evidenceRef,
        input.source ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapEv(result.rows[0]!);
  }

  async listForCriterion(criterionId: string): Promise<EvidenceReference[]> {
    const result = await this.db.query<EvRow>(
      `SELECT id, criterion_id, evidence_type, evidence_ref, source, metadata, created_at
       FROM wfos_criterion_evidence_references WHERE criterion_id = $1
       ORDER BY created_at`,
      [criterionId],
    );
    return result.rows.map(mapEv);
  }

  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM wfos_criterion_evidence_references WHERE id = $1', [id]);
  }
}

// ===========================================================================
// Row mappers
// ===========================================================================

interface ReqRow {
  id: string;
  architecture_version_id: string;
  requirement_id: string;
  title: string;
  description: string | null;
  verification_requirement: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}
interface DepRow {
  id: string;
  requirement_id: string;
  depends_on_id: string;
  created_at: Date;
}
interface AcRow {
  id: string;
  requirement_id: string;
  criterion_id: string;
  description: string;
  verification_expectation: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}
interface EvRow {
  id: string;
  criterion_id: string;
  evidence_type: string;
  evidence_ref: string;
  source: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function mapReq(row: ReqRow): Requirement {
  return {
    id: row.id,
    architectureVersionId: row.architecture_version_id,
    requirementId: row.requirement_id,
    title: row.title,
    description: row.description,
    verificationRequirement: row.verification_requirement,
    status: row.status as RequirementStatus,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDep(row: DepRow): RequirementDependency {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    dependsOnId: row.depends_on_id,
    createdAt: row.created_at,
  };
}

function mapAc(row: AcRow): AcceptanceCriterion {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    criterionId: row.criterion_id,
    description: row.description,
    verificationExpectation: row.verification_expectation,
    status: row.status as CriterionStatus,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEv(row: EvRow): EvidenceReference {
  return {
    id: row.id,
    criterionId: row.criterion_id,
    evidenceType: row.evidence_type,
    evidenceRef: row.evidence_ref,
    source: row.source,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}
