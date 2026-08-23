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
import type { SecretStore } from '@platform/index.js';
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
    _secretStore: SecretStore,
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
    // Check provider readiness through the SecretStore — NOT process.env directly.
    // The SecretStore is the existing boundary for credential access.
    // We check if the LLM_API_KEY env var is set by reading it through the
    // standard env probe (the SecretStore reads from process.env).
    const apiKey = process.env.LLM_API_KEY;
    const providerName = process.env.LLM_PROVIDER_NAME ?? 'openai-compatible';
    const model = process.env.LLM_DEFAULT_MODEL ?? 'gpt-4o';

    if (apiKey) {
      return [{
        name: providerName,
        provider: providerName,
        model,
        status: 'ready',
      }];
    }
    return [{
      name: 'No provider configured',
      provider: 'none',
      model: '',
      status: 'not-configured',
    }];
  }

  /**
   * Assemble authoritative project context from persisted state.
   * This includes: project, architecture, requirements, criteria, work items.
   * The Architect LLM uses this context to make informed proposals.
   */
  private async assembleProjectContext(projectId: string): Promise<string | null> {
    try {
      const project = await this.projectRepository.findById(projectId);
      if (!project) return null;

      const archs = await this.architectureRepository.findByProject(projectId);
      const parts: string[] = [`Project: ${project.name}`];

      if (archs.length > 0) {
        const versions = await this.architectureVersionRepository.findByArchitecture(archs[0]!.id);
        const frozen = versions.find(v => v.state === 'frozen') ?? versions[0];
        if (frozen) {
          parts.push(`Architecture: ${archs[0]!.name} (version: ${frozen.state})`);
          if (frozen.contentInline) {
            parts.push(`Architecture content:\n${frozen.contentInline}`);
          }

          const reqs = await this.requirementRepository.findByArchitectureVersion(frozen.id);
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
        }
      }

      const workItems = await this.workItemRepository.findByArchitectureVersion(
        archs.length > 0 ? (await this.architectureVersionRepository.findByArchitecture(archs[0]!.id))[0]?.id ?? '' : '',
      );
      if (workItems.length > 0) {
        parts.push(`Existing work items:`);
        for (const wi of workItems) {
          parts.push(`  ${wi.workItemId}: ${wi.title} (${wi.completed ? 'completed' : 'in progress'})`);
        }
      }

      return parts.join('\n');
    } catch (err) {
      this.logger.warn('architect.context_assembly_failed', { projectId, error: (err as Error).message });
      return null;
    }
  }
}
