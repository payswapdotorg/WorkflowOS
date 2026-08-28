import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { FakePullRequestCreationPort } from '../../helpers/fake-pr-creation-port.js';
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
import {
  DefaultAgentGateway,
  FakeAgentAdapter,
} from '../../../src/modules/agents/internal/agent-gateway.js';
import type {
  AgentProviderAdapter,
  AgentRequest,
  AgentExecutionResult,
} from '../../../src/modules/agents/internal/agent.types.js';
import { GovernedPullRequestService } from '../../../src/modules/workflows/internal/governed-pull-request-service.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import { DefaultLlmGateway, FakeLlmAdapter } from '../../../src/modules/llm/internal/llm-gateway.js';
import { DefaultArchitectService } from '../../../src/modules/llm/internal/architect-service.js';
import { DefaultVerificationService } from '../../../src/modules/verification/internal/verification-service.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import { DefaultGitHubAdapter } from '../../../src/modules/github/internal/pg-github-repository.js';
import { FakeGitHubAdapter } from '../../../src/modules/github/internal/fake-github-adapter.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';
import { PgArchitectureAssertionRepository } from '../../../src/modules/architecture/internal/pg-architecture-repository.js';
import {
  DefaultArchitectureCheckpointService,
  createDefaultDetectorRegistry,
  GithubRepositorySnapshotProvider,
  CHECKPOINT_RUN_SOURCE,
} from '../../../src/architecture-checkpoints/index.js';
import { generateExecutionId } from '@platform/ids.js';

/**
 * WORK-051 round 1 + round 2 — the architecture checkpoint LIFECYCLE GATES in
 * the workflow orchestrator, INCLUDING the actual PR-creation boundary
 * (PR #52 review, BLOCKER 1 + BLOCKER 2):
 *
 *   - the agent execution contract is STRUCTURALLY PR-INCAPABLE: a
 *     deliberately SIDE-EFFECTING provider (smuggled PR ref + capability
 *     probes) can neither create nor report a PR in the pre-gate phase;
 *   - with a BLOCKING architecture violation, the recorded PR-creation
 *     side-effect count is ZERO;
 *   - with a CONFORMANT revision, EXACTLY ONE PR is created and only AFTER
 *     the gate passes (event-order proof);
 *   - the governed PR creation is CRASH-SAFE + IDEMPOTENT across the
 *     external side effect (see governed-pr-creation.integration.test.ts);
 *   - the four lifecycle gates block their transitions (proof 5 + the
 *     readiness/work-order/verification-entry gates);
 *   - advisory results allow; a throwing gate fails closed;
 *   - the end-to-end correction loop (violation → new revision → pass).
 */
describe('WORK-051 — orchestrator architecture checkpoint gates + the PR-creation boundary', () => {
  let stack: TestAuthStack;
  let queue: InMemoryQueue;
  let workflowEngine: DefaultWorkflowEngine;
  let fakeAgent: FakeAgentAdapter;
  let fakeLlm: FakeLlmAdapter;
  let verificationService: DefaultVerificationService;
  let assertionRepo: PgArchitectureAssertionRepository;
  let fakeGithub: FakeGitHubAdapter;
  let snapshotProvider: GithubRepositorySnapshotProvider;
  let org: { id: string };
  let user: { id: string };
  let project: { id: string };
  const OWNER = 'gates-org';
  const REPO = 'gates-repo';

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

  /**
   * A gate wrapper that RECORDS evaluation events into a shared event log —
   * proves the gate ran BEFORE the PR-creation side effect (ordering).
   */
  class RecordingGate implements ArchitectureCheckpointGate {
    constructor(
      private readonly inner: ArchitectureCheckpointGate,
      private readonly events: Array<{ type: string; detail: string }>,
    ) {}

    async evaluate(input: ArchitectureCheckpointGateInput): Promise<ArchitectureCheckpointGateResult> {
      this.events.push({ type: 'gate', detail: `${input.checkpointKind}@${input.implementationRevision ?? 'no-rev'}` });
      return this.inner.evaluate(input);
    }
  }

  /** A recording PR-creation authority (the two-stage fake). */
  class RecordingPrPort extends FakePullRequestCreationPort {
    constructor(private readonly events: Array<{ type: string; detail: string }>) {
      super();
    }

    override async createPullRequest(input: {
      projectId: string;
      workItemId: string;
      headRevision: string;
      title: string;
      body?: string | null;
    }): Promise<{ externalPrId: string; headCommit: string | null }> {
      const result = await super.createPullRequest(input);
      this.events.push({ type: 'pr-create', detail: input.headRevision });
      return result;
    }
  }

  /** A scriptable agent provider: a settable commitRef. */
  class ScriptedAgentAdapter implements AgentProviderAdapter {
    readonly providerName = 'scripted';
    private commitRef = 'rev-corrupt';
    readonly calls: Array<{ executionId: string }> = [];

    setCommitRef(ref: string): void { this.commitRef = ref; }

    supports(provider: string): boolean { return provider === 'scripted'; }

    async execute(request: AgentRequest) {
      this.calls.push({ executionId: request.executionId });
      return {
        status: 'success' as const,
        output: 'scripted output',
        startedAt: new Date(),
        completedAt: new Date(),
        executionId: request.executionId,
        provider: this.providerName,
        configuration: request.configuration,
        commitRef: this.commitRef,
        reportedTests: [],
        reportedBlockers: [],
        error: null,
        metadata: {},
      };
    }
  }

  /**
   * PR #52 round 2 (BLOCKER 1) — a DELIBERATELY SIDE-EFFECTING provider.
   *
   * Constructed EXACTLY as production constructs agent adapters (zero
   * platform capabilities — createOpenAiAgentAdapterFromEnv grants nothing
   * but environment config), it attempts EVERY avenue a misbehaving
   * provider has during the pre-gate execution phase:
   *
   *   1. probes the request object for ANY function-valued property (a
   *      capability smuggled into the request would be a PR-creation
   *      avenue);
   *   2. records whatever capabilities its constructor received (none in
   *      the production construction shape);
   *   3. SMUGGLES a `pullRequestRef` onto its return value (type-laundered
   *      past the compiler) hoping it crosses the gateway boundary and
   *      enters the governed path.
   *
   * The regressions prove all attempts are structurally inert: there is no
   * capability to use, no channel to report through, and no side effect.
   */
  class SideEffectingAgentAdapter implements AgentProviderAdapter {
    readonly providerName = 'side-effecting';
    readonly probe = {
      /** Function-valued properties found on the request (capability probe). */
      requestFunctionProps: [] as string[],
      /** Capabilities the constructor was granted (none, production shape). */
      constructorCapabilities: [] as string[],
      /** Whether the smuggled PR ref was attached to the return value. */
      smuggledPrRefAttached: false,
    };

    supports(provider: string): boolean { return provider === 'side-effecting'; }

    async execute(request: AgentRequest): Promise<AgentExecutionResult> {
      // (1) Capability probe: is there ANY function on the request the
      // provider could invoke to cause a PR side effect?
      for (const [key, value] of Object.entries(request)) {
        if (typeof value === 'function') this.probe.requestFunctionProps.push(key);
      }
      // (2) The adapter was constructed with zero platform capabilities —
      // there is no PR-creation port, credential, or SDK to reach for.
      // (3) Smuggle a PR identity onto the return value — a runtime object
      // is not bound by the compile-time contract.
      this.probe.smuggledPrRefAttached = true;
      return {
        status: 'success' as const,
        output: 'side-effecting output',
        startedAt: new Date(),
        completedAt: new Date(),
        executionId: request.executionId,
        provider: this.providerName,
        configuration: request.configuration,
        commitRef: 'rev-smuggle',
        reportedTests: [],
        reportedBlockers: [],
        error: null,
        metadata: {},
        pullRequestRef: 'github:evil/smuggle#666',
      } as unknown as AgentExecutionResult;
    }
  }

  let scriptedAgent: ScriptedAgentAdapter;

  const buildOrchestrator = (
    gate: ArchitectureCheckpointGate,
    prPort: FakePullRequestCreationPort,
    agentAdapters: readonly import('../../../src/modules/agents/internal/agent.types.js').AgentProviderAdapter[] = [fakeAgent],
  ): DefaultWorkflowOrchestrator => {
    const logger = createLogger({ level: 'silent' });
    const gateway = new DefaultAgentGateway(stack.db.client, logger, agentAdapters, 3);
    const llmGateway = new DefaultLlmGateway(stack.db.client, logger, [fakeLlm], 3);
    const architectService = new DefaultArchitectService(stack.db.client, llmGateway, stack.workOrderRepository, logger);
    const agentRunRepo = new PgAgentRunRepository(stack.db.client);
    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    return new DefaultWorkflowOrchestrator(
      stack.db.client, logger, queue, workflowEngine,
      stack.workItemRepository, stack.workOrderRepository, depService,
      stack.workItemCompletionService,
      stack.pullRequestAssociationRepository, gateway, agentRunRepo,
      architectService,
      verificationService, new DefaultReviewService(stack.db.client, stack.workItemRepository, logger),
      new DefaultGitHubAdapter(),
      stack.architectureVersionRepository, stack.architectureRepository,
      stack.projectRepository, gate, generateExecutionId,
      // PR #52 round 2 (BLOCKER 2): the governed PR-creation boundary — the
      // durable create-or-converge protocol over the port (the fake).
      new GovernedPullRequestService(stack.db.client, prPort),
    );
  };

  const state = async (workItemId: string) =>
    (await workflowEngine.getState(workItemId))?.currentState ?? null;

  /** Drive initiate synchronously (no worker; processSignal directly). */
  const initiate = async (
    orchestrator: DefaultWorkflowOrchestrator,
    workItemId: string,
    agentProvider?: string,
  ) => {
    const signal = await orchestrator.initiateConvergence({
      workItemId,
      sourceEventId: `initiate-${generateExecutionId()}`,
      executionId: generateExecutionId(),
      ...(agentProvider ? { payload: { agentProvider } } : {}),
    });
    await orchestrator.processSignal(signal.id);
  };

  beforeAll(async () => {
    stack = await buildAuthStack({});
    queue = new InMemoryQueue();
    const logger = createLogger({ level: 'silent' });
    fakeAgent = new FakeAgentAdapter();
    scriptedAgent = new ScriptedAgentAdapter();
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
    fakeGithub = new FakeGitHubAdapter();
    snapshotProvider = new GithubRepositorySnapshotProvider(
      new PgProjectGitHubRepositoryRepository(stack.db.client),
      fakeGithub,
    );
    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    workflowEngine = new DefaultWorkflowEngine(
      stack.db.client, logger,
      (wiId: string) => depService.canBeginImplementation(wiId),
    );

    org = await stack.organizationRepository.create({ name: 'Gate Org' });
    user = await stack.userRepository.upsertByExternalId({ externalId: 'gate-user', displayName: 'User' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Gate Project' });

    // The project's /github repository link (server-side snapshot resolution)
    // + seeded exact-revision trees.
    const linkRepo = new PgProjectGitHubRepositoryRepository(stack.db.client);
    await linkRepo.create({
      projectId: project.id,
      installationId: 'inst-gates',
      owner: OWNER,
      repository: REPO,
      defaultBranch: 'main',
    });
  });

  afterAll(async () => {
    await stack.teardown();
  });

  // --- /github fixture seeding ------------------------------------------------

  const seedTree = (ref: string, files: Record<string, string>): void => {
    const dirs = new Map<string, Map<string, 'file' | 'dir'>>();
    const ensureDir = (dir: string): Map<string, 'file' | 'dir'> => {
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      return dirs.get(dir)!;
    };
    ensureDir('');
    for (const [path, content] of Object.entries(files)) {
      fakeGithub.setFile(OWNER, REPO, ref, path, content);
      const segments = path.split('/');
      const parent = segments.slice(0, -1).join('/');
      ensureDir(parent).set(segments[segments.length - 1]!, 'file');
      for (let i = segments.length - 2; i >= 0; i--) {
        const dirPath = segments.slice(0, i + 1).join('/');
        ensureDir(segments.slice(0, i).join('/')).set(segments[i]!, 'dir');
        ensureDir(dirPath);
      }
    }
    for (const [dir, entries] of dirs) {
      fakeGithub.setDir(
        OWNER, REPO, ref, dir,
        [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, type]) => ({ name, type })),
      );
    }
  };

  const cleanTree = (): Record<string, string> => ({
    'src/modules/alpha/index.ts': "export type { A } from './internal/a.types.js';\n",
    'src/modules/alpha/internal/a.types.ts': 'export interface A { x: number }\n',
  });
  const violatingTree = (): Record<string, string> => ({
    ...cleanTree(),
    'src/modules/beta/index.ts': 'export type {}\n',
    'src/modules/beta/internal/b.types.ts': 'export interface B { y: number }\n',
    'src/modules/alpha/internal/leak.ts':
      "import type { B } from '@modules/beta/internal/b.types.js';\nexport const leak = (b: B): number => b.y;\n",
  });

  const frozenVersionWithAssertion = async (
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
      detectorConfig: {},
    });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    return v;
  };

  const workItemOn = async (versionId: string) =>
    stack.workItemRepository.create({
      architectureVersionId: versionId,
      workItemId: `WI-${generateExecutionId()}`,
      title: 'gate proof',
    });

  const realService = () =>
    new DefaultArchitectureCheckpointService({
      workItemReader: stack.workItemRepository,
      architectureVersionReader: stack.architectureVersionRepository,
      architectureReader: stack.architectureRepository,
      assertionReader: assertionRepo,
      verificationService,
      snapshotReader: snapshotProvider,
      detectors: createDefaultDetectorRegistry(),
      logger: createLogger({ level: 'silent' }),
    });

  // --- BLOCKER 2: the PR-creation boundary (the required two-stage proof) ------

  it('BLOCKER 2 — with a BLOCKING architecture violation, the recorded PR-creation side-effect count is ZERO (state stays implementing)', async () => {
    seedTree('rev-corrupt', violatingTree());
    const v = await frozenVersionWithAssertion();
    const wi = await workItemOn(v.id);

    const events: Array<{ type: string; detail: string }> = [];
    const prPort = new RecordingPrPort(events);
    const orchestrator = buildOrchestrator(new RecordingGate(realService(), events), prPort, [scriptedAgent]);
    scriptedAgent.setCommitRef('rev-corrupt');

    await initiate(orchestrator, wi.id, 'scripted');

    // The agent phase ran (the PR-incapable execution contract — there is
    // no PR semantic the provider could produce)…
    expect(scriptedAgent.calls.length).toBeGreaterThanOrEqual(1);
    // …the gate evaluated the EXACT revision and BLOCKED…
    expect(events.some((e) => e.type === 'gate' && e.detail === 'pr_conformance@rev-corrupt')).toBe(true);
    // …and the PR authority recorded ZERO createPullRequest side effects.
    expect(prPort.calls).toHaveLength(0);
    expect(events.filter((e) => e.type === 'pr-create')).toHaveLength(0);
    // The work item stays IMPLEMENTING (no PR association, no PR_OPEN).
    expect(await state(wi.id)).toBe('implementing');
    const prs = await stack.pullRequestAssociationRepository.listForWorkItem(wi.id);
    expect(prs).toHaveLength(0);
    const history = await workflowEngine.getHistory(wi.id);
    expect(history.some((t) => t.toState === 'pr_open')).toBe(false);
  });

  it('BLOCKER 2 — with a CONFORMANT revision, EXACTLY ONE PR is created and only AFTER the gate passes (event order)', async () => {
    seedTree('rev-clean', cleanTree());
    const v = await frozenVersionWithAssertion();
    const wi = await workItemOn(v.id);

    const events: Array<{ type: string; detail: string }> = [];
    const prPort = new RecordingPrPort(events);
    const orchestrator = buildOrchestrator(new RecordingGate(realService(), events), prPort, [scriptedAgent]);
    scriptedAgent.setCommitRef('rev-clean');

    await initiate(orchestrator, wi.id, 'scripted');

    // Exactly one PR-creation side effect…
    expect(prPort.calls).toHaveLength(1);
    // …bound to the EXACT revision the gate evaluated…
    expect(prPort.calls[0]!.headRevision).toBe('rev-clean');
    // …and it happened AFTER the gate allowed it.
    const gateIndex = events.findIndex(
      (e) => e.type === 'gate' && e.detail === 'pr_conformance@rev-clean',
    );
    const createIndex = events.findIndex((e) => e.type === 'pr-create');
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(gateIndex);

    // The lifecycle completed: PR association + PR_OPEN.
    expect(await state(wi.id)).toBe('pr_open');
    const prs = await stack.pullRequestAssociationRepository.listForWorkItem(wi.id);
    expect(prs.length).toBe(1);
    expect(prs[0]!.headCommit).toBe('rev-clean');
  });

  it('BLOCKER 1 (round 2) — a SIDE-EFFECTING provider cannot create a PR in the pre-gate phase: no capability, no channel, no side effect', async () => {
    seedTree('rev-smuggle', cleanTree());
    const v = await frozenVersionWithAssertion();
    const wi = await workItemOn(v.id);

    const events: Array<{ type: string; detail: string }> = [];
    const prPort = new RecordingPrPort(events);
    // PRODUCTION CONSTRUCTION SHAPE: the adapter receives ZERO platform
    // capabilities (exactly what createOpenAiAgentAdapterFromEnv grants —
    // environment config only). It probes + smuggles anyway.
    const evilAgent = new SideEffectingAgentAdapter();
    const orchestrator = buildOrchestrator(new RecordingGate(realService(), events), prPort, [evilAgent]);

    await initiate(orchestrator, wi.id, 'side-effecting');

    // (a) The request the provider received is PURE DATA — no
    //     function-valued properties (no smuggled capability to invoke).
    expect(evilAgent.probe.requestFunctionProps).toEqual([]);
    // (b) The provider holds NO platform capability (constructed with none).
    expect(evilAgent.probe.constructorCapabilities).toEqual([]);
    // (c) ZERO PR side effects reached the /github authority from the agent
    //     phase (the fake's operation counter is empty — the only PR
    //     creation in the whole flow is the post-gate port call below).
    expect(fakeGithub.createPullRequestCalls).toHaveLength(0);
    // (d) The gate ran at the exact revision and ALLOWED; the ONLY PR
    //     creation is the post-gate governed port call — exactly one,
    //     strictly AFTER the gate event.
    expect(prPort.calls).toHaveLength(1);
    expect(prPort.calls[0]!.headRevision).toBe('rev-smuggle');
    const gateIndex = events.findIndex(
      (e) => e.type === 'gate' && e.detail === 'pr_conformance@rev-smuggle',
    );
    const createIndex = events.findIndex((e) => e.type === 'pr-create');
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(gateIndex);
    // (e) The SMUGGLED PR identity appears NOWHERE: not on any persisted
    //     agent run (the gateway membrane drops it), not in any association
    //     (the only association is the post-gate port PR), not in state.
    const runs = await new PgAgentRunRepository(stack.db.client).findByWorkItem(wi.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.some((r) => r.pullRequestRef === 'github:evil/smuggle#666')).toBe(false);
    for (const r of runs) expect(r.pullRequestRef).toBeNull();
    const prs = await stack.pullRequestAssociationRepository.listForWorkItem(wi.id);
    expect(prs.length).toBe(1);
    expect(prs[0]!.externalPrId).not.toBe('github:evil/smuggle#666');
    // The lifecycle completed through the LEGITIMATE boundary only.
    expect(await state(wi.id)).toBe('pr_open');
  });

  it('BLOCKER 1 (round 2, unit) — the gateway is the CAPABILITY MEMBRANE: a smuggled pullRequestRef cannot cross the provider boundary', async () => {
    const evil = new SideEffectingAgentAdapter();
    const logger = createLogger({ level: 'silent' });
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Membrane Arch' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    const wi = await workItemOn(v.id);
    // A REAL work order (the agent-run FK requires one).
    const wo = await stack.workOrderRepository.create({
      workItemId: wi.id, projectId: project.id, architectureVersionId: v.id,
    });
    const gateway = new DefaultAgentGateway(stack.db.client, logger, [evil], 3);
    const executionId = generateExecutionId();
    const result = await gateway.execute({
      provider: 'side-effecting',
      configuration: {},
      workItemId: wi.id,
      workOrderId: wo.id,
      executionId,
      input: 'impl',
    });
    // The provider DID attach the smuggled property to its return value…
    expect(evil.probe.smuggledPrRefAttached).toBe(true);
    // …but the gateway's returned result is the PROJECTED contract — the
    // property cannot cross the boundary (it does not exist on the result).
    expect('pullRequestRef' in result).toBe(false);
    expect((result as unknown as Record<string, unknown>).pullRequestRef).toBeUndefined();
    // …and the persisted AgentRun row records NO PR ref.
    const runRepo = new PgAgentRunRepository(stack.db.client);
    const run = await runRepo.findByExecutionId(executionId);
    expect(run).toBeTruthy();
    expect(run!.status).toBe('success');
    expect(run!.pullRequestRef).toBeNull();
  });

  it('BLOCKER 2 (agent_run_completed path) — the same boundary holds: gate FIRST, exactly one creation, external PR refs adopted only post-gate', async () => {
    seedTree('rev-arc-completed', cleanTree());
    const v = await frozenVersionWithAssertion();
    const wi = await workItemOn(v.id);

    const events: Array<{ type: string; detail: string }> = [];
    const prPort = new RecordingPrPort(events);
    const orchestrator = buildOrchestrator(new RecordingGate(realService(), events), prPort, [scriptedAgent]);

    // Drive to IMPLEMENTING with a violating revision: the gate blocks, no PR.
    seedTree('rev-arc-bad', violatingTree());
    scriptedAgent.setCommitRef('rev-arc-bad');
    await initiate(orchestrator, wi.id, 'scripted');
    expect(await state(wi.id)).toBe('implementing');
    expect(prPort.calls).toHaveLength(0);

    // The corrected revision arrives as a NEW agent run (the trusted
    // agent_run_completed signal carries the AUTHORITATIVE run record's
    // commitRef — so the run must actually be at the corrected revision).
    const wo = await stack.workOrderRepository.create({
      workItemId: wi.id, projectId: project.id, architectureVersionId: v.id,
    });
    scriptedAgent.setCommitRef('rev-arc-completed');
    const gateway = new DefaultAgentGateway(
      stack.db.client, createLogger({ level: 'silent' }), [scriptedAgent], 3,
    );
    await gateway.execute({
      provider: 'scripted',
      configuration: {},
      workItemId: wi.id,
      workOrderId: wo.id,
      architectureVersionId: v.id,
      executionId: generateExecutionId(),
      input: 'corrected implementation',
    });
    const runs = await new PgAgentRunRepository(stack.db.client).findByWorkItem(wi.id);
    const correctedRun = runs.find((r) => r.commitRef === 'rev-arc-completed');
    expect(correctedRun).toBeTruthy();

    const signal = await orchestrator.submitAgentRunCompleted({
      workItemId: wi.id,
      agentRunId: correctedRun!.id,
      executionId: generateExecutionId(),
    });
    await orchestrator.processSignal(signal.id);

    // Exactly ONE creation, after the gate, bound to the fixed revision.
    expect(prPort.calls).toHaveLength(1);
    expect(prPort.calls[0]!.headRevision).toBe('rev-arc-completed');
    expect(await state(wi.id)).toBe('pr_open');
  });

  it('BLOCKER 2 (round 2, workflow crash/retry) — a crash AFTER the external PR create converges on re-drive: same PR, no second create, no duplicate association', async () => {
    seedTree('rev-crash-retry', cleanTree());
    const v = await frozenVersionWithAssertion();
    const wi = await workItemOn(v.id);

    /**
     * A switchable PR port: the underlying fake performs the real
     * create side effect; the wrapper can "kill the process" AFTER the
     * external create (before the durable record + association + PR_OPEN).
     */
    class SwitchableCrashPort extends FakePullRequestCreationPort {
      crashAfterCreate = false;
      override async createPullRequest(input: {
        projectId: string; workItemId: string; headRevision: string; title: string; body?: string | null;
      }): Promise<{ externalPrId: string; headCommit: string | null }> {
        const created = await super.createPullRequest(input); // the side effect happens
        if (this.crashAfterCreate) {
          throw new Error('simulated process death AFTER the external PR create');
        }
        return created;
      }
    }

    const events: Array<{ type: string; detail: string }> = [];
    const prPort = new SwitchableCrashPort();
    const orchestrator = buildOrchestrator(new RecordingGate(realService(), events), prPort, [scriptedAgent]);

    // Drive to IMPLEMENTING with a violating revision first (the gate
    // blocks — no PR; the work item sits in implementing awaiting a new
    // agent run, exactly the state in which a re-drive after a crash lands).
    seedTree('rev-crash-bad', violatingTree());
    scriptedAgent.setCommitRef('rev-crash-bad');
    await initiate(orchestrator, wi.id, 'scripted');
    expect(await state(wi.id)).toBe('implementing');
    expect(prPort.calls).toHaveLength(0);

    // The agent run at the conformance-passing revision.
    const wo = await stack.workOrderRepository.create({
      workItemId: wi.id, projectId: project.id, architectureVersionId: v.id,
    });
    scriptedAgent.setCommitRef('rev-crash-retry');
    const gateway = new DefaultAgentGateway(
      stack.db.client, createLogger({ level: 'silent' }), [scriptedAgent], 3,
    );
    await gateway.execute({
      provider: 'scripted',
      configuration: {},
      workItemId: wi.id,
      workOrderId: wo.id,
      architectureVersionId: v.id,
      executionId: generateExecutionId(),
      input: 'crash-retry implementation',
    });
    const runs = await new PgAgentRunRepository(stack.db.client).findByWorkItem(wi.id);
    const run = runs.find((r) => r.commitRef === 'rev-crash-retry');
    expect(run).toBeTruthy();
    // FIRST drive: the external PR create SUCCEEDS, then the process dies
    // before the durable record — the work item stays IMPLEMENTING with NO
    // association (the transaction rolled back).
    prPort.crashAfterCreate = true;
    const signal = await orchestrator.submitAgentRunCompleted({
      workItemId: wi.id,
      agentRunId: run!.id,
      executionId: generateExecutionId(),
    });
    await orchestrator.processSignal(signal.id);
    expect(await state(wi.id)).toBe('implementing');
    expect(prPort.calls).toHaveLength(1); // the external create DID happen
    let prs = await stack.pullRequestAssociationRepository.listForWorkItem(wi.id);
    expect(prs).toHaveLength(0); // …but nothing was durably recorded

    // The RETRY (the convergence model reprocesses after failure/restart):
    // a NEW agent run drives the SAME implementation revision (the same
    // convergence key). The governed boundary must CONVERGE on the PR the
    // crashed attempt created — never open a second one.
    prPort.crashAfterCreate = false;
    await gateway.execute({
      provider: 'scripted',
      configuration: {},
      workItemId: wi.id,
      workOrderId: wo.id,
      architectureVersionId: v.id,
      executionId: generateExecutionId(),
      input: 'crash-retry re-drive (same revision)',
    });
    const runsAfter = await new PgAgentRunRepository(stack.db.client).findByWorkItem(wi.id);
    const reDriveRun = runsAfter.find(
      (r) => r.commitRef === 'rev-crash-retry' && r.id !== run!.id,
    );
    expect(reDriveRun).toBeTruthy();
    const retrySignal = await orchestrator.submitAgentRunCompleted({
      workItemId: wi.id,
      agentRunId: reDriveRun!.id,
      executionId: generateExecutionId(),
    });
    await orchestrator.processSignal(retrySignal.id);

    // Still EXACTLY ONE external create; ONE association; the lifecycle
    // completed through the converged PR.
    expect(prPort.calls).toHaveLength(1);
    expect(prPort.findCalls.length).toBeGreaterThanOrEqual(1); // the convergence read
    prs = await stack.pullRequestAssociationRepository.listForWorkItem(wi.id);
    expect(prs.length).toBe(1);
    expect(prs[0]!.externalPrId).toBe('github:owner/repo#1'); // the crashed attempt's PR
    expect(prs[0]!.headCommit).toBe('rev-crash-retry');
    expect(await state(wi.id)).toBe('pr_open');
  });

  // --- PROOF 5: a blocking failure prevents the PR_OPEN transition ------------

  it('PROOF 5 — a BLOCKED pr_conformance gate prevents IMPLEMENTING → PR_OPEN (state stays implementing; no transition recorded)', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id, workItemId: `WI-${generateExecutionId()}`, title: 'PR gate proof',
    });

    const gate = new ScriptedGate();
    gate.respond('pr_conformance', { allowed: false, status: 'blocked', reasons: ['ARCH-GATE-001 [blocking/fail]: violation'] });
    const prPort = new FakePullRequestCreationPort();
    const orchestrator = buildOrchestrator(gate, prPort);

    await initiate(orchestrator, wi.id);
    expect(await state(wi.id)).toBe('implementing'); // agent ran, but NO pr_open
    // ZERO PR creations under the denied gate.
    expect(prPort.calls).toHaveLength(0);

    const history = await workflowEngine.getHistory(wi.id);
    expect(history.some((t) => t.toState === 'pr_open')).toBe(false);

    // The gate was invoked with the exact implementation revision the agent produced.
    const prCall = gate.calls.find((c) => c.checkpointKind === 'pr_conformance');
    expect(prCall).toBeTruthy();
    expect(prCall!.workItemId).toBe(wi.id);
    expect(prCall!.implementationRevision).toBe('abc123'); // FakeAgentAdapter's commitRef
  });

  // --- the other three gates ---------------------------------------------------

  it('a BLOCKED readiness gate prevents READY → ASSIGNED (no assignment, no agent run)', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id, workItemId: `WI-${generateExecutionId()}`, title: 'readiness proof',
    });

    const gate = new ScriptedGate();
    gate.respond('readiness', { allowed: false, status: 'inconclusive', reasons: ['version not frozen'] });
    const orchestrator = buildOrchestrator(gate, new FakePullRequestCreationPort());

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
    const orchestrator = buildOrchestrator(gate, new FakePullRequestCreationPort());

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
    const orchestrator = buildOrchestrator(gate, new FakePullRequestCreationPort());
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

  // --- advisory + fail-closed-error postures ------------------------------------

  it('PROOF 6 (lifecycle) — passed_with_advisories ALLOWS the transition (the PR is created post-gate)', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id, workItemId: `WI-${generateExecutionId()}`, title: 'advisory proof',
    });

    const gate = new ScriptedGate();
    gate.respond('pr_conformance', { allowed: true, status: 'passed_with_advisories', reasons: ['advisory: docs drift'] });
    const prPort = new FakePullRequestCreationPort();
    const orchestrator = buildOrchestrator(gate, prPort);
    await initiate(orchestrator, wi.id);
    expect(await state(wi.id)).toBe('pr_open');
    expect(prPort.calls).toHaveLength(1); // the PR creation happened (post-gate)
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
    const orchestrator = buildOrchestrator(throwingGate, new FakePullRequestCreationPort());
    await initiate(orchestrator, wi.id);
    // The readiness gate failed closed: the work item never left READY.
    expect(await state(wi.id)).toBe('ready');
  });

  // --- impact policy through the REAL checkpoint service ------------------------

  it('impact policy (real service) — a LOW-impact work item skips pre-implementation gates but still runs the PR checkpoint at full severity', async () => {
    seedTree('rev-impact-low', violatingTree());
    const v = await frozenVersionWithAssertion();

    const lowWi = await stack.workItemRepository.create({
      architectureVersionId: v.id, workItemId: `WI-${generateExecutionId()}`, title: 'low impact',
      architectureImpact: 'low',
    });

    const orchestrator = buildOrchestrator(realService(), new FakePullRequestCreationPort(), [scriptedAgent]);
    scriptedAgent.setCommitRef('rev-impact-low');

    const callsBefore = scriptedAgent.calls.length;
    await initiate(orchestrator, lowWi.id, 'scripted');
    // The agent DID run (readiness/work_order skipped for LOW impact)…
    expect(scriptedAgent.calls.length).toBe(callsBefore + 1);
    // …but the PR checkpoint ran WITH full severity and BLOCKED on the violation.
    expect(await state(lowWi.id)).toBe('implementing');

    // The blocked checkpoint left durable /verification evidence.
    const runs = await verificationService.listRunsForWorkItem(lowWi.id);
    const blocked = runs.filter((r) => r.source === CHECKPOINT_RUN_SOURCE && r.status === 'completed');
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked[0]!.summary.status).toBe('blocked');
  });

  // --- the end-to-end correction loop with the REAL service ----------------------

  it('end-to-end (real service) — a violation blocks PR creation; the corrected REVISION unblocks it (both results durable + revision-bound)', async () => {
    seedTree('rev-e2e-bad', violatingTree());
    seedTree('rev-e2e-good', cleanTree());
    const v = await frozenVersionWithAssertion();
    const wi = await workItemOn(v.id);

    const events: Array<{ type: string; detail: string }> = [];
    const prPort = new RecordingPrPort(events);
    const orchestrator = buildOrchestrator(new RecordingGate(realService(), events), prPort, [scriptedAgent]);

    // First attempt: the implementation revision carries the violation →
    // the gate blocks; ZERO PR-creation side effects.
    scriptedAgent.setCommitRef('rev-e2e-bad');
    await initiate(orchestrator, wi.id, 'scripted');
    expect(await state(wi.id)).toBe('implementing');
    expect(prPort.calls).toHaveLength(0);

    // The blocked evidence is durable + revision-bound.
    const afterBlock = await verificationService.listRunsForWorkItem(wi.id);
    const blockedRuns = afterBlock.filter(
      (r) => r.source === CHECKPOINT_RUN_SOURCE && r.status === 'completed',
    );
    expect(blockedRuns.length).toBeGreaterThanOrEqual(1);
    expect(blockedRuns[0]!.summary.status).toBe('blocked');
    expect(blockedRuns[0]!.metadata.implementationRevision).toBe('rev-e2e-bad');

    // The correction: the work item cycles through review (the same legal
    // transition path the orchestrator drives) and re-enters the correction
    // implementation path with a NEW revision.
    scriptedAgent.setCommitRef('rev-e2e-good');
    await workflowEngine.transition({ workItemId: wi.id, toState: 'pr_open' }); // test setup (the engine's own authority)
    await workflowEngine.transition({ workItemId: wi.id, toState: 'verifying' });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'architect_review' });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'changes_requested' });

    // Re-initiate the convergence: changes_requested → implementing → agent
    // run at the corrected revision → gate PASSES → exactly ONE PR creation.
    await initiate(orchestrator, wi.id, 'scripted');
    expect(prPort.calls).toHaveLength(1);
    expect(prPort.calls[0]!.headRevision).toBe('rev-e2e-good');
    expect(await state(wi.id)).toBe('pr_open');

    // Both checkpoint results persist (blocked first, then passed) — the
    // correction is fully auditable.
    const afterFix = await verificationService.listRunsForWorkItem(wi.id);
    const statuses = afterFix
      .filter((r) => r.source === CHECKPOINT_RUN_SOURCE && r.status === 'completed')
      .map((r) => r.summary.status as string)
      .sort();
    expect(statuses).toContain('blocked');
    expect(statuses).toContain('passed');
  });
});
