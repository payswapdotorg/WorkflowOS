import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type { LlmGateway } from './llm.types.js';
import type { WorkOrderRepository } from '@modules/work-items/index.js';
import type {
  ArchitectService,
  ArchitectExecutionRequest,
  ArchitectExecutionResult,
  ArchitectContext,
  ArchitectRequirementSummary,
  ArchitectCriterionSummary,
  ArchitectRepositoryEvidence,
  ArchitectVerificationEvidence,
} from './architect.types.js';

/**
 * Default {@link ArchitectService} (LLM-002, LLM-003).
 *
 * Assembles authoritative context from persistent PostgreSQL state, requests
 * reasoning through the existing LlmGateway, normalizes the result, and
 * generates a Work Order via the existing /work-items Work Order contract.
 *
 * MODULE OWNERSHIP (WORK-014 §3, §11, §17, §23 + architect review PR #13):
 *
 * The Architect Service lives in /llm. It may READ authoritative project state
 * (projects, architecture versions, requirements, criteria, work items,
 * repository associations) for context assembly. The only mutation it performs
 * against the Work Order persistence authority is routed through the existing
 * {@link WorkOrderRepository} contract owned by /work-items:
 *
 *   /llm (Architect Service)
 *       → WorkOrderRepository.create() + WorkOrderRepository.updateState()
 *       → /work-items persistence (wfos_work_orders)
 *
 * The Architect Service does NOT:
 * - write to `wfos_work_orders` directly (that bypasses /work-items authority
 *   and is enforced by static architecture checks + a regression test);
 * - persist Architect Review records (that's /reviews);
 * - mutate workflow state (that's /workflows);
 * - determine criterion PASS/FAIL (that's /verification);
 * - create a second Work Order model (that's /work-items).
 */
export class DefaultArchitectService implements ArchitectService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly llmGateway: LlmGateway,
    private readonly workOrderRepository: WorkOrderRepository,
    private readonly logger: Logger,
  ) {}

  async execute(request: ArchitectExecutionRequest): Promise<ArchitectExecutionResult> {
    // 1. Assemble authoritative context from persistent state.
    const context = await this.assembleContext(request);

    // 2. Build the LLM prompt from authoritative context.
    const prompt = this.buildPrompt(request, context);

    // 3. Request reasoning through the existing LlmGateway.
    const response = await this.llmGateway.generate({
      provider: request.provider,
      model: request.model,
      messages: [{ role: 'user', content: prompt }],
      systemInstruction: 'You are a WorkflowOS architect. Analyze the provided project context and provide structured architectural reasoning.',
      executionId: request.executionId,
      workItemId: request.workItemId,
      metadata: { task: request.task, architectureVersionId: request.architectureVersionId },
    });

    // 4. Normalize the result.
    const result = this.normalizeResult(request, response);
    this.logger.info('architect.execute.success', {
      executionId: request.executionId,
      provider: request.provider,
      model: request.model,
      architectureChangeRequired: result.architectureChangeRequired,
    });
    return result;
  }

  async generateWorkOrder(
    request: ArchitectExecutionRequest,
    result: ArchitectExecutionResult,
  ): Promise<{ workOrderId: string; architectExecutionId: string }> {
    if (!result.workOrderCandidate) {
      throw new Error('architect execution result has no work order candidate');
    }
    if (!request.workItemId) {
      throw new Error('work item ID required for Work Order generation');
    }

    const candidate = result.workOrderCandidate;

    // MUTATION BOUNDARY (architect review PR #13):
    //
    // The Architect Service lives in /llm. /work-items owns the Work Order
    // persistence authority (WORK-014 §3, §11, §17, §23). The Architect Service
    // must NOT write to `wfos_work_orders` directly through DatabaseClient —
    // doing so would make /llm a second Work Order persistence authority and
    // bypass the /work-items WorkOrderRepository contract.
    //
    // The generated Work Order is therefore created via the existing
    // WorkOrderRepository contract:
    //
    //   /llm → WorkOrderRepository.create() → /work-items persistence
    //
    // The repository creates the row in the 'draft' state. Architect-generated
    // Work Orders are surfaced as 'generated' (per the frozen spec §18 +
    // WORK_ORDER_GENERATED audit event). That transition is also routed through
    // the repository contract, so /work-items retains exclusive ownership of
    // Work Order state transitions:
    //
    //   /llm → WorkOrderRepository.updateState(id, 'generated') → /work-items
    //
    // The Architect Service preserves traceability to the originating execution
    // by recording the architect execution ID / provider / model in the Work
    // Order's `implementationContext` (a field owned by the /work-items Work
    // Order contract, so no contract extension is required).
    const created = await this.workOrderRepository.create({
      workItemId: request.workItemId,
      projectId: request.projectId,
      architectureVersionId: request.architectureVersionId,
      requirementIds: candidate.requirementIds,
      criterionIds: candidate.criterionIds,
      architectureConstraints: candidate.architectureConstraints,
      implementationContext: {
        ...candidate.implementationContext,
        architectExecutionId: request.executionId,
        architectProvider: request.provider,
        architectModel: request.model,
      },
      scope: candidate.scope,
      outOfScope: candidate.outOfScope,
      verificationRequirements: candidate.verificationRequirements,
    });

    const generated = await this.workOrderRepository.updateState(
      created.id,
      'generated',
    );
    if (!generated) {
      // Should be unreachable given create() just succeeded; we never return a
      // dangling id to the caller.
      throw new Error(
        `work order ${created.id} disappeared during generation transition`,
      );
    }

    this.logger.info('architect.work_order.generated', {
      workOrderId: generated.id,
      workItemId: request.workItemId,
      architectExecutionId: request.executionId,
      architectureVersionId: request.architectureVersionId,
    });

    return {
      workOrderId: generated.id,
      architectExecutionId: request.executionId,
    };
  }

  // --- Context assembly (from persistent PostgreSQL state) ---

  private async assembleContext(request: ArchitectExecutionRequest): Promise<ArchitectContext> {
    // Load requirements for the architecture version.
    const reqResult = await this.db.query<{ id: string; requirement_id: string; title: string; status: string }>(
      `SELECT id, requirement_id, title, status
       FROM wfos_requirements
       WHERE architecture_version_id = $1
       ORDER BY requirement_id`,
      [request.architectureVersionId],
    );
    const requirements: ArchitectRequirementSummary[] = reqResult.rows.map((r) => ({
      id: r.id, requirementId: r.requirement_id, title: r.title, status: r.status,
    }));

    // Load acceptance criteria for those requirements.
    const reqIds = requirements.map((r) => r.id);
    let criteria: ArchitectCriterionSummary[] = [];
    if (reqIds.length > 0) {
      const critResult = await this.db.query<{ id: string; criterion_id: string; description: string; status: string; requirement_id: string }>(
        `SELECT c.id, c.criterion_id, c.description, c.status, c.requirement_id
         FROM wfos_acceptance_criteria c
         WHERE c.requirement_id = ANY($1::uuid[])
         ORDER BY c.criterion_id`,
        [reqIds],
      );
      criteria = critResult.rows.map((c) => ({
        id: c.id, criterionId: c.criterion_id, description: c.description,
        status: c.status, requirementId: c.requirement_id,
      }));
    }

    // Load architecture version constraints.
    const archResult = await this.db.query<{ content_inline: string | null; metadata: Record<string, unknown> }>(
      `SELECT content_inline, metadata FROM wfos_architecture_versions WHERE id = $1`,
      [request.architectureVersionId],
    );
    const archConstraints = archResult.rows[0]?.content_inline ?? null;

    // Load repository evidence (provider-independent associations).
    const repoResult = await this.db.query<{ provider: string; external_id: string; canonical_ref: string }>(
      `SELECT provider, external_id, canonical_ref
       FROM wfos_project_repositories
       WHERE project_id = $1`,
      [request.projectId],
    );
    const repoEvidence: ArchitectRepositoryEvidence[] = repoResult.rows.map((r) => ({
      provider: r.provider, externalId: r.external_id, canonicalRef: r.canonical_ref,
    }));

    // Load work item out-of-scope if applicable.
    let outOfScope: string | null = null;
    if (request.workItemId) {
      const wiResult = await this.db.query<{ out_of_scope: string | null }>(
        `SELECT out_of_scope FROM wfos_work_items WHERE id = $1`,
        [request.workItemId],
      );
      outOfScope = wiResult.rows[0]?.out_of_scope ?? null;
    }

    // WORK-018 (WF-VER-AC-02): load persisted VerificationRun + evidence when
    // a verificationRunId is provided. The architect execution receives the
    // actual verification state/evidence context, not an empty array.
    let verificationEvidence: ArchitectVerificationEvidence[] = [];
    if (request.verificationRunId) {
      // Load the verification run.
      const runResult = await this.db.query<{ id: string; status: string; summary: Record<string, unknown> }>(
        `SELECT id, status, summary FROM wfos_verification_runs WHERE id = $1`,
        [request.verificationRunId],
      );
      if (runResult.rows.length > 0) {
        const run = runResult.rows[0]!;
        // Load the evidence records for this run.
        const evResult = await this.db.query<{ id: string; evidence_type: string; result: string; external_ref: string | null }>(
          `SELECT id, evidence_type, result, external_ref
           FROM wfos_evidence WHERE verification_run_id = $1
           ORDER BY created_at`,
          [request.verificationRunId],
        );
        verificationEvidence = evResult.rows.map((ev) => ({
          type: ev.evidence_type,
          ref: ev.external_ref ?? ev.id,
          status: `${ev.result} (run: ${run.status})`,
        }));
      }
    }

    return {
      projectId: request.projectId,
      architectureVersionId: request.architectureVersionId,
      workItemId: request.workItemId,
      requirements,
      acceptanceCriteria: criteria,
      architectureConstraints: archConstraints,
      repositoryEvidence: repoEvidence,
      verificationEvidence,
      outOfScope,
    };
  }

  private buildPrompt(request: ArchitectExecutionRequest, context: ArchitectContext): string {
    const parts: string[] = [
      `# Architect Execution Request`,
      ``,
      `## Task`,
      request.task,
      ``,
      `## Architecture Version`,
      `ID: ${context.architectureVersionId}`,
      `Constraints: ${context.architectureConstraints ?? '(none)'}`,
      ``,
      `## Requirements`,
      ...context.requirements.map((r) => `- [${r.requirementId}] ${r.title} (status: ${r.status})`),
      ``,
      `## Acceptance Criteria`,
      ...context.acceptanceCriteria.map((c) => `- [${c.criterionId}] ${c.description} (status: ${c.status})`),
      ``,
      `## Repository Evidence`,
      ...context.repositoryEvidence.map((r) => `- ${r.provider}: ${r.canonicalRef}`),
      ``,
      `## Out of Scope`,
      context.outOfScope ?? '(not specified)',
      ``,
      `## Instructions`,
      `Analyze the above project context. Provide:`,
      `1. A verdict (approve/request_changes/architecture_change_required)`,
      `2. A summary`,
      `3. Reasoning/rationale`,
      `4. Identified risks`,
      `5. Identified constraints`,
      `6. Required corrections (if any)`,
      `7. Whether an architecture change is required`,
      `8. A work order candidate with scope, out-of-scope, constraints, requirement IDs, criterion IDs, and verification requirements`,
    ];
    return parts.join('\n');
  }

  private normalizeResult(
    request: ArchitectExecutionRequest,
    response: { content: string; provider: string; model: string; executionId: string },
  ): ArchitectExecutionResult {
    // Parse the LLM response. For WORK-014 we use a simple structured format.
    // In production, the prompt would instruct the LLM to return JSON.
    // For tests, the FakeLlmAdapter returns a pre-formatted response.
    const content = response.content;

    // Try to parse as JSON; fall back to plain text.
    try {
      const parsed = JSON.parse(content) as {
        verdict?: string; summary?: string; reasoning?: string;
        risks?: string[]; constraints?: string[]; corrections?: string[];
        architectureChangeRequired?: boolean;
        workOrder?: { scope: string; outOfScope: string; constraints: string;
          requirementIds: string[]; criterionIds: string[];
          verificationRequirements: string[]; implementationContext: Record<string, unknown> };
      };
      return {
        executionId: request.executionId,
        provider: request.provider,
        model: request.model,
        verdict: parsed.verdict ?? 'unknown',
        summary: parsed.summary ?? content.slice(0, 200),
        reasoning: parsed.reasoning ?? '',
        identifiedRisks: parsed.risks ?? [],
        identifiedConstraints: parsed.constraints ?? [],
        requiredCorrections: parsed.corrections ?? [],
        architectureChangeRequired: parsed.architectureChangeRequired ?? false,
        workOrderCandidate: parsed.workOrder ? {
          scope: parsed.workOrder.scope,
          outOfScope: parsed.workOrder.outOfScope,
          architectureConstraints: parsed.workOrder.constraints,
          requirementIds: parsed.workOrder.requirementIds,
          criterionIds: parsed.workOrder.criterionIds,
          verificationRequirements: parsed.workOrder.verificationRequirements,
          implementationContext: parsed.workOrder.implementationContext ?? {},
        } : null,
      };
    } catch {
      // Plain text response — normalize minimally.
      return {
        executionId: request.executionId,
        provider: request.provider,
        model: request.model,
        verdict: 'unknown',
        summary: content.slice(0, 200),
        reasoning: content,
        identifiedRisks: [],
        identifiedConstraints: [],
        requiredCorrections: [],
        architectureChangeRequired: false,
        workOrderCandidate: null,
      };
    }
  }
}
