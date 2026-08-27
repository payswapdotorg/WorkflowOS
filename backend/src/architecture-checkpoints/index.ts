/**
 * WORK-051 — Architecture Governance and Checkpoints (public barrel).
 *
 * The architecture-checkpoints domain is an APPLICATION-LAYER ORCHESTRATOR
 * that lives at `src/architecture-checkpoints/` (mirrors the §34 benchmark +
 * WORK-033 execution-policy pattern: NOT an 18th frozen module — it CONSUMES
 * the frozen modules via their public barrels).
 *
 * Boundary contract (static-architecture checks enforce):
 *   - imports from @modules/* (public barrels only — never internal/)
 *   - imports from @platform/* (cross-cutting infrastructure)
 *   - NEVER issues SQL; checkpoint evidence is persisted ONLY through the
 *     /verification public contract (VerificationService)
 *   - NEVER mutates workflow state (no WorkflowEngine access at all)
 *   - NEVER mutates architecture definitions (read-only reader ports only)
 *   - NEVER stores credentials; detectors have no provider coupling
 *   - NO scheduler/cron/setInterval in the initial increment
 *
 * Authority model (issue #51; design §4, §8):
 *   /architecture  owns ArchitectureVersions + assertions
 *   /verification  owns all durable evidence
 *   /workflows     owns lifecycle state (consumes the gate result)
 *   /reviews       remains the semantic architectural judgment authority
 */
export type {
  ArchitectureVersionReader,
  ArchitectureReader,
  WorkItemReader,
  ArchitectureImpactLevel,
  ArchitectureCheckpointStatus,
  ArchitectureDetectorStatus,
  AssertionEvaluation,
  ArchitectureCheckpointResult,
  DetectorInput,
  DetectorResult,
  ArchitectureAssertionDetector,
  ArchitectureCheckpointService,
} from './types.js';
export {
  ARCHITECTURE_IMPACT_LEVELS,
  IMPACT_CHECKPOINT_MATRIX,
  CrossTenantCheckpointAccessError,
} from './types.js';

export { DefaultArchitectureCheckpointService } from './internal/default-checkpoint-service.js';
export type { DefaultArchitectureCheckpointServiceDeps } from './internal/default-checkpoint-service.js';
export { CHECKPOINT_RUN_SOURCE, deriveImpact } from './internal/default-checkpoint-service.js';
export {
  createDefaultDetectorRegistry,
  INITIAL_DETECTOR_KINDS,
} from './internal/detector-registry.js';
