/** Agent execute job handler — registered with the existing WorkerHost. */
import type { Logger } from '@platform/logger.js';
import type { JobRecord, JobHandler } from '@platform/index.js';
import type { AgentGateway } from './agent.types.js';

export function createAgentJobHandler(
  gateway: AgentGateway,
  logger: Logger,
): JobHandler {
  return {
    type: 'agent.execute',
    async handle(job: JobRecord): Promise<void> {
      const payload = job.payload as {
        provider: string; configuration: Record<string, unknown>;
        workItemId: string; workOrderId?: string; architectureVersionId?: string;
        executionId: string; repositoryRef?: string; branch?: string; input: string;
      };
      if (!payload?.executionId) {
        logger.error('agent.job.missing_execution_id', { jobId: job.id });
        return;
      }
      await gateway.execute({
        provider: payload.provider,
        configuration: payload.configuration ?? {},
        workItemId: payload.workItemId,
        workOrderId: payload.workOrderId,
        architectureVersionId: payload.architectureVersionId,
        executionId: payload.executionId,
        repositoryRef: payload.repositoryRef,
        branch: payload.branch,
        input: payload.input ?? '',
      });
    },
  };
}
