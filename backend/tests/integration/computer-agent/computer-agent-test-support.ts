/**
 * V2-008 — shared integration test support (NOT a test file).
 *
 * The REAL stack (mirrors the V2-005 run-test-support harness composition):
 *   - real PGlite (all 61 migrations) through buildAuthStack;
 *   - the real V2-002 workflow-repository service (the runtime's read-only
 *     version-fetch seam — real workflow/version rows, real content pins);
 *   - the real V2-005 DefaultWorkflowRunService as the runtime's
 *     ComputerAgentRunRecorder (structurally satisfied — NO adapter code),
 *     with an INJECTED stepping clock at fixed base epoch and epoch 7;
 *   - the real V2-004 DefaultNodeCapabilityService (hosts register through
 *     the REAL registration protocol via registerComputerHost);
 *   - REAL Ed25519 attester key pairs (the merged V2-014 barrel) on the
 *     adapters that declare attestation support.
 *
 * DETERMINISM: every clock is injected (stepping agent clock + stepping run
 * clock, fixed base 1_788_264_000_000 = 2026-09-01T12:00:00.000Z, step
 * 1000ms); every node key seed is a fixed string (node ids derive
 * deterministically from the sha-256 of the seed); every workflow input and
 * trigger id is a fixed string. No wall clock, no randomness in the drives —
 * the Ed25519 key pairs are real cryptography with key-normalized assertions
 * (the V2-008 unit-battery discipline).
 */
import { createHash } from 'node:crypto';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
  type WorkflowRepositoryService,
  type WorkflowPrincipal,
} from '../../../src/workflow-repository/index.js';
import {
  DefaultWorkflowRunService,
  createSteppingRunClock,
  type RunCommandEnvelope,
  type WorkflowRun,
  type WorkflowRunClock,
  type WorkflowRunService,
} from '../../../src/workflow-runs/index.js';
import {
  createWorkflowIrBuilder,
  serializeWorkflowIrDocument,
  computeWorkflowVersionSemanticDigest,
  type WorkflowIrDocument,
  type WorkflowNode,
} from '../../../src/workflow-ir/index.js';
import {
  ComputerAgentRuntime,
  DesktopHostAdapter,
  MobileHostAdapter,
  WebBrowserHostAdapter,
  registerComputerHost,
  ScriptedBrowserEnvironment,
  ScriptedDesktopEnvironment,
  ScriptedMobileEnvironment,
  createSteppingAgentClock,
  type AgentDecider,
  type AttestingComputerHost,
  type BrowserPageElement,
  type ComputerAgentPolicy,
  type DesktopEnvironment,
  type ComputerAgentRunRecorder,
  type ComputerHostAdapter,
} from '../../../src/computer-agent/index.js';
import {
  DefaultNodeCapabilityService,
  type CapabilityAdvertisement,
  type NodeCapabilityService,
  type NodePlatformClass,
  type NodeRequirementSet,
} from '../../../src/node-capability/index.js';
import {
  InMemoryReplayRegistry,
  generateAttesterKeyPair,
  type AttesterKeyPair,
  type ExecutionAttestation,
  type ExecutionStatement,
  type ReplayRegistry,
} from '../../../src/execution-attestation/index.js';

/** Deterministic clock base: 2026-09-01T12:00:00.000Z (no Date API). */
export const AGENT_CLOCK_BASE_MS = 1_788_264_000_000;
/** Deterministic per-call clock step. */
export const AGENT_CLOCK_STEP_MS = 1000;
/** The fixed attestation-freshness protocol epoch of every drive. */
export const AGENT_TEST_EPOCH = 7;

/** sha-256 hex over a fixed test value (real one-way commitment). */
export function commitmentOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The canonical filesystem grant pair every default policy carries. */
export const DEFAULT_SAFE_ACTION_GRANTS = [
  { capability: 'filesystem.read', scope: 'run' as const },
  { capability: 'filesystem.write', scope: 'run' as const },
  { capability: 'phone.call.answer', scope: 'run' as const },
];

// ============================================================================
// §1 The IR documents (authored through the merged V2-003 builder)
// ============================================================================

/** One agentic filesystem step: observe → grounded write → verify. */
export function buildAgenticWriteDocument(options: { stepId?: string; task?: string } = {}): WorkflowIrDocument {
  const stepId = options.stepId ?? 'organize';
  const node: WorkflowNode = {
    id: stepId,
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: options.task ?? 'Write the triage report to the given path' },
    capabilityRequirements: ['filesystem.read', 'filesystem.write'],
    placement: 'device_local',
    inputs: [{ name: 'reportPath', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'reportPath' } }],
    outputs: [{ name: 'written', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart(stepId)
    .addWorkflowInput({ name: 'reportPath', type: { kind: 'string' } })
    .addNode(node)
    .build();
}

/**
 * The approval flow: agentic write → HUMAN approval pause point → the
 * declared post-approval notification step (both declared outcomes covered —
 * the V2-003 IR_HUMAN_OUTCOME_UNCOVERED discipline).
 */
export function buildApprovalFlowDocument(): WorkflowIrDocument {
  const organize: WorkflowNode = {
    id: 'organize',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Write the triage report to the given path' },
    capabilityRequirements: ['filesystem.read', 'filesystem.write'],
    placement: 'device_local',
    inputs: [{ name: 'reportPath', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'reportPath' } }],
    outputs: [{ name: 'written', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const approve: WorkflowNode = {
    id: 'approve',
    executionClass: 'human',
    spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve posting the triage report.' } },
    capabilityRequirements: [],
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'human_confirmation',
  };
  const notify: WorkflowNode = {
    // the post-approval notification step (fixture: a deterministic
    // filesystem flag-write the attached desktop host can really execute —
    // the notify semantics are the pause-approval test's, not messaging's)
    id: 'notify',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'filesystem.write' },
    capabilityRequirements: ['filesystem.write'],
    placement: 'device_local',
    inputs: [
      { name: 'path', type: { kind: 'string' }, binding: { kind: 'literal', value: 'reports/notified.flag' } },
      { name: 'content', type: { kind: 'string' }, binding: { kind: 'literal', value: 'TRIAGE APPROVED' } },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('organize')
    .addWorkflowInput({ name: 'reportPath', type: { kind: 'string' } })
    .addNode(organize)
    .addNode(approve)
    .addNode(notify)
    .addEdge({ from: 'organize', to: 'approve', on: 'success' })
    .addEdge({ from: 'approve', to: 'notify', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve', to: 'notify', on: { outcome: 'rejected' } })
    .build();
}

/** One agentic browser step: observe the page → grounded click → verify. */
export function buildBrowserClickDocument(): WorkflowIrDocument {
  const node: WorkflowNode = {
    id: 'submit_form',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Submit the triage form through the browser' },
    capabilityRequirements: ['browser.observe', 'browser.click'],
    placement: 'cloud_allowed',
    inputs: [{ name: 'formUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'formUrl' } }],
    outputs: [{ name: 'submitted', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('submit_form')
    .addWorkflowInput({ name: 'formUrl', type: { kind: 'string' } })
    .addNode(node)
    .build();
}

/** One agentic phone step: observe the call log → grounded answer → verify. */
export function buildMobileAnswerDocument(): WorkflowIrDocument {
  const node: WorkflowNode = {
    id: 'answer_call',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Answer the incoming call from the on-call engineer' },
    capabilityRequirements: ['phone.call.observe', 'phone.call.answer'],
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'answered', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder().withStart('answer_call').addNode(node).build();
}

/**
 * The multi-host flow: one browser step (web host) then one filesystem step
 * (desktop host) — capability sets steer each step to a DIFFERENT host
 * through the merged V2-004 matcher.
 */
export function buildMultiHostDocument(): WorkflowIrDocument {
  const collect: WorkflowNode = {
    id: 'collect',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Submit the triage form through the browser' },
    capabilityRequirements: ['browser.observe', 'browser.click'],
    placement: 'cloud_allowed',
    inputs: [{ name: 'formUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'formUrl' } }],
    outputs: [{ name: 'submitted', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const fileStep: WorkflowNode = {
    id: 'file_step',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Write the collected report to the given path' },
    capabilityRequirements: ['filesystem.read', 'filesystem.write'],
    placement: 'device_local',
    inputs: [{ name: 'reportPath', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'reportPath' } }],
    outputs: [{ name: 'written', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('collect')
    .addWorkflowInput({ name: 'formUrl', type: { kind: 'string' } })
    .addWorkflowInput({ name: 'reportPath', type: { kind: 'string' } })
    .addNode(collect)
    .addNode(fileStep)
    .addEdge({ from: 'collect', to: 'file_step', on: 'success' })
    .build();
}

/** One cloud-only agentic step (cloud_required — hard locality). */
export function buildCloudOnlyDocument(): WorkflowIrDocument {
  const node: WorkflowNode = {
    id: 'notify_channel',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Send the approved summary to the team channel' },
    capabilityRequirements: ['messaging.send'],
    placement: 'cloud_required',
    inputs: [],
    outputs: [{ name: 'sent', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder().withStart('notify_channel').addNode(node).build();
}

// ============================================================================
// §2 The deterministic deciders
// ============================================================================

/**
 * The canonical filesystem drive: observe absent → grounded write → verify.
 * The target path comes from the step's resolved INPUT (the workflow input
 * binding) — the parameter is only the default when no input is bound.
 */
export function createObserveWriteVerifyDecider(options: {
  readonly reportPath: string;
  readonly content: string;
}): AgentDecider {
  const { content } = options;
  return (ctx) => {
    const reportPath =
      typeof ctx.inputs.reportPath === 'string' && ctx.inputs.reportPath.length > 0
        ? ctx.inputs.reportPath
        : options.reportPath;
    if (ctx.observation === null) {
      return { decision: 'observe', capability: 'filesystem.read', subject: reportPath };
    }
    const writeSucceeded = ctx.history.some((record) => record.capability === 'filesystem.write' && record.ok);
    if (!writeSucceeded) {
      const target = ctx.observation.elements.find((element) => element.elementId === reportPath);
      return {
        decision: 'act',
        capability: 'filesystem.write',
        grounding: target
          ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest }
          : null,
        parameters: { path: reportPath, content },
      };
    }
    return {
      decision: 'complete',
      verify: { capability: 'filesystem.read', subject: reportPath, expect: { elementId: reportPath, state: content } },
      outputs: { written: true },
    };
  };
}

/** A decider that requests human takeover at its first decision. */
export function createTakeoverDecider(reason: string): AgentDecider {
  return () => ({ decision: 'takeover', reason });
}

// ============================================================================
// §3 The test stack (real PGlite + real services)
// ============================================================================

/** One authored workflow version in the real repository. */
export interface AuthoredWorkflow {
  readonly workflowId: string;
  readonly versionId: string;
  /** The V2-003 semantic digest of the pinned version content. */
  readonly semanticDigest: string;
}

export interface ComputerAgentTestStack {
  readonly stack: TestAuthStack;
  readonly repository: WorkflowRepositoryService;
  /** The shared real V2-005 run service (the runtime's recorder). */
  readonly runService: WorkflowRunService;
  /** The shared V2-004 node directory (tests scope their own fresh ones). */
  readonly nodes: DefaultNodeCapabilityService;
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly principal: WorkflowPrincipal;
  /** A second organization + its owner principal (determinism drives). */
  createOrganization(name: string, externalId: string): Promise<{
    orgId: string;
    userId: string;
    principal: WorkflowPrincipal;
  }>;
  /** The shared stepping agent clock (fixed base, 1000ms step). */
  readonly agentClock: () => string;
  /** A FRESH stepping agent clock at the fixed base (determinism drives). */
  freshAgentClock(): () => string;
  /** A FRESH real run service instance over the SAME database. */
  freshRunService(): WorkflowRunService;
  /** A FRESH in-memory V2-004 node directory (per-test host scoping). */
  freshNodeDirectory(): DefaultNodeCapabilityService;
  /** Author one workflow version through the real V2-002 repository. */
  authorWorkflow(options: {
    document: WorkflowIrDocument;
    slug: string;
    organizationId?: string;
    principal?: WorkflowPrincipal;
  }): Promise<AuthoredWorkflow>;
  /** Request one run through the real V2-005 service (returns the run). */
  requestRun(options: {
    workflowId: string;
    versionId: string;
    triggerId: string;
    principal?: WorkflowPrincipal;
    organizationId?: string;
    inputCommitmentValues?: readonly string[];
  }): Promise<WorkflowRun>;
  /** Compose the real ComputerAgentRuntime over the real stack. */
  createRuntime(options?: {
    nodes?: NodeCapabilityService;
    recorder?: ComputerAgentRunRecorder;
    clock?: () => string;
    epoch?: number;
    replayRegistry?: ReplayRegistry;
    policy?: Partial<ComputerAgentPolicy>;
  }): ComputerAgentRuntime;
  /** Register + attach a desktop host (REAL V2-004 registration). */
  attachDesktopHost(options: {
    nodes: NodeCapabilityService;
    keySeed: string;
    /** Any DesktopEnvironment port implementation (scripted OR real-fs). */
    environment: DesktopEnvironment;
    attesterKey?: AttesterKeyPair;
    capabilities?: readonly CapabilityAdvertisement[];
    /** The host adapter clock (defaults to the stack's shared agent clock). */
    clock?: () => string;
  }): { host: DesktopHostAdapter; nodeId: string; sessionToken: string };
  /** Register + attach a web (browser) host (REAL V2-004 registration). */
  attachWebHost(options: {
    nodes: NodeCapabilityService;
    keySeed: string;
    environment: ScriptedBrowserEnvironment;
    attesterKey?: AttesterKeyPair;
    capabilities?: readonly CapabilityAdvertisement[];
    /** The host adapter clock (defaults to the stack's shared agent clock). */
    clock?: () => string;
  }): { host: WebBrowserHostAdapter; nodeId: string; sessionToken: string };
  /** Register + attach a mobile (phone) host (REAL V2-004 registration). */
  attachMobileHost(options: {
    nodes: NodeCapabilityService;
    keySeed: string;
    environment: ScriptedMobileEnvironment;
    attesterKey?: AttesterKeyPair;
    capabilities?: readonly CapabilityAdvertisement[];
    /** The host adapter clock (defaults to the stack's shared agent clock). */
    clock?: () => string;
  }): { host: MobileHostAdapter; nodeId: string; sessionToken: string };
  /** Register a CLOUD node (no adapter — the never-routed locality probe). */
  registerCloudNode(options: {
    nodes: NodeCapabilityService;
    keySeed: string;
    capabilities: readonly CapabilityAdvertisement[];
  }): { nodeId: string; sessionToken: string };
  /** The default runtime policy (overridable per test). */
  defaultPolicy(): ComputerAgentPolicy;
  teardown(): Promise<void>;
}

export async function buildComputerAgentTestStack(): Promise<ComputerAgentTestStack> {
  const stack = await buildAuthStack({});
  const memberships: OrganizationMembershipResolver = {
    isMember: async (userId, organizationId) =>
      (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
  };
  const repository = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });

  const org = await stack.organizationRepository.create({ name: 'V2-008 Org A' });
  const owner = await stack.userRepository.upsertByExternalId({
    externalId: 'v2-008-owner-a',
    displayName: 'Owner A',
  });
  await stack.membershipRepository.assign({ userId: owner.id, organizationId: org.id, roleId: 'owner' });

  // ONE shared stepping clock for the run service, the runtime and every
  // host adapter: all timestamp producers and the verifying boundary stay
  // coherent (a divergent second stepper would fabricate clock skew far
  // beyond any honest validity window — the unit battery covers skew via
  // the staleness/rejection paths instead).
  const runClock: WorkflowRunClock = createSteppingRunClock(AGENT_CLOCK_BASE_MS, AGENT_CLOCK_STEP_MS);
  const runService = new DefaultWorkflowRunService({
    db: stack.db.client,
    memberships,
    workflowRepository: repository,
    clock: runClock,
    currentEpoch: AGENT_TEST_EPOCH,
  });
  const agentClock: () => string = () => runClock.now();
  const nodes = new DefaultNodeCapabilityService({ clock: () => AGENT_CLOCK_BASE_MS });

  const defaultPolicy = (): ComputerAgentPolicy => ({
    maxActionsPerStep: 12,
    maxObservationAgeMs: 60_000,
    maxRecoveryCyclesPerStep: 4,
    safeAction: { grants: [...DEFAULT_SAFE_ACTION_GRANTS] },
    attestation: { required: false, validityMs: 3_600_000 },
  });

  const stackApi: ComputerAgentTestStack = {
    stack,
    repository,
    runService,
    nodes,
    orgId: org.id,
    ownerUserId: owner.id,
    principal: { userId: owner.id },
    createOrganization: async (name, externalId) => {
      const newOrg = await stack.organizationRepository.create({ name });
      const newOwner = await stack.userRepository.upsertByExternalId({
        externalId,
        displayName: name,
      });
      await stack.membershipRepository.assign({ userId: newOwner.id, organizationId: newOrg.id, roleId: 'owner' });
      return { orgId: newOrg.id, userId: newOwner.id, principal: { userId: newOwner.id } };
    },
    agentClock,
    freshAgentClock: () => createSteppingAgentClock(AGENT_CLOCK_BASE_MS, AGENT_CLOCK_STEP_MS),
    freshRunService: () =>
      new DefaultWorkflowRunService({
        db: stack.db.client,
        memberships,
        workflowRepository: repository,
        clock: createSteppingRunClock(AGENT_CLOCK_BASE_MS, AGENT_CLOCK_STEP_MS),
        currentEpoch: AGENT_TEST_EPOCH,
      }),
    freshNodeDirectory: () => new DefaultNodeCapabilityService({ clock: () => AGENT_CLOCK_BASE_MS }),
    authorWorkflow: async (options) => {
      const principal = options.principal ?? stackApi.principal;
      const organizationId = options.organizationId ?? stackApi.orgId;
      const created = await repository.createWorkflow(principal, {
        organizationId,
        slug: options.slug,
        name: `V2-008 ${options.slug}`,
        description: null,
        visibility: 'organization',
        content: JSON.parse(serializeWorkflowIrDocument(options.document)) as Record<string, unknown>,
        protocol: { irSchemaVersion: 'test-ir-1' },
      });
      const document = JSON.parse(serializeWorkflowIrDocument(options.document)) as WorkflowIrDocument;
      return {
        workflowId: created.workflow.id,
        versionId: created.initialVersion.id,
        semanticDigest: computeWorkflowVersionSemanticDigest(document).digest,
      };
    },
    requestRun: async (options) => {
      const principal = options.principal ?? stackApi.principal;
      const envelope: RunCommandEnvelope = {
        commandId: `cmd-ca-req-${options.triggerId}`,
        correlationId: `ca-${options.triggerId}`,
      };
      const values = options.inputCommitmentValues ?? ['ca-input'];
      const requested = await runService.requestRun(principal, envelope, {
        organizationId: options.organizationId ?? stackApi.orgId,
        workflowId: options.workflowId,
        versionId: options.versionId,
        trigger: { type: 'manual', id: options.triggerId },
        inputCommitments: values.map((value) => commitmentOf(value)),
      });
      return requested.result.run;
    },
    createRuntime: (options = {}) =>
      new ComputerAgentRuntime({
        recorder: options.recorder ?? runService,
        nodes: options.nodes ?? stackApi.nodes,
        workflowRepository: repository,
        clock: options.clock ?? agentClock,
        epoch: options.epoch ?? AGENT_TEST_EPOCH,
        policy: { ...defaultPolicy(), ...options.policy },
        replayRegistry: options.replayRegistry ?? new InMemoryReplayRegistry(),
      }),
    attachDesktopHost: (options) => {
      const capabilities = options.capabilities ?? [
        { name: 'filesystem.read', version: 1, availability: 'available' },
        { name: 'filesystem.write', version: 1, availability: 'available' },
      ];
      const { nodeId, sessionToken } = registerComputerHost({
        nodes: options.nodes,
        keySeed: options.keySeed,
        platformClass: 'desktop',
        capabilities,
      });
      const host = new DesktopHostAdapter({
        nodeId,
        sessionToken,
        clock: options.clock ?? agentClock,
        capabilities,
        attestation: options.attesterKey
          ? { supported: true, attesterKeyId: options.attesterKey.keyId }
          : { supported: false, reason: 'no-attester-key' },
        ...(options.attesterKey ? { attesterKey: options.attesterKey } : {}),
        environment: options.environment,
      });
      return { host, nodeId, sessionToken };
    },
    attachWebHost: (options) => {
      const capabilities = options.capabilities ?? [
        { name: 'browser.observe', version: 1, availability: 'available' },
        { name: 'browser.click', version: 1, availability: 'available' },
      ];
      const { nodeId, sessionToken } = registerComputerHost({
        nodes: options.nodes,
        keySeed: options.keySeed,
        platformClass: 'web',
        capabilities,
      });
      const host = new WebBrowserHostAdapter({
        nodeId,
        sessionToken,
        clock: options.clock ?? agentClock,
        capabilities,
        attestation: options.attesterKey
          ? { supported: true, attesterKeyId: options.attesterKey.keyId }
          : { supported: false, reason: 'no-attester-key' },
        ...(options.attesterKey ? { attesterKey: options.attesterKey } : {}),
        environment: options.environment,
      });
      return { host, nodeId, sessionToken };
    },
    attachMobileHost: (options) => {
      const capabilities = options.capabilities ?? [
        { name: 'phone.call.observe', version: 1, availability: 'available' },
        { name: 'phone.call.answer', version: 1, availability: 'available' },
      ];
      const { nodeId, sessionToken } = registerComputerHost({
        nodes: options.nodes,
        keySeed: options.keySeed,
        platformClass: 'ios',
        capabilities,
      });
      const host = new MobileHostAdapter({
        nodeId,
        sessionToken,
        clock: options.clock ?? agentClock,
        capabilities,
        attestation: options.attesterKey
          ? { supported: true, attesterKeyId: options.attesterKey.keyId }
          : { supported: false, reason: 'no-attester-key' },
        ...(options.attesterKey ? { attesterKey: options.attesterKey } : {}),
        environment: options.environment,
      });
      return { host, nodeId, sessionToken };
    },
    registerCloudNode: (options) =>
      registerComputerHost({
        nodes: options.nodes,
        keySeed: options.keySeed,
        platformClass: 'cloud',
        capabilities: options.capabilities,
      }),
    defaultPolicy,
    teardown: stack.teardown,
  };
  return stackApi;
}

// ============================================================================
// §4 Host fixtures over the scripted environments
// ============================================================================

/** A scripted desktop environment with a `reports` directory, no files. */
export function freshDesktopEnvironment(): ScriptedDesktopEnvironment {
  return new ScriptedDesktopEnvironment({ directories: ['reports'] });
}

/** The scripted browser page every web drive uses (fixed elements). */
export function triageFormPage(): { url: string; elements: readonly BrowserPageElement[] } {
  return {
    url: 'https://integration.example/triage',
    elements: [
      { elementId: 'btn-submit', kind: 'button', label: 'Submit', state: 'enabled' },
      { elementId: 'input-notes', kind: 'input', label: 'Notes', state: '' },
    ],
  };
}

/** The scripted browser environment over the canonical triage form page. */
export function freshBrowserEnvironment(): ScriptedBrowserEnvironment {
  return new ScriptedBrowserEnvironment([triageFormPage()]);
}

/** The scripted mobile environment with one fixed ringing call. */
export function freshMobileEnvironment(): ScriptedMobileEnvironment {
  return new ScriptedMobileEnvironment({
    calls: [
      { callId: 'call-oncall-001', state: 'ringing', caller: 'On-call Engineer', number: '+15550100' },
    ],
  });
}

// ============================================================================
// §5 The attestation-capturing host wrapper (typed delegation)
// ============================================================================

/**
 * A delegating attesting host that CAPTURES every attestation it signs (the
 * exact envelope the runtime produced — byte-identical replay/tamper probes
 * need the real object, never a reconstruction).
 */
export class CapturingHost implements AttestingComputerHost {
  readonly nodeId: string;
  readonly sessionToken: string;
  readonly platformClass: NodePlatformClass;
  readonly capabilities: readonly CapabilityAdvertisement[];
  readonly attestationSupport: { readonly supported: true; readonly attesterKeyId: string };
  private readonly captured: ExecutionAttestation[] = [];
  private readonly inner: AttestingComputerHost;

  constructor(inner: ComputerHostAdapter) {
    // fail-closed wrapper: a non-attesting host cannot be captured as one
    if (!inner.attestationSupport.supported || typeof (inner as AttestingComputerHost).signStatement !== 'function') {
      throw new Error('CapturingHost requires a host with real attester key material');
    }
    this.inner = inner as AttestingComputerHost;
    this.nodeId = inner.nodeId;
    this.sessionToken = inner.sessionToken;
    this.platformClass = inner.platformClass;
    this.capabilities = inner.capabilities;
    this.attestationSupport = inner.attestationSupport as { supported: true; attesterKeyId: string };
  }

  /** Every attestation this host signed for the runtime, in order. */
  get attestations(): readonly ExecutionAttestation[] {
    return [...this.captured];
  }

  invoke(invocationId: string, request: Parameters<ComputerHostAdapter['invoke']>[1]): ReturnType<ComputerHostAdapter['invoke']> {
    return this.inner.invoke(invocationId, request);
  }

  nextNonce(): string {
    return this.inner.nextNonce();
  }

  signStatement(statement: ExecutionStatement, issuedAt: string): ExecutionAttestation {
    const attestation = this.inner.signStatement(statement, issuedAt);
    this.captured.push(attestation);
    return attestation;
  }
}

/** Trusted-attester policy helper: the key ids of the given attesting hosts. */
export function attestationPolicyFor(hosts: readonly ComputerHostAdapter[]): {
  required: boolean;
  trustedAttesterKeyIds: string[];
} {
  const keyIds = hosts
    .filter((host) => host.attestationSupport.supported)
    .map((host) => (host.attestationSupport.supported ? host.attestationSupport.attesterKeyId : ''));
  return { required: false, trustedAttesterKeyIds: keyIds };
}

/** A REAL Ed25519 attester key pair (the merged V2-014 barrel). */
export function newAttesterKey(): AttesterKeyPair {
  return generateAttesterKeyPair();
}

/** The requirement-set shape the runtime routes with (V2-004 as DATA). */
export function requirementSetOf(input: {
  id: string;
  capabilities: readonly string[];
  placement: NodeRequirementSet['placement']['required'];
}): NodeRequirementSet {
  return {
    id: input.id,
    capabilities: input.capabilities.map((name) => ({ name })),
    placement: { required: input.placement },
    minTrustTier: 'provisional',
  };
}

/** The canonical fixed report content of every filesystem drive. */
export const TRIAGE_REPORT_CONTENT = 'TRIAGE REPORT v1';
/** The canonical fixed report path input of every filesystem drive. */
export const WORKFLOW_INPUTS = { reportPath: 'reports/summary.md' } as const;
