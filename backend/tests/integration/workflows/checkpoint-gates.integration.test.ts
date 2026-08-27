import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { InMemoryQueue, createLogger, InMemoryObjectStore } from '@platform/index.js';

import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import {
  DefaultWorkflowOrchestrator,
} from '../../../src/modules/workflows/internal/workflow-orchestrator.js';
import { ArchitectureCheckpointGateDeniedError } from '../../../src/modules/workflows/internal/convergence.types.js';
import type {
  ArchitectureCheckpointGate,
  ArchitectureCheckpointGateInput,
  ArchitectureCheckpointGateResult,
  ArchitectureCheckpointKind,
} from '@modules/workflows/index.js';
import { DefaultWorkItemDependencyService } from '../../../src/modules/work-items/internal/work-item-dependency-service.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import { DefaultLlmGateway, FakeLlmAdapter } from '../../../src/modules/llm/internal/llm-gateway.js';
import { DefaultArchitectService } from '../../../src/modules/llm/internal/architect-service.js';
import { DefaultVerificationService } from '../../../src/modules/verification/internal/verification-service.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import { DefaultGitHubAdapter } from '../../../src/modules/github/internal/pg-github-repository.js';
import { PgArchitectureAssertionRepository } from '../../../src/modules/architecture/internal/pg-architecture-repository.js';
import {
  DefaultArchitectureCheckpointService,
  createDefaultDetectorRegistry,
  CHECKPOINT_RUN_SOURCE,
} from '../../../src/architecture-checkpoints/index.js';
import { generateExecutionId } from '@platform/ids.js';

/**
 * WORK-051 — the four architecture checkpoint LIFECYCLE GATES in the workflow
 * orchestrator.
 *
 * Mandatory proof 5 (issue #51): blocking checkpoint failures prevent the
 * relevant workflow transition. Plus: advisory results do not block (proof 6
 * at the lifecycle level), the fail-closed gate-error posture, the impact
 * policy through the REAL checkpoint service, and the end-to-end correction
 * loop (blocked → tree corrected → progression) driven by the real detectors.
 */
describe('WORK-051 — orchestrator architecture checkpoint gates', () => {
  let stack: TestAuthStack;
  let queue: InMemoryQueue;
  let workflowEngine: DefaultWorkflowEngine;
  let fakeAgent: FakeAgentAdapter;
  let fakeLlm: FakeLlmAdapter;
  let agentGateway: DefaultAgentGateway;
  let verificationService: DefaultVerificationService;
  let assertionRepo: PgArchitectureAssertionRepository;
  let org: { id: string };
  let user: { id: string };
  let project: { id: string };

  /** A scriptable gate: per-kind responses + an invocation log. */
  class ScriptedGate implements ArchitectureCheckpointGate {
    readonly calls: Array<Pick<ArchitectureCheckpointGateInput, 'checkpointKind' | 'workItemId' | 'implementationRevision'>> = [];
    private readonly responses = new Map<ArchitectureCheckpointKind, Partial<ArchitectureCheckpointGateResult>>();

    respond(kind: ArchitectureCheckpointKind, result: Partial<ArchitectureCheckpointGateResult>): void {
      this.responses.set(kind, result);
    }

    async evaluate(input: ArchitectureCheckpointGateInput): Promise<ArchitectureCheckpointGateResult> {
      this.calls.push({
        checkpointKind: input.checkpointKind,
        workItemId: input.workItemId,
        implementationRevision: input.implementationRevision ?? null,
      });
      const r = this.responses.get(input.checkpointKind);
      return {
        allowed: r?.allowed ?? true,
        applicable: r?.applicable ?? true,
        status: r?.status ?? 'passed',
        checkpointId: r?.checkpointId ?? null,
        reasons: r?.reasons ?? [],
      };
    }
  }

  const buildOrchestrator = (gate: ArchitectureCheckpointGate): DefaultWorkflowOrchestrator => {
    const logger = createLogger({ level: 'silent' });
    const llmGateway = new DefaultLlmGateway(stack.db.client, logger, [fakeLlm], 3);
    const architectService = new DefaultArchitectService(stack.db.client, llmGateway, stack.workOrderRepository, logger);
    const agentRunRepo = new PgAgentRunRepository(stack.db.client);
    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    return new DefaultWorkflowOrchestrator(
      stack.db.client, logger, queue, workflowEngine,
      stack.workItemRepository, stack.workOrderRepository, depService,
      stack.workItemCompletionService,
      stack.pullRequestAssociationRepository, agentGateway, agentRunRepo,
      architectService,
      verificationService, new DefaultReviewService(stack.db.client, stack.workItemRepository, logger),
      new DefaultGitHubAdapter(),
      stack.architectureVersionRepository, stack.architectureRepository,
      stack.projectRepository, gate, generateExecutionId,
    );
  };

  const state = async (workItemId: string) =>
    (await workflowEngine.getState(workItemId))?.currentState ?? null;

  /** Drive initiate synchronously (no worker; processSignal directly). */
  const initiate = async (orchestrator: DefaultWorkflowOrchestrator, workItemId: string) => {
    const signal = await orchestrator.initiateConvergence({
      workItemId,
      sourceEventId: `initiate-${generateExecutionId()}`,
      executionId: generateExecutionId(),
    });
    await orchestrator.processSignal(signal.id);
  };

  beforeAll(async () => {
    stack = await buildAuthStack({});
    queue = new InMemoryQueue();
    const logger = createLogger({ level: 'silent' });
    fakeAgent = new FakeAgentAdapter();
    agentGateway = new DefaultAgentGateway(stack.db.client, logger, [fakeAgent], 3);
    fakeLlm = new FakeLlmAdapter();
    // The architect fake returns a valid work-order candidate whenever the
    // orchestrator generates a Work Order during convergence.
    fakeLlm.setResponse(JSON.stringify({
      verdict: 'approve', summary: 'OK', reasoning: '',
      risks: [], constraints: [], corrections: [],
      architectureChangeRequired: false,
      workOrder: {
        scope: 'Implement', outOfScope: 'Nothing',
        constraints: 'Follow arch',
        requirementIds: [], criterionIds: [],
        verificationRequirements: [],
        implementationContext: {},
      },
    }));
    verificationService = new DefaultVerificationService(
      stack.db.client,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.workItemRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.ciEvidenceRepository,
      new InMemoryObjectStore(),
      logger,
    );
    assertionRepo = new PgArchitectureAssertionRepository(stack.db.client);
    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    workflowEngine = new DefaultWorkflowEngine(
      stack.db.client, logger,
      (wiId: string) => depService.canBeginImplementation(wiId),
    );

    org = await stack.organizationRepository.create({ name: 'Gate Org' });
    user = await stack.userRepository.upsertByExternalId({ externalId: 'gate-user', displayName: 'User' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Gate Project' });
  });

  afterAll(async () => {
    await stack.teardown();
  });

  const tempRoots: string[] = [];
  const makeTempTree = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'wfos-gates-'));
    tempRoots.push(root);
    return root;
  };
  afterAll(() => {
    for (const r of tempRoots) {
      try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
  const writeCleanTree = (root: string): void => {
    mkdirSync(join(root, 'src', 'modules', 'alpha', 'internal'), { recursive: true });
    writeFileSync(join(root, 'src', 'modules', 'alpha', 'index.ts'), 'export type { A } from \'./internal/a.types.js\';\n');
    writeFileSync(join(root, 'src', 'modules', 'alpha', 'internal', 'a.types.ts'), 'export interface A { x: number }\n');
  };
  const writeViolatingTree = (root: string): void => {
    writeCleanTree(root);
    mkdirSync(join(root, 'src', 'modules', 'beta', 'internal'), { recursive: true });
    writeFileSync(join(root, 'src', 'modules', 'beta', 'index.ts'), 'export type {}\n');
    writeFileSync(join(root, 'src', 'modules', 'beta', 'internal', 'b.types.ts'), 'export interface B { y: number }\n');
    writeFileSync(join(root, 'src', 'modules', 'alpha', 'internal', 'leak.ts'),
      "import type { B } from '@modules/beta/internal/b.types.js';\nexport const leak = (b: B): number => b.y;\n");
  };

  const frozenVersionWithAssertion = async (
    detectorConfig: Record<string, unknown>,
    severity: 'blocking' | 'advisory' = 'blocking',
  ): Promise<{ id: string }> => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'content' });
    await assertionRepo.create({
      architectureVersionId: v.id,
      assertionId: 'ARCH-GATE-001',
      severity,
      scope: 'repository',
      statement: 'gate rule',
      detectorKind: 'repository-structure',
      detectorConfig,
    });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    return v;
  };

  // --- PROOF 5: a blocking failure prevents the PR_OPEN transition ----------

  it('PROOF 5 — a BLOCKED pr_conformance gate prevents IMPLEMENTING → PR_OPEN (state stays implementing; no transition recorded)', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id, workItemId: `WI-${generateExecutionId()}`, title: 'PR gate proof',
    });

    const gate = new ScriptedGate();
    gate.respond('pr_conformance', { allowed: false, status: 'blocked', reasons: ['ARCH-GATE-001 [blocking/fail]: violation'] });
    const orchestrator = buildOrchestrator(gate);

    await initiate(orchestrator, wi.id);
    expect(await state(wi.id)).toBe('implementing'); // agent ran, but NO pr_open

    const history = await workflowEngine.getHistory(wi.id);
    expect(history.some((t) => t.toState === 'pr_open')).toBe(false);

    // The gate was invoked with the exact implementation revision the agent produced.
    const prCall = gate.calls.find((c) => c.checkpointKind === 'pr_conformance');
    expect(prCall).toBeTruthy();
    expect(prCall!.workItemId).toBe(wi.id);
    expect(prCall!.implementationRevision).toBe('abc123'); // FakeAgentAdapter's commitRef
  });

  // --- the other three gates -------------------------------------------------

  it('a BLOCKED readiness gate prevents READY → ASSIGNED (no assignment, no agent run)', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id, workItemId: `WI-${generateExecutionId()}`, title: 'readiness proof',
    });

    const gate = new ScriptedGate();
    gate.respond('readiness', { allowed: false, status: 'inconclusive', reasons: ['version not frozen'] });
    const orchestrator = buildOrchestrator(gate);

    const callsBefore = fakeAgent.getCallCount();
    await initiate(orchestrator, wi.id);
    expect(await state(wi.id)).toBe('ready'); // draft → ready happened, assignment did NOT
    expect(fakeAgent.getCallCount()).toBe(callsBefore); // no agent run launched
    const history = await workflowEngine.getHistory(wi.id);
    expect(history.some((t) => t.toState === 'assigned')).toBe(false);
  });

  it('a BLOCKED work_order gate prevents the agent run (stays ASSIGNED; work order already resolved)', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id, workItemId: `WI-${generateExecutionId()}`, title: 'work order proof',
    });

    const gate = new ScriptedGate();
    gate.respond('work_order', { allowed: false, status: 'blocked', reasons: ['scope violates assertion'] });
    const orchestrator = buildOrchestrator(gate);

    const callsBefore = fakeAgent.getCallCount();
    await initiate(orchestrator, wi.id);
    expect(await state(wi.id)).toBe('assigned'); // assignment happened; agent did NOT run
    expect(fakeAgent.getCallCount()).toBe(callsBefore);
  });

  it('a BLOCKED verification_entry gate prevents PR_OPEN → VERIFYING (typed denial; no verification run created)', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id, workItemId: `WI-${generateExecutionId()}`, title: 'verification entry proof',
    });

    const gate = new ScriptedGate(); // all gates permissive on the way up
    const orchestrator = buildOrchestrator(gate);
    await initiate(orchestrator, wi.id);
    expect(await state(wi.id)).toBe('pr_open');

    // Now block verification entry.
    gate.respond('verification_entry', { allowed: false, status: 'blocked', reasons: ['drift after last checkpoint'] });
    await expect(
      orchestrator.beginVerification({
        workItemId: wi.id,
        executionId: generateExecutionId(),
        sourceEventId: `begin-verify-${generateExecutionId()}`,
      }),
    ).rejects.toThrow(ArchitectureCheckpointGateDeniedError);

    expect(await state(wi.id)).toBe('pr_open'); // still PR_OPEN
    const runs = await verificationService.listRunsForWorkItem(wi.id);
    expect(runs.filter((r) => r.source !== CHECKPOINT_RUN_SOURCE)).toHaveLength(0); // no verification run
  });

  // --- advisory + fail-closed-error postures ----------------------------------

  it('PROOF 6 (lifecycle) — passed_with_advisories ALLOWS the transition', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id, workItemId: `WI-${generateExecutionId()}`, title: 'advisory proof',
    });

    const gate = new ScriptedGate();
    gate.respond('pr_conformance', { allowed: true, status: 'passed_with_advisories', reasons: ['advisory: docs drift'] });
    const orchestrator = buildOrchestrator(gate);
    await initiate(orchestrator, wi.id);
    expect(await state(wi.id)).toBe('pr_open');
  });

  it('a THROWING gate fails CLOSED (no transition on an unevaluable checkpoint)', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id, workItemId: `WI-${generateExecutionId()}`, title: 'gate error proof',
    });

    const throwingGate: ArchitectureCheckpointGate = {
      async evaluate() {
        throw new Error('checkpoint infrastructure down');
      },
    };
    const orchestrator = buildOrchestrator(throwingGate);
    await initiate(orchestrator, wi.id);
    // The readiness gate failed closed: the work item never left READY.
    expect(await state(wi.id)).toBe('ready');
  });

  // --- impact policy through the REAL checkpoint service ----------------------

  it('impact policy (real service) — a LOW-impact work item skips pre-implementation gates but still runs the PR checkpoint at full severity', async () => {
    const badRoot = makeTempTree();
    writeViolatingTree(badRoot);
    const v = await frozenVersionWithAssertion({ rootDir: badRoot });

    const lowWi = await stack.workItemRepository.create({
      architectureVersionId: v.id, workItemId: `WI-${generateExecutionId()}`, title: 'low impact',
      metadata: { architectureImpact: 'low' },
    });

    const realGate = new DefaultArchitectureCheckpointService({
      workItemReader: stack.workItemRepository,
      architectureVersionReader: stack.architectureVersionRepository,
      architectureReader: stack.architectureRepository,
      assertionReader: assertionRepo,
      verificationService,
      detectors: createDefaultDetectorRegistry(),
      logger: createLogger({ level: 'silent' }),
    });
    const orchestrator = buildOrchestrator(realGate);

    const callsBefore = fakeAgent.getCallCount();
    await initiate(orchestrator, lowWi.id);
    // The agent DID run (readiness/work_order skipped for LOW impact)…
    expect(fakeAgent.getCallCount()).toBe(callsBefore + 1);
    // …but the PR checkpoint ran WITH full severity and BLOCKED on the violation.
    expect(await state(lowWi.id)).toBe('implementing');

    // The blocked checkpoint left durable /verification evidence.
    const runs = await verificationService.listRunsForWorkItem(lowWi.id);
    const blocked = runs.filter((r) => r.source === CHECKPOINT_RUN_SOURCE && r.status === 'completed');
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked[0]!.summary.status).toBe('blocked');
  });

  // --- the end-to-end correction loop with the REAL service --------------------

  it('end-to-end (real service) — a violation blocks PR_OPEN, the corrected tree unblocks it (drift caught before PR creation; evidence is revision-bound)', async () => {
    const root = makeTempTree();
    writeViolatingTree(root);
    // The assertion is scoped to the PR conformance checkpoint via the
    // appliesToCheckpoints pre-filter (a pre-implementation tree scan is not
    // meaningful before the implementation exists).
    const v = await frozenVersionWithAssertion({
      rootDir: root,
      appliesToCheckpoints: ['pr_conformance'],
    });

    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id, workItemId: `WI-${generateExecutionId()}`, title: 'e2e correction',
    });

    const realGate = new DefaultArchitectureCheckpointService({
      workItemReader: stack.workItemRepository,
      architectureVersionReader: stack.architectureVersionRepository,
      architectureReader: stack.architectureRepository,
      assertionReader: assertionRepo,
      verificationService,
      detectors: createDefaultDetectorRegistry(),
      logger: createLogger({ level: 'silent' }),
    });
    const orchestrator = buildOrchestrator(realGate);

    // First attempt: the tree carries the violation → the PR checkpoint
    // blocks before PR_OPEN (drift caught BEFORE the PR exists).
    await initiate(orchestrator, wi.id);
    expect(await state(wi.id)).toBe('implementing');
    expect(fakeAgent.getCallCount()).toBeGreaterThanOrEqual(1);

    // The blocked evidence is durable + revision-bound.
    const afterBlock = await verificationService.listRunsForWorkItem(wi.id);
    const blockedRuns = afterBlock.filter(
      (r) => r.source === CHECKPOINT_RUN_SOURCE && r.status === 'completed',
    );
    expect(blockedRuns.length).toBeGreaterThanOrEqual(1);
    expect(blockedRuns[0]!.summary.status).toBe('blocked');

    // Correct the tree (the SAME frozen version + assertion set now passes).
    rmSync(join(root, 'src', 'modules', 'alpha', 'internal', 'leak.ts'), { force: true });

    // Re-drive via a trusted agent_run_completed signal for the fake run.
    const run = (await new PgAgentRunRepository(stack.db.client).findByWorkItem(wi.id))[0];
    expect(run).toBeTruthy();
    const signal = await orchestrator.submitAgentRunCompleted({
      workItemId: wi.id,
      agentRunId: run!.id,
      executionId: generateExecutionId(),
    });
    await orchestrator.processSignal(signal.id);

    // The corrected implementation now clears the PR conformance checkpoint.
    expect(await state(wi.id)).toBe('pr_open');

    // Both checkpoint results persist (blocked first, then passed) —
    // the correction is fully auditable.
    const afterFix = await verificationService.listRunsForWorkItem(wi.id);
    const statuses = afterFix
      .filter((r) => r.source === CHECKPOINT_RUN_SOURCE && r.status === 'completed')
      .map((r) => r.summary.status as string)
      .sort();
    expect(statuses).toContain('blocked');
    expect(statuses).toContain('passed');
  });
});
