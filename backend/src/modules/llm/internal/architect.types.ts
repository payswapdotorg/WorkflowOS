/**
 * Architect Service types (LLM-002, LLM-003).
 *
 * WORK-014 extends /llm with the Architect Service: assembles authoritative
 * context from persistent state, requests reasoning through LlmGateway,
 * normalizes the result, and generates a Work Order via /work-items.
 *
 * The Architect Service does NOT:
 * - persist Architect Review records (that's /reviews);
 * - mutate workflow state (that's /workflows);
 * - determine criterion PASS/FAIL (that's /verification);
 * - create a second Work Order model (that's /work-items).
 */

// --- Architect context (assembled from persistent state) ---

export interface ArchitectContext {
  readonly projectId: string;
  readonly architectureVersionId: string;
  readonly workItemId?: string;
  readonly requirements: ArchitectRequirementSummary[];
  readonly acceptanceCriteria: ArchitectCriterionSummary[];
  readonly architectureConstraints: string | null;
  readonly repositoryEvidence: ArchitectRepositoryEvidence[];
  readonly verificationEvidence: ArchitectVerificationEvidence[];
  readonly outOfScope: string | null;
}

export interface ArchitectRequirementSummary {
  readonly id: string;
  readonly requirementId: string;
  readonly title: string;
  readonly status: string;
}

export interface ArchitectCriterionSummary {
  readonly id: string;
  readonly criterionId: string;
  readonly description: string;
  readonly status: string;
  readonly requirementId: string;
}

export interface ArchitectRepositoryEvidence {
  readonly provider: string;
  readonly externalId: string;
  readonly canonicalRef: string;
}

export interface ArchitectVerificationEvidence {
  readonly type: string;
  readonly ref: string;
  readonly status: string | null;
}

// --- Architect execution request ---

export interface ArchitectExecutionRequest {
  readonly projectId: string;
  readonly architectureVersionId: string;
  readonly workItemId?: string;
  /**
   * Optional VerificationRun ID. When provided (WORK-018), the Architect
   * Service loads the persisted verification run + its evidence and includes
   * them in the assembled context (WF-VER-AC-02).
   */
  readonly verificationRunId?: string;
  readonly task: string;
  readonly executionId: string;
  readonly provider: string;
  readonly model: string;
}

// --- Architect execution result (normalized, provider-independent) ---

export interface ArchitectExecutionResult {
  readonly executionId: string;
  readonly provider: string;
  readonly model: string;
  readonly verdict: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly identifiedRisks: string[];
  readonly identifiedConstraints: string[];
  readonly requiredCorrections: string[];
  readonly architectureChangeRequired: boolean;
  readonly workOrderCandidate: WorkOrderCandidate | null;
}

export interface WorkOrderCandidate {
  readonly scope: string;
  readonly outOfScope: string;
  readonly architectureConstraints: string;
  readonly requirementIds: string[];
  readonly criterionIds: string[];
  readonly verificationRequirements: string[];
  readonly implementationContext: Record<string, unknown>;
}

// --- Architect Service interface ---

export interface ArchitectService {
  /**
   * Assemble authoritative context from persistent state and execute
   * architect reasoning through the existing LlmGateway.
   */
  execute(request: ArchitectExecutionRequest): Promise<ArchitectExecutionResult>;

  /**
   * Generate a Work Order from an architect execution result using the
   * existing /work-items Work Order contract.
   */
  generateWorkOrder(
    request: ArchitectExecutionRequest,
    result: ArchitectExecutionResult,
  ): Promise<{ workOrderId: string; architectExecutionId: string }>;
}
