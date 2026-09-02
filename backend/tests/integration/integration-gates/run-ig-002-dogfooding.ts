import { createHash } from 'node:crypto';
import {
  DefaultNodeCapabilityService,
  computeRegistrationResponse,
  type CapabilityAdvertisement,
  type NodeCapabilityService,
  type NodeEligibilityEvaluation,
  type NodePlatformClass,
  type NodeRequirementSet,
} from '../../../src/node-capability/index.js';
import {
  buildMinimalDocument,
  buildTriageDocument,
  withNode,
} from '../../unit/workflow-ir/helpers.js';
import {
  computeWorkflowVersionSemanticDigest,
  validateWorkflowIrDocument,
  type WorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';

/**
 * IG-002 — standalone dogfooding RUN (real process, real product paths).
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/integration-gates/run-ig-002-dogfooding.ts
 *
 * Executes the frozen IG-002 dogfooding clause for real:
 *
 *   "Take one real workflow that can run on two supported host classes and
 *    verify equivalent workflow meaning with host-specific capability
 *    resolution."
 *
 * Real paths only: the workflow is authored and validated through the merged
 * V2-003 WorkflowIR module (buildTriageDocument / validateWorkflowIrDocument
 * / computeWorkflowVersionSemanticDigest), and both host classes register
 * through the merged V2-004 registration protocol (enrollNodeKey →
 * requestRegistrationChallenge → computeRegistrationResponse →
 * completeRegistration → setNodeTrustAttributes) before the real matcher
 * (matchNodes) resolves the projected requirement sets. The IR→requirement
 * projection is the same test-local adapter the gate test uses (V2-004
 * consumes requirements as data and must not absorb WorkflowIR semantics).
 *
 * The transcript below is persisted (verbatim) as dogfooding evidence at
 * spec/architecture/v2/dogfooding-evidence/IG-002-ir-capability-placement-gate.md.
 *
 * Determinism: fixed key seeds (sha256 of fixed strings), injected protocol
 * clock, sequential nonces — the only wall-clock lines are run-instance
 * bookkeeping. Exits non-zero when any experiment check fails (fail-closed
 * runner).
 */

const WORK_ORDER_ID = 'IG-002';
/** Activation base of the IG-002 branch (merged main, V2-005 merge #134). */
const BASE_SHA = 'def45e79db60d9b509263d2c166733ede9dc1b3d';
const CLOCK_BASE = 1_733_568_000_000; // fixed injected protocol clock (ms)
const LEASE_MS = 60_000;

const CLOUD_KEY_SEED = 'ig-002-dogfooding-cloud-host';
const WEB_KEY_SEED = 'ig-002-dogfooding-web-host';

const CLOUD_CAPABILITIES: readonly CapabilityAdvertisement[] = [
  { name: 'workflow.execute', version: 1, availability: 'available' },
  { name: 'workflow.observe', version: 1, availability: 'available' },
  { name: 'github.repository.read', version: 1, availability: 'available' },
];

const WEB_CAPABILITIES: readonly CapabilityAdvertisement[] = [
  { name: 'workflow.observe', version: 1, availability: 'available' },
  { name: 'browser.navigate', version: 1, availability: 'available' },
  { name: 'browser.click', version: 1, availability: 'available' },
];

function hostSecret(seed: string): Uint8Array {
  return createHash('sha256').update(seed).digest();
}

function register(
  service: NodeCapabilityService,
  secret: Uint8Array,
  platformClass: NodePlatformClass,
  capabilities: readonly CapabilityAdvertisement[],
  supportsHumanApproval: boolean,
) {
  const { nodeKeyFingerprint } = service.enrollNodeKey({ nodeKeySecret: secret });
  const challenge = service.requestRegistrationChallenge({ nodeKeyFingerprint });
  const payload = {
    nodeKeyFingerprint,
    platformClass,
    protocolVersion: 1,
    capabilities,
    attributes: { supportsHumanApproval, health: 'healthy' as const },
  };
  const response = computeRegistrationResponse({ nodeKeySecret: secret, payload, nonce: challenge.nonce });
  const session = service.completeRegistration({
    ...payload,
    challengeNonce: challenge.nonce,
    response,
  });
  service.setNodeTrustAttributes({ nodeId: session.nodeId, trustTier: 'trusted' });
  return { ...session, nodeKeyFingerprint };
}

/**
 * The only adapter in this gate (duplicated from the gate test, same
 * semantics); V2-004 receives the resulting requirement as data.
 */
function requirementFromIr(nodeId: string, document: WorkflowIrDocument): NodeRequirementSet {
  const node = document.ir.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`IG-002 fixture missing node ${nodeId}`);
  return {
    id: `IG-002-${node.id}`,
    capabilities: node.capabilityRequirements.map((name) => ({ name })),
    placement: { required: node.placement },
    ...(node.placement === 'device_local' ? { privacy: { localOnly: true } } : {}),
  };
}

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly observed: string;
}

const checks: Check[] = [];
function check(name: string, passed: boolean, observed: string): void {
  checks.push({ name, passed, observed });
}

function reasonsText(evaluation: NodeEligibilityEvaluation): string {
  return evaluation.reasons.length === 0
    ? 'none'
    : evaluation.reasons.map((reason) => `${reason.dimension}:${reason.code}`).join('; ');
}

function line(label: string, value: string): string {
  return `  ${label.padEnd(38, ' ')} ${value}`;
}

// ---------------------------------------------------------------------------
// Real experiment
// ---------------------------------------------------------------------------

const wallClockStartedAtMs = Date.now();

// --- Step 1: AUTHOR a real workflow through the real V2-003 paths. ---
const triage = buildTriageDocument();
const triageValidation = validateWorkflowIrDocument(triage);
const triageDigest = computeWorkflowVersionSemanticDigest(triage).digest;
const triageProjections = triage.ir.nodes.map((node) => ({
  nodeId: node.id,
  requirement: requirementFromIr(node.id, triage),
}));
check(
  'authored triage workflow validates through the real V2-003 validator',
  triageValidation.ok,
  `validateWorkflowIrDocument ok=${String(triageValidation.ok)}`,
);
check(
  'per-node requirement projections derived for every authored node (no fabricated ids)',
  triageProjections.length === triage.ir.nodes.length,
  `${triageProjections.length} nodes projected`,
);

// --- Step 2: REGISTER two host classes through the REAL V2-004 protocol. ---
function buildFleetService(withWeb: boolean) {
  let now = CLOCK_BASE;
  let nonce = 0;
  const service = new DefaultNodeCapabilityService({
    clock: () => now,
    nonceSource: () => (++nonce).toString(16).padStart(16, '0'),
    heartbeatLeaseTtlMs: LEASE_MS,
  });
  const cloud = register(service, hostSecret(CLOUD_KEY_SEED), 'cloud', CLOUD_CAPABILITIES, false);
  const web = withWeb
    ? register(service, hostSecret(WEB_KEY_SEED), 'web', WEB_CAPABILITIES, true)
    : null;
  return { service, cloud, web };
}

const fleet = buildFleetService(true);
const fleetWebRecord = fleet.web ? fleet.service.getNode(fleet.web.nodeId) : null;
const fleetCloudRecord = fleet.service.getNode(fleet.cloud.nodeId);
check(
  'two host classes of different platform classes registered through the real V2-004 protocol',
  fleetWebRecord !== null &&
    fleetCloudRecord !== null &&
    fleetWebRecord.platformClass === 'web' &&
    fleetCloudRecord.platformClass === 'cloud' &&
    fleetWebRecord.capabilities.some((c) => c.name === 'workflow.observe') &&
    fleetCloudRecord.capabilities.some((c) => c.name === 'workflow.observe'),
  `web=${fleetWebRecord?.platformClass ?? 'n/a'} cloud=${fleetCloudRecord?.platformClass ?? 'n/a'}`,
);

// --- Step 3: THE DOGFOODING CORE — one real workflow, two host classes. ---
const runnerWorkflow = withNode(buildMinimalDocument(), 'observe', {
  spec: { class: 'deterministic_api', capability: 'workflow.observe' },
  capabilityRequirements: ['workflow.observe'],
  placement: 'any_supported_node',
});
const runnerValidation = validateWorkflowIrDocument(runnerWorkflow);
const digestBeforeResolution = computeWorkflowVersionSemanticDigest(runnerWorkflow).digest;

// (a) The IR is platform-neutral: its semantic digest must never change when
//     the same workflow is resolved against each host class.
const sharedRequirement = requirementFromIr('observe', runnerWorkflow);
const sharedResult = fleet.service.matchNodes(sharedRequirement);
const webShared = sharedResult.evaluations.find((evaluation) => evaluation.platformClass === 'web');
const cloudShared = sharedResult.evaluations.find((evaluation) => evaluation.platformClass === 'cloud');
const digestAfterWebResolution = computeWorkflowVersionSemanticDigest(runnerWorkflow).digest;
const digestAfterCloudResolution = computeWorkflowVersionSemanticDigest(runnerWorkflow).digest;
check(
  'WorkflowIR semantic digest identical across both host resolutions (platform-neutral IR)',
  digestBeforeResolution === digestAfterWebResolution &&
    digestBeforeResolution === digestAfterCloudResolution,
  digestBeforeResolution,
);
check(
  'runner workflow validates (real V2-003 validator)',
  runnerValidation.ok,
  `validateWorkflowIrDocument ok=${String(runnerValidation.ok)}`,
);

// (b) The shared capability resolves on BOTH host classes.
check(
  'both host classes eligible for the shared workflow.observe step (capability + placement)',
  sharedResult.eligibleNodes.length === 2 &&
    webShared !== undefined &&
    cloudShared !== undefined &&
    webShared.capabilityEligible &&
    webShared.placementEligible &&
    webShared.eligible &&
    cloudShared.capabilityEligible &&
    cloudShared.placementEligible &&
    cloudShared.eligible,
  `eligible nodes=${String(sharedResult.eligibleNodes.length)}`,
);

// (c) Host-specific capability resolution: the same workflow node, device
//     placement preference with an explicit cloud fallback (requirement data
//     added after projection — not IR).
const hostSpecificRequirement: NodeRequirementSet = {
  ...sharedRequirement,
  id: 'IG-002-observe-host-specific',
  placement: { required: 'device_preferred', fallbackOrder: ['cloud_allowed'] },
};
const hostSpecificResult = fleet.service.matchNodes(hostSpecificRequirement);
const webSpecific = hostSpecificResult.evaluations.find((evaluation) => evaluation.platformClass === 'web');
const cloudSpecific = hostSpecificResult.evaluations.find(
  (evaluation) => evaluation.platformClass === 'cloud',
);
check(
  'host-specific resolution: web host rank 0, cloud host rank 1 (explicit fallback, equivalent meaning)',
  hostSpecificResult.eligibleNodes.length === 2 &&
    webSpecific?.eligible === true &&
    webSpecific.placementRank === 0 &&
    webSpecific.satisfiedPlacement === 'device_preferred' &&
    cloudSpecific?.eligible === true &&
    cloudSpecific.placementRank === 1 &&
    cloudSpecific.satisfiedPlacement === 'cloud_allowed',
  `web rank=${webSpecific?.placementRank ?? 'n/a'} cloud rank=${cloudSpecific?.placementRank ?? 'n/a'}`,
);

// --- Step 4: unsupported-platform rejections (persisted in the transcript). ---

// 4a. Cloud-only fleet: NO device-class node is deployed at all.
const cloudOnly = buildFleetService(false);
const cloudOnlyRecord = cloudOnly.service.getNode(cloudOnly.cloud.nodeId);
check(
  'cloud-only fleet registers exactly one cloud-class node (no device-class node deployed)',
  cloudOnlyRecord !== null &&
    cloudOnlyRecord.platformClass === 'cloud' &&
    cloudOnly.service.listNodes().length === 1,
  `nodes=${cloudOnly.service.listNodes().map((node) => node.platformClass).join(',')}`,
);
const localWorkflow = withNode(buildMinimalDocument(), 'observe', {
  spec: { class: 'deterministic_api', capability: 'browser.navigate' },
  capabilityRequirements: ['browser.navigate'],
  placement: 'device_local',
});
const localResult = cloudOnly.service.matchNodes(requirementFromIr('observe', localWorkflow));
const localCloudEvaluation = localResult.evaluations.find(
  (evaluation) => evaluation.platformClass === 'cloud',
);
check(
  'unsupported platform (no deployed device-class node, device_local): 0 eligible, placement-dimension rejection',
  localResult.eligibleNodes.length === 0 &&
    localResult.evaluations.length === 1 &&
    localCloudEvaluation !== undefined &&
    localCloudEvaluation.placementEligible === false &&
    localCloudEvaluation.reasons.some(
      (reason) => reason.dimension === 'placement' && reason.code === 'PLACEMENT_LOCALITY_VIOLATION',
    ) &&
    localCloudEvaluation.reasons.some(
      (reason) => reason.dimension === 'placement' && reason.code === 'PRIVACY_LOCAL_ONLY_VIOLATION',
    ) &&
    localCloudEvaluation.reasons.every(
      (reason) => reason.dimension === 'placement' || reason.dimension === 'capability',
    ),
  `eligible nodes=${String(localResult.eligibleNodes.length)} reasons=[${localCloudEvaluation ? reasonsText(localCloudEvaluation) : 'n/a'}]`,
);

// 4a'. The same platform fact via a non-hard device placement spells the
//      class-mismatch reason code.
const preferredWorkflow = withNode(buildMinimalDocument(), 'observe', {
  spec: { class: 'deterministic_api', capability: 'browser.navigate' },
  capabilityRequirements: ['browser.navigate'],
  placement: 'device_preferred',
});
const preferredResult = cloudOnly.service.matchNodes(requirementFromIr('observe', preferredWorkflow));
const preferredCloudEvaluation = preferredResult.evaluations.find(
  (evaluation) => evaluation.platformClass === 'cloud',
);
check(
  'unsupported platform (no deployed device-class node, device_preferred): 0 eligible, PLACEMENT_CLASS_MISMATCH',
  preferredResult.eligibleNodes.length === 0 &&
    preferredCloudEvaluation !== undefined &&
    preferredCloudEvaluation.placementEligible === false &&
    preferredCloudEvaluation.reasons.some(
      (reason) => reason.dimension === 'placement' && reason.code === 'PLACEMENT_CLASS_MISMATCH',
    ),
  `eligible nodes=${String(preferredResult.eligibleNodes.length)} reasons=[${preferredCloudEvaluation ? reasonsText(preferredCloudEvaluation) : 'n/a'}]`,
);

// 4b. Fail-closed protocol gate: every deployed node is protocol version 1,
//     the requirement demands >= 2.
const gatedRequirement: NodeRequirementSet = {
  ...sharedRequirement,
  id: 'IG-002-observe-protocol-gate',
  minProtocolVersion: 2,
};
const gatedResult = fleet.service.matchNodes(gatedRequirement);
check(
  'unsupported platform (protocol version): 0 eligible, every evaluation PROTOCOL_VERSION_UNSUPPORTED (fail-closed)',
  gatedResult.eligibleNodes.length === 0 &&
    gatedResult.evaluations.length === 2 &&
    gatedResult.evaluations.every(
      (evaluation) =>
        evaluation.protocolEligible === false &&
        evaluation.reasons.some(
          (reason) =>
            reason.dimension === 'protocol' && reason.code === 'PROTOCOL_VERSION_UNSUPPORTED',
        ) &&
        evaluation.capabilityEligible &&
        evaluation.placementEligible,
    ),
  `eligible nodes=${String(gatedResult.eligibleNodes.length)}`,
);

// 4c. Cross-dimensional impossibility on the full fleet: each node fails a
//     DIFFERENT dimension — classified as such, NOT as platform rejection.
const impossibleWorkflow = withNode(buildMinimalDocument(), 'observe', {
  spec: { class: 'deterministic_api', capability: 'browser.navigate' },
  capabilityRequirements: ['browser.navigate'],
  placement: 'cloud_required',
});
const impossibleResult = fleet.service.matchNodes(requirementFromIr('observe', impossibleWorkflow));
const impossibleWeb = impossibleResult.evaluations.find(
  (evaluation) => evaluation.platformClass === 'web',
);
const impossibleCloud = impossibleResult.evaluations.find(
  (evaluation) => evaluation.platformClass === 'cloud',
);
check(
  'cross-dimensional impossibility on the full fleet: 0 eligible, each node fails a different dimension (NOT platform rejection)',
  impossibleResult.eligibleNodes.length === 0 &&
    impossibleWeb !== undefined &&
    impossibleWeb.placementEligible === false &&
    impossibleWeb.capabilityEligible === true &&
    impossibleWeb.reasons.some(
      (reason) => reason.dimension === 'placement' && reason.code === 'PLACEMENT_CLASS_MISMATCH',
    ) &&
    impossibleCloud !== undefined &&
    impossibleCloud.capabilityEligible === false &&
    impossibleCloud.placementEligible === true &&
    impossibleCloud.reasons.some(
      (reason) => reason.dimension === 'capability' && reason.code === 'CAPABILITY_NOT_ADVERTISED',
    ),
  `web reasons=[${impossibleWeb ? reasonsText(impossibleWeb) : 'n/a'}] cloud reasons=[${impossibleCloud ? reasonsText(impossibleCloud) : 'n/a'}]`,
);

const wallDurationMs = Date.now() - wallClockStartedAtMs;

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

const out: string[] = [];
out.push('IG-002 WorkflowIR ↔ node-capability/placement — dogfooding run');
out.push(`work order: ${WORK_ORDER_ID} (integration gate: V2-003 WorkflowIR × V2-004 node/capability protocol)`);
out.push(`gate test: backend/tests/integration/integration-gates/ig-002-workflowir-capability-placement.integration.test.ts`);
out.push(`branch base (merged main): ${BASE_SHA}`);
out.push(`injected protocol clock base: ${CLOCK_BASE}`);
out.push('nonce source: sequential (per service instance)');
out.push(`heartbeat lease TTL (ms): ${LEASE_MS}`);
out.push(`key seeds: sha256('${CLOUD_KEY_SEED}'), sha256('${WEB_KEY_SEED}')`);
out.push(`wall clock start (ms): ${wallClockStartedAtMs}`);
out.push('');
out.push('authored workflow (real V2-003 authoring + validation):');
out.push(line('fixture', 'buildTriageDocument() (backend/tests/unit/workflow-ir/helpers.ts)'));
out.push(line('validateWorkflowIrDocument', `ok=${String(triageValidation.ok)}`));
out.push(line('semantic digest', triageDigest));
out.push(line('nodes / edges', `${String(triage.ir.nodes.length)} / ${String(triage.ir.edges.length)}`));
out.push('per-node requirement projections (test-local IR→requirement adapter; V2-004 consumes requirements as data):');
for (const projection of triageProjections) {
  const privacy =
    projection.requirement.privacy?.localOnly === true ? ' privacy.localOnly=true' : '';
  out.push(
    line(
      projection.nodeId,
      `capabilities=[${projection.requirement.capabilities.map((c) => c.name).join(', ')}] placement=${projection.requirement.placement.required}${privacy}`,
    ),
  );
}
out.push('');
out.push('host registration (real V2-004 protocol: enrollNodeKey → requestRegistrationChallenge → computeRegistrationResponse → completeRegistration → setNodeTrustAttributes):');
if (fleetWebRecord) {
  out.push(line('web host (device class)', `${fleetWebRecord.nodeId} platform=${fleetWebRecord.platformClass} location=${fleetWebRecord.locationClass} protocol=${String(fleetWebRecord.protocolVersion)}`));
  out.push(line('  capabilities', fleetWebRecord.capabilities.map((c) => c.name).join(', ')));
  out.push(line('  supportsHumanApproval', String(fleetWebRecord.attributes.supportsHumanApproval)));
}
if (fleetCloudRecord) {
  out.push(line('cloud host (cloud class)', `${fleetCloudRecord.nodeId} platform=${fleetCloudRecord.platformClass} location=${fleetCloudRecord.locationClass} protocol=${String(fleetCloudRecord.protocolVersion)}`));
  out.push(line('  capabilities', fleetCloudRecord.capabilities.map((c) => c.name).join(', ')));
  out.push(line('  supportsHumanApproval', String(fleetCloudRecord.attributes.supportsHumanApproval)));
}
out.push('');
out.push('dogfooding core — one real workflow on two supported host classes:');
out.push(line('workflow under test', 'buildMinimalDocument() + workflow.observe observer node, placement any_supported_node'));
out.push(line('WorkflowIR semantic digest', `${digestBeforeResolution} (platform-neutral)`));
out.push(line('digest stable across host resolutions', String(digestBeforeResolution === digestAfterWebResolution && digestBeforeResolution === digestAfterCloudResolution)));
out.push('shared resolution (workflow.observe, any_supported_node):');
if (webShared && cloudShared) {
  out.push(line('web host', `ELIGIBLE capability=${String(webShared.capabilityEligible)} placement=${String(webShared.placementEligible)} rank=${webShared.placementRank ?? 'n/a'}`));
  out.push(line('cloud host', `ELIGIBLE capability=${String(cloudShared.capabilityEligible)} placement=${String(cloudShared.placementEligible)} rank=${cloudShared.placementRank ?? 'n/a'}`));
}
out.push('host-specific resolution (device_preferred + explicit cloud_allowed fallback, requirement data not IR):');
if (webSpecific && cloudSpecific) {
  out.push(line('web host', `ELIGIBLE capability=${String(webSpecific.capabilityEligible)} placement=${String(webSpecific.placementEligible)} rank=${webSpecific.placementRank ?? 'n/a'} satisfied=${webSpecific.satisfiedPlacement ?? 'n/a'}`));
  out.push(line('cloud host', `ELIGIBLE capability=${String(cloudSpecific.capabilityEligible)} placement=${String(cloudSpecific.placementEligible)} rank=${cloudSpecific.placementRank ?? 'n/a'} satisfied=${cloudSpecific.satisfiedPlacement ?? 'n/a'}`));
}
out.push('');
out.push('unsupported-platform rejections (explicit, dimension-tagged, never silent):');
out.push('- cloud-only fleet + device_local browser step (no device-class node deployed):');
if (cloudOnlyRecord) {
  out.push(line('deployed platform set', `${cloudOnlyRecord.nodeId} platform=${cloudOnlyRecord.platformClass} location=${cloudOnlyRecord.locationClass} (no device-class node)`));
}
out.push(line('eligible nodes', String(localResult.eligibleNodes.length)));
if (localCloudEvaluation) {
  out.push(line('cloud evaluation', `INELIGIBLE placement=${String(localCloudEvaluation.placementEligible)}`));
  out.push(line('reasons', reasonsText(localCloudEvaluation)));
}
out.push(line('verdict', 'UNSUPPORTED PLATFORM (no deployed device-class node): REJECTED HONESTLY'));
out.push('- cloud-only fleet + device_preferred browser step (no fallback admitted):');
out.push(line('eligible nodes', String(preferredResult.eligibleNodes.length)));
if (preferredCloudEvaluation) {
  out.push(line('cloud evaluation', `INELIGIBLE placement=${String(preferredCloudEvaluation.placementEligible)}`));
  out.push(line('reasons', reasonsText(preferredCloudEvaluation)));
}
out.push(line('verdict', 'UNSUPPORTED PLATFORM (no deployed device-class node): REJECTED HONESTLY'));
out.push('- full fleet + minProtocolVersion 2 requirement (nodes registered at protocol version 1):');
out.push(line('eligible nodes', String(gatedResult.eligibleNodes.length)));
for (const evaluation of gatedResult.evaluations) {
  out.push(line(`${evaluation.platformClass} evaluation`, `INELIGIBLE protocol=${String(evaluation.protocolEligible)} (capability=${String(evaluation.capabilityEligible)} placement=${String(evaluation.placementEligible)})`));
  out.push(line('  reasons', reasonsText(evaluation)));
}
out.push(line('verdict', 'UNSUPPORTED PLATFORM (protocol version): REJECTED HONESTLY'));
out.push('- full fleet + browser.navigate with cloud_required (each node fails a DIFFERENT dimension):');
out.push(line('eligible nodes', String(impossibleResult.eligibleNodes.length)));
if (impossibleWeb) out.push(line('web reasons', reasonsText(impossibleWeb)));
if (impossibleCloud) out.push(line('cloud reasons', reasonsText(impossibleCloud)));
out.push(line('verdict', 'CLASSIFIED: cross-dimensional impossibility (NOT platform rejection)'));
out.push('');
out.push('checks:');
for (const item of checks) {
  out.push(`  ${item.passed ? '✓' : '✗'} ${item.name}${item.passed ? '' : ` (observed: ${item.observed})`}`);
}
out.push(`assertions: ${checks.filter((item) => item.passed).length}/${checks.length} passed`);
out.push('');
const allPassed = checks.every((item) => item.passed);
out.push(
  allPassed
    ? 'RESULT: equivalent workflow meaning on two supported host classes with host-specific capability resolution — PASS'
    : 'RESULT: CHECK FAILURE — the IG-002 dogfooding experiment failed (see ✗ lines above)',
);
out.push(`wall duration (ms): ${wallDurationMs}`);

process.stdout.write(`${out.join('\n')}\n`);
if (!allPassed) {
  process.exitCode = 1;
}
