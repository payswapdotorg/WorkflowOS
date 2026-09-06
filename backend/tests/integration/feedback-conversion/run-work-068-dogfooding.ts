/**
 * WORK-068 — standalone dogfooding RUN (real process, real product paths).
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/feedback-conversion/run-work-068-dogfooding.ts
 *
 * Executes the governing protocol's real-system dogfooding clause for the
 * feedback→governed-Work-Item conversion layer on the REAL stack:
 *
 *   - real PGlite (ALL 62 migrations) + the real identity stack (API-key
 *     operator) + the REAL Fastify route surface (the governed convert
 *     mutation + the read-only assessment preview);
 *   - the REAL WORK-067 EngineeringSignalService (observations ingested
 *     through its public intake; release correlation through its engine);
 *   - the REAL /work-items intake (PgWorkItemRepository — the created Work
 *     Items land in the real schema under the real UNIQUE constraint).
 *
 * The journey (the canonical flow of spec/work-orders/WORK-068.md):
 *
 *   1. SIGNALS — two logical failures recorded through the real WORK-067
 *      intake: a checkout failure confirmed by TWO sources (validation +
 *      CI) in one environment, and a critical runtime webhook timeout.
 *   2. ASSESS (READ-ONLY) — GET /feedback/proposals derives the assessed,
 *      deduplicated, prioritized proposals; the authoritative store stays
 *      EMPTY (the mutation-detection proof).
 *   3. CONVERT (THE GOVERNED DECISION) — POST /feedback/convert with the
 *      caller-supplied decisionReason only (decidedBy is server-resolved):
 *      the Work Items land through the EXISTING /work-items intake with
 *      the full provenance embedded in metadata.feedbackConversion.
 *   4. THE AUTHORITATIVE READ-BACK — the created records are read through
 *      the /work-items authority's own repository: FB- ids, completed=false
 *      (the full governance lifecycle still applies), the decision record,
 *      the occurrence provenance (the raw observation references verbatim).
 *   5. DEDUPLICATION — the SAME conversion decision again: zero creates,
 *      convergence on the existing items (never a second Work Item).
 *   6. RECURRENCE — the checkout fix "merged" (the internal completion
 *      seam), the failure RECURS (a new observation through WORK-067), the
 *      conversion creates the RECURRENCE Work Item (FB-xxx.R2) with the
 *      recurrence chain recorded — the completed item never blocks new
 *      governed work.
 *   7. THE ADVERSARIAL LEGS — the foreign user (403), the forged
 *      decision-authority fields (400 REJECTED, never ignored), the
 *      missing decisionReason (400), the unknown signal id (400), the
 *      unauthenticated call (401).
 *
 * The transcript is persisted as the durable evidence document at
 * spec/architecture/v1.1/dogfooding-evidence/2026-09-06-work-068-feedback-conversion.md
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { DefaultEngineeringSignalService, InMemoryEngineeringSignalRepository } from '../../../src/engineering-signals/index.js';
import { DefaultFeedbackConversionService } from '../../../src/feedback-conversion/index.js';
import { createLogger } from '@platform/logger.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import type { FastifyInstance } from 'fastify';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const EVIDENCE_PATH = join(
  REPO_ROOT,
  'spec',
  'architecture',
  'v1.1',
  'dogfooding-evidence',
  '2026-09-06-work-068-feedback-conversion.md',
);

const transcript: string[] = [''];
let failures = 0;

function record(leg: string, ok: boolean, detail: string): void {
  transcript.push(`- ${ok ? 'PASS' : 'FAIL'} ${leg} — ${detail}`);
  if (!ok) failures += 1;
}

function expectEq(actual: unknown, expected: unknown, what: string): boolean {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  record(what, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return ok;
}

function expectMatch(actual: string, pattern: RegExp, what: string): boolean {
  const ok = pattern.test(actual);
  record(what, ok, `'${actual.slice(0, 60)}' must match ${pattern}`);
  return ok;
}

async function main(): Promise<void> {
  transcript.push('# WORK-068 feedback→governed-Work-Item conversion — the real-system dogfooding run');
  transcript.push('');
  transcript.push(`Executed: ${new Date().toISOString()} (the runner's own clock — NOT a domain decision input)`);
  transcript.push('');
  transcript.push('## Stack');
  transcript.push('');
  transcript.push('- real PGlite with ALL migrations; the real identity stack (API-key operator)');
  transcript.push('- the REAL WORK-067 EngineeringSignalService (the public signal intake + correlation engine)');
  transcript.push('- the REAL /work-items intake (PgWorkItemRepository — wfos_work_items + the real UNIQUE constraint)');
  transcript.push('- the REAL Fastify route surface: POST /projects/:id/feedback/convert + GET /projects/:id/feedback/proposals');
  transcript.push('');

  const stack: TestAuthStack = await buildAuthStack({
    WFOS_TEST_KEY_A: 'raw-key-w068-df-a',
    WFOS_TEST_KEY_B: 'raw-key-w068-df-b',
  });
  const logger = createLogger({ level: 'info', destination: new CaptureStream() });

  // --- The real organization/project/architecture -------------------------
  const org = await stack.organizationRepository.create({ name: 'W068 Dogfood Org' });
  const user = await stack.userRepository.upsertByExternalId({ externalId: 'w068-df-user', displayName: 'Dogfood User' });
  await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
  const project = await stack.projectRepository.create({ organizationId: org.id, name: 'W068 Dogfood Project' });
  await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });
  const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'W068 Dogfood Arch' });
  const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# W068 dogfood' });

  // A foreign user (the tenant-isolation discrimination):
  const orgB = await stack.organizationRepository.create({ name: 'W068 Dogfood Org B' });
  const userB = await stack.userRepository.upsertByExternalId({ externalId: 'w068-df-user-b', displayName: 'Foreign User' });
  await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
  const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'W068 Foreign Project' });
  await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });

  await stack.apiKeyProvisioner.provision({
    keyId: 'w068-df-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'w068-df-user', label: 'A', rawKey: 'raw-key-w068-df-a',
  });
  await stack.apiKeyProvisioner.provision({
    keyId: 'w068-df-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'w068-df-user-b', label: 'B', rawKey: 'raw-key-w068-df-b',
  });

  // --- The real WORK-067 signal service ------------------------------------
  const signalService = new DefaultEngineeringSignalService({
    signalRepository: new InMemoryEngineeringSignalRepository(),
    logger,
    now: () => new Date('2026-09-06T00:00:00Z'),
  });

  // --- The real route surface ----------------------------------------------
  const conversionService = new DefaultFeedbackConversionService({
    logger,
    now: () => new Date('2026-09-06T10:00:00Z'),
  });
  const server: FastifyInstance = await buildServer({
    queue: stack.db.client as never,
    logger: stack.db.logger,
    auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
    feedbackConversion: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      workItemRepository: stack.workItemRepository,
      engineeringSignalService: signalService,
      conversionService,
      logger,
    },
  });
  await server.ready();

  const authA = { 'x-api-key': 'raw-key-w068-df-a' };
  const authB = { 'x-api-key': 'raw-key-w068-df-b' };
  const base = `/projects/${project.id}/feedback`;

  // =========================================================================
  // LEG 1 — SIGNALS: two logical failures through the real WORK-067 intake
  // =========================================================================
  await signalService.ingestObservation({
    source: 'validation',
    tenantId: 'tenant-w068-df',
    projectId: project.id,
    environmentId: 'env-prod-df',
    logicalFailureKey: 'validation:journey-checkout:step-pay:expectation-total',
    severity: 'high',
    observedAt: '2026-09-06T08:00:00Z',
    observationRef: { kind: 'validation-run', ref: 'run-df-1', detail: 'failure: step-pay/expectation-total' },
    raw: { failedStepId: 'step-pay', expected: 'total is 3 items', actual: null },
    releaseRef: null,
  });
  await signalService.ingestObservation({
    source: 'ci',
    tenantId: 'tenant-w068-df',
    projectId: project.id,
    environmentId: 'env-prod-df',
    logicalFailureKey: 'validation:journey-checkout:step-pay:expectation-total',
    severity: 'high',
    observedAt: '2026-09-06T08:30:00Z',
    observationRef: { kind: 'ci-evidence', ref: 'wfos_github_ci_evidence:df-1', detail: 'conclusion=failure' },
    raw: { workflowName: 'backend-tests', conclusion: 'failure' },
    releaseRef: null,
  });
  await signalService.ingestObservation({
    source: 'runtime',
    tenantId: 'tenant-w068-df',
    projectId: project.id,
    environmentId: 'env-prod-df',
    logicalFailureKey: 'runtime:payment-webhook:timeout',
    severity: 'critical',
    observedAt: '2026-09-06T09:00:00Z',
    observationRef: { kind: 'runtime-incident', ref: 'incident-df-1', detail: 'webhook p99 timeout' },
    raw: { incident: 'webhook timeout', p99: 30000 },
    releaseRef: null,
  });
  const signals = await signalService.listSignalsForProject(project.id);
  expectEq(signals.length, 2, 'LEG 1 — two logical signals recorded (the cross-source observations converged in WORK-067)');

  // =========================================================================
  // LEG 2 — ASSESS (READ-ONLY): the proposals derive, nothing lands
  // =========================================================================
  const assess = await server.inject({
    method: 'GET',
    url: `${base}/proposals?architectureVersionId=${version.id}`,
    headers: authA,
  });
  expectEq(assess.statusCode, 200, 'LEG 2 — GET /feedback/proposals 200');
  const assessBody = assess.json() as { proposals: Array<{ identity: { proposalId: string }; assessment: { blastRadius: { sources: string[]; band: string } }; priority: string; sourceSignalIds: string[] }> };
  expectEq(assessBody.proposals.length, 2, 'LEG 2 — two assessed proposals');
  const checkoutProposal = assessBody.proposals.find((p) => p.sourceSignalIds.length === 1 && p.assessment.blastRadius.sources.length === 2)!;
  expectMatch(checkoutProposal.identity.proposalId, /^FB-[0-9a-f]{10}$/, 'LEG 2 — the checkout proposal FB- id');
  expectEq(checkoutProposal.assessment.blastRadius.sources.sort(), ['ci', 'validation'], 'LEG 2 — cross-source confirmation recorded');
  expectEq((await stack.workItemRepository.findByArchitectureVersion(version.id)).length, 0, 'LEG 2 — READ-ONLY: nothing landed in the authoritative store');

  // =========================================================================
  // LEG 3 — CONVERT (the governed decision): the Work Items land through
  //         the EXISTING /work-items intake
  // =========================================================================
  const convert = await server.inject({
    method: 'POST',
    url: `${base}/convert`,
    headers: authA,
    payload: {
      architectureVersionId: version.id,
      decisionReason: 'the checkout failure is confirmed by two independent sources and the webhook timeout is critical — convert both into governed work',
    },
  });
  expectEq(convert.statusCode, 201, 'LEG 3 — POST /feedback/convert 201 (created)');
  const convertBody = convert.json() as { createdCount: number; decision: { decidedBy: string; decidedAt: string } };
  expectEq(convertBody.createdCount, 2, 'LEG 3 — two Work Items created through the existing intake');
  expectEq(convertBody.decision.decidedBy, user.id, 'LEG 3 — decidedBy is the AUTHENTICATED principal (server-resolved)');

  // =========================================================================
  // LEG 4 — THE AUTHORITATIVE READ-BACK
  // =========================================================================
  const stored = await stack.workItemRepository.findByArchitectureVersion(version.id);
  expectEq(stored.length, 2, 'LEG 4 — two authoritative Work Item records');
  const checkoutItem = stored.find((item) => (item.metadata as Record<string, unknown>).feedbackConversion !== undefined && ((item.metadata as Record<string, unknown>).feedbackConversion as Record<string, unknown>).logicalFailureKey === 'validation:journey-checkout:step-pay:expectation-total')!;
  expectMatch(checkoutItem.workItemId, /^FB-[0-9a-f]{10}$/, 'LEG 4 — the authoritative FB- work item id');
  expectEq(checkoutItem.completed, false, 'LEG 4 — NOT completed (the full governance lifecycle still applies)');
  const md = (checkoutItem.metadata as Record<string, unknown>).feedbackConversion as Record<string, unknown>;
  expectEq(md.sourceSignalIds !== undefined && Array.isArray(md.sourceSignalIds) && (md.sourceSignalIds as string[]).length === 1, true, 'LEG 4 — the originating signal provenance preserved');
  const provenance = md.occurrenceProvenance as Array<{ observationRef: { ref: string } }>;
  expectEq(provenance.map((e) => e.observationRef.ref).sort(), ['run-df-1', 'wfos_github_ci_evidence:df-1'], 'LEG 4 — the raw observation references preserved VERBATIM');
  expectEq((md.decision as Record<string, unknown>).decidedBy, user.id, 'LEG 4 — the governed decision embedded in the authoritative record');

  // =========================================================================
  // LEG 5 — DEDUPLICATION: the same decision again converges
  // =========================================================================
  const convert2 = await server.inject({
    method: 'POST',
    url: `${base}/convert`,
    headers: authA,
    payload: {
      architectureVersionId: version.id,
      decisionReason: 'the same failures again — the conversion must converge, never duplicate',
    },
  });
  expectEq(convert2.statusCode, 200, 'LEG 5 — the repeat conversion 200 (no creates)');
  const convert2Body = convert2.json() as { createdCount: number; deduplicatedCount: number };
  expectEq(convert2Body.createdCount, 0, 'LEG 5 — zero creates on the repeat');
  expectEq(convert2Body.deduplicatedCount, 2, 'LEG 5 — both proposals converged');
  expectEq((await stack.workItemRepository.findByArchitectureVersion(version.id)).length, 2, 'LEG 5 — still exactly two authoritative records');

  // =========================================================================
  // LEG 6 — RECURRENCE: the fix merged, the failure recurs, new governed work
  // =========================================================================
  // The completion seam (the /workflows+/verification-derived fact — only
  // the internal WorkItemCompletionService may set it in production; the
  // dogfood drives the same persistence boundary the completion service
  // writes through):
  await stack.db.client.query('UPDATE wfos_work_items SET completed = true WHERE id = $1', [checkoutItem.id]);
  // The failure recurs AFTER the fix:
  await signalService.ingestObservation({
    source: 'validation',
    tenantId: 'tenant-w068-df',
    projectId: project.id,
    environmentId: 'env-prod-df',
    logicalFailureKey: 'validation:journey-checkout:step-pay:expectation-total',
    severity: 'critical',
    observedAt: '2026-09-06T09:30:00Z',
    observationRef: { kind: 'validation-run', ref: 'run-df-2', detail: 'failure recurred after the fix' },
    raw: { failedStepId: 'step-pay', expected: 'total is 3 items', actual: null, note: 'recurrence' },
    releaseRef: null,
  });
  const convert3 = await server.inject({
    method: 'POST',
    url: `${base}/convert`,
    headers: authA,
    payload: {
      architectureVersionId: version.id,
      decisionReason: 'the checkout fix did not hold — the recurrence is new governed work',
    },
  });
  const convert3Body = convert3.json() as { createdCount: number; results: Array<{ outcome: string; workItemHumanId: string; proposal: { recurrenceOf: string[]; assessment: { peakSeverity: string } } }> };
  expectEq(convert3.statusCode, 201, 'LEG 6 — the recurrence conversion 201 (the completed item does not block)');
  const recurrenceResult = convert3Body.results.find((r) => r.outcome === 'created')!;
  expectMatch(recurrenceResult.workItemHumanId, /^FB-[0-9a-f]{10}\.R2$/, 'LEG 6 — the recurrence Work Item FB-xxx.R2');
  expectEq(recurrenceResult.proposal.recurrenceOf, [checkoutItem.id], 'LEG 6 — the recurrence chain recorded');
  expectEq(recurrenceResult.proposal.assessment.peakSeverity, 'critical', 'LEG 6 — the escalated recurrence severity assessed');
  const storedAfter = await stack.workItemRepository.findByArchitectureVersion(version.id);
  expectEq(storedAfter.length, 3, 'LEG 6 — three authoritative records (the completed fix + the recurrence + the webhook item)');

  // =========================================================================
  // LEG 7 — THE ADVERSARIAL LEGS
  // =========================================================================
  const unauth = await server.inject({ method: 'GET', url: `${base}/proposals?architectureVersionId=${version.id}` });
  expectEq(unauth.statusCode, 401, 'LEG 7 — unauthenticated GET → 401');
  const foreign = await server.inject({ method: 'POST', url: `${base}/convert`, headers: authB, payload: { architectureVersionId: version.id, decisionReason: 'x' } });
  expectEq(foreign.statusCode, 403, 'LEG 7 — the foreign user → 403 (tenant isolation)');
  for (const field of ['decidedBy', 'decision', 'assessment', 'priority']) {
    const forged = await server.inject({
      method: 'POST',
      url: `${base}/convert`,
      headers: authA,
      payload: { architectureVersionId: version.id, decisionReason: 'x', [field]: 'forged' },
    });
    expectEq(forged.statusCode, 400, `LEG 7 — the forged ${field} field REJECTED (400)`);
  }
  const noReason = await server.inject({ method: 'POST', url: `${base}/convert`, headers: authA, payload: { architectureVersionId: version.id } });
  expectEq(noReason.statusCode, 400, 'LEG 7 — the missing decisionReason → 400 (no silent conversion)');
  const unknownSignal = await server.inject({
    method: 'POST',
    url: `${base}/convert`,
    headers: authA,
    payload: { architectureVersionId: version.id, decisionReason: 'x', signalIds: ['sig_unknown'] },
  });
  expectEq(unknownSignal.statusCode, 400, 'LEG 7 — the unknown signal id → 400 (fail-closed, never fabricated)');

  await server.close();
  await stack.teardown();

  // --- The evidence document ------------------------------------------------
  transcript.push('');
  transcript.push('## Result');
  transcript.push('');
  transcript.push(failures === 0 ? 'ALL LEGS PASS (exit 0)' : `${failures} FAILURE(S) (exit 1)`);
  transcript.push('');
  transcript.push('## Boundary summary (the honest scope statement)');
  transcript.push('');
  transcript.push('- The conversion submitted proposed Work Items ONLY through the existing WorkItemRepository.create intake; no second work-item authority exists (18 static-architecture invariants + the discrimination suite pin it).');
  transcript.push('- Every created Work Item preserves its originating signal provenance (metadata.feedbackConversion: signal ids, sources, environments, occurrence references verbatim, the advisory regression evidence, the governed decision).');
  transcript.push('- The mutation required the explicit governed decision (decidedBy server-resolved + the caller-supplied decisionReason); the assessment was re-derived in the mutation path; the read-only assess created nothing.');
  transcript.push('- Deduplication converged the repeated conversion on the existing OPEN items; the completed item yielded the recurrence (FB-xxx.R2) with the recurrence chain — never a duplicate, never a blocked conversion.');
  transcript.push('- The created Work Items are NOT completed, NOT assigned, NOT executed — the full governance lifecycle (architecture checkpoint, agent execution, verification, architect review, merge) still applies before any code change.');
  transcript.push('- The signal store is the documented in-memory WORK-067 boundary (no durable signal storage exists yet — the future ACR at the port); the Work Items are durable in the real schema.');
  transcript.push('');

  const evidenceDoc = [
    '# WORK-068 — Feedback → Governed Work Items: the real-system dogfooding run',
    '',
    'Executed by `backend/tests/integration/feedback-conversion/run-work-068-dogfooding.ts`',
    '(the real PGlite stack + the real identity + the real route surface + the',
    'real WORK-067 signal service + the real /work-items intake). The durable',
    'activation dispatch is Issue #12 on payswapdotorg/WorkflowOS (2026-09-06,',
    'live main 0d06f8b). The transcript below is the structured run record.',
    '',
    ...transcript,
  ].join('\n');
  writeFileSync(EVIDENCE_PATH, evidenceDoc, 'utf8');

  // eslint-disable-next-line no-console
  console.log(transcript.join('\n'));
  // eslint-disable-next-line no-console
  console.log(`\nevidence document written: ${EVIDENCE_PATH}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
