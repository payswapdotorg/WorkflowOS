/**
 * V2-013 — internal/first-party-artifacts.
 *
 * The six first-party development workflow ARTIFACTS: WorkflowOS's own
 * software-engineering, maintenance, deployment and governance procedures
 * as ORDINARY WorkflowIR documents — authored through the merged V2-003
 * public builder (V2-003 stays the ONLY workflow-semantics authority;
 * these are data, never a second workflow model).
 *
 * Determinism (the frozen "Deterministic-first" discipline):
 *   - every document is a pure function of this file — identical bytes on
 *     every load; the semantic digest (V2-003's) is therefore stable;
 *   - every capability is an EXISTING canonical registry name (pinned by
 *     the boundary battery's registry-conformance tests);
 *   - NO artifact declares `github.pull_request.merge` (the architect's
 *     merge gate — the canonical MAY-NOT), binds any governance-protected
 *     repository surface, or claims a capability outside the first-party
 *     allowlist (pinned by the boundary battery).
 *
 * The execution-policy overlay (proofRequiredSteps) marks the steps whose
 * execution REQUIRES a verified predecessor execution fact — the
 * work order's proof-consumption conformance.
 */

import { createWorkflowIrBuilder } from '../../workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../workflow-ir/index.js';
import type { FirstPartyWorkflowArtifact } from '../types.js';

// ---------------------------------------------------------------------------
// Node factories (deterministic; literal task prose; no wall clock/random)
// ---------------------------------------------------------------------------

function devApiStep(
  id: string,
  capability: 'filesystem.read' | 'filesystem.write' | 'github.repository.read' | 'github.pull_request.create' | 'workflow.execute' | 'workflow.observe',
): WorkflowNode {
  return {
    id,
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability },
    capabilityRequirements: [capability],
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'done', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
}

function agenticStep(
  id: string,
  task: string,
  capabilities: readonly ('filesystem.read' | 'filesystem.write' | 'github.repository.read' | 'github.pull_request.create' | 'workflow.execute' | 'workflow.observe')[],
): WorkflowNode {
  return {
    id,
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task },
    capabilityRequirements: [...capabilities],
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'done', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
}

function humanApprovalStep(id: string, instruction: string): WorkflowNode {
  return {
    id,
    executionClass: 'human',
    spec: { class: 'human', human: { kind: 'approval', instruction } },
    capabilityRequirements: [],
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'human_confirmation',
  };
}

// ---------------------------------------------------------------------------
// The six documents
// ---------------------------------------------------------------------------

/**
 * IMPLEMENTATION: branch, implement red→green, commit, open a PR — and
 * STOP at the architect's review (the merge gate is NOT part of the
 * procedure: no first-party workflow ever merges).
 */
function implementationDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('prepare_branch')
    .addWorkflowInput({ name: 'workOrderRef', type: { kind: 'string' } })
    .addNode(agenticStep('prepare_branch', 'Create the implementation branch rooted at the activated work order base', ['filesystem.read', 'filesystem.write']))
    .addNode(agenticStep('implement_red', 'Write the failing tests that pin the work order contract', ['filesystem.write']))
    .addNode(agenticStep('implement_green', 'Implement the minimal honest change that turns the battery green', ['filesystem.write']))
    // commit + open the PR for architect review (the merge gate stays external)
    .addNode(devApiStep('commit_and_open_pr', 'github.pull_request.create'))
    .addEdge({ from: 'prepare_branch', to: 'implement_red', on: 'success' })
    .addEdge({ from: 'implement_red', to: 'implement_green', on: 'success' })
    .addEdge({ from: 'implement_green', to: 'commit_and_open_pr', on: 'success' })
    .build();
}

/**
 * REVIEW: read the changed repository state, evaluate against the frozen
 * contract, record findings — the HUMAN architect approval step is where
 * the semantic authority is exercised (MAY); merging is never here.
 */
function reviewDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('inspect_diff')
    .addWorkflowInput({ name: 'pullRequestRef', type: { kind: 'string' } })
    .addNode(agenticStep('inspect_diff', 'Read the pull request diff and the repository state it claims', ['github.repository.read', 'filesystem.read']))
    .addNode(agenticStep('verify_contract', 'Re-verify the change against the frozen work order contract and the delivered regressions', ['github.repository.read']))
    .addNode(humanApprovalStep('architect_review', 'The architect reviews and decides: the merge gate (a self-hosted worker never merges its own governing PR)'))
    .addNode(devApiStep('record_findings', 'filesystem.write'))
    .addEdge({ from: 'inspect_diff', to: 'verify_contract', on: 'success' })
    .addEdge({ from: 'verify_contract', to: 'architect_review', on: 'success' })
    .addEdge({ from: 'architect_review', to: 'record_findings', on: { outcome: 'approved' } })
    .addEdge({ from: 'architect_review', to: 'record_findings', on: { outcome: 'rejected' } })
    .build();
}

/**
 * TESTING: run the verification battery, ingest the CI evidence, and
 * record it — the verified predecessor predicate gates the evidence
 * recording step (a proof-required step).
 */
function testingDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('run_battery')
    .addWorkflowInput({ name: 'pullRequestRef', type: { kind: 'string' } })
    .addNode(agenticStep('run_battery', 'Run the affected test batteries on the exact change revision', ['filesystem.read']))
    .addNode(devApiStep('ingest_ci_evidence', 'github.repository.read'))
    .addNode(agenticStep('record_evidence', 'Record the typed verification evidence bound to the exact revision', ['filesystem.write']))
    .addEdge({ from: 'run_battery', to: 'ingest_ci_evidence', on: 'success' })
    .addEdge({ from: 'ingest_ci_evidence', to: 'record_evidence', on: 'success' })
    .build();
}

/**
 * RELEASE: after the architect merge, converge main and prepare the
 * deployable state — the merge itself is the architect's act (external to
 * every first-party workflow).
 */
function releaseDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('observe_merge')
    .addWorkflowInput({ name: 'pullRequestRef', type: { kind: 'string' } })
    .addNode(devApiStep('observe_merge', 'github.repository.read'))
    .addNode(agenticStep('converge_main', 'Converge the local development environment to the merged canonical main', ['filesystem.read', 'filesystem.write']))
    .addNode(devApiStep('verify_deployable', 'workflow.observe'))
    .addEdge({ from: 'observe_merge', to: 'converge_main', on: 'success' })
    .addEdge({ from: 'converge_main', to: 'verify_deployable', on: 'success' })
    .build();
}

/**
 * MAINTENANCE: observe maintenance signals and feed GOVERNED work items
 * (the signals feed the architect's plan; never a direct change).
 */
function maintenanceDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('observe_signals')
    .addWorkflowInput({ name: 'since', type: { kind: 'string' } })
    .addNode(agenticStep('observe_signals', 'Observe the engineering maintenance signals since the given bound', ['filesystem.read']))
    .addNode(agenticStep('prepare_work_item_inputs', 'Prepare the typed maintenance-signal summary for governed Work Item creation', ['filesystem.write']))
    .addNode(humanApprovalStep('architect_triage', 'The architect triages the signals and decides which governed Work Items to open'))
    .addNode(devApiStep('record_triage', 'filesystem.write'))
    .addEdge({ from: 'observe_signals', to: 'prepare_work_item_inputs', on: 'success' })
    .addEdge({ from: 'prepare_work_item_inputs', to: 'architect_triage', on: 'success' })
    .addEdge({ from: 'architect_triage', to: 'record_triage', on: { outcome: 'approved' } })
    .addEdge({ from: 'architect_triage', to: 'record_triage', on: { outcome: 'rejected' } })
    .build();
}

/**
 * DOGFOODING: install a first-party workflow through the SAME universal
 * installation authority, execute it end-to-end, and record the evidence —
 * the execute step requires the verified-predecessor predicate when the
 * dogfood demands execution proof (proof-required step).
 */
function dogfoodingDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('install_workflow')
    .addWorkflowInput({ name: 'procedureKind', type: { kind: 'string' } })
    .addNode(devApiStep('install_workflow', 'workflow.execute'))
    .addNode(agenticStep('execute_workflow', 'Execute the installed workflow end-to-end through the real execution authorities', ['workflow.execute', 'filesystem.read']))
    .addNode(agenticStep('record_evidence', 'Record the dogfooding evidence and corrective observations', ['filesystem.write']))
    .addEdge({ from: 'install_workflow', to: 'execute_workflow', on: 'success' })
    .addEdge({ from: 'execute_workflow', to: 'record_evidence', on: 'success' })
    .build();
}

// ---------------------------------------------------------------------------
// The frozen library (canonical kind order)
// ---------------------------------------------------------------------------

/** All six first-party artifacts, in the frozen canonical kind order. */
export const FIRST_PARTY_WORKFLOW_ARTIFACTS: readonly FirstPartyWorkflowArtifact[] = [
  {
    kind: 'implementation',
    slug: 'wfos-dev-implementation',
    name: 'WorkflowOS implementation procedure',
    description:
      'The first-party implementation workflow: branch from the activated work order base, implement red→green, commit, and open the pull request for architect review (the merge gate stays external).',
    document: implementationDocument(),
    executionPolicy: { proofRequiredSteps: [] },
  },
  {
    kind: 'review',
    slug: 'wfos-dev-review',
    name: 'WorkflowOS review procedure',
    description:
      'The first-party review workflow: inspect the diff, re-verify the frozen contract, exercise the architect approval gate, and record the typed findings.',
    document: reviewDocument(),
    executionPolicy: { proofRequiredSteps: ['architect_review'] },
  },
  {
    kind: 'testing',
    slug: 'wfos-dev-testing',
    name: 'WorkflowOS verification procedure',
    description:
      'The first-party testing workflow: run the affected batteries, ingest the CI evidence, and record the typed verification evidence bound to the exact revision.',
    document: testingDocument(),
    executionPolicy: { proofRequiredSteps: ['record_evidence'] },
  },
  {
    kind: 'release',
    slug: 'wfos-dev-release',
    name: 'WorkflowOS release procedure',
    description:
      'The first-party release workflow: observe the architect merge, converge the development environment, and verify the deployable runtime state.',
    document: releaseDocument(),
    executionPolicy: { proofRequiredSteps: ['converge_main'] },
  },
  {
    kind: 'maintenance',
    slug: 'wfos-dev-maintenance',
    name: 'WorkflowOS maintenance procedure',
    description:
      'The first-party maintenance workflow: observe engineering signals, prepare the governed Work Item inputs, and triage through the architect.',
    document: maintenanceDocument(),
    executionPolicy: { proofRequiredSteps: [] },
  },
  {
    kind: 'dogfooding',
    slug: 'wfos-dev-dogfooding',
    name: 'WorkflowOS dogfooding procedure',
    description:
      'The first-party dogfooding workflow: install a first-party workflow through the universal authority, execute it end-to-end, and record the evidence.',
    document: dogfoodingDocument(),
    executionPolicy: { proofRequiredSteps: ['execute_workflow'] },
  },
];

/** The canonical kind order lookup (deterministic). */
export function artifactByKind(kind: string): FirstPartyWorkflowArtifact | undefined {
  return FIRST_PARTY_WORKFLOW_ARTIFACTS.find((artifact) => artifact.kind === kind);
}
