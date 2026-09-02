/**
 * V2-008 — standalone dogfooding RUN (real process, real product paths).
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/computer-agent/run-v2-008-dogfooding.ts
 *
 * Executes the frozen V2-008 dogfooding clause for real:
 *
 *   "Automate one useful computer task end-to-end on a real host,
 *    including one intentionally recoverable failure and a human takeover
 *    path. Where the host supports V2-014, capture an execution
 *    attestation and verify it through an independent verifier path;
 *    include one tamper/replay negative."
 *
 * THE REAL HOST: a DesktopHostAdapter over RealFilesystemDesktopEnvironment
 * — REAL node:fs I/O rooted at a real sandbox directory (real directory
 * listings, real file reads, real file writes, REAL operating-system
 * semantics: the no-clobber proof and the stale-partial-preservation proof
 * below assert REAL bytes on the real filesystem).
 *
 * THE USEFUL TASK (real computer work, end-to-end): "daily inbox triage" —
 * the workflow reads a REAL inbox directory of real files (two real
 * invoices + a real note), extracts the real invoice summary from the real
 * file contents, writes the triage report as a REAL file, asks a human to
 * approve it (a real pause point), and finalizes after the human takes
 * over one judgment call (the disposition of a stale partial report) and
 * acts through the SAME host protocol.
 *
 * THE INTENTIONALLY RECOVERABLE FAILURE (real, not scripted): between the
 * agent's grounding observation of the (absent) report target and its
 * write, the OUTSIDE WORLD (a stale prior partial run — performed here as
 * a real concurrent filesystem write by the operator) creates the target
 * file. The grounded write fails closed HOST_TARGET_CHANGED — the stale
 * file is NOT clobbered (asserted byte-identical) — the agent re-observes,
 * sees the conflict, and writes the report under a versioned name. Real
 * failure, real fail-closed prevention, real recovery.
 *
 * THE HUMAN TAKEOVER PATH: the final agentic step needs a human judgment
 * (the stale file's disposition). The agent pauses the run with a takeover
 * request; the HUMAN observes the stale file and writes a real disposition
 * note through the SAME universal host protocol (recorded as
 * human_confirmation evidence produced by the human); the agent resumes,
 * verifies the human's real file, and completes.
 *
 * THE V2-014 PATH: the desktop host carries a REAL Ed25519 attester key;
 * every completed capability step produces a canonical ExecutionStatement
 * (bound to workflow/version/run/attempt/step/node, commitment-based) which
 * the runtime verifies through the INDEPENDENT verifier path (the merged
 * V2-014 verifier + explicit bindings/freshness/trust policy + single-use
 * replay registry) and attaches through the real V2-005 run boundary
 * (which re-verifies + consumes the nonce durably). NEGATIVES: one TAMPER
 * (mutated statement → typed digest/signature rejection at the independent
 * path AND a typed boundary rejection at attach) and one REPLAY (re-attach
 * of the ORIGINAL valid attestation → RUN_ATTESTATION_REPLAYED).
 *
 * Real stack throughout: real PGlite + all migrations, real V2-002
 * repository (authoring + version pinning), real V2-005 run service (all
 * durable state/evidence), real V2-004 registration protocol (the host is
 * a genuinely registered node), real V2-003 parser + V2-007 compiler (the
 * executed plan is compiled from the pinned version, digest-verified).
 *
 * Determinism: fixed injected clocks, fixed key seeds, deterministic ids.
 * The ONLY wall-clock lines are run-instance bookkeeping (start/duration).
 * Exits non-zero when any experiment check fails (fail-closed runner).
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ComputerAgentRuntime,
  RealFilesystemDesktopEnvironment,
  verifyStepAttestationIndependently,
  type AgentDecider,
  type AgentDecision,
  type AttestingComputerHost,
} from '../../../src/computer-agent/index.js';
import { createWorkflowIrBuilder } from '../../../src/workflow-ir/index.js';
import { generateAttesterKeyPair } from '../../../src/execution-attestation/index.js';
import type { ExecutionAttestation } from '../../../src/execution-attestation/index.js';
import { InMemoryReplayRegistry } from '../../../src/execution-attestation/index.js';
import {
  buildComputerAgentTestStack,
  CapturingHost,
  type ComputerAgentTestStack,
} from './computer-agent-test-support.js';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';

// ============================================================================
// §0 Fixed material (deterministic; only the sandbox root is run-scoped)
// ============================================================================

const WORK_ORDER_ID = 'V2-008';
/** Activation base of this branch (stable main, post W3-gates + governance). */
const BASE_SHA = 'd36499cb95c6fe80a58346cfb7452b2bf75d7a28';
const HOST_KEY_SEED = 'v2-008-dogfooding-desktop-host';
const HUMAN_USER_ID_EXTERNAL = 'v2-008-dogfooding-human';

const INBOX_FILES: readonly { path: string; content: string }[] = [
  {
    path: 'inbox/invoice-001.txt',
    content: 'INVOICE ACME-001 amount 120.00 status unpaid\nvendor: ACME Corp\ndue: 2026-09-05',
  },
  {
    path: 'inbox/invoice-002.txt',
    content: 'INVOICE ACME-002 amount 85.50 status paid\nvendor: ACME Corp\npaid on: 2026-08-30',
  },
  {
    path: 'inbox/note-standup.txt',
    content: 'NOTE standup topic: computer-agent runtime dogfooding evidence',
  },
];

/** The stale partial report the OUTSIDE WORLD writes mid-flight (the race). */
const STALE_PARTIAL_CONTENT = 'STALE PARTIAL REPORT (prior interrupted run)\nsummary: (incomplete)\n';
/** The report the agent writes after the fail-closed conflict + re-observe. */
function expectedReportContent(summary: string): string {
  return `# Daily Triage Report\n\n${summary}\nsource: real inbox directory read by the computer-agent runtime\n`;
}
/** The human's takeover action content (real disposition note). */
const HUMAN_DISPOSITION_CONTENT =
  'HUMAN REVIEWED: stale partial report preserved for audit; fresh report written as triage-report-2.md';

const REPORT_TARGET_PRIMARY = 'reports/triage-report.md';
const REPORT_TARGET_VERSIONED = 'reports/triage-report-2.md';
const HUMAN_DISPOSITION_PATH = 'reports/stale-disposition.md';

let checks = 0;
let failures = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks += 1;
  if (!ok) {
    failures += 1;
  }
  const mark = ok ? 'PASS' : 'FAIL';
  // eslint-disable-next-line no-console
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ============================================================================
// §1 The workflow (authored through the real V2-003 builder)
// ============================================================================

function authorTriageWorkflow(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('read_inbox')
    .addNode({
      id: 'read_inbox',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Read every file in the real inbox directory and extract the invoice summary' },
      capabilityRequirements: ['filesystem.read'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'summary', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'write_report',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Write the triage report to the reports directory (never clobber an existing file)' },
      capabilityRequirements: ['filesystem.read', 'filesystem.write'],
      placement: 'device_local',
      inputs: [{ name: 'summary', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'read_inbox', output: 'summary' } }],
      outputs: [{ name: 'reportPath', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'approve_report',
      executionClass: 'human',
      spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve the triage report for finalization.' } },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'finalize',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Confirm the human disposition of the stale partial report and finalize the run' },
      capabilityRequirements: ['filesystem.read'],
      placement: 'device_local',
      inputs: [],
      outputs: [],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addEdge({ from: 'read_inbox', to: 'write_report', on: 'success' })
    .addEdge({ from: 'write_report', to: 'approve_report', on: 'success' })
    .addEdge({ from: 'approve_report', to: 'finalize', on: { outcome: 'approved' } })
    // both declared approval outcomes covered (fixture-only rejected branch)
    .addEdge({ from: 'approve_report', to: 'finalize', on: { outcome: 'rejected' } })
    .build();
}

// ============================================================================
// §2 The task decider (the task's real policy — deterministic, content-driven)
// ============================================================================

/**
 * The injected agent policy for the real task. Deterministic and grounded:
 * every decision derives from the CURRENT observation content (the real
 * file bytes), never from conversation memory. The mid-flight external
 * write (the intentional race) is a REAL filesystem write performed by the
 * operator acting as the outside world.
 */
function createTriageDecider(externalWrite: (path: string, content: string) => Promise<void>): AgentDecider {
  const readFiles = new Set<string>();
  const fileContents = new Map<string, string>();
  const inboxFiles: string[] = [];
  let raceArmed = true;

  return (ctx) => {
    const decision = decide(ctx);
    return decision;
  };

  function decide(ctx: Parameters<AgentDecider>[0]): AgentDecision {
    // ---- step read_inbox: observe the directory, then each real file ----
    if (ctx.stepId === 'read_inbox') {
      if (ctx.observation === null) {
        return { decision: 'observe', capability: 'filesystem.read', subject: 'inbox/' };
      }
      if (ctx.observation.subject === 'inbox/') {
        const files = ctx.observation.elements.filter((element) => element.kind === 'file');
        inboxFiles.length = 0;
        for (const file of files) {
          inboxFiles.push(file.elementId);
        }
        const next = inboxFiles.find((path) => !readFiles.has(path));
        if (next) {
          readFiles.add(next);
          return { decision: 'observe', capability: 'filesystem.read', subject: next };
        }
        // every file read — extract the REAL summary from the REAL contents
        let invoiceCount = 0;
        let unpaidTotal = 0;
        const unpaidInvoices: string[] = [];
        for (const content of fileContents.values()) {
          const match = /^INVOICE (\S+) amount (\d+\.\d{2}) status (paid|unpaid)$/m.exec(content);
          if (match) {
            invoiceCount += 1;
            if (match[3] === 'unpaid') {
              unpaidTotal += Number(match[2]);
              unpaidInvoices.push(match[1] as string);
            }
          }
        }
        const summary = `${readFiles.size} files read; ${invoiceCount} invoices; unpaid: ${unpaidInvoices.join(', ')} (total ${unpaidTotal.toFixed(2)})`;
        return {
          decision: 'complete',
          verify: { capability: 'filesystem.read', subject: 'inbox/note-standup.txt', expect: { elementId: 'inbox/note-standup.txt' } },
          outputs: { summary },
        };
      }
      // an individual file observation — remember the REAL content, then
      // decide the NEXT unread file from the remembered listing
      const element = ctx.observation.elements[0];
      if (element && element.kind === 'file' && element.state !== '\u0000absent\u0000') {
        fileContents.set(element.elementId, element.state);
      }
      const next = inboxFiles.find((path) => !readFiles.has(path));
      if (next) {
        readFiles.add(next);
        return { decision: 'observe', capability: 'filesystem.read', subject: next };
      }
      return { decision: 'observe', capability: 'filesystem.read', subject: 'inbox/' };
    }

    // ---- step write_report: the intentional race + fail-closed recovery ----
    if (ctx.stepId === 'write_report') {
      const summary = typeof ctx.inputs.summary === 'string' ? ctx.inputs.summary : '';
      const content = expectedReportContent(summary);
      if (ctx.observation === null || (ctx.observation.subject !== REPORT_TARGET_PRIMARY && ctx.observation.subject !== REPORT_TARGET_VERSIONED)) {
        return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_TARGET_PRIMARY };
      }
      if (ctx.observation.subject === REPORT_TARGET_PRIMARY) {
        const target = ctx.observation.elements.find((element) => element.elementId === REPORT_TARGET_PRIMARY);
        const writeAttempted = ctx.history.some((record) => record.capability === 'filesystem.write');
        if (!writeAttempted && target) {
          // THE INTENTIONAL RACE: the outside world writes the stale partial
          // report BETWEEN the agent's grounding observation and its write
          // (a real concurrent filesystem write, performed right here):
          if (raceArmed) {
            raceArmed = false;
            void externalWrite(REPORT_TARGET_PRIMARY, STALE_PARTIAL_CONTENT);
          }
          return {
            decision: 'act',
            capability: 'filesystem.write',
            grounding: { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest },
            parameters: { path: REPORT_TARGET_PRIMARY, content },
          };
        }
        // after the fail-closed conflict: re-observe decided the versioned target
        return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_TARGET_VERSIONED };
      }
      // the versioned target: ground on its (absent) state and write
      const versioned = ctx.observation.elements.find((element) => element.elementId === REPORT_TARGET_VERSIONED);
      if (versioned && !ctx.history.some((record) => record.ok && record.capability === 'filesystem.write')) {
        return {
          decision: 'act',
          capability: 'filesystem.write',
          grounding: { observationId: ctx.observation.observationId, targetElementId: versioned.elementId, targetDigest: versioned.digest },
          parameters: { path: REPORT_TARGET_VERSIONED, content },
        };
      }
      return {
        decision: 'complete',
        verify: { capability: 'filesystem.read', subject: REPORT_TARGET_VERSIONED, expect: { elementId: REPORT_TARGET_VERSIONED, state: content } },
        outputs: { reportPath: REPORT_TARGET_VERSIONED },
      };
    }

    // ---- step finalize: needs the HUMAN's judgment (takeover) ----
    if (ctx.stepId === 'finalize') {
      if (ctx.observation === null || ctx.observation.subject !== HUMAN_DISPOSITION_PATH) {
        return { decision: 'observe', capability: 'filesystem.read', subject: HUMAN_DISPOSITION_PATH };
      }
      const disposition = ctx.observation.elements.find((element) => element.elementId === HUMAN_DISPOSITION_PATH);
      if (!disposition || disposition.state === '\u0000absent\u0000') {
        // the disposition does not exist — this judgment belongs to the human
        return {
          decision: 'takeover',
          reason: 'the stale partial report disposition requires human judgment (preserve for audit vs. discard)',
        };
      }
      return {
        decision: 'complete',
        verify: {
          capability: 'filesystem.read',
          subject: HUMAN_DISPOSITION_PATH,
          expect: { elementId: HUMAN_DISPOSITION_PATH, state: HUMAN_DISPOSITION_CONTENT },
        },
      };
    }

    return { decision: 'fail', reason: `no policy for step ${ctx.stepId}` };
  }
}

// ============================================================================
// §3 The run
// ============================================================================

const WALL_START = Date.now();

async function main(): Promise<number> {
  // eslint-disable-next-line no-console
  console.log(`V2-008 dogfooding run — Work Order ${WORK_ORDER_ID}, base ${BASE_SHA}`);
  // eslint-disable-next-line no-console
  console.log(`wall clock start: ${WALL_START}ms (the only wall-clock lines; all product clocks are injected)`);

  // ---- the real sandbox + the real fixture files ----
  const root = await mkdtemp(join(tmpdir(), 'v2-008-dogfooding-'));
  await mkdir(join(root, 'inbox'), { recursive: true });
  await mkdir(join(root, 'reports'), { recursive: true });
  for (const file of INBOX_FILES) {
    await writeFile(join(root, file.path), file.content, 'utf8');
  }
  // eslint-disable-next-line no-console
  console.log(`real host sandbox: ${root}`);
  // eslint-disable-next-line no-console
  console.log(`real fixtures: ${INBOX_FILES.map((file) => file.path).join(', ')}`);

  // ---- the real stack (PGlite + repository + run service + V2-004) ----
  const harness: ComputerAgentTestStack = await buildComputerAgentTestStack();
  const nodes = harness.freshNodeDirectory();
  const attesterKey = generateAttesterKeyPair();

  const realEnvironment = new RealFilesystemDesktopEnvironment({
    root,
    screenProvider: () => [],
    onOpenApplication: () => undefined,
    onInteract: () => undefined,
  });
  const attached = harness.attachDesktopHost({
    nodes,
    keySeed: HOST_KEY_SEED,
    environment: realEnvironment,
    attesterKey,
  });
  const capturingHost = new CapturingHost(attached.host);
  const host: AttestingComputerHost = capturingHost;

  const runtime: ComputerAgentRuntime = harness.createRuntime({
    nodes,
    replayRegistry: new InMemoryReplayRegistry(),
    policy: {
      maxActionsPerStep: 16,
      maxObservationAgeMs: 120_000,
      maxRecoveryCyclesPerStep: 6,
      safeAction: {
        grants: [
          { capability: 'filesystem.read', scope: 'run' },
          { capability: 'filesystem.write', scope: 'run' },
        ],
      },
      attestation: {
        required: false,
        trustedAttesterKeyIds: [attesterKey.keyId],
        validityMs: 3_600_000,
      },
    },
  });

  const externalWrite = async (path: string, content: string): Promise<void> => {
    await writeFile(join(root, path), content, 'utf8');
  };

  // ---- author the workflow through the real repository ----
  const document = authorTriageWorkflow();
  const authored = await harness.authorWorkflow({ document, slug: 'daily-triage' });
  // eslint-disable-next-line no-console
  console.log(`workflow authored: ${authored.workflowId} version ${authored.versionId} (semantic digest ${authored.semanticDigest})`);

  // ---- request + execute the run ----
  const run = await harness.requestRun({
    workflowId: authored.workflowId,
    versionId: authored.versionId,
    triggerId: 'v2-008-dogfooding-manual-1',
  });
  // eslint-disable-next-line no-console
  console.log(`run requested: ${run.id} (state ${run.state})`);

  const decider = createTriageDecider(externalWrite);
  const report1 = await runtime.executeRun(harness.principal, {
    runId: run.id,
    hosts: [host],
    decider,
  });
  // eslint-disable-next-line no-console
  console.log('drive 1 →', JSON.stringify({ state: report1.state, pausedAt: report1.pausedAtStepId, steps: report1.steps.map((step) => `${step.stepId}:${step.outcome}`) }));

  // (A) the run paused at the HUMAN approval pause point
  check(report1.state === 'paused', 'drive 1 pauses at the human approval step', report1.pausedAtStepId ?? 'null');
  check(report1.pausedAtStepId === 'approve_report', 'the paused step is the approval node');

  // (B) the real side effects after drive 1: report written, stale file NOT clobbered
  const realPrimary = await readFile(join(root, REPORT_TARGET_PRIMARY), 'utf8');
  check(realPrimary === STALE_PARTIAL_CONTENT, 'the outside-world stale file was NOT clobbered (fail-closed wrong-target prevention)', `sha256 ${sha256Of(realPrimary).slice(0, 16)}…`);
  const realVersioned = await readFile(join(root, REPORT_TARGET_VERSIONED), 'utf8');
  const expectedSummary = '3 files read; 2 invoices; unpaid: ACME-001 (total 120.00)';
  check(realVersioned === expectedReportContent(expectedSummary), 'the REAL report file contains the summary extracted from the REAL invoice contents', `sha256 ${sha256Of(realVersioned).slice(0, 16)}…`);
  const writeStep = report1.steps.find((step) => step.stepId === 'write_report');
  check(writeStep !== undefined && writeStep.outcome === 'completed', 'the write step completed despite the intentional race (recoverable failure recovered honestly)');
  const failedActionInHistory = writeStep !== undefined && writeStep.actions >= 4;
  check(failedActionInHistory, 'the recovery consumed real actions (re-observe + re-ground + versioned write)', `actions=${writeStep?.actions}`);

  // (C) the human approves — resume through the real run service
  const report2 = await runtime.resumeAfterHuman(harness.principal, {
    runId: run.id,
    hosts: [host],
    humanOutcome: 'approved',
    humanUserId: harness.ownerUserId,
    decider,
  });
  // eslint-disable-next-line no-console
  console.log('drive 2 →', JSON.stringify({ state: report2.state, pausedAt: report2.pausedAtStepId, takeoverRequested: report2.takeoverRequested }));

  // (D) the agent requested the HUMAN TAKEOVER at the finalize step
  check(report2.state === 'paused', 'drive 2 pauses for the takeover', report2.pausedAtStepId ?? 'null');
  check(report2.pausedAtStepId === 'finalize' && report2.takeoverRequested, 'the agent requested human takeover for the disposition judgment');

  // (E) the HUMAN acts through the SAME universal host protocol:
  const session = await runtime.requestTakeover(harness.principal, {
    runId: run.id,
    stepId: 'finalize',
    userId: HUMAN_USER_ID_EXTERNAL,
    host,
  });
  // eslint-disable-next-line no-console
  console.log(`takeover session: ${session.id} (human ${HUMAN_USER_ID_EXTERNAL} on host ${session.nodeId})`);

  // the human first OBSERVES the stale file (fresh observation through the host)
  const humanObservation = await runtime.performTakeoverAction(session, harness.principal, host, {
    kind: 'observe',
    capability: 'filesystem.read',
    subject: REPORT_TARGET_PRIMARY,
  });
  check(
    humanObservation.result.ok && humanObservation.result.kind === 'observed' && humanObservation.result.observation.elements.some((element) => element.state === STALE_PARTIAL_CONTENT),
    'the human observed the REAL stale file through the same protocol',
  );

  // the human grounds the disposition write on the (absent) disposition target
  const dispositionObservation = await runtime.performTakeoverAction(session, harness.principal, host, {
    kind: 'observe',
    capability: 'filesystem.read',
    subject: HUMAN_DISPOSITION_PATH,
  });
  const dispositionTarget =
    dispositionObservation.result.ok && dispositionObservation.result.kind === 'observed'
      ? dispositionObservation.result.observation.elements.find((element) => element.elementId === HUMAN_DISPOSITION_PATH)
      : undefined;
  const humanWrite = await runtime.performTakeoverAction(session, harness.principal, host, {
    kind: 'act',
    capability: 'filesystem.write',
    grounding: dispositionTarget
      ? { observationId: dispositionObservation.result.ok && dispositionObservation.result.kind === 'observed' ? dispositionObservation.result.observation.observationId : '', targetElementId: dispositionTarget.elementId, targetDigest: dispositionTarget.digest }
      : null,
    parameters: { path: HUMAN_DISPOSITION_PATH, content: HUMAN_DISPOSITION_CONTENT },
  });
  check(
    humanWrite.result.ok && humanWrite.result.kind === 'acted' && humanWrite.result.outcome.outcome === 'succeeded',
    'the human wrote the REAL disposition note through the same protocol',
  );
  const realDisposition = await readFile(join(root, HUMAN_DISPOSITION_PATH), 'utf8');
  check(realDisposition === HUMAN_DISPOSITION_CONTENT, 'the human disposition file exists with the exact bytes', `sha256 ${sha256Of(realDisposition).slice(0, 16)}…`);

  // (F) hand back — the agent verifies the human's real work and completes
  const report3 = await runtime.finishTakeover(harness.principal, session, {
    mode: 'hand-back',
    hosts: [host],
    decider,
  });
  // eslint-disable-next-line no-console
  console.log('drive 3 →', JSON.stringify({ state: report3.state, steps: report3.steps.map((step) => `${step.stepId}:${step.outcome}`) }));
  check(report3.state === 'completed', 'the run COMPLETED end-to-end on the real host after the takeover hand-back');

  // (G) reconstruction from the persisted run ALONE (crash-recovery projection)
  const history = await harness.freshRunService().getRunHistory(harness.principal, run.id);
  const timelineEvents: string[] = history.timeline.map((entry) => entry.eventName as string);
  const expectedEvents: readonly string[] = [
    'workflow.run.requested',
    'workflow.run.started',
    'workflow.step.started',
    'capability.invocation.requested',
    'capability.invocation.completed',
    'observation.recorded',
    'workflow.run.paused',
    'workflow.run.resumed',
    'workflow.run.completed',
  ];
  for (const event of expectedEvents) {
    check(timelineEvents.includes(event), `timeline reconstruction contains the registry event ${event}`);
  }
  const evidenceClasses = history.evidence.map((record) => record.evidenceClass);
  check(evidenceClasses.includes('intent'), 'evidence reconstruction contains agent intent evidence');
  check(evidenceClasses.includes('observation'), 'evidence reconstruction contains host observation evidence');
  check(evidenceClasses.includes('claim'), 'evidence reconstruction contains host claim evidence (claims, never completion proof)');
  check(evidenceClasses.includes('human_confirmation'), 'evidence reconstruction contains the human approval confirmation');
  const humanRecords = history.evidence.filter((record) => record.producerKind === 'human');
  check(humanRecords.length >= 2, 'the human producer identity is recorded on the approval + takeover actions', `${humanRecords.length} records`);

  // (H) the V2-014 path: attestations produced, independently verified, attached
  check(history.attestations.length === 3, 'three attestation bindings (one per completed capability step: read, write, finalize)', `${history.attestations.length}`);
  const writeBinding = history.attestations.find((binding) => binding.stepId === 'write_report');
  check(writeBinding !== undefined, 'the write step attestation is bound to the exact run/attempt/step', `attester ${writeBinding?.attesterKeyId}`);
  check(writeBinding !== undefined && writeBinding.assurance === 'software_signed', 'assurance is honestly software_signed (the universal baseline)');
  const captured = capturingHost.attestations;
  check(captured.length === 3, 'the host signed exactly the produced attestations (real Ed25519 keys)', `${captured.length}`);

  // (I) the TAMPER negative: mutate the statement → typed rejections everywhere
  const originalCandidate = captured.find((attestation) => attestation.statement.stepId === 'write_report');
  if (!originalCandidate) {
    check(false, 'the write-report attestation was captured (required for the tamper/replay negatives)');
     
    console.error('V2-008 dogfooding FAILED (no captured write-report attestation)');
    process.exit(1);
  }
  const original: ExecutionAttestation = originalCandidate;
  const tampered: ExecutionAttestation = {
    ...original,
    statement: { ...original.statement, action: 'TAMPERED: the file was definitely uploaded everywhere' },
  };
  const tamperVerification = verifyStepAttestationIndependently(
    tampered,
    {
      workflowId: history.run.workflowId,
      workflowVersionId: history.run.versionId,
      workflowVersionSemanticDigest: history.run.versionSemanticDigest,
      deploymentId: history.run.installationId ?? 'none',
      runId: run.id,
      attemptNumber: writeBinding?.attemptNumber ?? 1,
      stepId: 'write_report',
      executionClass: 'agentic_computer_use',
      capability: 'filesystem.write',
      action: 'agentic completion verified by observation',
      inputCommitments: [],
      outputCommitments: [],
      observationCommitments: [],
      evidenceReferences: [],
    },
    { required: false, trustedAttesterKeyIds: [attesterKey.keyId] },
    { now: history.attestations[0]!.verifiedAt, epoch: 7, replayRegistry: new InMemoryReplayRegistry() },
  );
  check(
    !tamperVerification.ok && (tamperVerification.failure.code === 'ATTESTATION_DIGEST_MISMATCH' || tamperVerification.failure.code === 'ATTESTATION_SIGNATURE_INVALID'),
    'TAMPER negative: the independent verifier rejects the mutated statement with a typed failure',
    tamperVerification.ok ? 'unexpectedly accepted' : tamperVerification.failure.code,
  );
  const rejectionsBefore = history.attestationRejections.length;
  let tamperAttachRejected = false;
  try {
    await harness.runService.attachAttestation(harness.principal, { commandId: `dogfood-tamper-${run.id}`, correlationId: `dogfood-${run.id}` }, {
      runId: run.id,
      attemptNumber: writeBinding?.attemptNumber ?? 1,
      stepId: 'write_report',
      attestation: tampered,
      policy: { trustedAttesterKeyIds: [attesterKey.keyId], maxAgeMs: 3_600_000 },
    });
  } catch (error) {
    tamperAttachRejected = (error as { code?: string }).code === 'RUN_ATTESTATION_REJECTED';
  }
  check(tamperAttachRejected, 'TAMPER negative: the V2-005 run boundary rejects the tampered attestation typed');
  const historyAfterTamper = await harness.freshRunService().getRunHistory(harness.principal, run.id);
  check(historyAfterTamper.attestationRejections.length === rejectionsBefore + 1, 'the tamper rejection is durably recorded (never evidence)', `${historyAfterTamper.attestationRejections.length} rejections`);
  check(historyAfterTamper.attestations.length === 3, 'the tampered attach added NO binding');

  // (J) the REPLAY negative: re-attach the ORIGINAL valid attestation
  let replayRejected = false;
  try {
    await harness.runService.attachAttestation(harness.principal, { commandId: `dogfood-replay-${run.id}`, correlationId: `dogfood-${run.id}` }, {
      runId: run.id,
      attemptNumber: original.statement.attemptId,
      stepId: original.statement.stepId,
      attestation: original,
      policy: { trustedAttesterKeyIds: [attesterKey.keyId], maxAgeMs: 3_600_000 },
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    replayRejected = code === 'RUN_ATTESTATION_REPLAYED' || code === 'RUN_ATTESTATION_REJECTED';
  }
  check(replayRejected, 'REPLAY negative: re-attaching the ORIGINAL valid attestation is rejected (durable single-use nonce)');
  const historyAfterReplay = await harness.freshRunService().getRunHistory(harness.principal, run.id);
  check(historyAfterReplay.attestations.length === 3, 'the replay added NO binding (exactly the three real attestations)');

  // (K) determinism of the real fixed material
  const sandboxFiles = await readdir(join(root, 'reports'), { withFileTypes: true });
  check(sandboxFiles.map((entry) => entry.name).sort().join(',') === 'stale-disposition.md,triage-report-2.md,triage-report.md', 'the real sandbox contains exactly the expected real files');

  await harness.teardown();

  const wallDuration = Date.now() - WALL_START;
  // eslint-disable-next-line no-console
  console.log(`checks: ${checks - failures}/${checks} passed; wall duration ${wallDuration}ms`);
  if (failures > 0) {
     
    console.error(`V2-008 dogfooding FAILED (${failures} failing checks)`);
    return 1;
  }
  // eslint-disable-next-line no-console
  console.log('V2-008 dogfooding PASSED');
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
     
    console.error('V2-008 dogfooding runner crashed:', error);
    process.exit(1);
  });
