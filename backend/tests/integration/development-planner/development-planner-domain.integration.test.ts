/**
 * WORK-040: Continuous Development Planner — integration coverage of the 16
 * frozen WORK-040 regression requirements.
 *
 * The test wires the REAL development-planner orchestrator
 * (DefaultDevelopmentPlannerService) + the REAL deterministic prioritizer
 * (DeterministicPlanningPrioritizer) on top of a real PostgreSQL test database
 * (pglite locally / real pg in CI). The architecture version + project are
 * produced by the REAL /architecture + /projects authorities. The planner
 * CREATES Work Items through the REAL /work-items WorkItemRepository.create
 * (the single creation path) — no fake creation path.
 *
 * The 16 regressions:
 *  1. deterministic planning (same signals → same proposedWorkItemId → same Work Item)
 *  2. duplicate planning convergence (re-evaluate → 'already-exists', no new row)
 *  3. concurrent planner invocations (simulated unique-violation → catch + re-query → converge)
 *  4. existing equivalent Work Item detection (pre-existing same workItemId → 'already-exists')
 *  5. dependency-aware ordering (signal with relatedWorkItemIds → candidate cites the chain)
 *  6. provenance preservation (recommendation provenance = signal's, never 'confirmed')
 *  7. explainable reasons (priorityFactors + rationale + whyNow present + non-empty)
 *  8. tenant isolation (planner rejects a version from a different project)
 *  9. revision-bound context (metadata.planner.baselineCommitSha = input's)
 * 10. planner failure creates no false Work Items (create throws → 'evaluation-failed', no row)
 * 11. planner never bypasses workflow (no workflow state record created for the Work Item)
 * 12. planner never bypasses execution policy (no execution record created)
 * 13. GET does not mutate authoritative state (the GET route creates nothing)
 * 14. crash/retry behavior — covered in planner-job-crash-retry.regression.test.ts
 * 15. developer-request + planner convergence (same goal → one Work Item)
 * 16. completed-work + planner convergence (same goal → one Work Item)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import { DefaultDevelopmentPlannerService } from '../../../src/development-planner/internal/default-development-planner-service.js';
import { DeterministicPlanningPrioritizer, computeProposedWorkItemId } from '../../../src/development-planner/internal/deterministic-planning-prioritizer.js';
import type {
  PlanningContext,
  PlanningEvaluateInput,
  PlanningSignal,
  WorkItemRepository,
} from '@development-planner/index.js';
import type { WorkItem, CreateWorkItemInput, UpdateWorkItemInput } from '@modules/work-items/index.js';
import { createLogger } from '@platform/logger.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import { InMemoryQueue } from '@platform/index.js';
import { WorkerHost } from '@platform/worker/worker-host.js';
import { PlanningEvaluateJobHandler } from '../../../src/development-planner/internal/planning-evaluate-job-handler.js';

/**
 * A WorkItemRepository wrapper that can simulate a create failure (for
 * regression #10) OR a concurrent-create unique-violation (for regression #3).
 * It delegates read methods to the real repo so the dedup map + re-query work
 * against the real persistence.
 */
class InterceptableWorkItemRepository implements WorkItemRepository {
  constructor(
    private readonly real: WorkItemRepository,
    private readonly onCreate?: (input: CreateWorkItemInput) => Promise<void>,
  ) {}
  async create(input: CreateWorkItemInput): Promise<WorkItem> {
    if (this.onCreate) await this.onCreate(input);
    return this.real.create(input);
  }
  async findById(id: string): Promise<WorkItem | null> {
    return this.real.findById(id);
  }
  async findByArchitectureVersion(architectureVersionId: string): Promise<WorkItem[]> {
    return this.real.findByArchitectureVersion(architectureVersionId);
  }
  async update(id: string, input: UpdateWorkItemInput): Promise<WorkItem | null> {
    return this.real.update(id, input);
  }
}

describe('WORK-040 — Continuous Development Planner (16 frozen regressions)', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let userA: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let versionA: { id: string };
  let versionB: { id: string };
  let planner: DefaultDevelopmentPlannerService;
  let ctxA: PlanningContext;
  const capture = new CaptureStream();

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-dp-a',
    });
    const orgA = await stack.organizationRepository.create({ name: 'DP Org A' });
    const orgB = await stack.organizationRepository.create({ name: 'DP Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'dp-user-a', displayName: 'User A' });
    const userB = await stack.userRepository.upsertByExternalId({ externalId: 'dp-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'DP Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'DP Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'dp-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'dp-user-a', label: 'User A', rawKey: 'raw-key-dp-a',
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'DP Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);

    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'DP Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    const logger = createLogger({ level: 'info', destination: capture });
    planner = new DefaultDevelopmentPlannerService({
      prioritizer: new DeterministicPlanningPrioritizer(),
      logger,
    });
    ctxA = {
      organizationId: orgA.id,
      projectId: projectA.id,
      workItemRepository: stack.workItemRepository,
      workItemDependencyRepository: stack.workItemDependencyRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      requirementRepository: stack.requirementRepository,
      acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
      logger,
    };

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      architecture: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureDecisionRepository: stack.architectureDecisionRepository,
        architectureChangeRequestRepository: stack.architectureChangeRequestRepository,
        architectureService: stack.architectureService,
      },
      workItems: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workItemRequirementRepository: stack.workItemRequirementRepository,
        workItemCriterionRepository: stack.workItemCriterionRepository,
        workItemDependencyRepository: stack.workItemDependencyRepository,
        pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
        workOrderRepository: stack.workOrderRepository,
      },
      developmentPlanner: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureRepository: stack.architectureRepository,
        requirementRepository: stack.requirementRepository,
        acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
        workItemRepository: stack.workItemRepository,
        workItemDependencyRepository: stack.workItemDependencyRepository,
        plannerService: planner,
        logger: stack.db.logger,
        queue: new InMemoryQueue(),
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  /** A canonical developer-request signal. */
  const devRequestSignal = (goal: string, scope?: string): PlanningSignal => ({
    kind: 'developer-request',
    canonicalGoal: goal,
    scope,
    provenance: 'proposed',
    originator: 'dp-user-a',
  });

  // -------------------------------------------------------------------------
  // 1. deterministic planning
  // -------------------------------------------------------------------------
  it('1. deterministic planning — the same signal always produces the same proposedWorkItemId + the same Work Item', async () => {
    const goal = 'Refactor the OAuth refresh token flow';
    const signal = devRequestSignal(goal, 'src/auth/refresh.ts');
    const result = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [signal] },
      ctxA,
    );
    expect(result.createdCount).toBe(1);
    const rec = result.recommendations[0]!;
    expect(rec.status).toBe('created');
    const expectedId = computeProposedWorkItemId(goal, 'src/auth/refresh.ts');
    expect(rec.workItemHumanId).toBe(expectedId);
    // Re-run with the SAME signal → converges (regression #2 below also covers this).
    const result2 = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [signal] },
      ctxA,
    );
    expect(result2.recommendations[0]!.status).toBe('already-exists');
    expect(result2.recommendations[0]!.workItemId).toBe(rec.workItemId);
  });

  // -------------------------------------------------------------------------
  // 2. duplicate planning convergence
  // -------------------------------------------------------------------------
  it('2. duplicate planning convergence — re-evaluating the same signals produces NO new Work Item', async () => {
    const goal = 'Add SSO provider integration';
    const signal = devRequestSignal(goal);
    const r1 = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [signal] },
      ctxA,
    );
    expect(r1.createdCount).toBe(1);
    const before = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
    const r2 = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [signal] },
      ctxA,
    );
    expect(r2.createdCount).toBe(0);
    expect(r2.alreadyExistsCount).toBe(1);
    const after = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
    // NO new row was created by the re-evaluation.
    expect(after.length).toBe(before.length);
  });

  // -------------------------------------------------------------------------
  // 3. concurrent planner invocations (simulated unique-violation → catch + re-query → converge)
  // -------------------------------------------------------------------------
  it('3. concurrent planner invocations — a concurrent create (unique-violation) is caught + the planner converges (no duplicate)', async () => {
    const goal = 'Migrate the billing service to typed errors';
    const signal = devRequestSignal(goal);
    const proposedId = computeProposedWorkItemId(goal);
    // Simulate a concurrent insert INSIDE the race window: the dedup map is
    // loaded (no competing row yet), then INSIDE create (before the real
    // INSERT) the hook inserts the competing row → the real create throws a
    // unique-violation (23505) → the orchestrator catches + re-queries →
    // finds the competing row → converges. pglite is single-threaded so this
    // is deterministic; the real-PG parallel concurrency is covered in
    // planner-concurrency.regression.test.ts.
    let raceInserted = false;
    const interceptingRepo = new InterceptableWorkItemRepository(
      stack.workItemRepository,
      async (input) => {
        if (input.workItemId === proposedId && !raceInserted) {
          raceInserted = true;
          await stack.workItemRepository.create({
            architectureVersionId: input.architectureVersionId,
            workItemId: proposedId,
            title: 'Competing concurrent create (race)',
          });
        }
      },
    );
    const ctxIntercept: PlanningContext = { ...ctxA, workItemRepository: interceptingRepo };
    const result = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [signal] },
      ctxIntercept,
    );
    // The orchestrator's create threw a unique-violation → caught → re-queried
    // → converged onto the competing row ('already-exists'). NO duplicate.
    expect(result.createdCount).toBe(0);
    expect(result.alreadyExistsCount).toBe(1);
    expect(result.recommendations[0]!.status).toBe('already-exists');
    // Verify exactly ONE row exists for this proposedId (no duplicate).
    const all = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
    const matches = all.filter((w) => w.workItemId === proposedId);
    expect(matches.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. existing equivalent Work Item detection
  // -------------------------------------------------------------------------
  it('4. existing equivalent Work Item detection — a planner signal whose proposedWorkItemId matches an existing Work Item converges', async () => {
    const goal = 'Extract the notification queue into its own module';
    const proposedId = computeProposedWorkItemId(goal);
    // Pre-create the equivalent Work Item (manually, as if a developer created it).
    await stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: proposedId,
      title: 'Pre-existing equivalent',
    });
    const signal = devRequestSignal(goal);
    const result = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [signal] },
      ctxA,
    );
    expect(result.recommendations[0]!.status).toBe('already-exists');
    expect(result.createdCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. dependency-aware ordering
  // -------------------------------------------------------------------------
  it('5. dependency-aware ordering — a signal with relatedWorkItemIds surfaces the dependency chain in the candidate rationale', async () => {
    // Create a prerequisite Work Item + a dependent Work Item (deps: dependent → prerequisite).
    const prereq = await stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: 'PLAN-PREREQ-1',
      title: 'Prerequisite work item',
    });
    const dependent = await stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: 'PLAN-DEP-1',
      title: 'Dependent work item',
    });
    await stack.workItemDependencyRepository.add(dependent.id, prereq.id);
    // A signal that relates to the dependent item — the prioritizer reads the
    // chain (dependent → prereq) + surfaces it in the rationale.
    const signal: PlanningSignal = {
      kind: 'technical-debt',
      canonicalGoal: 'Pay down the dependent item chain',
      provenance: 'inferred',
      relatedWorkItemIds: [dependent.id],
    };
    const result = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [signal] },
      ctxA,
    );
    expect(result.createdCount).toBe(1);
    const rec = result.recommendations[0]!;
    // The candidate cites the dependency chain.
    expect(rec.candidate.rationale).toMatch(/dependency chain/);
    expect(rec.candidate.proposedDependencies).toContain(dependent.id);
    // A dependency-chain priority factor was recorded.
    expect(rec.candidate.priorityFactors.some((f) => f.kind === 'dependency-chain')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 6. provenance preservation
  // -------------------------------------------------------------------------
  it('6. provenance preservation — the recommendation provenance is the signal provenance (never promoted to confirmed)', async () => {
    const goal = 'Audit the secret rotation path';
    const signal: PlanningSignal = {
      kind: 'architecture-observation',
      canonicalGoal: goal,
      provenance: 'inferred',
    };
    const result = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [signal] },
      ctxA,
    );
    const rec = result.recommendations[0]!;
    expect(rec.candidate.signal.provenance).toBe('inferred');
    // The Work Item's metadata.planner.provenance preserves the signal's
    // provenance VERBATIM (never 'confirmed').
    const wi = await stack.workItemRepository.findById(rec.workItemId!);
    const plannerMeta = (wi!.metadata as { planner?: { provenance?: string } }).planner;
    expect(plannerMeta!.provenance).toBe('inferred');
    expect(plannerMeta!.provenance).not.toBe('confirmed');
  });

  // -------------------------------------------------------------------------
  // 7. explainable reasons
  // -------------------------------------------------------------------------
  it('7. explainable reasons — every candidate carries non-empty priorityFactors + rationale + whyNow', async () => {
    const signal = devRequestSignal('Document the deployment runbook');
    const result = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [signal] },
      ctxA,
    );
    const rec = result.recommendations[0]!;
    expect(rec.candidate.priorityFactors.length).toBeGreaterThan(0);
    expect(rec.candidate.rationale.length).toBeGreaterThan(0);
    expect(rec.candidate.whyNow.length).toBeGreaterThan(0);
    expect(rec.candidate.expectedImpact.length).toBeGreaterThan(0);
    // Every factor has a non-empty detail + a non-negative weight.
    for (const f of rec.candidate.priorityFactors) {
      expect(f.detail.length).toBeGreaterThan(0);
      expect(f.weight).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------------
  // 8. tenant isolation
  // -------------------------------------------------------------------------
  it('8. tenant isolation — the planner rejects a version belonging to a different project', async () => {
    // ctxA is scoped to projectA. versionB belongs to projectB. The planner
    // re-asserts version.architectureId → architecture.projectId === ctx.projectId
    // + rejects (a UUID is NEVER a credential).
    const signal = devRequestSignal('Cross-tenant attempt');
    await expect(
      planner.evaluate(
        { projectId: projectA.id, architectureVersionId: versionB.id, signals: [signal] },
        ctxA,
      ),
    ).rejects.toThrow(/planning-architecture-version-not-in-project/);
  });

  // -------------------------------------------------------------------------
  // 9. revision-bound context
  // -------------------------------------------------------------------------
  it('9. revision-bound context — metadata.planner.baselineCommitSha records the revision the signal was bound to', async () => {
    const baselineCommitSha = 'abc123def456';
    const signal = devRequestSignal('Bind the planning evidence to a revision');
    const result = await planner.evaluate(
      {
        projectId: projectA.id,
        architectureVersionId: versionA.id,
        signals: [signal],
        baselineCommitSha,
      },
      ctxA,
    );
    const rec = result.recommendations[0]!;
    const wi = await stack.workItemRepository.findById(rec.workItemId!);
    const plannerMeta = (wi!.metadata as { planner?: { baselineCommitSha?: string } }).planner;
    expect(plannerMeta!.baselineCommitSha).toBe(baselineCommitSha);
  });

  // -------------------------------------------------------------------------
  // 10. planner failure creates no false Work Items
  // -------------------------------------------------------------------------
  it('10. planner failure creates no false Work Items — a create that throws (non-unique-violation) yields evaluation-failed + no row', async () => {
    const goal = 'A signal whose create will fail';
    const signal = devRequestSignal(goal);
    // Intercept create to throw a generic (non-23505) error.
    const failingRepo = new InterceptableWorkItemRepository(stack.workItemRepository);
    failingRepo.create = async () => {
      throw new Error('simulated-create-failure');
    };
    const ctxFailing: PlanningContext = { ...ctxA, workItemRepository: failingRepo };
    const result = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [signal] },
      ctxFailing,
    );
    expect(result.failedCount).toBe(1);
    expect(result.recommendations[0]!.status).toBe('evaluation-failed');
    expect(result.recommendations[0]!.failureReason).toMatch(/simulated-create-failure/);
    // NO false Work Item landed (the real repo has no row for this proposedId).
    const proposedId = computeProposedWorkItemId(goal);
    const all = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
    expect(all.filter((w) => w.workItemId === proposedId).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 11. planner never bypasses workflow
  // -------------------------------------------------------------------------
  it('11. planner never bypasses workflow — the created Work Item has NO workflow state record (the planner creates only the Work Item row)', async () => {
    const signal = devRequestSignal('Verify no workflow state is created');
    const result = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [signal] },
      ctxA,
    );
    const wiId = result.recommendations[0]!.workItemId!;
    // The Work Item exists.
    const wi = await stack.workItemRepository.findById(wiId);
    expect(wi).not.toBeNull();
    // No workflow execution/state row references this Work Item (the workflow
    // state machine is /workflows authority — the planner does NOT touch it).
    const wfRows = await stack.db.client.query(
      `SELECT id FROM wfos_workflow_executions WHERE work_item_id = $1`,
      [wiId],
    );
    expect(wfRows.rows.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 12. planner never bypasses execution policy
  // -------------------------------------------------------------------------
  it('12. planner never bypasses execution policy — the created Work Item has NO execution record', async () => {
    const signal = devRequestSignal('Verify no execution is started');
    const result = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [signal] },
      ctxA,
    );
    const wiId = result.recommendations[0]!.workItemId!;
    // No execution record references this Work Item (execution is /agents +
    // /execution authority — the planner does NOT start it).
    const execRows = await stack.db.client.query(
      `SELECT id FROM wfos_executions WHERE work_item_id = $1`,
      [wiId],
    );
    expect(execRows.rows.length).toBe(0);
    // No Work Order was created (the Work Order lifecycle is downstream of the
    // planner — /work-items owns it, but the planner does NOT create one).
    const woRows = await stack.db.client.query(
      `SELECT id FROM wfos_work_orders WHERE work_item_id = $1`,
      [wiId],
    );
    expect(woRows.rows.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 13. GET does not mutate authoritative state
  // -------------------------------------------------------------------------
  it('13. GET does not mutate authoritative state — a GET /recommendations call creates NO new Work Items', async () => {
    const before = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectA.id}/planning/recommendations?architectureVersionId=${versionA.id}`,
      headers: { authorization: 'Bearer raw-key-dp-a' },
    });
    expect(res.statusCode).toBe(200);
    const after = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
    // No new rows created by the read.
    expect(after.length).toBe(before.length);
  });

  // -------------------------------------------------------------------------
  // 15. developer-request + planner convergence
  // -------------------------------------------------------------------------
  it('15. developer-request + planner convergence — a developer request + a planner run with the same goal produce ONE Work Item', async () => {
    const goal = 'Developer-requested OAuth refactor convergence';
    // First: a developer-request signal creates the Work Item.
    const r1 = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [devRequestSignal(goal)] },
      ctxA,
    );
    expect(r1.createdCount).toBe(1);
    // Second: a DIFFERENT signal kind with the SAME canonicalGoal converges
    // (the dedup key is goal+scope, not signal kind — the planner detects the
    // equivalent existing item).
    const sameGoalProductSignal: PlanningSignal = {
      kind: 'product-goal',
      canonicalGoal: goal,
      provenance: 'proposed',
    };
    const r2 = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [sameGoalProductSignal] },
      ctxA,
    );
    expect(r2.createdCount).toBe(0);
    expect(r2.alreadyExistsCount).toBe(1);
    expect(r2.recommendations[0]!.workItemId).toBe(r1.recommendations[0]!.workItemId);
  });

  // -------------------------------------------------------------------------
  // 16. completed-work + planner convergence
  // -------------------------------------------------------------------------
  it('16. completed-work + planner convergence — a completed-work signal + a planner run with the same goal produce ONE Work Item', async () => {
    const goal = 'Completed-work follow-up convergence';
    const completedSignal: PlanningSignal = {
      kind: 'completed-work',
      canonicalGoal: goal,
      provenance: 'observed',
    };
    const r1 = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [completedSignal] },
      ctxA,
    );
    expect(r1.createdCount).toBe(1);
    // A follow-up planner run with the same goal converges.
    const r2 = await planner.evaluate(
      { projectId: projectA.id, architectureVersionId: versionA.id, signals: [completedSignal] },
      ctxA,
    );
    expect(r2.createdCount).toBe(0);
    expect(r2.alreadyExistsCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 14. crash/retry behavior — durable job redelivery (reuses the existing
  // Queue + WorkerHost; NO new scheduler). The handler is idempotent (the
  // planner is convergent via the DB constraint), so redelivery is safe.
  // -------------------------------------------------------------------------
  describe('14. crash/retry — the durable planning.evaluate job', () => {
    it('redelivers on failure + converges (one Work Item, not two)', async () => {
      const queue = new InMemoryQueue();
      const logger = createLogger({ level: 'info', destination: capture });
      // A planner whose first evaluate throws + whose second succeeds. This
      // simulates a transient failure (e.g. a DB blip) that the WorkerHost
      // redelivers per the redeliveryPolicy (maxAttempts: 3).
      let attempt = 0;
      const flakyPlanner: DefaultDevelopmentPlannerService = new (class extends DefaultDevelopmentPlannerService {
        override async evaluate(input: PlanningEvaluateInput, ctx: PlanningContext) {
          attempt++;
          if (attempt === 1) {
            throw new Error('simulated-transient-failure');
          }
          return super.evaluate(input, ctx);
        }
      })({ prioritizer: new DeterministicPlanningPrioritizer(), logger });

      const handler = new PlanningEvaluateJobHandler({
        plannerService: flakyPlanner,
        projectRepository: stack.projectRepository,
        workItemRepository: stack.workItemRepository,
        workItemDependencyRepository: stack.workItemDependencyRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureRepository: stack.architectureRepository,
        requirementRepository: stack.requirementRepository,
        acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
        logger,
      });
      const host = new WorkerHost(queue, new Map([[handler.type, handler]]), logger, {
        pollIntervalMs: 5,
      });
      await host.start();
      try {
        const goal = 'Crash-retry durable job convergence';
        const signal = devRequestSignal(goal);
        const job = await queue.enqueue('planning.evaluate', {
          projectId: projectA.id,
          organizationId: ctxA.organizationId,
          architectureVersionId: versionA.id,
          signals: [signal],
        });
        // Wait for the worker to process (with retries). The redeliveryPolicy
        // maxAttempts: 3 means the first failure is redelivered.
        await waitFor(() => attempt >= 2, 2000);
        await queue.ack(job.id);
      } finally {
        await host.stop();
      }
      // After the redelivery, the planner succeeded → exactly ONE Work Item.
      const proposedId = computeProposedWorkItemId('Crash-retry durable job convergence');
      const all = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
      const matches = all.filter((w) => w.workItemId === proposedId);
      expect(matches.length).toBe(1);
    });
  });
});

/** Poll a predicate until it returns true or the timeout elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
