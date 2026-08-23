import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { ArchitectPlanApplier } from '../../../src/modules/llm/internal/architect-plan-applier.js';
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
import type {
  ArchitectSession,
  ArchitectSessionRepository,
  ArchitectMessage,
  ArchitectRevision,
  ArchitectParsedPlan,
} from '@modules/llm/index.js';
import type { DatabaseClient } from '@platform/index.js';

/**
 * PR #28 regression — Architect session acceptance MUST be inside the
 * same database transaction as the plan-artifact writes (Architecture,
 * ArchitectureVersion, Requirements, Criteria, Work Items, associations,
 * dependencies, Work Orders).
 *
 * Before the fix, the applier ran:
 *
 *     await db.transaction(...)              // plan writes
 *     await sessionRepository.findActiveByProject(...)
 *     await sessionRepository.markAccepted(...)  // OUTSIDE the tx
 *
 * This left a window where the plan could commit successfully while
 * session acceptance failed — a partial-state violation.
 *
 * After the fix, the applier constructs a transaction-scoped
 * ArchitectSessionRepository via `factories.createArchitectSessionRepository(txClient)`
 * and calls `markAccepted` BEFORE the transaction commits. Any failure in
 * `markAccepted` rolls back the entire transaction.
 *
 * This file proves both directions:
 *   1. SUCCESS PATH: the session is accepted inside the same transaction.
 *   2. REGRESSION PATH: a deliberate `markAccepted` failure rolls back ALL
 *      plan artifacts (Architecture, ArchitectureVersion, Requirement,
 *      Criterion, Work Item, association, dependency, Work Order) AND
 *      leaves the session in `active` status.
 */

/**
 * A wrapping ArchitectSessionRepository that delegates to the real
 * PgArchitectSessionRepository but can be configured to throw on
 * `markAccepted`. Because the applier constructs its transaction-scoped
 * session repository via the factory, this wrapper is what the factory
 * returns — so the failure happens INSIDE the db.transaction callback.
 */
class FailingArchitectSessionRepository implements ArchitectSessionRepository {
  constructor(
    private readonly inner: ArchitectSessionRepository,
    private readonly shouldFailAccept: () => boolean,
    public readonly markAcceptedCalls: { sessionId: string; timestamp: number }[] = [],
  ) {}

  findActiveByProject(projectId: string): Promise<ArchitectSession | null> {
    return this.inner.findActiveByProject(projectId);
  }
  create(input: { projectId: string; provider: string; model: string }): Promise<ArchitectSession> {
    return this.inner.create(input);
  }
  updateMessages(
    sessionId: string,
    messages: ArchitectMessage[],
    parsedPlan: ArchitectParsedPlan | null,
  ): Promise<void> {
    return this.inner.updateMessages(sessionId, messages, parsedPlan);
  }
  saveRevision(input: {
    sessionId: string;
    revisionNumber: number;
    userPrompt: string;
    architectResponse: string;
    parsedPlan: ArchitectParsedPlan | null;
  }): Promise<ArchitectRevision> {
    return this.inner.saveRevision(input);
  }
  listRevisions(sessionId: string): Promise<ArchitectRevision[]> {
    return this.inner.listRevisions(sessionId);
  }
  async markAccepted(sessionId: string): Promise<void> {
    this.markAcceptedCalls.push({ sessionId, timestamp: Date.now() });
    if (this.shouldFailAccept()) {
      throw new Error('intentional markAccepted failure for regression test');
    }
    await this.inner.markAccepted(sessionId);
  }
}

function samplePlan(): ArchitectParsedPlan {
  return {
    architecture: { name: 'Atomic Apply Arch', content: 'Constraints for atomic apply' },
    requirements: [
      {
        requirementId: 'REQ-ATOMIC-001',
        title: 'Atomic requirement',
        description: 'Proves transaction rollback',
        criteria: [
          { criterionId: 'AC-ATOMIC-001', description: 'No partial state after failure' },
        ],
      },
    ],
    workItems: [
      {
        workItemId: 'WI-ATOMIC-001',
        title: 'Atomic work item (depends on WI-ATOMIC-002)',
        objective: 'Implement atomic apply',
        scope: 'Backend transaction',
        requirementIds: ['REQ-ATOMIC-001'],
        criterionIds: ['AC-ATOMIC-001'],
        dependencies: ['WI-ATOMIC-002'],
      },
      {
        workItemId: 'WI-ATOMIC-002',
        title: 'Atomic work item 2 (dependency target)',
        objective: 'Dependency target',
        scope: 'Backend transaction',
        dependencies: [],
      },
    ],
    summary: 'Atomic apply regression plan',
  };
}

describe('PR #28 regression — Architect session acceptance atomicity', () => {
  let stack: TestAuthStack;
  let projectA: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({});
    const orgA = await stack.organizationRepository.create({ name: 'Atomic Apply Org' });
    const userA = await stack.userRepository.upsertByExternalId({ externalId: 'atomic-user', displayName: 'Atomic User' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Atomic Apply Project' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
  });

  afterAll(async () => {
    await stack.teardown();
  });

  /**
   * Build an ArchitectPlanApplier whose transaction-scoped session repo
   * factory returns a FailingArchitectSessionRepository. The wrapper
   * delegates to the real PgArchitectSessionRepository for everything
   * except markAccepted, which it can be told to throw.
   *
   * The root session repository (used for the pre-tx findActiveByProject
   * lookup) is the real PgArchitectSessionRepository — we don't want it
   * to throw on read.
   */
  function buildApplier(shouldFailAccept: () => boolean, captures: { sessionId: string; timestamp: number }[]) {
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
        createArchitectSessionRepository: (db: DatabaseClient) =>
          new FailingArchitectSessionRepository(new PgArchitectSessionRepository(db), shouldFailAccept, captures),
      },
      stack.db.logger,
    );
  }

  // -------------------------------------------------------------------------
  // Count helpers — all scoped by projectId so the success-path artifacts
  // in projectA don't pollute the regression-path counts in projectB.
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

  async function countWorkItemRequirements(projectId: string): Promise<number> {
    const r = await stack.db.client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM wfos_work_item_requirements wir
       JOIN wfos_work_items wi ON wi.id = wir.work_item_id
       JOIN wfos_architecture_versions av ON av.id = wi.architecture_version_id
       JOIN wfos_architectures a ON a.id = av.architecture_id
       WHERE a.project_id = $1`,
      [projectId],
    );
    return Number(r.rows[0]!.c);
  }

  async function countWorkItemCriteria(projectId: string): Promise<number> {
    const r = await stack.db.client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM wfos_work_item_criteria wic
       JOIN wfos_work_items wi ON wi.id = wic.work_item_id
       JOIN wfos_architecture_versions av ON av.id = wi.architecture_version_id
       JOIN wfos_architectures a ON a.id = av.architecture_id
       WHERE a.project_id = $1`,
      [projectId],
    );
    return Number(r.rows[0]!.c);
  }

  async function countWorkItemDependencies(projectId: string): Promise<number> {
    // The dependencies table uses columns (work_item_id, depends_on_id).
    const r = await stack.db.client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM wfos_work_item_dependencies wid
       JOIN wfos_work_items wi ON wi.id = wid.work_item_id
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

  async function countActiveSessions(projectId: string): Promise<number> {
    const r = await stack.db.client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM wfos_architect_sessions WHERE project_id = $1 AND status = 'active'`,
      [projectId],
    );
    return Number(r.rows[0]!.c);
  }

  async function fetchSessionStatus(projectId: string): Promise<string | null> {
    const r = await stack.db.client.query<{ status: string }>(
      `SELECT status FROM wfos_architect_sessions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    if (r.rows.length === 0) return null;
    return r.rows[0]!.status;
  }

  // -------------------------------------------------------------------------
  // SUCCESS PATH: session becomes accepted inside the same transaction.
  // -------------------------------------------------------------------------

  it('success path: marks the active Architect session accepted inside the same transaction', async () => {
    // Create an active session for the project.
    const sessionRepo = new PgArchitectSessionRepository(stack.db.client);
    const session = await sessionRepo.create({
      projectId: projectA.id,
      provider: 'fake',
      model: 'test-model',
    });
    expect(session.status).toBe('active');

    // Apply a plan. The applier should accept the session inside the tx.
    const captures: { sessionId: string; timestamp: number }[] = [];
    const applier = buildApplier(() => false, captures);
    const result = await applier.apply(projectA.id, samplePlan());

    // The applier must report the accepted session id back to the caller.
    expect(result.acceptedSessionIds).toEqual([session.id]);

    // markAccepted must have been called exactly once — proving the
    // transaction-scoped session repo was used (not the root one).
    expect(captures.length).toBe(1);
    expect(captures[0]!.sessionId).toBe(session.id);

    // The session status must now be 'accepted' in the database.
    const status = await fetchSessionStatus(projectA.id);
    expect(status).toBe('accepted');

    // And the plan artifacts must be present (architecture created).
    expect(result.architectureId).toBeTruthy();
    expect(result.architectureVersionId).toBeTruthy();
    expect(result.requirements.length).toBe(1);
    expect(result.criteria.length).toBe(1);
    expect(result.workItems.length).toBe(2);
    expect(result.workOrders.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // REGRESSION PATH: deliberate session-acceptance failure rolls back
  // EVERYTHING (plan artifacts + session stays active).
  // -------------------------------------------------------------------------

  it('regression: deliberate markAccepted failure rolls back all plan artifacts and leaves the session active', async () => {
    // Use a SEPARATE project so the success-path artifacts above don't
    // pollute the counts. Counts in this test are scoped by project_id.
    const orgB = await stack.organizationRepository.create({ name: 'Atomic Apply Org B' });
    const userB = await stack.userRepository.upsertByExternalId({ externalId: 'atomic-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Atomic Apply Project B' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });

    // Create an active session for projectB.
    const sessionRepo = new PgArchitectSessionRepository(stack.db.client);
    const session = await sessionRepo.create({
      projectId: projectB.id,
      provider: 'fake',
      model: 'test-model',
    });
    expect(session.status).toBe('active');

    // Capture baseline counts (projectB should be empty for all artifact tables).
    const baseline = {
      architectures: await countArchitectures(projectB.id),
      architectureVersions: await countArchitectureVersions(projectB.id),
      requirements: await countRequirements(projectB.id),
      criteria: await countCriteria(projectB.id),
      workItems: await countWorkItems(projectB.id),
      workItemRequirements: await countWorkItemRequirements(projectB.id),
      workItemCriteria: await countWorkItemCriteria(projectB.id),
      workItemDependencies: await countWorkItemDependencies(projectB.id),
      workOrders: await countWorkOrders(projectB.id),
    };

    // Apply the plan with a session repo that throws on markAccepted.
    const captures: { sessionId: string; timestamp: number }[] = [];
    const applier = buildApplier(() => true, captures); // FAIL on accept

    await expect(applier.apply(projectB.id, samplePlan())).rejects.toThrow(
      'intentional markAccepted failure for regression test',
    );

    // markAccepted must have been called (proving the transaction-scoped
    // session repo was used), and it must have thrown.
    expect(captures.length).toBe(1);
    expect(captures[0]!.sessionId).toBe(session.id);

    // --- ASSERT: no plan artifacts remain (transaction rolled back) ---

    expect(await countArchitectures(projectB.id), 'no Architecture remains').toBe(baseline.architectures);
    expect(await countArchitectureVersions(projectB.id), 'no ArchitectureVersion remains').toBe(baseline.architectureVersions);
    expect(await countRequirements(projectB.id), 'no Requirement remains').toBe(baseline.requirements);
    expect(await countCriteria(projectB.id), 'no Criterion remains').toBe(baseline.criteria);
    expect(await countWorkItems(projectB.id), 'no Work Item remains').toBe(baseline.workItems);
    expect(await countWorkItemRequirements(projectB.id), 'no Work Item ↔ Requirement association remains').toBe(baseline.workItemRequirements);
    expect(await countWorkItemCriteria(projectB.id), 'no Work Item ↔ Criterion association remains').toBe(baseline.workItemCriteria);
    expect(await countWorkItemDependencies(projectB.id), 'no Work Item dependency remains').toBe(baseline.workItemDependencies);
    expect(await countWorkOrders(projectB.id), 'no Work Order remains').toBe(baseline.workOrders);

    // --- ASSERT: Architect session remains ACTIVE ---
    const activeCount = await countActiveSessions(projectB.id);
    expect(activeCount, 'Architect session remains active after rollback').toBe(1);

    const status = await fetchSessionStatus(projectB.id);
    expect(status, 'Architect session status is still active (not accepted)').toBe('active');
  });
});
