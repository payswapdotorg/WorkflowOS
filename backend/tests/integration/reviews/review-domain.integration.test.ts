import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type { Review, ArchitectReviewResult } from '@modules/reviews/index.js';

/**
 * WORK-016 — Architect Reviews and Review Findings (REVIEW-001, REVIEW-002).
 *
 * Tests:
 * - Review persistence (creation, traceability, architect execution ref, stable identity)
 * - Findings (persistence, review relationship, criterion/evidence references, severity)
 * - Outcomes (every canonical verdict, invalid verdicts rejected)
 * - Finalization (persistence, historical immutability, repeat-finalization rejected)
 * - Workflow boundary (finalization does NOT mutate workflow state)
 * - Verification boundary (review can reference evidence/criteria, does not evaluate)
 * - Architect traceability (exact execution ref, exact ArchitectureVersion, mismatch rejected)
 * - Correction cycle (Review #1 → CHANGES_REQUESTED → Review #2 → APPROVE)
 * - Tenant isolation (cross-tenant read/create/finding/criterion-reference denied)
 */
describe('WORK-016 — Architect Reviews and Review Findings', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let reviewService: DefaultReviewService;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let versionA: { id: string };
  let versionB: { id: string };
  let reqA: { id: string };
  let criterionA1: { id: string };
  let reqB: { id: string };
  let criterionB1: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-review-a',
      WFOS_TEST_KEY_B: 'raw-key-review-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'Review Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Review Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'review-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'review-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Review Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Review Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'review-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'review-user-a', label: 'User A', rawKey: 'raw-key-review-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'review-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'review-user-b', label: 'User B', rawKey: 'raw-key-review-b',
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Review Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'Review constraints A' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'Review Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'Review constraints B' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id, requirementId: 'REQ-REVIEW-A-001', title: 'Auth requirement',
    });
    criterionA1 = await stack.acceptanceCriterionRepository.create({
      requirementId: reqA.id, criterionId: 'AC-REVIEW-1', description: 'Valid auth resolves identity',
    });

    reqB = await stack.requirementRepository.create({
      architectureVersionId: versionB.id, requirementId: 'REQ-REVIEW-B-001', title: 'B requirement',
    });
    criterionB1 = await stack.acceptanceCriterionRepository.create({
      requirementId: reqB.id, criterionId: 'AC-REVIEW-B-1', description: 'B criterion',
    });

    reviewService = new DefaultReviewService(
      stack.db.client,
      stack.workItemRepository,
      stack.db.logger,
    );

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      architecture: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureDecisionRepository: stack.architectureDecisionRepository,
        architectureChangeRequestRepository: stack.architectureChangeRequestRepository,
        architectureService: stack.architectureService,
      },
      workItems: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workItemRequirementRepository: stack.workItemRequirementRepository,
        workItemCriterionRepository: stack.workItemCriterionRepository,
        workItemDependencyRepository: stack.workItemDependencyRepository,
        pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
        workOrderRepository: stack.workOrderRepository,
      },
      requirements: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        requirementRepository: stack.requirementRepository,
        requirementDependencyRepository: stack.requirementDependencyRepository,
        acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
        evidenceReferenceRepository: stack.evidenceReferenceRepository,
      },
      workflow: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workflowEngine: new DefaultWorkflowEngine(stack.db.client, stack.db.logger),
      },
      reviews: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        reviewService,
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  async function createWorkItemA(id: string) {
    return stack.workItemRepository.create({ architectureVersionId: versionA.id, workItemId: id, title: id });
  }

  async function createWorkItemB(id: string) {
    return stack.workItemRepository.create({ architectureVersionId: versionB.id, workItemId: id, title: id });
  }

  // --- Review persistence ---

  describe('Review persistence (REVIEW-AC-01)', () => {
    it('creates a Review with Work Item/ArchitectureVersion/execution traceability + stable identity', async () => {
      const wi = await createWorkItemA('REVIEW-001');
      const review = await reviewService.createReview({
        projectId: projectA.id,
        workItemId: wi.id,
        architectureVersionId: versionA.id,
        architectExecutionId: 'arch-exec-001',
        source: 'architect-llm',
        reviewer: 'fake/test-model',
        executionId: 'review-exec-001',
        summary: 'Initial architect review',
        reviewInput: { context: 'assembled context' },
      });
      expect(review.id).toBeTruthy();
      expect(review.workItemId).toBe(wi.id);
      expect(review.projectId).toBe(projectA.id);
      expect(review.architectureVersionId).toBe(versionA.id);
      expect(review.architectExecutionId).toBe('arch-exec-001');
      expect(review.source).toBe('architect-llm');
      expect(review.reviewer).toBe('fake/test-model');
      expect(review.executionId).toBe('review-exec-001');
      expect(review.status).toBe('in_progress');
      expect(review.outcome).toBeNull();
      expect(review.startedAt).toBeTruthy();
      expect(review.completedAt).toBeNull();
    });

    it('rejects a Review with mismatched ArchitectureVersion (traceability)', async () => {
      const wi = await createWorkItemA('REVIEW-002');
      await expect(
        reviewService.createReview({
          projectId: projectA.id,
          workItemId: wi.id,
          architectureVersionId: versionB.id, // mismatched
          source: 'architect-llm',
          executionId: 'review-exec-002',
        }),
      ).rejects.toThrow();
    });

    it('persists Review with Work Order reference when provided', async () => {
      const wi = await createWorkItemA('REVIEW-003');
      const wo = await stack.workOrderRepository.create({
        workItemId: wi.id, projectId: projectA.id, architectureVersionId: versionA.id,
      });
      const review = await reviewService.createReview({
        projectId: projectA.id,
        workItemId: wi.id,
        workOrderId: wo.id,
        architectureVersionId: versionA.id,
        source: 'architect-llm',
        executionId: 'review-exec-003',
      });
      expect(review.workOrderId).toBe(wo.id);
    });

    it('manual review (no architect execution ref) is supported', async () => {
      const wi = await createWorkItemA('REVIEW-004');
      const review = await reviewService.createReview({
        projectId: projectA.id,
        workItemId: wi.id,
        architectureVersionId: versionA.id,
        source: 'manual',
        reviewer: 'human-reviewer-a',
        executionId: 'review-exec-004',
      });
      expect(review.architectExecutionId).toBeNull();
      expect(review.source).toBe('manual');
      expect(review.reviewer).toBe('human-reviewer-a');
    });
  });

  // --- Findings ---

  describe('Findings (FINDING-AC-01, FINDING-AC-02)', () => {
    it('persists a finding with review relationship + criterion/evidence references', async () => {
      const wi = await createWorkItemA('REVIEW-FIND-001');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-find-001',
      });
      const finding = await reviewService.addFinding({
        projectId: projectA.id, reviewId: review.id,
        severity: 'blocker',
        title: 'Auth bypass vulnerability',
        description: 'The auth implementation allows bypass via crafted headers',
        affectedScope: 'backend/src/auth/',
        requirementId: reqA.id,
        criterionId: criterionA1.id,
        evidenceRef: 'evidence-uuid-123',
        requiredCorrection: 'Add header validation + rate limiting',
        verificationRequirement: 'Integration test proving bypass is blocked',
      });
      expect(finding.id).toBeTruthy();
      expect(finding.reviewId).toBe(review.id);
      expect(finding.severity).toBe('blocker');
      expect(finding.title).toBe('Auth bypass vulnerability');
      expect(finding.requirementId).toBe(reqA.id);
      expect(finding.criterionId).toBe(criterionA1.id);
      expect(finding.evidenceRef).toBe('evidence-uuid-123');
      expect(finding.requiredCorrection).toBe('Add header validation + rate limiting');
      expect(finding.disposition).toBe('open');
    });

    it('a review can contain multiple findings (FINDING-AC-01)', async () => {
      const wi = await createWorkItemA('REVIEW-FIND-002');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-find-002',
      });
      await reviewService.addFinding({
        projectId: projectA.id, reviewId: review.id, severity: 'major',
        title: 'Finding 1', description: 'First issue',
      });
      await reviewService.addFinding({
        projectId: projectA.id, reviewId: review.id, severity: 'minor',
        title: 'Finding 2', description: 'Second issue',
      });
      await reviewService.addFinding({
        projectId: projectA.id, reviewId: review.id, severity: 'info',
        title: 'Finding 3', description: 'Third issue',
      });
      const findings = await reviewService.listFindingsForReview(review.id);
      expect(findings).toHaveLength(3);
    });

    it('rejects a finding with an invalid criterion (nonexistent)', async () => {
      const wi = await createWorkItemA('REVIEW-FIND-003');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-find-003',
      });
      await expect(
        reviewService.addFinding({
          projectId: projectA.id, reviewId: review.id,
          title: 'Bad finding', description: 'Invalid criterion ref',
          criterionId: '00000000-0000-0000-0000-000000000000',
        }),
      ).rejects.toThrow();
    });

    it('cross-tenant criterion reference is rejected (tenant isolation)', async () => {
      const wi = await createWorkItemA('REVIEW-FIND-004');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-find-004',
      });
      // criterionB1 belongs to project B, but the review belongs to project A.
      await expect(
        reviewService.addFinding({
          projectId: projectA.id, reviewId: review.id,
          title: 'Cross-tenant', description: 'Bad criterion ref',
          criterionId: criterionB1.id,
        }),
      ).rejects.toThrow();
    });
  });

  // --- Outcomes ---

  describe('Outcomes (REVIEW-AC-02)', () => {
    it('accepts APPROVE verdict', async () => {
      const wi = await createWorkItemA('REVIEW-OUT-001');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-out-001',
      });
      const finalized = await reviewService.finalizeReview(review.id, { outcome: 'APPROVE' });
      expect(finalized.outcome).toBe('APPROVE');
      expect(finalized.status).toBe('completed');
      expect(finalized.completedAt).not.toBeNull();
    });

    it('accepts REQUEST_CHANGES verdict', async () => {
      const wi = await createWorkItemA('REVIEW-OUT-002');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-out-002',
      });
      const finalized = await reviewService.finalizeReview(review.id, { outcome: 'REQUEST_CHANGES' });
      expect(finalized.outcome).toBe('REQUEST_CHANGES');
    });

    it('accepts ARCHITECTURE_CHANGE_REQUIRED verdict', async () => {
      const wi = await createWorkItemA('REVIEW-OUT-003');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-out-003',
      });
      const finalized = await reviewService.finalizeReview(review.id, { outcome: 'ARCHITECTURE_CHANGE_REQUIRED' });
      expect(finalized.outcome).toBe('ARCHITECTURE_CHANGE_REQUIRED');
    });

    it('accepts IMPLEMENTATION_BLOCKED verdict', async () => {
      const wi = await createWorkItemA('REVIEW-OUT-004');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-out-004',
      });
      const finalized = await reviewService.finalizeReview(review.id, { outcome: 'IMPLEMENTATION_BLOCKED' });
      expect(finalized.outcome).toBe('IMPLEMENTATION_BLOCKED');
    });

    it('rejects an invalid verdict', async () => {
      const wi = await createWorkItemA('REVIEW-OUT-005');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-out-005',
      });
      await expect(
        reviewService.finalizeReview(review.id, { outcome: 'INVALID_VERDICT' as never }),
      ).rejects.toThrow(/invalid verdict/);
    });

    it('API: invalid verdict returns 400', async () => {
      const wi = await createWorkItemA('REVIEW-OUT-006');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-out-006',
      });
      const res = await server.inject({
        method: 'POST', url: `/reviews/${review.id}/finalize`,
        headers: { 'x-api-key': 'raw-key-review-a' },
        payload: { outcome: 'NOT_A_VERDICT' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // --- Finalization ---

  describe('Finalization (historical immutability, repeat-finalization)', () => {
    it('finalized review outcome is immutable (REVIEW-AC-03)', async () => {
      const wi = await createWorkItemA('REVIEW-FIN-001');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-fin-001',
      });
      const finalized = await reviewService.finalizeReview(review.id, { outcome: 'APPROVE' });
      expect(finalized.outcome).toBe('APPROVE');

      // Attempt to re-finalize with a different outcome — must be rejected.
      await expect(
        reviewService.finalizeReview(review.id, { outcome: 'REQUEST_CHANGES' }),
      ).rejects.toThrow(/already finalized/);
    });

    it('findings cannot be added to a finalized review', async () => {
      const wi = await createWorkItemA('REVIEW-FIN-002');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-fin-002',
      });
      await reviewService.finalizeReview(review.id, { outcome: 'APPROVE' });
      await expect(
        reviewService.addFinding({
          projectId: projectA.id, reviewId: review.id,
          title: 'Late finding', description: 'After finalization',
        }),
      ).rejects.toThrow(/already finalized/);
    });

    it('repeat finalization is rejected (409)', async () => {
      const wi = await createWorkItemA('REVIEW-FIN-003');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-fin-003',
      });
      await reviewService.finalizeReview(review.id, { outcome: 'APPROVE' });
      const res = await server.inject({
        method: 'POST', url: `/reviews/${review.id}/finalize`,
        headers: { 'x-api-key': 'raw-key-review-a' },
        payload: { outcome: 'REQUEST_CHANGES' },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  // --- Workflow boundary ---

  describe('Workflow boundary (finalization does NOT mutate workflow state)', () => {
    it('finalizing a review does NOT mutate canonical workflow state', async () => {
      const wi = await createWorkItemA('REVIEW-WF-001');
      const wfEngine = new DefaultWorkflowEngine(stack.db.client, stack.db.logger);
      await wfEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-wf-001',
      });
      await reviewService.finalizeReview(review.id, { outcome: 'APPROVE' });
      // Workflow state must be UNCHANGED — /reviews does not mutate workflow state.
      const wfState = await wfEngine.getState(wi.id);
      expect(wfState!.currentState).toBe('ready');
    });

    it('public Review Result is consumable without /reviews/internal imports', async () => {
      const wi = await createWorkItemA('REVIEW-WF-002');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-wf-002',
      });
      await reviewService.addFinding({
        projectId: projectA.id, reviewId: review.id, severity: 'major',
        title: 'Finding 1', description: 'Issue found',
      });
      await reviewService.finalizeReview(review.id, { outcome: 'REQUEST_CHANGES' });
      const result = await reviewService.getReviewResult(review.id);
      expect(result).not.toBeNull();
      expect(result!.reviewId).toBe(review.id);
      expect(result!.workItemId).toBe(wi.id);
      expect(result!.architectureVersionId).toBe(versionA.id);
      expect(result!.outcome).toBe('REQUEST_CHANGES');
      expect(result!.findingIds).toHaveLength(1);
      expect(result!.completedAt).toBeTruthy();
    });

    it('Review Result is null for non-finalized review', async () => {
      const wi = await createWorkItemA('REVIEW-WF-003');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-wf-003',
      });
      const result = await reviewService.getReviewResult(review.id);
      expect(result).toBeNull();
    });
  });

  // --- Verification boundary ---

  describe('Verification boundary (review references evidence/criteria, does not evaluate)', () => {
    it('review can reference verification evidence without evaluating it', async () => {
      const wi = await createWorkItemA('REVIEW-VER-001');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-ver-001',
        reviewInput: {
          verificationRunId: 'verification-run-uuid',
          evidenceReferences: ['evidence-1', 'evidence-2'],
        },
      });
      // The review record references verification evidence in its reviewInput.
      expect(review.reviewInput.verificationRunId).toBe('verification-run-uuid');
      expect(review.reviewInput.evidenceReferences).toEqual(['evidence-1', 'evidence-2']);
    });

    it('findings can reference criteria/evidence without becoming an evidence store', async () => {
      const wi = await createWorkItemA('REVIEW-VER-002');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-ver-002',
      });
      const finding = await reviewService.addFinding({
        projectId: projectA.id, reviewId: review.id,
        severity: 'major', title: 'Criterion not met',
        description: 'The auth criterion is not satisfied by the implementation',
        criterionId: criterionA1.id,
        evidenceRef: 'evidence-uuid-456',
        requiredCorrection: 'Fix the auth flow',
        verificationRequirement: 'Re-run integration tests',
      });
      // The finding references the criterion + evidence — it does NOT evaluate
      // or modify the criterion's status.
      expect(finding.criterionId).toBe(criterionA1.id);
      expect(finding.evidenceRef).toBe('evidence-uuid-456');
      // Verify the criterion's status is UNCHANGED (reviews don't evaluate).
      const crit = await stack.acceptanceCriterionRepository.findById(criterionA1.id);
      expect(crit!.status).toBe('pending'); // unchanged — /reviews doesn't evaluate
    });
  });

  // --- Architect traceability ---

  describe('Architect traceability', () => {
    it('exact architect execution reference is preserved', async () => {
      const wi = await createWorkItemA('REVIEW-TRACE-001');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        architectExecutionId: 'arch-exec-trace-001',
        source: 'architect-llm',
        reviewer: 'fake/test-model',
        executionId: 'review-trace-001',
      });
      expect(review.architectExecutionId).toBe('arch-exec-trace-001');
    });

    it('frozen ArchitectureVersion is not mutated by the review', async () => {
      const wi = await createWorkItemA('REVIEW-TRACE-002');
      const versionBefore = await stack.architectureVersionRepository.findById(versionA.id);
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-trace-002',
      });
      await reviewService.finalizeReview(review.id, { outcome: 'ARCHITECTURE_CHANGE_REQUIRED' });
      // The ArchitectureVersion state must be UNCHANGED — reviews reference,
      // not mutate. A verdict of ARCHITECTURE_CHANGE_REQUIRED signals that
      // /architecture's Change Request lifecycle should be invoked (by
      // /workflows), but /reviews itself never mutates the version.
      const versionAfter = await stack.architectureVersionRepository.findById(versionA.id);
      expect(versionAfter!.state).toBe(versionBefore!.state);
      expect(versionAfter!.contentInline).toBe(versionBefore!.contentInline);
    });
  });

  // --- Correction cycle ---

  describe('Correction cycle (Review #1 → CHANGES_REQUESTED → Review #2 → APPROVE)', () => {
    it('independent historical Reviews remain retrievable after correction cycle', async () => {
      const wi = await createWorkItemA('REVIEW-CYC-001');

      // Review #1 → REQUEST_CHANGES with a finding.
      const review1 = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-cyc-001a',
      });
      const finding1 = await reviewService.addFinding({
        projectId: projectA.id, reviewId: review1.id,
        severity: 'blocker', title: 'Auth bypass', description: 'Critical issue',
        requiredCorrection: 'Add header validation',
      });
      const finalized1 = await reviewService.finalizeReview(review1.id, { outcome: 'REQUEST_CHANGES' });
      expect(finalized1.outcome).toBe('REQUEST_CHANGES');

      // Review #2 → APPROVE. Its finding links back to the prior finding
      // (FINDING-AC-03 correction-cycle traceability).
      const review2 = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-cyc-001b',
      });
      const finding2 = await reviewService.addFinding({
        projectId: projectA.id, reviewId: review2.id,
        severity: 'info', title: 'Correction verified', description: 'The bypass is fixed',
        causedByFindingId: finding1.id, // link-back to prior finding
      });
      const finalized2 = await reviewService.finalizeReview(review2.id, { outcome: 'APPROVE' });
      expect(finalized2.outcome).toBe('APPROVE');

      // Both reviews remain independently persisted + historically retrievable.
      const history = await reviewService.listReviewsForWorkItem(wi.id);
      expect(history).toHaveLength(2);
      // Newest first.
      expect(history[0]!.id).toBe(review2.id);
      expect(history[1]!.id).toBe(review1.id);

      // The correction-cycle link-back is preserved.
      expect(finding2.causedByFindingId).toBe(finding1.id);

      // Review #1's outcome is immutable (not silently changed to APPROVE).
      const review1After = await reviewService.findReview(review1.id);
      expect(review1After!.outcome).toBe('REQUEST_CHANGES');
    });
  });

  // --- Tenant isolation ---

  describe('Tenant isolation', () => {
    it('cross-tenant Review read denied (403)', async () => {
      const wi = await createWorkItemA('REVIEW-TEN-001');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-ten-001',
      });
      // User B tries to read Project A's review.
      const res = await server.inject({
        method: 'GET', url: `/reviews/${review.id}`,
        headers: { 'x-api-key': 'raw-key-review-b' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('cross-tenant Review creation denied (403)', async () => {
      const wi = await createWorkItemA('REVIEW-TEN-002');
      // User B tries to create a review for Project A's work item.
      const res = await server.inject({
        method: 'POST', url: `/work-items/${wi.id}/reviews`,
        headers: { 'x-api-key': 'raw-key-review-b' },
        payload: { source: 'architect-llm' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('cross-tenant finding creation denied (403)', async () => {
      const wi = await createWorkItemA('REVIEW-TEN-003');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-ten-003',
      });
      // User B tries to add a finding to Project A's review.
      const res = await server.inject({
        method: 'POST', url: `/reviews/${review.id}/findings`,
        headers: { 'x-api-key': 'raw-key-review-b' },
        payload: { title: 'Cross-tenant finding', description: 'Bad' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('cross-tenant finalize denied (403)', async () => {
      const wi = await createWorkItemA('REVIEW-TEN-004');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-ten-004',
      });
      // User B tries to finalize Project A's review.
      const res = await server.inject({
        method: 'POST', url: `/reviews/${review.id}/finalize`,
        headers: { 'x-api-key': 'raw-key-review-b' },
        payload: { outcome: 'APPROVE' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('identifier substitution cannot bypass authorization (cross-tenant criterion)', async () => {
      const wiA = await createWorkItemA('REVIEW-TEN-005');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wiA.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-ten-005',
      });
      // Try to add a finding referencing Project B's criterion — rejected at DB level.
      await expect(
        reviewService.addFinding({
          projectId: projectA.id, reviewId: review.id,
          title: 'Cross-tenant criterion', description: 'Bad',
          criterionId: criterionB1.id,
        }),
      ).rejects.toThrow();
    });

    it('cross-tenant work item substitution rejected', async () => {
      // User B's work item belongs to project B. User A tries to create a
      // review for it via the API.
      const wiB = await createWorkItemB('REVIEW-TEN-006');
      const res = await server.inject({
        method: 'POST', url: `/work-items/${wiB.id}/reviews`,
        headers: { 'x-api-key': 'raw-key-review-a' },
        payload: { source: 'architect-llm' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // --- API ---

  describe('API', () => {
    it('API: authorized review creation succeeds (201)', async () => {
      const wi = await createWorkItemA('REVIEW-API-001');
      const res = await server.inject({
        method: 'POST', url: `/work-items/${wi.id}/reviews`,
        headers: { 'x-api-key': 'raw-key-review-a' },
        payload: { source: 'architect-llm', reviewer: 'fake/test-model' },
      });
      expect(res.statusCode).toBe(201);
      const review = res.json() as Review;
      expect(review.workItemId).toBe(wi.id);
    });

    it('API: list review history for a work item', async () => {
      const wi = await createWorkItemA('REVIEW-API-002');
      await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-api-002a',
      });
      await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-api-002b',
      });
      const res = await server.inject({
        method: 'GET', url: `/work-items/${wi.id}/reviews`,
        headers: { 'x-api-key': 'raw-key-review-a' },
      });
      expect(res.statusCode).toBe(200);
      const reviews = res.json() as Review[];
      expect(reviews).toHaveLength(2);
    });

    it('API: retrieve public Review Result', async () => {
      const wi = await createWorkItemA('REVIEW-API-003');
      const review = await reviewService.createReview({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'architect-llm', executionId: 'review-api-003',
      });
      await reviewService.finalizeReview(review.id, { outcome: 'APPROVE' });
      const res = await server.inject({
        method: 'GET', url: `/reviews/${review.id}/result`,
        headers: { 'x-api-key': 'raw-key-review-a' },
      });
      expect(res.statusCode).toBe(200);
      const result = res.json() as ArchitectReviewResult;
      expect(result.outcome).toBe('APPROVE');
      expect(result.reviewId).toBe(review.id);
    });
  });
});
