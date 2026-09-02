/**
 * V2-008 — cross-host integration on the REAL stack (real PGlite + V2-002 +
 * V2-005 DefaultWorkflowRunService as the runtime's recorder + real V2-004
 * registration + real Ed25519 attester keys): the web (browser), desktop and
 * mobile host classes drive ONE universal invocation protocol.
 *
 * Pins the Work Order's required regressions:
 *   - WEB: a browser step (observe → grounded click → verify) completes on
 *     the web host adapter over the scripted browser environment, with the
 *     real attestation path (ONE software_signed binding);
 *   - DESKTOP PARITY: the desktop host produces the IDENTICAL protocol
 *     shape (same step-report numbers, same evidence-class sequence, same
 *     invocation discipline) — platform differences appear ONLY in the
 *     capabilities offered, never in protocol semantics (constitution §4);
 *   - IDENTICAL IR SEMANTIC DIGESTS: authoring the same WorkflowIR content
 *     twice produces the identical V2-003 semantic digest (content-derived,
 *     slug/org-independent) — both runs pin the same digest;
 *   - TARGET-CHANGED RACE RECOVERY: an external write between observe and
 *     act fails the grounded act HOST_TARGET_CHANGED (no clobber), the loop
 *     re-observes, re-grounds on the fresh digest and completes — the
 *     durable invocations show failed-then-succeeded honestly;
 *   - MOBILE: a phone step answers a ringing call (grounded answer, the call
 *     REALLY becomes active); with NO attester key the runtime records the
 *     HONEST attestation-absence evidence (never a fabricated binding);
 *   - LOCALITY (constitution §12): a device_local step NEVER routes to a
 *     cloud node that advertises the very same capabilities (the merged
 *     V2-004 matcher's locality dimension is the discriminator); a step
 *     with only device hosts registered fails AGENT_NO_ELIGIBLE_HOST;
 *     a device_local step with only a cloud node registered fails the same;
 *   - MULTI-HOST: a two-step workflow routes each step to a DIFFERENT host
 *     through the merged V2-004 matcher (capability steering), both steps
 *     complete on their own hosts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AgentDecider } from '../../../src/computer-agent/index.js';
import type { WorkflowRunHistory } from '../../../src/workflow-runs/index.js';
import {
  buildComputerAgentTestStack,
  buildAgenticWriteDocument,
  buildBrowserClickDocument,
  buildCloudOnlyDocument,
  buildMobileAnswerDocument,
  buildMultiHostDocument,
  createObserveWriteVerifyDecider,
  freshBrowserEnvironment,
  freshDesktopEnvironment,
  freshMobileEnvironment,
  newAttesterKey,
  attestationPolicyFor,
  requirementSetOf,
  TRIAGE_REPORT_CONTENT,
  WORKFLOW_INPUTS,
  type ComputerAgentTestStack,
} from './computer-agent-test-support.js';

const REPORT_PATH = WORKFLOW_INPUTS.reportPath;
const FORM_URL = 'https://integration.example/triage';
const RACE_CONTENT = 'RACE-RECOVERY-REPORT';
/** The identical protocol shape every single-step agentic drive produces. */
const SINGLE_STEP_EVIDENCE_CLASSES = [
  'intent',
  'observation',
  'intent',
  'claim',
  'intent',
  'observation',
  'verification',
];

/** The web drive decider: observe the page → grounded click → verify. */
function createBrowserClickDecider(): AgentDecider {
  return (ctx) => {
    const formUrl = ctx.inputs.formUrl as string;
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

/** The mobile drive decider: observe the call log → grounded answer → verify. */
function createAnswerCallDecider(): AgentDecider {
  return (ctx) => {
    if (ctx.observation === null) {
      return { decision: 'observe', capability: 'phone.call.observe', subject: 'call-log' };
    }
    const answered = ctx.history.some((record) => record.capability === 'phone.call.answer' && record.ok);
    if (!answered) {
      const target = ctx.observation.elements.find((element) => element.elementId === 'call-oncall-001');
      return {
        decision: 'act',
        capability: 'phone.call.answer',
        grounding: target
          ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest }
          : null,
        parameters: {},
      };
    }
    return {
      decision: 'complete',
      verify: {
        capability: 'phone.call.observe',
        subject: 'call-log',
        expect: { elementId: 'call-oncall-001', state: 'active' },
      },
      outputs: { answered: true },
    };
  };
}

describe('V2-008 computer-agent runtime — cross-host (web / desktop / mobile) on the real stack', () => {
  let harness: ComputerAgentTestStack;

  beforeAll(async () => {
    harness = await buildComputerAgentTestStack();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it('web: a browser click drive (observe → grounded click → verify) completes with a real attestation binding', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshBrowserEnvironment();
    const key = newAttesterKey();
    const { host, nodeId } = harness.attachWebHost({
      nodes,
      keySeed: 'cross-web-host',
      environment,
      attesterKey: key,
    });
    const runtime = harness.createRuntime({
      nodes,
      policy: { attestation: attestationPolicyFor([host]) },
    });
    const authored = await harness.authorWorkflow({ document: buildBrowserClickDocument(), slug: 'browser-click' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'cross-web',
    });

    const report = await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [host],
      decider: createBrowserClickDecider(),
      workflowInputs: { formUrl: FORM_URL },
    });

    expect(report.state).toBe('completed');
    expect(report.steps.length).toBe(1);
    expect(report.steps[0]!.stepId).toBe('submit_form');
    expect(report.steps[0]!.nodeId).toBe(nodeId);
    expect(report.steps[0]!.actions).toBe(3);
    expect(report.steps[0]!.observations).toBe(3);
    expect(report.steps[0]!.attestationsAttached).toBe(1);
    // the click REALLY happened on the host environment:
    const button = environment.snapshot().find((element) => element.elementId === 'btn-submit');
    expect(button?.state).toBe('clicked');

    const history: WorkflowRunHistory = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(history.invocations.map((invocation) => invocation.capability)).toEqual([
      'browser.observe',
      'browser.click',
      'browser.observe',
    ]);
    for (const invocation of history.invocations) {
      expect(invocation.outcome).toBe('succeeded');
    }
    expect(history.evidence.map((evidence) => evidence.evidenceClass)).toEqual(SINGLE_STEP_EVIDENCE_CLASSES);
    expect(history.attestations.length).toBe(1);
    expect(history.attestations[0]!.assurance).toBe('software_signed');
    expect(history.attestations[0]!.attesterKeyId).toBe(key.keyId);
    expect(history.attestations[0]!.stepId).toBe('submit_form');
  });

  it('desktop parity + identical IR semantic digests: the same protocol shape, the same pinned digest across two authorings', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshDesktopEnvironment();
    const key = newAttesterKey();
    const { host } = harness.attachDesktopHost({
      nodes,
      keySeed: 'cross-desktop-host',
      environment,
      attesterKey: key,
    });
    const runtime = harness.createRuntime({
      nodes,
      policy: { attestation: attestationPolicyFor([host]) },
    });
    // the SAME WorkflowIR content authored TWICE (different slugs):
    const authoredA = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'parity-a' });
    const authoredB = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'parity-b' });
    // the V2-003 semantic digest is content-derived (slug/org-independent):
    expect(authoredB.semanticDigest).toBe(authoredA.semanticDigest);
    expect(authoredB.semanticDigest).toMatch(/^[0-9a-f]{64}$/);

    const runA = await harness.requestRun({
      workflowId: authoredA.workflowId,
      versionId: authoredA.versionId,
      triggerId: 'cross-desktop-a',
    });
    const reportA = await runtime.executeRun(harness.principal, {
      runId: runA.id,
      hosts: [host],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });
    const runB = await harness.requestRun({
      workflowId: authoredB.workflowId,
      versionId: authoredB.versionId,
      triggerId: 'cross-desktop-b',
    });
    const reportB = await runtime.executeRun(harness.principal, {
      runId: runB.id,
      hosts: [host],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: 'reports/summary-b.md' },
    });
    // both runs pin the SAME semantic digest (the runtime's pin discipline):
    expect(reportA.state).toBe('completed');
    expect(reportB.state).toBe('completed');
    const historyA = await harness.runService.getRunHistory(harness.principal, runA.id);
    const historyB = await harness.runService.getRunHistory(harness.principal, runB.id);
    expect(historyA.run.versionSemanticDigest).toBe(authoredA.semanticDigest);
    expect(historyB.run.versionSemanticDigest).toBe(authoredB.semanticDigest);
    expect(historyA.run.versionSemanticDigest).toBe(historyB.run.versionSemanticDigest);

    // DESKTOP PARITY with the web drive: the IDENTICAL protocol shape —
    // platform differences appear ONLY in capabilities, never in semantics:
    expect(reportB.steps[0]!.actions).toBe(3);
    expect(reportB.steps[0]!.observations).toBe(3);
    expect(reportB.steps[0]!.attestationsAttached).toBe(1);
    expect(historyB.invocations.map((invocation) => invocation.capability)).toEqual([
      'filesystem.read',
      'filesystem.write',
      'filesystem.read',
    ]);
    expect(historyB.evidence.map((evidence) => evidence.evidenceClass)).toEqual(SINGLE_STEP_EVIDENCE_CLASSES);
    expect(historyB.attestations[0]!.assurance).toBe('software_signed');
    expect(environment.readFile(REPORT_PATH)).toBe(TRIAGE_REPORT_CONTENT);
    expect(environment.readFile('reports/summary-b.md')).toBe(TRIAGE_REPORT_CONTENT);
  });

  it('desktop target-changed race recovery: grounded act fails HOST_TARGET_CHANGED (no clobber) → re-observe → fresh grounding completes', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshDesktopEnvironment();
    const { host } = harness.attachDesktopHost({ nodes, keySeed: 'cross-race-desktop', environment });
    const runtime = harness.createRuntime({ nodes });
    const authored = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'agentic-write-race' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'cross-race',
    });

    // the decider races the environment BETWEEN observe and act (the same
    // deterministic pattern as the unit battery), then recovers honestly:
    const decider: AgentDecider = (ctx) => {
      if (ctx.observation === null) {
        return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_PATH };
      }
      const writeSucceeded = ctx.history.some((record) => record.capability === 'filesystem.write' && record.ok);
      if (writeSucceeded) {
        return {
          decision: 'complete',
          verify: {
            capability: 'filesystem.read',
            subject: REPORT_PATH,
            expect: { elementId: REPORT_PATH, state: RACE_CONTENT },
          },
          outputs: { written: true },
        };
      }
      const sawTargetChanged = ctx.history.some((record) => record.failureCode === 'HOST_TARGET_CHANGED');
      if (!sawTargetChanged) {
        // the environment races the target between observe and act:
        environment.externalWrite(REPORT_PATH, 'EXTERNAL-RACE');
        const target = ctx.observation.elements.find((element) => element.elementId === REPORT_PATH);
        return {
          decision: 'act',
          capability: 'filesystem.write',
          grounding: target
            ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest }
            : null,
          parameters: { path: REPORT_PATH, content: RACE_CONTENT },
        };
      }
      if (!ctx.observation.elements.some((element) => element.elementId === REPORT_PATH && element.state === 'EXTERNAL-RACE')) {
        return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_PATH };
      }
      // re-grounded on the FRESH reality (the raced content):
      const fresh = ctx.observation.elements.find((element) => element.elementId === REPORT_PATH);
      return {
        decision: 'act',
        capability: 'filesystem.write',
        grounding: fresh
          ? { observationId: ctx.observation.observationId, targetElementId: fresh.elementId, targetDigest: fresh.digest }
          : null,
        parameters: { path: REPORT_PATH, content: RACE_CONTENT },
      };
    };

    const report = await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [host],
      decider,
      workflowInputs: { reportPath: REPORT_PATH },
    });

    expect(report.state).toBe('completed');
    expect(report.steps[0]!.outcome).toBe('completed');
    expect(report.steps[0]!.failure).toBeNull();
    expect(report.steps[0]!.actions).toBe(5); // observe, raced act, re-observe, act, verify

    // the effect: written ONLY after fresh re-grounding:
    expect(environment.readFile(REPORT_PATH)).toBe(RACE_CONTENT);

    // the durable invocations show the honest failed-then-succeeded sequence:
    const history = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(history.invocations.map((invocation) => `${invocation.capability}:${invocation.outcome}`)).toEqual([
      'filesystem.read:succeeded',
      'filesystem.write:failed', // HOST_TARGET_CHANGED — the raced write never executed
      'filesystem.read:succeeded',
      'filesystem.write:succeeded',
      'filesystem.read:succeeded',
    ]);
  });

  it('mobile: answering a ringing call through the SAME protocol; NO attester key → the honest attestation-absence record', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshMobileEnvironment();
    // NO attester key on the mobile host — the honest absence path:
    const { host, nodeId } = harness.attachMobileHost({ nodes, keySeed: 'cross-mobile-host', environment });
    const runtime = harness.createRuntime({ nodes });
    const authored = await harness.authorWorkflow({ document: buildMobileAnswerDocument(), slug: 'mobile-answer' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'cross-mobile',
    });

    const report = await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [host],
      decider: createAnswerCallDecider(),
      workflowInputs: {},
    });

    expect(report.state).toBe('completed');
    expect(report.steps[0]!.stepId).toBe('answer_call');
    expect(report.steps[0]!.nodeId).toBe(nodeId);
    // the call REALLY became active on the host environment:
    expect(environment.calls().find((call) => call.callId === 'call-oncall-001')?.state).toBe('active');

    const history = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(history.invocations.map((invocation) => invocation.capability)).toEqual([
      'phone.call.observe',
      'phone.call.answer',
      'phone.call.observe',
    ]);
    for (const invocation of history.invocations) {
      expect(invocation.outcome).toBe('succeeded');
    }
    // HONEST absence: no fabricated or up-claimed attestation, and the
    // runtime's own absence record is durable:
    expect(history.attestations.length).toBe(0);
    expect(report.steps[0]!.attestationsAttached).toBe(0);
    expect(report.steps[0]!.failure).toBeNull();
    const absence = history.evidence.find((evidence) => evidence.description?.includes('no attester key'));
    expect(absence).toBeDefined();
    expect(absence?.producerKind).toBe('computer_agent');
    expect(absence?.producerId).toBe('workflowos/computer-agent-runtime');
  });

  it('locality: a device_local step never routes to a cloud node (same capabilities); no device host → AGENT_NO_ELIGIBLE_HOST', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshDesktopEnvironment();
    const key = newAttesterKey();
    const { host: desktopHost, nodeId: desktopNodeId } = harness.attachDesktopHost({
      nodes,
      keySeed: 'locality-desktop',
      environment,
      attesterKey: key,
    });
    // a CLOUD node advertising the VERY SAME capabilities (the locality
    // dimension is the ONLY routing discriminator — constitution §12):
    const cloud = harness.registerCloudNode({
      nodes,
      keySeed: 'locality-cloud',
      capabilities: [
        { name: 'filesystem.read', version: 1, availability: 'available' },
        { name: 'filesystem.write', version: 1, availability: 'available' },
      ],
    });

    // the merged V2-004 matcher excludes the cloud node for device_local:
    const match = nodes.matchNodes(
      requirementSetOf({
        id: 'req:locality',
        capabilities: ['filesystem.read', 'filesystem.write'],
        placement: 'device_local',
      }),
    );
    const eligibleIds = match.eligibleNodes.map((node) => node.nodeId);
    expect(eligibleIds).toContain(desktopNodeId);
    expect(eligibleIds).not.toContain(cloud.nodeId);

    // the drive routes to the DESKTOP host and completes:
    const runtime = harness.createRuntime({
      nodes,
      policy: { attestation: attestationPolicyFor([desktopHost]) },
    });
    const authored = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'agentic-write-locality' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'locality-positive',
    });
    const report = await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [desktopHost],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });
    expect(report.state).toBe('completed');
    expect(report.steps[0]!.nodeId).toBe(desktopNodeId);
    expect(report.steps[0]!.nodeId).not.toBe(cloud.nodeId);
    expect(environment.readFile(REPORT_PATH)).toBe(TRIAGE_REPORT_CONTENT);

    // ---- the fail-closed direction: device_local with ONLY the cloud node:
    const cloudOnlyNodes = harness.freshNodeDirectory();
    harness.registerCloudNode({
      nodes: cloudOnlyNodes,
      keySeed: 'locality-cloud-solo',
      capabilities: [
        { name: 'filesystem.read', version: 1, availability: 'available' },
        { name: 'filesystem.write', version: 1, availability: 'available' },
      ],
    });
    const cloudOnlyRuntime = harness.createRuntime({ nodes: cloudOnlyNodes });
    const runNoDevice = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'locality-no-device',
    });
    const failed = await cloudOnlyRuntime.executeRun(harness.principal, {
      runId: runNoDevice.id,
      hosts: [],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });
    expect(failed.state).toBe('failed');
    expect(failed.failure?.code).toBe('AGENT_NO_ELIGIBLE_HOST');
    expect(failed.failure?.recoverable).toBe(false);
    expect(failed.steps[0]!.nodeId).toBeNull();
    const failedHistory = await harness.runService.getRunHistory(harness.principal, runNoDevice.id);
    expect(failedHistory.run.state).toBe('failed');
  });

  it('cloud-only step with only device hosts → AGENT_NO_ELIGIBLE_HOST (locality is a correctness constraint)', async () => {
    const nodes = harness.freshNodeDirectory();
    // a DEVICE host advertising the step's capability (messaging.send): the
    // capability dimension matches; ONLY the locality dimension excludes it:
    const { host: deviceHost } = harness.attachDesktopHost({
      nodes,
      keySeed: 'cloud-only-desktop',
      environment: freshDesktopEnvironment(),
      capabilities: [{ name: 'messaging.send', version: 1, availability: 'available' }],
    });
    const runtime = harness.createRuntime({ nodes });
    const authored = await harness.authorWorkflow({ document: buildCloudOnlyDocument(), slug: 'cloud-only' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'cloud-only',
    });

    const report = await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [deviceHost],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });

    expect(report.state).toBe('failed');
    expect(report.failure?.code).toBe('AGENT_NO_ELIGIBLE_HOST');
    expect(report.failure?.detail).toContain('cloud_required');
    expect(report.steps[0]!.nodeId).toBeNull();
    // the run is failed in the durable state (honest, never invented):
    const history = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(history.run.state).toBe('failed');
    expect(history.steps[0]!.status).toBe('failed');
  });

  it('multi-host: a two-step workflow routes each step to a DIFFERENT host (capability steering through the merged matcher)', async () => {
    const nodes = harness.freshNodeDirectory();
    const browserEnvironment = freshBrowserEnvironment();
    const desktopEnvironment = freshDesktopEnvironment();
    const webKey = newAttesterKey();
    const { host: webHost, nodeId: webNodeId } = harness.attachWebHost({
      nodes,
      keySeed: 'multi-web-host',
      environment: browserEnvironment,
      attesterKey: webKey,
    });
    const desktopKey = newAttesterKey();
    const { host: desktopHost, nodeId: desktopNodeId } = harness.attachDesktopHost({
      nodes,
      keySeed: 'multi-desktop-host',
      environment: desktopEnvironment,
      attesterKey: desktopKey,
    });
    const runtime = harness.createRuntime({
      nodes,
      policy: { attestation: attestationPolicyFor([webHost, desktopHost]) },
    });
    const authored = await harness.authorWorkflow({ document: buildMultiHostDocument(), slug: 'multi-host' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'multi-host',
    });

    // ONE decider drives BOTH steps (branched on the decision context's stepId):
    const decider: AgentDecider = (ctx) => {
      if (ctx.stepId === 'collect') {
        const formUrl = ctx.inputs.formUrl as string;
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
      }
      const reportPath = ctx.inputs.reportPath as string;
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
          parameters: { path: reportPath, content: TRIAGE_REPORT_CONTENT },
        };
      }
      return {
        decision: 'complete',
        verify: { capability: 'filesystem.read', subject: reportPath, expect: { elementId: reportPath, state: TRIAGE_REPORT_CONTENT } },
        outputs: { written: true },
      };
    };

    const report = await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [webHost, desktopHost],
      decider,
      workflowInputs: { formUrl: FORM_URL, reportPath: REPORT_PATH },
    });

    expect(report.state).toBe('completed');
    expect(report.steps.length).toBe(2);
    // each step ran on ITS OWN host (different node ids — capability steering):
    expect(report.steps[0]!.stepId).toBe('collect');
    expect(report.steps[0]!.nodeId).toBe(webNodeId);
    expect(report.steps[1]!.stepId).toBe('file_step');
    expect(report.steps[1]!.nodeId).toBe(desktopNodeId);
    expect(webNodeId).not.toBe(desktopNodeId);
    for (const step of report.steps) {
      expect(step.outcome).toBe('completed');
      expect(step.failure).toBeNull();
      expect(step.attestationsAttached).toBe(1);
    }
    // BOTH hosts produced their real effects:
    expect(browserEnvironment.snapshot().find((element) => element.elementId === 'btn-submit')?.state).toBe('clicked');
    expect(desktopEnvironment.readFile(REPORT_PATH)).toBe(TRIAGE_REPORT_CONTENT);

    // the durable history: six invocations across both steps, two bindings:
    const history = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(history.invocations.map((invocation) => invocation.capability)).toEqual([
      'browser.observe',
      'browser.click',
      'browser.observe',
      'filesystem.read',
      'filesystem.write',
      'filesystem.read',
    ]);
    expect(history.attestations.length).toBe(2);
    expect(history.attestations.map((binding) => binding.stepId).sort()).toEqual(['collect', 'file_step']);
    expect(new Set(history.attestations.map((binding) => binding.attesterKeyId))).toEqual(
      new Set([webKey.keyId, desktopKey.keyId]),
    );
  });
});
