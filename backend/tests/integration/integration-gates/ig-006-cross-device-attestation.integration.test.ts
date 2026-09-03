/**
 * IG-006 — Cross-Device Execution Attestation Composition Integration Gate.
 *
 * Frozen scope ONLY (spec/architecture/v2/work-orders/IG-006.md + Issue #150):
 * integration tests/protocol conformance/evidence. This gate composes the
 * ALREADY-MERGED capabilities V2-005 (durable WorkflowRuns + evidence),
 * V2-008 (computer/device execution), V2-009 (locality-aware placement +
 * event delivery) and V2-014 (ExecutionAttestation) into ONE cross-device
 * execution protocol. No implementation redesign, no sibling rebases, no
 * drive-by fixes — every surface below is consumed exactly through the
 * merged public barrels (workflow-runs, computer-agent, workflow-deployments,
 * execution-attestation, node-capability, workflow-ir, workflow-repository)
 * plus the established test harnesses (trigger-test-support).
 *
 * The frozen objective, proven on the REAL stack (real PGlite + ALL 62
 * migrations + the real identity stack + the real V2-002 workflow-repository
 * routes + the real V2-005 run routes + the real V2-009 deployment service
 * and event ingest route over app.inject + the real V2-004 node directory
 * with the REAL host registration protocol + TWO real host adapters of TWO
 * different supported host kinds — web (Node A) and desktop (Node B) — each
 * carrying a REAL Ed25519 attester key, driving the merged ComputerAgentRuntime
 * over the real V2-005 run service as its recorder):
 *
 *   "Verify that durable WorkflowRuns, computer/device execution,
 *    locality-aware placement, and ExecutionAttestations compose into one
 *    cross-device execution protocol without duplicate side effects or
 *    trust-boundary collapse."
 *
 * Required proof (each its own labeled section of the main path):
 *   P1. one Run and WorkflowVersion identity preserved across two nodes —
 *       the event-triggered run pins the deployment's exact (workflow,
 *       version) tuple, V2-002's content digest and V2-003's semantic
 *       digest; BOTH step attestations bind the SAME run/version/semantic
 *       digest/attempt identity while binding DIFFERENT node identities;
 *   P2. step execution on Node A produces a valid ExecutionAttestation —
 *       the web step completes through the real runtime with the
 *       produce→independently-verify→attach gate and ONE software_signed
 *       binding durably attached;
 *   P3. Node B independently verifies the attestation BEFORE admitting a
 *       dependent action — the merged
 *       surfaces now prove BOTH legs on the REAL RUNTIME PATH (the V2-016
 *       re-prove; the PR #152 blocked attempt proved only the verifier leg) —
 *       P3a (verifier domain): the transferred envelope (canonical
 *       bytes → parse) verifies through the merged V2-014 verifier under
 *       Node B's OWN verifier context (fresh replay registry, run-derived
 *       binding expectations, Node B's trusted-attester list); a verifier
 *       that does not trust Node A's key refuses typed — and produces NO
 *       VerifiedExecutionFact, so the admission currency below is
 *       impossible to mint without trusting the attester;
 *       P3b (admission coupling, PROVEN on the runtime path): Node B's
 *       verification RESULT — the canonical V2-014 VerifiedExecutionFact —
 *       is CONSUMED as the dependent step's runtime admission precondition
 *       (the merged V2-016 DependentStepPrecondition surface; the resume
 *       input's full key set is pinned below). The dependent step CANNOT
 *       execute without an admitted precondition: the dedicated fail-closed
 *       test machine-checks the missing case (AGENT_PRECONDITION_REJECTED,
 *       zero host side effects), the cross-run fact-theft case
 *       (COMPUTER_AGENT_PRECONDITION_REJECTED thrown at drive entry, the run
 *       left PAUSED and re-drivable), and the genuine re-drive with the
 *       corrected precondition completing the run;
 *   P4. freshness/replay protection works across reconnect/retry — the
 *       re-presented handoff is rejected ATTESTATION_REPLAYED (single-use
 *       nonce), a verifier-epoch advance rejects ATTESTATION_EPOCH_STALE,
 *       an aged envelope rejects ATTESTATION_EXPIRED, and the V2-005 run
 *       boundary's DURABLE replay registry rejects a re-attach typed
 *       (RUN_ATTESTATION_REJECTED / ATTESTATION_REPLAYED, route-level 422,
 *       persisted rejection row);
 *   P5. causal parent binding is enforced — now BOTH legs on the REAL
 *       RUNTIME PATH (the V2-016 re-prove) —
 *       P5a (verifier domain): the merged V2-014 verifier binds the
 *       causalParents dimension: an un-parented dependent statement and a
 *       wrong-parented one are both rejected typed with dimension
 *       "causalParents" (hand-built probes prove the VERIFIER dimension
 *       only, per the V2-016 work order: "A hand-built ExecutionStatement is
 *       insufficient proof of runtime causal production");
 *       P5b (runtime production, PROVEN): the RUNTIME-PRODUCED dependent
 *       attestation — the real resumeAfterHuman walk's own output, captured
 *       from Node B's signing host AND read back from the durable V2-005
 *       binding of the real record_ack step — carries EXACTLY Node A's
 *       execution digest in causalParents, and that produced attestation
 *       verifies under the causalParents expectation (never a hand-built
 *       statement for the positive proof);
 *   P6. duplicate handoff/event delivery converges without duplicate side
 *       effects — the duplicate event (V2-009 inbox), the duplicate
 *       attestation delivery (V2-014 ingestion ledger + Node B's replay
 *       registry), the duplicate attach command (V2-005 exactly-once
 *       command log) and the duplicate host action (V2-008 host ledger)
 *       ALL converge; final accounting: exactly ONE run, ONE write effect
 *       per host, one binding per step, zero new protocol timeline events;
 *   P7. capability and authorization remain separate — the host ADVERTISES
 *       filesystem.write while the run's safe-action policy lacks the
 *       grant: the invocation is refused typed AGENT_CAPABILITY_UNAUTHORIZED
 *       with ZERO side effects; and the verified attestation fact explicitly
 *       never asserts authorization/capability possession (neverAsserts);
 *   P8. insufficient node trust/assurance produces an explicit
 *       ineligible/rejected result — a V2-004 trust tier below the routing
 *       minimum yields the typed AGENT_NO_ELIGIBLE_HOST (the run fails,
 *       nothing executes on the untrusted node); a requiredAssurance above
 *       the honest software_signed baseline yields the typed
 *       AGENT_ATTESTATION_REJECTED carrying ATTESTATION_ASSURANCE_INSUFFICIENT;
 *   P9. evidence and attestation references reconstruct the execution
 *       history — the run history read over the real route reconstructs
 *       run pins, the single attempt, all three steps (web node → human
 *       approval → desktop node), the invocation sequence, the evidence
 *       class sequence, both attestation bindings whose
 *       evidenceReferences ALL resolve to real evidence records of this
 *       run, the exact protocol timeline, and the exactly-once command log.
 *
 * GATE VERDICT: PASS — every frozen proof green on the RUNTIME COMPOSITION
 * PATH. The blocked PR #152 attempt (preserved open on its original 927f23d
 * base as the historical fail-closed record) surfaced exactly the two
 * missing couplings; V2-016 — Cross-Device Attestation Runtime Preconditions
 * (merged as main 11d6afbf, squash of PR #155) — supplied the runtime
 * contract, and this re-prove demonstrates both couplings on the real path:
 * V2-014 verification → VerifiedExecutionFact → Node-B admission →
 * dependent side effect → causalParents in the runtime-produced attestation.
 * The gate still modifies ONLY its own three files (the gate test, the
 * dogfooding runner, the evidence file) — zero modifications to
 * V2-005/V2-008/V2-009/V2-014/V2-016 source (frozen scope; the V2-016
 * surfaces are consumed through the merged public barrel only).
 *
 * Dedicated negative/observation tests below the main path:
 *   - the P3b ADMISSION-COUPLING fail-closed battery (on a fresh tenant:
 *     the dependent action is REFUSED without an admitted precondition
 *     (AGENT_PRECONDITION_REJECTED, zero side effects) even though the
 *     untrusted Node-B verifier cannot even mint the admission currency;
 *     cross-run fact theft is rejected typed at drive entry with the run
 *     left paused; the genuine re-drive with the corrected precondition
 *     completes the run);
 *   - the trust/assurance pair (P8) on fresh tenants;
 *   - the capability-vs-authorization separation (P7) on a fresh tenant;
 *   - a SURFACED COMPOSITION OBSERVATION (not a frozen-proof failure): the
 *     merged runtime's per-drive values map does not survive the
 *     pause→resume cross-device handoff — a node_output binding after the
 *     human-pause handoff resolves to null (the durable run records output
 *     COMMITMENTS only). The gate pins the observed behavior precisely for
 *     the architect; the frozen proofs above never depend on value-level
 *     cross-drive dataflow.
 */
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildServer } from '../../../src/api/server.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { createLogger } from '@platform/logger.js';
import {
  buildTriggerTestStack,
  createTenant,
  versionContentOf,
  TRIGGER_TEST_EPOCH,
  type TriggerTestStack,
} from '../workflow-deployments/trigger-test-support.js';
import {
  createWorkflowIrBuilder,
  computeWorkflowVersionSemanticDigest,
  parseWorkflowIrDocument,
  type WorkflowIrDocument,
  type WorkflowNode,
} from '../../../src/workflow-ir/index.js';
import {
  ComputerAgentRuntime,
  WebBrowserHostAdapter,
  DesktopHostAdapter,
  registerComputerHost,
  ScriptedBrowserEnvironment,
  ScriptedDesktopEnvironment,
  formatUtcTimestamp,
  epochMsOf,
  type ComputerAgentPolicy,
  type AgentDecider,
  type AttestingComputerHost,
  type ComputerHostAdapter,
  type DependentStepPrecondition,
  type ResumeAfterHumanInput,
  type StepAttestationMaterial,
} from '../../../src/computer-agent/index.js';
import {
  generateAttesterKeyPair,
  serializeAttestation,
  parseAttestation,
  verifyAttestation,
  validateExecutionStatement,
  signExecutionAttestation,
  InMemoryReplayRegistry,
  InMemoryAttestationLedger,
  EXECUTION_STATEMENT_OBJECT_TYPE,
  EXECUTION_STATEMENT_SCHEMA_VERSION,
  type AttesterKeyPair,
  type ExecutionAttestation,
  type ExecutionStatement,
  type VerifiedExecutionFact,
} from '../../../src/execution-attestation/index.js';
import type { WorkflowRunHistory } from '../../../src/workflow-runs/index.js';
import type { NodeRequirementSet } from '../../../src/node-capability/index.js';
import type { FastifyInstance } from 'fastify';

const API_KEY = 'ig-006-api-test-key';
const OPERATOR_EXTERNAL_ID = 'ig-006-api-operator';
const FORM_URL = 'https://integration.example/intake';
const ACK_PATH = 'reports/ack.md';
const ACK_CONTENT = 'ACK: intake form submitted and attested across devices';
const CLOUD_POLICY = { placement: { required: 'cloud_allowed' as const }, privacy: { localOnly: false } };

function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

let support: TriggerTestStack;
/** The REAL Fastify app: V2-002 + V2-005 + V2-009 routes (inject-driven). */
let app: FastifyInstance;
let operatorUserId: string;

beforeAll(async () => {
  support = await buildTriggerTestStack({
    WFOS_IG_006_API_TEST_KEY: API_KEY,
  });
  const operator = await support.stack.userRepository.upsertByExternalId({
    externalId: OPERATOR_EXTERNAL_ID,
    displayName: 'IG-006 API Operator',
  });
  operatorUserId = operator.id;
  const provisioner = new ApiKeyCredentialProvisioner(support.stack.db.client);
  await provisioner.provision({
    keyId: 'ig-006-api-test-key-id',
    secretRef: 'WFOS_IG_006_API_TEST_KEY',
    externalId: OPERATOR_EXTERNAL_ID,
    label: 'IG-006 API Operator',
    rawKey: API_KEY,
  });
  const authProvider = new ApiKeyAuthProvider(support.stack.db.client, new EnvSecretStore());
  app = await buildServer({
    queue: new InMemoryQueue(),
    logger: createLogger({ level: 'silent' }),
    auth: { authProvider, userRepository: support.stack.userRepository },
    workflowRepository: { workflowRepositoryService: support.repository },
    workflowRuns: { workflowRunService: support.runs },
    workflowDeployments: { workflowDeploymentService: support.deployments },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await support.teardown();
});

// ============================================================================
// The real HTTP helper (the product path — every route call is inject-driven)
// ============================================================================

async function injectJson(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await app.inject({
    method,
    url,
    headers:
      payload === undefined
        ? { authorization: `Bearer ${API_KEY}` }
        : { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    payload: payload as Record<string, unknown> | undefined,
  });
  return {
    status: response.statusCode,
    body: (response.json() ?? {}) as Record<string, unknown>,
    raw: response.body,
  };
}

/** A fresh tenant owned by the API-key operator (per-test isolation). */
async function freshGateTenant(label: string) {
  const tenant = await createTenant(support, `ig6-${label}`);
  await support.stack.membershipRepository.assign({
    userId: operatorUserId,
    organizationId: tenant.organizationId,
    roleId: 'owner',
  });
  return {
    organizationId: tenant.organizationId,
    ownerUserId: operatorUserId,
    principal: { userId: operatorUserId },
  };
}

// ============================================================================
// The cross-device gate fixture
// ============================================================================

/**
 * The gate fixture: the cross-device intake acknowledgment flow — the
 * `collect` agentic browser step (cloud_allowed — Node A, the web host), the
 * `approve` human pause point (the cross-device handoff moment), and the
 * `record_ack` agentic filesystem step (device_local — Node B, the desktop
 * host; its inputs are literals: the merged runtime's cross-drive values map
 * does not survive the pause→resume handoff — see the dedicated observation
 * test; the dependent action's DEPENDENCE is control (the approved edge) +
 * the attestation/causal layer, the established V2-008 pattern).
 */
function authorCrossDeviceDocument(): WorkflowIrDocument {
  const collect: WorkflowNode = {
    id: 'collect',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Submit the intake form through the browser' },
    capabilityRequirements: ['browser.observe', 'browser.click'],
    placement: 'cloud_allowed',
    inputs: [{ name: 'formUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'formUrl' } }],
    outputs: [{ name: 'submitted', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const approve: WorkflowNode = {
    id: 'approve',
    executionClass: 'human',
    spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve the cross-device handoff before the device-local acknowledgment.' } },
    capabilityRequirements: [],
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'human_confirmation',
  };
  const recordAck: WorkflowNode = {
    id: 'record_ack',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Write the acknowledgment report on the local device' },
    capabilityRequirements: ['filesystem.read', 'filesystem.write'],
    placement: 'device_local',
    inputs: [
      { name: 'ackPath', type: { kind: 'string' }, binding: { kind: 'literal', value: ACK_PATH } },
      { name: 'ackContent', type: { kind: 'string' }, binding: { kind: 'literal', value: ACK_CONTENT } },
    ],
    outputs: [{ name: 'written', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('collect')
    .addWorkflowInput({ name: 'formUrl', type: { kind: 'string' } })
    .addNode(collect)
    .addNode(approve)
    .addNode(recordAck)
    .addEdge({ from: 'collect', to: 'approve', on: 'success' })
    .addEdge({ from: 'approve', to: 'record_ack', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve', to: 'record_ack', on: { outcome: 'rejected' } })
    .build();
}

/**
 * The single-step device-local fixture (the dedicated negatives): ONLY the
 * dependent filesystem step — one device, one attesting host, one action.
 */
function authorLocalAckDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('record_ack')
    .addNode({
      id: 'record_ack',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Write the acknowledgment report on the local device' },
      capabilityRequirements: ['filesystem.read', 'filesystem.write'],
      placement: 'device_local',
      inputs: [
        { name: 'ackPath', type: { kind: 'string' }, binding: { kind: 'literal', value: ACK_PATH } },
        { name: 'ackContent', type: { kind: 'string' }, binding: { kind: 'literal', value: ACK_CONTENT } },
      ],
      outputs: [{ name: 'written', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .build();
}

/**
 * The node_output variant (the surfaced composition observation): identical
 * EXCEPT the dependent step binds its content to the browser step's output.
 */
function authorCrossDeviceDataflowDocument(): WorkflowIrDocument {
  const document = authorCrossDeviceDocument();
  const nodes = document.ir.nodes.map((node) =>
    node.id === 'record_ack'
      ? {
          ...node,
          inputs: [
            { name: 'ackPath', type: { kind: 'string' as const }, binding: { kind: 'literal' as const, value: ACK_PATH } },
            { name: 'submitted', type: { kind: 'boolean' as const }, binding: { kind: 'node_output' as const, node: 'collect', output: 'submitted' } },
          ],
        }
      : node,
  );
  return { ...document, ir: { ...document.ir, nodes } };
}

// ============================================================================
// The two real hosts + the runtime composition (merged barrels only)
// ============================================================================

/**
 * A delegating attesting host that CAPTURES every attestation it signs (the
 * exact envelope the runtime produced — the cross-device transfer needs the
 * real signed object, never a reconstruction; the V2-008 test-support
 * pattern, typed against the merged barrel's AttestingComputerHost).
 */
class CapturingHost implements AttestingComputerHost {
  readonly nodeId: string;
  readonly sessionToken: string;
  readonly platformClass: AttestingComputerHost['platformClass'];
  readonly capabilities: AttestingComputerHost['capabilities'];
  readonly attestationSupport: { readonly supported: true; readonly attesterKeyId: string };
  private readonly captured: ExecutionAttestation[] = [];
  private readonly inner: AttestingComputerHost;

  constructor(inner: ComputerHostAdapter) {
    if (!inner.attestationSupport.supported || typeof (inner as AttestingComputerHost).signStatement !== 'function') {
      throw new Error('CapturingHost requires a host with real attester key material');
    }
    this.inner = inner as AttestingComputerHost;
    this.nodeId = inner.nodeId;
    this.sessionToken = inner.sessionToken;
    this.platformClass = inner.platformClass;
    this.capabilities = inner.capabilities;
    this.attestationSupport = inner.attestationSupport;
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

const BROWSER_CAPS = [
  { name: 'browser.observe', version: 1, availability: 'available' as const },
  { name: 'browser.click', version: 1, availability: 'available' as const },
];
const FILESYSTEM_CAPS = [
  { name: 'filesystem.read', version: 1, availability: 'available' as const },
  { name: 'filesystem.write', version: 1, availability: 'available' as const },
];

/** Attach the web host (Node A) with a REAL Ed25519 attester key. */
function attachWebHost(
  key: AttesterKeyPair,
  environment: ScriptedBrowserEnvironment,
  nodes: TriggerTestStack['nodes'] = support.nodes,
): CapturingHost {
  const registration = registerComputerHost({
    nodes,
    keySeed: `ig6-node-a-${key.keyId.slice(-8)}`,
    platformClass: 'web',
    capabilities: BROWSER_CAPS,
  });
  return new CapturingHost(new WebBrowserHostAdapter({
    nodeId: registration.nodeId,
    sessionToken: registration.sessionToken,
    clock: () => support.clock.utc(),
    capabilities: BROWSER_CAPS,
    attestation: { supported: true, attesterKeyId: key.keyId },
    attesterKey: key,
    environment,
  }));
}

/** Attach the desktop host (Node B) with a REAL Ed25519 attester key. */
function attachDesktopHost(
  key: AttesterKeyPair,
  environment: ScriptedDesktopEnvironment,
  nodes: TriggerTestStack['nodes'] = support.nodes,
): CapturingHost {
  const registration = registerComputerHost({
    nodes,
    keySeed: `ig6-node-b-${key.keyId.slice(-8)}`,
    platformClass: 'desktop',
    capabilities: FILESYSTEM_CAPS,
  });
  return new CapturingHost(new DesktopHostAdapter({
    nodeId: registration.nodeId,
    sessionToken: registration.sessionToken,
    clock: () => support.clock.utc(),
    capabilities: FILESYSTEM_CAPS,
    attestation: { supported: true, attesterKeyId: key.keyId },
    attesterKey: key,
    environment,
  }));
}

/** One node's runtime over the REAL stack (each node: its OWN replay registry). */
function nodeRuntime(
  nodes: TriggerTestStack['nodes'],
  attestation: ComputerAgentPolicy['attestation'],
  dependentStepIds?: readonly string[],
): ComputerAgentRuntime {
  return new ComputerAgentRuntime({
    recorder: support.runs,
    nodes,
    workflowRepository: support.repository,
    clock: () => support.clock.utc(),
    epoch: TRIGGER_TEST_EPOCH,
    policy: {
      maxActionsPerStep: 12,
      maxObservationAgeMs: 60_000,
      maxRecoveryCyclesPerStep: 4,
      safeAction: { grants: [
        { capability: 'browser.observe', scope: 'run' },
        { capability: 'browser.click', scope: 'run' },
        { capability: 'filesystem.read', scope: 'run' },
        { capability: 'filesystem.write', scope: 'run' },
      ] },
      attestation,
      // V2-016 — the dependent-admission policy (runtime configuration;
      // the dependent step REQUIRES an admitted V2-014-derived verified
      // predecessor before its first side-effecting host invocation).
      ...(dependentStepIds ? { dependentStepIds } : {}),
    },
    replayRegistry: new InMemoryReplayRegistry(),
  });
}

/** The Node A decider: observe the page → grounded click → verify. */
function createBrowserSubmitDecider(): AgentDecider {
  return (ctx) => {
    const formUrl = typeof ctx.inputs.formUrl === 'string' ? ctx.inputs.formUrl : FORM_URL;
    if (ctx.observation === null) {
      return { decision: 'observe', capability: 'browser.observe', subject: formUrl };
    }
    const clicked = ctx.history.some((record) => record.capability === 'browser.click' && record.ok);
    if (!clicked) {
      const target = ctx.observation.elements.find((element) => element.elementId === 'btn-submit');
      return {
        decision: 'act',
        capability: 'browser.click',
        grounding: target
          ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest }
          : null,
        parameters: {},
      };
    }
    return {
      decision: 'complete',
      verify: { capability: 'browser.observe', subject: formUrl, expect: { elementId: 'btn-submit', state: 'clicked' } },
      outputs: { submitted: true },
    };
  };
}

/** The Node B decider: observe absent → grounded write → verify (the dependent action). */
function createAckWriteDecider(): AgentDecider {
  return (ctx) => {
    const path = typeof ctx.inputs.ackPath === 'string' ? ctx.inputs.ackPath : ACK_PATH;
    const content = typeof ctx.inputs.ackContent === 'string' ? ctx.inputs.ackContent : ACK_CONTENT;
    if (ctx.observation === null) {
      return { decision: 'observe', capability: 'filesystem.read', subject: path };
    }
    const wrote = ctx.history.some((record) => record.capability === 'filesystem.write' && record.ok);
    if (!wrote) {
      const target = ctx.observation.elements.find((element) => element.elementId === path);
      return {
        decision: 'act',
        capability: 'filesystem.write',
        grounding: target
          ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest }
          : null,
        parameters: { path, content },
      };
    }
    return {
      decision: 'complete',
      verify: { capability: 'filesystem.read', subject: path, expect: { elementId: path, state: content } },
      outputs: { written: true },
    };
  };
}

/** The Node B decider for the dataflow-observation document. */
function createSubmittedDependentDecider(): AgentDecider {
  return (ctx) => {
    const path = ACK_PATH;
    const content = ctx.inputs.submitted === true ? ACK_CONTENT : 'FORM NOT SUBMITTED (input unbound across the handoff)';
    if (ctx.observation === null) {
      return { decision: 'observe', capability: 'filesystem.read', subject: path };
    }
    const wrote = ctx.history.some((record) => record.capability === 'filesystem.write' && record.ok);
    if (!wrote) {
      const target = ctx.observation.elements.find((element) => element.elementId === path);
      return {
        decision: 'act',
        capability: 'filesystem.write',
        grounding: target
          ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest }
          : null,
        parameters: { path, content },
      };
    }
    return {
      decision: 'complete',
      verify: { capability: 'filesystem.read', subject: path, expect: { elementId: path, state: content } },
      outputs: { written: true },
    };
  };
}

/** Create the fixture workflow through the REAL V2-002 routes. */
async function createCrossDeviceWorkflow(
  t: { organizationId: string },
  slug: string,
  document: WorkflowIrDocument,
): Promise<{ workflowId: string; versionId: string; versionNumber: number; contentDigest: string }> {
  const res = await injectJson('POST', `/organizations/${t.organizationId}/workflow-repository/workflows`, {
    slug,
    name: 'Cross-Device Intake Acknowledgment',
    description: 'Browser step on the web device, human handoff approval, device-local acknowledgment write',
    visibility: 'private',
    content: versionContentOf(document),
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
  });
  expect(res.status, res.raw).toBe(201);
  const created = res.body as unknown as {
    workflow: { id: string; headVersionId: string };
    initialVersion: { id: string; versionNumber: number; contentDigest: string };
  };
  return {
    workflowId: created.workflow.id,
    versionId: created.initialVersion.id,
    versionNumber: created.initialVersion.versionNumber,
    contentDigest: created.initialVersion.contentDigest,
  };
}

// ============================================================================
// The gate
// ============================================================================

describe('IG-006 — cross-device execution attestation composition over the merged V2-005/V2-008 (incl. the merged V2-016 dependent-admission + causal-parent hooks)/V2-009/V2-014 contracts', () => {
  it('the full cross-device gate path: one run, two nodes, attested handoff, independent verification, verification-derived admission, dependent action, runtime causal parents (P1, P2, P3a+P3b, P4, P5a+P5b, P6, P7, P8, P9)', async () => {
    const t = await freshGateTenant('main');
    const keyA = generateAttesterKeyPair();
    const keyB = generateAttesterKeyPair();
    const browserEnvironment = new ScriptedBrowserEnvironment([{
      url: FORM_URL,
      elements: [
        { elementId: 'btn-submit', kind: 'button', label: 'Submit', state: 'enabled' },
        { elementId: 'input-notes', kind: 'input', label: 'Notes', state: '' },
      ],
    }]);
    const desktopEnvironment = new ScriptedDesktopEnvironment({ directories: ['reports'] });
    const hostA = attachWebHost(keyA, browserEnvironment);
    const hostB = attachDesktopHost(keyB, desktopEnvironment);

    // --- 0. ONE immutable WorkflowVersion: authored, installed, deployed ----
    const pinned = await createCrossDeviceWorkflow(t, 'ig6-cross-device', authorCrossDeviceDocument());
    expect(pinned.versionNumber).toBe(1);

    const installRes = await injectJson(
      'POST',
      `/organizations/${t.organizationId}/workflow-repository/installations`,
      { workflowId: pinned.workflowId, versionId: pinned.versionId },
    );
    expect(installRes.status, installRes.raw).toBe(201);
    const installation = (installRes.body as unknown as { installation: { id: string; versionId: string; status: string } }).installation;
    expect(installation.versionId).toBe(pinned.versionId);
    expect(installation.status).toBe('enabled');

    const versionRead = await injectJson(
      'GET',
      `/workflow-repository/workflows/${pinned.workflowId}/versions/${pinned.versionId}`,
    );
    expect(versionRead.status).toBe(200);
    const parsed = parseWorkflowIrDocument(
      JSON.stringify((versionRead.body as unknown as { version: { content: Record<string, unknown> } }).version.content),
    );
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const semanticDigest = computeWorkflowVersionSemanticDigest(parsed.document).digest;
    expect(semanticDigest).toMatch(/^[0-9a-f]{64}$/);

    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: installation.id,
      name: 'ig6-cross-device-dep',
      placement: CLOUD_POLICY,
    });
    expect(deployment.workflowId).toBe(pinned.workflowId);
    expect(deployment.versionId).toBe(pinned.versionId);
    expect(deployment.installationId).toBe(installation.id);
    const { subscription: eventSubscription } = await support.deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'event',
      eventPattern: { eventType: 'file.changed' },
    });

    // --- P1. the EVENT-TRIGGERED run pins the exact version identity -------
    const eventPayload = {
      source: hostA.nodeId,
      eventId: 'ig6-intake-form-change-0001',
      eventType: 'file.changed',
      payload: { path: '/inbox/intake-form.txt' },
    };
    const first = await injectJson('POST', `/organizations/${t.organizationId}/workflow-deployments/events`, eventPayload);
    expect(first.status, first.raw).toBe(201);
    expect(first.body.created).toBe(true);
    const firstEvent = (first.body as unknown as { event: { id: string; payloadCommitment: string } }).event;
    const deliveries = (first.body as unknown as { deliveries: { state: string; runId: string | null }[] }).deliveries;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.state).toBe('delivered');
    const runId = deliveries[0]!.runId!;
    expect(runId).toBeTruthy();

    const run = await support.runs.getRun(t.principal, runId);
    expect(run.workflowId).toBe(pinned.workflowId);
    expect(run.versionId).toBe(pinned.versionId);
    expect(run.versionContentDigest).toBe(pinned.contentDigest);
    expect(run.versionSemanticDigest).toBe(semanticDigest);
    expect(run.installationId).toBe(installation.id);
    expect(run.trigger.type).toBe('file_event');
    expect(run.trigger.id).toBe(`evt:${firstEvent.id}:${eventSubscription.id}`);
    expect(run.inputCommitments).toEqual([firstEvent.payloadCommitment]);

    // --- P6 (event leg). the DUPLICATE event converges idempotently -------
    const duplicate = await injectJson('POST', `/organizations/${t.organizationId}/workflow-deployments/events`, eventPayload);
    expect(duplicate.status, duplicate.raw).toBe(200);
    expect(duplicate.body.created).toBe(false);
    expect((duplicate.body as unknown as { deliveries: unknown[] }).deliveries).toEqual([]);
    const runsAfterDuplicate = await support.runs.listRunsInOrganization(t.principal, t.organizationId);
    expect(runsAfterDuplicate).toHaveLength(1);
    expect(runsAfterDuplicate[0]!.id).toBe(runId);

    // --- locality-aware placement through the merged V2-004 matcher --------
    // A cloud node advertising the very same filesystem capabilities is
    // PLACEMENT-ineligible for the device_local dependent step (the locality
    // dimension discriminates; capability alone never routes).
    registerComputerHost({
      nodes: support.nodes,
      keySeed: 'ig6-cloud-relay-node',
      platformClass: 'cloud',
      capabilities: FILESYSTEM_CAPS,
    });
    const dependentRequirement: NodeRequirementSet = {
      id: 'step:record_ack',
      capabilities: [{ name: 'filesystem.read' }, { name: 'filesystem.write' }],
      placement: { required: 'device_local' },
      minTrustTier: 'provisional',
    };
    const match = support.nodes.matchNodes(dependentRequirement);
    const desktopEvaluation = match.evaluations.find((evaluation) => evaluation.nodeId === hostB.nodeId);
    const cloudEvaluations = match.evaluations.filter((evaluation) => evaluation.nodeId !== hostB.nodeId && evaluation.nodeId !== hostA.nodeId);
    expect(desktopEvaluation?.eligible).toBe(true);
    for (const cloudEvaluation of cloudEvaluations) {
      expect(cloudEvaluation.eligible).toBe(false);
      expect(cloudEvaluation.placementEligible).toBe(false);
    }
    expect(match.eligibleNodes.map((evaluation) => evaluation.nodeId)).toEqual([hostB.nodeId]);

    // --- P2. STEP EXECUTION ON NODE A produces a valid attestation ---------
    const runtimeA = nodeRuntime(support.nodes, {
      required: true,
      trustedAttesterKeyIds: [keyA.keyId],
      validityMs: 300_000,
    });
    const reportA = await runtimeA.executeRun(t.principal, {
      runId,
      hosts: [hostA as ComputerHostAdapter],
      decider: createBrowserSubmitDecider(),
      workflowInputs: { formUrl: FORM_URL },
    });
    // the run PAUSES at the human handoff approval (the transfer moment):
    // the browser step COMPLETED on Node A; the human step is the pause point.
    expect(reportA.state).toBe('paused');
    expect(reportA.pausedAtStepId).toBe('approve');
    expect(reportA.steps).toHaveLength(2);
    const collectStep = reportA.steps[0]!;
    expect(collectStep.stepId).toBe('collect');
    expect(collectStep.outcome).toBe('completed');
    expect(collectStep.nodeId).toBe(hostA.nodeId);
    expect(collectStep.attestationsAttached).toBe(1);
    expect(collectStep.attestationsRejected).toBe(0);
    expect(reportA.steps[1]!.stepId).toBe('approve');
    expect(reportA.steps[1]!.outcome).toBe('paused');
    // the REAL environment effect on Node A: the submit button REALLY clicked
    const submitButton = browserEnvironment.snapshot().find((element) => element.elementId === 'btn-submit');
    expect(submitButton?.state).toBe('clicked');

    // the durable attestation produced on Node A (the REAL V2-005 boundary)
    const historyAfterA = await support.runs.getRunHistory(t.principal, runId);
    expect(historyAfterA.run.state).toBe('paused');
    expect(historyAfterA.attestations).toHaveLength(1);
    const bindingA = historyAfterA.attestations[0]!;
    expect(bindingA.stepId).toBe('collect');
    expect(bindingA.attesterKeyId).toBe(keyA.keyId);
    expect(bindingA.assurance).toBe('software_signed');
    expect(bindingA.statement.nodeId).toBe(hostA.nodeId);
    expect(bindingA.statement.runId).toBe(runId);
    expect(bindingA.statement.workflowId).toBe(pinned.workflowId);
    expect(bindingA.statement.workflowVersionId).toBe(pinned.versionId);
    expect(bindingA.statement.workflowVersionSemanticDigest).toBe(semanticDigest);
    expect(bindingA.statement.attemptId).toBe(1);

    // the captured envelope (what Node A actually signed — the transfer object)
    expect(hostA.attestations).toHaveLength(1);
    const attestationA = hostA.attestations[0]!;

    // --- P3a. the TRANSFER + Node B's INDEPENDENT verification (verifier domain)
    // The handoff medium is the V2-014 canonical envelope bytes: serialize on
    // Node A, parse on Node B, verify with Node B's OWN verifier context.
    // THE COUPLING (the V2-016 re-prove): the VerifiedExecutionFact produced
    // below is CONSUMED by the resumeAfterHuman drive that executes the
    // dependent action (the P3b admission precondition constructed after
    // the freshness negatives) — the verification result and the dependent
    // execution are now ONE composition path.
    const transferred = parseAttestation(serializeAttestation(attestationA));
    expect(transferred.ok, JSON.stringify(transferred)).toBe(true);
    if (!transferred.ok) throw new Error('unreachable');
    expect(transferred.attestation.attestationId).toBe(attestationA.attestationId);
    expect(transferred.attestation.statement).toEqual(attestationA.statement);

    // Node B's verifier: fresh replay registry (Node B's own single-use nonce
    // state), run-derived binding expectations, Node B's trusted attesters.
    const nodeBReplayRegistry = new InMemoryReplayRegistry();
    const admission = verifyAttestation(transferred.attestation, {
      bindings: {
        workflowId: pinned.workflowId,
        workflowVersionId: pinned.versionId,
        workflowVersionSemanticDigest: semanticDigest,
        deploymentId: installation.id,
        runId,
        attemptId: 1,
        stepId: 'collect',
      },
      freshness: {
        now: support.clock.utc(),
        currentEpoch: TRIGGER_TEST_EPOCH,
        replayRegistry: nodeBReplayRegistry,
      },
      attesterKeyIds: [keyA.keyId, keyB.keyId],
    });
    expect(admission.ok, JSON.stringify(admission)).toBe(true);
    if (!admission.ok) throw new Error('unreachable');
    const fact: VerifiedExecutionFact = admission.fact;
    // P7 (attestation leg): a valid signature NEVER asserts authorization,
    // capability possession, correct behavior, observed effect or sufficiency.
    expect(fact.attests).toBe('statement_authenticity');
    expect(fact.attesterKeyId).toBe(keyA.keyId);
    expect(fact.verifiedAt).toBe(support.clock.utc());
    expect(fact.neverAsserts).toEqual([
      'authorization',
      'capability_possession',
      'correct_behavior',
      'observed_effect',
      'sufficient_evidence',
    ]);
    expect(fact.nonAuthorityNote).toContain('never authorization');

    // P3 negative (verifier domain): a Node B verifier that does NOT trust
    // Node A's key refuses the verification typed — and produces NO fact, so
    // NO admission precondition can be constructed for the dependent action
    // (the missing-admission fail-closed case is the dedicated P3b test).
    const untrusted = verifyAttestation(transferred.attestation, {
      bindings: { runId },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [keyB.keyId],
    });
    expect(untrusted.ok).toBe(false);
    expect(untrusted.ok ? null : untrusted.failure.code).toBe('ATTESTATION_ATTESTER_UNEXPECTED');
    expect(desktopEnvironment.readFile(ACK_PATH)).toBeNull();

    // --- P4. freshness/replay protection across reconnect/retry ------------
    // (a) the RETRY: the same handoff re-presented to Node B's verifier (the
    //     same registry — Node B's reconnecting process re-attempts admission)
    //     is a REPLAY of the single-use nonce: admission is NOT re-granted.
    const retry = verifyAttestation(transferred.attestation, {
      bindings: { runId },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: nodeBReplayRegistry },
      attesterKeyIds: [keyA.keyId, keyB.keyId],
    });
    expect(retry.ok).toBe(false);
    expect(retry.ok ? null : retry.failure.code).toBe('ATTESTATION_REPLAYED');
    // (b) the EPOCH: Node B's protocol epoch advanced past the statement's.
    const epochAdvanced = verifyAttestation(transferred.attestation, {
      bindings: { runId },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH + 1, replayRegistry: new InMemoryReplayRegistry() },
    });
    expect(epochAdvanced.ok).toBe(false);
    expect(epochAdvanced.ok ? null : epochAdvanced.failure.code).toBe('ATTESTATION_EPOCH_STALE');
    // (c) the AGE: a fresh registry but a verifier clock past validUntil
    //     (issuedAt + 300s) — the re-presented envelope is stale.
    const stale = verifyAttestation(transferred.attestation, {
      bindings: { runId },
      freshness: {
        now: formatUtcTimestamp(epochMsOf(support.clock.utc()) + 600_000),
        currentEpoch: TRIGGER_TEST_EPOCH,
        replayRegistry: new InMemoryReplayRegistry(),
      },
    });
    expect(stale.ok).toBe(false);
    expect(stale.ok ? null : stale.failure.code).toBe('ATTESTATION_EXPIRED');

    // --- P3b. THE ADMISSION COUPLING (the V2-016 re-prove): Node B's
    // verification RESULT — the canonical V2-014 VerifiedExecutionFact
    // produced by the P3a leg under Node B's OWN verifier context — is
    // CONSUMED as the dependent step's runtime admission precondition. The
    // typed DependentStepPrecondition is the merged V2-016 surface: the
    // runtime validates it structurally at drive entry (before any recorder
    // command of the drive) and admits the dependent step's first
    // side-effecting host invocation ONLY with it. The fail-closed negatives
    // (the missing case, cross-run fact theft, the re-drive) are the
    // dedicated P3b test below.
    const runtimeB = nodeRuntime(support.nodes, {
      required: true,
      trustedAttesterKeyIds: [keyA.keyId, keyB.keyId],
      validityMs: 3_600_000,
    }, ['record_ack']);
    const predecessorPrecondition: DependentStepPrecondition = {
      dependentStepId: 'record_ack',
      predecessorAttestationId: fact.attestationId,
      verifiedPredecessor: fact,
      causalParentDigests: [fact.executionDigest.digest],
      runId,
      workflowVersionId: run.versionId,
      workflowVersionSemanticDigest: run.versionSemanticDigest,
    };
    const reportB = await runtimeB.resumeAfterHuman(t.principal, {
      runId,
      hosts: [hostB as ComputerHostAdapter],
      humanOutcome: 'approved',
      humanUserId: operatorUserId,
      decider: createAckWriteDecider(),
      preconditions: [predecessorPrecondition],
    });
    expect(reportB.state).toBe('completed');
    expect(reportB.failure).toBeNull();
    const ackStep = reportB.steps.find((step) => step.stepId === 'record_ack');
    expect(ackStep?.outcome).toBe('completed');
    expect(ackStep?.nodeId).toBe(hostB.nodeId);
    expect(ackStep?.attestationsAttached).toBe(1);
    // the REAL environment effect on Node B: the acknowledgment file written
    // EXACTLY once with the exact expected content.
    expect(desktopEnvironment.readFile(ACK_PATH)).toBe(ACK_CONTENT);
    expect(hostB.attestations).toHaveLength(1);
    const attestationB = hostB.attestations[0]!;

    // --- P1 (completed). one run/version identity across TWO nodes ---------
    const history = await support.runs.getRunHistory(t.principal, runId);
    expect(history.run.state).toBe('completed');
    expect(history.run.versionId).toBe(pinned.versionId);
    expect(history.run.versionSemanticDigest).toBe(semanticDigest);
    expect(history.attempts).toHaveLength(1);
    expect(history.attempts[0]!.attemptNumber).toBe(1);
    expect(history.steps.map((step) => [step.stepId, step.status])).toEqual([
      ['collect', 'completed'],
      ['approve', 'completed'],
      ['record_ack', 'completed'],
    ]);
    expect(history.attestations).toHaveLength(2);
    // (the history projection orders bindings by (attached_at, attestation_id)
    // — with the fixed injected clock both share attached_at, so the array
    // order follows the content-derived attestation ids; select by the
    // durable step binding instead, never by array position)
    const durableA = history.attestations.find((binding) => binding.stepId === 'collect')!;
    const durableB = history.attestations.find((binding) => binding.stepId === 'record_ack')!;
    // the SAME run/version/semantic-digest/installation/attempt identity…
    for (const binding of [durableA, durableB]) {
      expect(binding.runId).toBe(runId);
      expect(binding.statement.workflowId).toBe(pinned.workflowId);
      expect(binding.statement.workflowVersionId).toBe(pinned.versionId);
      expect(binding.statement.workflowVersionSemanticDigest).toBe(semanticDigest);
      expect(binding.statement.deploymentId).toBe(installation.id);
      expect(binding.statement.attemptId).toBe(1);
    }
    // …across TWO DIFFERENT node identities (Node A produced the first, Node B the second)
    expect(durableA.statement.nodeId).toBe(hostA.nodeId);
    expect(durableA.attesterKeyId).toBe(keyA.keyId);
    expect(durableB.statement.nodeId).toBe(hostB.nodeId);
    expect(durableB.attesterKeyId).toBe(keyB.keyId);
    expect(durableA.executionDigest).not.toBe(durableB.executionDigest);

    // --- P5. CAUSAL PARENT BINDING — on the REAL runtime production path ---
    const digestA = durableA.executionDigest;
    // (a) P5b POSITIVE (the RUNTIME PRODUCTION — the V2-016 re-prove): the
    //     dependent attestation PRODUCED BY THE REAL resumeAfterHuman walk on
    //     Node B (captured from Node B's signing host AND read back from the
    //     durable V2-005 binding) carries EXACTLY Node A's execution digest
    //     in causalParents. The declared parent in the admitted precondition
    //     was the verified fact's OWN execution digest — which IS the
    //     durable binding's digest (the verifier and the boundary compute
    //     the same canonical digest over the same statement). Never a
    //     hand-built statement: the V2-016 work order requires the actual
    //     production path for the positive proof.
    expect(fact.executionDigest.digest).toBe(digestA);
    expect([...attestationB.statement.causalParents]).toEqual([digestA]);
    expect([...durableB.statement.causalParents as readonly string[]]).toEqual([digestA]);
    // (b) P5a+P5b POSITIVE (the produced attestation verifies): the
    //     runtime-produced parented dependent attestation verifies under the
    //     causalParents expectation through the merged V2-014 verifier — the
    //     causal chain is real end-to-end (production AND verification).
    const causalOk = verifyAttestation(attestationB, {
      bindings: { runId, attemptId: 1, stepId: 'record_ack', causalParents: [digestA] },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [keyB.keyId],
    });
    expect(causalOk.ok, JSON.stringify(causalOk)).toBe(true);
    // (c) P5a NEGATIVE (verifier domain): an UN-PARENTED dependent statement
    //     (the pre-V2-016 runtime shape — reconstructed here ONLY as the
    //     verifier-dimension probe) is REFUSED under the same causal
    //     expectation — the binding dimension is enforced.
    const unparentedProbeStatement: ExecutionStatement = {
      objectType: EXECUTION_STATEMENT_OBJECT_TYPE,
      statementSchemaVersion: EXECUTION_STATEMENT_SCHEMA_VERSION,
      workflowId: pinned.workflowId,
      workflowVersionId: pinned.versionId,
      workflowVersionSemanticDigest: semanticDigest,
      deploymentId: installation.id,
      runId,
      attemptId: 1,
      stepId: 'record_ack',
      nodeId: hostB.nodeId,
      workloadIdentity: 'computer-agent-runtime@desktop',
      executionClass: 'agentic_computer_use',
      capability: 'filesystem.write',
      action: 'cross-device dependent step (causal parent binding probe)',
      inputCommitments: durableB.statement.inputCommitments as readonly string[],
      outputCommitments: durableB.statement.outputCommitments as readonly string[],
      observationCommitments: durableB.statement.observationCommitments as readonly string[],
      evidenceReferences: durableB.statement.evidenceReferences as readonly string[],
      causalParents: [],
      nonce: hostB.nextNonce(),
      epoch: TRIGGER_TEST_EPOCH,
      outcome: 'succeeded',
      executedAt: support.clock.utc(),
      validUntil: formatUtcTimestamp(epochMsOf(support.clock.utc()) + 3_600_000),
    };
    expect(validateExecutionStatement(unparentedProbeStatement).ok).toBe(true);
    const unparentedProbeAttestation = signExecutionAttestation({
      statement: unparentedProbeStatement,
      attesterPrivateKey: keyB.privateKey,
      attesterPublicKeyDer: keyB.publicKeyDer,
      assurance: 'software_signed',
      issuedAt: support.clock.utc(),
    });
    const causalUnparented = verifyAttestation(unparentedProbeAttestation, {
      bindings: { runId, attemptId: 1, stepId: 'record_ack', causalParents: [digestA] },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [keyB.keyId],
    });
    expect(causalUnparented.ok).toBe(false);
    if (!causalUnparented.ok) {
      expect(causalUnparented.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      expect(causalUnparented.failure.dimension).toBe('causalParents');
      expect(causalUnparented.failure.actual).toBe('');
    }
    // (d) P5a NEGATIVE: a WRONG causal parent digest is refused the same way.
    const wrongParentProbeAttestation = signExecutionAttestation({
      statement: { ...unparentedProbeStatement, causalParents: [sha256Of('wrong-parent-digest')], nonce: hostB.nextNonce() },
      attesterPrivateKey: keyB.privateKey,
      attesterPublicKeyDer: keyB.publicKeyDer,
      assurance: 'software_signed',
      issuedAt: support.clock.utc(),
    });
    const causalWrong = verifyAttestation(wrongParentProbeAttestation, {
      bindings: { runId, attemptId: 1, stepId: 'record_ack', causalParents: [digestA] },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [keyB.keyId],
    });
    expect(causalWrong.ok).toBe(false);
    if (!causalWrong.ok) {
      expect(causalWrong.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      expect(causalWrong.failure.dimension).toBe('causalParents');
    }

    // --- P5b (surface pin). the V2-016 production surface this gate now
    // CONSUMES: StepAttestationMaterial carries the causal-parent input
    // (exactly the field the PR #152 blocked attempt pinned as MISSING —
    // its presence now is the consumed contract, drift-detected so any
    // silent change to the production surface forces this gate to be
    // revisited).
    expectTypeOf<keyof StepAttestationMaterial>().toEqualTypeOf<
      | 'workflowId'
      | 'workflowVersionId'
      | 'workflowVersionSemanticDigest'
      | 'deploymentId'
      | 'runId'
      | 'attemptNumber'
      | 'stepId'
      | 'executionClass'
      | 'capability'
      | 'action'
      | 'inputCommitments'
      | 'outputCommitments'
      | 'observationCommitments'
      | 'evidenceReferences'
      | 'causalParents'
    >();

    // --- P9 (pre-duplicate snapshot). the execution history ----------------
    const timelineBeforeDuplicates = history.timeline.map((entry) => entry.eventName);
    expect(timelineBeforeDuplicates).toEqual([
      'workflow.run.requested',
      'workflow.run.started',
      'workflow.step.started',
      'capability.invocation.requested',
      'capability.invocation.completed',
      'observation.recorded',
      'capability.invocation.requested',
      'capability.invocation.completed',
      'capability.invocation.requested',
      'capability.invocation.completed',
      'observation.recorded',
      'execution.attestation.verified',
      'verification.completed',
      'workflow.step.completed',
      'workflow.step.started',
      'workflow.run.paused',
      'workflow.run.resumed',
      'workflow.step.completed',
      'workflow.step.started',
      'capability.invocation.requested',
      'capability.invocation.completed',
      'observation.recorded',
      'capability.invocation.requested',
      'capability.invocation.completed',
      'capability.invocation.requested',
      'capability.invocation.completed',
      'observation.recorded',
      'execution.attestation.verified',
      'verification.completed',
      'workflow.step.completed',
      'workflow.run.completed',
    ]);
    expect(history.invocations.map((invocation) => invocation.capability)).toEqual([
      'browser.observe',
      'browser.click',
      'browser.observe',
      'filesystem.read',
      'filesystem.write',
      'filesystem.read',
    ]);
    for (const invocation of history.invocations) {
      expect(invocation.outcome).toBe('succeeded');
    }
    // The evidence class MULTISET of the full cross-device run (the shared
    // fixed clock gives every record the same recordedAt, so the history
    // projection orders evidence by its content-derived id — the ORDERED
    // execution reconstruction is the seq-ordered timeline above): both
    // capability steps contribute the intent/observation/claim/verification
    // discipline, and the human handoff contributes ONE human_confirmation.
    expect([...history.evidence.map((evidence) => evidence.evidenceClass)].sort()).toEqual([
      'claim',
      'claim',
      'human_confirmation',
      'intent',
      'intent',
      'intent',
      'intent',
      'intent',
      'intent',
      'observation',
      'observation',
      'observation',
      'observation',
      'verification',
      'verification',
    ]);
    // every attestation evidenceReference resolves to a REAL evidence record
    const evidenceIds = new Set(history.evidence.map((evidence) => evidence.id));
    for (const binding of history.attestations) {
      for (const reference of binding.statement.evidenceReferences as readonly string[]) {
        expect(evidenceIds.has(reference)).toBe(true);
      }
    }
    // the human confirmation is produced by the acting human
    const humanEvidence = history.evidence.find((evidence) => evidence.evidenceClass === 'human_confirmation');
    expect(humanEvidence?.producerKind).toBe('human');
    expect(humanEvidence?.producerId).toBe(operatorUserId);
    expect(history.attestationRejections).toHaveLength(0);

    // --- P6 (the duplicate legs). EVERY duplicate converges ----------------
    // (a) the handoff ledger: the SAME envelope delivered twice converges by
    //     stable attestation identity (accepted → duplicate).
    const handoffInbox = new InMemoryAttestationLedger();
    const firstDelivery = handoffInbox.ingest(transferred.attestation, support.clock.utc());
    const secondDelivery = handoffInbox.ingest(transferred.attestation, support.clock.utc());
    expect(firstDelivery.kind).toBe('accepted');
    expect(secondDelivery.kind).toBe('duplicate');
    expect(secondDelivery.attestationId).toBe(firstDelivery.attestationId);
    expect(secondDelivery.deliveries).toBe(2);
    // (b) the boundary command log: the EXACT attach command re-submitted
    //     (same command id, same payload) converges exactly-once.
    const convergedAttach = await support.runs.attachAttestation(
      t.principal,
      { commandId: `cmd-agent-${runId}-att-${attestationA.attestationId}`, correlationId: `agent-${runId}` },
      {
        runId,
        attemptNumber: 1,
        stepId: 'collect',
        attestation: attestationA,
        policy: { trustedAttesterKeyIds: [keyA.keyId] },
      },
    );
    expect(convergedAttach.executed).toBe(false);
    // (c) the boundary replay registry: a re-attach under a NEW command id
    //     (the retry that lost its correlation) is rejected TYPED through the
    //     real route — HTTP 422, RUN_ATTESTATION_REJECTED, the durable
    //     rejection row records ATTESTATION_REPLAYED, and the binding count
    //     does not grow.
    const replayed = await injectJson('POST', `/workflow-runs/runs/${runId}/attestations`, {
      commandId: 'cmd-ig006-replayed-attach-retry',
      correlationId: 'corr-ig006-replayed-attach',
      attemptNumber: 1,
      stepId: 'collect',
      attestation: attestationA,
      policy: { trustedAttesterKeyIds: [keyA.keyId] },
    });
    expect(replayed.status, replayed.raw).toBe(422);
    expect(replayed.body.code).toBe('RUN_ATTESTATION_REJECTED');
    expect(String(replayed.body.message)).toContain('ATTESTATION_REPLAYED');
    // (d) the host ledger: the SAME invocation id re-presented to Node B's
    //     host converges — NO second write (at-most-once host effects).
    const duplicateAct = await (hostB as ComputerHostAdapter).invoke(`inv-${runId}-a1-record_ack-c0-0002`, {
      kind: 'act',
      capability: 'filesystem.write',
      grounding: null,
      parameters: { path: ACK_PATH, content: ACK_CONTENT },
    });
    expect(duplicateAct.ok).toBe(true);
    if (duplicateAct.ok && duplicateAct.kind === 'acted') {
      expect(duplicateAct.converged).toBe(true);
    }
    expect(desktopEnvironment.readFile(ACK_PATH)).toBe(ACK_CONTENT);

    // --- P9 (final). duplicate deliveries added ZERO protocol events -------
    const finalHistory: WorkflowRunHistory = await support.runs.getRunHistory(t.principal, runId);
    expect(finalHistory.timeline.map((entry) => entry.eventName)).toEqual(timelineBeforeDuplicates);
    expect(finalHistory.evidence).toHaveLength(history.evidence.length);
    expect(finalHistory.attestations).toHaveLength(2);
    expect(finalHistory.attestationRejections).toHaveLength(1);
    expect(finalHistory.attestationRejections[0]!.failureCode).toBe('ATTESTATION_REPLAYED');
    expect(finalHistory.attestationRejections[0]!.attestationId).toBe(attestationA.attestationId);
    // exactly ONE filesystem.write invocation succeeded on the whole run
    const writeInvocations = finalHistory.invocations.filter((invocation) => invocation.capability === 'filesystem.write');
    expect(writeInvocations).toHaveLength(1);
    expect(writeInvocations[0]!.outcome).toBe('succeeded');
    // exactly ONE run in the organization (no second side effect anywhere)
    const finalRuns = await support.runs.listRunsInOrganization(t.principal, t.organizationId);
    expect(finalRuns).toHaveLength(1);
    expect(finalRuns[0]!.id).toBe(runId);

    // --- P9 (route leg). the history reads over the REAL route ------------
    const historyRoute = await injectJson('GET', `/workflow-runs/runs/${runId}/history`);
    expect(historyRoute.status, historyRoute.raw).toBe(200);
    const routeHistory = historyRoute.body as unknown as {
      run: { id: string; versionId: string; versionSemanticDigest: string };
      steps: { stepId: string; status: string }[];
      attestations: { attestationId: string; executionDigest: string; attesterKeyId: string }[];
    };
    expect(routeHistory.run.id).toBe(runId);
    expect(routeHistory.run.versionId).toBe(pinned.versionId);
    expect(routeHistory.run.versionSemanticDigest).toBe(semanticDigest);
    expect(routeHistory.steps.map((step) => [step.stepId, step.status])).toEqual([
      ['collect', 'completed'],
      ['approve', 'completed'],
      ['record_ack', 'completed'],
    ]);
    expect(new Set(routeHistory.attestations.map((binding) => binding.attesterKeyId))).toEqual(
      new Set([keyA.keyId, keyB.keyId]),
    );
  });

  it('P3b (PROVEN on the runtime path): the dependent action REQUIRES the admission consumed from the independently verified Node-A attestation (fail-closed negatives + the genuine re-drive)', async () => {
    // The V2-016 re-prove of the PR #152 blocking finding #1, machine-checked
    // on the REAL stack. The merged public surface now COUPLES Node B's
    // independent verification of the Node-A handoff attestation to the
    // dependent action's admission:
    //   - the V2-008 ResumeAfterHumanInput carries the typed `preconditions`
    //     field (the V2-016 DependentStepPrecondition — its complete key set
    //     is pinned below at the type level, drift-detected by `bun run
    //     typecheck` as part of the verification battery);
    //   - the admission currency is the canonical V2-014 VerifiedExecutionFact
    //     — the verifier's RESULT: impossible to mint without a successful
    //     verification under a policy that trusts the attester;
    //   - the runtime consumes the admitted precondition BEFORE the
    //     dependent step's FIRST side-effecting host invocation and fails
    //     closed without it (AGENT_PRECONDITION_REJECTED at the step gate;
    //     COMPUTER_AGENT_PRECONDITION_REJECTED at drive entry for
    //     supplied-but-invalid preconditions, the run left PAUSED and
    //     re-drivable).
    // The old gap probe (the PR #152 correction) proved the dependent side
    // effect executed with ZERO admission decision; this re-prove proves the
    // exact inverse: without the verification-derived admission the
    // dependent side effect is IMPOSSIBLE.
    expectTypeOf<keyof ResumeAfterHumanInput>().toEqualTypeOf<
      | 'runId'
      | 'hosts'
      | 'humanOutcome'
      | 'providedValue'
      | 'humanUserId'
      | 'decider'
      | 'workflowInputs'
      | 'preconditions'
    >();

    const t = await freshGateTenant('admission-coupling');
    // an ISOLATED node directory (this test registers its own host pair)
    const nodes = support.freshNodes();
    const keyA = generateAttesterKeyPair();
    const keyB = generateAttesterKeyPair();
    const browserEnvironment = new ScriptedBrowserEnvironment([{
      url: FORM_URL,
      elements: [
        { elementId: 'btn-submit', kind: 'button', label: 'Submit', state: 'enabled' },
        { elementId: 'input-notes', kind: 'input', label: 'Notes', state: '' },
      ],
    }]);
    const desktopEnvironment = new ScriptedDesktopEnvironment({ directories: ['reports'] });
    const hostA = attachWebHost(keyA, browserEnvironment, nodes);
    const hostB = attachDesktopHost(keyB, desktopEnvironment, nodes);

    const pinned = await createCrossDeviceWorkflow(t, 'ig6-admission-coupling', authorCrossDeviceDocument());

    // --- leg (a): RUN ONE — the dependent action attempted with NO
    // verification leg and NO admitted precondition. Node B's runtime
    // declares the dependent-admission policy (record_ack REQUIRES a
    // verified predecessor) and its trust context deliberately does NOT
    // include Node A's attester key.
    const requestedOne = await support.runs.requestRun(
      t.principal,
      { commandId: 'cmd-ig006-admission-coupling-1', correlationId: 'corr-ig006-admission-coupling-1' },
      {
        organizationId: t.organizationId,
        workflowId: pinned.workflowId,
        versionId: pinned.versionId,
        trigger: { type: 'manual', id: 'ig006-admission-coupling-1' },
        inputCommitments: [sha256Of('ig006-admission-coupling-1')],
      },
    );
    const runIdOne = requestedOne.result.run.id;

    // Node A executes the first step: its OWN produce→verify→attach gates run
    // (attestation A is produced and durably attached by Node A's runtime).
    const runtimeA = nodeRuntime(nodes, { required: true, trustedAttesterKeyIds: [keyA.keyId], validityMs: 300_000 });
    const reportA = await runtimeA.executeRun(t.principal, {
      runId: runIdOne,
      hosts: [hostA as ComputerHostAdapter],
      decider: createBrowserSubmitDecider(),
      workflowInputs: { formUrl: FORM_URL },
    });
    expect(reportA.state).toBe('paused');
    expect(reportA.pausedAtStepId).toBe('approve');
    expect(reportA.steps[0]!.attestationsAttached).toBe(1);
    const attestationOne = hostA.attestations[0]!;

    // NO TRANSFER and NO VERIFICATION at Node B: a Node-B verifier that does
    // NOT trust Node A's key cannot mint the admission currency at all —
    // the typed refusal produces NO VerifiedExecutionFact (the failed
    // verification result carries only the typed failure, never a fact).
    const noFact = verifyAttestation(attestationOne, {
      bindings: { runId: runIdOne, attemptId: 1, stepId: 'collect' },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [keyB.keyId],
    });
    expect(noFact.ok).toBe(false);
    expect(noFact.ok ? null : noFact.failure.code).toBe('ATTESTATION_ATTESTER_UNEXPECTED');

    // THE COUPLING, machine-checked (the missing case): the dependent
    // action is REFUSED — the run FAILS with the typed
    // AGENT_PRECONDITION_REJECTED, ZERO host side effects of any kind (the
    // acknowledgment file is NOT written; the dependent step never invoked
    // ANY host capability — the admission gate fired before host routing).
    const runtimeBUntrusted = nodeRuntime(nodes, { required: true, trustedAttesterKeyIds: [keyB.keyId], validityMs: 3_600_000 }, ['record_ack']);
    const refused = await runtimeBUntrusted.resumeAfterHuman(t.principal, {
      runId: runIdOne,
      hosts: [hostB as ComputerHostAdapter],
      humanOutcome: 'approved',
      humanUserId: operatorUserId,
      decider: createAckWriteDecider(),
    });
    expect(refused.state).toBe('failed');
    const refusedStep = refused.steps.find((step) => step.stepId === 'record_ack');
    expect(refusedStep?.outcome).toBe('failed');
    expect(refusedStep?.failure?.code).toBe('AGENT_PRECONDITION_REJECTED');
    expect(refusedStep?.actions).toBe(0);
    expect(refusedStep?.observations).toBe(0);
    expect(desktopEnvironment.readFile(ACK_PATH)).toBeNull();
    const historyOne = await support.runs.getRunHistory(t.principal, runIdOne);
    expect(historyOne.run.state).toBe('failed');
    expect(historyOne.steps.map((step) => [step.stepId, step.status])).toEqual([
      ['collect', 'completed'],
      ['approve', 'completed'],
      ['record_ack', 'failed'],
    ]);
    expect(historyOne.invocations.filter((invocation) => invocation.capability.startsWith('filesystem'))).toHaveLength(0);
    expect(historyOne.attestations).toHaveLength(1);
    expect(hostB.attestations).toHaveLength(0);

    // --- leg (b): RUN TWO (the same pinned immutable version) — CROSS-RUN
    // FACT THEFT: Node B verifies run ONE's attestation (a GENUINE fact —
    // for run one) and supplies it as run TWO's admission precondition. The
    // runtime rejects the substitution at DRIVE ENTRY (typed throw, zero
    // side effects, run two left PAUSED and re-drivable).
    const requestedTwo = await support.runs.requestRun(
      t.principal,
      { commandId: 'cmd-ig006-admission-coupling-2', correlationId: 'corr-ig006-admission-coupling-2' },
      {
        organizationId: t.organizationId,
        workflowId: pinned.workflowId,
        versionId: pinned.versionId,
        trigger: { type: 'manual', id: 'ig006-admission-coupling-2' },
        inputCommitments: [sha256Of('ig006-admission-coupling-2')],
      },
    );
    const runIdTwo = requestedTwo.result.run.id;
    const reportA2 = await runtimeA.executeRun(t.principal, {
      runId: runIdTwo,
      hosts: [hostA as ComputerHostAdapter],
      decider: createBrowserSubmitDecider(),
      workflowInputs: { formUrl: FORM_URL },
    });
    expect(reportA2.state).toBe('paused');
    expect(reportA2.pausedAtStepId).toBe('approve');
    const attestationTwo = hostA.attestations.find((candidate) => candidate.statement.runId === runIdTwo)!;
    expect(attestationTwo.statement.runId).toBe(runIdTwo);

    // the genuine fact for run ONE (Node B's verifier, full bindings):
    const theft = verifyAttestation(attestationOne, {
      bindings: { runId: runIdOne, attemptId: 1, stepId: 'collect' },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [keyA.keyId, keyB.keyId],
    });
    expect(theft.ok, JSON.stringify(theft)).toBe(true);
    if (!theft.ok) throw new Error('unreachable');
    const runTwo = await support.runs.getRun(t.principal, runIdTwo);
    const stolenPrecondition: DependentStepPrecondition = {
      dependentStepId: 'record_ack',
      predecessorAttestationId: theft.fact.attestationId,
      verifiedPredecessor: theft.fact,
      causalParentDigests: [theft.fact.executionDigest.digest],
      // claims run TWO…
      runId: runIdTwo,
      workflowVersionId: runTwo.versionId,
      workflowVersionSemanticDigest: runTwo.versionSemanticDigest,
      // …while carrying run ONE's verified fact (its statement binds run ONE)
    };
    const runtimeBCoupled = nodeRuntime(nodes, { required: true, trustedAttesterKeyIds: [keyA.keyId, keyB.keyId], validityMs: 3_600_000 }, ['record_ack']);
    await expect(runtimeBCoupled.resumeAfterHuman(t.principal, {
      runId: runIdTwo,
      hosts: [hostB as ComputerHostAdapter],
      humanOutcome: 'approved',
      humanUserId: operatorUserId,
      decider: createAckWriteDecider(),
      preconditions: [stolenPrecondition],
    })).rejects.toMatchObject({ code: 'COMPUTER_AGENT_PRECONDITION_REJECTED' });
    // the run stays PAUSED (the admission validation ran BEFORE the drive's
    // first recorder command — the resume never happened), zero side effects:
    const runTwoAfterRejection = await support.runs.getRun(t.principal, runIdTwo);
    expect(runTwoAfterRejection.state).toBe('paused');
    expect(desktopEnvironment.readFile(ACK_PATH)).toBeNull();
    const historyTwoAfterRejection = await support.runs.getRunHistory(t.principal, runIdTwo);
    expect(historyTwoAfterRejection.attestations).toHaveLength(1);
    expect(historyTwoAfterRejection.invocations.filter((invocation) => invocation.capability.startsWith('filesystem'))).toHaveLength(0);

    // --- leg (c): the GENUINE RE-DRIVE with the corrected precondition:
    // Node B verifies run TWO's attestation under its OWN verifier context
    // (the P3a discipline — full bindings, fresh replay registry, Node B's
    // trusted-attester list) and the dependent action is admitted, executed
    // exactly once, and causally parented.
    const genuine = verifyAttestation(attestationTwo, {
      bindings: {
        workflowId: pinned.workflowId,
        workflowVersionId: runTwo.versionId,
        workflowVersionSemanticDigest: runTwo.versionSemanticDigest,
        runId: runIdTwo,
        attemptId: 1,
        stepId: 'collect',
      },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [keyA.keyId, keyB.keyId],
    });
    expect(genuine.ok, JSON.stringify(genuine)).toBe(true);
    if (!genuine.ok) throw new Error('unreachable');
    const genuinePrecondition: DependentStepPrecondition = {
      dependentStepId: 'record_ack',
      predecessorAttestationId: genuine.fact.attestationId,
      verifiedPredecessor: genuine.fact,
      causalParentDigests: [genuine.fact.executionDigest.digest],
      runId: runIdTwo,
      workflowVersionId: runTwo.versionId,
      workflowVersionSemanticDigest: runTwo.versionSemanticDigest,
    };
    const completed = await runtimeBCoupled.resumeAfterHuman(t.principal, {
      runId: runIdTwo,
      hosts: [hostB as ComputerHostAdapter],
      humanOutcome: 'approved',
      humanUserId: operatorUserId,
      decider: createAckWriteDecider(),
      preconditions: [genuinePrecondition],
    });
    expect(completed.state).toBe('completed');
    expect(completed.failure).toBeNull();
    const ackStepTwo = completed.steps.find((step) => step.stepId === 'record_ack');
    expect(ackStepTwo?.outcome).toBe('completed');
    expect(ackStepTwo?.nodeId).toBe(hostB.nodeId);
    expect(ackStepTwo?.attestationsAttached).toBe(1);
    expect(desktopEnvironment.readFile(ACK_PATH)).toBe(ACK_CONTENT);
    // the runtime-produced dependent attestation carries run TWO's verified
    // predecessor digest in causalParents (the P5 runtime causal chain):
    const attestationDependent = hostB.attestations.find((candidate) => candidate.statement.runId === runIdTwo)!;
    expect([...attestationDependent.statement.causalParents]).toEqual([genuine.fact.executionDigest.digest]);
    const historyTwo = await support.runs.getRunHistory(t.principal, runIdTwo);
    expect(historyTwo.run.state).toBe('completed');
    expect(historyTwo.attestations).toHaveLength(2);
    const durableDependent = historyTwo.attestations.find((binding) => binding.stepId === 'record_ack')!;
    expect([...durableDependent.statement.causalParents as readonly string[]]).toEqual([genuine.fact.executionDigest.digest]);
    const writeInvocations = historyTwo.invocations.filter((invocation) => invocation.capability === 'filesystem.write');
    expect(writeInvocations).toHaveLength(1);
  });

  it('P8: insufficient node trust produces the explicit typed ineligible result (no execution on the untrusted node)', async () => {
    const t = await freshGateTenant('trust');
    // a FRESH node directory whose ONLY filesystem host is UNTRUSTED (below
    // the runtime's default minHostTrustTier 'provisional') — the V2-004
    // trust dimension makes it ineligible; nothing executes anywhere.
    const nodes = support.freshNodes();
    const registration = registerComputerHost({
      nodes,
      keySeed: 'ig6-untrusted-desktop',
      platformClass: 'desktop',
      trustTier: 'untrusted',
      capabilities: FILESYSTEM_CAPS,
    });
    const environment = new ScriptedDesktopEnvironment({ directories: ['reports'] });
    const untrustedHost = new DesktopHostAdapter({
      nodeId: registration.nodeId,
      sessionToken: registration.sessionToken,
      clock: () => support.clock.utc(),
      capabilities: FILESYSTEM_CAPS,
      attestation: { supported: false, reason: 'no-attester-key' },
      environment,
    });
    const runtime = nodeRuntime(nodes, { required: false });

    const pinned = await createCrossDeviceWorkflow(t, 'ig6-trust-negative', authorLocalAckDocument());
    const requested = await support.runs.requestRun(
      t.principal,
      { commandId: 'cmd-ig006-trust-negative', correlationId: 'corr-ig006-trust-negative' },
      {
        organizationId: t.organizationId,
        workflowId: pinned.workflowId,
        versionId: pinned.versionId,
        trigger: { type: 'manual', id: 'ig006-trust-negative' },
        inputCommitments: [sha256Of('ig006-trust-negative')],
      },
    );
    const run = requested.result.run;

    const report = await runtime.executeRun(t.principal, {
      runId: run.id,
      hosts: [untrustedHost],
      decider: createAckWriteDecider(),
    });
    // the EXPLICIT typed ineligible result (fail-closed, not a silent skip)
    expect(report.state).toBe('failed');
    expect(report.failure?.code).toBe('AGENT_NO_ELIGIBLE_HOST');
    expect(report.failure?.recoverable).toBe(false);
    expect(report.steps[0]?.outcome).toBe('failed');
    expect(report.steps[0]?.nodeId).toBeNull();
    // NOTHING executed on the untrusted node: zero invocations, zero writes
    const history = await support.runs.getRunHistory(t.principal, run.id);
    expect(history.run.state).toBe('failed');
    expect(history.invocations).toHaveLength(0);
    expect(history.attestations).toHaveLength(0);
    expect(environment.readFile(ACK_PATH)).toBeNull();
    // the matcher's typed reason: the trust dimension, dimension-separated
    const match = nodes.matchNodes({
      id: 'step:record_ack',
      capabilities: [{ name: 'filesystem.read' }, { name: 'filesystem.write' }],
      placement: { required: 'device_local' },
      minTrustTier: 'provisional',
    });
    expect(match.eligibleNodes).toHaveLength(0);
    const evaluation = match.evaluations.find((candidate) => candidate.nodeId === registration.nodeId);
    expect(evaluation?.eligible).toBe(false);
    expect(evaluation?.trustEligible).toBe(false);
  });

  it('P8: insufficient attestation assurance produces the explicit typed rejection (runtime gate + admission verifier)', async () => {
    const t = await freshGateTenant('assurance');
    const nodes = support.freshNodes();
    const key = generateAttesterKeyPair();
    const registration = registerComputerHost({
      nodes,
      keySeed: 'ig6-assurance-desktop',
      platformClass: 'desktop',
      capabilities: FILESYSTEM_CAPS,
    });
    const environment = new ScriptedDesktopEnvironment({ directories: ['reports'] });
    const host = new CapturingHost(new DesktopHostAdapter({
      nodeId: registration.nodeId,
      sessionToken: registration.sessionToken,
      clock: () => support.clock.utc(),
      capabilities: FILESYSTEM_CAPS,
      attestation: { supported: true, attesterKeyId: key.keyId },
      attesterKey: key,
      environment,
    }));

    const pinned = await createCrossDeviceWorkflow(t, 'ig6-assurance-negative', authorLocalAckDocument());
    const requested = await support.runs.requestRun(
      t.principal,
      { commandId: 'cmd-ig006-assurance-negative', correlationId: 'corr-ig006-assurance-negative' },
      {
        organizationId: t.organizationId,
        workflowId: pinned.workflowId,
        versionId: pinned.versionId,
        trigger: { type: 'manual', id: 'ig006-assurance-negative' },
        inputCommitments: [sha256Of('ig006-assurance-negative')],
      },
    );
    const run = requested.result.run;

    // the runtime's requiredAssurance (hardware_backed) exceeds the honest
    // software_signed baseline every merged host produces → the completion
    // gate rejects the step typed; the run fails; the boundary is never
    // asked (no binding, no rejection row); the attestation assurance
    // dimension is EXPLICIT, never silently downgraded.
    const runtime = nodeRuntime(nodes, {
      required: true,
      trustedAttesterKeyIds: [key.keyId],
      requiredAssurance: 'hardware_backed',
    });
    const report = await runtime.executeRun(t.principal, {
      runId: run.id,
      hosts: [host as ComputerHostAdapter],
      decider: createAckWriteDecider(),
    });
    expect(report.state).toBe('failed');
    expect(report.failure?.code).toBe('AGENT_ATTESTATION_REJECTED');
    expect(report.failure?.detail).toContain('ATTESTATION_ASSURANCE_INSUFFICIENT');
    expect(report.steps[0]?.outcome).toBe('failed');
    const history = await support.runs.getRunHistory(t.principal, run.id);
    expect(history.run.state).toBe('failed');
    expect(history.steps[0]!.status).toBe('failed');
    expect(history.attestations).toHaveLength(0);
    expect(history.attestationRejections).toHaveLength(0);

    // the same dimension on the Node B admission verifier: a software_signed
    // attestation under a hardware_backed requirement is rejected TYPED.
    const admission = verifyAttestation(host.attestations[0]!, {
      bindings: { runId: run.id, attemptId: 1, stepId: 'record_ack' },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [key.keyId],
      requiredAssurance: 'hardware_backed',
    });
    expect(admission.ok).toBe(false);
    expect(admission.ok ? null : admission.failure.code).toBe('ATTESTATION_ASSURANCE_INSUFFICIENT');
  });

  it('P7: capability advertisement and authorization remain separate dimensions (typed refusal, zero side effects)', async () => {
    const t = await freshGateTenant('authorization');
    const nodes = support.freshNodes();
    const registration = registerComputerHost({
      nodes,
      keySeed: 'ig6-authorization-desktop',
      platformClass: 'desktop',
      capabilities: FILESYSTEM_CAPS,
    });
    const environment = new ScriptedDesktopEnvironment({ directories: ['reports'] });
    const host = new DesktopHostAdapter({
      nodeId: registration.nodeId,
      sessionToken: registration.sessionToken,
      clock: () => support.clock.utc(),
      capabilities: FILESYSTEM_CAPS,
      attestation: { supported: false, reason: 'no-attester-key' },
      environment,
    });
    // the host ADVERTISES filesystem.write (capability possession) but the
    // run's safe-action policy grants ONLY the read: the write invocation is
    // refused typed — advertisement is never authorization.
    const runtime = new ComputerAgentRuntime({
      recorder: support.runs,
      nodes,
      workflowRepository: support.repository,
      clock: () => support.clock.utc(),
      epoch: TRIGGER_TEST_EPOCH,
      policy: {
        maxActionsPerStep: 12,
        maxObservationAgeMs: 60_000,
        maxRecoveryCyclesPerStep: 4,
        safeAction: { grants: [{ capability: 'filesystem.read', scope: 'run' }] },
        attestation: { required: false },
      },
      replayRegistry: new InMemoryReplayRegistry(),
    });

    const pinned = await createCrossDeviceWorkflow(t, 'ig6-authorization-negative', authorLocalAckDocument());
    const requested = await support.runs.requestRun(
      t.principal,
      { commandId: 'cmd-ig006-authorization-negative', correlationId: 'corr-ig006-authorization-negative' },
      {
        organizationId: t.organizationId,
        workflowId: pinned.workflowId,
        versionId: pinned.versionId,
        trigger: { type: 'manual', id: 'ig006-authorization-negative' },
        inputCommitments: [sha256Of('ig006-authorization-negative')],
      },
    );
    const run = requested.result.run;

    const report = await runtime.executeRun(t.principal, {
      runId: run.id,
      hosts: [host],
      decider: createAckWriteDecider(),
    });
    expect(report.state).toBe('failed');
    expect(report.failure?.code).toBe('AGENT_CAPABILITY_UNAUTHORIZED');
    expect(report.failure?.recoverable).toBe(false);
    // the OBSERVE (granted) executed; the WRITE (unauthorized) never did —
    // the host COULD write (it advertises the capability) but wrote NOTHING.
    const history = await support.runs.getRunHistory(t.principal, run.id);
    expect(history.invocations.map((invocation) => invocation.capability)).toEqual(['filesystem.read']);
    expect(environment.readFile(ACK_PATH)).toBeNull();
    expect(history.attestations).toHaveLength(0);
  });

  it('surfaced composition observation: node_output dataflow does not survive the cross-device handoff (pinned for the architect)', async () => {
    const t = await freshGateTenant('dataflow');
    // an ISOLATED node directory (this test registers its own host pair)
    const routingNodes = support.freshNodes();
    const keyA = generateAttesterKeyPair();
    const keyB = generateAttesterKeyPair();
    const browserEnvironment = new ScriptedBrowserEnvironment([{
      url: FORM_URL,
      elements: [
        { elementId: 'btn-submit', kind: 'button', label: 'Submit', state: 'enabled' },
        { elementId: 'input-notes', kind: 'input', label: 'Notes', state: '' },
      ],
    }]);
    const desktopEnvironment = new ScriptedDesktopEnvironment({ directories: ['reports'] });
    const hostA = attachWebHost(keyA, browserEnvironment, routingNodes);
    const hostB = attachDesktopHost(keyB, desktopEnvironment, routingNodes);

    // the node_output variant: the dependent step binds its input to the
    // browser step's declared output.
    const pinned = await createCrossDeviceWorkflow(t, 'ig6-dataflow-observation', authorCrossDeviceDataflowDocument());
    const requested = await support.runs.requestRun(
      t.principal,
      { commandId: 'cmd-ig006-dataflow-observation', correlationId: 'corr-ig006-dataflow-observation' },
      {
        organizationId: t.organizationId,
        workflowId: pinned.workflowId,
        versionId: pinned.versionId,
        trigger: { type: 'manual', id: 'ig006-dataflow-observation' },
        inputCommitments: [sha256Of('ig006-dataflow-observation')],
      },
    );
    const run = requested.result.run;

    const runtimeA = nodeRuntime(routingNodes, { required: true, trustedAttesterKeyIds: [keyA.keyId], validityMs: 300_000 });
    const reportA = await runtimeA.executeRun(t.principal, {
      runId: run.id,
      hosts: [hostA as ComputerHostAdapter],
      decider: createBrowserSubmitDecider(),
      workflowInputs: { formUrl: FORM_URL },
    });
    expect(reportA.state).toBe('paused');
    expect(reportA.steps[0]!.attestationsAttached).toBe(1);

    const runtimeB = nodeRuntime(routingNodes, { required: true, trustedAttesterKeyIds: [keyA.keyId, keyB.keyId], validityMs: 3_600_000 });
    const reportB = await runtimeB.resumeAfterHuman(t.principal, {
      runId: run.id,
      hosts: [hostB as ComputerHostAdapter],
      humanOutcome: 'approved',
      humanUserId: operatorUserId,
      decider: createSubmittedDependentDecider(),
    });
    // The OBSERVED merged-surface behavior (pinned honestly, NOT a
    // frozen-proof failure): the V2-008 runtime's step-output values are a
    // per-drive in-memory map — a pause→resume constructs a fresh one seeded
    // only from workflowInputs, and the durable run records output
    // COMMITMENTS only. The node_output binding therefore resolves to null
    // across the handoff (silently — no typed failure), and the dependent
    // decider observes inputs.submitted === null.
    expect(reportB.state).toBe('completed');
    expect(desktopEnvironment.readFile(ACK_PATH)).toBe('FORM NOT SUBMITTED (input unbound across the handoff)');
    // the durable record is HONEST about the effect that actually happened:
    // the write invocation's output commitment matches the ACTUAL written
    // content's observation, and the run completes with both attestations.
    const history = await support.runs.getRunHistory(t.principal, run.id);
    expect(history.run.state).toBe('completed');
    expect(history.attestations).toHaveLength(2);
    const writeInvocation = history.invocations.find((invocation) => invocation.capability === 'filesystem.write');
    expect(writeInvocation?.outcome).toBe('succeeded');
    // within ONE drive the dataflow DOES work (the values map is populated):
    // this is specifically the cross-drive (cross-device handoff) boundary.
  });
});
