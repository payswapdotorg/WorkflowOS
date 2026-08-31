/**
 * WORK-069 §4 — the composition adapter over the EXISTING /runtime
 * deployment authority (WORK-019/WORK-026). Reads the provider-RECORDED
 * deployment state through the module's PUBLIC contract
 * (`DeploymentRepository.findLatestForProject`) — the domain's own
 * `RuntimeObservationReader` port, so the domain imports no module
 * internals. The status mapping is TOTAL (the domain mirrors the
 * authority's recorded vocabulary; a foreign status fails closed as
 * 'unavailable' — never a healthy default).
 */
import type { DeploymentRepository } from '@modules/runtime/index.js';
import type {
  ProgressiveDeploymentStatus,
  RolloutRuntimeObservation,
  RuntimeObservationReader,
} from '../types.js';

export class RuntimeModuleDeploymentObservationReader implements RuntimeObservationReader {
  constructor(private readonly deploymentRepository: DeploymentRepository) {}

  async readLatestDeploymentObservation(projectId: string): Promise<RolloutRuntimeObservation | null> {
    const deployment = await this.deploymentRepository.findLatestForProject(projectId);
    if (deployment === null) return null;
    // The authority record's OWN recorded time — never the decision clock,
    // never an inference (WORK-019's updatedAt is the provider-recorded
    // observation boundary).
    const observedAt =
      deployment.updatedAt instanceof Date
        ? deployment.updatedAt.toISOString()
        : String(deployment.updatedAt);
    const status = normalizeDeploymentStatus(deployment.status);
    if (status === null) {
      // A foreign status is an UNAVAILABLE observation (fail closed) —
      // never a healthy default, never a throw that would mask the record.
      return null;
    }
    return {
      kind: 'deployment',
      deploymentId: deployment.id,
      deploymentStatus: status,
      observedAt,
    };
  }
}

/** The total mapping of the authority's recorded status onto the domain vocabulary (null = unavailable). */
function normalizeDeploymentStatus(status: string): ProgressiveDeploymentStatus | null {
  switch (status) {
    case 'queued':
    case 'building':
    case 'ready':
    case 'error':
    case 'canceled':
      return status;
    default:
      return null;
  }
}
