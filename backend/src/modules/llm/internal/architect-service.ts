import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type { LlmGateway } from './llm.types.js';
import type {
  ArchitectService,
  ArchitectExecutionRequest,
  ArchitectExecutionResult,
  ArchitectContext,
  ArchitectRequirementSummary,
  ArchitectCriterionSummary,
  ArchitectRepositoryEvidence,
} from './architect.types.js';

/**
 * Default {@link ArchitectService} (LLM-002, LLM-003).
 *
 * Assembles authoritative context from persistent PostgreSQL state, requests
 * reasoning through the existing LlmGateway, normalizes the result, and
 * generates a Work Order via the existing /work-items Work Order contract.
 *
 * The Architect Service does NOT:
 * - persist Architect Review records (that's /reviews);
 * - mutate workflow state (that's /workflows);
 * - determine criterion PASS/FAIL (that's /verification);
 * - create a second Work Order model (that's /work-items).
 */
export class DefaultArchitectService implements ArchitectService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly llmGateway: LlmGateway,
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

    // Generate a Work Order using the existing /work-items contract.
    // The Work Order references the exact ArchitectureVersion, requirements,
    // criteria, and constraints from the architect context.
    const woResult = await this.db.query<{ id: string }>(
      `INSERT INTO wfos_work_orders
         (work_item_id, project_id, architecture_version_id, requirement_ids,
          criterion_ids, architecture_constraints, implementation_context,
          scope, out_of_scope, verification_requirements, state, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'generated', $11)
       RETURNING id`,
      [
        request.workItemId,
        request.projectId,
        request.architectureVersionId,
        JSON.stringify(result.workOrderCandidate.requirementIds),
        JSON.stringify(result.workOrderCandidate.criterionIds),
        result.workOrderCandidate.architectureConstraints,
        JSON.stringify({
          ...result.workOrderCandidate.implementationContext,
          architectExecutionId: request.executionId,
          architectProvider: request.provider,
          architectModel: request.model,
        }),
        result.workOrderCandidate.scope,
        result.workOrderCandidate.outOfScope,
        JSON.stringify(result.workOrderCandidate.verificationRequirements),
        JSON.stringify({ architectExecutionId: request.executionId }),
      ],
    );

    return {
      workOrderId: woResult.rows[0]!.id,
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

    return {
      projectId: request.projectId,
      architectureVersionId: request.architectureVersionId,
      workItemId: request.workItemId,
      requirements,
      acceptanceCriteria: criteria,
      architectureConstraints: archConstraints,
      repositoryEvidence: repoEvidence,
      verificationEvidence: [], // WORK-015 will provide verification evidence.
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
