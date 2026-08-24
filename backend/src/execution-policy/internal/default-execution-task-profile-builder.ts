/**
 * WORK-033 §15 — ExecutionTaskProfile builder.
 *
 * Derives an ExecutionTaskProfile from the Work Item + Work Order +
 * ImplementationContext. This is DERIVED METADATA feeding eligibility +
 * recommendation — it is NOT another authority for architecture/requirements
 * (those remain with /architecture, /requirements, /work-items).
 *
 * Boundary: depends on the /work-items public repository INTERFACES (types
 * only from the barrel). The composition root (app.ts) injects the concrete
 * repository instances — this file never imports /work-items/internal/.
 */
import type {
  WorkItem,
  WorkItemRepository,
  WorkOrderRepository,
  ImplementationContextContent,
  ImplementationContextRepository,
} from '@modules/work-items';
import type {
  CapabilityRequirement,
  ExecutionTaskProfile,
} from '../types.js';
import type { Logger } from '@platform/logger.js';

export interface ExecutionTaskProfileBuilderDeps {
  readonly workItemRepository: WorkItemRepository;
  readonly workOrderRepository: WorkOrderRepository;
  readonly implementationContextRepository: ImplementationContextRepository;
  readonly logger: Logger;
}

export class DefaultExecutionTaskProfileBuilder {
  constructor(private readonly deps: ExecutionTaskProfileBuilderDeps) {}

  async build(workItemId: string): Promise<ExecutionTaskProfile> {
    const workItem = await this.deps.workItemRepository.findById(workItemId);
    if (!workItem) {
      throw new Error(`task-profile: work item ${workItemId} not found`);
    }
    const latestContext = await this.deps.implementationContextRepository.findLatestByWorkItem(workItemId);
    const content = latestContext?.content ?? null;

    const browserRequired = (content?.browserTestRequirements?.length ?? 0) > 0
      || /\bplaywright|cypress|e2e|browser/i.test(workItem.scope ?? '');
    const terminalRequired = /\bterminal|cli|shell|deploy|migration/i.test(workItem.scope ?? '') || browserRequired;
    const repo = content?.repository;
    const repositoryAccess = !!(repo && repo.owner && repo.repository);
    const language = detectLanguage(workItem, content);
    const framework = detectFramework(workItem, content);
    const requiredCapabilities: CapabilityRequirement[] = deriveRequiredCapabilities({
      browserRequired, terminalRequired, repositoryAccess,
    });

    return {
      language,
      framework,
      repositorySize: estimateSize(workItem, content),
      complexity: estimateComplexity(workItem, content),
      architectureSensitivity: estimateArchSensitivity(workItem),
      securitySensitivity: estimateSecuritySensitivity(workItem, content),
      browserRequired,
      terminalRequired,
      repositoryAccess,
      externalExecutionAllowed: !/\bnative-only\b|externalExecution:\s*false/i.test(workItem.executionMetadata?.['execution'] as string ?? ''),
      nativeExecutionAllowed: !/\bexternal-only\b|nativeExecution:\s*false/i.test(workItem.executionMetadata?.['execution'] as string ?? ''),
      requiredCapabilities,
      humanInterventionLikely: estimateHumanIntervention(workItem, content),
    };
  }
}

function detectLanguage(wi: WorkItem, ctx: ImplementationContextContent | null): string | null {
  const hay = `${wi.title} ${wi.scope ?? ''} ${wi.objective ?? ''} ${ctx?.architectureName ?? ''}`;
  if (/\btypescript|\bts\b|next\.?js|vite/i.test(hay)) return 'typescript';
  if (/\bpython|\bpy\b|django|fastapi/i.test(hay)) return 'python';
  if (/\brust|cargo/i.test(hay)) return 'rust';
  if (/\bgo\b|golang/i.test(hay)) return 'go';
  if (/\bjava|kotlin|jvm/i.test(hay)) return 'java';
  return null;
}

function detectFramework(wi: WorkItem, ctx: ImplementationContextContent | null): string | null {
  const hay = `${wi.title} ${wi.scope ?? ''} ${ctx?.architectureName ?? ''}`;
  if (/next\.?js/i.test(hay)) return 'nextjs';
  if (/vite/i.test(hay)) return 'vite';
  if (/fastapi/i.test(hay)) return 'fastapi';
  if (/django/i.test(hay)) return 'django';
  if (/express/i.test(hay)) return 'express';
  if (/hono/i.test(hay)) return 'hono';
  return null;
}

function estimateSize(_wi: WorkItem, ctx: ImplementationContextContent | null): 'small' | 'medium' | 'large' | 'unknown' {
  const reqCount = ctx?.requirements?.length ?? 0;
  const critCount = ctx?.requirements?.reduce((n, r) => n + (r.criteria?.length ?? 0), 0) ?? 0;
  const deps = ctx?.dependencies?.length ?? 0;
  const score = reqCount * 2 + critCount + deps;
  if (score === 0) return 'unknown';
  if (score <= 4) return 'small';
  if (score <= 12) return 'medium';
  return 'large';
}

function estimateComplexity(wi: WorkItem, ctx: ImplementationContextContent | null): 'low' | 'medium' | 'high' | 'unknown' {
  const reqCount = ctx?.requirements?.length ?? 0;
  const critCount = ctx?.requirements?.reduce((n, r) => n + (r.criteria?.length ?? 0), 0) ?? 0;
  const hasArchConstraints = !!wi.architectureConstraints;
  const score = reqCount + critCount + (hasArchConstraints ? 2 : 0);
  if (score === 0) return 'unknown';
  if (score <= 3) return 'low';
  if (score <= 8) return 'medium';
  return 'high';
}

function estimateArchSensitivity(wi: WorkItem): 'low' | 'medium' | 'high' {
  return wi.architectureConstraints ? 'high' : 'low';
}

function estimateSecuritySensitivity(wi: WorkItem, ctx: ImplementationContextContent | null): 'low' | 'medium' | 'high' {
  const hay = `${wi.title} ${wi.scope ?? ''} ${ctx?.architectureName ?? ''}`;
  if (/\bauth|credential|secret|token|password|pii|gdpr|crypto|key\b/i.test(hay)) return 'high';
  if (/\bpayment|billing|audit|permission|rbac\b/i.test(hay)) return 'medium';
  return 'low';
}

function deriveRequiredCapabilities(input: {
  browserRequired: boolean; terminalRequired: boolean; repositoryAccess: boolean;
}): CapabilityRequirement[] {
  const out: CapabilityRequirement[] = [];
  // Implementation Work Orders always operate on a repository workspace —
  // coding-agent capability is the baseline requirement.
  out.push('coding_agent');
  if (input.repositoryAccess) out.push('repository_access');
  if (input.terminalRequired) out.push('terminal');
  if (input.browserRequired) out.push('browser');
  return out;
}

function estimateHumanIntervention(wi: WorkItem, ctx: ImplementationContextContent | null): boolean {
  const hay = `${wi.title} ${wi.scope ?? ''}`;
  if (/\bmanual|review|approval|human|handoff\b/i.test(hay)) return true;
  if ((ctx?.priorReviewFindings?.length ?? 0) > 0) return true;
  return false;
}
