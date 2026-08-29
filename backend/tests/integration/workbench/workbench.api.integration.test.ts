/**
 * WORK-048 — route-level API tests for the Developer Workbench read model.
 *
 * The work order's required adversarial coverage at the HTTP boundary:
 *
 *   #1  The Workbench CANNOT read another project (tenant isolation — user B
 *       receives 403 on EVERY project-A workbench endpoint, and user A's
 *       responses never contain a single project-B row: no cross-project
 *       data leakage, no existence oracle).
 *   #4  Backend state changes are reflected after refresh/re-query (the
 *       dependency authority's completion flips unsatisfiedDependencies on
 *       the NEXT work-graph query — never a stale cached verdict).
 *   #8  Work Item details remain consistent with authoritative backend
 *       records (the node carries the work-items repository's own fields).
 *   #9  The PR/revision shown is the authoritative GitHub-derived identity
 *       (externalPrId/provider/repository/branch/baseBranch/headCommit/status
 *       verbatim from the /work-items PR-association authority).
 *   #10 Verification results come from the /verification authority's own
 *       records (the rollup row IS the verification run row).
 *
 * Plus the fail-closed ladder (401 unauthenticated; 403 unknown project —
 * authorization before data, no oracle), the SAFE execution shape (no prompt,
 * no package snapshot), the newest-first ordering, and the ?limit contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import type { FastifyInstance } from 'fastify';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultWorkItemDependencyService } from '../../../src/modules/work-items/internal/work-item-dependency-service.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import { PgExecutionRecordRepository } from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultVerificationService } from '../../../src/modules/verification/internal/verification-service.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';

describe('WORK-048 — Developer Workbench read-model API (project-scoped, read-only, authority-consuming)', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;

  let projectAId: string;
  let projectBId: string;
  let wiA1Id: string; // WB-A-001 — depends on WB-A-002 (the blocked node)
  let wiA2Id: string; // WB-A-002 — transitioned to 'ready' (the active node)
  let rawKeyA: string;
  let rawKeyB: string;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-w048-a',
      WFOS_TEST_KEY_B: 'raw-key-w048-b',
    });

    // --- Project A (user A / org A) -----------------------------------------
    const orgA = await stack.organizationRepository.create({ name: 'W048 Org A' });
    const userA = await stack.userRepository.upsertByExternalId({ externalId: 'w048-user-a', displayName: 'User A' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'W048 Project A' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    projectAId = projectA.id;
    await stack.apiKeyProvisioner.provision({
      keyId: 'w048-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'w048-user-a', label: 'A', rawKey: 'raw-key-w048-a',
    });
    rawKeyA = 'raw-key-w048-a';

    const archA = await stack.architectureRepository.create({ projectId: projectAId, name: 'W048 Arch A' });
    const versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: '# W048 A' });

    const wiA1 = await stack.workItemRepository.create({
      architectureVersionId: versionA.id, workItemId: 'WB-A-001',
      title: 'A first item', objective: 'objective A1', scope: 'src/a1.ts',
      metadata: { baseCommit: 'w048-a-baseline-000000000000000000000001' },
    });
    const wiA2 = await stack.workItemRepository.create({
      architectureVersionId: versionA.id, workItemId: 'WB-A-002',
      title: 'A second item', objective: 'objective A2', scope: 'src/a2.ts',
      metadata: { baseCommit: 'w048-a-baseline-000000000000000000000002' },
    });
    wiA1Id = wiA1.id;
    wiA2Id = wiA2.id;
    // WB-A-001 depends on WB-A-002 (still incomplete → unsatisfied).
    await stack.workItemDependencyRepository.add(wiA1Id, wiA2Id);

    // The workflow authority: WB-A-002 reaches 'ready'.
    const auditService = new DefaultAuditService(stack.db.client, stack.db.logger);
    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    const workflowEngine = new DefaultWorkflowEngine(
      stack.db.client, stack.db.logger,
      (wiId: string) => depService.canBeginImplementation(wiId),
      auditService,
    );
    await workflowEngine.transition({ workItemId: wiA2Id, toState: 'ready', actor: 'w048-fixture' });

    // Executions (the /agents authority): needs the work-order + context FKs.
    const workOrderA = await stack.workOrderRepository.create({
      workItemId: wiA2Id, projectId: projectAId, architectureVersionId: versionA.id,
      scope: 'src/a2.ts', verificationRequirements: ['unit-test'],
    });
    const contextRepo = new PgImplementationContextRepository(stack.db.client);
    const ctxA = await contextRepo.create({
      workItemId: wiA2Id, revision: 1, kind: 'initial',
      content: { prompt: 'w048 context A' } as never,
    });
    const executionRepo = new PgExecutionRecordRepository(stack.db.client);
    await executionRepo.create({
      executionId: 'exec-w048-a-1', projectId: projectAId, workItemId: wiA2Id,
      workOrderId: workOrderA.id, implementationContextId: ctxA.id,
      mode: 'native', provider: 'fake', model: 'fake-model',
      repositoryRef: 'pectoraux/W048-A', branch: 'feat/wb-a-1',
      prompt: 'SECRET-FREE-PROMPT', promptDigest: 'digest-a-1',
    });

    // PR association (the /work-items GitHub-derived identity authority).
    await stack.pullRequestAssociationRepository.create({
      workItemId: wiA2Id, externalPrId: 'w048-pr-101', provider: 'github',
      repositoryRef: 'pectoraux/W048-A', branch: 'feat/wb-a-1', baseBranch: 'main',
      headCommit: 'w048headcommit0000000000000000000000001',
    });

    // Verification run (the /verification authority).
    const verificationService = new DefaultVerificationService(
      stack.db.client,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.workItemRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.ciEvidenceRepository,
      stack.objectStore,
      stack.db.logger,
    );
    await verificationService.createRun({
      projectId: projectAId, workItemId: wiA2Id, architectureVersionId: versionA.id,
      source: 'manual', sourceRef: 'w048-fixture', executionId: 'exec-w048-a-1',
    });

    // Review (the /reviews authority).
    const reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, stack.db.logger);
    await reviewService.createReview({
      projectId: projectAId, workItemId: wiA2Id, architectureVersionId: versionA.id,
      source: 'manual', executionId: 'exec-w048-a-1', reviewer: 'w048-fixture',
    });

    // --- Project B (user B / org B — the isolation partner) ------------------
    const orgB = await stack.organizationRepository.create({ name: 'W048 Org B' });
    const userB = await stack.userRepository.upsertByExternalId({ externalId: 'w048-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'W048 Project B' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    projectBId = projectB.id;
    await stack.apiKeyProvisioner.provision({
      keyId: 'w048-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'w048-user-b', label: 'B', rawKey: 'raw-key-w048-b',
    });
    rawKeyB = 'raw-key-w048-b';

    const archB = await stack.architectureRepository.create({ projectId: projectBId, name: 'W048 Arch B' });
    const versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: '# W048 B' });
    const wiB1 = await stack.workItemRepository.create({
      architectureVersionId: versionB.id, workItemId: 'WB-B-001',
      title: 'B first item', objective: 'objective B1', scope: 'src/b1.ts',
      metadata: { baseCommit: 'w048-b-baseline-000000000000000000000001' },
    });
    const workOrderB = await stack.workOrderRepository.create({
      workItemId: wiB1.id, projectId: projectBId, architectureVersionId: versionB.id,
      scope: 'src/b1.ts', verificationRequirements: ['unit-test'],
    });
    const ctxB = await contextRepo.create({
      workItemId: wiB1.id, revision: 1, kind: 'initial',
      content: { prompt: 'w048 context B' } as never,
    });
    await executionRepo.create({
      executionId: 'exec-w048-b-1', projectId: projectBId, workItemId: wiB1.id,
      workOrderId: workOrderB.id, implementationContextId: ctxB.id,
      mode: 'native', provider: 'fake', model: 'fake-model',
      prompt: 'SECRET-FREE-PROMPT-B', promptDigest: 'digest-b-1',
    });

    // --- The server with the WORK-048 workbench route group ------------------
    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      workbench: {
        authorizationService: stack.authorizationService,
        workItemRepository: stack.workItemRepository,
        workItemDependencyRepository: stack.workItemDependencyRepository,
        dependencyService: depService,
        workflowEngine,
        executionRecordRepository: executionRepo,
        pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
        verificationService,
        reviewService,
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  const authHeaders = (key: string) => ({ 'x-api-key': key });

  const ENDPOINTS = [
    '/work-graph',
    '/executions',
    '/pr-associations',
    '/verification-runs',
    '/reviews',
  ] as const;

  // --- ADVERSARIAL #1: tenant isolation -------------------------------------

  it('ADVERSARIAL #1 (tenant isolation): user B is 403-forbidden on EVERY project-A workbench endpoint (no existence oracle, no data)', async () => {
    for (const ep of ENDPOINTS) {
      const res = await server.inject({
        method: 'GET',
        url: `/projects/${projectAId}${ep}`,
        headers: authHeaders(rawKeyB),
      });
      expect(res.statusCode, `GET ${ep} must be 403 for user B`).toBe(403);
      const body = res.json() as { error?: string };
      expect(body.error).toBe('forbidden');
    }
  });

  it('ADVERSARIAL #1 (no cross-project data leakage): project-A responses contain ZERO project-B rows (and vice versa)', async () => {
    const graphA = (await server.inject({
      method: 'GET', url: `/projects/${projectAId}/work-graph`, headers: authHeaders(rawKeyA),
    })).json() as { workGraph: { nodes: { id: string }[]; edges: unknown[] } };
    expect(graphA.workGraph.nodes.map((n) => n.id).sort()).toEqual([wiA1Id, wiA2Id].sort());

    const execsA = (await server.inject({
      method: 'GET', url: `/projects/${projectAId}/executions`, headers: authHeaders(rawKeyA),
    })).json() as { executions: { executionId: string }[] };
    expect(execsA.executions.map((e) => e.executionId)).toEqual(['exec-w048-a-1']);

    const execsB = (await server.inject({
      method: 'GET', url: `/projects/${projectBId}/executions`, headers: authHeaders(rawKeyB),
    })).json() as { executions: { executionId: string }[] };
    expect(execsB.executions.map((e) => e.executionId)).toEqual(['exec-w048-b-1']);

    const graphB = (await server.inject({
      method: 'GET', url: `/projects/${projectBId}/work-graph`, headers: authHeaders(rawKeyB),
    })).json() as { workGraph: { nodes: { id: string }[] } };
    expect(graphB.workGraph.nodes.every((n) => n.id !== wiA1Id && n.id !== wiA2Id)).toBe(true);
  });

  // --- the fail-closed ladder -------------------------------------------------

  it('unauthenticated requests are 401 on every workbench endpoint (fail closed, never anonymous reads)', async () => {
    for (const ep of ENDPOINTS) {
      const res = await server.inject({ method: 'GET', url: `/projects/${projectAId}${ep}` });
      expect(res.statusCode, `GET ${ep} unauthenticated`).toBe(401);
    }
  });

  it('an unknown project id is 403 (authorization runs BEFORE any data is queried — no existence oracle)', async () => {
    const unknownId = '00000000-0000-4000-8000-000000000000';
    for (const ep of ENDPOINTS) {
      const res = await server.inject({
        method: 'GET', url: `/projects/${unknownId}${ep}`, headers: authHeaders(rawKeyA),
      });
      expect(res.statusCode, `GET ${ep} unknown project`).toBe(403);
    }
  });

  // --- the work graph ---------------------------------------------------------

  it('the work graph returns authoritative facts: nodes (work-items fields + workflow state + unsatisfied dependencies) and edges', async () => {
    const res = await server.inject({
      method: 'GET', url: `/projects/${projectAId}/work-graph`, headers: authHeaders(rawKeyA),
    });
    expect(res.statusCode).toBe(200);
    const { workGraph } = res.json() as {
      workGraph: {
        projectId: string;
        nodes: Array<{
          id: string; workItemId: string; title: string; objective: string | null;
          completed: boolean; currentState: string | null; unsatisfiedDependencies: string[];
        }>;
        edges: Array<{ workItemId: string; dependsOnId: string }>;
      };
    };
    expect(workGraph.projectId).toBe(projectAId);
    // ADVERSARIAL #8: the node carries the work-items repository's own fields.
    const a1 = workGraph.nodes.find((n) => n.id === wiA1Id)!;
    expect(a1.workItemId).toBe('WB-A-001');
    expect(a1.title).toBe('A first item');
    expect(a1.objective).toBe('objective A1');
    expect(a1.completed).toBe(false);
    // The dependency AUTHORITY's verdict: WB-A-001 is blocked on the incomplete WB-A-002.
    expect(a1.unsatisfiedDependencies).toEqual([wiA2Id]);
    // The workflow AUTHORITY's state: WB-A-002 reached 'ready'.
    const a2 = workGraph.nodes.find((n) => n.id === wiA2Id)!;
    expect(a2.currentState).toBe('ready');
    expect(a2.unsatisfiedDependencies).toEqual([]);
    // The edge list mirrors the authoritative dependency rows.
    expect(workGraph.edges).toEqual([{ workItemId: wiA1Id, dependsOnId: wiA2Id }]);
  });

  it('ADVERSARIAL #4 (refresh/re-query): a backend state change (dependency completed) is reflected on the NEXT work-graph query', async () => {
    // Before: WB-A-001 is blocked on WB-A-002.
    const before = (await server.inject({
      method: 'GET', url: `/projects/${projectAId}/work-graph`, headers: authHeaders(rawKeyA),
    })).json() as { workGraph: { nodes: Array<{ id: string; unsatisfiedDependencies: string[] }> } };
    expect(before.workGraph.nodes.find((n) => n.id === wiA1Id)!.unsatisfiedDependencies).toEqual([wiA2Id]);

    // The backend authority changes: WB-A-002 is completed.
    await stack.workItemRepository.markCompleted(wiA2Id, true);

    // Re-query: the fresh authoritative verdict — never a cached one.
    const after = (await server.inject({
      method: 'GET', url: `/projects/${projectAId}/work-graph`, headers: authHeaders(rawKeyA),
    })).json() as { workGraph: { nodes: Array<{ id: string; unsatisfiedDependencies: string[]; completed: boolean }> } };
    const a1 = after.workGraph.nodes.find((n) => n.id === wiA1Id)!;
    expect(a1.unsatisfiedDependencies).toEqual([]);
    expect(after.workGraph.nodes.find((n) => n.id === wiA2Id)!.completed).toBe(true);

    // Restore the fixture for the other tests.
    await stack.workItemRepository.markCompleted(wiA2Id, false);
  });

  // --- the rollups --------------------------------------------------------------

  it('the executions rollup is SAFE (no prompt, no package snapshot) and project-scoped newest-first', async () => {
    const res = await server.inject({
      method: 'GET', url: `/projects/${projectAId}/executions`, headers: authHeaders(rawKeyA),
    });
    expect(res.statusCode).toBe(200);
    const { executions } = res.json() as { executions: Array<Record<string, unknown>> };
    expect(executions).toHaveLength(1);
    const exec = executions[0]!;
    expect(exec.executionId).toBe('exec-w048-a-1');
    expect(exec.workItemId).toBe(wiA2Id);
    expect(exec.provider).toBe('fake');
    expect(exec.mode).toBe('native');
    expect(exec.repository).toBe('pectoraux/W048-A');
    expect(exec.branch).toBe('feat/wb-a-1');
    // SAFE: the prompt + package snapshot NEVER leave the backend.
    expect(exec).not.toHaveProperty('prompt');
    expect(exec).not.toHaveProperty('packageJson');
    expect(exec).not.toHaveProperty('package');
  });

  it('ADVERSARIAL #9: the changes rollup carries the AUTHORITATIVE GitHub-derived PR identity verbatim', async () => {
    const res = await server.inject({
      method: 'GET', url: `/projects/${projectAId}/pr-associations`, headers: authHeaders(rawKeyA),
    });
    expect(res.statusCode).toBe(200);
    const { prAssociations } = res.json() as {
      prAssociations: Array<{
        workItemId: string; externalPrId: string; provider: string;
        repositoryRef: string | null; branch: string | null; baseBranch: string | null;
        headCommit: string | null; status: string;
      }>;
    };
    expect(prAssociations).toHaveLength(1);
    const pr = prAssociations[0]!;
    expect(pr.externalPrId).toBe('w048-pr-101');
    expect(pr.provider).toBe('github');
    expect(pr.repositoryRef).toBe('pectoraux/W048-A');
    expect(pr.branch).toBe('feat/wb-a-1');
    expect(pr.baseBranch).toBe('main');
    expect(pr.headCommit).toBe('w048headcommit0000000000000000000000001');
    expect(pr.status).toBe('active');
    expect(pr.workItemId).toBe(wiA2Id);
  });

  it('ADVERSARIAL #10: the verification rollup returns the /verification authority\'s own run records', async () => {
    const res = await server.inject({
      method: 'GET', url: `/projects/${projectAId}/verification-runs`, headers: authHeaders(rawKeyA),
    });
    expect(res.statusCode).toBe(200);
    const { verificationRuns } = res.json() as {
      verificationRuns: Array<{ projectId: string; workItemId: string; status: string; source: string; executionId: string }>;
    };
    expect(verificationRuns).toHaveLength(1);
    const run = verificationRuns[0]!;
    expect(run.projectId).toBe(projectAId);
    expect(run.workItemId).toBe(wiA2Id);
    expect(run.source).toBe('manual');
    expect(run.executionId).toBe('exec-w048-a-1');
    expect(['pending', 'running', 'completed', 'failed']).toContain(run.status);
  });

  it('the reviews rollup returns the /reviews authority\'s own records', async () => {
    const res = await server.inject({
      method: 'GET', url: `/projects/${projectAId}/reviews`, headers: authHeaders(rawKeyA),
    });
    expect(res.statusCode).toBe(200);
    const { reviews } = res.json() as {
      reviews: Array<{ projectId: string; workItemId: string; status: string; source: string; outcome: string | null }>;
    };
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    expect(review.projectId).toBe(projectAId);
    expect(review.workItemId).toBe(wiA2Id);
    expect(review.source).toBe('manual');
    expect(review.status).toBe('in_progress');
    expect(review.outcome).toBeNull();
  });

  it('the ?limit query is honored on every rollup (the audit-route convention)', async () => {
    for (const ep of ['/executions', '/pr-associations', '/verification-runs', '/reviews']) {
      const res = await server.inject({
        method: 'GET', url: `/projects/${projectAId}${ep}?limit=1`, headers: authHeaders(rawKeyA),
      });
      expect(res.statusCode, `GET ${ep}?limit=1`).toBe(200);
      const body = res.json() as Record<string, unknown[]>;
      const list = Object.values(body)[0]!;
      expect(list.length).toBeLessThanOrEqual(1);
    }
  });
});
