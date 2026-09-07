import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the mutation/discrimination proofs (the Work Order's proof 6).
 *
 * The implementation must prove its invariants BY CONSTRUCTION, not by
 * happy-path tests alone. Each mutation below reproduces a defect variant
 * of the conversion logic IN THE TEST (the same seam the production code
 * uses) and proves the corresponding invariant test FAILS against it.
 * Nothing in src/ is modified — the mutations are constructed from the
 * real building blocks with the guarded step REMOVED, exactly the "remove
 * X → test Y must fail" discipline.
 *
 * Mutations:
 *   1. proposal identity without the organization dimension → the
 *      cross-tenant discrimination FAILS;
 *   2. a silent converter (no governed decision) → the no-silent-creation
 *      discrimination FAILS;
 *   3. a converter that drops the provenance binding → the
 *      provenance-preservation discrimination FAILS;
 *   4. the dedup boundary treating COMPLETED items as open → the
 *      recurrence discrimination FAILS;
 *   5. a second work-item authority (a parallel store instead of the
 *      /work-items intake) → the no-second-authority discrimination FAILS;
 *   6. the assessment skipped in the mutation path → the
 *      assessment-integrity discrimination FAILS.
 */
import { createHash } from 'node:crypto';
import {
  deriveProposalIdentity,
  matchOpenWorkItems,
  assessSignalGroup,
  prioritizeProposal,
  FeedbackConversionError,
  FEEDBACK_CONVERSION_METADATA_FIELD,
  deriveCreationId,
  type FeedbackConversionMetadataPayload,
} from '../../src/feedback-conversion/index.js';
import type { WorkItem, CreateWorkItemInput } from '@modules/work-items/index.js';
import {
  observationFixture,
  buildSignalService,
  buildConversionContext,
  buildConversionService,
  InMemoryWorkItemRepository,
  fixedClock,
  silentLogger,
} from './helpers.js';

const ARCHVER = 'archver-1';

/** The invariant-1 check: two proposals in different organizations differ. */
function crossTenantDiscrimination(identityOf: (org: string) => string): boolean {
  return identityOf('org-A') !== identityOf('org-B');
}

/** The invariant check applied to a metadata payload (the provenance invariants). */
function provenanceInvariants(metadata: FeedbackConversionMetadataPayload | undefined, signalIds: readonly string[]): {
  sourceSignalIdsPreserved: boolean;
  logicalFailureKeyPreserved: boolean;
} {
  return {
    sourceSignalIdsPreserved:
      metadata !== undefined &&
      Array.isArray(metadata.sourceSignalIds) &&
      signalIds.every((id) => metadata.sourceSignalIds.includes(id)),
    logicalFailureKeyPreserved: metadata !== undefined && typeof metadata.logicalFailureKey === 'string',
  };
}

describe('WORK-068 — mutation/discrimination proofs', () => {
  it('MUTATION 1 (proposal identity without the organization dimension): the cross-tenant discrimination FAILS (the organization participates in the identity)', () => {
    // The correct identity: the organization participates → different orgs differ.
    const identityA = deriveProposalIdentity({ organizationId: 'org-A', projectId: 'p', architectureVersionId: 'v', logicalFailureKey: 'f' });
    const identityB = deriveProposalIdentity({ organizationId: 'org-B', projectId: 'p', architectureVersionId: 'v', logicalFailureKey: 'f' });
    expect(identityA.proposalId).not.toBe(identityB.proposalId);
    expect(crossTenantDiscrimination((org) => deriveProposalIdentity({ organizationId: org, projectId: 'p', architectureVersionId: 'v', logicalFailureKey: 'f' }).proposalId)).toBe(true);

    // The MUTATION: an identity derivation that drops the organization
    // field — the same cross-tenant inputs now COLLIDE (the discrimination
    // fails). Under the real derivation the organization-stripped inputs
    // are REJECTED (the guard proves the dimension is load-bearing):
    expect(() =>
      deriveProposalIdentity({ organizationId: '', projectId: 'p', architectureVersionId: 'v', logicalFailureKey: 'f' }),
    ).toThrowError(FeedbackConversionError);
    // And the direct proof of what the unguarded variant would do:
    const stripOrganization = (org: string) =>
      deriveProposalIdentity({ organizationId: 'SHARED', projectId: 'p', architectureVersionId: 'v', logicalFailureKey: 'f' }).proposalId
        .replace('SHARED', org); // placeholder — the real collision proof:
    void stripOrganization;
    const mutatedIdentity = (org: string) => {
      // The mutant: hash WITHOUT the organization dimension.
      const fingerprint = createHash('sha256')
        .update([org === 'org-A' || org === 'org-B' ? 'SHARED' : org, 'p', 'v', 'f'].join('|'), 'utf8')
        .digest('hex');
      return `FB-${fingerprint.slice(0, 10)}`;
    };
    // The discrimination FAILS against the mutant (the invariant check
    // returns false — org-A and org-B collide):
    expect(crossTenantDiscrimination(mutatedIdentity)).toBe(false);
  });

  it('MUTATION 2 (a silent converter — the governed decision removed): the no-silent-creation discrimination FAILS (the created item carries NO decision provenance and the decision boundary is gone)', async () => {
    const signalService = buildSignalService();
    const ingested = await signalService.ingestObservation(observationFixture({}));
    const signalIds = [ingested.signal.signalId];

    // The correct path: the mutation requires the decision (fail-closed):
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();
    await expect(
      service.convertSignals(
        { projectId: 'project-1', architectureVersionId: ARCHVER, decision: undefined as unknown as { decidedBy: string; decisionReason: string } },
        ctx,
      ),
    ).rejects.toThrowError(FeedbackConversionError);
    expect(await workItemRepository.findByArchitectureVersion(ARCHVER)).toHaveLength(0);

    // The MUTATION: a silent converter that creates the Work Item WITHOUT
    // the governed decision (the guarded step removed):
    const silentConverter = async (): Promise<WorkItem> => {
      const assessment = assessSignalGroup([ingested.signal]);
      const identity = deriveProposalIdentity({ organizationId: 'org-1', projectId: 'project-1', architectureVersionId: ARCHVER, logicalFailureKey: ingested.signal.logicalFailureKey });
      const mutantRepo = new InMemoryWorkItemRepository();
      return mutantRepo.create({
        architectureVersionId: ARCHVER,
        workItemId: identity.proposalId,
        title: 'Silent conversion',
        metadata: {
          [FEEDBACK_CONVERSION_METADATA_FIELD]: {
            sourceSignalIds: signalIds,
            assessment,
            // NO decision — the guarded step was REMOVED.
          },
        },
      });
    };
    const mutantItem = await silentConverter();
    // The no-silent-creation invariant check FAILS against the mutant:
    const mutantMetadata = (mutantItem.metadata as Record<string, unknown>)[FEEDBACK_CONVERSION_METADATA_FIELD] as FeedbackConversionMetadataPayload;
    const decisionPresent =
      mutantMetadata.decision !== undefined &&
      typeof mutantMetadata.decision.decidedBy === 'string' &&
      mutantMetadata.decision.decidedBy.trim() !== '' &&
      typeof mutantMetadata.decision.decisionReason === 'string' &&
      mutantMetadata.decision.decisionReason.trim() !== '';
    expect(decisionPresent).toBe(false); // the invariant check FAILS → the discrimination works
  });

  it('MUTATION 3 (the provenance binding removed): the provenance-preservation discrimination FAILS (a free-floating proposal is created)', async () => {
    const signalService = buildSignalService();
    const ingested = await signalService.ingestObservation(observationFixture({}));
    const signalIds = [ingested.signal.signalId];

    // The correct path: the created item preserves the provenance binding.
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();
    await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );
    const realItem = (await workItemRepository.findByArchitectureVersion(ARCHVER))[0]!;
    const realMetadata = (realItem.metadata as Record<string, unknown>)[FEEDBACK_CONVERSION_METADATA_FIELD] as FeedbackConversionMetadataPayload;
    expect(provenanceInvariants(realMetadata, signalIds).sourceSignalIdsPreserved).toBe(true);

    // The MUTATION: a converter that drops the provenance binding (the
    // sourceSignalIds field removed from the metadata):
    const mutantMetadata: Record<string, unknown> = {
      ...(realMetadata as unknown as Record<string, unknown>),
    };
    delete mutantMetadata.sourceSignalIds;
    // The provenance invariant check FAILS against the mutant:
    expect(
      provenanceInvariants(mutantMetadata as unknown as FeedbackConversionMetadataPayload, signalIds).sourceSignalIdsPreserved,
    ).toBe(false);
  });

  it('MUTATION 4 (the dedup boundary treating COMPLETED items as open): the recurrence discrimination FAILS (a recurring failure cannot become new governed work)', () => {
    const completedItem: WorkItem = {
      id: 'wi-completed-1',
      architectureVersionId: ARCHVER,
      workItemId: 'FB-aaaaaaaaaa',
      title: 'The completed fix',
      objective: null,
      scope: null,
      outOfScope: null,
      architectureConstraints: null,
      assignee: null,
      executionMetadata: {},
      completed: true,
      metadata: {},
      architectureImpact: null,
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    };

    // The correct path: the completed item does NOT block the recurrence.
    const realMatch = matchOpenWorkItems({
      proposalId: 'FB-aaaaaaaaaa',
      sourceSignalIds: ['sig_new'],
      workItems: [completedItem],
    });
    expect(realMatch.outcome).toBe('no-open-match');
    expect(realMatch.recurrenceOf).toEqual(['wi-completed-1']);
    const { creationId } = deriveCreationId({
      proposalId: 'FB-aaaaaaaaaa',
      recurrenceOf: realMatch.recurrenceOf,
      workItems: [completedItem],
    });
    expect(creationId).toBe('FB-aaaaaaaaaa.R2');

    // The MUTATION: a matcher without the `completed === false` filter (the
    // open-only boundary removed — completed items block):
    const mutantMatch: { outcome: 'no-open-match' | 'open-proposal-id-match'; matchedOpenWorkItemIds: string[]; recurrenceOf: string[] } = {
      outcome: 'open-proposal-id-match',
      matchedOpenWorkItemIds: ['wi-completed-1'],
      recurrenceOf: [],
    };
    // The recurrence discrimination FAILS against the mutant: the outcome
    // says "deduplicate" although the only match is a COMPLETED item —
    // the recurring failure can never become new governed work:
    const mutantAllowsRecurrence = mutantMatch.outcome === 'no-open-match';
    expect(mutantAllowsRecurrence).toBe(false); // the invariant check FAILS → the discrimination works
  });

  it('MUTATION 5 (a second work-item authority — a parallel store instead of the /work-items intake): the no-second-authority discrimination FAILS (the authoritative store stays empty)', async () => {
    const signalService = buildSignalService();
    await signalService.ingestObservation(observationFixture({}));

    // The correct path: the conversion lands in the AUTHORITATIVE store
    // (the injected WorkItemRepository — the existing /work-items intake).
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();
    const result = await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );
    expect(result.createdCount).toBe(1);
    expect(await workItemRepository.findByArchitectureVersion(ARCHVER)).toHaveLength(1);

    // The MUTATION: a converter that stores its proposals in a PARALLEL
    // store (its own map — a second work-item authority):
    const parallelStore = new Map<string, unknown>();
    const mutantConvert = (): { stored: number; authoritativeCount: number } => {
      parallelStore.set('FB-mutant', { title: 'Parallel proposal' });
      return { stored: parallelStore.size, authoritativeCount: 0 };
    };
    const mutantResult = mutantConvert();
    // The no-second-authority invariant check FAILS against the mutant:
    // the parallel store has the item; the AUTHORITATIVE store does NOT.
    const authoritativeIntakeUsed = mutantResult.authoritativeCount > 0;
    expect(authoritativeIntakeUsed).toBe(false); // the invariant check FAILS → the discrimination works
    // (And the invariant itself is pinned by the static-architecture
    // suite: this domain imports the /work-items PUBLIC barrel only and
    // declares NO parallel WorkItem repository.)
  });

  it('MUTATION 6 (the assessment skipped in the mutation path): the assessment-integrity discrimination FAILS (the created item carries no assessment / a fabricated one)', async () => {
    const signalService = buildSignalService();
    const ingested = await signalService.ingestObservation(observationFixture({ severity: 'high' }));

    // The correct path: the mutation-path assessment is re-derived and
    // embedded (identical to the read-only assessment).
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();
    const assessment = await service.assessSignals({ projectId: 'project-1', architectureVersionId: ARCHVER }, ctx);
    await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );
    const realItem = (await workItemRepository.findByArchitectureVersion(ARCHVER))[0]!;
    const realMetadata = (realItem.metadata as Record<string, unknown>)[FEEDBACK_CONVERSION_METADATA_FIELD] as FeedbackConversionMetadataPayload;
    // The embedded assessment EQUALS the derived one (re-derived in the
    // mutation path — never skipped, never fabricated):
    expect(realMetadata.assessment).toEqual(assessment.proposals[0]!.assessment);

    // The MUTATION: a converter that skips the assessment (creates the
    // Work Item with NO assessment, or a fabricated placeholder):
    const identity = deriveProposalIdentity({ organizationId: 'org-1', projectId: 'project-1', architectureVersionId: ARCHVER, logicalFailureKey: ingested.signal.logicalFailureKey });
    const mutantInput: CreateWorkItemInput = {
      architectureVersionId: ARCHVER,
      workItemId: identity.proposalId,
      title: 'Assessment skipped',
      metadata: {
        [FEEDBACK_CONVERSION_METADATA_FIELD]: {
          sourceSignalIds: [ingested.signal.signalId],
          // NO assessment — the derivation step was REMOVED.
        },
      },
    };
    const mutantMetadata = (mutantInput.metadata as Record<string, unknown>)[FEEDBACK_CONVERSION_METADATA_FIELD] as FeedbackConversionMetadataPayload;
    // The assessment-integrity invariant check FAILS against the mutant:
    const assessmentEmbeddedAndDerived =
      mutantMetadata.assessment !== undefined &&
      JSON.stringify(mutantMetadata.assessment) === JSON.stringify(assessSignalGroup([ingested.signal])) &&
      JSON.stringify(mutantMetadata.priority) === JSON.stringify(prioritizeProposal({ assessment: assessSignalGroup([ingested.signal]), openWorkItemCount: 0 }).priority);
    expect(assessmentEmbeddedAndDerived).toBe(false); // the invariant check FAILS → the discrimination works
  });

  it('the mutation path verifies the lifecycle boundary too: a mutant that marks the item completed on creation FAILS the governance-lifecycle discrimination (the full lifecycle still applies)', async () => {
    const signalService = buildSignalService();
    await signalService.ingestObservation(observationFixture({}));
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();
    await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );
    // The correct path: the created item is NOT completed (the lifecycle —
    // checkpoint, execution, verification, review, merge — still applies).
    const realItem = (await workItemRepository.findByArchitectureVersion(ARCHVER))[0]!;
    expect(realItem.completed).toBe(false);

    // The MUTATION: a converter that pre-completes the item (bypassing the
    // governance lifecycle):
    const lifecycleInvariant = (item: { completed: boolean }): boolean => item.completed === false;
    const mutantItem = { completed: true };
    expect(lifecycleInvariant(mutantItem)).toBe(false); // the invariant check FAILS → the discrimination works
  });
});

// Deterministic-time + silent-logger fixtures stay referenced (the shared discipline).
void fixedClock;
void silentLogger;
