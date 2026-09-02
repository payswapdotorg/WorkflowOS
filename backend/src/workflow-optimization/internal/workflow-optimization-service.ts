/**
 * V2-011 — the workflow-optimization service (the proposal lifecycle).
 *
 * Deterministic analysis → proposal creation with full provenance and the
 * unsafe guard → the human/owner APPROVAL GATE → materialization of the
 * approved candidate as a NEW WorkflowVersion through the materializer
 * port (re-verifying every guard first — defense in depth). The service
 * NEVER activates, installs, deploys or enables anything: the candidate
 * version merely EXISTS; activation is V2-002/V2-009's surface.
 *
 * The baseline document is consumed read-only (deep-cloned on entry);
 * every handed-out record is deep-frozen (copy-on-write discipline).
 */
import {
  computeWorkflowVersionSemanticDigest,
  serializeWorkflowIrDocument,
} from '../../workflow-ir/index.js';
import type { WorkflowIrDocument } from '../../workflow-ir/index.js';
import type { WorkflowRunHistory } from '../../workflow-runs/index.js';
import type {
  CreateProposalInput,
  ListProposalsInput,
  MaterializationRecord,
  MaterializeProposalResult,
  OptimizationAnalysis,
  OptimizationProposal,
  ProposalActionInput,
  SubworkflowReuseTarget,
  WorkflowOptimizationService,
  WorkflowOptimizationServiceDeps,
} from '../types.js';
import { WorkflowOptimizationError } from '../types.js';
import { analyzeWorkflowDocument } from './analysis.js';
import {
  deriveApiSubstitutionCandidate,
  deriveReuseSubstitutionCandidate,
} from './candidate-derivation.js';
import { compareWorkflowVersions, compareRunHistories } from './comparison.js';
import { assertCandidateSafe } from './unsafe-guard.js';
import { deepClone, deepFreeze } from './immutable.js';

/** The canonical protocol descriptor the materializer carries (the V2-002 route contract). */
const CANDIDATE_PROTOCOL = { irSchemaVersion: 'workflowos-workflow-ir-v1' } as const;

export class DefaultWorkflowOptimizationService implements WorkflowOptimizationService {
  private readonly deps: WorkflowOptimizationServiceDeps;

  constructor(deps: WorkflowOptimizationServiceDeps) {
    this.deps = deps;
  }

  analyzeWorkflow(document: WorkflowIrDocument): OptimizationAnalysis {
    return analyzeWorkflowDocument(document);
  }

  createProposal(input: CreateProposalInput): OptimizationProposal {
    // fail-closed input validation
    if (
      !input.ownerId ||
      !input.workflowId ||
      !input.versionId ||
      !input.opportunityNodeId
    ) {
      throw new WorkflowOptimizationError(
        'OPTIMIZATION_INPUT_INVALID',
        'ownerId, workflowId, versionId and opportunityNodeId are required',
      );
    }
    if (input.reuseTarget !== undefined && input.reuseTarget !== null) {
      assertReuseTargetValid(input.reuseTarget);
    }

    // the baseline document is consumed read-only (deep clone on entry)
    const baseline = deepClone(input.document);

    // the analysis is re-run internally (deterministic — identical to the
    // caller's own analyzeWorkflow result for the same document)
    const analysis = analyzeWorkflowDocument(baseline);

    // resolve the requested opportunity
    const opportunity =
      analysis.opportunities.find(
        (candidate) =>
          candidate.kind === 'api_substitution' && candidate.nodeId === input.opportunityNodeId,
      ) ??
      analysis.opportunities.find(
        (candidate) =>
          candidate.kind === 'workflow_reuse' &&
          candidate.nodeIds.includes(input.opportunityNodeId),
      );
    if (!opportunity) {
      // an unsafe rejection covering this node is reported as such
      const rejection = analysis.rejected.find((candidate) =>
        candidate.nodeIds.includes(input.opportunityNodeId),
      );
      if (rejection) {
        throw new WorkflowOptimizationError(
          'UNSAFE_OPTIMIZATION',
          `the optimization for node ${input.opportunityNodeId} is rejected as unsafe: ${rejection.reason}`,
          { reason: rejection.reason, nodeIds: rejection.nodeIds },
        );
      }
      throw new WorkflowOptimizationError(
        'OPPORTUNITY_NOT_FOUND',
        `no optimization opportunity found for node ${input.opportunityNodeId}`,
        { opportunityNodeId: input.opportunityNodeId },
      );
    }

    // derive the candidate (the proposed change — always a NEW document)
    let candidate: WorkflowIrDocument;
    let affectedNodeIds: readonly string[];
    let reuseTarget: SubworkflowReuseTarget | null = null;
    if (opportunity.kind === 'api_substitution') {
      if (input.reuseTarget !== undefined && input.reuseTarget !== null) {
        throw new WorkflowOptimizationError(
          'REUSE_TARGET_INVALID',
          'a reuse target does not apply to an api_substitution proposal',
        );
      }
      candidate = deriveApiSubstitutionCandidate(baseline, opportunity.nodeId);
      affectedNodeIds = [opportunity.nodeId];
    } else {
      reuseTarget = input.reuseTarget ?? null;
      candidate = deriveReuseSubstitutionCandidate(
        baseline,
        opportunity.substitutionSiteNodeIds,
        reuseTarget ?? { workflowId: 'unresolved', versionRef: 'unresolved' },
      );
      affectedNodeIds = [...opportunity.substitutionSiteNodeIds];
    }

    // the deterministic comparison (correctness FIRST) + the unsafe guard
    const comparison = compareWorkflowVersions(baseline, candidate);
    assertCandidateSafe({ baseline, candidate, comparison, affectedNodeIds });

    const proposal: OptimizationProposal = deepFreeze({
      id: this.deps.idFactory(),
      kind: opportunity.kind,
      ownerId: input.ownerId,
      provenance: {
        baseline: {
          workflowId: input.workflowId,
          versionId: input.versionId,
          semanticDigest: computeWorkflowVersionSemanticDigest(baseline).digest,
        },
        analysisId: analysis.analysisId,
        rulesVersion: analysis.rulesVersion,
        opportunityKind: opportunity.kind,
        opportunityNodeIds: [...(opportunity.kind === 'api_substitution' ? [opportunity.nodeId] : opportunity.nodeIds)],
        candidateDigest: computeWorkflowVersionSemanticDigest(candidate).digest,
      },
      affectedNodeIds: [...affectedNodeIds],
      rationale: opportunity.rationale,
      baselineDocument: deepFreeze(deepClone(baseline)),
      candidateDocument: deepFreeze(deepClone(candidate)),
      reuseTarget,
      comparison: deepFreeze(deepClone(comparison)),
      status: 'proposed',
      createdAt: this.deps.clock(),
      decision: null,
      materialization: null,
    });
    this.deps.store.put(deepClone(proposal));
    return proposal;
  }

  getProposal(proposalId: string): OptimizationProposal {
    const stored = this.deps.store.get(proposalId);
    if (!stored) {
      throw new WorkflowOptimizationError(
        'PROPOSAL_NOT_FOUND',
        `no optimization proposal ${proposalId}`,
      );
    }
    return deepFreeze(deepClone(stored));
  }

  listProposals(input?: ListProposalsInput): readonly OptimizationProposal[] {
    const proposals = this.deps.store.list();
    const filtered =
      input?.workflowId !== undefined
        ? proposals.filter((proposal) => proposal.provenance.baseline.workflowId === input.workflowId)
        : proposals;
    return filtered.map((proposal) => deepFreeze(deepClone(proposal)));
  }

  approveProposal(input: ProposalActionInput): OptimizationProposal {
    return this.decide(input, 'approved');
  }

  rejectProposal(input: ProposalActionInput): OptimizationProposal {
    return this.decide(input, 'rejected');
  }

  async materializeProposal(input: {
    readonly proposalId: string;
    readonly ownerId: string;
  }): Promise<MaterializeProposalResult> {
    const stored = this.getProposalInternal(input.proposalId);
    if (stored.ownerId !== input.ownerId) {
      throw new WorkflowOptimizationError(
        'OWNER_MISMATCH',
        `only the proposal owner may materialize proposal ${input.proposalId}`,
      );
    }
    if (stored.status === 'proposed') {
      throw new WorkflowOptimizationError(
        'APPROVAL_REQUIRED',
        `proposal ${input.proposalId} requires the owner's explicit approval before a candidate version can be materialized`,
      );
    }
    if (stored.status === 'rejected') {
      throw new WorkflowOptimizationError(
        'PROPOSAL_NOT_APPROVED',
        `proposal ${input.proposalId} was rejected by the owner — it can never be materialized`,
      );
    }
    if (stored.status === 'materialized') {
      throw new WorkflowOptimizationError(
        'PROPOSAL_ALREADY_MATERIALIZED',
        `proposal ${input.proposalId} already materialized candidate version ${stored.materialization?.versionId}`,
      );
    }

    // reuse proposals require an explicit existing-workflow target
    if (stored.kind === 'workflow_reuse' && !stored.reuseTarget) {
      throw new WorkflowOptimizationError(
        'REUSE_TARGET_REQUIRED',
        `proposal ${input.proposalId} is a reuse suggestion without an explicit target workflow version — supply the reuse target before materializing`,
      );
    }

    // defense in depth: re-verify every unsafe-optimization invariant
    const comparison = compareWorkflowVersions(stored.baselineDocument, stored.candidateDocument);
    assertCandidateSafe({
      baseline: stored.baselineDocument,
      candidate: stored.candidateDocument,
      comparison,
      affectedNodeIds: stored.affectedNodeIds,
    });

    // materialize as a NEW WorkflowVersion through the port (never a mutation)
    const content = JSON.parse(
      serializeWorkflowIrDocument(stored.candidateDocument),
    ) as Record<string, unknown>;
    let versionId: string;
    try {
      const result = await this.deps.materializer.createCandidateVersion({
        workflowId: stored.provenance.baseline.workflowId,
        parentVersionId: stored.provenance.baseline.versionId,
        content,
        protocol: { ...CANDIDATE_PROTOCOL },
      });
      versionId = result.versionId;
    } catch (error) {
      if (error instanceof WorkflowOptimizationError) {
        throw error;
      }
      throw new WorkflowOptimizationError(
        'MATERIALIZER_FAILED',
        `the candidate-version materializer rejected the proposal: ${error instanceof Error ? error.message : String(error)}`,
        { proposalId: input.proposalId },
      );
    }

    const materialization: MaterializationRecord = {
      workflowId: stored.provenance.baseline.workflowId,
      versionId,
      materializedAt: this.deps.clock(),
      candidateDigest: stored.provenance.candidateDigest,
    };
    const materialized: OptimizationProposal = deepFreeze({
      ...deepClone(stored),
      status: 'materialized',
      materialization,
    });
    this.deps.store.put(deepClone(materialized));
    return { proposal: deepFreeze(deepClone(materialized)), materialization };
  }

  compareVersions(baseline: WorkflowIrDocument, candidate: WorkflowIrDocument) {
    return compareWorkflowVersions(baseline, candidate);
  }

  compareRunHistories(baseline: WorkflowRunHistory, optimized: WorkflowRunHistory) {
    return compareRunHistories(baseline, optimized);
  }

  // ---------------------------------------------------------------------

  private decide(
    input: ProposalActionInput,
    decision: 'approved' | 'rejected',
  ): OptimizationProposal {
    const stored = this.getProposalInternal(input.proposalId);
    if (stored.ownerId !== input.ownerId) {
      throw new WorkflowOptimizationError(
        'OWNER_MISMATCH',
        `only the proposal owner may decide proposal ${input.proposalId}`,
      );
    }
    if (stored.status !== 'proposed') {
      throw new WorkflowOptimizationError(
        'PROPOSAL_ALREADY_DECIDED',
        `proposal ${input.proposalId} is already ${stored.status} — decisions are single-shot`,
      );
    }
    const decided: OptimizationProposal = deepFreeze({
      ...deepClone(stored),
      status: decision,
      decision: {
        ownerId: input.ownerId,
        decidedAt: this.deps.clock(),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });
    this.deps.store.put(deepClone(decided));
    return decided;
  }

  private getProposalInternal(proposalId: string): OptimizationProposal {
    const stored = this.deps.store.get(proposalId);
    if (!stored) {
      throw new WorkflowOptimizationError(
        'PROPOSAL_NOT_FOUND',
        `no optimization proposal ${proposalId}`,
      );
    }
    return stored;
  }
}

/** A reuse target must be a non-empty (workflowId, versionRef) pair. */
function assertReuseTargetValid(target: SubworkflowReuseTarget): void {
  if (!target.workflowId || !target.versionRef) {
    throw new WorkflowOptimizationError(
      'REUSE_TARGET_INVALID',
      'a reuse target requires a non-empty workflowId and versionRef',
    );
  }
}
