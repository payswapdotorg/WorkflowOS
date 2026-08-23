/**
 * WORK-025: DefaultConversationalArchitectService.
 *
 * Extends the existing /llm Architect boundary to support conversational
 * architecture generation. This service:
 * - Assembles authoritative project context (architecture, requirements, etc.)
 * - Calls the existing LlmGateway (NOT a second LLM implementation)
 * - Parses the LLM response into a structured plan
 * - Returns provider configuration (readiness only — no secrets)
 *
 * The route delegates to this service. The route does NOT call LlmGateway
 * directly or inspect process.env for credentials.
 */
import type { Logger } from '@platform/logger.js';
import type { LlmGateway } from './llm.types.js';
import type { DatabaseClient } from '@platform/index.js';
import type { ProviderRegistry } from '@platform/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { RequirementRepository, AcceptanceCriterionRepository } from '@modules/requirements/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import { generateExecutionId } from '@platform/ids.js';
import type {
  ConversationalArchitectService,
  ConversationalArchitectResult,
  ProviderConfig,
  ArchitectMessage,
  ArchitectParsedPlan,
} from './conversational-architect.types.js';

const ARCHITECT_SYSTEM_PROMPT = `You are the WorkflowOS Architect. The user describes a software system they want to build. You generate a structured architecture proposal as JSON.

Return ONLY valid JSON with this exact shape:
{
  "architecture": { "name": "...", "content": "...", "constraints": ["..."] },
  "requirements": [{ "requirementId": "REQ-001", "title": "...", "description": "...", "criteria": [{ "criterionId": "AC-001", "description": "..." }] }],
  "workItems": [{ "workItemId": "WORK-001", "title": "...", "objective": "...", "scope": "...", "requirementIds": ["REQ-001"], "criterionIds": ["AC-001"], "dependencies": [] }],
  "summary": "Brief summary of the architecture"
}

Rules:
- PostgreSQL is authoritative. Redis is non-authoritative.
- The frontend is a consumer, never an authority.
- Use modular monolith architecture unless the user specifies otherwise.
- Generate 3-8 requirements with 1-3 criteria each.
- Generate 2-6 work items with clear objectives.
- Each Work Item must specify which requirementIds and criterionIds it implements.
- Include dependency references between work items where relevant.
- Be concise but complete.`;

export class DefaultConversationalArchitectService implements ConversationalArchitectService {
  constructor(
    _db: DatabaseClient,
    private readonly llmGateway: LlmGateway,
    private readonly projectRepository: ProjectRepository,
    private readonly architectureRepository: ArchitectureRepository,
    private readonly architectureVersionRepository: ArchitectureVersionRepository,
    private readonly requirementRepository: RequirementRepository,
    private readonly acceptanceCriterionRepository: AcceptanceCriterionRepository,
    private readonly workItemRepository: WorkItemRepository,
    private readonly _providerRegistry: ProviderRegistry,
    private readonly logger: Logger,
  ) {}

  async converse(input: {
    projectId: string;
    prompt: string;
    conversation: ArchitectMessage[];
    provider: string;
    model: string;
  }): Promise<ConversationalArchitectResult> {
    const executionId = generateExecutionId();

    // Assemble authoritative project context.
    const contextStr = await this.assembleProjectContext(input.projectId);

    // Build messages — include system prompt + project context + conversation history.
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: ARCHITECT_SYSTEM_PROMPT },
    ];

    // Include project context as a system message if available.
    if (contextStr) {
      messages.push({ role: 'system', content: `Current project context:\n${contextStr}` });
    }

    // Include conversation history.
    for (const msg of input.conversation) {
      messages.push({ role: msg.role, content: msg.content });
    }

    // Current user prompt.
    messages.push({ role: 'user', content: input.prompt });

    // Call the LLM gateway (existing boundary — NOT a second LLM implementation).
    const result = await this.llmGateway.generate({
      provider: input.provider,
      model: input.model,
      messages,
      executionId,
      metadata: { projectId: input.projectId },
    });

    // Parse the response as JSON.
    let parsedPlan: ArchitectParsedPlan | null = null;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedPlan = JSON.parse(jsonMatch[0]) as ArchitectParsedPlan;
      }
    } catch {
      this.logger.warn('architect.converse.parse_failed', { executionId });
    }

    return {
      executionId,
      content: result.content,
      parsedPlan,
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
      },
    };
  }

  getProviders(): ProviderConfig[] {
    // Delegate to the ProviderRegistry — the /llm service does NOT
    // read process.env or check secrets directly.
    return this._providerRegistry.getProviders();
  }

  /**
   * Validate that a provider+model combination is configured.
   * Used by the route to reject arbitrary browser-submitted values.
   */
  isProviderConfigured(provider: string, model: string): boolean {
    return this._providerRegistry.isConfigured(provider, model);
  }

  /**
   * Assemble authoritative project context from persisted state.
   *
   * Resolves the AUTHORITATIVE architecture version using a deterministic
   * rule consistent with the existing architecture contracts:
   *   1. Find all architectures for the project.
   *   2. For each architecture, find all versions.
   *   3. Select the FROZEN version from the most recently created architecture
   *      that has one. If no frozen version exists, select the most recent
   *      DRAFT version from the most recent architecture.
   *   4. If multiple architectures have frozen versions, prefer the most
   *      recently created architecture (NOT the first in the array).
   *
   * This avoids the archs[0] / versions[0] assumption that breaks when
   * a project has multiple architectures or versions.
   */
  private async assembleProjectContext(projectId: string): Promise<string | null> {
    try {
      const project = await this.projectRepository.findById(projectId);
      if (!project) return null;

      const archs = await this.architectureRepository.findByProject(projectId);
      const parts: string[] = [`Project: ${project.name}`];

      if (archs.length > 0) {
        // Sort architectures by creation time descending (most recent first).
        const sortedArchs = [...archs].sort((a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );

        // Resolve the authoritative version: frozen > draft, most recent architecture.
        let authoritativeVersion: { id: string; state: string; contentInline: string | null; architectureId: string } | null = null;
        let authoritativeArch: { id: string; name: string } | null = null;

        for (const arch of sortedArchs) {
          const versions = await this.architectureVersionRepository.findByArchitecture(arch.id);
          // Sort versions by creation time descending (most recent first).
          const sortedVersions = [...versions].sort((a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          );
          // Prefer frozen, then fall back to the most recent draft.
          const frozen = sortedVersions.find(v => v.state === 'frozen');
          if (frozen) {
            authoritativeVersion = frozen;
            authoritativeArch = arch;
            break;
          }
          // If no frozen found yet, use the most recent draft from the most recent architecture.
          if (!authoritativeVersion && sortedVersions.length > 0) {
            authoritativeVersion = sortedVersions[0]!;
            authoritativeArch = arch;
          }
        }

        if (authoritativeVersion && authoritativeArch) {
          parts.push(`Architecture: ${authoritativeArch.name} (version state: ${authoritativeVersion.state})`);
          if (authoritativeVersion.contentInline) {
            parts.push(`Architecture content:\n${authoritativeVersion.contentInline}`);
          }

          // Fetch requirements + criteria for the authoritative version.
          const reqs = await this.requirementRepository.findByArchitectureVersion(authoritativeVersion.id);
          if (reqs.length > 0) {
            parts.push(`Existing requirements:`);
            for (const req of reqs) {
              parts.push(`  ${req.requirementId}: ${req.title}`);
              const criteria = await this.acceptanceCriterionRepository.listForRequirement(req.id);
              for (const crit of criteria) {
                parts.push(`    ${crit.criterionId}: ${crit.description} (${crit.status})`);
              }
            }
          }

          // Fetch work items for the authoritative version.
          const workItems = await this.workItemRepository.findByArchitectureVersion(authoritativeVersion.id);
          if (workItems.length > 0) {
            parts.push(`Existing work items:`);
            for (const wi of workItems) {
              parts.push(`  ${wi.workItemId}: ${wi.title} (${wi.completed ? 'completed' : 'in progress'})`);
            }
          }
        }
      }

      return parts.join('\n');
    } catch (err) {
      this.logger.warn('architect.context_assembly_failed', { projectId, error: (err as Error).message });
      return null;
    }
  }
}
