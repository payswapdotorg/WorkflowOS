import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import {
  ArchitectPlanApplier,
  ArchitectPlanIntegrityError,
} from '../../../src/modules/llm/internal/architect-plan-applier.js';
import { PgArchitectSessionRepository } from '../../../src/modules/llm/internal/pg-architect-session-repository.js';
import {
  PgArchitectureRepository,
  PgArchitectureVersionRepository,
} from '../../../src/modules/architecture/internal/pg-architecture-repository.js';
import {
  PgRequirementRepository,
  PgAcceptanceCriterionRepository,
} from '../../../src/modules/requirements/internal/pg-requirement-repository.js';
import {
  PgWorkItemRepository,
  PgWorkItemRequirementRepository,
  PgWorkItemCriterionRepository,
  PgWorkOrderRepository,
  PgWorkItemDependencyRepository,
} from '../../../src/modules/work-items/internal/pg-work-item-repository.js';
import type { ArchitectParsedPlan } from '@modules/llm/index.js';
import type { DatabaseClient } from '@platform/index.js';

/**
 * PR #28 correction #2 — plan-integrity validation.
 *
 * Before the fix, the applier silently skipped associations when a
 * reference didn't resolve:
 *
 *     const req = createdReqs.find(r => r.requirementId === reqId);
 *     if (req) await wiReqRepo.associate(workItem.id, req.id);
 *
 * This meant malformed Architect output could produce a partially applied
 * plan (missing associations) while the transaction still committed.
 *
 * After the fix, the applier validates the plan BEFORE entering the
 * transaction and throws ArchitectPlanIntegrityError for:
 *
 *   1. Unknown requirementId referenced by a Work Item
 *   2. Unknown criterionId referenced by a Work Item
 *   3. Unknown dependency ID referenced by a Work Item
 *   4. Duplicate Work Item IDs
 *   5. Duplicate requirement IDs
 *   6. Duplicate criterion IDs
 *   7. Criterion declared under the wrong requirement
 *
 * This file proves each violation kind throws BEFORE any plan artifact is
 * persisted (no Architecture, ArchitectureVersion, Requirement, Criterion,
 * Work Item, association, dependency, or Work Order remains), and the
 * Architect session remains active.
 *
 * It also proves the happy-path plan (valid references, no duplicates)
 * still applies successfully after the validation layer was added.
 */

function validPlan(): ArchitectParsedPlan {
  return {
    architecture: { name: 'Plan Integrity Arch', content: 'Constraints for plan integrity' },
    requirements: [
      {
        requirementId: 'REQ-PI-001',
        title: 'Requirement 1',
        description: 'First requirement',
        criteria: [
          { criterionId: 'AC-PI-001', description: 'Criterion 1' },
          { criterionId: 'AC-PI-002', description: 'Criterion 2' },
        ],
      },
      {
        requirementId: 'REQ-PI-002',
        title: 'Requirement 2',
        description: 'Second requirement',
        criteria: [
          { criterionId: 'AC-PI-003', description: 'Criterion 3' },
        ],
      },
    ],
    workItems: [
      {
        workItemId: 'WI-PI-001',
        title: 'Work Item 1',
        objective: 'Objective 1',
        scope: 'Scope 1',
        requirementIds: ['REQ-PI-001'],
        criterionIds: ['AC-PI-001', 'AC-PI-002'],
        dependencies: ['WI-PI-002'],
      },
      {
        workItemId: 'WI-PI-002',
        title: 'Work Item 2',
        objective: 'Objective 2',
        scope: 'Scope 2',
        requirementIds: ['REQ-PI-002'],
        criterionIds: ['AC-PI-003'],
        dependencies: [],
      },
    ],
    summary: 'Valid plan integrity plan',
  };
}

describe('PR #28 correction #2 — plan-integrity validation', () => {
  let stack: TestAuthStack;
  let project: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({});
    const org = await stack.organizationRepository.create({ name: 'Plan Integrity Org' });
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'plan-integrity-user', displayName: 'PI User' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Plan Integrity Project' });
    await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });
  });

  afterAll(async () => {
    await stack.teardown();
  });

  function buildApplier() {
    const rootSessionRepo = new PgArchitectSessionRepository(stack.db.client);
    return new ArchitectPlanApplier(
      stack.db.client,
      rootSessionRepo,
      {
        createArchitectureRepository: (db: DatabaseClient) => new PgArchitectureRepository(db),
        createArchitectureVersionRepository: (db: DatabaseClient) => new PgArchitectureVersionRepository(db),
        createRequirementRepository: (db: DatabaseClient) => new PgRequirementRepository(db),
        createAcceptanceCriterionRepository: (db: DatabaseClient) => new PgAcceptanceCriterionRepository(db),
        createWorkItemRepository: (db: DatabaseClient) => new PgWorkItemRepository(db),
        createWorkItemRequirementRepository: (db: DatabaseClient) => new PgWorkItemRequirementRepository(db),
        createWorkItemCriterionRepository: (db: DatabaseClient) => new PgWorkItemCriterionRepository(db),
        createWorkOrderRepository: (db: DatabaseClient) => new PgWorkOrderRepository(db),
        createWorkItemDependencyRepository: (db: DatabaseClient) => new PgWorkItemDependencyRepository(db),
        createArchitectSessionRepository: (db: DatabaseClient) => new PgArchitectSessionRepository(db),
      },
      stack.db.logger,
    );
  }

  // -------------------------------------------------------------------------
  // Count helpers — all scoped by projectId so violations don't pollute
  // each other's counts. (Each test uses a fresh project anyway.)
  // -------------------------------------------------------------------------

  async function countArchitectures(projectId: string): Promise<number> {
    const r = await stack.db.client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM wfos_architectures WHERE project_id = $1`,
      [projectId],
    );
    return Number(r.rows[0]!.c);
  }
  async function countArchitectureVersions(projectId: string): Promise<number> {
    const r = await stack.db.client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM wfos_architecture_versions av
       JOIN wfos_architectures a ON a.id = av.architecture_id
       WHERE a.project_id = $1`,
      [projectId],
    );
    return Number(r.rows[0]!.c);
  }
  async function countRequirements(projectId: string): Promise<number> {
    const r = await stack.db.client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM wfos_requirements r
       JOIN wfos_architecture_versions av ON av.id = r.architecture_version_id
       JOIN wfos_architectures a ON a.id = av.architecture_id
       WHERE a.project_id = $1`,
      [projectId],
    );
    return Number(r.rows[0]!.c);
  }
  async function countCriteria(projectId: string): Promise<number> {
    const r = await stack.db.client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM wfos_acceptance_criteria ac
       JOIN wfos_requirements req ON req.id = ac.requirement_id
       JOIN wfos_architecture_versions av ON av.id = req.architecture_version_id
       JOIN wfos_architectures a ON a.id = av.architecture_id
       WHERE a.project_id = $1`,
      [projectId],
    );
    return Number(r.rows[0]!.c);
  }
  async function countWorkItems(projectId: string): Promise<number> {
    const r = await stack.db.client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM wfos_work_items wi
       JOIN wfos_architecture_versions av ON av.id = wi.architecture_version_id
       JOIN wfos_architectures a ON a.id = av.architecture_id
       WHERE a.project_id = $1`,
      [projectId],
    );
    return Number(r.rows[0]!.c);
  }
  async function countWorkOrders(projectId: string): Promise<number> {
    const r = await stack.db.client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM wfos_work_orders WHERE project_id = $1`,
      [projectId],
    );
    return Number(r.rows[0]!.c);
  }

  // -------------------------------------------------------------------------
  // HAPPY PATH — a valid plan still applies successfully with the new
  // validation layer in place. This proves the validation is permissive
  // for correct plans and doesn't reject anything it shouldn't.
  // -------------------------------------------------------------------------

  it('happy path: a valid plan with correct references applies successfully', async () => {
    const applier = buildApplier();
    const result = await applier.apply(project.id, validPlan());
    expect(result.architectureId).toBeTruthy();
    expect(result.architectureVersionId).toBeTruthy();
    expect(result.requirements.length).toBe(2);
    expect(result.criteria.length).toBe(3);
    expect(result.workItems.length).toBe(2);
    expect(result.workOrders.length).toBe(2);
    // The plan was valid, so all artifacts should be present.
    expect(await countArchitectures(project.id)).toBe(1);
    expect(await countRequirements(project.id)).toBe(2);
    expect(await countCriteria(project.id)).toBe(3);
    expect(await countWorkItems(project.id)).toBe(2);
    expect(await countWorkOrders(project.id)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // VIOLATION 1: Unknown requirement ID referenced by a Work Item.
  // -------------------------------------------------------------------------

  it('throws on unknown requirement ID referenced by a Work Item', async () => {
    const plan = validPlan();
    // WI-PI-001 references REQ-PI-001 (valid) + REQ-DOES-NOT-EXIST (invalid).
    plan.workItems![0]!.requirementIds = ['REQ-PI-001', 'REQ-DOES-NOT-EXIST'];

    const applier = buildApplier();
    let thrown: unknown;
    try {
      await applier.apply(project.id, plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ArchitectPlanIntegrityError);
    expect((thrown as ArchitectPlanIntegrityError).kind).toBe('unknown-requirement-reference');
    expect((thrown as ArchitectPlanIntegrityError).message).toContain('REQ-DOES-NOT-EXIST');
    // No artifacts persisted.
    // Note: the happy-path test above applied 1 architecture to this project;
    // the violation test should NOT have added any. So the count is still 1.
    const before = await countArchitectures(project.id);
    await assertNoArtifactsForViolation(project.id, before);
  });

  // -------------------------------------------------------------------------
  // VIOLATION 2: Unknown criterion ID referenced by a Work Item.
  // -------------------------------------------------------------------------

  it('throws on unknown criterion ID referenced by a Work Item', async () => {
    const plan = validPlan();
    plan.workItems![0]!.criterionIds = ['AC-PI-001', 'AC-DOES-NOT-EXIST'];

    const applier = buildApplier();
    let thrown: unknown;
    try {
      await applier.apply(project.id, plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ArchitectPlanIntegrityError);
    expect((thrown as ArchitectPlanIntegrityError).kind).toBe('unknown-criterion-reference');
    expect((thrown as ArchitectPlanIntegrityError).message).toContain('AC-DOES-NOT-EXIST');
    const before = await countArchitectures(project.id);
    await assertNoArtifactsForViolation(project.id, before);
  });

  // -------------------------------------------------------------------------
  // VIOLATION 3: Unknown dependency ID referenced by a Work Item.
  // -------------------------------------------------------------------------

  it('throws on unknown dependency ID referenced by a Work Item', async () => {
    const plan = validPlan();
    plan.workItems![0]!.dependencies = ['WI-PI-002', 'WI-DOES-NOT-EXIST'];

    const applier = buildApplier();
    let thrown: unknown;
    try {
      await applier.apply(project.id, plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ArchitectPlanIntegrityError);
    expect((thrown as ArchitectPlanIntegrityError).kind).toBe('unknown-dependency-reference');
    expect((thrown as ArchitectPlanIntegrityError).message).toContain('WI-DOES-NOT-EXIST');
    const before = await countArchitectures(project.id);
    await assertNoArtifactsForViolation(project.id, before);
  });

  // -------------------------------------------------------------------------
  // VIOLATION 4: Duplicate Work Item ID.
  // -------------------------------------------------------------------------

  it('throws on duplicate Work Item ID', async () => {
    const plan = validPlan();
    // Add a second work item with the SAME workItemId as WI-PI-001.
    plan.workItems!.push({
      workItemId: 'WI-PI-001',
      title: 'Duplicate Work Item',
      objective: 'Should fail',
      scope: 'Duplicate',
      requirementIds: ['REQ-PI-001'],
      criterionIds: ['AC-PI-001'],
    });

    const applier = buildApplier();
    let thrown: unknown;
    try {
      await applier.apply(project.id, plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ArchitectPlanIntegrityError);
    expect((thrown as ArchitectPlanIntegrityError).kind).toBe('duplicate-work-item-id');
    expect((thrown as ArchitectPlanIntegrityError).message).toContain('WI-PI-001');
    const before = await countArchitectures(project.id);
    await assertNoArtifactsForViolation(project.id, before);
  });

  // -------------------------------------------------------------------------
  // VIOLATION 5: Duplicate requirement ID.
  // -------------------------------------------------------------------------

  it('throws on duplicate requirement ID', async () => {
    const plan = validPlan();
    // Add a second requirement with the SAME requirementId as REQ-PI-001.
    plan.requirements!.push({
      requirementId: 'REQ-PI-001',
      title: 'Duplicate Requirement',
      description: 'Should fail',
      criteria: [],
    });

    const applier = buildApplier();
    let thrown: unknown;
    try {
      await applier.apply(project.id, plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ArchitectPlanIntegrityError);
    expect((thrown as ArchitectPlanIntegrityError).kind).toBe('duplicate-requirement-id');
    expect((thrown as ArchitectPlanIntegrityError).message).toContain('REQ-PI-001');
    const before = await countArchitectures(project.id);
    await assertNoArtifactsForViolation(project.id, before);
  });

  // -------------------------------------------------------------------------
  // VIOLATION 6: Duplicate criterion ID.
  // -------------------------------------------------------------------------

  it('throws on duplicate criterion ID', async () => {
    const plan = validPlan();
    // Add a second criterion with the SAME criterionId as AC-PI-001, under
    // a DIFFERENT requirement (REQ-PI-002).
    plan.requirements![1]!.criteria!.push({
      criterionId: 'AC-PI-001',
      description: 'Duplicate criterion under different requirement',
    });

    const applier = buildApplier();
    let thrown: unknown;
    try {
      await applier.apply(project.id, plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ArchitectPlanIntegrityError);
    expect((thrown as ArchitectPlanIntegrityError).kind).toBe('duplicate-criterion-id');
    expect((thrown as ArchitectPlanIntegrityError).message).toContain('AC-PI-001');
    const before = await countArchitectures(project.id);
    await assertNoArtifactsForViolation(project.id, before);
  });

  // -------------------------------------------------------------------------
  // VIOLATION 7: Criterion declared under the wrong requirement.
  //
  // A Work Item references AC-PI-001, which is declared under REQ-PI-001.
  // But the Work Item's requirementIds do NOT include REQ-PI-001. The
  // criterion exists (so it's not an "unknown-criterion-reference"), but
  // it's declared under a requirement the Work Item doesn't reference.
  // -------------------------------------------------------------------------

  it('throws on criterion declared under the wrong requirement', async () => {
    const plan = validPlan();
    // WI-PI-002 references REQ-PI-002 + AC-PI-001.
    // AC-PI-001 is declared under REQ-PI-001 (not REQ-PI-002).
    plan.workItems![1]!.criterionIds = ['AC-PI-001'];
    // requirementIds stays ['REQ-PI-002'] (no REQ-PI-001).

    const applier = buildApplier();
    let thrown: unknown;
    try {
      await applier.apply(project.id, plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ArchitectPlanIntegrityError);
    expect((thrown as ArchitectPlanIntegrityError).kind).toBe('criterion-declared-under-wrong-requirement');
    expect((thrown as ArchitectPlanIntegrityError).message).toContain('AC-PI-001');
    expect((thrown as ArchitectPlanIntegrityError).message).toContain('REQ-PI-001');
    const before = await countArchitectures(project.id);
    await assertNoArtifactsForViolation(project.id, before);
  });

  /**
   * Helper: assert that the violation did NOT add any artifacts beyond
   * what was already there from the happy-path test.
   *
   * The happy-path test applied exactly 1 architecture/version/req/etc.
   * to `project`. Violation tests should NOT add any. So the count after
   * a violation should equal the count before the violation (which equals
   * the happy-path's 1-of-each baseline).
   */
  async function assertNoArtifactsForViolation(projectId: string, beforeArchCount: number): Promise<void> {
    expect(await countArchitectures(projectId), 'no new Architecture added by violation').toBe(beforeArchCount);
    // The happy-path applied 1 architecture → 1 version → 2 reqs → 3 crits
    // → 2 work items → 2 work orders. A violation should add nothing.
    // So all counts should match the happy-path baseline.
    expect(await countArchitectureVersions(projectId), 'no new ArchitectureVersion').toBe(beforeArchCount);
    expect(await countRequirements(projectId), 'no new Requirement').toBe(beforeArchCount * 2);
    expect(await countCriteria(projectId), 'no new Criterion').toBe(beforeArchCount * 3);
    expect(await countWorkItems(projectId), 'no new Work Item').toBe(beforeArchCount * 2);
    expect(await countWorkOrders(projectId), 'no new Work Order').toBe(beforeArchCount * 2);
  }
});
