/**
 * WORK-040 — the planner database-level concurrency fence: REAL PostgreSQL
 * concurrency regression.
 *
 * The planner's dedup is the EXISTING UNIQUE(architecture_version_id,
 * work_item_id) DB constraint on wfos_work_items + the deterministic
 * proposedWorkItemId. Two CONCURRENT planner.evaluate calls for the SAME
 * signal (same proposedWorkItemId) race: both load the (empty) dedup map, both
 * fire workItemRepository.create. PostgreSQL's unique constraint serializes:
 * one INSERT succeeds ('created'); the other throws a unique-violation (23505)
 * → the orchestrator catches + re-queries + converges ('already-exists'). The
 * net result: exactly ONE Work Item (no duplicate).
 *
 * This file proves the fence is REAL by exercising TWO concurrent `pg.Client`
 * connections against the same schema (the createSecondClient test harness). A
 * single-threaded pglite run CANNOT demonstrate true concurrent INSERT racing
 * (the WASM runtime serializes all statements). The suite SKIPS on pglite — it
 * runs only when `WORKFLOWOS_DATABASE_URL` is set (CI / a real postgres service).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgWorkItemRepository } from '../../../src/modules/work-items/internal/pg-work-item-repository.js';
import { DefaultDevelopmentPlannerService } from '../../../src/development-planner/internal/default-development-planner-service.js';
import { DeterministicPlanningPrioritizer, computeProposedWorkItemId } from '../../../src/development-planner/internal/deterministic-planning-prioritizer.js';
import type { PlanningContext, PlanningSignal } from '@development-planner/index.js';
import { createLogger } from '@platform/logger.js';
import { CaptureStream } from '../../helpers/capture-stream.js';

const isRealPg =
  !!process.env.WORKFLOWOS_DATABASE_URL &&
  process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

describe.skipIf(!isRealPg)(
  'WORK-040 — planner concurrency fence (real PostgreSQL)',
  () => {
    let stack: TestAuthStack;
    let versionId: string;
    let projectId: string;
    let ctxT1: PlanningContext;
    let ctxT2: PlanningContext;
    // T2's second independent client (closed on teardown).
    let secondClient: { close: () => Promise<void> } | undefined;
    const capture = new CaptureStream();

    beforeAll(async () => {
      stack = await buildAuthStack();
      const org = await stack.organizationRepository.create({ name: 'DP Concurrency Org' });
      const user = await stack.userRepository.upsertByExternalId({ externalId: 'dp-concurrency-user', displayName: 'Concurrency User' });
      await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
      const project = await stack.projectRepository.create({ organizationId: org.id, name: 'DP Concurrency Project' });
      await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });
      projectId = project.id;
      const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'DP Concurrency Arch' });
      const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
      await stack.architectureVersionRepository.transitionState(version.id, 'frozen', user.id);
      versionId = version.id;

      const logger = createLogger({ level: 'info', destination: capture });
      // T1 uses the main test client's workItemRepository.
      const repoT1 = stack.workItemRepository;
      // T2 uses a SECOND independent pg.Client against the SAME test schema.
      // T2's create races T1's create on the unique constraint.
      const second = await stack.db.createSecondClient!();
      const repoT2 = new PgWorkItemRepository(second.client);
      secondClient = second;

      ctxT1 = {
        organizationId: org.id,
        projectId: project.id,
        workItemRepository: repoT1,
        workItemDependencyRepository: stack.workItemDependencyRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureRepository: stack.architectureRepository,
        requirementRepository: stack.requirementRepository,
        acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
        logger,
      };
      ctxT2 = {
        organizationId: org.id,
        projectId: project.id,
        workItemRepository: repoT2,
        workItemDependencyRepository: stack.workItemDependencyRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureRepository: stack.architectureRepository,
        requirementRepository: stack.requirementRepository,
        acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
        logger,
      };
    });

    afterAll(async () => {
      if (secondClient) await secondClient.close();
      await stack.teardown();
    });

    it('two concurrent planner.evaluate calls for the SAME signal converge to ONE Work Item (the DB unique constraint fences the race)', async () => {
      const goal = 'Real-PG concurrent planner convergence';
      const signal: PlanningSignal = {
        kind: 'developer-request',
        canonicalGoal: goal,
        provenance: 'proposed',
      };
      const proposedId = computeProposedWorkItemId(goal);
      const plannerT1 = new DefaultDevelopmentPlannerService({
        prioritizer: new DeterministicPlanningPrioritizer(),
        logger: createLogger({ level: 'info', destination: capture }),
      });
      const plannerT2 = new DefaultDevelopmentPlannerService({
        prioritizer: new DeterministicPlanningPrioritizer(),
        logger: createLogger({ level: 'info', destination: capture }),
      });
      // Fire both evaluates CONCURRENTLY — they race on the same proposedId.
      const [r1, r2] = await Promise.all([
        plannerT1.evaluate(
          { projectId, architectureVersionId: versionId, signals: [signal] },
          ctxT1,
        ),
        plannerT2.evaluate(
          { projectId, architectureVersionId: versionId, signals: [signal] },
          ctxT2,
        ),
      ]);
      // Exactly ONE created + ONE already-exists (the loser caught the
      // unique-violation + re-queried + converged). Order is non-deterministic.
      const created = [r1, r2].filter((r) => r.createdCount === 1);
      const converged = [r1, r2].filter((r) => r.alreadyExistsCount === 1);
      expect(created.length, 'exactly one planner created the Work Item').toBe(1);
      expect(converged.length, 'exactly one planner converged (already-exists)').toBe(1);
      // The created + the converged point at the SAME Work Item id.
      const createdRec = created[0]!.recommendations[0]!;
      const convergedRec = converged[0]!.recommendations[0]!;
      expect(convergedRec.status).toBe('already-exists');
      expect(convergedRec.workItemId).toBe(createdRec.workItemId);
      // Exactly ONE row in the database for this proposedId (no duplicate).
      const all = await stack.workItemRepository.findByArchitectureVersion(versionId);
      const matches = all.filter((w) => w.workItemId === proposedId);
      expect(matches.length, 'exactly one Work Item row (the DB constraint fenced the race)').toBe(1);
    });
  },
);
