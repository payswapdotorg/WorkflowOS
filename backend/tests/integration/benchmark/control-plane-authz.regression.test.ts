/**
 * PR #35 review fix (control-plane boundary + start concurrency):
 * regression tests proving the two blockers the reviewer flagged on the
 * WORK-032 branch post-PR-#36-merge:
 *
 *   1. PRIMARY BLOCKER — UNAUTHORIZED LAZY RECOVERY. The service-level
 *      `getExperiment()` triggered lazy recovery (a MUTATION: recovery CAS
 *      + finalization CASes + terminal audit events) on `finalizing`
 *      reads, and every route resolves the experiment's projectId via
 *      `getExperiment(id)` BEFORE calling requireProjectAuthorization —
 *      so authorization happened AFTER a potentially state-mutating
 *      operation. A caller with NO access to the experiment's project
 *      could trigger recovery on another project's experiment merely by
 *      knowing its UUID. The experiment UUID is NOT an authorization
 *      credential; authorization MUST precede ANY mutation, even
 *      recovery.
 *
 *      The fix: `getExperiment()` is a PURE read; recovery moved to
 *      `recoverExperimentIfStale()`, which the route layer calls ONLY
 *      AFTER requireProjectAuthorization succeeded. These tests prove:
 *        (a) an UNAUTHORIZED cross-project read produces NO mutation + NO
 *            audit (the stuck `finalizing` row is returned untouched —
 *            status, fencing generation, + lease unchanged);
 *        (b) an AUTHORIZED read still recovers the stuck experiment to
 *            exactly one terminal state + exactly one terminal audit
 *            (forward progress is preserved — the fix did not remove the
 *            recovery, it re-homed it behind authorization).
 *
 *   2. SECONDARY BLOCKER — NON-ATOMIC EXPERIMENT START. `startExperiment()`
 *      was read-check-write (read status → check created/paused in the
 *      application layer → unconditional `updateExperimentStatus(...,
 *      'running')` → audit BENCHMARK_STARTED → enqueue trials). Under
 *      concurrent starts, BOTH callers passed the check (both read
 *      'created'), BOTH wrote 'running', BOTH audited, and BOTH enqueued —
 *      duplicate BENCHMARK_STARTED auditing + duplicate queue delivery.
 *
 *      The fix: `claimExperimentStart()` — an atomic CAS
 *      (`WHERE id=$1 AND status IN ('created','paused') RETURNING *`).
 *      Only the CAS WINNER performs the side effects (audit + enqueue).
 *      These tests prove: two concurrent starts produce exactly ONE
 *      transition, ONE BENCHMARK_STARTED audit, and ONE set of trial
 *      enqueues; the loser is rejected with the invalid-state error
 *      (mirroring the sequential double-start semantics).
 *
 * NOTE: like compare-authz.regression.test.ts, this file uses a CUSTOM
 * inline fixture (not `buildBenchmarkFixture`) because we need TWO
 * DISTINCT users (one per project) so the cross-tenant read is
 * meaningful (User B's API key cannot authorize Project A). The
 * WorkerHost is intentionally NOT started: the `benchmark.trial` jobs
 * enqueued by startExperiment stay in the queue so the enqueue counts
 * are deterministic (no worker races the assertions).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import {
  DefaultBenchmarkService,
  DefaultBenchmarkSnapshotService,
  DefaultBenchmarkIntegrityService,
  DefaultBenchmarkMetricCollector,
  DefaultBenchmarkTrialOrchestrator,
  DefaultBenchmarkExportService,
  DefaultBenchmarkRecommendationService,
  PgBenchmarkRepository,
  DeterministicNativeBenchmarkProvider,
  DeterministicExternalBenchmarkProvider,
} from '../../../src/benchmark/index.js';
import { InMemoryQueue } from '@platform/index.js';
import { buildServer } from '@api/server.js';
import { DefaultExecutionService } from '../../../src/modules/agents/internal/execution-service.js';
import { DefaultExecutionTaskService } from '../../../src/modules/work-items/internal/execution-task-service.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultExecutionPromptBuilder } from '../../../src/modules/work-items/internal/execution-prompt-builder.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import {
  PgExecutionRecordRepository,
  PgExecutionEventRepository,
  PgExecutionHandoffRepository,
  PgExecutionCallbackRepository,
} from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { DefaultExecutionHandoffService } from '../../../src/modules/agents/internal/execution-handoff-service.js';
import { DefaultExecutionCallbackService } from '../../../src/modules/agents/internal/execution-callback-service.js';
import { DefaultExecutionEventIngestionService } from '../../../src/modules/agents/internal/execution-event-ingestion-service.js';
import { FakeGitHubAdapter } from '../../../src/modules/github/internal/fake-github-adapter.js';
import { PgCiEvidenceIngestionRepository } from '../../../src/modules/github/internal/pg-ci-evidence-repository.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import { DefaultAuthorizationService } from '../../../src/modules/auth/internal/authorization-service.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';
import type { FastifyInstance } from 'fastify';
import type { BenchmarkService } from '../../../src/benchmark/index.js';
import type { DefaultAuditService as AuditServiceInstance } from '../../../src/modules/audit/internal/audit-service.js';

interface ProjectFixture {
  readonly userId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly apiKey: string;
}

async function buildProjectFixture(
  stack: TestAuthStack,
  opts: { apiKey: string; secretRef: string; externalId: string; label: string; projectName: string; workItemLabel: string },
): Promise<ProjectFixture> {
  const org = await stack.organizationRepository.create({ name: `Org ${opts.label}` });
  const user = await stack.userRepository.upsertByExternalId({
    externalId: opts.externalId,
    displayName: opts.label,
  });
  await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
  const project = await stack.projectRepository.create({ organizationId: org.id, name: opts.projectName });
  await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });
  await stack.apiKeyProvisioner.provision({
    keyId: `key-${opts.label}`,
    secretRef: opts.secretRef,
    externalId: opts.externalId,
    label: opts.label,
    rawKey: opts.apiKey,
  });

  const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch ${opts.label}` });
  const version = await stack.architectureVersionRepository.create({
    architectureId: arch.id,
    contentInline: `# Architecture ${opts.label}`,
  });
  await stack.architectureVersionRepository.transitionState(version.id, 'frozen', user.id);
  const req = await stack.requirementRepository.create({
    architectureVersionId: version.id,
    requirementId: `REQ-${opts.label}-001`,
    title: 'Calculator adds',
    description: 'add(2,3)===5',
  });
  const crit = await stack.acceptanceCriterionRepository.create({
    requirementId: req.id,
    criterionId: `AC-${opts.label}-001`,
    description: 'add(2,3) returns 5',
    verificationExpectation: 'unit-test',
  });
  const workItem = await stack.workItemRepository.create({
    architectureVersionId: version.id,
    workItemId: `WORK-${opts.workItemLabel}-001`,
    title: 'Calculator addition',
    objective: 'Add a calculator.',
    scope: 'src/calc.ts',
    outOfScope: 'sub',
    metadata: { baseCommit: `${opts.label.toLowerCase()}-baseline-commit-000000000000000001` },
  });
  await stack.workItemRequirementRepository.associate(workItem.id, req.id);
  await stack.workItemCriterionRepository.associate(workItem.id, crit.id);
  await stack.workOrderRepository.create({
    workItemId: workItem.id,
    projectId: project.id,
    architectureVersionId: version.id,
    requirementIds: [req.id],
    criterionIds: [crit.id],
    scope: 'src/calc.ts',
    verificationRequirements: ['unit-test: add(2,3)===5'],
  });
  const projectGitHubRepositoryRepository = new PgProjectGitHubRepositoryRepository(stack.db.client);
  await projectGitHubRepositoryRepository.create({
    projectId: project.id,
    installationId: `inst-${opts.label}`,
    owner: `${opts.label.toLowerCase()}-org`,
    repository: `${opts.label.toLowerCase()}-repo`,
    defaultBranch: 'main',
    linkType: 'linked',
  });
  return {
    userId: user.id,
    projectId: project.id,
    workItemId: workItem.id,
    apiKey: opts.apiKey,
  };
}

describe('PR #35 fix — control-plane boundary (authz-before-mutation) + atomic experiment start', () => {
  let stack: TestAuthStack;
  let fixtureA: ProjectFixture;
  let fixtureB: ProjectFixture;
  let benchmarkService: BenchmarkService;
  let benchmarkRepository: PgBenchmarkRepository;
  let auditService: AuditServiceInstance;
  let server: FastifyInstance;
  let queue: InMemoryQueue;

  const API_KEY_A = 'raw-key-control-plane-a';
  const SECRET_REF_A = 'WFOS_TEST_KEY_CONTROL_PLANE_A';
  const API_KEY_B = 'raw-key-control-plane-b';
  const SECRET_REF_B = 'WFOS_TEST_KEY_CONTROL_PLANE_B';

  /** Counter of `benchmark.trial` enqueue calls (the start side-effect signal). */
  let trialJobEnqueues: number;

  beforeAll(async () => {
    process.env[SECRET_REF_A] = API_KEY_A;
    process.env[SECRET_REF_B] = API_KEY_B;
    stack = await buildAuthStack({ [SECRET_REF_A]: API_KEY_A, [SECRET_REF_B]: API_KEY_B });
    fixtureA = await buildProjectFixture(stack, {
      apiKey: API_KEY_A,
      secretRef: SECRET_REF_A,
      externalId: 'control-plane-user-a',
      label: 'CtrlA',
      projectName: 'Project A',
      workItemLabel: 'CTRLA',
    });
    fixtureB = await buildProjectFixture(stack, {
      apiKey: API_KEY_B,
      secretRef: SECRET_REF_B,
      externalId: 'control-plane-user-b',
      label: 'CtrlB',
      projectName: 'Project B',
      workItemLabel: 'CTRLB',
    });

    // --- wire benchmark service (shared across both projects) ---
    const db = stack.db.client;
    const logger = stack.db.logger;
    auditService = new DefaultAuditService(db, logger);
    const authorizationService = new DefaultAuthorizationService(
      stack.membershipRepository,
      stack.rolePermissionRepository,
      stack.projectRepository,
      stack.projectAccessRepository,
    );
    benchmarkRepository = new PgBenchmarkRepository(db);
    const projectGitHubRepositoryRepository = new PgProjectGitHubRepositoryRepository(db);
    const githubAdapter = new FakeGitHubAdapter();
    const implementationContextRepository = new PgImplementationContextRepository(db);
    const promptBuilder = new DefaultExecutionPromptBuilder();
    const implementationContextBuilder = new DefaultImplementationContextBuilder(
      stack.workItemRepository,
      stack.workOrderRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.workItemDependencyRepository,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.architectureRepository,
      implementationContextRepository,
      async () => null,
      async () => null,
      async () => [],
      async () => [],
    );
    const snapshotService = new DefaultBenchmarkSnapshotService({
      repository: benchmarkRepository,
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      projectRepository: stack.projectRepository,
      implementationContextBuilder,
      contextRepository: implementationContextRepository,
      promptBuilder,
      projectGitHubRepositoryRepository,
      githubAdapter,
      logger: logger as never,
    });
    const integrityService = new DefaultBenchmarkIntegrityService({ repository: benchmarkRepository, logger: logger as never });
    const workflowEngine = new DefaultWorkflowEngine(db, logger);
    const reviewService = new DefaultReviewService(db, stack.workItemRepository, logger);
    const verificationService = {
      listRunsForWorkItem: async () => [],
      listEvidenceForRun: async () => [],
      listMappingsForRun: async () => [],
    } as never;
    const ciEvidenceIngestionRepository = new PgCiEvidenceIngestionRepository(db);
    const agentRunRepository = new PgAgentRunRepository(db);
    const metricCollector = new DefaultBenchmarkMetricCollector({
      repository: benchmarkRepository,
      workflowEngine,
      verificationService,
      reviewService,
      pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
      ciEvidenceIngestionRepository,
      agentRunRepository,
      logger: logger as never,
    });
    const executionRecordRepository = new PgExecutionRecordRepository(db);
    const executionEventRepository = new PgExecutionEventRepository(db);
    const executionHandoffRepository = new PgExecutionHandoffRepository(db);
    const executionCallbackRepository = new PgExecutionCallbackRepository(db);
    const executionTaskService = new DefaultExecutionTaskService({
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      implementationContextBuilder,
      contextRepository: implementationContextRepository,
      promptBuilder,
      logger: logger as never,
    });
    const executionHandoffService = new DefaultExecutionHandoffService({
      executionRecordRepository,
      handoffRepository: executionHandoffRepository,
      auditService,
      logger: logger as never,
    });
    void executionHandoffService;
    const executionCallbackService = new DefaultExecutionCallbackService({
      executionRecordRepository,
      callbackRepository: executionCallbackRepository,
      auditService,
      logger: logger as never,
    });
    void executionCallbackService;
    const executionEventIngestionService = new DefaultExecutionEventIngestionService({
      executionRecordRepository,
      eventRepository: executionEventRepository,
      auditService,
      logger: logger as never,
    });
    void executionEventIngestionService;
    const deterministicNativeProvider = new DeterministicNativeBenchmarkProvider({
      variant: 'perfect-first-pass',
      agentRunRepository,
    });
    const deterministicExternalProvider = new DeterministicExternalBenchmarkProvider({
      variant: 'perfect-first-pass',
    });
    const executionService = new DefaultExecutionService({
      executionRecordRepository,
      providers: [deterministicNativeProvider, deterministicExternalProvider],
      auditService,
      logger: logger as never,
    });
    const trialOrchestrator = new DefaultBenchmarkTrialOrchestrator({
      repository: benchmarkRepository,
      executionService,
      executionTaskService,
      agentRunRepository,
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      workItemRequirementRepository: stack.workItemRequirementRepository,
      workItemCriterionRepository: stack.workItemCriterionRepository,
      workItemDependencyRepository: stack.workItemDependencyRepository,
      workflowEngine,
      projectGitHubRepositoryRepository,
      githubAdapter,
      logger: logger as never,
    });
    const exportService = new DefaultBenchmarkExportService({ repository: benchmarkRepository, logger: logger as never });
    const recommendationService = new DefaultBenchmarkRecommendationService({ repository: benchmarkRepository, logger: logger as never });
    queue = new InMemoryQueue();
    benchmarkService = new DefaultBenchmarkService({
      db,
      logger: logger as never,
      repository: benchmarkRepository,
      snapshotService,
      integrityService,
      metricCollector,
      trialOrchestrator,
      exportService,
      recommendationService,
      auditService,
      authorizationService,
      queue,
      executionRecordRepository,
      workflowEngine,
    });

    // Count `benchmark.trial` enqueues — the concurrent-start side-effect
    // signal. WITHOUT the atomic start claim, BOTH concurrent starters
    // would enqueue the queued trials (duplicate queue delivery). WITH the
    // claim, only the CAS winner enqueues.
    trialJobEnqueues = 0;
    const origEnqueue = queue.enqueue.bind(queue);
    queue.enqueue = (async (type: string, payload: unknown, options?: object) => {
      if (type === 'benchmark.trial') trialJobEnqueues++;
      return origEnqueue(type as never, payload as never, options as never);
    }) as typeof queue.enqueue;

    // --- build the Fastify server (auth + benchmark routes only) ---
    // NOTE: NO WorkerHost — the enqueued `benchmark.trial` jobs stay in the
    // queue so the concurrent-start enqueue counts are deterministic.
    server = await buildServer({
      queue,
      logger: logger as never,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      benchmark: { authorizationService, benchmarkService },
    });
    await server.ready();
  });

  afterAll(async () => {
    if (server) await server.close();
    if (queue) await queue.close();
    if (stack) await stack.teardown();
  });

  /** GET /benchmarks/:id with the given API key. */
  async function getExperiment(
    apiKey: string,
    experimentId: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await server.inject({
      method: 'GET',
      url: `/benchmarks/${experimentId}`,
      headers: { 'x-api-key': apiKey },
    });
    let body: Record<string, unknown>;
    try {
      body = res.json() as Record<string, unknown>;
    } catch {
      body = { raw: res.body };
    }
    return { status: res.statusCode, body };
  }

  /** POST /benchmarks/:id/start with the given API key. */
  async function postStart(
    apiKey: string,
    experimentId: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await server.inject({
      method: 'POST',
      url: `/benchmarks/${experimentId}/start`,
      headers: { 'x-api-key': apiKey },
    });
    let body: Record<string, unknown>;
    try {
      body = res.json() as Record<string, unknown>;
    } catch {
      body = { raw: res.body };
    }
    return { status: res.statusCode, body };
  }

  /**
   * Create a snapshot + single-trial experiment in Project A, then put it
   * into the STUCK RECOVERABLE state: experiment 'running', trial terminal,
   * a lost worker's `finalizing` reservation whose lease has EXPIRED. This
   * is exactly the state the (removed) lazy recovery used to mutate on
   * read — the state an unauthorized reader must NOT be able to advance.
   */
  async function makeStuckFinalizingExperiment(name: string): Promise<string> {
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixtureA.projectId,
      workItemId: fixtureA.workItemId,
      name: `${name}-snapshot`,
      actor: fixtureA.userId,
    });
    const exp = await benchmarkService.createExperiment({
      projectId: fixtureA.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name,
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
      createdBy: fixtureA.userId,
    });
    const { trials } = await benchmarkService.listTrials(exp.id);
    const trialId = trials[0]!.id;
    // The state checkExperimentCompletion expects: experiment 'running' +
    // every trial terminal.
    await benchmarkRepository.updateExperimentStatus(exp.id, 'running', { startedAt: new Date() });
    await stack.db.client.query(
      `UPDATE wfos_benchmark_trials
         SET status = 'completed', lifecycle_phase = 'completed', completed_at = NOW()
       WHERE id = $1`,
      [trialId],
    );
    // A lost worker wins the reservation (running → finalizing, 30s lease)
    // + then DIES before validation/finalization.
    const claimed = await benchmarkRepository.claimExperimentCompletion(exp.id, 30_000);
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe('finalizing');
    // The lease EXPIRES (the worker has been dead longer than the TTL) —
    // the recovery CAS (`WHERE finalizing_lease_expires_at < NOW()`) can
    // now reclaim it. The experiment is STUCK + RECOVERABLE.
    await stack.db.client.query(
      `UPDATE wfos_benchmark_experiments
         SET finalizing_lease_expires_at = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [exp.id],
    );
    return exp.id;
  }

  it('UNAUTHORIZED cross-project read produces NO mutation + NO audit (authorization precedes recovery)', async () => {
    const experimentId = await makeStuckFinalizingExperiment('unauthorized-read-no-mutation');
    const before = await benchmarkRepository.getExperiment(experimentId);
    expect(before?.status).toBe('finalizing');
    // PRECONDITION: the experiment belongs to Project A — a DIFFERENT
    // project than User B's authorization (User B owns Project B only).
    // User B knows the experiment UUID but has NO access to Project A.
    expect(before?.projectId).toBe(fixtureA.projectId);
    expect(before?.projectId).not.toBe(fixtureB.projectId);
    const beforeGeneration = before?.finalizingGeneration;
    const auditsBefore = await auditService.listForResource('benchmark_experiment', experimentId);

    // User B (authorized ONLY for Project B) reads Project A's stuck
    // experiment by its UUID. The UUID is NOT an authorization credential:
    // the request MUST be rejected with 403 — and CRITICALLY, the read
    // MUST NOT have triggered the (previously lazy) recovery. Pre-fix, the
    // service-level getExperiment mutated here BEFORE
    // requireProjectAuthorization ran: the recovery CAS reclaimed the
    // expired lease, the finalization CAS completed the experiment, and a
    // BENCHMARK_COMPLETED audit was written — all by an UNAUTHORIZED
    // caller.
    const { status, body } = await getExperiment(API_KEY_B, experimentId);
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');

    // ASSERTION 1 — the experiment row is UNCHANGED. Still stuck in
    // `finalizing` with the SAME fencing generation + the STILL-EXPIRED
    // lease (the recovery CAS never ran — if it had, the generation would
    // have advanced + the lease would have been renewed into the future).
    const after = await benchmarkRepository.getExperiment(experimentId);
    expect(after?.status).toBe('finalizing');
    expect(after?.finalizingGeneration).toBe(beforeGeneration);
    const row = await stack.db.client.query<{ status: string; gen: string | null; lease: Date | null }>(
      `SELECT status, finalizing_generation AS gen, finalizing_lease_expires_at AS lease
         FROM wfos_benchmark_experiments WHERE id = $1`,
      [experimentId],
    );
    expect(row.rows[0]?.status).toBe('finalizing');
    expect(row.rows[0]?.lease !== null).toBe(true);
    // The lease is still in the PAST (expired — not renewed by any recovery).
    expect(new Date(row.rows[0]!.lease!).getTime()).toBeLessThan(Date.now());

    // ASSERTION 2 — ZERO new audit events. No BENCHMARK_COMPLETED, no
    // BENCHMARK_INVALIDATED, no recovery audit of any kind. An
    // unauthorized read cannot mutate another project's experiment.
    const auditsAfter = await auditService.listForResource('benchmark_experiment', experimentId);
    expect(auditsAfter).toHaveLength(auditsBefore.length);
    expect(auditsAfter.filter((e) => e.eventType === 'BENCHMARK_COMPLETED')).toHaveLength(0);
    expect(auditsAfter.filter((e) => e.eventType === 'BENCHMARK_INVALIDATED')).toHaveLength(0);

    // ASSERTION 3 — forward progress is PRESERVED for the AUTHORIZED
    // reader. User A (Project A's owner) reads the same stuck experiment:
    // authorization succeeds FIRST, then the post-authorization recovery
    // hook runs — the experiment is recovered to `completed` with exactly
    // ONE BENCHMARK_COMPLETED audit. The fix re-homed the recovery behind
    // authorization; it did NOT remove it.
    const authorized = await getExperiment(API_KEY_A, experimentId);
    expect(authorized.status).toBe(200);
    const recoveredExp = authorized.body.experiment as { status: string };
    expect(recoveredExp.status).toBe('completed');
    const auditsFinal = await auditService.listForResource('benchmark_experiment', experimentId);
    expect(auditsFinal.filter((e) => e.eventType === 'BENCHMARK_COMPLETED')).toHaveLength(1);
    expect(auditsFinal.filter((e) => e.eventType === 'BENCHMARK_INVALIDATED')).toHaveLength(0);
  });

  it('CONCURRENT experiment starts finalize exactly once (one transition, one audit, one set of enqueues)', async () => {
    // Create a fresh 'created' experiment with ONE queued trial.
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixtureA.projectId,
      workItemId: fixtureA.workItemId,
      name: 'concurrent-start-snapshot',
      actor: fixtureA.userId,
    });
    const exp = await benchmarkService.createExperiment({
      projectId: fixtureA.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name: 'concurrent-start-experiment',
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
      createdBy: fixtureA.userId,
    });
    const auditsBefore = await auditService.listForResource('benchmark_experiment', exp.id);
    const startedAuditsBefore = auditsBefore.filter((e) => e.eventType === 'BENCHMARK_STARTED').length;
    const enqueuesBefore = trialJobEnqueues;

    // TWO CONCURRENT starts by the SAME authorized user (the authorized
    // caller racing itself — e.g. a double-clicked button or a retried
    // request). WITHOUT the atomic start claim, BOTH requests read
    // 'created', BOTH passed the application-layer check, BOTH wrote
    // 'running', BOTH audited BENCHMARK_STARTED, and BOTH enqueued the
    // queued trial — duplicate auditing + duplicate queue delivery.
    // WITH claimExperimentStart (created|paused → running CAS), exactly
    // ONE request wins; the loser is rejected with the invalid-state
    // error (the sequential double-start semantics).
    const [first, second] = await Promise.all([
      postStart(API_KEY_A, exp.id),
      postStart(API_KEY_A, exp.id),
    ]);
    const statuses = [first.status, second.status].sort();
    // Exactly ONE success + ONE invalid-state rejection.
    expect(statuses).toEqual([200, 400]);
    const loser = first.status === 400 ? first : second;
    expect(String(loser.body.error)).toBe('benchmark-start-failed');
    expect(String(loser.body.message)).toContain('benchmark-experiment-invalid-state: running');

    // ASSERTION 1 — exactly ONE BENCHMARK_STARTED audit event. The CAS
    // loser never reached the audit write.
    const auditsAfter = await auditService.listForResource('benchmark_experiment', exp.id);
    const startedAudits = auditsAfter.filter((e) => e.eventType === 'BENCHMARK_STARTED');
    expect(startedAudits).toHaveLength(startedAuditsBefore + 1);

    // ASSERTION 2 — exactly ONE set of trial enqueues. The experiment has
    // one queued trial; only the CAS winner enqueued it. (The loser
    // enqueued NOTHING — it was rejected at the claim.)
    expect(trialJobEnqueues - enqueuesBefore).toBe(1);

    // ASSERTION 3 — the experiment transitioned 'running' exactly once
    // and STAYS 'running' (no worker is running, so the enqueued trial
    // job just sits in the queue — deterministic). startedAt is stamped.
    const after = await benchmarkRepository.getExperiment(exp.id);
    expect(after?.status).toBe('running');
    expect(after?.startedAt).not.toBeNull();

    // ASSERTION 4 — a THIRD (sequential) start is ALSO rejected (the
    // experiment is 'running' — the same invalid-state semantics as the
    // concurrent loser). The CAS handles the sequential + concurrent
    // double-start identically.
    const third = await postStart(API_KEY_A, exp.id);
    expect(third.status).toBe(400);
    expect(String(third.body.message)).toContain('benchmark-experiment-invalid-state: running');
    // ...and it produced NO additional audit + NO additional enqueue.
    const auditsFinal = await auditService.listForResource('benchmark_experiment', exp.id);
    expect(auditsFinal.filter((e) => e.eventType === 'BENCHMARK_STARTED')).toHaveLength(startedAuditsBefore + 1);
    expect(trialJobEnqueues - enqueuesBefore).toBe(1);
  });
});
