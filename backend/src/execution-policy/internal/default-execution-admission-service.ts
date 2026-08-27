/** WORK-043: final execution admission boundary. */
import type { Logger } from '@platform/logger.js';
import type { ExecutionTask, ExecutionAdmissionPort, ExecutionAdmissionResult } from '@modules/agents';
import type { ExecutionPolicyService } from '../types.js';

export interface ProjectOrganizationResolver {
  getOrganizationId(projectId: string): Promise<string | null>;
}

export interface DefaultExecutionAdmissionServiceDeps {
  readonly executionPolicyService: ExecutionPolicyService;
  readonly organizationResolver: ProjectOrganizationResolver;
  readonly logger: Logger;
}

export class DefaultExecutionAdmissionService implements ExecutionAdmissionPort {
  constructor(private readonly deps: DefaultExecutionAdmissionServiceDeps) {}

  async admit(task: ExecutionTask): Promise<ExecutionAdmissionResult> {
    const organizationId = await this.deps.organizationResolver.getOrganizationId(task.projectId);
    if (!organizationId) {
      return {
        admitted: false,
        reason: 'execution-admission-organization-unresolvable',
        policyVersion: null,
        blockingReasons: [{
          category: 'organization',
          constraint: 'project_organization_resolution',
          reason: `Organization for project ${task.projectId} could not be resolved.`,
        }],
      };
    }
    try {
      const verdict = await this.deps.executionPolicyService.evaluateCandidateEligibility({
        organizationId,
        projectId: task.projectId,
        workItemId: task.workItemId,
        provider: task.provider,
        model: task.model,
        executionMode: task.mode,
        userId: null,
      });
      return {
        admitted: verdict.eligibility.eligible,
        reason: verdict.eligibility.eligible
          ? 'execution-admitted-current-hard-constraints'
          : 'execution-admission-hard-constraint-block',
        policyVersion: verdict.policyVersion,
        blockingReasons: verdict.eligibility.blockingReasons,
      };
    } catch (error) {
      this.deps.logger.error('execution-admission.evaluation-failed', {
        projectId: task.projectId,
        executionId: task.executionId,
        error: (error as Error).message,
      });
      return {
        admitted: false,
        reason: 'execution-admission-evaluation-failed',
        policyVersion: null,
        blockingReasons: [{
          category: 'policy',
          constraint: 'evaluation',
          reason: (error as Error).message,
        }],
      };
    }
  }
}
